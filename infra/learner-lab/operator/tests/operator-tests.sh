#!/usr/bin/env bash
# Adversarial regression tests for the Learner Lab operator scripts
# (STOCKWISE-P8-ADR040-INFRA-REMEDIATION-01: findings F2, F3, F6, F7).
# AWS and Terraform are replaced by recording stubs (tests/stubs); nothing
# leaves this machine. Archive checks use a real pg_restore in a disposable,
# labelled PostgreSQL container that is removed at the end.
#   operator-tests.sh [operator-dir]      default: the operator directory above
# Pass an older copy of the operator directory to reproduce its failures.
# Prints OPERATOR_TEST:<id>:PASS|FAIL and exits non-zero if any case fails.
# Each case runs operator scripts in a subshell to isolate its environment.
# shellcheck disable=SC2329,SC2030,SC2031
set -euo pipefail

tests_dir="$(cd "$(dirname "$0")" && pwd)"
operator="$(cd "${1:-${tests_dir}/..}" && pwd)"
repo="$(cd "${tests_dir}/../../../.." && pwd)"
run="lls-optest-$(date -u +%Y%m%d%H%M%S)-$RANDOM"
work="${repo}/test-results/operator-tests/${run}"
stubs="${tests_dir}/stubs"
postgres_image="postgres:16.15-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea"
account=111111111111
identity="arn:aws:sts::${account}:assumed-role/voclabs/user0000000=student@example.invalid"
results=()
mkdir -p "$work"

record() { results+=("$1:$2"); echo "OPERATOR_TEST:$1:$2"; }
expect() {
  local id="$1"
  shift
  if "$@"; then record "$id" PASS; else record "$id" FAIL; fi
}
native() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

