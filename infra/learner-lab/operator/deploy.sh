#!/usr/bin/env bash
# StockWise Learner Lab release (ADR-040). Public deploy and the Native cutover
# are owner gates (G6): run only when authorized.
#   deploy.sh --release <release.env> --var-file <demo.tfvars> [--seed-demo] [--native-cutover]
# <release.env> comes from mirror-images.sh (ECR digests only).
#
# Order, preserving ADR-039's database contract:
#   A. terraform apply: new ops task definitions; the application keeps its
#      current images and task count (a fresh stack: new images, 0 tasks)
#   B. ops task `prepare`: forward-only migrate deploy -> grants -> fence state
#   C. optional `seed`, LEGACY only (D-08)
#   D. LEGACY: `cutover` (only with --native-cutover; service must be at 0 tasks)
#   E. terraform apply: new web/api images, exactly one application task
#   F. wait for the service to be stable, then smoke.sh over HTTPS
# Each terraform apply shows its plan and asks for confirmation. Before step B
# the public hostname must already resolve to this stack over valid HTTPS (the
# DNS record is owner gate G5, created before this script runs; finding F9);
# otherwise nothing irreversible happens.
# shellcheck source-path=SCRIPTDIR source=common.sh
source "$(dirname "$0")/common.sh"
require_tools aws terraform curl
aws_region
require_lab_identity
ensure_state_dir
require_before_deadline

release_file="" var_file="" seed=false cutover=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --release) release_file="${2:-}"; shift 2 ;;
    --var-file) var_file="${2:-}"; shift 2 ;;
    --seed-demo) seed=true; shift ;;
    --native-cutover) cutover=true; shift ;;
    *) die "unknown argument: $1" ;;
  esac
done
var_file="$(resolve_var_file "$var_file")"
read_release "$release_file"
new_web="$web_image" new_api="$api_image" new_ops="$ops_image"

current_web="$(tf_output current_web_image)"
current_api="$(tf_output current_api_image)"
current_count="$(tf_output current_app_desired_count)"
if [[ "$current_web" == "none" || "$current_api" == "none" ]]; then
  current_web="$new_web" current_api="$new_api" current_count=0
fi

if [[ "$(tf_output cloudfront_enabled)" == "true" && -z "${TF_VAR_cloudfront_origin_secret:-}" ]]; then
  [[ -r "${state_dir}/cloudfront-origin-secret" ]] || die "CloudFront is enabled: create ${state_dir}/cloudfront-origin-secret first (see README)"
  TF_VAR_cloudfront_origin_secret="$(cat "${state_dir}/cloudfront-origin-secret")"
  export TF_VAR_cloudfront_origin_secret
fi

apply() {
  tf apply -var-file="$var_file" -var "web_image=$1" -var "api_image=$2" \
    -var "ops_image=${new_ops}" -var "app_desired_count=$3"
}

step "A: ops task definitions for ${new_ops##*@} (application unchanged)"
apply "$current_web" "$current_api" "$current_count"

# The ALB answers 503 while no task is registered and 200 once one is healthy;
# 000 means DNS, the certificate or TLS is not ready.
origin="$(tf_output public_origin)"
status="$(curl --silent --show-error --max-time 15 --output /dev/null --write-out '%{http_code}' \
  "${origin}/api/health" 2>/dev/null || true)"
[[ "$status" =~ ^(200|502|503)$ ]] ||
  die "${origin} is not reachable over valid HTTPS (status ${status:-none}); create the public DNS record (G5) and wait for it to resolve before deploying"
step "public origin ${origin} reachable over HTTPS (status ${status})"

step "B: migrate, grants, fence state"
prepare_log="$(mktemp "${state_dir}/prepare.XXXXXX")"
"${operator_dir}/run-ops-task.sh" prepare | tee "$prepare_log"
state="$(sed -n 's/^STOCKWISE_FENCE_STATE:\([A-Z]*\).*/\1/p' "$prepare_log" | tail -1)"
rm -f "$prepare_log"
step "authentication fence state: ${state:-unknown}"

if $seed; then
  [[ "$state" == "LEGACY" ]] || die "--seed-demo requires the LEGACY state (seed before the Native cutover)"
  step "C: optional synthetic seed"
  "${operator_dir}/run-ops-task.sh" seed
fi

case "$state" in
  NATIVE) ;;
  LEGACY)
    $cutover || die "database is LEGACY; rerun with --native-cutover to seal it NATIVE (one-way)"
    [[ "$current_count" == "0" ]] || die "the application must be at 0 tasks before the cutover"
    step "D: Native cutover (one-way)"
    "${operator_dir}/run-ops-task.sh" cutover
    ;;
  QUIESCED) die "a cutover was interrupted; inspect it and resume deliberately (README: interrupted cutover)" ;;
  *) die "could not read the fence state from the prepare task" ;;
esac

if [[ -r "${state_dir}/release-current.env" ]]; then
  cp -p "${state_dir}/release-current.env" "${state_dir}/release-previous.env"
fi
step "E: application release ${new_web##*@} / ${new_api##*@}, one task"
apply "$new_web" "$new_api" 1
# Notifications are enabled again; make an earlier ALARM re-evaluate (R2-F8).
reconcile_outage_alarm
cp -p "$release_file" "${state_dir}/release-current.env"

step "F: waiting for the service to become stable"
aws ecs wait services-stable --cluster "$(tf_output cluster_name)" --services "$(tf_output service_name)"
"${operator_dir}/smoke.sh"
step "release active"
