#!/usr/bin/env bash
# Creates the private exports bucket if it does not exist (ADR-040). Run once
# after the first (targeted) apply and before the full apply:
#   ensure-exports-bucket.sh
# Terraform reads this bucket as a data source and manages its versioning,
# encryption, public-access block and policy (storage.tf). The bucket is created
# here because the Learner Lab service control policy denies the object-lock
# read that the aws_s3_bucket resource performs. Idempotent; nothing is printed
# except the bucket name.
# shellcheck source-path=SCRIPTDIR source=common.sh
source "$(dirname "$0")/common.sh"
require_tools aws terraform
aws_region
require_lab_identity

prefix="$(tf_output name_prefix)"
account="$(tf_output account_id)"
bucket="${prefix}-exports-${account}-${AWS_REGION}"
if aws s3api head-bucket --bucket "$bucket" >/dev/null 2>&1; then
  step "exports bucket ${bucket} already exists; unchanged"
  exit 0
fi
if [[ "$AWS_REGION" == us-east-1 ]]; then
  aws s3api create-bucket --bucket "$bucket" >/dev/null
else
  aws s3api create-bucket --bucket "$bucket" \
    --create-bucket-configuration "LocationConstraint=${AWS_REGION}" >/dev/null
fi
# Tags let teardown's residual check find it; a tagging refusal is not fatal.
aws s3api put-bucket-tagging --bucket "$bucket" \
  --tagging 'TagSet=[{Key=Project,Value=stockwise},{Key=Name,Value=exports}]' >/dev/null 2>&1 ||
  step "bucket tagging was refused; continuing"
step "exports bucket ${bucket} created"
