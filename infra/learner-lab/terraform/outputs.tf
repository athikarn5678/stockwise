output "acm_validation_records" {
  description = "CNAME records to create at the DNS provider so ACM can issue the certificate."
  value = var.existing_certificate_arn != null ? [] : [
    for option in aws_acm_certificate.app[0].domain_validation_options : {
      name  = option.resource_record_name
      type  = option.resource_record_type
      value = option.resource_record_value
    }
  ]
}

output "public_dns_record" {
  description = "The DNS record the owner creates for the demo hostname (DNS only, not proxied)."
  value = {
    name  = var.demo_hostname
    type  = "CNAME"
    value = var.enable_cloudfront ? aws_cloudfront_distribution.app[0].domain_name : aws_lb.app.dns_name
  }
}

output "public_origin" {
  value = "https://${var.demo_hostname}"
}

output "alb_dns_name" {
  value = aws_lb.app.dns_name
}

output "ecr_repositories" {
  value = { for name, repository in aws_ecr_repository.image : name => repository.repository_url }
}

output "cluster_name" {
  value = aws_ecs_cluster.demo.name
}

output "service_name" {
  value = aws_ecs_service.app.name
}

output "autoscaling_group_name" {
  value = aws_autoscaling_group.ecs.name
}

output "capacity_provider_name" {
  value = aws_ecs_capacity_provider.ec2.name
}

output "ops_task_definitions" {
  value = { for role, definition in aws_ecs_task_definition.ops : role => definition.family }
}

output "task_subnet_ids" {
  value = aws_subnet.app[*].id
}

output "task_security_group_id" {
  value = aws_security_group.task.id
}

output "ops_log_group" {
  value = aws_cloudwatch_log_group.container["ops"].name
}

output "application_secret_arn" {
  value = aws_secretsmanager_secret.application.arn
}

output "database_secret_arn" {
  value = aws_secretsmanager_secret.database.arn
}

output "master_secret_arn" {
  description = "RDS-managed (or write_only fallback) master credentials, used only by the ops-bootstrap task."
  value       = local.master_secret_arn
}

output "db_instance_identifier" {
  value = aws_db_instance.demo.identifier
}

output "db_endpoint" {
  value = aws_db_instance.demo.address
}

output "exports_bucket" {
  value = aws_s3_bucket.exports.id
}

output "outage_alarm_name" {
  description = "Reconciled by capacity.sh resume and deploy.sh (R2-F8)."
  value       = aws_cloudwatch_metric_alarm.no_healthy_target.alarm_name
}

output "dashboard_url" {
  value = "https://${var.region}.console.aws.amazon.com/cloudwatch/home?region=${var.region}#dashboards/dashboard/${aws_cloudwatch_dashboard.demo.dashboard_name}"
}

# Plain string outputs read by the operator scripts with `terraform output -raw`
# (no JSON tooling required on the operator machine).
output "name_prefix" {
  value = var.name_prefix
}

output "region" {
  value = var.region
}

# The account the operator scripts require the active Learner Lab identity to
# belong to (require_lab_identity fails closed without it).
output "account_id" {
  value = local.account_id
}

output "db_name" {
  value = var.db_name
}

output "task_subnets_csv" {
  value = join(",", aws_subnet.app[*].id)
}

output "db_master_username" {
  value = var.db_master_username
}

output "planning_deadline" {
  value = var.demo_end_time
}

output "cloudfront_enabled" {
  value = tostring(var.enable_cloudfront)
}

output "current_web_image" {
  value = coalesce(var.web_image, "none")
}

output "current_api_image" {
  value = coalesce(var.api_image, "none")
}

output "current_ops_image" {
  value = coalesce(var.ops_image, "none")
}

output "current_app_desired_count" {
  value = tostring(var.app_desired_count)
}
