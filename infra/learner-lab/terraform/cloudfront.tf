# OPTIONAL CloudFront edge (enable_cloudfront). CloudFront is not in the Learner
# Lab service list, so it stays off until access is verified (ADR-040).
#
# Caching rule: only content-hashed, public, immutable Next.js build assets
# (/_next/static/*) are cached. Everything else (pages, /api/*, sessions,
# verification, OTP, invitations, password reset) uses CachingDisabled and
# forwards every header (including Host and Origin), cookie and query string,
# so no user-specific response is ever stored at the edge.
data "aws_cloudfront_cache_policy" "disabled" {
  count = var.enable_cloudfront ? 1 : 0
  name  = "Managed-CachingDisabled"
}

data "aws_cloudfront_cache_policy" "optimized" {
  count = var.enable_cloudfront ? 1 : 0
  name  = "Managed-CachingOptimized"
}

data "aws_cloudfront_origin_request_policy" "all_viewer" {
  count = var.enable_cloudfront ? 1 : 0
  name  = "Managed-AllViewer"
}

# Static assets: no cookies or query strings reach the origin; Host is forwarded
# so the ALB certificate (demo_hostname) still validates.
resource "aws_cloudfront_origin_request_policy" "static_assets" {
  count = var.enable_cloudfront ? 1 : 0
  name  = "${var.name_prefix}-static-assets"
  headers_config {
    header_behavior = "whitelist"
    headers {
      items = ["Host"]
    }
  }
  cookies_config {
    cookie_behavior = "none"
  }
  query_strings_config {
    query_string_behavior = "none"
  }
}

resource "aws_cloudfront_response_headers_policy" "security" {
  count = var.enable_cloudfront ? 1 : 0
  name  = "${var.name_prefix}-security-headers"
  security_headers_config {
    strict_transport_security {
      access_control_max_age_sec = 86400
      include_subdomains         = false
      override                   = true
    }
    content_type_options {
      override = true
    }
  }
}

resource "aws_cloudfront_distribution" "app" {
  count           = var.enable_cloudfront ? 1 : 0
  enabled         = true
  comment         = "StockWise Learner Lab demo (ADR-040)"
  aliases         = [var.demo_hostname]
  price_class     = "PriceClass_100"
  http_version    = "http2and3"
  is_ipv6_enabled = true

  origin {
    origin_id   = "alb"
    domain_name = aws_lb.app.dns_name
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
      origin_read_timeout    = 30
    }
    custom_header {
      name  = "X-StockWise-Origin-Verify"
      value = var.cloudfront_origin_secret
    }
  }

  default_cache_behavior {
    target_origin_id           = "alb"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = data.aws_cloudfront_cache_policy.disabled[0].id
    origin_request_policy_id   = data.aws_cloudfront_origin_request_policy.all_viewer[0].id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security[0].id
  }

  ordered_cache_behavior {
    path_pattern               = "/_next/static/*"
    target_origin_id           = "alb"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = data.aws_cloudfront_cache_policy.optimized[0].id
    origin_request_policy_id   = aws_cloudfront_origin_request_policy.static_assets[0].id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security[0].id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = local.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  lifecycle {
    precondition {
      condition     = var.cloudfront_origin_secret != null && var.region == "us-east-1"
      error_message = "enable_cloudfront requires cloudfront_origin_secret and region us-east-1."
    }
  }
}
