# StockWise Plan

## Goal
Retail platform for SMEs: organization-level catalog and suppliers, branch inventory, purchasing, POS and sales, deterministic analytics and forecasting, AI business analysis. Scope and requirements: `BUILD_SPEC.md`; historical delivery order (Phases 1–8): `PROJECT_PLAN.md`. This file tracks post-Phase-7 work driven by the owner.

## Rules for every milestone
- A milestone that changes an accepted decision starts with an owner-approved ADR in `docs/decisions/` before code (AGENTS.md §16).
- Risky areas (auth/session, schema/migrations, money/payments, permissions) are executed or reviewed at Sonnet high.
- Done = `pnpm verify` + `pnpm build` pass, fresh-thread review vs this section + diff.

## Notes
- Deployment is deferred. The AWS Learner Lab topology (ADR-040) is no longer used; the target is the owner's own server behind a Cloudflare Tunnel (later ADR).
- Authentication (owner decision 2026-11-15): use Better Auth **Native**, the mode the AWS deployment used (`STOCKWISE_RUNTIME_ENV=production` + `STOCKWISE_AUTHENTICATION_AUTHORITY=native`, database sealed NATIVE by the one-way `native:cutover`). Local development currently runs Legacy (the default for development). Milestone M3 moves every runtime to Native and removes Legacy.
- Member re-invite is not needed: removed members are restored with Reactivate (Members page → "Include inactive" → member → "Reactivate with this access"). API and UI exist and their tests pass in `pnpm verify`.

## Milestones (in delivery order)

### M1 — Dependency security updates
`pnpm audit --prod` re-run 2026-11-15: 26 advisories (2 critical, 8 high, 13 moderate, 3 low), all in 7 packages. Compatible (minor/patch) upgrades only; no major bump is planned (AGENTS.md §12). Versions are pinned exactly (`saveExact`). The lockfile changes only through pnpm commands; transitive pins use the existing `overrides` block in `pnpm-workspace.yaml` (config edit, not a lockfile edit). No test/timeout changes.