cleanup() {
  set +e
  local ids
  mapfile -t ids < <(docker ps -aq --filter "label=lls.run=${run}")
  [[ ${#ids[@]} -gt 0 ]] && docker rm -f -v "${ids[@]}" >/dev/null
  if [[ "$(docker ps -aq --filter "label=lls.run=${run}" | wc -l)" == 0 ]]; then
    echo "OPERATOR_TEST_CLEANUP:COMPLETE"
  else
    echo "OPERATOR_TEST_CLEANUP:INCOMPLETE"
  fi
}
trap cleanup EXIT

new_case() {
  case_dir="${work}/$1"
  mkdir -p "${case_dir}/outputs" "${case_dir}/state" "${case_dir}/s3" "${case_dir}/s3meta"
  : >"${case_dir}/aws.log"
  : >"${case_dir}/terraform.log"
  local name value
  while IFS='=' read -r name value; do
    printf '%s' "$value" >"${case_dir}/outputs/${name}"
  done <<EOF
name_prefix=stockwise-demo
region=us-east-1
account_id=${account}
cluster_name=stockwise-demo
service_name=stockwise-demo-app
capacity_provider_name=stockwise-demo-ec2
task_subnets_csv=subnet-0aaaaaaaaaaaaaaaa,subnet-0bbbbbbbbbbbbbbbb
task_security_group_id=sg-0cccccccccccccccc
ops_log_group=/stockwise/stockwise-demo/ops
application_secret_arn=arn:aws:secretsmanager:us-east-1:${account}:secret:stockwise-demo/application-AbCdEf
database_secret_arn=arn:aws:secretsmanager:us-east-1:${account}:secret:stockwise-demo/database-AbCdEf
master_secret_arn=arn:aws:secretsmanager:us-east-1:${account}:secret:rds!db-0000-AbCdEf
db_master_username=stockwise_master
db_instance_identifier=stockwise-demo-postgres
db_name=stockwise_demo
exports_bucket=stockwise-demo-exports-${account}-us-east-1
planning_deadline=2099-01-01T00:00:00Z
cloudfront_enabled=false
public_origin=https://stockwise-demo.example.invalid
current_web_image=${account}.dkr.ecr.us-east-1.amazonaws.com/stockwise-demo/web@sha256:$(printf '1%.0s' {1..64})
current_api_image=${account}.dkr.ecr.us-east-1.amazonaws.com/stockwise-demo/api@sha256:$(printf '2%.0s' {1..64})
current_ops_image=${account}.dkr.ecr.us-east-1.amazonaws.com/stockwise-demo/ops@sha256:$(printf '3%.0s' {1..64})
current_app_desired_count=1
outage_alarm_name=stockwise-demo-no-healthy-target
EOF
  printf 'name_prefix = "stockwise-demo"\n' >"${case_dir}/demo.tfvars"
}

# Runs an operator script with the stubs first on PATH. Output goes to
# ${case_dir}/<label>.out; the exit status is returned.
operator_run() {
  local label="$1" script="$2"
  shift 2
  (
    export PATH="${stubs}:${PATH}" STUB_DIR="$case_dir" STUB_IDENTITY_ARN="${STUB_IDENTITY_ARN-$identity}"
    export STOCKWISE_OPERATOR_STATE_DIR="${case_dir}/state" AWS_REGION="${STUB_AWS_REGION:-us-east-1}" STOCKWISE_SMOKE_ATTEMPTS=1
    cd "${RUN_FROM:-$case_dir}"
    "${operator}/${script}" "$@"
  ) >"${case_dir}/${label}.out" 2>&1
}

no_terraform_mutation() { ! grep -qE '^(apply|destroy)( |$)' "${case_dir}/terraform.log"; }
no_run_task() { ! grep -q '^ecs run-task' "${case_dir}/aws.log"; }

# ---- F3: run-ops-task.sh verifies the Learner Lab identity before any submission ----
f3_refused() {
  # f3_refused <case> <identity ARN or MISSING> [output names to delete]
  new_case "f3-$1"
  local arn="$2"
  shift 2
  local name
  for name in "$@"; do rm -f "${case_dir}/outputs/${name}"; done
  STUB_IDENTITY_ARN="$arn" operator_run run run-ops-task.sh status && rc=0 || rc=$?
  [[ $rc != 0 ]] && no_run_task
}
expect F3_WRONG_ROLE_NO_SUBMISSION f3_refused wrong-role "arn:aws:sts::${account}:assumed-role/SomeOtherRole/session"
expect F3_MISSING_IDENTITY_NO_SUBMISSION f3_refused missing-identity MISSING
expect F3_WRONG_ACCOUNT_NO_SUBMISSION f3_refused wrong-account "arn:aws:sts::999999999999:assumed-role/voclabs/user"
expect F3_IAM_USER_NOT_LAB_ROLE_NO_SUBMISSION f3_refused iam-user "arn:aws:iam::${account}:user/voclabs"
expect F3_UNKNOWN_EXPECTED_ACCOUNT_NO_SUBMISSION f3_refused no-state "$identity" account_id application_secret_arn
new_case f3-correct
printf 'STOCKWISE_OPS: status\n' >"${case_dir}/task-log.txt"
operator_run run run-ops-task.sh status && rc=0 || rc=$?
expect F3_CORRECT_IDENTITY_SUBMITS bash -c "[[ $rc == 0 ]] && grep -q '^ecs run-task' '${case_dir}/aws.log'"

# ---- F6: put-secrets.sh never leaves a secret payload behind ------------------------
payload_left() { compgen -G "${case_dir}/state/secret.*" >/dev/null || compgen -G "${operator}/.state/secret.*" >/dev/null; }
printf 're_testonly_0123456789abcdef\n' >"${work}/resend-key"
new_case f6-failed-upload
STUB_PUT_FAIL=1 operator_run put put-secrets.sh --resend-key-file "$(native "${work}/resend-key")" && rc=0 || rc=$?
expect F6_FAILED_UPLOAD_EXITS_NONZERO bash -c "[[ $rc != 0 ]]"
expect F6_FAILED_UPLOAD_PAYLOAD_EXISTED_DURING_CALL grep -q 'payload-present:yes' "${case_dir}/aws.log"
if payload_left; then record F6_FAILED_UPLOAD_LEAVES_NO_PAYLOAD FAIL; else record F6_FAILED_UPLOAD_LEAVES_NO_PAYLOAD PASS; fi
rm -f "${operator}/.state/secret."* 2>/dev/null || true
new_case f6-success
operator_run put put-secrets.sh --resend-key-file "$(native "${work}/resend-key")" && rc=0 || rc=$?
expect F6_SUCCESS_EXITS_ZERO bash -c "[[ $rc == 0 ]]"
if payload_left; then record F6_SUCCESS_LEAVES_NO_PAYLOAD FAIL; else record F6_SUCCESS_LEAVES_NO_PAYLOAD PASS; fi
new_case f6-interrupted
(
  export PATH="${stubs}:${PATH}" STUB_DIR="$case_dir" STUB_IDENTITY_ARN="$identity" STUB_PUT_SLEEP=4
  export STOCKWISE_OPERATOR_STATE_DIR="${case_dir}/state" AWS_REGION=us-east-1
  cd "$case_dir"
  exec "${operator}/put-secrets.sh" --resend-key-file "$(native "${work}/resend-key")"
) >"${case_dir}/put.out" 2>&1 &
pid=$!
for _ in $(seq 1 40); do grep -q 'secretsmanager put-secret-value' "${case_dir}/aws.log" && break; sleep 0.25; done
kill -TERM "$pid" 2>/dev/null || true
wait "$pid" && rc=0 || rc=$?
sleep 5
expect F6_INTERRUPTED_EXITS_NONZERO bash -c "[[ $rc != 0 ]]"
if payload_left; then record F6_INTERRUPTED_LEAVES_NO_PAYLOAD FAIL; else record F6_INTERRUPTED_LEAVES_NO_PAYLOAD PASS; fi
rm -f "${operator}/.state/secret."* 2>/dev/null || true
# Generated values are 43-character base64url keys; none may appear in any
# retained output or stub log (the Resend test key is a fixed non-secret).
leaks="$(grep -rhoE '(^|[^A-Za-z0-9_-])[A-Za-z0-9_-]{43}([^A-Za-z0-9_-]|$)' "${work}"/f6-* 2>/dev/null | grep -vcE 'sha256|[0-9a-f]{43}' || true)"
expect F6_NO_SECRET_VALUE_IN_EVIDENCE bash -c "[[ '${leaks:-0}' == 0 ]]"

# ---- F7: tfvars paths are resolved before terraform -chdir -------------------------
f7_case() {
  # f7_case <id> <var-file argument> <run-from directory> <expected absolute path or "missing">
  local id="$1" argument="$2" from="$3" expected="$4"
  new_case "f7-${id}"
  local spaced="${case_dir}/dir with spaces"
  mkdir -p "$spaced" "${case_dir}/elsewhere/deeper"
  cp "${case_dir}/demo.tfvars" "${spaced}/demo vars.tfvars"
  argument="${argument//@CASE@/$case_dir}"
  from="${from//@CASE@/$case_dir}"
  expected="${expected//@CASE@/$case_dir}"
  RUN_FROM="$from" operator_run capacity capacity.sh pause --var-file "$argument" && rc=0 || rc=$?
  if [[ "$expected" == missing ]]; then
    expect "F7_${id}" bash -c "[[ $rc != 0 ]] && ! grep -qE '^(apply|destroy)' '${case_dir}/terraform.log'"
  else
    expect "F7_${id}" grep -qF -- "-var-file=$(native "$expected")" "${case_dir}/terraform.log"
  fi
}
f7_case ABSOLUTE_PATH "@CASE@/demo.tfvars" "@CASE@/elsewhere" "@CASE@/demo.tfvars"
f7_case RELATIVE_PATH "../demo.tfvars" "@CASE@/elsewhere" "@CASE@/demo.tfvars"
f7_case RELATIVE_FROM_OTHER_DIRECTORY "../../dir with spaces/demo vars.tfvars" "@CASE@/elsewhere/deeper" "@CASE@/dir with spaces/demo vars.tfvars"
f7_case PATH_WITH_SPACES "dir with spaces/demo vars.tfvars" "@CASE@" "@CASE@/dir with spaces/demo vars.tfvars"
f7_case MISSING_FILE "does-not-exist.tfvars" "@CASE@" missing
for script in rollback.sh teardown.sh; do
  new_case "f7-${script%.sh}-missing"
  extra=()
  [[ "$script" == teardown.sh ]] && extra=(--confirm stockwise-demo)
  operator_run run "$script" --var-file does-not-exist.tfvars "${extra[@]}" && rc=0 || rc=$?
  expect "F7_${script%.sh}_MISSING_FILE_REFUSED_WITHOUT_MUTATION" bash -c "[[ $rc != 0 ]] &&
    grep -q 'does-not-exist.tfvars is missing or unreadable' '${case_dir}/run.out' &&
    ! grep -qE '^(apply|destroy)' '${case_dir}/terraform.log' && ! grep -q '^ecs run-task' '${case_dir}/aws.log'"
done
# A relative --var-file reaches terraform as an absolute path from teardown too
# (exercised by the F2 cases, which pass "demo.tfvars" from the case directory).

# ---- R2-F3: every AWS-calling entry point verifies identity, account and region
# itself, before its first service call -----------------------------------------
only_identity_calls() { ! grep -vqE '^sts get-caller-identity( |$)' "${case_dir}/aws.log"; }
entry_args() {
  # Arguments that let each entry point get as far as it can.
  case "$1" in
    budget-check.sh) entry=() ;;
    verify-export.sh)
      # A well-formed marker, so a script without its own identity check would
      # go on to call S3 (as Codex reproduced).
      printf 'STOCKWISE_EXPORT_RESULT:v1 export_id=td-0000000000000000 database=stockwise_demo bucket=stockwise-demo-exports-%s-us-east-1 key=exports/stockwise_demo/20261031T000000Z-td-0000000000000000.dump bytes=100 sha256=%s\n' \
        "$account" "$(printf 'a%.0s' {1..64})" >"${case_dir}/task.log"
      entry=(task.log stockwise_demo td-0000000000000000 "stockwise-demo-exports-${account}-us-east-1" exports) ;;
    run-ops-task.sh) entry=(status) ;;
    put-secrets.sh) entry=(--resend-key-file "$(native "${work}/resend-key")") ;;
    mirror-images.sh)
      entry=(--web "ghcr.io/x/web@sha256:$(printf '1%.0s' {1..64})" --api "ghcr.io/x/api@sha256:$(printf '2%.0s' {1..64})"
        --ops "ghcr.io/x/ops@sha256:$(printf '3%.0s' {1..64})" --revision "$(printf 'a%.0s' {1..40})") ;;
    deploy.sh)
      printf 'WEB_IMAGE=%s\nAPI_IMAGE=%s\nOPS_IMAGE=%s\n' "$(cat "${case_dir}/outputs/current_web_image")" \
        "$(cat "${case_dir}/outputs/current_api_image")" "$(cat "${case_dir}/outputs/current_ops_image")" >"${case_dir}/release.env"
      entry=(--release release.env --var-file demo.tfvars) ;;
    rollback.sh) entry=(--var-file demo.tfvars) ;;
    capacity.sh) entry=(pause --var-file demo.tfvars) ;;
    teardown.sh) entry=(--var-file demo.tfvars --confirm stockwise-demo) ;;
  esac
}
identity_refused() {
  # identity_refused <script> <variant>
  local script="$1" variant="$2" arn="$identity" region=us-east-1
  new_case "r2f3-${script%.sh}-${variant}"
  case "$variant" in
    wrong-account) arn="arn:aws:sts::999999999999:assumed-role/voclabs/user" ;;
    wrong-role) arn="arn:aws:sts::${account}:assumed-role/SomeOtherRole/session" ;;
    iam-user) arn="arn:aws:iam::${account}:user/voclabs" ;;
    missing) arn=MISSING ;;
    malformed) arn="arn:aws:sts::1111:assumed-role/voclabs/user with spaces" ;;
    unavailable-binding) rm -f "${case_dir}/outputs/account_id" "${case_dir}/outputs/application_secret_arn" ;;
    wrong-region) region=eu-west-1 ;;
  esac
  entry_args "$script"
  STUB_IDENTITY_ARN="$arn" STUB_AWS_REGION="$region" operator_run run "$script" "${entry[@]}" && rc=0 || rc=$?
  [[ $rc != 0 ]] && only_identity_calls && no_terraform_mutation
}
for script in budget-check.sh verify-export.sh run-ops-task.sh put-secrets.sh mirror-images.sh deploy.sh \
  rollback.sh capacity.sh teardown.sh; do
  for variant in wrong-account wrong-role iam-user missing malformed unavailable-binding wrong-region; do
    expect "R2F3_${script%.sh}_${variant}_NO_SERVICE_CALL" identity_refused "$script" "$variant"
  done
