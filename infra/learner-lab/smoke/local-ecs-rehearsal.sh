#!/usr/bin/env bash
# LOCAL ONLY rehearsal of the ADR-040 ECS task definitions on Docker Desktop
# (Git Bash on Windows, or Linux). Nothing touches AWS. It renders the real
# templates (terraform/templates) with task-runner.mjs and runs each container
# with the declared environment, secrets, read-only root, tmpfs, capabilities,
# init process, memory limits and health checks:
#   - a TLS-only PostgreSQL 16.15 (own test CA, hostssl only) stands in for RDS;
#   - a "pause" container owns the task network namespace like the awsvpc ENI,
#     and api and web join it, so the API is reachable only on its loopback;
#   - a moto S3 server stands in for the exports bucket;
#   - ops tasks run bootstrap-roles, prepare, seed, cutover and export in the
#     ADR-040 order; Native-only startup and the role restrictions are probed.
# The local test CA is mounted over the baked RDS bundle (the only deviation).
# Every resource carries the label lls.run=<run> and is removed at the end.
#   infra/learner-lab/smoke/local-ecs-rehearsal.sh [web-image api-image ops-image]
# shellcheck disable=SC2329
set -euo pipefail
export MSYS_NO_PATHCONV=1

repo="$(cd "$(dirname "$0")/../../.." && pwd)"
smoke_dir="${repo}/infra/learner-lab/smoke"
templates="${repo}/infra/learner-lab/terraform/templates"
run="lls-ecs-$(date -u +%Y%m%d%H%M%S)-$RANDOM"
home="${repo}/test-results/learner-lab-ecs-rehearsal/${run}"
vm_home="/run/desktop/mnt/host${home}"
[[ -d /run/desktop/mnt/host ]] || [[ "$(uname -s)" != Linux ]] || vm_home="$home"
network="${run}-net"
label=(--label "lls.run=${run}")
web_image="${1:-stockwise-local/web:ecs-candidate}"
api_image="${2:-stockwise-local/api:ecs-candidate}"
ops_image="${3:-stockwise-local/ops:ecs-candidate}"
postgres_image="postgres:16.15-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea"
alpine_image="alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc"
s3_image="motoserver/moto:5.1.14@sha256:800719627036dc38dc699e9f314f624f2c98ac3d8bb754db078cb2698f08ee77"
public_origin="https://stockwise-demo.example.test"
results=()

record() { results+=("$1:$2"); echo "LOCAL_ECS:$1:$2"; }
check() {
  local name="$1"
  shift
  if "$@"; then record "$name" PASS; else record "$name" FAIL; fi
}
win() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }
key() { node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))"; }
runner() { node "$(win "${smoke_dir}/task-runner.mjs")" "$@"; }

