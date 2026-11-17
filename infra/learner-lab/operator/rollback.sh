#!/usr/bin/env bash
# Redeploys the previous web/api images (ADR-040). Migrations are forward-only:
# rollback never touches the schema (the previous release must be compatible
# with the already-migrated database; a release older than M3 / `ADR-045`
# cannot run on the post-M3 schema).
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