done
# Positive control: with the right identity the standalone entry points proceed.
new_case r2f3-budget-check-correct
operator_run run budget-check.sh && rc=0 || rc=$?
expect R2F3_BUDGET_CHECK_CORRECT_IDENTITY_PROCEEDS bash -c "[[ $rc == 0 ]] && grep -q '^ec2 describe-instances' '${case_dir}/aws.log'"

# ---- R2-NEW-F1: put-secrets never reports READY on an AWS error or a bad value ----
secrets_refused() {
  # secrets_refused <case> <list mode> <get mode>
  new_case "r2nf1-$1"
  STUB_SM_LIST="$2" STUB_SM_GET="$3" operator_run put put-secrets.sh --resend-key-file "$(native "${work}/resend-key")" && rc=0 || rc=$?
  [[ $rc != 0 ]] && ! grep -q 'STOCKWISE_SECRETS:READY' "${case_dir}/put.out" && ! payload_left
}
list_refused() { secrets_refused "list-$1" "$1" valid && ! grep -q 'put-secret-value' "${case_dir}/aws.log"; }
for mode in accessdenied throttle timeout blank none json; do
  expect "R2NF1_LIST_${mode}_NOT_READY_NO_UPLOAD" list_refused "$mode"
done
for mode in malformed missingkey badvalue notjson accessdenied; do
  expect "R2NF1_READBACK_${mode}_NOT_READY" secrets_refused "get-${mode}" empty "$mode"