cleanup() {
  set +e
  echo "LOCAL_ECS: cleaning up ${run}"
  local ids
  mapfile -t ids < <(docker ps -aq --filter "label=lls.run=${run}")
  [[ ${#ids[@]} -gt 0 ]] && docker rm -f -v "${ids[@]}" >/dev/null
  docker network rm "$network" >/dev/null 2>&1
  local left
  left="$(docker ps -aq --filter "label=lls.run=${run}" | wc -l)$(docker network ls -q --filter "name=${network}" | wc -l)"
  if [[ "$left" == "00" ]]; then echo "LOCAL_ECS_CLEANUP:COMPLETE"; else echo "LOCAL_ECS_CLEANUP:INCOMPLETE"; fi
  # Generated secrets exist only under this run's directory.
  rm -rf "${home}/secrets.json" "${home}/env" "${home}/certs" "${home}/login.json" "${home}/curl-body.tmp"
}
trap cleanup EXIT

mkdir -p "${home}/certs" "${home}/env" "${home}/defs"
docker run --rm "${label[@]}" -v "${vm_home}/certs:/certs" "$alpine_image" sh -ec '
  apk add --quiet --no-cache openssl >/dev/null
  cd /certs
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=lls stand-in RDS CA" -keyout ca.key -out ca.pem
  openssl req -newkey rsa:2048 -nodes -subj "/CN=lls-postgres" -keyout server.key -out server.csr
  printf "subjectAltName=DNS:lls-postgres\n" > san.ext
  openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 2 -extfile san.ext -out server.crt
  printf "local all all trust\nhostssl all all all scram-sha-256\nhost all all all reject\n" > pg_hba.conf
  rm -f ca.key server.csr san.ext ca.srl' 2>/dev/null
ca_mount=(-v "${vm_home}/certs/ca.pem:/etc/stockwise/rds-global-bundle.pem:ro")

master="$(key)" app="$(key)" migrator="$(key)" demo="$(key)"
node -e '
const [file, master, app, migrator, demo, ...keys] = process.argv.slice(1);
const names = ["STOCKWISE_ANALYTICS_CURSOR_HMAC_KEY","STOCKWISE_VERIFICATION_OTP_KEY","STOCKWISE_VERIFICATION_PROOF_KEY","STOCKWISE_BETTER_AUTH_SECRET","STOCKWISE_INVITATION_CONTINUATION_KEY"];
const application = Object.fromEntries(names.map((n, i) => [n, keys[i]]));
application.RESEND_API_KEY = "re_local_rehearsal_never_sends";
require("fs").writeFileSync(file, JSON.stringify({
  "local:master": { username: "stockwise_master", password: master },
  "local:database": { app_password: app, migrator_password: migrator, demo_user_password: demo },
  "local:application": application }), { mode: 0o600 });
' "$(win "${home}/secrets.json")" "$master" "$app" "$migrator" "$demo" "$(key)" "$(key)" "$(key)" "$(key)" "$(key)"

docker network create "${label[@]}" "$network" >/dev/null
docker run -d "${label[@]}" --name "${run}-postgres" --network "$network" --network-alias lls-postgres \
  -e POSTGRES_USER=stockwise_master -e POSTGRES_PASSWORD="$master" -e POSTGRES_DB=stockwise_demo \
  -v "${vm_home}/certs:/certs-in:ro" "$postgres_image" \
  sh -ec 'install -o postgres -m 0600 /certs-in/server.key /var/lib/postgresql/server.key
          install -o postgres -m 0644 /certs-in/server.crt /certs-in/pg_hba.conf /var/lib/postgresql/
          exec docker-entrypoint.sh postgres -c ssl=on \
            -c ssl_cert_file=/var/lib/postgresql/server.crt -c ssl_key_file=/var/lib/postgresql/server.key \
            -c hba_file=/var/lib/postgresql/pg_hba.conf' >/dev/null
docker run -d "${label[@]}" --name "${run}-s3" --network "$network" --network-alias lls-s3 "$s3_image" >/dev/null
for _ in $(seq 1 60); do
  docker exec "${run}-postgres" pg_isready -U stockwise_master -d stockwise_demo >/dev/null 2>&1 && break
  sleep 1
done
sleep 3

# ---- render the task definitions exactly as Terraform does -----------------------
cat >"${home}/defs/app-vars.json" <<EOF
{ "region": "us-east-1", "db_host": "lls-postgres", "db_port": "5432", "db_name": "stockwise_demo",
  "web_image": "${web_image}", "api_image": "${api_image}", "public_web_origin": "${public_origin}",
  "email_from": "StockWise Demo <noreply@example.invalid>", "web_log_group": "local", "api_log_group": "local",
  "database_secret_arn": "local:database", "application_secret_arn": "local:application" }
EOF
runner render "$(win "${templates}/app-containers.json.tftpl")" "$(win "${home}/defs/app-vars.json")" >"${home}/defs/app.json"
for role in ops bootstrap export; do
  secrets="$(runner ops-secrets "$role")"
  node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ region: "us-east-1", db_host: "lls-postgres",
    db_port: "5432", db_name: "stockwise_demo", ops_image: process.argv[2], ops_role: process.argv[3],
    export_bucket: "lls-exports", ops_log_group: "local", secrets: process.argv[4] }))' \
    "$(win "${home}/defs/${role}-vars.json")" "$ops_image" "$role" "$secrets"
  runner render "$(win "${templates}/ops-container.json.tftpl")" "$(win "${home}/defs/${role}-vars.json")" >"${home}/defs/${role}.json"
