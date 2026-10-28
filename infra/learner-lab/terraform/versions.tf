terraform {
  # 1.11+: write-only arguments (the optional write-only RDS master password).
  required_version = ">= 1.11.0, < 2.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # Local state on the operator machine (never committed; see .gitignore).
  # Secret values never pass through Terraform: Secrets Manager secrets are
  # created empty and filled by operator/put-secrets.sh, and the RDS master
  # password is RDS-managed (or write-only in the fallback mode).
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project     = "stockwise"
      Environment = "learner-lab-demo"
      ManagedBy   = "terraform"
      Decision    = "ADR-040"
    }
  }
}

data "aws_caller_identity" "current" {}

data "aws_partition" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  # Learner Lab forbids creating IAM roles; these pre-created ones are referenced
  # by ARN so Terraform makes no IAM API call at all (zero aws_iam_* resources).
  lab_role_arn             = "arn:${data.aws_partition.current.partition}:iam::${local.account_id}:role/${var.lab_role_name}"
  lab_instance_profile_arn = "arn:${data.aws_partition.current.partition}:iam::${local.account_id}:instance-profile/${var.lab_instance_profile_name}"
}
