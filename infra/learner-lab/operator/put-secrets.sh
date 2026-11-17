#!/usr/bin/env bash
# Generates and stores every StockWise demo secret value in Secrets Manager
# (ADR-040). Run once after the first apply, before any ops task:
#   put-secrets.sh [--resend-key-file <file>] [--master-password-from-env]
#
#   <name_prefix>/database     app_password, migrator_password, demo_user_password
#   <name_prefix>/application  five distinct 32-byte keys, RESEND_API_KEY and the
#                              provider values below
#
# Provider values are read from the operator's own shell environment at run
# time (never from Git, never printed, never in argv):
#   RESEND_API_KEY          only when --resend-key-file is not given
#   OPENCODE_GO_API_KEY     AI analysis (OpenCode Go)
#   STRIPE_SECRET_KEY       Stripe test-mode secret key (sk_test_...; live keys refused)
#   STOCKWISE_PROMPTPAY_ID  PromptPay receiver (10-digit phone, 13-digit national
#                           ID or 15-digit e-wallet ID; digits only)
#   <name_prefix>/master       only with db_master_password_mode = write_only:
#                              username + TF_VAR_db_master_password
# Values are generated locally, written to a 0600 temporary file, sent with
# put-secret-value file://, and the file is removed. Nothing is printed.
# A secret that already has a current value keeps every stored key (no silent
# rotation: rotating the database secret requires bootstrap-roles again, and
# rotating application keys invalidates sessions, proofs and pending OTPs). The
# one exception is additive: provider keys missing from an existing
# application secret (for example one stored before they existed) are merged in
# with merge-secret-json.mjs; stored values are never overwritten.
#
# Fails closed (R2-NEW-F1): every AWS call's exit status and response shape is
# checked, so an AccessDenied, throttling, timeout, empty or malformed answer
# never counts as "already set". STOCKWISE_SECRETS:READY is printed only after
# each required secret has been read back and every required key holds a
# well-formed value. Values are read into memory only, never printed.
# shellcheck source-path=SCRIPTDIR source=common.sh
source "$(dirname "$0")/common.sh"
require_tools aws terraform openssl node
aws_region
require_lab_identity
ensure_state_dir

resend_key_file="" with_master=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --resend-key-file) resend_key_file="${2:-}"; shift 2 ;;
    --master-password-from-env) with_master=true; shift ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ -z "$resend_key_file" || -r "$resend_key_file" ]] || die "--resend-key-file must name a readable file holding the Resend API key"

# Sets current_versions to the number of AWSCURRENT versions of secret $1, or
# exits. Never called in a condition, so errexit and die() stay effective.
read_current_versions() {
  local output
  # shellcheck disable=SC2016 # JMESPath literal, not shell
  if ! output="$(aws secretsmanager list-secret-version-ids --secret-id "$1" \
    --query 'length(Versions[?contains(VersionStages, `AWSCURRENT`)])' --output text)"; then
    die "cannot read the versions of the $2 secret (AWS error: access denied, throttling, timeout or similar); nothing is reported ready"
  fi
  [[ "$output" =~ ^[0-9]+$ ]] || die "unexpected response when reading the versions of the $2 secret; nothing is reported ready"
  current_versions="$output"
}

# Reads secret $1 back and checks that each key=pattern pair names a key whose
# string value matches the pattern exactly. Exits on any error.
verify_secret() {
  local arn="$1" label="$2" json validation
  shift 2
  if ! json="$(aws secretsmanager get-secret-value --secret-id "$arn" --query SecretString --output text)"; then
    die "cannot read back the ${label} secret (AWS error); nothing is reported ready"
  fi
  if ! validation="$(printf '%s' "$json" | node "$(native_path "${operator_dir}/validate-secret-json.mjs")" "$@")" ||
    [[ "$validation" != STOCKWISE_SECRET_JSON:VALID ]]; then
    die "the ${label} secret is not an unambiguous JSON object with the required credential fields; nothing is reported ready"
  fi
  unset json
  step "${label} secret verified"
}

