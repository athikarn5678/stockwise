#!/usr/bin/env bash
# Copies CI-built images into the stack's ECR repositories by digest (ADR-040,
# OD-3). LabRole can only pull from ECR, so the operator pushes with the lab
# session credentials:
#   mirror-images.sh --web <ghcr ref@sha256> --api <ref@sha256> --ops <ref@sha256> --revision <git sha>
# Each source is copied unmodified with `docker buildx imagetools create`, and
# the ECR manifest digest must equal the source digest, or the script refuses.
# Writes .state/release-<revision>.env with the ECR digest references for
# deploy.sh. Image publication is an owner gate (G3): run only when authorized.
# shellcheck source-path=SCRIPTDIR source=common.sh
source "$(dirname "$0")/common.sh"
require_tools aws terraform docker
aws_region
require_lab_identity
ensure_state_dir

declare -A source_ref=()
revision=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --web | --api | --ops) source_ref[${1#--}]="${2:-}"; shift 2 ;;
    --revision) revision="${2:-}"; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || die "--revision must be the full 40-character commit SHA the images were built from"
for name in web api ops; do
  [[ "${source_ref[$name]:-}" =~ ^[a-z0-9.-]+(:[0-9]+)?/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$ ]] ||
    die "--${name} must be a digest reference (tags are refused)"
done

account="$(aws sts get-caller-identity --query Account --output text)"
registry="${account}.dkr.ecr.${AWS_REGION}.amazonaws.com"
prefix="$(tf_output name_prefix)"

step "logging Docker in to ECR (token piped, never printed)"
aws ecr get-login-password | docker login --username AWS --password-stdin "$registry" >/dev/null

release="${state_dir}/release-${revision}.env"
[[ ! -e "$release" ]] || die "${release} already exists"
tmp_release="$(mktemp "${state_dir}/release.XXXXXX")"
for name in web api ops; do
  source_digest="${source_ref[$name]##*@}"
  target="${registry}/${prefix}/${name}"
  # Immutable tags: a second copy of the same revision is refused by ECR.
  step "copying ${name} ${source_digest} -> ${target}:sha-${revision}"
  docker buildx imagetools create --tag "${target}:sha-${revision}" "${source_ref[$name]}" >/dev/null
  copied="$(docker buildx imagetools inspect "${target}:sha-${revision}" --format '{{json .Manifest.Digest}}' | tr -d '"')"
  [[ "$copied" == "$source_digest" ]] ||
    die "${name}: ECR digest ${copied} differs from source ${source_digest}; do not deploy this copy"
  printf '%s_IMAGE=%s@%s\n' "${name^^}" "$target" "$copied" >>"$tmp_release"
done
mv "$tmp_release" "$release"
docker logout "$registry" >/dev/null
step "release recorded in ${release}"
cat "$release"
