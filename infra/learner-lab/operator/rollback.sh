#!/usr/bin/env bash
# Redeploys the previous web/api images (ADR-040). Migrations are forward-only:
# rollback never touches the schema and is allowed only once the database is
# sealed NATIVE (the previous release must be Native-compatible with it).
#   rollback.sh --var-file <demo.tfvars>
# shellcheck source-path=SCRIPTDIR source=common.sh
source "$(dirname "$0")/common.sh"
require_tools aws terraform curl
aws_region
require_lab_identity
require_before_deadline

var_file=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --var-file) var_file="${2:-}"; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done
var_file="$(resolve_var_file "$var_file")"
read_release "${state_dir}/release-previous.env"
previous_web="$web_image" previous_api="$api_image"
current_ops="$(tf_output current_ops_image)"
require_ecr_digest "$current_ops"

state_log="$(mktemp "${state_dir}/fence.XXXXXX")"
"${operator_dir}/run-ops-task.sh" fence-state | tee "$state_log"
grep -q '^STOCKWISE_FENCE_STATE:NATIVE' "$state_log" || { rm -f "$state_log"; die "rollback requires the NATIVE state"; }
rm -f "$state_log"

if [[ "$(tf_output cloudfront_enabled)" == "true" && -z "${TF_VAR_cloudfront_origin_secret:-}" ]]; then
  TF_VAR_cloudfront_origin_secret="$(cat "${state_dir}/cloudfront-origin-secret")"
  export TF_VAR_cloudfront_origin_secret
fi
step "rolling the application back to ${previous_web##*@} / ${previous_api##*@}"
tf apply -var-file="$var_file" -var "web_image=${previous_web}" -var "api_image=${previous_api}" \
  -var "ops_image=${current_ops}" -var "app_desired_count=1"
reconcile_outage_alarm
aws ecs wait services-stable --cluster "$(tf_output cluster_name)" --services "$(tf_output service_name)"
"${operator_dir}/smoke.sh"
cp -p "${state_dir}/release-current.env" "${state_dir}/release-rolled-back.env"
cp -p "${state_dir}/release-previous.env" "${state_dir}/release-current.env"
step "rollback active"
