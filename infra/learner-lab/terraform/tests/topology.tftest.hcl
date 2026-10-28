# Offline checks of the ADR-040 topology with a mocked AWS provider:
#   terraform test   (no AWS credentials, nothing is created)
# They prove what the configuration declares, not what Learner Lab permits.

mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  mock_data "aws_partition" {
    defaults = { partition = "aws" }
  }
  mock_data "aws_availability_zones" {
    defaults = { names = ["us-east-1a", "us-east-1b", "us-east-1c"] }
  }
  mock_data "aws_ssm_parameter" {
    defaults = { insecure_value = "ami-0123456789abcdef0" }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  mock_data "aws_cloudfront_cache_policy" {
    defaults = { id = "mock-cache-policy" }
  }
  mock_resource "aws_db_instance" {
    defaults = {
      address            = "stockwise-demo-postgres.example.us-east-1.rds.amazonaws.com"
      port               = 5432
      master_user_secret = [{ secret_arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:rds!db-mock", kms_key_id = "", secret_status = "active" }]
    }
  }
  mock_resource "aws_secretsmanager_secret" {
    defaults = { arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:stockwise-demo/mock" }
  }
  # Realistic identifiers so the provider's own argument validation passes.
  mock_resource "aws_lb" {
    defaults = {
      arn        = "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/stockwise-demo-alb/0123456789abcdef"
      arn_suffix = "app/stockwise-demo-alb/0123456789abcdef"
      dns_name   = "stockwise-demo-alb-123.us-east-1.elb.amazonaws.com"
    }
  }
  mock_resource "aws_lb_target_group" {
    defaults = {
      arn        = "arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/stockwise-demo-web/0123456789abcdef"
      arn_suffix = "targetgroup/stockwise-demo-web/0123456789abcdef"
    }
  }
  mock_resource "aws_lb_listener" {
    defaults = { arn = "arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/stockwise-demo-alb/0123456789abcdef/0123456789abcdef" }
  }
  mock_resource "aws_acm_certificate" {
    defaults = { arn = "arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000000" }
  }
  mock_resource "aws_acm_certificate_validation" {
    defaults = { certificate_arn = "arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000000" }
  }
  mock_resource "aws_launch_template" {
    defaults = { id = "lt-0123456789abcdef0", latest_version = 1 }
  }
  mock_resource "aws_autoscaling_group" {
    defaults = { arn = "arn:aws:autoscaling:us-east-1:123456789012:autoScalingGroup:00000000-0000-0000-0000-000000000000:autoScalingGroupName/stockwise-demo-ecs" }
  }
  mock_resource "aws_sns_topic" {
    defaults = { arn = "arn:aws:sns:us-east-1:123456789012:stockwise-demo-alarms" }
  }
  mock_resource "aws_s3_bucket" {
    defaults = { arn = "arn:aws:s3:::stockwise-demo-mock" }
  }
  mock_resource "aws_ecs_cluster" {
    defaults = { id = "arn:aws:ecs:us-east-1:123456789012:cluster/stockwise-demo", arn = "arn:aws:ecs:us-east-1:123456789012:cluster/stockwise-demo" }
  }
  mock_resource "aws_ecs_task_definition" {
    defaults = { arn = "arn:aws:ecs:us-east-1:123456789012:task-definition/stockwise-demo-app:1" }
  }
  mock_resource "aws_cloudfront_response_headers_policy" {
    defaults = { id = "mock-response-headers" }
  }
}

variables {
  demo_hostname     = "stockwise-demo.example.com"
  email_from        = "StockWise Demo <noreply@demo.example.com>"
  web_image         = "123456789012.dkr.ecr.us-east-1.amazonaws.com/stockwise-demo/web@sha256:1111111111111111111111111111111111111111111111111111111111111111"
  api_image         = "123456789012.dkr.ecr.us-east-1.amazonaws.com/stockwise-demo/api@sha256:2222222222222222222222222222222222222222222222222222222222222222"
  ops_image         = "123456789012.dkr.ecr.us-east-1.amazonaws.com/stockwise-demo/ops@sha256:3333333333333333333333333333333333333333333333333333333333333333"
  app_desired_count = 1
  demo_end_time     = "2099-01-01T00:00:00Z"
  # terraform test needs an ephemeral input to be identical in plan and apply;
  # unused in the default secrets_manager mode.
  db_master_password = "test-only-not-a-secret-0123456789"
}

run "default_topology" {
  command = apply

  # Network: three tiers in two AZs; RDS subnets have no route out.
  assert {
    condition     = length(aws_subnet.public) == 2 && length(aws_subnet.app) == 2 && length(aws_subnet.data) == 2
    error_message = "Expected public, app and data subnets in two AZs."
  }
  assert {
    condition     = length(aws_route_table.data.route) == 0
    error_message = "Data subnets must have no internet route."
  }
  assert {
    condition     = alltrue([for subnet in aws_subnet.app : !subnet.map_public_ip_on_launch])
    error_message = "App subnets must not assign public IPs."
  }
  assert {
    condition = length(aws_nat_gateway.demo) == 2 && alltrue([
      for index, table in aws_route_table.app : one(table.route).nat_gateway_id == aws_nat_gateway.demo[index].id
    ]) && aws_nat_gateway.demo[0].subnet_id != aws_nat_gateway.demo[1].subnet_id
    error_message = "Two NAT gateways in different AZs, each app subnet routed through its own (OD-4)."
  }

  # ALB with ACM HTTPS, HTTP redirect, security headers, IP targets.
  assert {
    condition     = aws_lb.app.internal == false && aws_lb.app.drop_invalid_header_fields
    error_message = "ALB must be internet-facing and drop invalid headers."
  }
  assert {
    condition     = aws_lb_listener.https.protocol == "HTTPS" && aws_lb_listener.https.ssl_policy == "ELBSecurityPolicy-TLS13-1-2-2021-06"
    error_message = "HTTPS listener with a TLS 1.2/1.3 policy expected."
  }
  assert {
    condition     = aws_lb_listener.https.routing_http_response_strict_transport_security_header_value == "max-age=86400" && aws_lb_listener.https.routing_http_response_server_enabled == false
    error_message = "ALB must add HSTS and suppress the Server header."
  }
  assert {
    condition     = aws_lb_listener.http[0].default_action[0].type == "redirect"
    error_message = "HTTP must redirect to HTTPS."
  }
  assert {
    condition     = aws_lb_target_group.web.target_type == "ip" && aws_lb_target_group.web.port == 3000 && aws_lb_target_group.web.health_check[0].path == "/api/health"
    error_message = "Target group must register awsvpc task IPs on 3000 with /api/health."
  }
  assert {
    condition     = length(aws_cloudfront_distribution.app) == 0
    error_message = "CloudFront must stay disabled by default."
  }

  # ECS on EC2 with an Auto Scaling Group across both AZs.
  assert {
    condition     = aws_autoscaling_group.ecs.min_size == 2 && length(aws_autoscaling_group.ecs.vpc_zone_identifier) == 2
    error_message = "ASG must keep two instances across both app subnets."
  }
  assert {
    condition     = aws_launch_template.ecs.metadata_options[0].http_tokens == "required" && aws_launch_template.ecs.metadata_options[0].http_put_response_hop_limit == 1
    error_message = "IMDSv2 with hop limit 1 required."
  }
  assert {
    condition     = endswith(aws_launch_template.ecs.iam_instance_profile[0].arn, ":instance-profile/LabInstanceProfile")
    error_message = "Container instances must use LabInstanceProfile."
  }
  assert {
    condition     = strcontains(base64decode(aws_launch_template.ecs.user_data), "ECS_AWSVPC_BLOCK_IMDS=true")
    error_message = "awsvpc tasks must be blocked from IMDS."
  }
  assert {
    condition     = aws_ecs_capacity_provider.ec2.auto_scaling_group_provider[0].managed_scaling[0].status == "ENABLED"
    error_message = "Capacity provider must manage ASG scaling."
  }

  # Application task: awsvpc, both containers, Native only, no task role.
  assert {
    condition     = aws_ecs_task_definition.app.network_mode == "awsvpc" && aws_ecs_task_definition.app.requires_compatibilities == toset(["EC2"])
    error_message = "Application task must be awsvpc on EC2."
  }
  assert {
    condition     = endswith(aws_ecs_task_definition.app.execution_role_arn, ":role/LabRole") && aws_ecs_task_definition.app.task_role_arn == null
    error_message = "LabRole is the execution role; the application has no task role."
  }
  assert {
    condition     = [for container in jsondecode(aws_ecs_task_definition.app.container_definitions) : container.name] == ["web", "api"]
    error_message = "Application task must contain web and api."
  }
  assert {
    condition = contains([
      for variable in jsondecode(aws_ecs_task_definition.app.container_definitions)[1].environment : "${variable.name}=${variable.value}"
    ], "STOCKWISE_AUTHENTICATION_AUTHORITY=native")
    error_message = "API must run Better Auth Native."
  }
  assert {
    condition = contains([
      for variable in jsondecode(aws_ecs_task_definition.app.container_definitions)[1].environment : "${variable.name}=${variable.value}"
    ], "STOCKWISE_PUBLIC_WEB_ORIGIN=https://stockwise-demo.example.com")
    error_message = "Public origin must be the exact HTTPS demo origin."
  }
  assert {
    condition     = !can(jsondecode(aws_ecs_task_definition.app.container_definitions)[1].portMappings)
    error_message = "The loopback API must not expose a port mapping."
  }
  assert {
    condition = length([
      for secret in jsondecode(aws_ecs_task_definition.app.container_definitions)[1].secrets : secret
      if strcontains(secret.valueFrom, "rds!") || strcontains(secret.name, "MASTER") || strcontains(secret.name, "MIGRATOR")
    ]) == 0
    error_message = "The API must not receive master or migrator credentials."
  }
  assert {
    condition     = jsondecode(aws_ecs_task_definition.app.container_definitions)[0].image == var.web_image
    error_message = "Web container must run the digest given."
  }

  # Ops tasks: least secrets per role; only export has AWS credentials.
  assert {
    condition     = aws_ecs_task_definition.ops["ops"].task_role_arn == null && aws_ecs_task_definition.ops["bootstrap"].task_role_arn == null
    error_message = "Only the export task may have a task role."
  }
  assert {
    condition     = endswith(aws_ecs_task_definition.ops["export"].task_role_arn, ":role/LabRole")
    error_message = "Export task needs LabRole to write to S3."
  }
  assert {
    condition = length([
      for secret in jsondecode(aws_ecs_task_definition.ops["ops"].container_definitions)[0].secrets : secret
      if strcontains(secret.name, "MASTER")
    ]) == 0
    error_message = "Master credentials belong to the bootstrap task only."
  }

  # Service: one task, stop-before-start, spread across AZs, circuit breaker.
  assert {
    condition     = aws_ecs_service.app.desired_count == 1 && aws_ecs_service.app.deployment_maximum_percent == 100 && aws_ecs_service.app.deployment_minimum_healthy_percent == 0
    error_message = "Exactly one application task, never two during deployment."
  }
  assert {
    condition     = aws_ecs_service.app.deployment_circuit_breaker[0].rollback && aws_ecs_service.app.network_configuration[0].assign_public_ip == false
    error_message = "Circuit breaker rollback on, no public IP."
  }

  # RDS Multi-AZ, private, encrypted, TLS forced, RDS-managed master secret.
  assert {
    condition     = aws_db_instance.demo.multi_az && !aws_db_instance.demo.publicly_accessible && aws_db_instance.demo.storage_encrypted
    error_message = "RDS must be Multi-AZ, private and encrypted."
  }
  assert {
    condition     = aws_db_instance.demo.storage_type == "gp2" && aws_db_instance.demo.monitoring_interval == 0 && aws_db_instance.demo.manage_master_user_password
    error_message = "Learner Lab RDS limits (gp2, no enhanced monitoring) and RDS-managed master secret."
  }
  assert {
    condition     = contains([for parameter in aws_db_parameter_group.demo.parameter : "${parameter.name}=${parameter.value}"], "rds.force_ssl=1")
    error_message = "rds.force_ssl must be 1."
  }

  # S3 exports protected; secrets created without values.
  assert {
    condition     = aws_s3_bucket.exports.force_destroy == false && aws_s3_bucket_public_access_block.exports.block_public_policy
    error_message = "Exports bucket must be private and survive an accidental destroy."
  }
  assert {
    condition     = aws_secretsmanager_secret.application.recovery_window_in_days == 0
    error_message = "Secrets must delete immediately at teardown."
  }

  # Budget guard.
  assert {
    condition     = aws_autoscaling_schedule.demo_end.max_size == 0 && aws_autoscaling_schedule.demo_end.start_time == "2099-01-01T00:00:00Z"
    error_message = "Scheduled scale-to-zero must exist at demo_end_time."
  }

  # F1: no ALB request logging (URLs carry single-use credentials).
  assert {
    condition     = alltrue([for log in aws_lb.app.access_logs : !log.enabled]) && alltrue([for log in aws_lb.app.connection_logs : !log.enabled])
    error_message = "ALB access and connection logging must stay disabled."
  }

  # F4: the default configuration holds no CloudFront origin secret anywhere.
  assert {
    condition     = var.cloudfront_origin_secret == null && length(aws_cloudfront_distribution.app) == 0 && length(aws_lb_listener_rule.cloudfront_only) == 0
    error_message = "Without CloudFront no origin secret may exist in configuration or state."
  }

  # F8: the outage alarm treats a missing target metric as zero and as breaching,
  # and notifies while the service should run.
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.no_healthy_target.treat_missing_data == "breaching" &&
      aws_cloudwatch_metric_alarm.no_healthy_target.actions_enabled &&
      aws_cloudwatch_metric_alarm.no_healthy_target.comparison_operator == "LessThanThreshold" &&
      aws_cloudwatch_metric_alarm.no_healthy_target.threshold == 1 &&
      contains([for query in aws_cloudwatch_metric_alarm.no_healthy_target.metric_query : query.expression], "IF(FILL(desired, 1) >= 1, FILL(healthy, 0), 1)")
    )
    error_message = "No-healthy-target must alarm on missing data while the service is expected to run."
  }
  assert {
    condition     = one([for query in aws_cloudwatch_metric_alarm.no_healthy_target.metric_query : query if query.return_data == true]).id == "outage_signal"
    error_message = "The alarm must evaluate the desired-aware expression, not a raw metric."
  }
  # R2-F8: availability is judged against the ECS service's desired count
  # (Container Insights), not EC2 capacity; the operator reconciles on resume.
  assert {
    condition = length([
      for query in aws_cloudwatch_metric_alarm.no_healthy_target.metric_query : query
      if query.id == "desired" && one(query.metric).namespace == "ECS/ContainerInsights" && one(query.metric).metric_name == "DesiredTaskCount"
    ]) == 1
    error_message = "The outage alarm must read the ECS service DesiredTaskCount."
  }
  assert {
    condition     = output.outage_alarm_name == aws_cloudwatch_metric_alarm.no_healthy_target.alarm_name && try(length(aws_cloudwatch_metric_alarm.no_healthy_target.insufficient_data_actions), 0) == 0
    error_message = "The reconciled alarm must be exported, and INSUFFICIENT_DATA (the reconciliation state) must not notify."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.this["unhealthy-target"].comparison_operator == "GreaterThanOrEqualToThreshold" && aws_cloudwatch_metric_alarm.this["unhealthy-target"].metric_name == "UnHealthyHostCount"
    error_message = "An unhealthy registered target still raises its own alarm."
  }
}

# F8: an intentional pause (capacity.sh pause, teardown) sets the service to
# zero tasks; outage notifications are silenced, not deleted.
run "f8_intentional_pause_silences_outage_alarm" {
  command = plan
  variables {
    app_desired_count = 0
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.no_healthy_target.actions_enabled == false && aws_ecs_service.app.desired_count == 0
    error_message = "A paused service must not page as an outage."
  }
}

# F8: resuming (capacity.sh resume) restores one task and the notifications.
run "f8_resume_reenables_outage_alarm" {
  command = plan
  variables {
    app_desired_count = 1
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.no_healthy_target.actions_enabled && aws_ecs_service.app.desired_count == 1
    error_message = "Resuming must re-enable outage notifications."
  }
}

# R2-F8: without Container Insights the outage alarm cannot see the desired count.
run "r2f8_outage_alarm_requires_container_insights" {
  command = plan
  variables {
    enable_container_insights = false
  }
  expect_failures = [aws_cloudwatch_metric_alarm.no_healthy_target]
}

# F4: CloudFront is fail-closed until the owner approves its secret handling.
run "cloudfront_refused_without_secret_design_approval" {
  command = plan
  variables {
    enable_cloudfront        = true
    cloudfront_origin_secret = "0123456789abcdefghijklmnopqrstuvwxyzABCD"
  }
  expect_failures = [var.enable_cloudfront]
}

# F4: a stray origin secret is refused while CloudFront is disabled.
run "cloudfront_secret_refused_while_disabled" {
  command = plan
  variables {
    cloudfront_origin_secret = "0123456789abcdefghijklmnopqrstuvwxyzABCD"
  }
  expect_failures = [var.cloudfront_origin_secret]
}

run "planning_deadline_default" {
  command = plan
  variables {
    demo_end_time = "2026-10-31T16:59:00Z"
  }
  assert {
    condition     = aws_autoscaling_schedule.demo_end.start_time == "2026-10-31T16:59:00Z" && output.planning_deadline == "2026-10-31T16:59:00Z"
    error_message = "The planning deadline is 2026-10-31 23:59 Asia/Bangkok (OD-5)."
  }
}

run "refuses_second_replica" {
  command = plan
  variables {
    app_desired_count = 2
  }
  expect_failures = [var.app_desired_count]
}

run "refuses_tagged_image" {
  command = plan
  variables {
    web_image = "ghcr.io/example/stockwise-web:latest"
  }
  expect_failures = [var.web_image]
}

run "refuses_application_without_images" {
  command = plan
  variables {
    web_image = null
  }
  expect_failures = [aws_ecs_task_definition.app]
}

run "refuses_other_regions" {
  command = plan
  variables {
    region = "eu-west-1"
  }
  expect_failures = [var.region]
}

run "cloudfront_edge" {
  command = apply
  variables {
    enable_cloudfront                   = true
    cloudfront_secret_in_state_approved = true
    cloudfront_origin_secret            = "0123456789abcdefghijklmnopqrstuvwxyzABCD"
  }

  assert {
    condition     = length(aws_cloudfront_distribution.app) == 1 && length(aws_lb_listener.http) == 0
    error_message = "CloudFront replaces the public HTTP listener."
  }
  assert {
    condition     = length(aws_vpc_security_group_ingress_rule.alb_https) == 0 && length(aws_vpc_security_group_ingress_rule.alb_https_cloudfront) == 1
    error_message = "With CloudFront the ALB accepts only the CloudFront origin-facing prefix list."
  }
  assert {
    condition     = aws_lb_listener.https.default_action[0].type == "fixed-response" && one(one(aws_lb_listener_rule.cloudfront_only[0].condition).http_header).http_header_name == "X-StockWise-Origin-Verify"
    error_message = "ALB must refuse requests without the origin-verify header."
  }
  assert {
    condition     = aws_cloudfront_distribution.app[0].default_cache_behavior[0].cache_policy_id == data.aws_cloudfront_cache_policy.disabled[0].id
    error_message = "Dynamic pages and APIs must not be cached."
  }
  assert {
    condition     = [for behavior in aws_cloudfront_distribution.app[0].ordered_cache_behavior : behavior.path_pattern] == ["/_next/static/*"]
    error_message = "Only immutable /_next/static/* assets may be cached."
  }
  assert {
    condition     = aws_cloudfront_distribution.app[0].default_cache_behavior[0].viewer_protocol_policy == "redirect-to-https" && one(one(aws_cloudfront_distribution.app[0].origin).custom_origin_config).origin_protocol_policy == "https-only"
    error_message = "HTTPS end to end."
  }
  assert {
    condition     = aws_cloudfront_origin_request_policy.static_assets[0].cookies_config[0].cookie_behavior == "none"
    error_message = "Cached assets must not forward cookies."
  }
}

run "cloudfront_requires_origin_secret" {
  command = plan
  variables {
    enable_cloudfront                   = true
    cloudfront_secret_in_state_approved = true
  }
  expect_failures = [aws_lb_listener_rule.cloudfront_only, aws_cloudfront_distribution.app]
}

run "write_only_master_password_fallback" {
  command = apply
  variables {
    db_master_password_mode = "write_only"
    db_master_password      = "abcdefghijklmnopqrstuvwxyz012345"
  }
  assert {
    condition     = length(aws_secretsmanager_secret.master) == 1 && aws_db_instance.demo.manage_master_user_password == null
    error_message = "Fallback stores master credentials in an operator-filled secret."
  }
}

run "write_only_requires_password" {
  command = plan
  variables {
    db_master_password_mode = "write_only"
    db_master_password      = null
  }
  expect_failures = [aws_db_instance.demo]
}