done
record TEMPLATES_RENDER PASS

container_args() {
  # $1 definitions, $2 container name, $3 env-file name, [$4 secrets json]
  local secrets="${4:-${home}/secrets.json}"
  mapfile -d '' -t args < <(runner args "$(win "$1")" "$2" "$(win "$secrets")" "$(win "${home}/env/$3")")
}

ops_count=0
ops_task() {
  # ops_task <role> <action> [extra docker args...] -> log path in $ops_log
  local role="$1" action="$2"
  shift 2
  ops_count=$((ops_count + 1))
  ops_log="${home}/ops-${ops_count}-${role}-${action}.log"
  container_args "${home}/defs/${role}.json" ops "ops-${ops_count}.env"
  docker run --rm "${label[@]}" --name "${run}-ops-${ops_count}" --network "$network" \
    "${args[@]}" "${ca_mount[@]}" "$@" "$ops_image" "$action" >"$ops_log" 2>&1
}

# ---- ops tasks in the ADR-040 order --------------------------------------------------
check OPS_BOOTSTRAP_ROLES ops_task bootstrap bootstrap-roles
if ops_task bootstrap migrate; then record OPS_ROLE_SCOPE_ENFORCED FAIL; else
  if grep -q "not permitted for the 'bootstrap'" "$ops_log"; then record OPS_ROLE_SCOPE_ENFORCED PASS; else record OPS_ROLE_SCOPE_ENFORCED FAIL; fi
fi
check OPS_PREPARE_MIGRATE_GRANTS ops_task ops prepare
if grep -q '^STOCKWISE_FENCE_STATE:LEGACY' "$ops_log"; then record FENCE_LEGACY_AFTER_PREPARE PASS; else record FENCE_LEGACY_AFTER_PREPARE FAIL; fi

app_container() {
  # app_container <name> <extra docker args...>
  local name="$1"
  shift
  container_args "${home}/defs/app.json" "$name" "app-${name}.env"
  local image
  image="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).find(c=>c.name===process.argv[2]).image)' "$(win "${home}/defs/app.json")" "$name")"
  docker run -d "${label[@]}" "${args[@]}" "${ca_mount[@]}" "$@" "$image" >/dev/null
}

# Native-only startup: the API refuses a database that is not sealed NATIVE.
docker run -d "${label[@]}" --name "${run}-pause-legacy" --network "$network" "$alpine_image" sleep 600 >/dev/null
app_container api --name "${run}-api-legacy" --network "container:${run}-pause-legacy"
status="$(timeout 120 docker wait "${run}-api-legacy" || echo timeout)"
docker logs "${run}-api-legacy" >"${home}/api-before-cutover.log" 2>&1
if [[ "$status" != 0 && "$status" != timeout ]]; then record API_REFUSES_LEGACY_DATABASE PASS; else record API_REFUSES_LEGACY_DATABASE "FAIL_${status}"; fi
docker rm -f "${run}-api-legacy" "${run}-pause-legacy" >/dev/null

# F5: the seed path refuses any TLS downgrade before connecting.
if ops_task ops seed -e STOCKWISE_SEED_PGSSLMODE=no-verify; then record SEED_REFUSES_NO_VERIFY_OVERRIDE FAIL; else
  if grep -q 'SEED_TLS_OVERRIDE_REFUSED' "$ops_log"; then record SEED_REFUSES_NO_VERIFY_OVERRIDE PASS; else record SEED_REFUSES_NO_VERIFY_OVERRIDE FAIL; fi
fi
# The real seed connects through the verified forwarder (stand-in CA, hostname lls-postgres).
check OPS_SEED_WHILE_LEGACY ops_task ops seed

