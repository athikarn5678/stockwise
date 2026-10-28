# ---- account and naming -------------------------------------------------------

variable "region" {
  description = "Learner Lab permits us-east-1 and us-west-2 only. CloudFront needs us-east-1."
  type        = string
  default     = "us-east-1"
  validation {
    condition     = contains(["us-east-1", "us-west-2"], var.region)
    error_message = "Learner Lab allows only us-east-1 and us-west-2."
  }
}

variable "name_prefix" {
  type    = string
  default = "stockwise-demo"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,20}$", var.name_prefix))
    error_message = "name_prefix must be 3-21 lowercase letters, digits or hyphens."
  }
}

variable "lab_role_name" {
  description = "Pre-created Learner Lab role used as the ECS task execution role (and the export task role)."
  type        = string
  default     = "LabRole"
}

variable "lab_instance_profile_name" {
  description = "Pre-created Learner Lab instance profile for the ECS container instances."
  type        = string
  default     = "LabInstanceProfile"
}

# ---- public endpoint ------------------------------------------------------------

variable "demo_hostname" {
  description = "Public demo hostname (D-06). Without CloudFront, a DNS CNAME points it at the ALB; with CloudFront, at the distribution."
  type        = string
  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", var.demo_hostname))
    error_message = "demo_hostname must be a lowercase DNS name."
  }
}

variable "enable_cloudfront" {
  description = "CloudFront in front of the ALB. CloudFront is NOT in the Learner Lab service list: enable only after access is verified and the origin-secret design is approved (cloudfront_secret_in_state_approved)."
  type        = bool
  default     = false
  validation {
    condition     = !var.enable_cloudfront || var.cloudfront_secret_in_state_approved
    error_message = "CloudFront is gated (finding F4): its origin secret would be stored in plaintext in Terraform state. Enable only after the owner approves that design (cloudfront_secret_in_state_approved = true) or a secret-free alternative."
  }
}

variable "cloudfront_origin_secret" {
  description = <<-EOT
    With CloudFront only: the X-StockWise-Origin-Verify header value the ALB
    requires (32-128 base64url characters). Terraform stores it in PLAINTEXT in
    state (both the CloudFront custom header and the ALB rule condition), which
    `sensitive` does not prevent (finding F4). Must stay null while CloudFront is
    disabled, so the default configuration never persists it.
  EOT
  type        = string
  default     = null
  sensitive   = true
  validation {
    condition     = var.cloudfront_origin_secret == null || can(regex("^[A-Za-z0-9_-]{32,128}$", var.cloudfront_origin_secret))
    error_message = "cloudfront_origin_secret must be 32-128 base64url characters."
  }
  validation {
    condition     = var.cloudfront_origin_secret == null || var.enable_cloudfront
    error_message = "cloudfront_origin_secret must be unset while CloudFront is disabled."
  }
}

variable "cloudfront_secret_in_state_approved" {
  description = <<-EOT
    Fail-closed gate for enable_cloudfront (finding F4). Set true only after the
    owner explicitly approves the CloudFront origin-protection design, with its
    known limitation that the origin secret is stored in plaintext in the
    operator's local Terraform state, or approves a design without a shared
    secret (for example CloudFront VPC origins with an internal ALB).
  EOT
  type        = bool
  default     = false
}

variable "existing_certificate_arn" {
  description = "Optional already-issued ACM certificate (same region; us-east-1 with CloudFront) covering demo_hostname. Otherwise one is requested with DNS validation."
  type        = string
  default     = null
}

