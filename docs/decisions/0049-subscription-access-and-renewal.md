---
status: proposed (owner-specified in the 2026-11-18 sprint brief, task M6-S2; acceptance to be recorded by the planner)
date: 2026-11-18
---

# ADR-049 — Subscription access states, the central 402 guard and renewal

Plan: `docs/PLAN.md` M6 (sprint tasks M6-S2/M6-S3). Builds on `ADR-047` (hosted Checkout, test mode, no webhook); amends only the pieces named below.

## Context and Problem Statement

`ADR-047` stores a paid subscription but nothing reacts to the absence of one. The owner wants a 14-day trial, a read-only experience once access ends, and a renewal that can be rehearsed repeatedly on the deployed demo. The API, not the web, must enforce it (AGENTS.md §2.1, §10).

## Decision Outcome

1. **Three access states**, computed server-side by one pure function (`resolveSubscriptionAccess`):
   - `ACTIVE`: a stored subscription with status `ACTIVE` (or `PAST_DUE`, which is never written yet and has no grace policy).
   - `TRIAL`: no subscription row and the organization is under 14 days old (`organizations.created_at + 14 days`, exact 24 h days; `trialDaysLeft` rounds up).
   - `EXPIRED`: a stored row with status `EXPIRED` or `CANCELED`, or no row once the trial is over.
   A stored row always wins over the trial clock, so an explicit `EXPIRED` row ends access even inside the trial.
2. **One central guard** (`subscription-guard.ts`, mounted once in `main.ts` before every organization-scoped router). For `POST|PUT|PATCH|DELETE /organizations/:organizationId/...` of an EXPIRED organization it answers **`402 SUBSCRIPTION_REQUIRED` before any route handler runs**, so nothing is written. Reads are never blocked. Default-deny: every mutating route under that prefix is guarded unless listed in `SUBSCRIPTION_GUARD_EXEMPT_ROUTES`, which holds exactly `POST billing/checkout`, `POST billing/confirm` and `POST ai-insights/analyze`.
   - Mutating routes outside the prefix (auth, own profile, first-organization onboarding, invitation acceptance) are not touched. `subscription-guard.test.ts` scans every API source file for mutating route registrations and fails when one is neither under the guarded prefix nor explicitly classified, so a new route cannot bypass the guard unnoticed.
   - The guard authenticates first (anonymous callers get the normal `401`) and is silent for callers who are not ACTIVE members of an ACTIVE organization, so subscription state never leaks across tenants; the route then gives its own `403`/`404`.
   - The guard is mounted only while billing is enabled (`STRIPE_SECRET_KEY` present). Without a way to pay, an expired trial would lock an organization out for good; with billing disabled nothing is enforced and `GET …/billing` returns `access: null`.
3. **Checkout works from EXPIRED (and TRIAL).** `POST …/billing/checkout` is refused (`409 SUBSCRIPTION_EXISTS`) only while the stored subscription keeps access (`ACTIVE`/`PAST_DUE`). A successful `confirm` renews an `EXPIRED`/`CANCELED` row **in place** (new session, customer and subscription ids, new plan and interval) and sets it `ACTIVE` immediately; a live subscription is still never swapped, and re-confirming the same session stays idempotent.
4. **Monthly and yearly plans, server-owned prices** (THB, integer satang): Starter 199 / 1,990, Growth 499 / 4,990, Business 999 / 9,990. Checkout takes `{plan, interval: "MONTH"|"YEAR"}` (interval defaults to `MONTH`); confirm accepts a session only if `amount_total` equals the price of `metadata.plan` for `metadata.interval` (absent = monthly, for sessions created before this change). OWNER only (`billing.manage`) as before.
5. **Schema (additive, two forward migrations):** enum value `EXPIRED` on `subscription_status`; enum `subscription_interval` and column `organization_subscriptions.interval` (default `MONTH`); the three Stripe reference columns become nullable, with a CHECK that every status other than `EXPIRED` still carries all three ids. Unique indexes ignore NULLs.
6. **Renewal rehearsal operator command.** `expire-subscription` (ops task action; `apps/api/src/billing-ops`) sets **only** organization `ce295c46-a4a1-5930-ba4f-75739461072d` to `EXPIRED`, idempotently: an existing row keeps its plan and Stripe ids, with no row a Stripe-less `EXPIRED` row (plan `STARTER`) is created, and it refuses when that organization does not exist. It takes no arguments, so it cannot target another tenant. Run: `infra/learner-lab/operator/run-ops-task.sh expire-subscription`; success prints `STOCKWISE_SUBSCRIPTION:EXPIRED organization=… previous=<status|CREATED>`.

## Consequences

- Organizations whose `created_at` was back-dated (the synthetic demo datasets use a 30–90 day history window) have no trial left: unless they hold an ACTIVE subscription they are `EXPIRED` the moment billing is enabled. Demo organizations that must stay writable need a paid (test-mode) subscription or a different `created_at`; the demo seed tasks own that choice.
- Status still drifts from Stripe without webhooks (cancel, failed payment, period end): a paid subscription stays `ACTIVE` indefinitely. Deferred with the webhook slice, as in `ADR-047`.
- The guard runs the authentication middleware and one query on every guarded mutating request, and the route authenticates again (one extra session lookup).
- Deferred: grace period for `PAST_DUE`, plan limits and feature gates, Customer Portal, Enterprise, live mode.