# The cutover refuses while any stockwise_app session is open. The session is
# held idle (psql waiting on stdin), like an application pool connection, so
# the server notices immediately when its container goes away.
docker run -d "${label[@]}" --name "${run}-app-session" --network "$network" -e PGPASSWORD="$app" \
  -v "${vm_home}/certs/ca.pem:/certs/ca.pem:ro" "$postgres_image" sh -c \
  'sleep 300 | psql "host=lls-postgres dbname=stockwise_demo user=stockwise_app sslmode=verify-full sslrootcert=/certs/ca.pem"' >/dev/null
sleep 4
if ops_task ops cutover; then record CUTOVER_REFUSES_OPEN_APP_SESSION FAIL; else
  if grep -q "open session" "$ops_log"; then record CUTOVER_REFUSES_OPEN_APP_SESSION PASS; else record CUTOVER_REFUSES_OPEN_APP_SESSION FAIL; fi
fi
docker rm -f "${run}-app-session" >/dev/null
for _ in $(seq 1 30); do
  [[ "$(docker exec "${run}-postgres" psql -U stockwise_master -d stockwise_demo -tAc \
    "SELECT count(*) FROM pg_stat_activity WHERE usename = 'stockwise_app'")" == 0 ]] && break
  sleep 1
done
check OPS_NATIVE_CUTOVER ops_task ops cutover
if grep -q '^STOCKWISE_CUTOVER:COMPLETE' "$ops_log"; then record FENCE_SEALED_NATIVE PASS; else record FENCE_SEALED_NATIVE FAIL; fi
if ops_task ops seed; then record SEED_REFUSED_AFTER_NATIVE FAIL; else record SEED_REFUSED_AFTER_NATIVE PASS; fi
check OPS_PREPARE_IDEMPOTENT_AFTER_NATIVE ops_task ops prepare

# ---- the application task: pause (task ENI) + api + web -------------------------------
start_task() {
  docker run -d "${label[@]}" --name "${run}-pause" --network "$network" -p 127.0.0.1::3000 --init \
    "$alpine_image" sleep 86400 >/dev/null
  app_container api --name "${run}-api" --network "container:${run}-pause"
  wait_healthy api || return 1
  # web dependsOn api HEALTHY, as declared.
  app_container web --name "${run}-web" --network "container:${run}-pause"
  wait_healthy web
}
wait_healthy() {
  local health
  mapfile -d '' -t health < <(runner health "$(win "${home}/defs/app.json")" "$1")
  for _ in $(seq 1 90); do
    docker exec "${run}-$1" "${health[@]}" >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}
stop_task() { docker rm -f "${run}-web" "${run}-api" "${run}-pause" >/dev/null 2>&1 || true; }

check APP_TASK_HEALTHY start_task
port="$(docker port "${run}-pause" 3000/tcp | head -1 | sed 's/.*://')"
base="http://127.0.0.1:${port}"
# Response bodies go to a scratch file: with MSYS_NO_PATHCONV set, a native
# Windows curl cannot open the literal path /dev/null.
sink="$(win "${home}/curl-body.tmp")"
status_of() { curl --silent --max-time 15 --output "$sink" --write-out '%{http_code}' "$@" || echo 000; }
expect() {
  local name="$1" expected="$2" status
  shift 2
  status="$(status_of "$@")"
  if [[ "$status" == "$expected" ]]; then record "$name" PASS; else record "$name" "FAIL_${status}"; fi
}
expect TARGET_HEALTH_CHECK_PATH 200 "${base}/api/health"
expect ANONYMOUS_ACCESS_CONTEXT_401 401 "${base}/api/v1/me/access-context"

printf '{"email":"demo-owner@example.invalid","password":"%s"}' "$demo" >"${home}/login.json"
headers="$(curl --silent --max-time 30 --output "$sink" --dump-header - -X POST "${base}/api/v1/auth/login" \
  -H "content-type: application/json" -H "origin: ${public_origin}" --data-binary "@$(win "${home}/login.json")" | tr -d '\r')"
