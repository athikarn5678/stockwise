# ---- Secrets Manager -------------------------------------------------------------
# Created EMPTY: operator/put-secrets.sh generates and stores every value with
# put-secret-value, so no secret ever passes through Terraform or its state.
# ECS injects individual JSON keys into containers at task start (LabRole as the
# execution role); an unset key stops the task before the application starts.
#   application  application keys and the Resend API key   -> api container
#   database     stockwise_app / stockwise_migrator passwords, demo-user password
#   master       only in the write_only fallback (RDS otherwise owns the secret)
resource "aws_secretsmanager_secret" "application" {
  name                    = "${var.name_prefix}/application"
  description             = "StockWise demo application keys and RESEND_API_KEY (values set by operator/put-secrets.sh)"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret" "database" {
  name                    = "${var.name_prefix}/database"
  description             = "StockWise demo database role passwords (values set by operator/put-secrets.sh)"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret" "master" {
  count                   = var.db_master_password_mode == "write_only" ? 1 : 0
  name                    = "${var.name_prefix}/master"
  description             = "RDS master credentials for the write_only fallback (set by operator/put-secrets.sh)"
  recovery_window_in_days = 0
}

locals {
  master_secret_arn = (var.db_master_password_mode == "secrets_manager"
    ? aws_db_instance.demo.master_user_secret[0].secret_arn
  : aws_secretsmanager_secret.master[0].arn)
}

# ---- ECR -----------------------------------------------------------------------
# operator/mirror-images.sh copies the CI-built GHCR images here by digest
# (LabRole can pull from ECR; the console user pushes).
resource "aws_ecr_repository" "image" {
  for_each             = toset(["web", "api", "ops"])
  name                 = "${var.name_prefix}/${each.key}"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = true # images are reproducible from CI
  image_scanning_configuration {
    scan_on_push = true
  }
  encryption_configuration {
    encryption_type = "AES256"
  }
}

resource "aws_ecr_lifecycle_policy" "image" {
  for_each   = aws_ecr_repository.image
  repository = each.value.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the five most recent images (current and rollback releases)"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 5 }
      action       = { type = "expire" }
    }]
  })
}

# ---- S3: database exports ----------------------------------------------------------
# Logical pg_dump exports written by the ops-export task (pre-demo baseline,
# before risky operations, before teardown); teardown.sh downloads them first.
resource "aws_s3_bucket" "exports" {
  bucket        = "${var.name_prefix}-exports-${local.account_id}-${var.region}"
  force_destroy = var.exports_force_destroy
  tags          = { Name = "${var.name_prefix}-exports" }
}

resource "aws_s3_bucket_public_access_block" "exports" {
  bucket                  = aws_s3_bucket.exports.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "exports" {
  bucket = aws_s3_bucket.exports.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "exports" {
  bucket = aws_s3_bucket.exports.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "exports" {
  bucket = aws_s3_bucket.exports.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "aws:kms" # AWS managed key aws/s3
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "exports" {
  bucket = aws_s3_bucket.exports.id
  rule {
    id     = "expire-old-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = 7
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
  depends_on = [aws_s3_bucket_versioning.exports]
}

data "aws_iam_policy_document" "exports" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.exports.arn, "${aws_s3_bucket.exports.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "exports" {
  bucket     = aws_s3_bucket.exports.id
  policy     = data.aws_iam_policy_document.exports.json
  depends_on = [aws_s3_bucket_public_access_block.exports]
}
