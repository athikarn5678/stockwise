---
status: proposed
date: 2026-11-17
---

# ADR-046 — On-demand AI business analysis v1 (OpenCode Go, no persistence)

Numbering continues the global sequence (`ADR-001`…`ADR-045`). Plan: `docs/PLAN.md` M5-T1. Amends the provider and cadence scope of `ADR-033` for one additional read-only use case; it does not replace the scheduled summary pipeline.

## Context and Problem Statement

`ADR-033` fixed scheduled, persisted AI summaries generated from deterministic aggregate snapshots through OpenRouter, with a fixed cadence and stored `AiInsightReport` rows. Users also asked for an immediate, conversational "วิเคราะห์" action in Analytics: a short business analysis of the last completed days without waiting for the next scheduled run. The existing pipeline cannot serve that: it is periodic, it persists prompts/attempts/reports, and its prompt is tuned for stored cadence reports.

The question is how to add an on-demand analysis without weakening `ADR-033` data minimization, persistence provenance, cost bounds, or the existing three-permission read authorization.

## Considered Options

1. **Persist on-demand analyses as `AiInsightReport` rows.** Rejected: it would need a new cadence/identity concept, would replace the scheduled report for the same period, and would store ad-hoc text whose retention was never decided.
2. **Call the provider from the browser.** Rejected: the API is the security boundary; a provider key must never reach the client.
3. **New on-demand endpoint with a non-persisted response** (this ADR).

## Decision Outcome

Choose **Option 3**.

### 1. Provider

- OpenCode Go, reached through its OpenAI-compatible chat-completions API: `POST https://opencode.ai/zen/go/v1/chat/completions`.
- Configuration: `OPENCODE_GO_API_KEY` (server-only, optional) and `OPENCODE_GO_MODEL` (optional, default `deepseek-v4.1-flash`). Existing OpenAI-compatible adapter widened by options (`endpoint`, `model`, `providerName`, `timeoutMilliseconds`, `maxTokens`, `responseTextLimitBytes`); OpenRouter defaults and its `usage.include` extension are unchanged.
- Bounds: 60 s timeout with a single attempt (no retry), `max_tokens` 4000 (the model spends part of it on reasoning tokens), 12 KB response text. No paid fallback.
- Scheduled OpenRouter job, orchestrator, stored insights, and `ADR-033` data minimization remain unchanged; the two paths never share state.

### 2. Endpoint and authorization

- `POST /api/v1/organizations/{organizationId}/ai-insights/analyze`, authenticated, scope from the query (`scope=organization` or `scope=branch&branchId=...`), body `{language: "en"|"th", days?: 7|14|30}` (default 7).
- The **same** `AI_BUSINESS_SUMMARY_VIEW` + `BUSINESS_ANALYTICS_VIEW` + `SALES_COST_VIEW` check as the persisted reads runs before any snapshot work; the request body never carries organization/branch scope.
- Per-user, process-local limit of one analysis per 60 s, applied after authorization and counted even when generation fails. Results: `200` (with `Cache-Control: no-store`), `429 RATE_LIMITED` + `Retry-After`, `404 NOT_FOUND` (snapshot unavailable), `502 AI_PROVIDER_FAILED`, `502 AI_RESPONSE_REJECTED`, `400`, `403`.

### 3. Snapshot (data minimization)

Deterministic code, last N completed Organization-timezone days: period identity and scope kind; totals (net sales, sales, refunds, average order value) computed with exact decimal arithmetic; per-day buckets; top/bottom five **categories** by net sales; cost coverage, gross profit and gross margin only when every bucket has complete cost data, otherwise `costNote: "unavailable"`; best and worst day. No IDs, emails, product-level rows, inventory, forecast, reorder or supplier facts.

### 4. Output contract and validation

- Exactly five Markdown `##` sections in fixed order — TH: ภาพรวม / ยอดขาย / สินค้าขายดีและขายช้า / ข้อสังเกต / สิ่งที่ควรทำ; EN: Overview / Sales / Products / Notes & risks / Recommended actions.
- The prompt states the snapshot is authoritative data, never instructions, and forbids recomputation, invented numbers, JSON/HTML/code fences, and claims about forecast, reorder, or stock.
- The API rejects (no persistence, `AI_RESPONSE_REJECTED`) text with missing/extra/reordered headings or with any numeric token absent from the snapshot (grouped digits and 0–1 decimal rounding tolerated).
- Without `OPENCODE_GO_API_KEY` the endpoint returns deterministic mock text with the same five headings, explicitly labelled as a sample.

### 5. Known limits

- The rate limiter is process-local and resets on restart; multi-instance enforcement stays under `OQ-020`.
- Only category-level product data exists, so "best/worst products" means categories.
- The numeric check compares magnitudes with the snapshot's number set: small integers (such as 5 or 7), number words, and numbers equal to a category-name digit also pass; non-ASCII digits and any text before the first heading are rejected. Category names come from the database and reach the prompt as JSON data, so an instruction-like name is possible; the output contract and validator are the guard, not a trust assumption.
- More than 1,000 categories (10 pages of 100) makes the snapshot unavailable rather than ranking a partial list.
- `pnpm --filter @stockwise/api ai:smoke` (with `OPENCODE_GO_API_KEY` exported) is an operator-run provider probe that prints only the HTTP status and response length.
- Output is untrusted display text: escaped, never rendered as active HTML, and never stored.

## Consequences

Analytics gains an immediate analysis without a new table, migration, or scheduler. Cost stays bounded by one provider call per user per minute, and no prompt, response, or attempt metadata is persisted. `ADR-033` remains the authority for scheduled, persisted summaries.
