resource "aws_db_subnet_group" "demo" {
  name       = "${var.name_prefix}-db"
  subnet_ids = aws_subnet.data[*].id
  tags       = { Name = "${var.name_prefix}-db" }
}

resource "aws_db_parameter_group" "demo" {
  name   = "${var.name_prefix}-postgres${var.db_engine_version}"
  family = "postgres${var.db_engine_version}"

  # Clients verify the RDS CA (sslmode=verify-full); plaintext is refused.
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
  parameter {
    name  = "log_min_duration_statement"
    value = "1000"
  }
  parameter {
    name  = "log_connections"
    value = "1"
  }
}

# Pre-created so retention applies and terraform destroy removes it.
resource "aws_cloudwatch_log_group" "rds" {
  name              = "/aws/rds/instance/${var.name_prefix}-postgres/postgresql"
  retention_in_days = var.log_retention_days
}

# Multi-AZ DB instance: synchronous standby in the second AZ, automatic failover.
resource "aws_db_instance" "demo" {
  identifier     = "${var.name_prefix}-postgres"
  engine         = "postgres"
  engine_version = var.db_engine_version
  instance_class = var.db_instance_class

  allocated_storage = var.db_allocated_storage_gb
  storage_type      = "gp2"
  storage_encrypted = true

  db_name  = var.db_name
  username = var.db_master_username
  # Default: RDS creates the password and keeps it in a Secrets Manager secret
  # it owns. Fallback: a write-only password that never enters state.
  manage_master_user_password = var.db_master_password_mode == "secrets_manager" ? true : null
  password_wo                 = var.db_master_password_mode == "write_only" ? var.db_master_password : null
  password_wo_version         = var.db_master_password_mode == "write_only" ? var.db_master_password_version : null

  multi_az               = true
  db_subnet_group_name   = aws_db_subnet_group.demo.name
  vpc_security_group_ids = [aws_security_group.db.id]
  parameter_group_name   = aws_db_parameter_group.demo.name
  publicly_accessible    = false

  backup_retention_period    = var.db_backup_retention_days
  backup_window              = "17:00-18:00"
  maintenance_window         = "sun:18:30-sun:19:30"
  auto_minor_version_upgrade = true
  apply_immediately          = true
  deletion_protection        = var.db_deletion_protection
  # The lab account is disposable; operator/teardown.sh downloads a logical
  # export from S3 before destroy instead of keeping a billed final snapshot.
  skip_final_snapshot = true

  enabled_cloudwatch_logs_exports = ["postgresql"]
  # Learner Lab: enhanced monitoring is not supported.
  monitoring_interval          = 0
  performance_insights_enabled = false

  tags       = { Name = "${var.name_prefix}-postgres" }
  depends_on = [aws_cloudwatch_log_group.rds]

  lifecycle {
    # RDS chooses and upgrades the 16.x minor version.
    ignore_changes = [engine_version]
    precondition {
      condition     = var.db_master_password_mode == "secrets_manager" || var.db_master_password != null
      error_message = "db_master_password_mode = write_only requires TF_VAR_db_master_password."
    }
  }
}