Triage (T1). Reach: **R** = runtime-reachable in a deployed process; **D** = dev/build/test-only (appears in `--prod` only through better-auth peer deps or Prisma CLI).
| Package (adv. count, worst) | Current → target | Reach | Notes |
| --- | --- | --- | --- |
| next (3: 2 critical, 1 high) | 16.3.8 → 16.4.6 (web dep) and `@next/eslint-plugin-next` 16.3.8 → 16.4.6 (root dev) | R (web) | RCE in Image Optimization API and in `use cache`; DoS in Server Actions. Repo has no `use cache`/server actions; `next/image` appears in `brand-logo.tsx` (image optimizer exposure to be confirmed). Fix is `>=16.4.1`; 16.4.6 is the latest 16.x. `better-auth>next` is a peer and resolves to the same copy. Minor bump → needs `next build` + e2e. |
| zod (1 high) | direct 4.4.3 → 4.6.7 in api+web; better-auth's 4.6.5 → 4.6.7 via override | R (api+web) | Memory exhaustion on oversized constrained collections. Fix `>=4.6.6`. Same minor line as the current 4.6.5 already installed under better-auth. |
| body-parser (1 high) | 2.3.0 → 2.4.0 via override | R (api, via express 5.2.1) | DoS on trailing bytes. Express 5.2.1 allows `^2`; no express bump. |
| qs (1 moderate) | 6.16.0 → 6.16.1 (override value change `qs@6.15.3: 6.16.0` → new pin; express's range may need `qs@6.16.0: 6.16.1`) | R (api) | `qs.stringify` comma-array DoS; app only parses. |
| undici (8: 4 high, 4 moderate) | 8.10.2 → 8.12.4 via override (`undici@8.10.2: 8.12.4`) | D | Only path is `jsdom>undici` (web test env). |
| vite (6: 1 high, 4 moderate, 1 low) | 8.2.2 → 8.2.6 (patched ≥8.2.4, same 8.2 line) via override | D | Dev-server/launch-editor advisories; vite is only used by vitest. |
| @vitest/mocker (2 moderate) | 4.1.11 → 4.1.12 with `vitest` 4.1.11 → 4.1.12 (root dev) | D | Test-only. |
| fast-uri (4: 1+1 moderate, 2 low) | 3.1.8 → 3.1.9 via override (`fast-uri@3.1.5: 3.1.8` → 3.1.9) | D | Path: Prisma CLI `@prisma/dev>…>ajv`. Not in a runtime path. |

Open point for owner: better-auth 1.7.7 → 1.7.25 is NOT planned (auth is a risky area; overrides cover its zod/next/vite peers). Say so if you want it considered.

- E2E baseline (2026-11-16, found in M1-T2): unfiltered `pnpm test:e2e` fails on unmodified `main` (Playwright picks up vitest/node:test files and demo specs needing `DEMO30D_BROWSER_STATE`). Gate for M1 = `pnpm test:e2e "tests/e2e/[^/]+\.spec\.(ts|mts)$"` compared against `main`: main 34 failed / 130 passed of 169 (pos-scanner, form-layout, preferences, sale-receipt, etc.). A change passes if it adds no failing spec versus that set. M1-T2: 33 failed / 130 passed; M1-T3: 33 failed / 131 passed (branch 33 on both runs; flaky: `suppliers.spec.ts:23` failed on main only). No new failure on the branch. Fixing the e2e script/baseline is outside M1.
- [x] M1-T1 Triage advisories (runtime-reachable vs dev-only) and pick target versions — this table. Files: `docs/PLAN.md`. Acceptance: owner approves the table.
- [x] M1-T2 Upgrade next. Files: `apps/web/package.json` (next), `package.json` (`@next/eslint-plugin-next`), `pnpm-lock.yaml`; command `pnpm --filter @stockwise/web add --save-exact next@16.4.6` and `pnpm add -wD --save-exact @next/eslint-plugin-next@16.4.6`. Acceptance: Verify script, `pnpm build`, `pnpm test:e2e` pass; `pnpm audit --prod` shows no `next` advisory; `apps/web/next-env.d.ts` change not committed.
- [x] M1-T3 Upgrade remaining. Files: `apps/api/package.json` + `apps/web/package.json` (zod 4.6.7), `package.json` (vitest 4.1.12), `pnpm-workspace.yaml` (overrides: zod, body-parser, qs, undici, vite, fast-uri), `pnpm-lock.yaml`. Acceptance: Verify, `pnpm build`, `pnpm test:e2e` pass; audit shows none of zod/body-parser/qs/undici/vite/@vitest/mocker/fast-uri; no source or test edits.
- [x] M1-T4 Re-run `pnpm audit --prod` (and `--dev` for information); record any residual advisory and why accepted in this section. Files: `docs/PLAN.md`. Acceptance: 0 residual, or each residual listed with reach and reason.
  - Result (2026-11-16): `pnpm audit --prod` = **no known vulnerabilities** (was 26). M1-T2/T3 evidence: Verify 193 files / 2168 tests pass (one run hit a 5 s timeout in `database-harness.test.ts` under load; it passed 3/3 alone and in a full rerun; no test or timeout changed), `pnpm build` passes, filtered e2e adds no failure versus `main` (33 failed vs 34 on main, 169 specs).
  - Side effect of the vite override: transitive rolldown 1.2.5 → 1.2.19 and `@oxc-project/types` 0.146.0 → 0.156.0 (same minor); plus new transitive optional wasm packages `@emnapi/core@2.0.0-beta.2`, `@emnapi/runtime@2.0.0-beta.2`, `@emnapi/wasi-threads@2.2.0`, `@napi-rs/wasm-runtime@1.2.6`, `@tybys/wasm-util@0.10.4`. All dev/build-only.
  - Accepted residual (`pnpm audit`, incl. dev; 20 = 2 low, 12 moderate, 6 high): all dev/build-only, none shipped at runtime. 19 come from the `shadcn` 4.21.1 CLI (devDependency of `apps/web`, component scaffolding only): hono / @hono/node-server (MCP server code), undici 7.30.0, zod 3.25.76, systeminformation, ip-address, deepmerge. 1 is minimatch via `@eslint/js` / `@next/eslint-plugin-next` (lint-time). Fix path: upgrade `shadcn` when it ships patched transitive pins, or override later; not done here to avoid unrelated churn. Revisit at the next dependency review.
- Follow-up (separate task, not M1): fix `pnpm test:e2e` (it picks up vitest/node:test files and demo specs) and the 33 e2e failures present on both `main` and this branch (16 pos-scanner, plus form-layout, preferences, sale-receipt, application-shell, auth-verification, credential-link-entry and others).

### M2 — Keep the screen when the browser window loses focus
Problem (verified): `apps/web/src/providers/session-lifecycle-provider.tsx` calls `reset()` on `visibilitychange → hidden`, `pagehide` and `blur → focus`, which discards private TanStack Query data and bumps `generation`; the authenticated view remounts, shows the loading screen and loses unsaved form state. Deliberate safeguard (ADR-013/ADR-034); `refetchOnWindowFocus` is already `false`.
Outcome: returning to the tab keeps the screen and form state; the app silently revalidates `access-context` and resets only when actor, session or membership changed, or on a session-change hint/401.
- [ ] M2-T1 ADR: "revalidate on resume, reset only on change" with the security trade-off
- [ ] M2-T2 Implement silent revalidation; keep explicit session-change and 401 resets
- [ ] M2-T3 Tests: no remount/loading on focus/visibility; logout in another tab, actor switch and 401 still purge private data

### M3 — Better Auth Native everywhere (dev, test, own server)
Facts (verified): `better-auth` 1.7.7 is a dependency; the AWS task definition fixed `production` + `native`; the API refuses a database not sealed NATIVE; cutover is one-way (`native:cutover`, D5-P4 preflight). Docs still mark Native Live activation as not accepted, while GHCR images were built successfully on 2026-10-29/30 and the Cloudflare proxy section implies a live deployment — documentation status must be reconciled.
- [ ] M3-T1 Reconcile status docs (AGENTS.md, BETTER_AUTH_MIGRATION.md, infra README) with what was actually deployed
- [ ] M3-T2 ADR: Native is the only authority in every runtime (development, test, production); Legacy is removed (owner decision 2026-11-15)
- [ ] M3-T3 Dev setup: `STOCKWISE_BETTER_AUTH_SECRET` in `.env.example`; local dev and test databases are created NATIVE from migrations; the current empty local dev database is recreated, not converted (owner-approved 2026-11-15)
- [ ] M3-T4 Tests and e2e run against Native; verify passes
- [ ] M3-T5 Remove Legacy: legacy login/session/limiter code paths, the `legacy` authority value and its config, legacy-only tests. A fresh database starts NATIVE directly from migrations, with no cutover step (owner decision 2026-11-15); `native:cutover` is kept only if an existing LEGACY database still needs converting, otherwise removed
- [ ] M3-T6 Forward migration dropping legacy-only tables/columns after confirming no remaining reader (reviewed SQL, backup note; never edits applied migrations)
- [ ] M3-T7 Own-server runtime config (production + native) as part of the later deployment ADR

### M4 — 90-day demo dataset from one CLI command (from scratch)
Current state (verified): the dev database is empty after migrations. `demo:seed:30d` needs an existing organization/owner/supplier/VAT policy/branches/products, a Docker-attested disposable database and an explicit reference date.
Outcome: one command on an empty local database writes real rows into PostgreSQL through the production domain writers, so every feature (POS, inventory, purchasing, refunds, analytics, forecast, reorder, members, AI insights) works on it normally. It creates users for every role (OWNER, ADMIN, BRANCH_MANAGER, INVENTORY_STAFF, CASHIER), organization, branches, categories, products, suppliers, purchase orders/receipts, CASH/TRANSFER sales, refunds and adjustments covering every use case in `USE_CASE_SPECS.md`. History is 90 consecutive days ending on the run date; same seed → same logical data and amounts relative to the run date.
- [ ] M4-T1 ADR amending ADR-042 (from-scratch identity + 90 days, run-date anchored)
- [ ] M4-T2 Fixture generator: users/roles/org/branches/catalog/suppliers (demo passwords documented for local use only)
- [ ] M4-T3 90-day activity plan covering all use cases; reuse demo-30d runner/provenance
- [ ] M4-T4 Root command (e.g. `pnpm demo:seed`) + docs; refuses non-disposable databases
- [ ] M4-T5 Tests: determinism, rerun idempotency, use-case coverage checklist, analytics on seeded data
- [ ] M4-T6 (after M5) Load recorded AI analysis fixtures into the demo (no provider calls)

### M5 — AI business analysis v2 on OpenCode Go (design first)
Current flow (verified): deterministic analytics snapshot → prompt (`ai-summary-prompt.ts`) → OpenAI-style `chat/completions` to OpenRouter `openrouter/free` → plain prose (JSON output forbidden; forecast/reorder/inventory claims forbidden by ADR-033) → validated → stored in PostgreSQL → dashboard reads stored rows. No runtime trigger runs the orchestrator.
Outcome (owner-approved 2026-11-15), two report kinds, both stored in the database:
- **Scheduled analysis** (daily/weekly/monthly, completed periods): the 11 fixed sections below, returned as JSON validated by a Zod schema, rendered as section cards.
- **Today's brief** (on-demand button): today's intraday data so far → AI returns plain text in a separate "Today's brief" section. The input always contains: sales so far, transaction count and average ticket vs the same time yesterday; top 5 and bottom products today; refunds today; stock that fell to low/out today; per-branch totals (organization scope); open purchase orders due today. The text must cover each of these and end with up to 3 actions for the rest of the day.
- Provider is OpenCode Go (OpenAI-compatible base URL reported as `https://opencode.ai/zen/go/v1`, model configurable).
- [ ] M5-T1 ADR superseding ADR-033 parts: provider, sections/JSON schema, expanded snapshot (inventory/forecast/reorder inputs), data minimization, on-demand + schedule, who may trigger, rate/cost limits; confirm OpenCode Go terms allow app use
- [ ] M5-T2 Snapshot v2: add deterministic inputs for each section (no numbers invented by the model)
- [ ] M5-T3 Provider adapter for OpenCode Go + env names; keep `AiProvider` interface
- [ ] M5-T4 Prompt + Zod response schema; reject reports whose numbers are not in the snapshot
- [ ] M5-T5 Storage (forward migration, JSON report + version) and API read endpoints
- [ ] M5-T6 Triggers: scheduler (daily/weekly/monthly) in the API process with idempotent periods; "Today's brief" button for OWNER (organization scope) and BRANCH_MANAGER (assigned branch scope only); quota per role: OWNER 4 runs per organization-local day; BRANCH_MANAGER 4 runs per branch per day, shared by all managers of that branch (the organization may have several managers with different branches); at least 3 hours between runs within the same quota; enforced server-side; a generated brief is visible to every user of that role and scope
- [ ] M5-T7 UI: section cards, period picker, generating/failed states, TH/EN
- [ ] M5-T8 Record one real run per cadence on demo data as fixtures for M4-T6
- [ ] M5-T9 Tests with a fake provider: valid report, invalid JSON, hallucinated numbers rejected, timeout/401/429, schedule idempotency

#### M5 scheduled-analysis sections (approved; always present, "insufficient data" when empty)
1. Executive summary — 3–5 headline sentences plus the single most important action.
2. Sales performance — revenue, transactions, average ticket, change vs previous period; best/worst days.
3. Profit and margin — gross profit/margin where cost is known; products dragging margin; unknown-cost disclosure.
4. Products — top and bottom sellers, fast vs slow movers, products with no sales in the period.
5. Inventory health — low stock, overstock, dead stock, coverage classification (ADR-030).
6. Purchasing and reorder — reorder recommendations and late/partial receipts (ADR-032).
7. Forecast outlook — next-period demand from Forecasting V1 (ADR-031) with its accuracy.
8. Branch comparison — organization scope only; ranking and outliers.
9. Risks and anomalies — refund spikes, margin drops, unusual adjustments.
10. Recommended actions — 3–7 prioritized actions, each citing the metric keys it is based on.
11. Data quality — gaps, partial data, unknown costs.

### M6 — Stripe subscription billing (card only, test mode)
Prices follow the current pricing page (`apps/web/src/components/marketing/pricing-content.tsx`), THB. Approved by the owner 2026-11-15:
| Plan | Monthly | Yearly | Branches | Users | Feature gates |
|---|---|---|---|---|---|
| Starter | 199 | 1,990 | 1 | 3 | catalog, suppliers, inventory, receiving, POS, sales history, daily performance |
| Growth | 499 | 4,990 | 3 | 10 | + cross-branch analytics, role-based team, forecast and reorder |
| Business | 999 | 9,990 | 10 | 30 | + AI business analysis (M5) |
| Enterprise | contact sales | — | custom | custom | not sold through Stripe |
- New organizations get a 14-day Business trial; OWNER-only billing page; Stripe Checkout (subscription mode, card) + Customer Portal for change/cancel/payment method.
- Lapse policy: `past_due` → 7-day grace with a banner; after grace or `canceled` → read-only (view and history stay available; no new sales, receipts, adjustments, invites or branches); no data deletion. Plan limits are enforced on the API (branch/member creation, gated endpoints), not only in the UI.
- Test mode only: refuse `sk_live_`/`pk_live_` keys. Env names: `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`, plus one price ID per plan/period.
- [ ] M6-T1 ADR: plans, limits, trial, lapse policy, Stripe dependency review, env names, test-mode guard
- [ ] M6-T2 Schema/migration: organization subscription, Stripe customer/subscription IDs, webhook event log
- [ ] M6-T3 API: Checkout Session, Customer Portal session, signed idempotent webhook, entitlement service
- [ ] M6-T4 Enforce limits/gates in branch, member, analytics, forecast/reorder and AI endpoints
- [ ] M6-T5 Web: billing page, plan badge, trial/grace/read-only banners, success/cancel pages
- [ ] M6-T6 Tests: webhook signature required, duplicate events idempotent, non-OWNER denied, live key refused, limits and read-only enforced server-side

### M7 — Stripe at POS: card and PromptPay QR (test mode)
Facts: Stripe PromptPay one-time payments show a QR and have a test page to authorize/fail (needs a Thailand Stripe account, THB); card works with `4242 4242 4242 4242`. `PaymentMethod` is currently `CASH | TRANSFER`. Money rules: ADR-016/022/024/026/027.
Outcome: cashier takes a card or PromptPay QR payment; the sale completes and stock moves only after Stripe confirms via webhook, with server-recalculated totals.
- [ ] M7-T1 ADR: pending-payment sale state, stock commit timing, refunds through Stripe
- [ ] M7-T2 Schema/migration: payment method values, payment status, PaymentIntent reference
- [ ] M7-T3 API + webhook; M7-T4 POS UI (QR display, waiting, timeout/cancel)
- [ ] M7-T5 Tests: amount tampering, failed/expired QR leaves no sale or stock change, idempotent webhook

### M8 — README full setup guide (deferred by owner)
- [ ] M8-T1 README: prerequisites, `.env` (generated keys vs external services), Docker Postgres, migrate, demo seed, run, verify

## Open questions (owner)
- None open. Q1 (sections + Today's brief) and Q2 (plans, trial, lapse policy) approved 2026-11-15.
