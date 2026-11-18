# StockWise

StockWise is a retail platform for SMEs with organization-level catalog and
supplier management, branch inventory, purchasing, POS and sales, deterministic
analytics and forecasting, and scheduled aggregate AI summaries.

The repository is a pnpm workspace containing a Next.js web application and an
Express TypeScript modular monolith backed by PostgreSQL and Prisma.

## Start here

- [Documentation index](docs/README.md) — architecture, contracts, decisions, and development guides.
- [Build specification](BUILD_SPEC.md) — product scope, requirements, roles, and open questions.
- [Project plan](PROJECT_PLAN.md) — delivery order and current status.
- [Use cases](USE_CASE_SPECS.md) — behavior, alternative flows, and failures.
- [Developer guide](AGENTS.md#14-commands-and-environment-setup) — prerequisites, local setup, verified commands, and execution rules.

## Quick start (local)

Prerequisites: Node.js 24 LTS (minimum 24.21.0), pnpm 11.19.0 (`corepack enable`, then `corepack prepare pnpm@11.19.0 --activate`), Docker with Compose.

1. `pnpm install --frozen-lockfile`
2. `cp .env.example .env`, then fill it in. The file lists names and safe descriptions only; never commit a populated `.env`.
   - Generated locally (random values you create): `STOCKWISE_POSTGRES_USER`, `STOCKWISE_POSTGRES_PASSWORD`, `STOCKWISE_POSTGRES_DATABASE`, `STOCKWISE_POSTGRES_PORT`, `DATABASE_URL`, `TEST_DATABASE_URL`, `STOCKWISE_BETTER_AUTH_SECRET`, `STOCKWISE_ANALYTICS_CURSOR_HMAC_KEY`, `STOCKWISE_VERIFICATION_OTP_KEY`, `STOCKWISE_VERIFICATION_PROOF_KEY`, `STOCKWISE_INVITATION_CONTINUATION_KEY` (the `.env.example` comments say how long each must be).
   - External services (all optional locally): `RESEND_API_KEY` (email delivery), `OPENCODE_GO_API_KEY` (AI analysis; without it the page returns labelled mock text), `STRIPE_SECRET_KEY` (test mode `sk_test_` only; without it billing is hidden), `STOCKWISE_PROMPTPAY_ID` (10-digit mobile number; without it the POS PromptPay option is hidden).
3. Start PostgreSQL: `docker compose up --detach postgres`.
4. Apply migrations: `pnpm --filter @stockwise/api exec prisma migrate deploy --config prisma.config.ts`.
5. Optional demo data (a new, empty, disposable `*_demo` database only): follow [Demo data](docs/development/DEMO_DATA.md) (`pnpm demo:seed:90d`). It creates the "Siam Mart" organization, five role accounts and 72 stored AI reports.
6. Run: `pnpm dev:api` and `pnpm dev:web` in two terminals, then open http://localhost:3000.
7. Verify: `pnpm verify` (format, lint, strict typecheck, tests). `pnpm test:e2e` needs its own `_test` database and free ports 3000 and 3001; see [Local setup](docs/development/LOCAL_SETUP.md).

AWS Learner Lab demo: the operator runbook is [infra/learner-lab/RUNBOOK.md](infra/learner-lab/RUNBOOK.md), with the full reference in [infra/learner-lab/README.md](infra/learner-lab/README.md).

## Repository layout

| Path | Purpose |
| --- | --- |
| `apps/web/` | Next.js UI and application-local tests |
| `apps/api/` | Express modules, Prisma schema/migrations, and application-local tests |
| `docs/` | Canonical technical documentation |
| `test/` | Root tooling smoke test |
| `tests/e2e/` | Cross-application Playwright tests and fixtures |
| `infra/learner-lab/` | Terraform, operator scripts and runbook for the AWS Learner Lab demo (ADR-040) |
| `.github/workflows/` | CI quality gates and Learner Lab image builds |

Root configuration files own the workspace, local PostgreSQL Compose setup,
and shared build, formatting, linting, and test tooling. Generated outputs and
populated environment files are ignored. `infra/learner-lab/` holds the AWS Learner Lab
demo deployment; `packages/` is a reserved boundary and does not exist.

Task, evidence, audit, and acceptance records belong in the external StockWise
Obsidian project records; repository documentation follows the
[documentation location policy](AGENTS.md#documentation-location-policy).