rm -f "${home}/login.json"
if grep -q '^HTTP/[0-9.]* 200' <<<"$headers"; then record NATIVE_LOGIN_SEEDED_OWNER PASS; else
  record NATIVE_LOGIN_SEEDED_OWNER "FAIL_$(grep -m1 '^HTTP/' <<<"$headers" | awk '{print $2}')"; fi
session="$(grep -i '^set-cookie: __Secure-stockwise_native\.session_token=' <<<"$headers" | head -1 || true)"
if [[ -n "$session" ]] && grep -qi 'httponly' <<<"$session" && grep -qi '; *secure' <<<"$session" &&
  grep -qi 'samesite=lax' <<<"$session" && ! grep -qi 'domain=' <<<"$session"; then
  record SESSION_COOKIE_SECURE_HTTPONLY_LAX_HOSTONLY PASS
else
  record SESSION_COOKIE_SECURE_HTTPONLY_LAX_HOSTONLY FAIL
fi
cookie="$(sed -E 's/^set-cookie: ([^;]*).*/\1/I' <<<"$session")"
context="$(curl --silent --max-time 15 -H "cookie: ${cookie}" "${base}/api/v1/me/access-context" || true)"
if grep -q '"role":"OWNER"' <<<"$context"; then record ACCESS_CONTEXT_OWNER PASS; else record ACCESS_CONTEXT_OWNER FAIL; fi
expect CROSS_ORIGIN_LOGIN_REFUSED 403 -X POST -H "content-type: application/json" \
  -H "origin: https://cross-origin.invalid" --data '{"email":"demo-owner@example.invalid","password":"x"}' \
  "${base}/api/v1/auth/login"

