#!/usr/bin/env bash
# Pre-change procedure for the one-time ADR-041 OWNER reconciliation. Every
# step except `backup` works on a RESTORED COPY of a verified export in a
# disposable, loopback-only PostgreSQL container; nothing here writes to the
# deployed database.
#   owner-reconciliation-rehearsal.sh backup  <export-id> <work-dir>
#   owner-reconciliation-rehearsal.sh restore <verified.dump> <work-dir>
#   owner-reconciliation-rehearsal.sh spec    <approvals.json> <work-dir>
#   owner-reconciliation-rehearsal.sh check   <work-dir>
#   owner-reconciliation-rehearsal.sh dry-run <work-dir>
#   owner-reconciliation-rehearsal.sh cleanup <work-dir>
#
#   backup   runs the ops `export`, then verify-export.sh (marker, S3 checksum
#            metadata, size, SHA-256, pg_restore listing). Needs Lab credentials.
#   restore  starts the disposable container, restores the verified dump, and
#            writes <work-dir>/restore.env (mode 600; holds the local URL).
#   spec     resolves the owner's approval (ID prefixes + masked emails) against
#            the restored copy into full IDs and e-mail digests, and writes
#            <work-dir>/spec.json (mode 600) plus its digest.
#   check    read-only evidence on the restored copy: exact OWNER rows of each
#            approved organization, and whether each retained OWNER account can
#            sign in (ACTIVE, verified, credential account) and has a recent
#            real session. Prints GATE lines; never prints addresses.
#   dry-run  runs the production operator code in dry-run mode on the copy.
#   cleanup  removes the container and the copy's secrets.
# shellcheck source-path=SCRIPTDIR source=common.sh
source "$(dirname "$0")/common.sh"

readonly postgres_image="postgres:16.15-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea"
readonly session_max_age_hours=24
repo_dir="$(cd "${operator_dir}/../../.." && pwd)"
api_dir="${repo_dir}/apps/api/src/owner-reconciliation"

command_name="${1:-}"
shift || true

load_restore() {
  [[ -r "${work}/restore.env" ]] || die "no restored copy in ${work}; run restore first"
  # shellcheck disable=SC1091
  source "${work}/restore.env"
}

psql_copy() { docker exec -i "$CONTAINER" psql -U postgres -d audit_copy --no-psqlrc --quiet --tuples-only --no-align "$@"; }

