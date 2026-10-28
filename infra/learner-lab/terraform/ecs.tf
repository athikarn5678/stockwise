# ECS on EC2: an Auto Scaling Group of ECS-optimized AL2023 instances across both
# AZs (created before the cluster's capacity provider, as the Learner Lab README
# recommends), one service running the web+api task behind the ALB, and one-off
# ops task definitions run by operator/run-ops-task.sh.

resource "aws_cloudwatch_log_group" "container" {
  for_each          = toset(["web", "api", "ops"])
  name              = "/stockwise/${var.name_prefix}/${each.key}"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "container_insights" {
  count             = var.enable_container_insights ? 1 : 0
  name              = "/aws/ecs/containerinsights/${var.name_prefix}/performance"
  retention_in_days = 1
}

resource "aws_ecs_cluster" "demo" {
  name = var.name_prefix
  setting {
    name  = "containerInsights"
    value = var.enable_container_insights ? "enabled" : "disabled"
  }
  depends_on = [aws_cloudwatch_log_group.container_insights]
}

# ---- capacity: launch template, Auto Scaling Group, capacity provider -------------
data "aws_ssm_parameter" "ecs_ami" {
  name = var.ecs_ami_parameter
}

resource "aws_launch_template" "ecs" {
  name_prefix            = "${var.name_prefix}-ecs-"
  image_id               = data.aws_ssm_parameter.ecs_ami.insecure_value
  instance_type          = var.instance_type
  vpc_security_group_ids = [aws_security_group.instance.id]
  update_default_version = true

  iam_instance_profile {
    arn = local.lab_instance_profile_arn
  }

  # IMDSv2 only, hop limit 1; awsvpc tasks are additionally blocked from IMDS
  # (ECS_AWSVPC_BLOCK_IMDS), so containers cannot borrow the instance role.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_size           = var.root_volume_gb
      volume_type           = "gp3"
      encrypted             = true
      delete_on_termination = true
    }
  }

  monitoring {
    enabled = false
  }

  user_data = base64encode(<<-EOT
    #!/bin/bash
    cat >>/etc/ecs/ecs.config <<'CONFIG'
    ECS_CLUSTER=${var.name_prefix}
    ECS_AWSVPC_BLOCK_IMDS=true
    ECS_ENABLE_TASK_IAM_ROLE=true
    ECS_CONTAINER_STOP_TIMEOUT=30s
    ECS_IMAGE_PULL_BEHAVIOR=prefer-cached
    CONFIG
  EOT
  )

  tag_specifications {
    resource_type = "instance"
    tags          = { Name = "${var.name_prefix}-ecs" }
  }
  tag_specifications {
    resource_type = "volume"
    tags          = { Name = "${var.name_prefix}-ecs" }
  }
}

resource "aws_autoscaling_group" "ecs" {
  name                      = "${var.name_prefix}-ecs"
  vpc_zone_identifier       = aws_subnet.app[*].id
  min_size                  = var.asg_min_size
  max_size                  = var.asg_max_size
  desired_capacity          = var.asg_min_size
  health_check_type         = "EC2"
  health_check_grace_period = 120
  protect_from_scale_in     = false
  default_instance_warmup   = 120
  enabled_metrics           = ["GroupDesiredCapacity", "GroupInServiceInstances", "GroupPendingInstances", "GroupTotalInstances"]

  launch_template {
    id      = aws_launch_template.ecs.id
    version = aws_launch_template.ecs.latest_version
  }

  tag {
    key                 = "AmazonECSManaged"
    value               = "true"
    propagate_at_launch = true
  }
  tag {
    key                 = "Name"
    value               = "${var.name_prefix}-ecs"
    propagate_at_launch = true
  }

  lifecycle {
    # ECS managed scaling owns the desired capacity after creation.
    ignore_changes = [desired_capacity]
  }
}

resource "aws_ecs_capacity_provider" "ec2" {
  name = "${var.name_prefix}-ec2"
  auto_scaling_group_provider {
    auto_scaling_group_arn = aws_autoscaling_group.ecs.arn
    # Disabled so teardown never waits on protected instances; ECS still drains
    # tasks from instances before scale-in.
    managed_termination_protection = "DISABLED"
    managed_draining               = "ENABLED"
    managed_scaling {
      status                    = "ENABLED"
      target_capacity           = 100
      minimum_scaling_step_size = 1
      maximum_scaling_step_size = 1
      instance_warmup_period    = 120
    }
  }
}

resource "aws_ecs_cluster_capacity_providers" "demo" {
  cluster_name       = aws_ecs_cluster.demo.name
  capacity_providers = [aws_ecs_capacity_provider.ec2.name]
  default_capacity_provider_strategy {
    capacity_provider = aws_ecs_capacity_provider.ec2.name
    weight            = 1
  }
}