variable "allowed_ingress_ipv4_cidrs" {
  description = "Sources allowed to reach the ALB when CloudFront is disabled."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

# ---- application --------------------------------------------------------------

variable "email_from" {
  description = "STOCKWISE_EMAIL_FROM, a sender on the Resend-verified domain (D-09), e.g. StockWise Demo <noreply@demo.example.com>."
  type        = string
  validation {
    condition     = length(var.email_from) > 3 && !can(regex("[\"\\\\\\n]", var.email_from))
    error_message = "email_from must not contain double quotes, backslashes or newlines."
  }
}

variable "web_image" {
  description = "Web image by digest: <registry>/<repository>@sha256:<64 hex>. Required for the full apply."
  type        = string
  default     = null
  validation {
    condition     = var.web_image == null || can(regex("^[a-z0-9.-]+(:[0-9]+)?/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$", var.web_image))
    error_message = "web_image must be a digest reference (tags are refused)."
  }
}

variable "api_image" {
  description = "API image by digest."
  type        = string
  default     = null
  validation {
    condition     = var.api_image == null || can(regex("^[a-z0-9.-]+(:[0-9]+)?/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$", var.api_image))
    error_message = "api_image must be a digest reference (tags are refused)."
  }
}

variable "ops_image" {
  description = "Ops image by digest (migrations, grants, cutover, seed, export)."
  type        = string
  default     = null
  validation {
    condition     = var.ops_image == null || can(regex("^[a-z0-9.-]+(:[0-9]+)?/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$", var.ops_image))
    error_message = "ops_image must be a digest reference (tags are refused)."
  }
}

variable "app_desired_count" {
  description = <<-EOT
    Running application tasks: 0 until the database is sealed NATIVE, then 1.
    Capped at 1: the login/password-proof credential-failure limiter and its
    per-email serialization are process-local (ADR-040), so a second replica would
    multiply that budget. Raising it needs a shared limiter and an owner decision.
  EOT
  type        = number
  default     = 0
  validation {
    condition     = contains([0, 1], var.app_desired_count)
    error_message = "app_desired_count must be 0 or 1 while authentication limiters are process-local."
  }
}

# ---- compute --------------------------------------------------------------------

variable "instance_type" {
  description = "ECS container instance type. Learner Lab allows nano through large."
  type        = string
  default     = "t3.small"
  validation {
    condition     = can(regex("^t3\\.(small|medium|large)$", var.instance_type))
    error_message = "Use t3.small, t3.medium or t3.large (x86_64 images; 2 GiB is the minimum that fits the task)."
  }
}

variable "asg_min_size" {
  description = "Container instances kept running, one per Availability Zone."
  type        = number
  default     = 2
  validation {
    condition     = var.asg_min_size >= 0 && var.asg_min_size <= 3
    error_message = "asg_min_size must be 0-3."
  }
}

variable "asg_max_size" {
  description = "Upper bound for ECS managed scaling. Learner Lab: max 9 running instances per region; 20 deactivates the account."
  type        = number
  default     = 3
  validation {
    condition     = var.asg_max_size >= var.asg_min_size && var.asg_max_size <= 4
    error_message = "asg_max_size must be between asg_min_size and 4."
  }
}

variable "root_volume_gb" {
  description = "gp3 root volume per container instance (the ECS-optimized AL2023 AMI needs 30 GB)."
  type        = number
  default     = 30
  validation {
    condition     = var.root_volume_gb >= 30 && var.root_volume_gb <= 100
    error_message = "root_volume_gb must be 30-100 (Learner Lab EBS limit is 100 GB)."
  }
}

variable "ecs_ami_parameter" {
  description = "Public SSM parameter holding the ECS-optimized Amazon Linux 2023 AMI id."
  type        = string
  default     = "/aws/service/ecs/optimized-ami/amazon-linux-2023/recommended/image_id"
}

variable "enable_container_insights" {
  type    = bool
  default = true
}

# ---- network --------------------------------------------------------------------

variable "vpc_cidr" {
  type    = string
  default = "10.40.0.0/16"
}

# ---- database -------------------------------------------------------------------

variable "db_name" {
  description = "Must end in _demo so the optional seeder accepts it; no hyphens."
  type        = string
  default     = "stockwise_demo"
  validation {
    condition     = can(regex("^[a-z][a-z0-9_]*_demo$", var.db_name))
    error_message = "db_name must match ^[a-z][a-z0-9_]*_demo$."
  }
}

variable "db_master_username" {
  type    = string
  default = "stockwise_master"
}

variable "db_master_password_mode" {
  description = <<-EOT
    secrets_manager: RDS generates and stores the master password in Secrets Manager
    (manage_master_user_password). write_only: fallback if Learner Lab refuses that;
    supply TF_VAR_db_master_password (never stored in state) and store the same value
    with operator/put-secrets.sh --master-password.
  EOT
  type        = string
  default     = "secrets_manager"
  validation {
    condition     = contains(["secrets_manager", "write_only"], var.db_master_password_mode)
    error_message = "db_master_password_mode must be secrets_manager or write_only."
  }
}

variable "db_master_password" {
  description = "Only for db_master_password_mode = write_only: 24-128 base64url characters, write-only."
  type        = string
  default     = null
  sensitive   = true
  ephemeral   = true
  validation {
    condition     = var.db_master_password == null || can(regex("^[A-Za-z0-9_-]{24,128}$", var.db_master_password))
    error_message = "db_master_password must be 24-128 base64url characters."
  }
}

variable "db_master_password_version" {
  description = "write_only mode: increment to push a new db_master_password."
  type        = number
  default     = 1
}

variable "db_instance_class" {
  description = "Learner Lab RDS allows nano through medium burstable classes."
  type        = string
  default     = "db.t4g.micro"
  validation {
    condition     = can(regex("^db\\.t(3|4g)\\.(micro|small|medium)$", var.db_instance_class))
    error_message = "db_instance_class must be db.t3/db.t4g micro, small or medium."
  }
}

variable "db_engine_version" {
  description = "PostgreSQL major version."
  type        = string
  default     = "16"
}

variable "db_allocated_storage_gb" {
  type    = number
  default = 20
  validation {
    condition     = var.db_allocated_storage_gb >= 20 && var.db_allocated_storage_gb <= 100
    error_message = "Learner Lab RDS gp2 storage is limited to 100 GB."
  }
}

variable "db_backup_retention_days" {
  type    = number
  default = 1
  validation {
    condition     = var.db_backup_retention_days >= 1 && var.db_backup_retention_days <= 7
    error_message = "db_backup_retention_days must be 1-7."
  }
}

variable "db_deletion_protection" {
  description = "operator/teardown.sh sets false in a targeted apply immediately before destroy."
  type        = bool
  default     = true
}

# ---- storage, observability and budget guard -------------------------------------

variable "exports_force_destroy" {
  description = "Allow terraform destroy to delete stored database exports. operator/teardown.sh sets true only after downloading them."
  type        = bool
  default     = false
}

variable "log_retention_days" {
  type    = number
  default = 7
}

variable "alarm_email" {
  description = "Optional e-mail for SNS alarm notifications (AWS sends a confirmation message). Null: alarms are visible in the console only."
  type        = string
  default     = null
}

variable "demo_end_time" {
  description = "Planning deadline (ADR-040 OD-5: 2026-10-31 23:59 Asia/Bangkok). An ASG scheduled action scales the container instances to zero then; it is a backstop, not teardown. Must be in the future at apply time."
  type        = string
  default     = "2026-10-31T16:59:00Z"
  validation {
    condition     = can(formatdate("YYYY", var.demo_end_time)) && endswith(var.demo_end_time, "Z")
    error_message = "demo_end_time must be an RFC 3339 UTC timestamp ending in Z."
  }
}

variable "enable_aws_budget" {
  description = "Create an AWS Budgets cost alert (Budgets access in Learner Lab is unverified)."
  type        = bool
  default     = false
}

variable "budget_limit_usd" {
  type    = number
  default = 25
}

variable "budget_email" {
  type    = string
  default = null
}