done
expect R2NF1_EXISTING_BUT_UNVERIFIABLE_NOT_READY secrets_refused existing-malformed current malformed
new_case r2nf1-fresh-valid
STUB_SM_LIST=empty STUB_SM_GET=valid operator_run put put-secrets.sh --resend-key-file "$(native "${work}/resend-key")" && rc=0 || rc=$?
expect R2NF1_FRESH_VALID_READY bash -c "[[ $rc == 0 ]] && grep -q 'STOCKWISE_SECRETS:READY' '${case_dir}/put.out' &&
  [[ \$(grep -c 'put-secret-value' '${case_dir}/aws.log') == 2 ]] && [[ \$(grep -c 'get-secret-value' '${case_dir}/aws.log') == 2 ]]"
new_case r2nf1-existing-valid
STUB_SM_LIST=current STUB_SM_GET=valid operator_run put put-secrets.sh --resend-key-file "$(native "${work}/resend-key")" && rc=0 || rc=$?
expect R2NF1_EXISTING_VALID_READY_WITHOUT_UPLOAD bash -c "[[ $rc == 0 ]] && grep -q 'STOCKWISE_SECRETS:READY' '${case_dir}/put.out' &&
  ! grep -q 'put-secret-value' '${case_dir}/aws.log'"

# R3-F2: full JSON syntax and decoded duplicate keys, through the real CLI helper.
for mode in blank invalid-inner trailing-comma duplicate duplicate-conflict duplicate-null \
  escaped-duplicate application-duplicate wrong-type null-value empty-value nested get-throttle get-timeout; do
  expect "R3F2_${mode}_NOT_READY" secrets_refused "r3-${mode}" current "$mode"
done
for mode in whitespace multiline; do
  new_case "r3f2-valid-${mode}"
  STUB_SM_LIST=current STUB_SM_GET="$mode" operator_run put put-secrets.sh --resend-key-file "$(native "${work}/resend-key")" && rc=0 || rc=$?
  expect "R3F2_VALID_${mode}_READY" bash -c "[[ $rc == 0 ]] && grep -q 'STOCKWISE_SECRETS:READY' '${case_dir}/put.out' &&
    ! grep -q 'put-secret-value' '${case_dir}/aws.log'"
done

# ---- R2-F8: resume reconciles an outage alarm already in ALARM ------------------
resets() { grep -c '^cloudwatch set-alarm-state .*--state-value INSUFFICIENT_DATA' "${case_dir}/aws.log" || true; }
# The reset must come after the scale-up to one task (notifications re-enabled).
reset_after_scale_up() {
  local apply reset
  apply="$(grep -n '^terraform apply .*app_desired_count=1' "${case_dir}/sequence.log" | head -1 | cut -d: -f1)"
  reset="$(grep -n '^aws cloudwatch set-alarm-state' "${case_dir}/sequence.log" | head -1 | cut -d: -f1)"
  [[ -n "$apply" && -n "$reset" && "$apply" -lt "$reset" ]]
}
resume() { operator_run "resume-$1" capacity.sh resume --var-file demo.tfvars && rc=0 || rc=$?; }

