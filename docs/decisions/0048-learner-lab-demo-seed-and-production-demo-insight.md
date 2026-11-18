---
status: accepted
date: 2026-11-17
---

# ADR-048 — Learner Lab demo-database seed guard and Production Demo Insight allowlist

Owner decision, 2026-11-17 (24h sprint). Amends the "Demo30d seeding is disposable-local-only" and "Production rejects `STOCKWISE_DEMO_INSIGHT_ORGANIZATION_ID`" wording of `ADR-042` for the time-limited AWS Learner Lab demo only. `ADR-043` (operator-only `provision-demo`) is unchanged.

## Context and Problem Statement

`demo:seed:90d` (M4-S1) builds a complete synthetic demo from an empty database. Locally it is guarded by a Docker ownership receipt, which cannot exist inside an ECS ops task, so the old ops `seed` path could never pass its guard on AWS. Separately, `ADR-042` makes Demo Insight development/test only, so the Learner Lab app could not show the labelled sample text.

## Considered Options

1. Keep both restrictions: no seed and no Demo Insight on AWS. Rejected: the demo needs both.
2. Relax the receipt check generally. Rejected: it would weaken the local guard.
3. A second, narrower proof used only by the ops seed task, plus a one-organization production allowlist for Demo Insight (this ADR).

## Decision Outcome

Choose option 3.

### 1. Learner Lab demo-database seed guard

`verifyLearnerLabSeedTarget` (`apps/api/src/demo/demo-local-database.ts`) replaces the Docker receipt only when `STOCKWISE_DEMO_SEED_TARGET=learner-lab-ops`, which only `infra/learner-lab/ops/seed-through-loopback.mjs` sets. It requires all of: `STOCKWISE_OPS_ROLE=ops`; a non-production runtime; the loopback forwarder URL (`127.0.0.1`) to a `*_demo` database without a production/staging/live/test token; `current_database()` equal to the URL; and a database that is EMPTY or holds only the deterministic demo organization. Any other organization, user, product or sale refuses. The local Docker-receipt guard is unchanged for every other run.

The migrator role has no database-level `CREATE`, so `infra/learner-lab/db/roles.sql` pre-creates the `stockwise_demo` provenance schema owned by the migrator; `bootstrap-roles` must run before the first seed. All seeded rows are written by the OWNER demo user through the production domain writers.

### 2. Demo Insight in the production runtime

Demo Insight is served in `STOCKWISE_RUNTIME_ENV=production` only when `STOCKWISE_DEMO_INSIGHT_ORGANIZATION_ID` is set, the request's organization equals it, AND it equals the deterministic demo organization id (`DEMO_INSIGHT_PRODUCTION_ORGANIZATION_ID`, the `demo:seed:90d` organization). In production the organization-equality check runs before authorization (a non-member asking for another organization gets `404` rather than `403`). Everything else is unchanged: ordinary AI-summary authorization and trusted scope, the `ข้อมูลตัวอย่าง` / `Demo Insight` label, deterministic text from real metrics with the five fixed headings, no provider call, no AI report/attempt rows. If the variable is unset Demo Insight is off everywhere (no organization is served).

### Consequences

- A hosted database can be seeded without Docker, but only while it is empty or demo-only; a real tenant can never be touched.
- A mis-set variable cannot expose another tenant's data through Demo Insight.
- The reader still requires `COMPLETE` seed provenance with an unchanged business fingerprint (`ADR-042`), so any live write to the demo organization makes it fail closed (404). The runtime role also needs read access to `stockwise_demo.seed_runs` (infra follow-up owned by Worker C).

## Amendment 2026-11-18: stored seeded reports for the presentation

Owner decision 2026-11-18, M4-S3. The presentation must show a store that looks real, with reports the owner can open one by one. Therefore:

- `demo:seed:90d` now writes **stored** weekly and monthly reports at the end of the seed: `SUCCEEDED` `ai_insight_reports` with their immutable `analytics_snapshots`, for every Monday-Sunday week and every calendar month that lies fully inside the seed window, for the organization scope and for each branch scope. For a run on 2026-11-18 the window is 2026-08-01..2026-11-17 and the seed stores 15 weeks and 3 months over 4 scopes (60 weekly + 12 monthly = 72 reports). The window starts on the 1st day of the month three full calendar months before the run month and ends yesterday; today carries no seeded transaction.
- They use the existing snapshot and insight job pipeline with a deterministic seed-only provider (`seeded-template`, no network, no environment). The database row says `provider = "seeded-template"` truthfully; the UI never shows provider or model for stored reports. Reruns are idempotent and later POS activity never changes a stored report.
- The Analytics AI area offers only Weekly and Monthly (default Weekly) and a period picker over the stored reports of the selected scope. The `วิเคราะห์` on-demand button is unchanged.
- These stored reports **replace production Demo Insight for the presentation**. The Demo Insight reader and its fingerprint check are unchanged and stay available behind `STOCKWISE_DEMO_INSIGHT_ORGANIZATION_ID` (§2 above); with the variable unset the UI shows no Demo Insight card and no error. The stored reports carry no `ข้อมูลตัวอย่าง` label: removing the visible sample label is an owner decision.
- The seeded organization is shown as `Siam Mart` (deterministic id unchanged). User-visible seeded values (branches, products and SKUs, suppliers, user display names, purchase order and transfer references, adjustment notes, refund reason) carry no UAT/Demo wording. The legacy 30-day plan stays byte-identical and `verifyLearnerLabSeedTarget` accepts both the legacy and the presentation organization name with the deterministic id.

**Trade-off recorded:** the stored reports are deterministic template text computed from each period's own metrics, not AI output. They are real stored rows produced by the real pipeline, but nobody should present them as model-generated analysis; the live OpenRouter path remains the only source of genuinely AI-generated reports.

