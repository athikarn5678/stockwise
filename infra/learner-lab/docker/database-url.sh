#!/bin/sh
# API container entrypoint (ADR-040). ECS injects the runtime role's password
# from Secrets Manager as STOCKWISE_DB_PASSWORD and the non-secret endpoint as
# STOCKWISE_DB_*; this composes the DATABASE_URL the API validates, removes the
# separate password variable and execs the command. Prints no value.
set -eu

refuse() {
  echo "STOCKWISE_REFUSED: $1" >&2
  exit 64
}

if [ -z "${DATABASE_URL:-}" ]; then
  for name in STOCKWISE_DB_HOST STOCKWISE_DB_PORT STOCKWISE_DB_NAME STOCKWISE_DB_USER STOCKWISE_DB_PASSWORD; do
    eval "value=\${${name}:-}"
    [ -n "$value" ] || refuse "${name} is not set"
  done
  case "$STOCKWISE_DB_HOST" in *[!a-z0-9.-]*) refuse "STOCKWISE_DB_HOST has an unsupported shape" ;; esac
  case "$STOCKWISE_DB_PORT" in *[!0-9]*) refuse "STOCKWISE_DB_PORT must be numeric" ;; esac
  case "$STOCKWISE_DB_NAME$STOCKWISE_DB_USER" in *[!a-z0-9_]*) refuse "database or user name has an unsupported shape" ;; esac
  # Concatenated into the URL without escaping, so it must be base64url.
  case "$STOCKWISE_DB_PASSWORD" in *[!A-Za-z0-9_-]*) refuse "database password must be base64url" ;; esac
  [ "${#STOCKWISE_DB_PASSWORD}" -ge 24 ] && [ "${#STOCKWISE_DB_PASSWORD}" -le 128 ] ||
    refuse "database password must be 24-128 characters"
  # node-postgres verifies the RDS CA supplied through NODE_EXTRA_CA_CERTS.
  DATABASE_URL="postgresql://${STOCKWISE_DB_USER}:${STOCKWISE_DB_PASSWORD}@${STOCKWISE_DB_HOST}:${STOCKWISE_DB_PORT}/${STOCKWISE_DB_NAME}?sslmode=verify-full"
  export DATABASE_URL
fi
unset STOCKWISE_DB_PASSWORD
exec "$@"