new_case r2f8-resume-alarm
STUB_ALARM_STATE=ALARM resume 1
expect R2F8_RESUME_RESETS_EXISTING_ALARM_AFTER_SCALE_UP bash -c "[[ \$(grep -c '^cloudwatch set-alarm-state' '${case_dir}/aws.log') == 1 ]] &&
  [[ \$(cat '${case_dir}/alarm-state') == INSUFFICIENT_DATA ]]"
expect R2F8_RESET_ORDERED_AFTER_SCALE_UP reset_after_scale_up
# A second resume before CloudWatch re-evaluates finds INSUFFICIENT_DATA: no second reset.
STUB_ALARM_STATE=ALARM resume 2
expect R2F8_REPEATED_RESUME_NO_DUPLICATE_RESET bash -c "[[ \$(grep -c '^cloudwatch set-alarm-state' '${case_dir}/aws.log') == 1 ]]"
# CloudWatch re-evaluated and the outage continues: the next resume resets again
# (one notification per failed resume attempt, never two for one attempt).
printf 'ALARM' >"${case_dir}/alarm-state"
STUB_ALARM_STATE=ALARM resume 3
expect R2F8_RESUME_AFTER_RENEWED_ALARM_RESETS_ONCE_MORE bash -c "[[ \$(grep -c '^cloudwatch set-alarm-state' '${case_dir}/aws.log') == 2 ]]"

new_case r2f8-resume-ok
STUB_ALARM_STATE=OK resume 1
expect R2F8_RESUME_OK_NO_RESET bash -c "! grep -q '^cloudwatch set-alarm-state' '${case_dir}/aws.log' && grep -q '^cloudwatch describe-alarms' '${case_dir}/aws.log'"

new_case r2f8-resume-fails
STUB_ALARM_STATE=ALARM STUB_ECS_WAIT_FAIL=1 resume 1
expect R2F8_FAILED_RESUME_STILL_RESET_AND_FAILS bash -c "[[ $rc != 0 ]] && [[ \$(grep -c '^cloudwatch set-alarm-state' '${case_dir}/aws.log') == 1 ]]"

new_case r2f8-alarm-unreadable
STUB_ALARM_STATE=ALARM STUB_ALARM_READ_FAIL=1 resume 1
expect R2F8_UNREADABLE_ALARM_FAILS_CLOSED bash -c "[[ $rc != 0 ]] && grep -q 'cannot read the outage alarm state' '${case_dir}/resume-1.out' &&
  ! grep -q '^cloudwatch set-alarm-state' '${case_dir}/aws.log' && ! grep -q '^ecs wait' '${case_dir}/aws.log'"

new_case r2f8-pause
STUB_ALARM_STATE=ALARM operator_run pause capacity.sh pause --var-file demo.tfvars && rc=0 || rc=$?
expect R2F8_PAUSE_SILENCES_WITHOUT_RESET bash -c "grep -q 'app_desired_count=0' '${case_dir}/terraform.log' && ! grep -q '^cloudwatch' '${case_dir}/aws.log'"

new_case r2f8-rollback
mkdir -p "${case_dir}/state"
printf 'WEB_IMAGE=%s\nAPI_IMAGE=%s\nOPS_IMAGE=%s\n' "$(cat "${case_dir}/outputs/current_web_image")" \
  "$(cat "${case_dir}/outputs/current_api_image")" "$(cat "${case_dir}/outputs/current_ops_image")" >"${case_dir}/state/release-previous.env"
printf 'STOCKWISE_FENCE_STATE:NATIVE\n' >"${case_dir}/task-log.txt"
STUB_ALARM_STATE=ALARM operator_run rollback rollback.sh --var-file demo.tfvars && rc=0 || rc=$?
expect R2F8_ROLLBACK_RECONCILES_AFTER_APPLY reset_after_scale_up

# ---- F9: deploy stops before any irreversible step until public HTTPS resolves -----
# public_origin is an .invalid hostname (never resolves), as on a fresh stack
# whose DNS record (G5) does not exist yet.
new_case f9-no-public-dns
{
  echo "WEB_IMAGE=$(cat "${case_dir}/outputs/current_web_image")"
  echo "API_IMAGE=$(cat "${case_dir}/outputs/current_api_image")"
  echo "OPS_IMAGE=$(cat "${case_dir}/outputs/current_ops_image")"
} >"${case_dir}/release.env"
operator_run deploy deploy.sh --release release.env --var-file demo.tfvars --native-cutover && rc=0 || rc=$?
expect F9_DEPLOY_REFUSES_CUTOVER_BEFORE_PUBLIC_DNS bash -c "[[ $rc != 0 ]] &&
  grep -q 'create the public DNS record (G5)' '${case_dir}/deploy.out' &&
  ! grep -q '^ecs run-task' '${case_dir}/aws.log' && [[ \$(grep -c '^apply' '${case_dir}/terraform.log') == 1 ]]"

