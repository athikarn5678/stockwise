---
status: accepted (2026-11-18, planner decision)
date: 2026-11-18
---

# ADR-049 — AI analysis page: persisted, bilingual runs

Numbering continues the global sequence (`ADR-001`…`ADR-048`). Plan: `docs/PLAN.md` M5-S2. Amends `ADR-046` (on-demand analysis v1): the endpoint, persistence and language handling change; provider, authorization, snapshot minimization and the output contract do not.

## Context and Problem Statement

`ADR-046` returned one language per click, stored nothing, and lived as a button inside the Analytics AI-insight card. Users want to switch language without waiting, keep earlier analyses, and have a page of their own, while Analytics keeps only the stored weekly/monthly reports.

## Decision Outcome

1. **Page.** New sidebar page `/app/ai-analysis` (OWNER, ADMIN, BRANCH_MANAGER with an assigned branch — the same permissions as the persisted insight reads). The Analyze button is removed from the Analytics AI-insight section.
2. **One click, two languages.** `POST /api/v1/organizations/{id}/ai-analysis/runs` (scope from the query, body `{days?: 7|14|30}` only) builds the snapshot once and calls the provider for Thai and English concurrently. Each language is validated separately with the `ADR-046` contract (exactly five headings, every number present in the snapshot). One click is one run for the limiter (1 per user per 60 s, process-local). The previous `POST …/ai-insights/analyze` endpoint is removed.
3. **Partial success.** If exactly one language passes, the run is stored with the other language empty and returned with `missing`; `POST …/ai-analysis/runs/{runId}/retry {language}` generates only that language for the stored period and counts as one limiter use. A retry for a language already stored returns the run without a provider call. If both languages fail nothing is stored (`502`).
4. **Persistence.** One additive forward migration: table `ai_analysis_runs` (organization, optional branch via the composite same-organization key, actor, days, local period, reporting timezone, `content_th`, `content_en`, model, timestamps). CHECKs: `days IN (7,14,30)`, `local_from < local_to`, at least one language present. Only runs that came from the provider are stored; the no-key mock sample is returned with `id: null` and never stored.
5. **History.** `GET …/ai-analysis/runs` (newest first, keyset cursor, scope exact: organization-scope runs and each branch's runs are separate lists) and `GET …/runs/{runId}` (authorized against the run's own stored scope; missing and unauthorized share one `404`). Everyone authorized for a scope sees that scope's runs. Opening an item needs no provider call. The actor id is stored but never returned.
6. **Authorization** is unchanged: the same three-permission `reader.authorize` runs before any snapshot, store or provider work, on every route.

## Consequences

- A retry rebuilds the snapshot for the stored period from live data, so a refund or edit made after the original run can make the two languages of one run differ slightly.
- Provider cost is two calls per click; the limiter still bounds one click per minute per user.
- Stored analyses are visible to everyone authorized for that scope; they contain aggregates only (`ADR-046` §3).
- No retention/deletion policy yet; rows are append-only apart from filling a missing language.
