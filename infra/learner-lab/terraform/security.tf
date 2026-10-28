# Security-group chain: internet (or CloudFront) -> ALB :443 -> task :3000 ->
# RDS :5432. The API listens on the task's loopback only and is never a target.
data "aws_ec2_managed_prefix_list" "cloudfront_origin" {
  count = var.enable_cloudfront ? 1 : 0
  name  = "com.amazonaws.global.cloudfront.origin-facing"
}

resource "aws_security_group" "alb" {
  name        = "${var.name_prefix}-alb"
  description = "StockWise ALB: HTTPS from viewers (or CloudFront only)"
  vpc_id      = aws_vpc.demo.id
  tags        = { Name = "${var.name_prefix}-alb" }
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  for_each          = var.enable_cloudfront ? toset([]) : toset(var.allowed_ingress_ipv4_cidrs)
  security_group_id = aws_security_group.alb.id
  description       = "HTTPS from viewers"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = each.value
}

resource "aws_vpc_security_group_ingress_rule" "alb_http_redirect" {
  for_each          = var.enable_cloudfront ? toset([]) : toset(var.allowed_ingress_ipv4_cidrs)
  security_group_id = aws_security_group.alb.id
  description       = "HTTP, redirected to HTTPS by the listener"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  cidr_ipv4         = each.value
}

resource "aws_vpc_security_group_ingress_rule" "alb_https_cloudfront" {
  count             = var.enable_cloudfront ? 1 : 0
  security_group_id = aws_security_group.alb.id
  description       = "HTTPS from CloudFront origin-facing addresses only"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  prefix_list_id    = data.aws_ec2_managed_prefix_list.cloudfront_origin[0].id
}

resource "aws_vpc_security_group_egress_rule" "alb_to_task" {
  security_group_id            = aws_security_group.alb.id
  description                  = "Forward to the Next.js container"
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
  referenced_security_group_id = aws_security_group.task.id
}

# awsvpc task ENIs (application and one-off ops tasks).
resource "aws_security_group" "task" {
  name        = "${var.name_prefix}-task"
  description = "StockWise ECS tasks: web from the ALB only"
  vpc_id      = aws_vpc.demo.id
  tags        = { Name = "${var.name_prefix}-task" }
}

resource "aws_vpc_security_group_ingress_rule" "task_from_alb" {
  security_group_id            = aws_security_group.task.id
  description                  = "Next.js from the ALB"
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
  referenced_security_group_id = aws_security_group.alb.id
}

resource "aws_vpc_security_group_egress_rule" "task_to_db" {
  security_group_id            = aws_security_group.task.id
  description                  = "PostgreSQL"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.db.id
}

resource "aws_vpc_security_group_egress_rule" "task_https" {
  security_group_id = aws_security_group.task.id
  description       = "HTTPS egress through NAT (Resend; S3 for exports)"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

# Container instances: no inbound at all (administration via SSM Session Manager).
resource "aws_security_group" "instance" {
  name        = "${var.name_prefix}-instance"
  description = "StockWise ECS container instances: no inbound"
  vpc_id      = aws_vpc.demo.id
  tags        = { Name = "${var.name_prefix}-instance" }
}

resource "aws_vpc_security_group_egress_rule" "instance_https" {
  security_group_id = aws_security_group.instance.id
  description       = "ECS agent, ECR, CloudWatch, Secrets Manager, SSM over HTTPS"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_security_group" "db" {
  name        = "${var.name_prefix}-db"
  description = "StockWise RDS: PostgreSQL from ECS tasks only"
  vpc_id      = aws_vpc.demo.id
  tags        = { Name = "${var.name_prefix}-db" }
}

resource "aws_vpc_security_group_ingress_rule" "db_from_task" {
  security_group_id            = aws_security_group.db.id
  description                  = "PostgreSQL from ECS tasks"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.task.id
}