# Every payload file is registered before it is written and removed on any
# exit: success, a failed upload (errexit), and HUP/INT/TERM. The original
# exit status is preserved.
payloads=()
remove_payloads() {
  local file
  for file in "${payloads[@]}"; do rm -f -- "$file"; done
  payloads=()
}
trap remove_payloads EXIT
trap 'remove_payloads; exit 129' HUP
trap 'remove_payloads; exit 130' INT
trap 'remove_payloads; exit 143' TERM

put_json() {
  local arn="$1" payload
  payload="$(mktemp "${state_dir}/secret.XXXXXX")"
  payloads+=("$payload")
  chmod 0600 "$payload"
  cat >"$payload"
  aws secretsmanager put-secret-value --secret-id "$arn" \
    --secret-string "file://$(native_path "$payload")" --query Name --output text >/dev/null
  remove_payloads
}

readonly key43='[A-Za-z0-9_-]{43}'
readonly password='[A-Za-z0-9_-]{24,128}'
# Provider values (read from the environment). Stripe is test mode only (M6).
readonly provider_names=(OPENCODE_GO_API_KEY STRIPE_SECRET_KEY STOCKWISE_PROMPTPAY_ID)
readonly opencode_pattern='[A-Za-z0-9._-]{16,256}'
readonly stripe_pattern='sk_test_[A-Za-z0-9]{16,250}'
readonly promptpay_pattern='[0-9]{10}|[0-9]{13}|[0-9]{15}'

# Checks the environment value of variable $1 against pattern $2 without ever
# printing it. $3 is the hint shown on failure.
require_env_value() {
  local name="$1" pattern="$2" hint="$3" value="${!1:-}"
  [[ -n "$value" ]] || die "${name} must be set in the environment of this shell (${hint}); nothing was written"
  [[ "$value" =~ ^(${pattern})$ ]] || die "${name} in the environment has an unexpected format (${hint}); nothing was written"
}
require_provider_env() {
  require_env_value OPENCODE_GO_API_KEY "$opencode_pattern" "the OpenCode Go API key"
  require_env_value STRIPE_SECRET_KEY "$stripe_pattern" "a Stripe TEST-mode secret key, sk_test_..."
  require_env_value STOCKWISE_PROMPTPAY_ID "$promptpay_pattern" "a 10-, 13- or 15-digit PromptPay ID, digits only"
}
database_arn="$(tf_output database_secret_arn)"
application_arn="$(tf_output application_secret_arn)"

read_current_versions "$database_arn" database
if [[ "$current_versions" -gt 0 ]]; then
  step "database secret already set; unchanged"
else
  app="$(random_key)" migrator="$(random_key)" demo="$(random_key)"
  [[ "$app" != "$migrator" ]] || die "generated passwords collided"
  # Process substitution keeps put_json in this shell, so its cleanup traps
  # apply (in a pipeline it would run in a subshell, where traps are reset).
  put_json "$database_arn" < <(printf '{"app_password":"%s","migrator_password":"%s","demo_user_password":"%s"}' \
    "$app" "$migrator" "$demo")
  unset app migrator demo
  step "database secret stored"
fi

read_current_versions "$application_arn" application
if [[ "$current_versions" -gt 0 ]]; then
  # Existing secret: keep every stored key; add only the provider keys that are
  # missing. The stored JSON and the merged JSON live in memory only.
  if ! existing="$(aws secretsmanager get-secret-value --secret-id "$application_arn" --query SecretString --output text)"; then
    die "cannot read the application secret (AWS error); nothing is reported ready"
  fi
  merge_status=0
  merged="$(printf '%s' "$existing" | node "$(native_path "${operator_dir}/merge-secret-json.mjs")" "${provider_names[@]}")" || merge_status=$?
  unset existing
  case "$merge_status" in
    0)
      require_provider_env
      put_json "$application_arn" < <(printf '%s' "$merged")
      unset merged
      step "application secret: provider keys merged into the existing secret"
      ;;
    3) step "application secret already set; unchanged" ;;
    *) die "cannot merge provider keys into the application secret (not a flat string object, or a provider value is missing from the environment: ${provider_names[*]}); nothing was written" ;;
  esac
