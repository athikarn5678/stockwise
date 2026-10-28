#!/usr/bin/env bash
# Controlled teardown of the whole Learner Lab stack (ADR-040). Must complete
# before the planning deadline (2026-10-31T16:59:00Z). Irreversible: every
# database row and every AWS resource of the stack is deleted. Real teardown
# needs the owner's separate authorization.
#   teardown.sh --var-file <demo.tfvars> --confirm <name_prefix> [--export-dir <dir>]
#
# Fails closed (finding F2). Nothing destructive happens unless, in order:
#   1. a final export task bound to a fresh export id exits successfully;
#   2. verify-export.sh proves that exact S3 object was downloaded to the
#      operator's machine (default .state/exports/) with the marker's size and
#      SHA-256, and that pg_restore lists it as an archive of the expected
#      database with its core tables;
#   3. every other stored export is downloaded as well.
# Only then: lift RDS deletion protection (targeted apply), terraform destroy
# (shows the plan and asks for confirmation), and the residual check, which
# prints TEARDOWN_VERIFIED or every residual.
# shellcheck source-path=SCRIPTDIR source=common.sh
source "$(dirname "$0")/common.sh"
require_tools aws terraform docker openssl
aws_region
require_lab_identity
ensure_state_dir

var_file="" confirm="" export_dir="${state_dir}/exports"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --var-file) var_file="${2:-}"; shift 2 ;;
    --confirm) confirm="${2:-}"; shift 2 ;;
    --export-dir) export_dir="${2:-}"; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done
var_file="$(resolve_var_file "$var_file")"
prefix="$(tf_output name_prefix)"
[[ "$confirm" == "$prefix" ]] || die "--confirm must repeat the stack name prefix (${prefix})"

bucket="$(tf_output exports_bucket)"
database="$(tf_output db_name)"
db="$(tf_output db_instance_identifier)"
cluster="$(tf_output cluster_name)"
release_vars=()
for name in web api ops; do
  value="$(tf_output "current_${name}_image")"
  # An unset image becomes a syntactically valid placeholder no task ever runs.
  [[ "$value" == none ]] && value="public.ecr.aws/none/none@sha256:$(printf '0%.0s' {1..64})"
  release_vars+=(-var "${name}_image=${value}")
done
if [[ "$(tf_output cloudfront_enabled)" == "true" && -z "${TF_VAR_cloudfront_origin_secret:-}" ]]; then
  TF_VAR_cloudfront_origin_secret="$(cat "${state_dir}/cloudfront-origin-secret")"
  export TF_VAR_cloudfront_origin_secret
fi

export_id="td-$(openssl rand -hex 8)"
evidence="${state_dir}/teardown-${export_id}"
mkdir -p "$evidence"
step "1: final export ${export_id}"
"${operator_dir}/run-ops-task.sh" export --export-id "$export_id" >"${evidence}/export-task.log" 2>&1 || {
  cat "${evidence}/export-task.log" >&2
  die "the final export task failed; nothing was destroyed"
}

step "2: verifying the export and downloading it to ${export_dir}"
"${operator_dir}/verify-export.sh" "${evidence}/export-task.log" "$database" "$export_id" "$bucket" "$export_dir" ||
  die "the final export could not be verified; nothing was destroyed"

step "3: downloading every other stored export"
aws s3 cp "s3://${bucket}/exports/" "$(native_path "${export_dir}/all")/" --recursive --only-show-errors ||
  die "downloading the stored exports failed; nothing was destroyed"

step "4: lifting RDS deletion protection; allowing the exports bucket to be emptied"
tf apply -var-file="$var_file" "${release_vars[@]}" -var app_desired_count=0 \
  -var db_deletion_protection=false -var exports_force_destroy=true \
  -target=aws_db_instance.demo -target=aws_s3_bucket.exports -target=aws_ecs_service.app

step "5: terraform destroy"
tf destroy -var-file="$var_file" "${release_vars[@]}" -var app_desired_count=0 \
  -var db_deletion_protection=false -var exports_force_destroy=true

step "6: residual check"
residual=0
report() {
  [[ -z "$2" || "$2" == "None" || "$2" == "0" ]] && return
  echo "STOCKWISE_TEARDOWN_RESIDUAL:$1:$2"
  residual=1
}
report rds "$(aws rds describe-db-instances --db-instance-identifier "$db" --query 'DBInstances[0].DBInstanceStatus' --output text 2>/dev/null || true)"
report nat-gateways "$(aws ec2 describe-nat-gateways --filter Name=tag:Project,Values=stockwise \
  Name=state,Values=pending,available,deleting --query 'length(NatGateways)' --output text)"
report elastic-ips "$(aws ec2 describe-addresses --filters Name=tag:Project,Values=stockwise --query 'length(Addresses)' --output text)"
report ec2-instances "$(aws ec2 describe-instances --filters "Name=tag:Name,Values=${prefix}-ecs" \
  Name=instance-state-name,Values=pending,running,stopping,stopped --query 'length(Reservations[].Instances[])' --output text)"
# shellcheck disable=SC2016 # JMESPath literal, not shell
report ecs-cluster "$(aws ecs describe-clusters --clusters "$cluster" --query 'clusters[?status==`ACTIVE`] | length(@)' --output text)"
report ecr "$(aws ecr describe-repositories --query "repositories[?starts_with(repositoryName, '${prefix}/')] | length(@)" --output text)"
report log-groups "$(aws logs describe-log-groups --log-group-name-prefix "/stockwise/${prefix}/" --query 'length(logGroups)' --output text)"
report rds-log-group "$(aws logs describe-log-groups --log-group-name-prefix "/aws/rds/instance/${db}/" --query 'length(logGroups)' --output text)"
report tagged-resources "$(aws resourcegroupstaggingapi get-resources --tag-filters Key=Project,Values=stockwise \
  --query 'length(ResourceTagMappingList)' --output text)"
if [[ "$residual" == 0 ]]; then
  echo "STOCKWISE_TEARDOWN_VERIFIED"
else
  echo "STOCKWISE_TEARDOWN_INCOMPLETE: re-run the residual check after a few minutes (the tagging API lags deletions); remove anything that remains in the console"
  exit 1
fi
