#!/usr/bin/env bash
# Verifies one database export end to end before anything destructive may run
# (ADR-040; finding F2). Fails closed on the first unmet condition.
#   verify-export.sh <export-task-log> <expected-database> <expected-export-id> <expected-bucket> <download-dir>
#
#   1. the task log holds exactly one STOCKWISE_EXPORT_RESULT:v1 marker, bound
#      to the expected export id, database and bucket;
#   2. its object key is exactly exports/<database>/<UTC timestamp>-<export id>.dump;
#   3. the S3 object's sha256 metadata equals the marker;
#   4. exactly that object is downloaded to <download-dir> (a new file);
#   5. the file is non-empty and matches the marker's size and SHA-256;
#   6. pg_restore 16 (pinned image, no network) lists the archive, and its
#      header names the expected database with the expected core tables.
# On success writes <file>.verified and prints STOCKWISE_EXPORT_VERIFIED.
# shellcheck source-path=SCRIPTDIR source=common.sh
source "$(dirname "$0")/common.sh"
require_tools aws terraform docker sha256sum
aws_region
# Standalone entry point: verify the identity itself, whoever the caller is (R2-F3).
require_lab_identity

readonly postgres_image="postgres:16.15-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea"
[[ $# == 5 ]] || die "usage: verify-export.sh <task-log> <database> <export-id> <bucket> <download-dir>"
log="$1" database="$2" export_id="$3" bucket="$4" download_dir="$5"
[[ "$database" =~ ^[a-z][a-z0-9_]*_demo$ ]] || die "unexpected database name"
[[ "$export_id" =~ ^[a-z0-9-]{8,64}$ ]] || die "unexpected export id"
[[ -r "$log" ]] || die "export task log is missing"

markers="$(grep -c '^STOCKWISE_EXPORT_RESULT:v1 ' "$log" || true)"
[[ "$markers" == 1 ]] || die "expected exactly one export result marker, found ${markers}"
marker="$(grep '^STOCKWISE_EXPORT_RESULT:v1 ' "$log" | tr -d '\r')"
pattern='^STOCKWISE_EXPORT_RESULT:v1 export_id=([a-z0-9-]+) database=([a-z0-9_]+) bucket=([a-z0-9.-]+) key=([A-Za-z0-9/_.-]+) bytes=([0-9]+) sha256=([0-9a-f]{64})$'
[[ "$marker" =~ $pattern ]] || die "the export result marker is malformed"
m_id="${BASH_REMATCH[1]}" m_database="${BASH_REMATCH[2]}" m_bucket="${BASH_REMATCH[3]}"
m_key="${BASH_REMATCH[4]}" m_bytes="${BASH_REMATCH[5]}" m_sha="${BASH_REMATCH[6]}"
[[ "$m_id" == "$export_id" ]] || die "the marker belongs to another export operation"
[[ "$m_database" == "$database" ]] || die "the marker names database ${m_database}, expected ${database}"
[[ "$m_bucket" == "$bucket" ]] || die "the marker names another bucket"
[[ "$m_key" =~ ^exports/${database}/[0-9]{8}T[0-9]{6}Z-${export_id}\.dump$ ]] ||
  die "the marker's object key is not this export's object"
[[ "$m_bytes" -gt 0 ]] || die "the export is empty"

object_sha="$(aws s3api head-object --bucket "$bucket" --key "$m_key" --query 'Metadata.sha256' --output text | tr -d '\r')" ||
  die "the export object does not exist in S3"
[[ "$object_sha" == "$m_sha" ]] || die "the S3 object's checksum metadata differs from the marker"

mkdir -p "$download_dir"
file="${download_dir}/$(basename "$m_key")"
[[ ! -e "$file" ]] || die "${file} already exists; refusing to overwrite evidence"
aws s3api get-object --bucket "$bucket" --key "$m_key" "$(native_path "$file")" >/dev/null ||
  die "downloading the export failed"
[[ -s "$file" ]] || die "the downloaded export is missing or empty"
actual_bytes="$(wc -c <"$file" | tr -d ' ')"
[[ "$actual_bytes" == "$m_bytes" ]] || die "the downloaded export has ${actual_bytes} bytes, expected ${m_bytes}"
actual_sha="$(sha256sum "$file" | cut -d' ' -f1)"
[[ "$actual_sha" == "$m_sha" ]] || die "the downloaded export's SHA-256 differs from the marker"

listing="$(docker run --rm -i --network none "$postgres_image" pg_restore --list <"$file" 2>&1 | tr -d '\r')" ||
  die "pg_restore cannot read the archive"
grep -qE "^;[[:space:]]+dbname: ${database}\$" <<<"$listing" || die "the archive was taken from another database"
for table in users native_auth_transition _prisma_migrations; do
  grep -qE "TABLE public ${table}( |\$)" <<<"$listing" || die "the archive lacks table ${table}"
done

{
  echo "export_id=${export_id}"
  echo "database=${database}"
  echo "object=s3://${bucket}/${m_key}"
  echo "bytes=${actual_bytes}"
  echo "sha256=${actual_sha}"
  echo "pg_restore_entries=$(grep -c '^[0-9]' <<<"$listing")"
  echo "verified_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} >"${file}.verified"
echo "STOCKWISE_EXPORT_VERIFIED: s3://${bucket}/${m_key} ${actual_bytes} bytes sha256 ${actual_sha} -> ${file}"