case "$command_name" in
  backup)
    [[ $# == 2 ]] || die "usage: backup <export-id> <work-dir>"
    export_id="$1" work="$2"
    [[ "$export_id" =~ ^[a-z0-9-]{8,64}$ ]] || die "export id must be 8-64 of [a-z0-9-]"
    require_tools aws terraform docker sha256sum
    mkdir -p "$work"
    log="${work}/export-${export_id}.log"
    "${operator_dir}/run-ops-task.sh" export --export-id "$export_id" >"$log" 2>&1 ||
      { tail -5 "$log" >&2; die "the export task failed"; }
    bucket="$(grep -o 'bucket=[^ ]*' "$log" | head -1 | cut -d= -f2 | tr -d '\r')"
    database="$(grep -o 'database=[^ ]*' "$log" | head -1 | cut -d= -f2 | tr -d '\r')"
    "${operator_dir}/verify-export.sh" "$log" "$database" "$export_id" "$bucket" "${work}/dump"
    ;;

  restore)
    [[ $# == 2 ]] || die "usage: restore <verified.dump> <work-dir>"
    dump="$1" work="$2"
    require_tools docker
    [[ -s "$dump" && -r "${dump}.verified" ]] || die "the dump must be non-empty and have a .verified record from verify-export.sh"
    [[ ! -e "${work}/restore.env" ]] || die "${work} already holds a restored copy; run cleanup first"
    mkdir -p "$work"
    umask 077
    container="lls-ownrec-$(date -u +%Y%m%d%H%M%S)-$RANDOM"
    password="$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    docker run -d --name "$container" --label stockwise.lls=owner-reconciliation \
      -e POSTGRES_PASSWORD="$password" -e POSTGRES_DB=audit_copy \
      -p 127.0.0.1::5432 "$postgres_image" >/dev/null
    for _ in $(seq 1 60); do
      docker exec "$container" pg_isready -U postgres -d audit_copy >/dev/null 2>&1 && break
      sleep 1
    done
    docker cp "$(native_path "$dump")" "${container}:/tmp/restore.dump"
    MSYS_NO_PATHCONV=1 docker exec "$container" pg_restore --no-owner --no-privileges -U postgres -d audit_copy /tmp/restore.dump ||
      { docker rm -f "$container" >/dev/null; die "pg_restore failed"; }
    port="$(docker port "$container" 5432/tcp | head -1 | sed 's/.*://' | tr -d '\r')"
    {
      echo "CONTAINER=${container}"
      echo "DATABASE_URL=postgresql://postgres:${password}@127.0.0.1:${port}/audit_copy"
    } >"${work}/restore.env"
    CONTAINER="$container"
    orgs="$(psql_copy -c 'SELECT count(*) FROM organizations')"
    members="$(psql_copy -c 'SELECT count(*) FROM organization_memberships')"
    echo "STOCKWISE_RESTORE:OK organizations=${orgs} memberships=${members} container=${container}"
    ;;

  spec)
    [[ $# == 2 ]] || die "usage: spec <approvals.json> <work-dir>"
    approvals="$1" work="$2"
    load_restore
    require_tools node
    DATABASE_URL="$DATABASE_URL" node "$(native_path "${api_dir}/owner-reconciliation-spec-main.ts")" \
      "$(native_path "$approvals")" "$(native_path "${work}/spec.json")"
    ;;

  check)
    [[ $# == 1 ]] || die "usage: check <work-dir>"
    work="$1"
    load_restore
    [[ -r "${work}/spec.json" ]] || die "no spec.json; run spec first"
    mapfile -t rows < <(node -e '
      const spec = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      for (const o of spec.organizations)
        console.log([o.organizationId, o.retained.userId, o.retained.membershipId, o.demoted.userId, o.demoted.membershipId].join(" "));
    ' "$(native_path "${work}/spec.json")")
    fail=0
    for row in "${rows[@]}"; do
      read -r org retained_user retained_member demoted_user demoted_member <<<"$row"
      for id in $org $retained_user $retained_member $demoted_user $demoted_member; do
        [[ "$id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || die "spec holds a malformed identifier"
      done
      label="${org:0:8}"
      owners="$(psql_copy -c "SELECT count(*) FROM organization_memberships WHERE organization_id='${org}' AND role='OWNER' AND status='ACTIVE'")"
      echo "STOCKWISE_CHECK:org ${label} active_owners=${owners} (expected 2)"
      [[ "$owners" == 2 ]] || fail=1
      # Exact approved rows, read-only: role/status/version/assignments.
      psql_copy -F ' ' -c "
        SELECT 'STOCKWISE_CHECK:row ${label} ' || CASE m.id WHEN '${retained_member}' THEN 'retained' ELSE 'demoted' END
          || ' user=' || left(m.user_id::text, 8) || ' role=' || m.role || ' status=' || m.status
          || ' active_assignments=' || (SELECT count(*) FROM branch_assignments b WHERE b.organization_id = m.organization_id AND b.user_id = m.user_id AND b.status = 'ACTIVE')
        FROM organization_memberships m
        WHERE m.organization_id='${org}' AND m.id IN ('${retained_member}','${demoted_member}')
        ORDER BY (m.id = '${retained_member}') DESC"
      # Retained OWNER accessibility: an account that exists is not proof it works.
      access="$(psql_copy -F ' ' -c "
        SELECT (u.status = 'ACTIVE') AS active, (u.email_verified_at IS NOT NULL) AS verified,
               EXISTS (SELECT 1 FROM better_auth_accounts a WHERE a.user_id = u.id AND a.provider_id = 'credential' AND a.password IS NOT NULL) AS credential,
               COALESCE(floor(extract(epoch FROM (now() - (SELECT max(s.created_at) FROM better_auth_sessions s WHERE s.user_id = u.id))) / 3600)::text, 'never') AS session_age_hours
        FROM users u WHERE u.id = '${retained_user}'")"
      read -r active verified credential session_age <<<"$access"
      echo "STOCKWISE_CHECK:retained ${label} user=${retained_user:0:8} active=${active} verified=${verified} credential=${credential} last_login_age_hours=${session_age}"
      if [[ "$active" != t || "$verified" != t || "$credential" != t ]]; then
        echo "STOCKWISE_GATE:RETAINED_OWNER_ACCOUNT_NOT_USABLE ${label}"
        fail=1
      elif [[ "$session_age" == never || "$session_age" -gt $session_max_age_hours ]]; then
        echo "STOCKWISE_GATE:RETAINED_OWNER_LOGIN_UNPROVEN ${label} (ask the account holder to sign in and open the organization, then take a new export)"
        fail=1
      else
        echo "STOCKWISE_GATE:RETAINED_OWNER_LOGIN_RECENT ${label}"
      fi
    done
    [[ $fail == 0 ]] || die "check failed; do not proceed to the execution gate"
    echo "STOCKWISE_CHECK:ALL_PASSED"
    ;;

  dry-run)
    [[ $# == 1 ]] || die "usage: dry-run <work-dir>"
    work="$1"
    load_restore
    [[ -r "${work}/spec.json" ]] || die "no spec.json; run spec first"
    spec_b64="$(base64 <"${work}/spec.json" | tr -d '\n\r ')"
    DATABASE_URL="$DATABASE_URL" STOCKWISE_RECONCILE_MODE=dry-run STOCKWISE_RECONCILE_SPEC_B64="$spec_b64" \
      node "$(native_path "${api_dir}/owner-reconciliation-main.ts")"
    ;;

  cleanup)
    [[ $# == 1 ]] || die "usage: cleanup <work-dir>"
    work="$1"
    if [[ -r "${work}/restore.env" ]]; then
      load_restore
      docker rm -f -v "$CONTAINER" >/dev/null 2>&1 || true
      rm -f "${work}/restore.env" "${work}/spec.json"
      echo "STOCKWISE_CLEANUP:COMPLETE"
    else
      echo "STOCKWISE_CLEANUP:NOTHING_TO_DO"
    fi
    ;;

  *)
    die "usage: owner-reconciliation-rehearsal.sh backup|restore|spec|check|dry-run|cleanup ..."
    ;;
esac
