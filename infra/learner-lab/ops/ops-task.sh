#!/usr/bin/env bash
# One-off ECS operations for the StockWise Learner Lab demo (ADR-040), run as
# the ops image entrypoint by operator/run-ops-task.sh:
#   ops-task.sh <action>
# Each ops task definition receives only its own secrets and sets
# STOCKWISE_OPS_ROLE; an action outside that role is refused:
#   bootstrap  bootstrap-roles                       (RDS master credentials)
#   ops        prepare | migrate | grants | fence-state | status | seed | cutover |
#              uat-provision
#   export     export                                (LabRole task role, S3)
# Credentials travel only in environment variables, never in arguments or
# output. Machine-readable result lines start with STOCKWISE_.
set -euo pipefail

readonly ca=/etc/stockwise/rds-global-bundle.pem
readonly db_dir=/opt/stockwise/db
action="${1:-status}"

die() {
  echo "STOCKWISE_REFUSED: $*" >&2
  exit 1
}
step() { echo "STOCKWISE_OPS: $*"; }

require() {
  local name
  for name in "$@"; do
    [[ -n "${!name:-}" ]] || die "${name} is not set"
  done
}

base64url_password() {
  [[ "${!1}" =~ ^[A-Za-z0-9_-]{24,128}$ ]] || die "$1 must be 24-128 base64url characters"
}

require STOCKWISE_OPS_ROLE STOCKWISE_DB_HOST STOCKWISE_DB_PORT STOCKWISE_DB_NAME
[[ "$STOCKWISE_DB_HOST" =~ ^[a-z0-9.-]+$ && "$STOCKWISE_DB_PORT" =~ ^[0-9]+$ ]] ||
  die "database endpoint has an unsupported shape"
[[ "$STOCKWISE_DB_NAME" =~ ^[a-z][a-z0-9_]*_demo$ ]] || die "STOCKWISE_DB_NAME must end in _demo"

case "${STOCKWISE_OPS_ROLE}:${action}" in
  bootstrap:bootstrap-roles | export:export) ;;
  ops:prepare | ops:migrate | ops:grants | ops:fence-state | ops:status | ops:seed | ops:cutover | ops:uat-provision) ;;
  *) die "action '${action}' is not permitted for the '${STOCKWISE_OPS_ROLE}' task definition" ;;
esac

export PGHOST="$STOCKWISE_DB_HOST" PGPORT="$STOCKWISE_DB_PORT" PGDATABASE="$STOCKWISE_DB_NAME"
export PGSSLMODE=verify-full PGSSLROOTCERT="$ca" PGCONNECT_TIMEOUT=10

as_migrator() {
  require STOCKWISE_MIGRATOR_PASSWORD
  base64url_password STOCKWISE_MIGRATOR_PASSWORD
  export PGUSER=stockwise_migrator PGPASSWORD="$STOCKWISE_MIGRATOR_PASSWORD"
  local endpoint="${STOCKWISE_DB_HOST}:${STOCKWISE_DB_PORT}/${STOCKWISE_DB_NAME}"
  # node-postgres verifies through NODE_EXTRA_CA_CERTS; Prisma's schema engine
  # takes the CA through sslcert instead.
  export DATABASE_URL="postgresql://stockwise_migrator:${STOCKWISE_MIGRATOR_PASSWORD}@${endpoint}?sslmode=verify-full"
  export PRISMA_MIGRATE_DATABASE_URL="postgresql://stockwise_migrator:${STOCKWISE_MIGRATOR_PASSWORD}@${endpoint}?sslmode=require&sslcert=${ca}"
}

psql_quiet() { psql --no-psqlrc --quiet --set ON_ERROR_STOP=1 "$@"; }

fence_state() {
  psql_quiet --tuples-only --no-align --command "SELECT state FROM native_auth_transition" | tr -d '[:space:]'
}

prisma() { node node_modules/prisma/build/index.js "$@" --config prisma.config.ts; }

migrate() {
  step "applying committed migrations (forward-only)"
  DATABASE_URL="$PRISMA_MIGRATE_DATABASE_URL" prisma migrate deploy
}

grants() {
  step "re-applying runtime grants and checking stockwise_app privileges"
  psql_quiet --file "${db_dir}/grants.sql"
}

report_fence() {
  local state
  state="$(fence_state)"
  echo "STOCKWISE_FENCE_STATE:${state}"
}

