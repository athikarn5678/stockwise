#!/usr/bin/env bash
# Pause or resume the billable compute between demonstrations (ADR-040):
#   capacity.sh pause  --var-file <demo.tfvars>   service 0 -> ASG 0 -> RDS stopped
#   capacity.sh resume --var-file <demo.tfvars>   RDS started -> ASG 2 -> service 1 -> smoke
# A pause saves the EC2 and RDS hours only: the ALB, both NAT gateways and the
# public IPv4 addresses keep billing (about $0.14/h). It is not a substitute
# for teardown.sh at the end of the window.
# shellcheck source-path=SCRIPTDIR source=common.sh
source "$(dirname "$0")/common.sh"
require_tools aws terraform curl
aws_region
require_lab_identity

mode="${1:-}"
shift || true
var_file=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --var-file) var_file="${2:-}"; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ "$mode" == pause || "$mode" == resume ]] || die "usage: capacity.sh pause|resume --var-file <demo.tfvars>"
var_file="$(resolve_var_file "$var_file")"

images=(-var "web_image=$(tf_output current_web_image)" -var "api_image=$(tf_output current_api_image)"
  -var "ops_image=$(tf_output current_ops_image)")
for reference in "${images[@]}"; do
  [[ "$reference" == -var ]] || require_ecr_digest "${reference#*=}"
done
if [[ "$(tf_output cloudfront_enabled)" == "true" && -z "${TF_VAR_cloudfront_origin_secret:-}" ]]; then
  TF_VAR_cloudfront_origin_secret="$(cat "${state_dir}/cloudfront-origin-secret")"
  export TF_VAR_cloudfront_origin_secret
fi
db="$(tf_output db_instance_identifier)"

if [[ "$mode" == pause ]]; then
  step "service to 0 tasks and container instances to 0"
  tf apply -var-file="$var_file" "${images[@]}" -var app_desired_count=0 -var asg_min_size=0 -var asg_max_size=0
  step "stopping RDS ${db} (it restarts by itself after 7 days)"
  aws rds stop-db-instance --db-instance-identifier "$db" --query 'DBInstance.DBInstanceStatus' --output text
  echo "STOCKWISE_CAPACITY:PAUSED"
else
  require_before_deadline
  status="$(aws rds describe-db-instances --db-instance-identifier "$db" --query 'DBInstances[0].DBInstanceStatus' --output text)"
  if [[ "$status" == stopped ]]; then
    step "starting RDS ${db}"
    aws rds start-db-instance --db-instance-identifier "$db" --query 'DBInstance.DBInstanceStatus' --output text
  fi
  aws rds wait db-instance-available --db-instance-identifier "$db"
  step "container instances and one application task"
  tf apply -var-file="$var_file" "${images[@]}" -var app_desired_count=1
  # Notifications are re-enabled; make a pause-time ALARM re-evaluate (R2-F8).
  reconcile_outage_alarm
  aws ecs wait services-stable --cluster "$(tf_output cluster_name)" --services "$(tf_output service_name)"
  "${operator_dir}/smoke.sh"
  echo "STOCKWISE_CAPACITY:RESUMED"
fi