# ---- F2: teardown refuses to destroy without a verified export ---------------------
docker run -d --label "lls.run=${run}" --name "${run}-pg" -e POSTGRES_PASSWORD=test-only \
  -e POSTGRES_DB=stockwise_demo "$postgres_image" >/dev/null
for _ in $(seq 1 60); do docker exec "${run}-pg" pg_isready -U postgres -d stockwise_demo >/dev/null 2>&1 && break; sleep 1; done
sleep 2
schema='CREATE TABLE users (id uuid PRIMARY KEY);
  CREATE TABLE native_auth_transition (id boolean PRIMARY KEY, state text NOT NULL);
  CREATE TABLE _prisma_migrations (id text PRIMARY KEY);
  INSERT INTO native_auth_transition VALUES (true, '"'NATIVE'"');'
docker exec "${run}-pg" psql -q -U postgres -d stockwise_demo -c "$schema" >/dev/null
docker exec "${run}-pg" psql -q -U postgres -c "CREATE DATABASE other_demo" >/dev/null
docker exec "${run}-pg" psql -q -U postgres -d other_demo -c "$schema" >/dev/null
fixtures="${work}/fixtures"
mkdir -p "$fixtures"
docker exec "${run}-pg" pg_dump -U postgres -Fc stockwise_demo >"${fixtures}/valid.dump"
docker exec "${run}-pg" pg_dump -U postgres -Fc other_demo >"${fixtures}/other-database.dump"
head -c "$(($(wc -c <"${fixtures}/valid.dump") / 2))" "${fixtures}/valid.dump" >"${fixtures}/truncated.dump"
: >"${fixtures}/empty.dump"
head -c 4096 /dev/urandom >"${fixtures}/random.dump"
sha() { sha256sum "$1" | cut -d' ' -f1; }
size() { wc -c <"$1" | tr -d ' '; }

bucket="stockwise-demo-exports-${account}-us-east-1"
key_for() { printf 'exports/%s/20261031T000000Z-@EXPORT_ID@.dump' "${1:-stockwise_demo}"; }
# f2_case <id> <fixture or -> <marker: good|none|key:<key>|db:<db>|sha:<hex>|bytes:<n>> <task exit>
f2_case() {
  local id="$1" fixture="$2" marker="$3" task_exit="$4"
  new_case "f2-${id}"
  local key bytes digest database=stockwise_demo
  key="$(key_for)"
  if [[ "$fixture" != - ]]; then
    bytes="$(size "${fixtures}/${fixture}")"
    digest="$(sha "${fixtures}/${fixture}")"
  else
    bytes=12345 digest="$(printf 'a%.0s' {1..64})"
  fi
  case "$marker" in
    key:*) key="${marker#key:}" ;;
    db:*) database="${marker#db:}" ;;
    sha:*) digest="${marker#sha:}" ;;
    bytes:*) bytes="${marker#bytes:}" ;;
  esac
  if [[ "$fixture" != - ]]; then
    mkdir -p "$(dirname "${case_dir}/s3/$(key_for)")" "$(dirname "${case_dir}/s3meta/$(key_for)")"
    cp "${fixtures}/${fixture}" "${case_dir}/s3/$(key_for)"
    sha "${fixtures}/${fixture}" >"${case_dir}/s3meta/$(key_for)"
  fi
  {
    echo "STOCKWISE_OPS: pg_dump (custom format) as stockwise_migrator"
    [[ "$marker" == none ]] ||
      echo "STOCKWISE_EXPORT_RESULT:v1 export_id=@EXPORT_ID@ database=${database} bucket=${bucket} key=${key} bytes=${bytes} sha256=${digest}"
  } >"${case_dir}/task-log.txt"
  STUB_EXIT_CODE="$task_exit" operator_run teardown teardown.sh --var-file demo.tfvars --confirm stockwise-demo && rc=0 || rc=$?
}
f2_refused() { f2_case "$@"; [[ $rc != 0 ]] && no_terraform_mutation; }

expect F2_NO_DUMP_DOWNLOADED f2_refused no-dump - good 0
expect F2_MISSING_RESULT_MARKER f2_refused missing-marker valid.dump none 0
expect F2_FAILED_EXPORT_TASK f2_refused failed-task valid.dump good 1
expect F2_WRONG_S3_OBJECT f2_refused wrong-object valid.dump "key:exports/stockwise_demo/20261030T000000Z-older-export.dump" 0
expect F2_EMPTY_ARCHIVE f2_refused empty empty.dump good 0
expect F2_TRUNCATED_ARCHIVE f2_refused truncated truncated.dump good 0
expect F2_SIZE_MISMATCH f2_refused size-mismatch valid.dump bytes:999 0
expect F2_CHECKSUM_MISMATCH f2_refused checksum-mismatch valid.dump "sha:$(printf 'b%.0s' {1..64})" 0
expect F2_INVALID_POSTGRES_ARCHIVE f2_refused invalid random.dump good 0
expect F2_WRONG_DATABASE_IN_ARCHIVE f2_refused wrong-database-archive other-database.dump good 0
expect F2_WRONG_DATABASE_IN_MARKER f2_refused wrong-database-marker valid.dump db:other_demo 0
f2_case verified valid.dump good 0
expect F2_VERIFIED_EXPORT_ALLOWS_TEARDOWN bash -c "[[ $rc == 0 ]] &&
  grep -q 'db_deletion_protection=false' '${case_dir}/terraform.log' && grep -qE '^destroy' '${case_dir}/terraform.log' &&
  compgen -G '${case_dir}/state/exports/*.dump.verified' >/dev/null"
