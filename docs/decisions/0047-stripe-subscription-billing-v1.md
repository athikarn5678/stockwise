---
status: proposed
date: 2026-11-17
---

# ADR-047 — Stripe subscription billing v1 (hosted Checkout, test mode, card, no webhook)

Numbering continues the global sequence (`ADR-001`…`ADR-046`). Plan: `docs/PLAN.md` M6. This ADR covers only the minimal first slice (sprint task M6-S1); the full M6 plan (trial, lapse policy, limits, Customer Portal, signed webhook) is deferred and will be a later ADR.

## Context and Problem Statement

The owner wants a working subscription flow for the Starter, Growth and Business plans (199 / 499 / 999 THB per month, from `apps/web/src/components/marketing/pricing-content.tsx`) that can be demonstrated end to end, while staying easy to change later. Money, permission and schema rules apply (AGENTS.md §16).

## Decision Outcome

1. **Hosted Stripe Checkout, subscription mode, THB, monthly, card.** The API creates a Checkout Session through Stripe's REST API with `fetch` (no SDK, no new dependency), inline `price_data` (no Stripe Price objects), `client_reference_id` = Organization id, and a `success_url` containing the literal `{CHECKOUT_SESSION_ID}`. `payment_method_types` is not sent: current Stripe API versions reject it (verified live); card is the method enabled in the Stripe Dashboard payment-method settings.
2. **Test mode only.** `STRIPE_SECRET_KEY` must match `sk_test_…`: the API refuses to start with any other value (message never echoes it), `createStripeClient` throws for any other key, session ids must be `cs_test_…`, and a response with `livemode: true` is never accepted. Absent key = the feature is hidden (`GET …/billing` returns `enabled:false`, other billing routes `404`).
3. **OWNER-only management.** New fixed permission `billing.manage` (OWNER, organization scope) in `authorization-policy.ts`. Any active verified member may read the current plan (shown as a badge); only OWNER can create a Checkout Session or confirm one. The API is the boundary; the web page merely hides controls.
4. **Server-owned prices.** Amounts are integer satang (`19900`/`49900`/`99900`) in `billing-plans.ts`; the browser sends only the plan name. The success/cancel URL origin is `STOCKWISE_PUBLIC_WEB_ORIGIN`, never request data.
5. **Confirm endpoint instead of a webhook.** After Stripe redirects back, `POST …/billing/confirm {sessionId}` retrieves the session server-side and persists only if: `status = complete`, `payment_status = paid`, `mode = subscription`, `client_reference_id` and `metadata.organization_id` equal the caller's Organization, `currency = thb`, and `amount_total` equals the plan price for `metadata.plan`; customer and subscription ids must be present. Another Organization's session is refused (`403`); an unpaid/incomplete one is `409 CHECKOUT_NOT_COMPLETE`.
6. **Persistence.** One forward, additive migration: enums `subscription_plan`, `subscription_status` and table `organization_subscriptions` (one row per Organization; unique Organization, subscription id and checkout session id; CHECKs pin the `cus_`/`sub_`/`cs_test_` prefixes; restrictive FK). Re-confirming the same session is idempotent; a different session never overwrites an existing subscription (`409`), and Checkout is refused while a stored subscription exists, so StockWise never holds two rows or silently swaps plans. Only status `ACTIVE` is ever written in this slice.
7. **Deferred (explicit non-goals):** webhooks (so cancellation/failed payment never changes status), plan limits and feature gating, Customer Portal, plan change/cancel, yearly billing, trial, Enterprise, live mode.

## Consequences

- A paid subscription exists only after an OWNER returns from Stripe and the server verifies the session; a closed tab before the redirect leaves a paid Stripe subscription with no StockWise row until the OWNER reopens the success link (no webhook yet). Acceptable for test mode; a signed idempotent webhook is the planned fix.
- Double charging is not fully prevented: the guard is the stored row, which is written only at confirm. An OWNER who pays one Checkout and leaves without confirming (or opens two Checkouts in two tabs) can create a second live Stripe subscription in test mode; the second confirm returns `409` but Stripe still holds both. Deferred to the webhook/portal slice.
- Status can drift from Stripe (cancel/past due) until webhooks exist.
- `STRIPE_PUBLISHABLE_KEY` is documented but unused (hosted Checkout needs only the secret key).
- Learner Lab grants already give `stockwise_app` DML on new tables; no infra change.
