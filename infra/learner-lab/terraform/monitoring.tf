# CloudWatch alarms (to SNS), one dashboard and the optional AWS Budgets alert.
resource "aws_sns_topic" "alarms" {
  name = "${var.name_prefix}-alarms"
}

resource "aws_sns_topic_subscription" "alarm_email" {
  count     = var.alarm_email == null ? 0 : 1
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

locals {
  alb_dimensions = { LoadBalancer = aws_lb.app.arn_suffix }
  tg_dimensions  = { LoadBalancer = aws_lb.app.arn_suffix, TargetGroup = aws_lb_target_group.web.arn_suffix }
  ecs_dimensions = { ClusterName = aws_ecs_cluster.demo.name, ServiceName = aws_ecs_service.app.name }
  rds_dimensions = { DBInstanceIdentifier = aws_db_instance.demo.identifier }

  alarms = {
    alb-target-5xx = {
      namespace  = "AWS/ApplicationELB", metric = "HTTPCode_Target_5XX_Count", statistic = "Sum"
      dimensions = local.alb_dimensions, comparison = "GreaterThanOrEqualToThreshold", threshold = 5
      period     = 300, periods = 1, description = "Application returned 5xx responses"
    }
    alb-elb-5xx = {
      namespace  = "AWS/ApplicationELB", metric = "HTTPCode_ELB_5XX_Count", statistic = "Sum"
      dimensions = local.alb_dimensions, comparison = "GreaterThanOrEqualToThreshold", threshold = 5
      period     = 300, periods = 1, description = "ALB returned 5xx (no healthy target, timeouts)"
    }
    unhealthy-target = {
      namespace  = "AWS/ApplicationELB", metric = "UnHealthyHostCount", statistic = "Maximum"
      dimensions = local.tg_dimensions, comparison = "GreaterThanOrEqualToThreshold", threshold = 1
      period     = 60, periods = 3, description = "A web task fails the /api/health check"
    }
    ecs-cpu-high = {
      namespace  = "AWS/ECS", metric = "CPUUtilization", statistic = "Average"
      dimensions = local.ecs_dimensions, comparison = "GreaterThanThreshold", threshold = 80
      period     = 300, periods = 3, description = "Application task CPU above 80%"
    }
    ecs-memory-high = {
      namespace  = "AWS/ECS", metric = "MemoryUtilization", statistic = "Average"
      dimensions = local.ecs_dimensions, comparison = "GreaterThanThreshold", threshold = 85
      period     = 300, periods = 3, description = "Application task memory above 85% of its reservation"
    }
    rds-cpu-high = {
      namespace  = "AWS/RDS", metric = "CPUUtilization", statistic = "Average"
      dimensions = local.rds_dimensions, comparison = "GreaterThanThreshold", threshold = 80
      period     = 300, periods = 3, description = "RDS CPU above 80%"
    }
    rds-free-storage-low = {
      namespace  = "AWS/RDS", metric = "FreeStorageSpace", statistic = "Minimum"
      dimensions = local.rds_dimensions, comparison = "LessThanThreshold", threshold = 2147483648
      period     = 300, periods = 1, description = "RDS free storage below 2 GiB"
    }
    rds-freeable-memory-low = {
      namespace  = "AWS/RDS", metric = "FreeableMemory", statistic = "Minimum"
      dimensions = local.rds_dimensions, comparison = "LessThanThreshold", threshold = 67108864
      period     = 300, periods = 2, description = "RDS freeable memory below 64 MiB"
    }
    rds-connections-high = {
      namespace  = "AWS/RDS", metric = "DatabaseConnections", statistic = "Maximum"
      dimensions = local.rds_dimensions, comparison = "GreaterThanThreshold", threshold = 60
      period     = 300, periods = 1, description = "RDS connections above 60"
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "this" {
  for_each            = local.alarms
  alarm_name          = "${var.name_prefix}-${each.key}"
  alarm_description   = each.value.description
  namespace           = each.value.namespace
  metric_name         = each.value.metric
  statistic           = each.value.statistic
  dimensions          = each.value.dimensions
  comparison_operator = each.value.comparison
  threshold           = each.value.threshold
  period              = each.value.period
  evaluation_periods  = each.value.periods
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}

# The outage alarm (findings F8 and R2-F8). Application availability is judged
# against the ECS service's own desired task count (Container Insights), not
# EC2 capacity:
# - desired >= 1 (or desired unknown): the value is the healthy target count,
#   and a missing HealthyHostCount counts as 0 (the only task disappeared);
# - desired = 0 (an intentional pause or teardown): the value is 1, so a pause
#   evaluates as healthy rather than entering ALARM.
# Missing data is breaching. Notifications are also disabled while
# app_desired_count = 0. CloudWatch notifies only on a state transition, and
# re-enabling actions on an alarm already in ALARM does not notify again. So
# capacity.sh resume and deploy.sh reconcile: an ALARM found at resume time is
# moved to INSUFFICIENT_DATA, and a continuing outage then makes a fresh,
# notifying transition back to ALARM (operator/common.sh
# reconcile_outage_alarm). The end-of-window ASG scale-to-zero keeps the
# service desired, so that outage is reported.
resource "aws_cloudwatch_metric_alarm" "no_healthy_target" {
  alarm_name          = "${var.name_prefix}-no-healthy-target"
  alarm_description   = "No healthy application task behind the ALB while the ECS service should run (missing data counts as an outage)"
  comparison_operator = "LessThanThreshold"
  threshold           = 1
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  treat_missing_data  = "breaching"
  actions_enabled     = var.app_desired_count > 0
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]

  metric_query {
    id          = "outage_signal"
    expression  = "IF(FILL(desired, 1) >= 1, FILL(healthy, 0), 1)"
    label       = "Healthy targets while the service should run (1 while paused)"
    return_data = true
  }

  metric_query {
    id          = "desired"
    return_data = false
    metric {
      namespace   = "ECS/ContainerInsights"
      metric_name = "DesiredTaskCount"
      dimensions  = local.ecs_dimensions
      period      = 60
      stat        = "Maximum"
    }
  }

  metric_query {
    id          = "healthy"
    return_data = false
    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "HealthyHostCount"
      dimensions  = local.tg_dimensions
      period      = 60
      stat        = "Minimum"
    }
  }

  lifecycle {
    precondition {
      condition     = var.enable_container_insights
      error_message = "The outage alarm needs Container Insights (the ECS service DesiredTaskCount metric)."
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "latency_p95" {
  alarm_name          = "${var.name_prefix}-latency-p95"
  alarm_description   = "p95 target response time above 2 s"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "TargetResponseTime"
  extended_statistic  = "p95"
  dimensions          = local.alb_dimensions
  comparison_operator = "GreaterThanThreshold"
  threshold           = 2
  period              = 300
  evaluation_periods  = 2
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_dashboard" "demo" {
  dashboard_name = var.name_prefix
  dashboard_body = jsonencode({
    widgets = [
      for index, widget in [
        { title = "ALB requests and errors", metrics = [
          ["AWS/ApplicationELB", "RequestCount", "LoadBalancer", aws_lb.app.arn_suffix, { stat = "Sum" }],
          [".", "HTTPCode_Target_4XX_Count", ".", ".", { stat = "Sum" }],
          [".", "HTTPCode_Target_5XX_Count", ".", ".", { stat = "Sum" }],
          [".", "HTTPCode_ELB_5XX_Count", ".", ".", { stat = "Sum" }],
        ] },
        { title = "Target response time (p50 / p95)", metrics = [
          ["AWS/ApplicationELB", "TargetResponseTime", "LoadBalancer", aws_lb.app.arn_suffix, { stat = "p50" }],
          ["...", { stat = "p95" }],
        ] },
        { title = "Healthy / unhealthy tasks", metrics = [
          ["AWS/ApplicationELB", "HealthyHostCount", "TargetGroup", aws_lb_target_group.web.arn_suffix, "LoadBalancer", aws_lb.app.arn_suffix, { stat = "Minimum" }],
          [".", "UnHealthyHostCount", ".", ".", ".", ".", { stat = "Maximum" }],
        ] },
        { title = "ECS service CPU / memory (%)", metrics = [
          ["AWS/ECS", "CPUUtilization", "ClusterName", aws_ecs_cluster.demo.name, "ServiceName", aws_ecs_service.app.name],
          [".", "MemoryUtilization", ".", ".", ".", "."],
        ] },
        { title = "Auto Scaling Group instances", metrics = [
          ["AWS/AutoScaling", "GroupInServiceInstances", "AutoScalingGroupName", aws_autoscaling_group.ecs.name],
          [".", "GroupDesiredCapacity", ".", "."],
        ] },
        { title = "RDS CPU (%) and connections", metrics = [
          ["AWS/RDS", "CPUUtilization", "DBInstanceIdentifier", aws_db_instance.demo.identifier],
          [".", "DatabaseConnections", ".", ".", { yAxis = "right" }],
        ] },
        { title = "RDS free storage and memory (bytes)", metrics = [
          ["AWS/RDS", "FreeStorageSpace", "DBInstanceIdentifier", aws_db_instance.demo.identifier],
          [".", "FreeableMemory", ".", "."],
        ] },
        { title = "RDS read / write latency (s)", metrics = [
          ["AWS/RDS", "ReadLatency", "DBInstanceIdentifier", aws_db_instance.demo.identifier],
          [".", "WriteLatency", ".", "."],
        ] },
        ] : {
        type   = "metric"
        x      = (index % 2) * 12
        y      = floor(index / 2) * 6
        width  = 12
        height = 6
        properties = {
          title   = widget.title
          region  = var.region
          view    = "timeSeries"
          stacked = false
          period  = 60
          metrics = widget.metrics
        }
      }
    ]
  })
}

resource "aws_budgets_budget" "account" {
  count        = var.enable_aws_budget ? 1 : 0
  name         = "${var.name_prefix}-cost"
  budget_type  = "COST"
  limit_amount = tostring(var.budget_limit_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.budget_email]
  }

  lifecycle {
    precondition {
      condition     = var.budget_email != null
      error_message = "enable_aws_budget requires budget_email."
    }
  }
}
