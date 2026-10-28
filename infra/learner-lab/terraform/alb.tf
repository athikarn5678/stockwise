# ---- TLS certificate (ACM, DNS validation at the owner's DNS provider) ---------
# Two-step first apply: `terraform apply -target=aws_acm_certificate.app`, add the
# acm_validation_records output as CNAMEs, then the full apply waits for ISSUED.
resource "aws_acm_certificate" "app" {
  # One certificate serves the ALB and, with CloudFront, the distribution too:
  # CloudFront forwards the viewer Host header, so it validates the ALB's
  # certificate against demo_hostname as well.
  count             = var.existing_certificate_arn == null ? 1 : 0
  domain_name       = var.demo_hostname
  validation_method = "DNS"
  key_algorithm     = "RSA_2048"
  tags              = { Name = var.demo_hostname }

  lifecycle {
    create_before_destroy = true
    precondition {
      condition     = !var.enable_cloudfront || var.region == "us-east-1"
      error_message = "CloudFront reads its certificate from us-east-1; use region us-east-1."
    }
  }
}

resource "aws_acm_certificate_validation" "app" {
  count           = var.existing_certificate_arn == null ? 1 : 0
  certificate_arn = aws_acm_certificate.app[0].arn
  timeouts {
    create = "60m"
  }
}

locals {
  certificate_arn = coalesce(var.existing_certificate_arn, try(aws_acm_certificate_validation.app[0].certificate_arn, null))
}

# ---- Application Load Balancer ----------------------------------------------------
# Request (access and connection) logging is deliberately NOT enabled (ADR-040,
# finding F1). ALB access logs record full request URLs, and the emailed
# verification, password-reset and invitation links carry their single-use
# credentials in the query string, so such logs would hold bearer credentials.
# Observability comes from CloudWatch metrics and alarms and the containers'
# own logs (the API logs request paths without query strings). A future
# request-logging design needs its own credential-safe review.
resource "aws_lb" "app" {
  name                       = "${var.name_prefix}-alb"
  load_balancer_type         = "application"
  internal                   = false
  subnets                    = aws_subnet.public[*].id
  security_groups            = [aws_security_group.alb.id]
  drop_invalid_header_fields = true
  desync_mitigation_mode     = "strictest"
  idle_timeout               = 60
  enable_deletion_protection = false

  tags = { Name = "${var.name_prefix}-alb" }
}

# awsvpc task ENIs register by IP. /api/health crosses Next.js, its rewrite and
# the loopback API, so a target is healthy only when both containers are.
resource "aws_lb_target_group" "web" {
  name                 = "${var.name_prefix}-web"
  target_type          = "ip"
  protocol             = "HTTP"
  port                 = 3000
  vpc_id               = aws_vpc.demo.id
  deregistration_delay = 15

  health_check {
    path                = "/api/health"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = { Name = "${var.name_prefix}-web" }
}

resource "aws_lb_listener" "http" {
  count             = var.enable_cloudfront ? 0 : 1
  load_balancer_arn = aws_lb.app.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type = "redirect"
    redirect {
      protocol    = "HTTPS"
      port        = "443"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.app.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = local.certificate_arn

  # Response headers formerly added by Caddy (ADR-039), now set by the ALB.
  routing_http_response_strict_transport_security_header_value = "max-age=86400"
  routing_http_response_x_content_type_options_header_value    = "nosniff"
  routing_http_response_server_enabled                         = false

  # Without CloudFront: forward everything. With CloudFront: refuse requests that
  # lack the origin-verify header (a listener rule below forwards the rest).
  default_action {
    type             = var.enable_cloudfront ? "fixed-response" : "forward"
    target_group_arn = var.enable_cloudfront ? null : aws_lb_target_group.web.arn
    dynamic "fixed_response" {
      for_each = var.enable_cloudfront ? [1] : []
      content {
        content_type = "text/plain"
        message_body = "Forbidden"
        status_code  = "403"
      }
    }
  }
}

resource "aws_lb_listener_rule" "cloudfront_only" {
  count        = var.enable_cloudfront ? 1 : 0
  listener_arn = aws_lb_listener.https.arn
  priority     = 10
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
  condition {
    http_header {
      http_header_name = "X-StockWise-Origin-Verify"
      values           = [var.cloudfront_origin_secret]
    }
  }
  lifecycle {
    precondition {
      condition     = var.cloudfront_origin_secret != null
      error_message = "enable_cloudfront requires cloudfront_origin_secret."
    }
  }
}
