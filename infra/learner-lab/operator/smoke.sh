#!/usr/bin/env bash
# Post-deploy smoke over the public HTTPS origin (ADR-040). Uses no credential
# and creates no account; safe to run at any time while the stack is up.
#   smoke.sh
# shellcheck source-path=SCRIPTDIR source=common.sh
source "$(dirname "$0")/common.sh"
require_tools terraform curl

origin="$(tf_output public_origin)"
curl_options=(--silent --show-error --max-time 15)
failed=0
record() {
  echo "STOCKWISE_SMOKE:$1:$2"
  [[ "$2" == PASS* ]] || failed=1
}
status_of() { curl "${curl_options[@]}" --output /dev/null --write-out '%{http_code}' "$@" || echo 000; }
expect() {
  local label="$1" expected="$2" status
  shift 2
  status="$(status_of "$@")"
  if [[ "$status" == "$expected" ]]; then record "$label" "PASS:${status}"; else record "$label" "FAIL:${status}"; fi
}
header() {
  if grep -qi "$2" <<<"$headers"; then record "$1" PASS; else record "$1" FAIL; fi
}

# Health retries (default 30 x 5 s); the operator regression tests use 1.
attempts="${STOCKWISE_SMOKE_ATTEMPTS:-30}"
[[ "$attempts" =~ ^[1-9][0-9]?$ ]] || die "STOCKWISE_SMOKE_ATTEMPTS must be 1-99"
for _ in $(seq 1 "$attempts"); do
  [[ "$(status_of "${origin}/api/health")" == 200 ]] && break
  sleep 5
done
expect health 200 "${origin}/api/health"
expect home 200 "${origin}/"
expect login-page 200 "${origin}/login"
expect anonymous-access-context 401 "${origin}/api/v1/me/access-context"
# A cross-origin credential POST is refused before any account lookup.
expect cross-origin-login-refused 403 -X POST -H "content-type: application/json" \
  -H "origin: https://cross-origin.invalid" --data '{"email":"smoke@example.invalid","password":"x"}' \
  "${origin}/api/v1/auth/login"

headers="$(curl "${curl_options[@]}" --head "${origin}/" | tr -d '\r')"
header hsts '^strict-transport-security: max-age='
header nosniff '^x-content-type-options: nosniff'

if [[ "$(tf_output cloudfront_enabled)" == "true" ]]; then
  # The ALB accepts only CloudFront origin-facing addresses: a direct request
  # from here must fail to connect or be refused.
  status="$(curl --silent --max-time 10 --insecure --output /dev/null --write-out '%{http_code}' \
    "https://$(tf_output alb_dns_name)/api/health" || true)"
  if [[ "$status" == 000 || "$status" == 403 ]]; then
    record alb-direct-blocked "PASS:${status}"
  else
    record alb-direct-blocked "FAIL:${status}"
  fi
else
  host="${origin#https://}"
  expect http-redirects-to-https 301 "http://${host}/login"
fi

[[ "$failed" == 0 ]] || die "smoke failed"
echo "STOCKWISE_SMOKE:PASS"