else
  if [[ -n "$resend_key_file" ]]; then
    resend_key="$(tr -d '\r\n' <"$resend_key_file")"
  else
    resend_key="${RESEND_API_KEY:-}"
  fi
  [[ "$resend_key" =~ ^re_[A-Za-z0-9_]{8,200}$ ]] || die "the Resend API key (--resend-key-file or RESEND_API_KEY) is not a re_... key"
  require_provider_env
  declare -A key=()
  for name in STOCKWISE_ANALYTICS_CURSOR_HMAC_KEY STOCKWISE_VERIFICATION_OTP_KEY \
    STOCKWISE_VERIFICATION_PROOF_KEY STOCKWISE_BETTER_AUTH_SECRET STOCKWISE_INVITATION_CONTINUATION_KEY; do
    key[$name]="$(random_key)"
  done
  [[ "$(printf '%s\n' "${key[@]}" | sort -u | wc -l | tr -d ' ')" == 5 ]] || die "generated keys collided"
  put_json "$application_arn" < <(
    printf '{'
    for name in "${!key[@]}"; do printf '"%s":"%s",' "$name" "${key[$name]}"; done
    printf '"RESEND_API_KEY":"%s",' "$resend_key"
    printf '"OPENCODE_GO_API_KEY":"%s","STRIPE_SECRET_KEY":"%s","STOCKWISE_PROMPTPAY_ID":"%s"}' \
      "$OPENCODE_GO_API_KEY" "$STRIPE_SECRET_KEY" "$STOCKWISE_PROMPTPAY_ID"
  )
  unset key resend_key
  step "application secret stored"
fi

if $with_master; then
  [[ "${TF_VAR_db_master_password:-}" =~ ^[A-Za-z0-9_-]{24,128}$ ]] ||
    die "TF_VAR_db_master_password must hold the write-only master password"
  master_arn="$(tf_output master_secret_arn)"
  [[ "$master_arn" != *":secret:rds!"* ]] || die "the master secret is RDS-managed; --master-password-from-env applies only to write_only mode"
  read_current_versions "$master_arn" master
  if [[ "$current_versions" -gt 0 ]]; then
    step "master secret already set; unchanged"
  else
    master_username="$(tf_output db_master_username)"
    put_json "$master_arn" < <(printf '{"username":"%s","password":"%s"}' "$master_username" "$TF_VAR_db_master_password")
    step "master secret stored"
  fi
fi

# Read every required secret back before declaring readiness.
verify_secret "$database_arn" database \
  "app_password=${password}" "migrator_password=${password}" "demo_user_password=${password}"
verify_secret "$application_arn" application \
  "STOCKWISE_ANALYTICS_CURSOR_HMAC_KEY=${key43}" "STOCKWISE_VERIFICATION_OTP_KEY=${key43}" \
  "STOCKWISE_VERIFICATION_PROOF_KEY=${key43}" "STOCKWISE_BETTER_AUTH_SECRET=${key43}" \
  "STOCKWISE_INVITATION_CONTINUATION_KEY=${key43}" "RESEND_API_KEY=re_[A-Za-z0-9_]{8,200}" \
  "OPENCODE_GO_API_KEY=${opencode_pattern}" "STRIPE_SECRET_KEY=${stripe_pattern}" \
  "STOCKWISE_PROMPTPAY_ID=${promptpay_pattern}"
if $with_master; then
  verify_secret "$master_arn" master "username=[a-z][a-z0-9_]{0,62}" "password=${password}"
fi
echo "STOCKWISE_SECRETS:READY"