expect F7_TEARDOWN_RELATIVE_PATH_RESOLVED grep -qF -- "-var-file=$(native "${case_dir}/demo.tfvars")" "${case_dir}/terraform.log"
expect F2_PROTECTION_LIFTED_ONLY_AFTER_VERIFICATION bash -c "grep -q 'STOCKWISE_EXPORT_VERIFIED' '${case_dir}/teardown.out' &&
  [[ \$(grep -n 'STOCKWISE_EXPORT_VERIFIED' '${case_dir}/teardown.out' | head -1 | cut -d: -f1) -lt \$(grep -n 'lifting RDS deletion protection' '${case_dir}/teardown.out' | head -1 | cut -d: -f1) ]]"

# R3-F2 final: shell-to-Node invocation through a symlink/junction, write-only
# master credentials, and a successful validator process that does no work.
link_type=dir
[[ "$(uname -s)" == MINGW* || "$(uname -s)" == MSYS* ]] && link_type=junction
node -e 'require("node:fs").symlinkSync(process.argv[1], process.argv[2], process.argv[3])' \
  "$(native "$(dirname "$operator")")" "$(native "${work}/learner-lab-alias")" "$link_type"
alias_operator="${work}/learner-lab-alias/$(basename "$operator")"
secret_invocation_case() {
  local operator="$1" target="$2" mode="$3" expected="$4" list_mode="${5:-current}"
  local args=(--resend-key-file "$(native "${work}/resend-key")")
  new_case "final-${#results[@]}-${target}-${mode}"
  if [[ "$target" == master ]]; then
    printf '%s' "arn:aws:secretsmanager:us-east-1:${account}:secret:stockwise-demo/master-AbCdEf" >"${case_dir}/outputs/master_secret_arn"
    args+=(--master-password-from-env)
  fi
  TF_VAR_db_master_password=SYNTHETIC_MASTER_PASSWORD_0123456789 \
    STUB_SM_LIST="$list_mode" STUB_SM_GET="$mode" STUB_SM_BAD_SECRET="$target" \
    operator_run put put-secrets.sh "${args[@]}" && rc=0 || rc=$?
  if [[ "$expected" == ready ]]; then
    [[ $rc == 0 ]] && grep -q 'STOCKWISE_SECRETS:READY' "${case_dir}/put.out" && ! payload_left
  else
    [[ $rc != 0 ]] && ! grep -q 'STOCKWISE_SECRETS:READY' "${case_dir}/put.out" && ! payload_left
  fi
}
for route in real alias; do
  candidate_operator="$operator"
  [[ "$route" == alias ]] && candidate_operator="$alias_operator"
  for target in database application master; do
    for mode in valid invalid-inner duplicate-any blank; do
      expected=refused
      [[ "$mode" == valid ]] && expected=ready
      expect "R3F2_FINAL_${route}_${target}_${mode}" secret_invocation_case "$candidate_operator" "$target" "$mode" "$expected"
    done
  done
  expect "R3F2_FINAL_${route}_MASTER_FRESH_UPLOAD" secret_invocation_case "$candidate_operator" master valid ready empty
done
mkdir -p "${work}/noop/operator" "${work}/noop/terraform"
cp "${operator}/put-secrets.sh" "${operator}/common.sh" "${work}/noop/operator/"
: >"${work}/noop/operator/validate-secret-json.mjs"
for target in database master; do
  expect "R3F2_FINAL_NOOP_EXIT_ZERO_${target}_REFUSED" secret_invocation_case "${work}/noop/operator" "$target" valid refused
done

