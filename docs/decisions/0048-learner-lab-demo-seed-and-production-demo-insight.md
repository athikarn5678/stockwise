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