# ---- task definitions ------------------------------------------------------------
locals {
  images_set = var.web_image != null && var.api_image != null && var.ops_image != null

  common_template_vars = {
    region  = var.region
    db_host = aws_db_instance.demo.address
    db_port = tostring(aws_db_instance.demo.port)
    db_name = var.db_name
  }

  # "unset" only renders far enough for the precondition below to refuse the plan.
  app_containers = templatefile("${path.module}/templates/app-containers.json.tftpl", merge(local.common_template_vars, {
    web_image              = coalesce(var.web_image, "unset")
    api_image              = coalesce(var.api_image, "unset")
    public_web_origin      = "https://${var.demo_hostname}"
    email_from             = var.email_from
    web_log_group          = aws_cloudwatch_log_group.container["web"].name
    api_log_group          = aws_cloudwatch_log_group.container["api"].name
    database_secret_arn    = aws_secretsmanager_secret.database.arn
    application_secret_arn = aws_secretsmanager_secret.application.arn
  }))

  # Each ops task definition receives only the secrets its actions need
  # (templates/ops-secrets.json, also read by the local rehearsal).
  secret_arns = {
    application = aws_secretsmanager_secret.application.arn
    database    = aws_secretsmanager_secret.database.arn
    master      = local.master_secret_arn
  }
  ops_secrets = jsondecode(file("${path.module}/templates/ops-secrets.json"))
  ops_roles = {
    for role, secrets in local.ops_secrets : role => {
      # The export task is the only one with AWS credentials (LabRole, for S3).
      task_role = role == "export" ? local.lab_role_arn : null
      secrets = [
        for secret in secrets : { name = secret.name, valueFrom = "${local.secret_arns[secret.secret]}:${secret.key}::" }
      ]
    }
  }
}

resource "aws_ecs_task_definition" "app" {
  family                   = "${var.name_prefix}-app"
  network_mode             = "awsvpc"
  requires_compatibilities = ["EC2"]
  execution_role_arn       = local.lab_role_arn
  # No task role: the running application holds no AWS credentials.
  container_definitions = local.app_containers

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  lifecycle {
    precondition {
      condition     = local.images_set
      error_message = "web_image, api_image and ops_image (digest references) are required for the full apply."
    }
  }
}

resource "aws_ecs_task_definition" "ops" {
  for_each                 = local.ops_roles
  family                   = "${var.name_prefix}-ops-${each.key}"
  network_mode             = "awsvpc"
  requires_compatibilities = ["EC2"]
  execution_role_arn       = local.lab_role_arn
  task_role_arn            = each.value.task_role
  container_definitions = templatefile("${path.module}/templates/ops-container.json.tftpl", merge(local.common_template_vars, {
    ops_image     = coalesce(var.ops_image, "unset")
    ops_role      = each.key
    export_bucket = aws_s3_bucket.exports.id
    ops_log_group = aws_cloudwatch_log_group.container["ops"].name
    secrets       = jsonencode(each.value.secrets)
  }))

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  lifecycle {
    precondition {
      condition     = var.ops_image != null
      error_message = "ops_image (digest reference) is required for the full apply."
    }
  }
}

# ---- service -----------------------------------------------------------------------
resource "aws_ecs_service" "app" {
  name                              = "${var.name_prefix}-app"
  cluster                           = aws_ecs_cluster.demo.id
  task_definition                   = aws_ecs_task_definition.app.arn
  desired_count                     = var.app_desired_count
  health_check_grace_period_seconds = 120
  enable_ecs_managed_tags           = true
  propagate_tags                    = "SERVICE"
  enable_execute_command            = false

  capacity_provider_strategy {
    capacity_provider = aws_ecs_capacity_provider.ec2.name
    weight            = 1
  }

  # Stop the old task before starting the new one: never two API processes, so
  # the process-local login limiter keeps its accepted budget (brief downtime
  # during a release instead of a rolling overlap).
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  ordered_placement_strategy {
    type  = "spread"
    field = "attribute:ecs.availability-zone"
  }

  network_configuration {
    subnets          = aws_subnet.app[*].id
    security_groups  = [aws_security_group.task.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.web.arn
    container_name   = "web"
    container_port   = 3000
  }

  depends_on = [aws_lb_listener.https, aws_ecs_cluster_capacity_providers.demo]
}

# ---- budget guard: scale container instances to zero at the end of the window -----
resource "aws_autoscaling_schedule" "demo_end" {
  scheduled_action_name  = "${var.name_prefix}-demo-end-scale-to-zero"
  autoscaling_group_name = aws_autoscaling_group.ecs.name
  min_size               = 0
  max_size               = 0
  desired_capacity       = 0
  start_time             = var.demo_end_time
}
