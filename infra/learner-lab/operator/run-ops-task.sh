#!/usr/bin/env bash
# Runs one ops action as a one-off ECS task and waits for it (ADR-040):
#   run-ops-task.sh <action>
#   bootstrap-roles              -> <prefix>-ops-bootstrap (RDS master credentials)
#   export                       -> <prefix>-ops-export    (LabRole, writes to S3)
#   prepare | migrate | grants | fence-state | status | seed | cutover
#                                -> <prefix>-ops-ops
#   run-ops-task.sh export --export-id <id>   binds the export to <id>
#   run-ops-task.sh uat-provision --uat-phase accounts|memberships --uat-spec-file <json>
#                                passes the hash-only UAT spec (apps/api/src/uat) to the ops task
#                                (teardown.sh verifies exactly that export)
# Prints the task's CloudWatch log (credential-free by construction) and exits
# with the container's exit code. Every invocation first verifies the Learner
# Lab identity and account, whoever the caller is. `cutover` additionally
# requires the application service to have no desired, pending or running task.
# shellcheck source-path=SCRIPTDIR source=common.sh
source "$(dirname "$0")/common.sh"
require_tools aws terraform

action="${1:-}"
export_id=""
uat_phase=""
uat_spec_file=""
case "$action" in
  bootstrap-roles) role="bootstrap" ;;
  export) role="export" ;;
  prepare | migrate | grants | fence-state | status | seed | cutover | uat-provision) role="ops" ;;
  *) die "usage: run-ops-task.sh bootstrap-roles|prepare|migrate|grants|fence-state|status|seed|cutover|uat-provision|export [--export-id <id>] [--uat-phase <p> --uat-spec-file <f>]" ;;
esac
shift
while [[ $# -gt 0 ]]; do
  case "$1" in
    --export-id) export_id="${2:-}"; shift 2 ;;
    --uat-phase) uat_phase="${2:-}"; shift 2 ;;
    --uat-spec-file) uat_spec_file="${2:-}"; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done
if [[ -n "$export_id" ]]; then
  [[ "$action" == export && "$export_id" =~ ^[a-z0-9-]{8,64}$ ]] ||
    die "--export-id applies to export only and must be 8-64 of [a-z0-9-]"
fi

if [[ "$action" == "uat-provision" ]]; then
  [[ "$uat_phase" =~ ^(accounts|memberships)$ ]] || die "--uat-phase must be accounts or memberships"
  [[ -f "$uat_spec_file" ]] || die "--uat-spec-file must name an existing file"
elif [[ -n "$uat_phase$uat_spec_file" ]]; then
  die "--uat-phase and --uat-spec-file apply to uat-provision only"
fi

aws_region
require_lab_identity

prefix="$(tf_output name_prefix)"
cluster="$(tf_output cluster_name)"
service="$(tf_output service_name)"
capacity_provider="$(tf_output capacity_provider_name)"
subnets="$(tf_output task_subnets_csv)"
security_group="$(tf_output task_security_group_id)"
log_group="$(tf_output ops_log_group)"
family="${prefix}-ops-${role}"

if [[ "$action" == "cutover" ]]; then
  counts="$(aws ecs describe-services --cluster "$cluster" --services "$service" \
    --query 'services[0].[desiredCount,pendingCount,runningCount]' --output text)"
  [[ "$(tr -s '[:space:]' ' ' <<<"$counts" | xargs)" == "0 0 0" ]] ||
    die "the application service must be at 0 desired/pending/running tasks before the cutover (now: ${counts})"
fi

environment=""
[[ -n "$export_id" ]] && environment=",\"environment\":[{\"name\":\"STOCKWISE_EXPORT_ID\",\"value\":\"${export_id}\"}]"
if [[ "$action" == "uat-provision" ]]; then
  # Base64 keeps the JSON spec shell- and JSON-safe; it holds hashes only.
  spec_b64="$(base64 <"$uat_spec_file" | tr -d "\n\r ")"
  [[ ${#spec_b64} -le 7000 ]] || die "the UAT spec exceeds the ECS override size budget"
  environment=",\"environment\":[{\"name\":\"STOCKWISE_UAT_PHASE\",\"value\":\"${uat_phase}\"},{\"name\":\"STOCKWISE_UAT_SPEC_B64\",\"value\":\"${spec_b64}\"}]"
fi
step "starting ${family} ${action}"
task_arn="$(aws ecs run-task --cluster "$cluster" --task-definition "$family" \
  --capacity-provider-strategy "capacityProvider=${capacity_provider},weight=1" \
  --network-configuration "awsvpcConfiguration={subnets=[${subnets}],securityGroups=[${security_group}],assignPublicIp=DISABLED}" \
  --overrides "{\"containerOverrides\":[{\"name\":\"ops\",\"command\":[\"${action}\"]${environment}}]}" \
  --started-by stockwise-operator --query 'tasks[0].taskArn' --output text)"
[[ "$task_arn" == arn:* ]] || die "ECS did not start the task (check capacity and run-task failures)"
task_id="${task_arn##*/}"

# Tasks wait for capacity-provider scaling; poll up to 20 minutes.
for _ in $(seq 1 120); do
  status="$(aws ecs describe-tasks --cluster "$cluster" --tasks "$task_arn" \
    --query 'tasks[0].lastStatus' --output text)"
  [[ "$status" == "STOPPED" ]] && break
  sleep 10
done
[[ "$status" == "STOPPED" ]] || die "task ${task_id} did not stop within 20 minutes (status ${status})"

read -r exit_code reason < <(aws ecs describe-tasks --cluster "$cluster" --tasks "$task_arn" \
  --query 'tasks[0].[containers[0].exitCode,stoppedReason]' --output text)
aws logs get-log-events --log-group-name "$log_group" --log-stream-name "ops/ops/${task_id}" \
  --start-from-head --query 'events[].message' --output text 2>/dev/null | tr '\t' '\n' || true
echo "STOCKWISE_OPS_TASK:${action}:${task_id}:exit=${exit_code}"
[[ "$exit_code" == "0" ]] || die "${action} failed (exit ${exit_code}; ${reason})"
