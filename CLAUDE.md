@AGENTS.md

# Claude-only rules

Shared project rules live in AGENTS.md (read by Pi and Claude). Rules below add to them and never loosen them.

## Risky areas (use Sonnet high or ask first)
- Auth/session/permissions (`apps/api` auth modules, Better Auth migration)
- Prisma schema and migrations (`apps/api/prisma/`) — review migration SQL before applying
- Stock-ledger, money, tenant/branch isolation invariants (AGENTS.md §16)
- `.env*`, secrets, CI workflows (`.github/workflows/`)

## Review checklist
- Diff stays inside the task scope (AGENTS.md §15–16); no unrelated formatting or lockfile churn
- Re-run `pnpm verify` and read the diff; never trust a child report alone
- Migrations/schema changes match the Source of Truth docs; docs and plan status updated together
- No secrets, no Claude attribution in commits/PRs; no commit unless asked

## Workflow
- ADRs: `docs/decisions/` (this repo's layout; no `docs/adr/`). Plan: `docs/PLAN.md`.
- Branches `feat|fix|chore/M<n>-T<k>-<slug>`; Conventional Commits with task ID; never commit to `main`.