# Loopback API: reachable inside the task namespace, never from the network.
task_ip="$(docker inspect -f "{{(index .NetworkSettings.Networks \"${network}\").IPAddress}}" "${run}-pause")"
check WEB_REACHABLE_ON_TASK_IP docker run --rm "${label[@]}" --network "$network" "$alpine_image" nc -z -w 3 "$task_ip" 3000
if docker run --rm "${label[@]}" --network "$network" "$alpine_image" nc -z -w 3 "$task_ip" 3001; then
  record API_NOT_REACHABLE_FROM_NETWORK FAIL; else record API_NOT_REACHABLE_FROM_NETWORK PASS; fi
check API_HEALTH_ON_TASK_LOOPBACK docker exec "${run}-web" node -e \
  "fetch('http://127.0.0.1:3001/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

# The entrypoint composes DATABASE_URL and removes the separate password
# variable from the node process (only counts are printed). The container
# environment itself, seen by the init process, still holds the injected
# secret: that is how ECS secret injection works.
env_counts="$(docker exec "${run}-api" sh -c 'for p in /proc/[0-9]*; do
    case "$(tr "\0" " " <"$p/cmdline" 2>/dev/null)" in "node dist/main.js"*) tr "\0" "\n" <"$p/environ" ;; esac
  done' | awk -F= '$1=="STOCKWISE_DB_PASSWORD"{p++} $1=="DATABASE_URL"{d++} END{print p+0, d+0}')"
if [[ "$env_counts" == "0 1" ]]; then record API_PROCESS_ENV_COMPOSED PASS; else record API_PROCESS_ENV_COMPOSED "FAIL_${env_counts// /_}"; fi
if docker exec "${run}-api" sh -c 'touch /repo/probe' >/dev/null 2>&1; then record READ_ONLY_ROOT FAIL; else record READ_ONLY_ROOT PASS; fi
if [[ "$(docker inspect -f '{{json .HostConfig.CapDrop}}' "${run}-api")" == *ALL* ]]; then record CAPABILITIES_DROPPED PASS; else record CAPABILITIES_DROPPED FAIL; fi

# Production refuses Legacy selection and a missing database secret.
docker run -d "${label[@]}" --name "${run}-pause-probe" --network "$network" "$alpine_image" sleep 600 >/dev/null
app_container api --name "${run}-api-legacy-env" --network "container:${run}-pause-probe" \
  -e STOCKWISE_AUTHENTICATION_AUTHORITY=legacy
status="$(timeout 90 docker wait "${run}-api-legacy-env" || echo timeout)"
if [[ "$status" != 0 && "$status" != timeout ]]; then record PRODUCTION_REFUSES_LEGACY_AUTHORITY PASS; else
  record PRODUCTION_REFUSES_LEGACY_AUTHORITY "FAIL_${status}"; fi
docker logs "${run}-api-legacy-env" >"${home}/api-legacy-authority.log" 2>&1
output="$(docker run --rm "${label[@]}" -e STOCKWISE_DB_HOST=lls-postgres -e STOCKWISE_DB_PORT=5432 \
  -e STOCKWISE_DB_NAME=stockwise_demo -e STOCKWISE_DB_USER=stockwise_app "$api_image" 2>&1 || true)"
if grep -q 'STOCKWISE_REFUSED: STOCKWISE_DB_PASSWORD is not set' <<<"$output"; then record MISSING_SECRET_REFUSED PASS; else
  record MISSING_SECRET_REFUSED FAIL; fi
docker rm -f "${run}-api-legacy-env" "${run}-pause-probe" >/dev/null

# Runtime database role: DML only, read-only fence, no DDL, TLS required.
app_sql() {
  docker run --rm "${label[@]}" --network "$network" -e PGPASSWORD="$app" \
    -v "${vm_home}/certs/ca.pem:/certs/ca.pem:ro" "$postgres_image" psql --no-psqlrc --quiet --tuples-only --no-align \
    "host=lls-postgres dbname=stockwise_demo user=stockwise_app sslmode=verify-full sslrootcert=/certs/ca.pem" \
    --command "$1" 2>&1
}
if app_sql "SELECT count(*) FROM users" | grep -qx '[0-9][0-9]*'; then record APP_ROLE_READS PASS; else record APP_ROLE_READS FAIL; fi
if app_sql "UPDATE users SET display_name = display_name WHERE false" >/dev/null; then record APP_ROLE_WRITES_APPLICATION_TABLES PASS; else
  record APP_ROLE_WRITES_APPLICATION_TABLES FAIL; fi
for probe in "UPDATE native_auth_transition SET state = state" "DELETE FROM native_auth_enrollments" \
  "TRUNCATE users" "ALTER TABLE users DISABLE TRIGGER users_native_auth_fence" \
  "CREATE TABLE app_probe (id int)" "DELETE FROM _prisma_migrations"; do
  # psql exits non-zero on the expected refusal; the output is what is checked.
  output="$(app_sql "$probe" || true)"
  if grep -qiE 'permission denied|must be owner' <<<"$output"; then record "APP_ROLE_DENIED:${probe%% *}_${probe##* }" PASS; else
    record "APP_ROLE_DENIED:${probe%% *}_${probe##* }" FAIL; fi
done
output="$(app_sql "UPDATE native_auth_transition SET id = false" || true)"
if grep -qi "singleton id is immutable" <<<"$output"; then record APP_ROLE_FENCE_UPDATE_REFUSED_BY_TRIGGER PASS; else
  record APP_ROLE_FENCE_UPDATE_REFUSED_BY_TRIGGER FAIL; fi
output="$(docker run --rm "${label[@]}" --network "$network" -e PGPASSWORD="$app" "$postgres_image" \
  psql "host=lls-postgres dbname=stockwise_demo user=stockwise_app sslmode=disable" -c "SELECT 1" 2>&1 || true)"
if grep -qi 'pg_hba.conf' <<<"$output"; then record DATABASE_REFUSES_PLAINTEXT PASS; else record DATABASE_REFUSES_PLAINTEXT FAIL; fi

# Task replacement (what ECS does after a failure): the session survives.
docker logs "${run}-api" >"${home}/api-container.log" 2>&1
docker logs "${run}-web" >"${home}/web-container.log" 2>&1
stop_task
check APP_TASK_REPLACED_HEALTHY start_task
port="$(docker port "${run}-pause" 3000/tcp | head -1 | sed 's/.*://')"
expect SESSION_SURVIVES_TASK_REPLACEMENT 200 -H "cookie: ${cookie}" "http://127.0.0.1:${port}/api/v1/me/access-context"
docker logs "${run}-api" >"${home}/api-container-2.log" 2>&1
stop_task

# ---- export to the S3 stand-in ----------------------------------------------------------
s3_env=(-e STOCKWISE_EXPORT_S3_ENDPOINT_URL=http://lls-s3:5000 -e AWS_ACCESS_KEY_ID=local-rehearsal
  -e AWS_SECRET_ACCESS_KEY=local-rehearsal -e AWS_DEFAULT_REGION=us-east-1)
docker run --rm "${label[@]}" --network "$network" "${s3_env[@]}" -e HOME=/tmp --entrypoint aws "$ops_image" \
  --endpoint-url http://lls-s3:5000 s3api create-bucket --bucket lls-exports >/dev/null
# Bound to an export id, as teardown.sh does; the result marker must carry it.
export_id="rehearsal-$RANDOM$RANDOM"
check OPS_EXPORT_TO_S3 ops_task export export "${s3_env[@]}" -e "STOCKWISE_EXPORT_ID=${export_id}"
line="$(grep '^STOCKWISE_EXPORT_RESULT:v1 ' "$ops_log" || true)"
object="$(sed -nE 's#.* key=([^ ]*) .*#\1#p' <<<"$line")"
digest="$(sed -nE 's#.* sha256=([0-9a-f]{64})$#\1#p' <<<"$line")"
if [[ "$(grep -c '^STOCKWISE_EXPORT_RESULT:v1 ' "$ops_log")" == 1 && "$line" == *" export_id=${export_id} database=stockwise_demo bucket=lls-exports "* &&
  "$object" =~ ^exports/stockwise_demo/[0-9]{8}T[0-9]{6}Z-${export_id}\.dump$ ]]; then
  record EXPORT_RESULT_MARKER_BOUND_TO_EXPORT_ID PASS
else
  record EXPORT_RESULT_MARKER_BOUND_TO_EXPORT_ID FAIL
fi
verify="$(docker run --rm "${label[@]}" --network "$network" "${s3_env[@]}" -e HOME=/tmp --entrypoint sh "$ops_image" -c "
  aws --endpoint-url http://lls-s3:5000 s3api get-object --bucket lls-exports --key '${object}' /tmp/export.dump >/dev/null &&
  sha256sum /tmp/export.dump | cut -d' ' -f1 && pg_restore --list /tmp/export.dump | grep -c 'TABLE DATA'" 2>&1 || true)"
if [[ -n "$digest" && "$(head -1 <<<"$verify")" == "$digest" && "$(tail -1 <<<"$verify")" -gt 30 ]]; then
  record EXPORT_DOWNLOADS_VERIFIES_AND_RESTORES_LIST PASS
else
  record EXPORT_DOWNLOADS_VERIFIES_AND_RESTORES_LIST FAIL
fi

# ---- secret hygiene: no generated value in any retained log -----------------------------
leaks=0
while IFS= read -r value; do
  [[ -z "$value" ]] && continue
  grep -rlF -- "$value" "$home" --include='*.log' >/dev/null 2>&1 && leaks=$((leaks + 1))
done < <(node -e 'const s=require(process.argv[1]);for(const g of Object.values(s))for(const v of Object.values(g))console.log(v)' "$(win "${home}/secrets.json")")
if [[ "$leaks" == 0 ]]; then record LOG_SECRET_SCAN PASS; else record LOG_SECRET_SCAN "FAIL_${leaks}"; fi

failed=0
for result in "${results[@]}"; do [[ "$result" == *":PASS" ]] || failed=1; done
printf '%s\n' "${results[@]}" >"${home}/summary.txt"
echo "LOCAL_ECS_EVIDENCE:${home}"
echo "LOCAL_ECS_RESULTS:$(grep -c ':PASS$' "${home}/summary.txt")/${#results[@]}"
if [[ "$failed" == 0 ]]; then echo "LOCAL_ECS:PASS"; else echo "LOCAL_ECS:FAIL"; fi
exit "$failed"