# ---- ADR-041: reconcile-owners argument handling and ECS override contents ----
printf '{"version":1,"organizations":[]}
' >"${work}/reconcile-spec.json"
reconcile_refused() {
  # reconcile_refused <case> <args...>: refused before any ECS submission
  new_case "gov-$1"
  shift
  operator_run run run-ops-task.sh reconcile-owners "$@" && rc=0 || rc=$?
  [[ $rc != 0 ]] && no_run_task
}
spec_arg="$(native "${work}/reconcile-spec.json")"
expect GOV_RECONCILE_NO_MODE_REFUSED reconcile_refused nomode
expect GOV_RECONCILE_BAD_MODE_REFUSED reconcile_refused badmode --reconcile-mode delete
expect GOV_RECONCILE_APPLY_WITHOUT_DIGEST_REFUSED reconcile_refused nodigest --reconcile-mode apply --reconcile-spec-file "$spec_arg"
expect GOV_RECONCILE_APPLY_SHORT_DIGEST_REFUSED reconcile_refused shortdigest --reconcile-mode apply --reconcile-spec-file "$spec_arg" --reconcile-confirm-digest abc123
expect GOV_RECONCILE_DRYRUN_WITH_DIGEST_REFUSED reconcile_refused drydigest --reconcile-mode dry-run --reconcile-spec-file "$spec_arg" --reconcile-confirm-digest 0123456789abcdef
expect GOV_RECONCILE_DRYRUN_MISSING_SPEC_REFUSED reconcile_refused nospec --reconcile-mode dry-run
expect GOV_RECONCILE_VERIFY_WITH_SPEC_REFUSED reconcile_refused verifyspec --reconcile-mode verify --reconcile-spec-file "$spec_arg"
new_case gov-options-on-other-action
operator_run run run-ops-task.sh status --reconcile-mode verify && rc=0 || rc=$?
expect GOV_RECONCILE_OPTIONS_ONLY_FOR_RECONCILE_ACTION bash -c "[[ $rc != 0 ]] && ! grep -q '^ecs run-task' '${case_dir}/aws.log'"
override_case() {
  # override_case <case> <expected substring> <args...>
  new_case "gov-$1"
  local needle="$2"
  shift 2
  printf 'STOCKWISE_OPS: reconcile-owners
' >"${case_dir}/task-log.txt"
  operator_run run run-ops-task.sh reconcile-owners "$@" && rc=0 || rc=$?
  [[ $rc == 0 ]] && grep '^ecs run-task' "${case_dir}/aws.log" | grep -q -- "$needle" &&
    ! grep '^ecs run-task' "${case_dir}/aws.log" | grep -q '@'
}
expect GOV_RECONCILE_VERIFY_OVERRIDE override_case verify 'STOCKWISE_RECONCILE_MODE' --reconcile-mode verify
expect GOV_RECONCILE_DRYRUN_OVERRIDE override_case dry 'STOCKWISE_RECONCILE_SPEC_B64' --reconcile-mode dry-run --reconcile-spec-file "$spec_arg"
expect GOV_RECONCILE_APPLY_OVERRIDE override_case apply 'STOCKWISE_RECONCILE_CONFIRM_DIGEST' --reconcile-mode apply --reconcile-spec-file "$spec_arg" --reconcile-confirm-digest 0123456789abcdef

# ---- ADR-043: provision-demo argument handling and ECS override contents ----
printf '{"version":1}\n' >"${work}/demo-spec.json"
demo_spec_arg="$(native "${work}/demo-spec.json")"
demo_refused() {
  # demo_refused <case> <args...>: refused before any ECS submission
  new_case "demo-$1"
  shift
  operator_run run run-ops-task.sh provision-demo "$@" && rc=0 || rc=$?
  [[ $rc != 0 ]] && no_run_task
}
expect DEMO_NO_MODE_REFUSED demo_refused nomode
expect DEMO_BAD_MODE_REFUSED demo_refused badmode --demo-mode delete
expect DEMO_APPLY_WITHOUT_DIGEST_REFUSED demo_refused nodigest --demo-mode apply --demo-spec-file "$demo_spec_arg"
expect DEMO_APPLY_SHORT_DIGEST_REFUSED demo_refused shortdigest --demo-mode apply --demo-spec-file "$demo_spec_arg" --demo-confirm-digest abc123
expect DEMO_RETIRE_WITHOUT_DIGEST_REFUSED demo_refused retiredigest --demo-mode retire --demo-spec-file "$demo_spec_arg"
expect DEMO_DRYRUN_WITH_DIGEST_REFUSED demo_refused drydigest --demo-mode dry-run --demo-spec-file "$demo_spec_arg" --demo-confirm-digest 0123456789abcdef
expect DEMO_DRYRUN_MISSING_SPEC_REFUSED demo_refused nospec --demo-mode dry-run
expect DEMO_VERIFY_WITH_SPEC_REFUSED demo_refused verifyspec --demo-mode verify --demo-spec-file "$demo_spec_arg"
new_case demo-options-on-other-action
operator_run run run-ops-task.sh status --demo-mode verify && rc=0 || rc=$?
expect DEMO_OPTIONS_ONLY_FOR_PROVISION_ACTION bash -c "[[ $rc != 0 ]] && ! grep -q '^ecs run-task' '${case_dir}/aws.log'"
demo_override_case() {
  # demo_override_case <case> <expected substring> <args...>
  new_case "demo-$1"
  local needle="$2"
  shift 2
  printf 'STOCKWISE_OPS: provision-demo\n' >"${case_dir}/task-log.txt"
  operator_run run run-ops-task.sh provision-demo "$@" && rc=0 || rc=$?
  [[ $rc == 0 ]] && grep '^ecs run-task' "${case_dir}/aws.log" | grep -q -- "$needle" &&
    ! grep '^ecs run-task' "${case_dir}/aws.log" | grep -q '@'
}
expect DEMO_VERIFY_OVERRIDE demo_override_case verify 'STOCKWISE_DEMO_MODE' --demo-mode verify
expect DEMO_DRYRUN_OVERRIDE demo_override_case dry 'STOCKWISE_DEMO_SPEC_B64' --demo-mode dry-run --demo-spec-file "$demo_spec_arg"
expect DEMO_APPLY_OVERRIDE demo_override_case apply 'STOCKWISE_DEMO_CONFIRM_DIGEST' --demo-mode apply --demo-spec-file "$demo_spec_arg" --demo-confirm-digest 0123456789abcdef

failed=0
for result in "${results[@]}"; do [[ "$result" == *":PASS" ]] || failed=1; done
printf '%s\n' "${results[@]}" >"${work}/summary.txt"
echo "OPERATOR_TEST_EVIDENCE:${work}"
echo "OPERATOR_TEST_RESULTS:$(grep -c ':PASS$' "${work}/summary.txt")/${#results[@]}"
exit "$failed"
