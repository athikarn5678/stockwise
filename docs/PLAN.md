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
`pnpm audit --prod` (2026-11-15): 26 advisories — 2 critical (next), 8 high (next, vite, zod, body-parser, undici). Upgrade within compatible ranges first; a major upgrade is its own task (AGENTS.md §12).
- [ ] M1-T1 Triage advisories (runtime-reachable vs dev-only) and pick target versions
- [ ] M1-T2 Upgrade next (+ `@next/eslint-plugin-next`); verify, build, e2e
- [ ] M1-T3 Upgrade remaining (vite, zod, body-parser via express, undici); verify, build, e2e
- [ ] M1-T4 Re-run audit; record accepted residual advisories

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
