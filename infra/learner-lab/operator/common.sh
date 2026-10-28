#!/usr/bin/env bash
# Shared helpers for the StockWise Learner Lab operator scripts (ADR-040).
# Sourced, never executed. Runs on the operator machine (Linux, macOS or Git
# Bash) with the AWS CLI v2, Terraform >= 1.11 and Docker, using the Learner Lab
# session credentials from "AWS Details" in the operator's own shell. These
# scripts never write, print or export credentials.
set -euo pipefail

operator_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
terraform_dir="$(cd "${operator_dir}/../terraform" && pwd)"
# Local, Git-ignored state: release records, downloaded exports, temporary
# secret payloads (removed immediately after use). Overridable for the
# operator regression tests only.
state_dir="${STOCKWISE_OPERATOR_STATE_DIR:-${operator_dir}/.state}"
export operator_dir terraform_dir state_dir

die() {
  echo "STOCKWISE_REFUSED: $*" >&2
  exit 1
}
step() { echo "STOCKWISE_OPERATOR: $*"; }

require_tools() {
  local tool
  for tool in "$@"; do
    command -v "$tool" >/dev/null 2>&1 || die "missing required tool: ${tool}"
  done
}

ensure_state_dir() {
  umask 077
  mkdir -p "$state_dir"
  chmod 0700 "$state_dir" 2>/dev/null || true
}

# A file path the AWS CLI accepts (native Windows path under Git Bash).
native_path() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi
}

tf() { terraform -chdir="$terraform_dir" "$@"; }

tf_output() {
  tf output -raw "$1" 2>/dev/null || die "terraform output ${1} is unavailable (has the stack been applied?)"
}

aws_region() {
  AWS_REGION="${AWS_REGION:-$(tf_output region)}"
  export AWS_REGION AWS_DEFAULT_REGION="$AWS_REGION"
}

# Fails closed unless the active AWS identity is a Learner Lab role session
# (voclabs or LabRole) in the exact account recorded in Terraform state. Every
# entry point that calls AWS runs this first. Prints only the role name, never
# the account id or keys.
require_lab_identity() {
  local arn expected from_secret expected_region
  # Region first (no AWS call): Learner Lab allows two regions, and the active
  # one must be the region recorded in Terraform state.
  expected_region="$(tf output -raw region 2>/dev/null || true)"
  [[ "$expected_region" =~ ^us-(east-1|west-2)$ ]] || die "the expected region is unknown (no Terraform state); refusing to act"
  [[ "${AWS_REGION:-}" == "$expected_region" ]] || die "the active AWS region is not the region in Terraform state"
  arn="$(aws sts get-caller-identity --query Arn --output text 2>/dev/null)" ||
    die "no usable AWS credentials in this shell"
  [[ "$arn" =~ ^arn:aws:sts::([0-9]{12}):assumed-role/(voclabs|LabRole)/[^[:space:]/]+$ ]] ||
    die "the active AWS identity is not a Learner Lab role session (voclabs/LabRole)"
  local account="${BASH_REMATCH[1]}" role="${BASH_REMATCH[2]}"
  expected="$(tf output -raw account_id 2>/dev/null || true)"
  from_secret="$(tf output -raw application_secret_arn 2>/dev/null | cut -d: -f5 || true)"
  if [[ -z "$expected" ]]; then expected="$from_secret"; fi
  [[ "$expected" =~ ^[0-9]{12}$ ]] || die "the expected account is unknown (no Terraform state); refusing to act"
  [[ -z "$from_secret" || "$from_secret" == "$expected" ]] || die "Terraform state names two different accounts"
  [[ "$account" == "$expected" ]] || die "the active AWS account is not the account in Terraform state"
  echo "STOCKWISE_OPERATOR: AWS identity role ${role}"
}

# Outage-alarm reconciliation after the service is brought back to one task
# (R2-F8). CloudWatch notifies only on a state transition, and re-enabling
# actions on an alarm already in ALARM does not notify again. If the outage
# alarm is in ALARM now, it is moved to INSUFFICIENT_DATA (no action is
# configured for that state): CloudWatch then re-evaluates, and a continuing
# outage makes a fresh, notifying INSUFFICIENT_DATA -> ALARM transition, while
# a recovery reports OK. OK or INSUFFICIENT_DATA needs nothing, so repeated
# resumes cannot produce duplicate notifications. Any read error fails closed.
reconcile_outage_alarm() {
  local name state
  name="$(tf_output outage_alarm_name)"
  state="$(aws cloudwatch describe-alarms --alarm-names "$name" \
    --query 'MetricAlarms[0].StateValue' --output text)" || die "cannot read the outage alarm state"
  state="${state%$'\r'}"
  case "$state" in
    ALARM)
      aws cloudwatch set-alarm-state --alarm-name "$name" --state-value INSUFFICIENT_DATA \
        --state-reason "Operator resume: re-evaluating the outage now that notifications are enabled" >/dev/null ||
        die "cannot reset the outage alarm for re-evaluation"
      step "outage alarm was in ALARM; reset for re-evaluation (a continuing outage will notify)"
      ;;
    OK | INSUFFICIENT_DATA) step "outage alarm ${state}; no reconciliation needed" ;;
    *) die "unexpected outage alarm state: ${state:-none}" ;;
  esac
}

# Resolves a caller-supplied file path to an absolute native path before any
# `terraform -chdir` (which would otherwise reinterpret relative paths), keeping
# spaces intact. Refuses missing or unreadable files.
resolve_var_file() {
  local path="$1" directory
  [[ -n "$path" ]] || die "--var-file is required"
  [[ -f "$path" && -r "$path" ]] || die "--var-file ${path} is missing or unreadable"
  directory="$(cd -- "$(dirname -- "$path")" && pwd -P)" || die "cannot resolve --var-file ${path}"
  native_path "${directory}/$(basename -- "$path")"
}

# <account>.dkr.ecr.<region>.amazonaws.com/<repository>@sha256:<64 hex>
require_ecr_digest() {
  [[ "$1" =~ ^[0-9]{12}\.dkr\.ecr\.(us-east-1|us-west-2)\.amazonaws\.com/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$ ]] ||
    die "image must be an ECR digest reference: $1"
}

# Refuse new deployments once the planning deadline has passed.
require_before_deadline() {
  local deadline now
  deadline="$(tf_output planning_deadline)"
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  [[ "$now" < "$deadline" ]] || die "planning deadline ${deadline} has passed; run teardown.sh instead"
}

random_key() { openssl rand 32 | openssl base64 -A | tr '+/' '-_' | tr -d '='; }

# Reads KEY=VALUE release files without executing them.
read_release() {
  local file="$1" key value
  [[ -r "$file" ]] || die "cannot read release file ${file}"
  web_image="" api_image="" ops_image=""
  while IFS='=' read -r key value; do
    case "$key" in
      WEB_IMAGE) web_image="$value" ;;
      API_IMAGE) api_image="$value" ;;
      OPS_IMAGE) ops_image="$value" ;;
      '' | \#*) ;;
      *) die "unexpected key ${key} in ${file}" ;;
    esac
  done <"$file"
  require_ecr_digest "$web_image"
  require_ecr_digest "$api_image"
  require_ecr_digest "$ops_image"
}
