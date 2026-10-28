# syntax=docker/dockerfile:1
# StockWise Learner Lab demo images (ADR-040; ECS task definitions in
# infra/learner-lab/terraform/templates). Build context: repository root.
#   docker build -f infra/learner-lab/docker/Dockerfile --target web .
#   docker build -f infra/learner-lab/docker/Dockerfile --target api .
#   docker build -f infra/learner-lab/docker/Dockerfile --target ops .
# No secret is a build argument; STOCKWISE_API_ORIGIN is the fixed loopback
# origin of the API sidecar, validated by apps/web/src/environment.ts.

ARG NODE_IMAGE=node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20

# Amazon RDS CA bundle for sslmode=verify-full, pinned by checksum (the build
# fails closed if AWS publishes a new bundle; update the checksum deliberately).
FROM scratch AS rds-ca
ADD --checksum=sha256:90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b \
    --chmod=0644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /rds-global-bundle.pem

FROM ${NODE_IMAGE} AS base
# Prisma detects libssl through the openssl CLI to choose its schema engine.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV CI=1 \
    NEXT_TELEMETRY_DISABLED=1 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@11.19.0 --activate
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/

# ---- full build (dev dependencies) -------------------------------------------
FROM base AS build
RUN pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY apps/api apps/api
COPY apps/web apps/web
RUN pnpm --filter @stockwise/api build
ARG STOCKWISE_API_ORIGIN=http://127.0.0.1:3001
RUN STOCKWISE_API_ORIGIN=${STOCKWISE_API_ORIGIN} \
    pnpm --filter @stockwise/web exec next build --webpack \
 && rm -rf apps/web/.next/cache

# ---- production dependency trees ---------------------------------------------
FROM base AS api-production-deps
RUN pnpm install --frozen-lockfile --prod --filter @stockwise/api

FROM base AS web-production-deps
RUN pnpm install --frozen-lockfile --prod --filter @stockwise/web

FROM base AS ops-deps
# Includes the Prisma CLI (an API dev dependency) for `migrate deploy`.
RUN pnpm install --frozen-lockfile --filter @stockwise/api

# ---- api: Express + Native authentication (loopback 127.0.0.1:3001) -----------
FROM ${NODE_IMAGE} AS api
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=api-production-deps /repo/node_modules node_modules
COPY --from=api-production-deps /repo/apps/api/node_modules apps/api/node_modules
COPY --from=build /repo/apps/api/package.json apps/api/package.json
COPY --from=build /repo/apps/api/dist apps/api/dist
# The Native preflight verifies shipped migration checksums at startup.
COPY --from=build /repo/apps/api/prisma/migrations apps/api/prisma/migrations
COPY --from=rds-ca /rds-global-bundle.pem /etc/stockwise/rds-global-bundle.pem
COPY --chmod=0755 infra/learner-lab/docker/database-url.sh /usr/local/bin/stockwise-database-url
COPY infra/learner-lab/docker/redacting-log-pipe.mjs /usr/local/lib/stockwise/redacting-log-pipe.mjs
WORKDIR /repo/apps/api
USER node
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/bin/stockwise-database-url"]
# Log boundary (R2-F1): output reaches CloudWatch only after query strings and
# credential-shaped values are removed.
CMD ["node", "/usr/local/lib/stockwise/redacting-log-pipe.mjs", "node", "dist/main.js"]

# ---- ops: one-off ECS tasks (ops/ops-task.sh): role bootstrap, migrate deploy,
# grants, fence state, optional demo:seed, native:cutover, pg_dump export to S3.
FROM ${NODE_IMAGE} AS ops
ENV NODE_ENV=production
# psql/pg_dump 16 come from the PostgreSQL project's apt repository (pg_dump must
# not be older than the RDS 16 server), set up with the signing key that
# Debian's postgresql-common package ships; awscli writes exports to S3.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates postgresql-common \
 && /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y \
 && apt-get install -y --no-install-recommends postgresql-client-16 awscli \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
COPY --from=ops-deps /repo/node_modules node_modules
COPY --from=ops-deps /repo/apps/api/node_modules apps/api/node_modules
COPY --from=build /repo/apps/api/package.json apps/api/package.json
COPY --from=build /repo/apps/api/prisma.config.ts apps/api/prisma.config.ts
COPY --from=build /repo/apps/api/prisma apps/api/prisma
COPY --from=build /repo/apps/api/dist apps/api/dist
COPY --from=rds-ca /rds-global-bundle.pem /etc/stockwise/rds-global-bundle.pem
COPY infra/learner-lab/db/roles.sql infra/learner-lab/db/grants.sql /opt/stockwise/db/
COPY infra/learner-lab/ops/seed-through-loopback.mjs infra/learner-lab/ops/verified-postgres-forwarder.mjs /opt/stockwise/
COPY --chmod=0755 infra/learner-lab/ops/ops-task.sh /usr/local/bin/stockwise-ops
WORKDIR /repo/apps/api
USER node
ENTRYPOINT ["/usr/local/bin/stockwise-ops"]
CMD ["status"]

# ---- web: Next.js server on 0.0.0.0:3000 ---------------------------------------
FROM ${NODE_IMAGE} AS web
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    STOCKWISE_API_ORIGIN=http://127.0.0.1:3001
WORKDIR /repo
COPY --from=web-production-deps /repo/node_modules node_modules
COPY --from=web-production-deps /repo/apps/web/node_modules apps/web/node_modules
COPY --from=build /repo/apps/web/package.json apps/web/package.json
COPY --from=build /repo/apps/web/next.config.ts apps/web/next.config.ts
COPY --from=build /repo/apps/web/tsconfig.json apps/web/tsconfig.json
COPY --from=build /repo/apps/web/src apps/web/src
COPY --from=build /repo/apps/web/public apps/web/public
COPY infra/learner-lab/docker/redacting-log-pipe.mjs /usr/local/lib/stockwise/redacting-log-pipe.mjs
COPY --from=build --chown=node:node /repo/apps/web/.next apps/web/.next
WORKDIR /repo/apps/web
USER node
STOPSIGNAL SIGTERM
# Log boundary (R2-F1): Next.js proxy failures print the full upstream URL,
# including credentials carried in query strings; the pipe removes them before
# the output reaches CloudWatch.
ENTRYPOINT ["node", "/usr/local/lib/stockwise/redacting-log-pipe.mjs"]
CMD ["node", "node_modules/next/dist/bin/next", "start", "--hostname", "0.0.0.0", "--port", "3000"]