case "$action" in
  bootstrap-roles)
    require STOCKWISE_MASTER_USERNAME STOCKWISE_MASTER_PASSWORD STOCKWISE_MIGRATOR_PASSWORD STOCKWISE_APP_PASSWORD
    base64url_password STOCKWISE_MIGRATOR_PASSWORD
    base64url_password STOCKWISE_APP_PASSWORD
    [[ "$STOCKWISE_MIGRATOR_PASSWORD" != "$STOCKWISE_APP_PASSWORD" ]] || die "role passwords must differ"
    step "creating or updating stockwise_migrator and stockwise_app (idempotent)"
    PGUSER="$STOCKWISE_MASTER_USERNAME" PGPASSWORD="$STOCKWISE_MASTER_PASSWORD" \
      STOCKWISE_MIGRATOR_DB_PASSWORD="$STOCKWISE_MIGRATOR_PASSWORD" \
      STOCKWISE_APP_DB_PASSWORD="$STOCKWISE_APP_PASSWORD" \
      psql_quiet --file "${db_dir}/roles.sql"
    echo "STOCKWISE_BOOTSTRAP:COMPLETE"
    ;;
  migrate) as_migrator; migrate ;;
  grants) as_migrator; grants ;;
  fence-state) as_migrator; report_fence ;;
  prepare) as_migrator; migrate; grants; report_fence ;;
  status) as_migrator; DATABASE_URL="$PRISMA_MIGRATE_DATABASE_URL" prisma migrate status ;;
  seed)
    as_migrator
    require DEMO_USER_PASSWORD
    [[ "$(fence_state)" == "LEGACY" ]] || die "seeding requires the LEGACY state (seed before the Native cutover)"
    step "seeding synthetic stockwise-demo-v1 data (optional, D-08)"
    node /opt/stockwise/seed-through-loopback.mjs
    ;;
  uat-provision)
    # Owner-authorized UAT accounts/memberships (apps/api/src/uat): verified
    # Native users for uat-*@owner-domain only, hash-only input, no email.
    as_migrator
    require STOCKWISE_UAT_PHASE STOCKWISE_UAT_SPEC_B64
    [[ "$STOCKWISE_UAT_PHASE" =~ ^(accounts|memberships)$ ]] || die "STOCKWISE_UAT_PHASE must be accounts or memberships"
    [[ "$(fence_state)" == "NATIVE" ]] || die "UAT provisioning requires the NATIVE state"
    step "uat-provision ${STOCKWISE_UAT_PHASE} on ${STOCKWISE_DB_NAME}"
    node dist/uat/uat-provision-main.js
    ;;
  cutover)
    as_migrator
    state="$(fence_state)"
    case "$state" in
      NATIVE)
        echo "STOCKWISE_FENCE_STATE:NATIVE"
        echo "STOCKWISE_CUTOVER:ALREADY_NATIVE"
        exit 0
        ;;
      QUIESCED) die "a cutover was interrupted; inspect it, then resume deliberately with native-cutover-main.js --resume" ;;
      LEGACY) ;;
      *) die "unexpected fence state" ;;
    esac
    # Independent of the ECS check in run-ops-task.sh: no runtime-role session
    # may be open while the database is sealed.
    sessions="$(psql_quiet --tuples-only --no-align --command \
      "SELECT count(*) FROM pg_stat_activity WHERE usename = 'stockwise_app'" | tr -d '[:space:]')"
    [[ "$sessions" == "0" ]] || die "stockwise_app has ${sessions} open session(s); stop the application service first"
    step "running native:cutover on ${STOCKWISE_DB_NAME} (one-way)"
    node dist/native-cutover/native-cutover-main.js --confirm-database "$STOCKWISE_DB_NAME"
    state="$(fence_state)"
    [[ "$state" == "NATIVE" ]] || die "cutover did not seal the database NATIVE (state ${state})"
    echo "STOCKWISE_FENCE_STATE:NATIVE"
    echo "STOCKWISE_CUTOVER:COMPLETE"
    ;;
  export)
    as_migrator
    require STOCKWISE_EXPORT_BUCKET
    # Operators may bind an export to an id (teardown.sh does); otherwise one
    # is generated. The id is part of the object key and its metadata.
    export_id="${STOCKWISE_EXPORT_ID:-adhoc-$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')}"
    [[ "$export_id" =~ ^[a-z0-9-]{8,64}$ ]] || die "STOCKWISE_EXPORT_ID must be 8-64 of [a-z0-9-]"
    file="/tmp/${STOCKWISE_DB_NAME}-$(date -u +%Y%m%dT%H%M%SZ)-${export_id}.dump"
    key="exports/${STOCKWISE_DB_NAME}/$(basename "$file" | sed "s/^${STOCKWISE_DB_NAME}-//")"
    step "pg_dump (custom format) as stockwise_migrator"
    pg_dump --format=custom --no-owner --no-privileges --file "$file"
    [[ -s "$file" ]] || die "pg_dump produced an empty archive"
    pg_restore --list "$file" >/dev/null || die "pg_dump produced an archive pg_restore cannot read"
    digest="$(sha256sum "$file" | cut -d' ' -f1)"
    bytes="$(stat -c %s "$file")"
    endpoint=()
    # Local rehearsal only (an S3-compatible stand-in); unset in AWS.
    [[ -n "${STOCKWISE_EXPORT_S3_ENDPOINT_URL:-}" ]] && endpoint=(--endpoint-url "$STOCKWISE_EXPORT_S3_ENDPOINT_URL")
    aws "${endpoint[@]}" s3api put-object --bucket "$STOCKWISE_EXPORT_BUCKET" --key "$key" \
      --body "$file" --metadata "sha256=${digest},export-id=${export_id},database=${STOCKWISE_DB_NAME}" \
      --output text --query ETag >/dev/null
    rm -f "$file"
    # The single machine-readable result consumed by operator/verify-export.sh.
    echo "STOCKWISE_EXPORT_RESULT:v1 export_id=${export_id} database=${STOCKWISE_DB_NAME} bucket=${STOCKWISE_EXPORT_BUCKET} key=${key} bytes=${bytes} sha256=${digest}"
    ;;
esac
