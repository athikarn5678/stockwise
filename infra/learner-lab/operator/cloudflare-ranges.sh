#!/usr/bin/env bash
# Prints the official Cloudflare IPv4 ranges as the Terraform variable the ALB
# security group uses behind the Cloudflare proxy. Read-only: it changes nothing.
#   operator/cloudflare-ranges.sh            # print
# Refresh (Cloudflare changes ranges rarely; check before each release): put the
# printed lines into demo.tfvars, then run the normal release, or
#   terraform apply -refresh=false -var-file=demo.tfvars -target=aws_vpc_security_group_ingress_rule.alb_https
# The ALB is IPv4-only, so the IPv6 ranges are not needed.
set -euo pipefail
ranges="$(curl -fsS https://www.cloudflare.com/ips-v4)"
[[ "$(wc -l <<<"$ranges")" -ge 10 ]] || { echo "unexpected Cloudflare response" >&2; exit 1; }
# Port 443 and port 80 (the ALB listener only redirects HTTP to HTTPS) are both
# opened to the Cloudflare ranges: Cloudflare forwards plain-HTTP visitors to the
# origin on port 80, and a closed port makes http:// hang until Cloudflare
# reports an origin timeout (found 2026-11-17 by smoke.sh).
emit() {
  printf '%s = [\n' "$1"
  while IFS= read -r cidr; do
    [[ "$cidr" =~ ^[0-9.]+/[0-9]+$ ]] || { echo "unexpected range: $cidr" >&2; exit 1; }
    printf '  "%s",\n' "$cidr"
  done <<<"$ranges"
  printf ']\n'
}
emit allowed_ingress_ipv4_cidrs
emit allowed_http_ingress_ipv4_cidrs
