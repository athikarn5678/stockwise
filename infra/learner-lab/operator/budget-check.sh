#!/usr/bin/env bash
# Read-only budget monitor for the Learner Lab demo (ADR-040). Lists the
# billable resources that are actually running, estimates the hourly rate from
# us-east-1 on-demand list prices (excluding data transfer), and projects the
# spend until the planning deadline. The Learner Lab panel is the authoritative
# spend figure (it lags 8-12 hours); Cost Explorer is queried if the lab allows.
#   budget-check.sh [--remaining-usd <amount from the lab panel>]
# shellcheck source-path=SCRIPTDIR source=common.sh
source "$(dirname "$0")/common.sh"
require_tools aws terraform awk
aws_region
# Standalone entry point: verify the identity itself (R2-F3).
require_lab_identity

remaining=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --remaining-usd) remaining="${2:-}"; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done

prefix="$(tf_output name_prefix)"
db="$(tf_output db_instance_identifier)"
instances="$(aws ec2 describe-instances --filters "Name=tag:Name,Values=${prefix}-ecs" \
  "Name=instance-state-name,Values=running" --query 'length(Reservations[].Instances[])' --output text)"
nat="$(aws ec2 describe-nat-gateways --filter "Name=tag:Project,Values=stockwise" "Name=state,Values=available" \
  --query 'length(NatGateways)' --output text)"
alb="$(aws elbv2 describe-load-balancers --names "${prefix}-alb" --query 'length(LoadBalancers)' --output text 2>/dev/null || echo 0)"
rds="$(aws rds describe-db-instances --db-instance-identifier "$db" \
  --query 'DBInstances[0].[DBInstanceStatus,MultiAZ]' --output text 2>/dev/null || echo "absent False")"
eips="$(aws ec2 describe-addresses --filters "Name=tag:Project,Values=stockwise" --query 'length(Addresses)' --output text)"
echo "STOCKWISE_BUDGET:running ec2=${instances} nat=${nat} alb=${alb} rds=${rds/$'\t'/ multi_az=} nat_eips=${eips}"

# Hourly list prices (us-east-1, 2026-10): t3.small 0.0208; NAT 0.045; ALB
# 0.0225 + ~1 LCU 0.008; public IPv4 0.005 each (2 ALB + NAT EIPs);
# db.t4g.micro Multi-AZ 0.032 + 20 GB gp2 Multi-AZ 0.0063; 30 GB gp3 per
# instance 0.0033; Secrets Manager and alarms ~0.0031.
rate="$(awk -v ec2="$instances" -v nat="$nat" -v alb="$alb" -v eips="$eips" -v rds="${rds%%[[:space:]]*}" 'BEGIN {
  r = ec2 * (0.0208 + 0.0033) + nat * 0.045 + alb * (0.0225 + 0.008 + 2 * 0.005) + eips * 0.005 + 0.0031
  if (rds == "available") r += 0.032
  if (rds != "absent") r += 0.0063
  printf "%.4f", r }')"
deadline="$(tf_output planning_deadline)"
hours="$(awk -v now="$(date -u +%s)" -v end="$(date -u -d "$deadline" +%s 2>/dev/null || echo 0)" \
  'BEGIN { h = (end - now) / 3600; if (h < 0) h = 0; printf "%.1f", h }')"
projection="$(awk -v r="$rate" -v h="$hours" 'BEGIN { printf "%.2f", r * h }')"
echo "STOCKWISE_BUDGET:estimated_rate_usd_per_hour=${rate} hours_to_deadline=${hours} projected_usd_to_deadline=${projection}"
if [[ -n "$remaining" ]]; then
  awk -v left="$remaining" -v need="$projection" 'BEGIN {
    if (need + 5 > left) print "STOCKWISE_BUDGET:WARNING projected spend plus a $5 margin exceeds the remaining budget: pause or tear down"
    else print "STOCKWISE_BUDGET:OK projected spend plus a $5 margin fits the remaining budget" }'
fi
month_start="$(date -u +%Y-%m-01)"
tomorrow="$(date -u -d tomorrow +%Y-%m-%d 2>/dev/null || date -u -v+1d +%Y-%m-%d)"
if spend="$(aws ce get-cost-and-usage --time-period "Start=${month_start},End=${tomorrow}" --granularity MONTHLY \
  --metrics UnblendedCost --query 'ResultsByTime[0].Total.UnblendedCost.Amount' --output text 2>/dev/null)"; then
  echo "STOCKWISE_BUDGET:cost_explorer_month_to_date_usd=${spend}"
else
  echo "STOCKWISE_BUDGET:cost_explorer_unavailable (use the Learner Lab panel)"
fi
