# StockWise Architecture Decision Log

| Field | Value |
| --- | --- |
| Status | Accepted decision history |
| Baseline | Architecture Freeze v1 |
| Last updated | 2026-10-12 |

## 1. Log rules

- This file records why durable decisions were made and their consequences.
- Current product/system definitions remain in their topic-owned Source of Truth documents.
- Do not rewrite an accepted ADR to hide a later change. Add a new ADR, mark the old one `Superseded by ADR-*`, and update every affected current document in the same change.
- Open Questions are tracked only in `BUILD_SPEC.md`; an unresolved question is not an ADR.
- Status values: `Accepted`, `Superseded`, `Deprecated`, `Proposed`.

## ADR-001 — Use Express.js and TypeScript instead of FastAPI/Python

- **Date:** 2026-08-21
- **Status:** Accepted
- **Type:** Architecture

### Context

An earlier direction considered Python/FastAPI because analytics and machine-learning experiments were expected to be a central backend responsibility. The current product boundary changed: deterministic analytics and forecasting are application/database logic, while the external LLM only summarizes precomputed aggregates. A Python ML service is not required now.

### Alternatives considered

1. FastAPI/Python for the entire backend
2. TypeScript backend plus a separate Python analytics/ML service
3. Express.js + TypeScript backend, with PostgreSQL/TypeScript analytics

### Decision

Use **Express.js + TypeScript** for the backend. Use Next.js + TypeScript for the frontend. Do not use FastAPI, Python, or a separate ML service in the current baseline.

### Why selected

- One primary language reduces tooling, deployment, validation, and maintenance overhead.
- The current analytics/forecast scope does not justify Python-specific runtime complexity.
- Express is sufficient for the REST/application workload and allows explicit modular boundaries.
- It avoids authentication, networking, logging, and versioning between two backends.

### Consequences

- Analytics and Forecasting V1 must be implementable/testable in TypeScript and SQL.
- A future Python service requires measured need and a superseding ADR.
- Express provides less opinionated structure, so `AGENTS.md` and architecture rules must enforce thin controllers, domain modules, validation, and error handling.

## ADR-002 — Start with a modular monolith

- **Date:** 2026-08-21
- **Status:** Accepted
- **Type:** Architecture

### Context

StockWise has several domains but a small project/team and multiple workflows requiring strong database transactions. Independent deployment/ownership needs have not been demonstrated.

### Alternatives considered

1. Unstructured monolith
2. Modular monolith
3. Microservices from the start

### Decision

Build one Express deployable as a **modular monolith** with explicit identity, tenancy, catalog, inventory, purchasing, sales, analytics, and AI-insight boundaries.

### Why selected

- Minimizes operational and distributed-system overhead.
- Supports atomic checkout and receiving in one PostgreSQL transaction.
- Keeps domain boundaries reviewable without premature service extraction.
- Fits incremental MVP delivery.

### Consequences

- Modules cannot freely import one another's internals.
- Cross-domain workflows use explicit application contracts/use cases.
- No internal HTTP calls between modules.
- Microservices require evidence such as independent scaling/deployment/team ownership and a superseding ADR.

## ADR-003 — Model tenancy as Organization -> Branch

- **Date:** 2026-08-21
- **Status:** Accepted
- **Type:** Product and architecture

### Context

The target includes both small shops and SME retailers with multiple branches. Adding branches later would force changes to ownership, authorization, inventory, sales, purchasing, and analytics.

### Alternatives considered

1. Single-store system with branch added later
2. One account/database per branch
3. Organization tenant with branch operational scopes

### Decision

Use this hierarchy from the beginning:

```text
Organization (tenant)
  -> Branch (operation)
```

- Products, categories, and suppliers are organization-level.
- Inventory, sales/POS, purchase orders, and receiving are branch-level.
- A user can access multiple branches through organization and/or branch memberships.
- Authorization is RBAC plus branch scope.

### Why selected

- Matches real multi-branch ownership without separate accounts.
- Allows organization-wide catalog governance and branch-specific operational stock/sales.
- Prevents a later tenancy retrofit across every domain.

### Consequences

- Every business query must be tenant-scoped; branch operations also verify branch scope.
- `user.branchId` alone is an invalid complete membership model.
- Cross-tenant references must be prevented by scoped queries and data constraints.
- Organization analytics can aggregate only authorized branches.
- The fixed MVP RBAC and branch-assignment rules are defined by `ADR-016`.

## ADR-004 — Use PostgreSQL with Prisma

- **Date:** 2026-08-21
- **Status:** Accepted
- **Type:** Architecture and implementation baseline

### Context

StockWise needs relational ownership, uniqueness, referential integrity, precise money, transactions, concurrency controls, historical ledgers, and analytical SQL.

### Alternatives considered

1. PostgreSQL + Prisma
2. MySQL or another relational database
3. Document/NoSQL primary database
4. Multiple databases per domain

### Decision

Use **PostgreSQL** as the single primary system of record and **Prisma** for TypeScript data access and forward migrations.

### Why selected

- ACID transactions support checkout and receiving invariants.
- Relational constraints match organization/branch/resource ownership.
- `NUMERIC` supports precise monetary values.
- PostgreSQL query/index capabilities support operational access and analytics.
- Prisma aligns with the TypeScript stack and provides a reviewable schema/migration workflow.

### Consequences

- Database constraints remain necessary even with Zod/Prisma validation.
- Concurrency-sensitive flows may need explicit PostgreSQL locking/SQL behavior beyond simple ORM CRUD.
- Generated migrations require SQL review; applied migrations are not rewritten.
- Production uses Amazon RDS for PostgreSQL under ADR-009.

## ADR-005 — Use an inventory ledger plus current balance projection

- **Date:** 2026-08-21
- **Status:** Accepted
- **Type:** Data architecture

### Context

A single mutable product stock number cannot explain changes, reconcile errors, or support safe purchasing/sales history. Reads also need a fast current balance.

### Alternatives considered

1. Store only `product.stock`
2. Derive current stock by summing the full ledger on every request
3. Append-oriented transaction ledger plus transactionally maintained balance

### Decision

Use `InventoryTransaction` as the traceable movement history and `InventoryBalance` as the current branch/product projection. Every stock mutation writes both atomically.

### Why selected

- Provides a reason/source for each change.
- Keeps current stock reads efficient.
- Supports reconciliation, audit investigation, and compensating corrections.
- Works with atomic checkout and receiving.

### Consequences

- Direct/unexplained balance overwrites are prohibited.
- Corrections append compensating movements rather than edit/delete ledger history.
- Concurrency and reconciliation tests are mandatory.
- `ADR-024` resolves negative-stock behavior; transfer/refund movement lifecycles remain unresolved.

## ADR-006 — Compute analytics and forecasts in TypeScript/SQL

- **Date:** 2026-08-21
- **Status:** Accepted
- **Type:** Architecture

### Context

Analytics values must be reproducible, testable, tenant-scoped, and explainable. Asking an LLM to derive values would make results non-deterministic and unsafe. A separate Python service is not justified for Forecasting V1.

### Alternatives considered

1. Let an LLM calculate analytics/forecast values
2. Build a Python/ML service now
3. Calculate accepted formulas using PostgreSQL SQL and TypeScript

### Decision

Use PostgreSQL SQL and TypeScript for metrics, period comparisons, classifications, forecasting, evaluation, and reorder recommendations. `docs/contracts/ANALYTICS.md` is the sole formula contract.

### Why selected

- Results are deterministic and fixture-testable.
- Queries can enforce tenant/branch scope close to data.
- Avoids a second runtime/service before its value is proven.
- Keeps model/metric versions and inputs explainable.

### Consequences

- `ADR-029` later closes exact Analytics V1 formulas in `OQ-011`; `ADR-031`
  subsequently resolves `OQ-012` for Forecasting V1.
- Forecast experiments compare a named baseline using accepted reproducible metrics.
- Introducing Python/ML later requires measured improvement and a superseding ADR.

## ADR-007 — Use OpenRouter only for scheduled aggregate summaries

- **Date:** 2026-08-21
- **Status:** Accepted
- **Type:** Product, architecture, and security

### Context

Owners benefit from a plain-language explanation of many analytics outputs, but per-page or per-user generation is costly, slow, inconsistent, and unnecessary. The LLM must not be numerical truth or receive sensitive raw data.

### Alternatives considered

1. No LLM
2. On-demand chatbot/report generation
3. LLM as forecast/recommendation engine
4. Scheduled summary of precomputed aggregate snapshots

### Decision

Use **OpenRouter API** only to summarize versioned aggregate analytics snapshots on **daily, weekly, monthly, and yearly** schedules. Persist results; dashboards read stored content. Do not call OpenRouter on page views or user actions.

### Why selected

- Separates deterministic business truth from probabilistic language generation.
- Controls cost/rate and avoids repeated calls on dashboard traffic.
- Enables reviewable data minimization.
- Core retail operations remain available during provider outage.

### Consequences

- Snapshot, prompt, provider/model, and output provenance are versioned.
- No customer/employee personal data or raw transaction rows are sent.
- Provider failure produces a safe failed/stale state and never blocks operational workflows.
- EventBridge is the production schedule trigger; `ADR-033` closes the V1 timing and provider policy in `OQ-017`/`OQ-018`.
- OpenRouter is not a forecast engine, arithmetic service, database client, stock decision maker, or real-time chatbot.

## ADR-008 — Use versioned REST APIs

- **Date:** 2026-08-21
- **Status:** Accepted
- **Type:** Architecture

### Context

The Next.js client needs an explicit boundary to the Express backend. The domain is resource/action oriented, and no need for GraphQL complexity has been demonstrated.

### Alternatives considered

1. REST
2. GraphQL
3. Direct server/database coupling from the web app

### Decision

Use JSON REST endpoints under `/api/v1`, validated with Zod and protected by server-side authentication, RBAC, and tenant/branch scope.

### Why selected

- Clear HTTP/resource semantics and straightforward testing/documentation.
- Fits Express and the current product surface.
- Avoids introducing a second query/schema paradigm without need.

### Consequences

- Use consistent success/error envelopes, pagination, status/error mapping, and idempotency.
- Breaking contract changes require deliberate versioning/migration.
- Browser authentication uses the opaque-session and cookie contract in `ADR-013`; REST endpoints must not expose a bearer or refresh-token alternative.

## ADR-009 — Use an AWS baseline without fixing the exact hosting topology yet

- **Date:** 2026-08-21
- **Status:** Accepted
- **Type:** Cloud architecture

### Context

StockWise is a cloud/software-engineering project and must include deployment, monitoring, experimentation, limitations, and cost analysis. The exact frontend/backend compute and production topology have not been selected.

### Alternatives considered

1. Local-only deployment
2. AWS building-block baseline with topology selected later
3. Kubernetes/microservices platform from the start
4. A different cloud provider

### Decision

Use these AWS capabilities:

- RDS PostgreSQL
- S3 for accepted object-storage needs
- VPC network isolation
- CloudWatch logs/metrics/alerts
- EventBridge schedules
- Docker application packaging
- GitHub Actions CI/CD
- SQS only when measured job/backpressure complexity requires it

Leave exact frontend/backend compute, ingress, region, secrets, IaC, availability, recovery, and cost targets to `OQ-015`/`OQ-020`.

### Why selected

- Meets the cloud-delivery and experiment goals with managed foundational services.
- Avoids pretending that an unreviewed topology is already accepted.
- Keeps optional queue/service complexity evidence-driven.

### Consequences

- Documentation may show only a conceptual deployment until `OQ-015` closes.
- RDS is intended to be privately networked and protected by least privilege.
- Cloud changes require reviewable infrastructure as code after tooling is selected.
- S3 endpoints/assets are not added without a defined product need and security/lifecycle contract.
- Kubernetes and microservices remain non-goals.

## ADR-010 — Use email/password with Argon2 for MVP; defer Google login

- **Date:** 2026-08-21
- **Status:** Accepted
- **Type:** Product and security

### Context

Retail staff may not have suitable Google accounts, and the core project should not be blocked by OAuth provider setup. Email/password is required; Google login may be useful later as an option.

### Alternatives considered

1. Google-only authentication
2. Email/password plus Google immediately
3. Email/password MVP, optional Google after core completion
4. Managed identity service as an immediate replacement

### Decision

Implement email/password authentication for MVP and hash passwords with Argon2. Do not implement Google login now; revisit after the core project.

### Why selected

- Covers owner and employee accounts without external identity dependency.
- Keeps the MVP identity scope focused.
- Preserves Google as a later optional convenience rather than the only access path.

### Consequences

- Password storage, abuse prevention, verification/reset, and session security are StockWise responsibilities.
- Session, verification/reset, onboarding, and invitation implementation must follow `ADR-013`–`ADR-015` rather than introducing a second identity flow.
- Future Google login must map to the same profile/onboarding/membership model and requires a new accepted decision/update.

## ADR-011 — Use a native pnpm workspace monorepo

- **Date:** 2026-08-22
- **Status:** Accepted
- **Type:** Repository architecture and tooling

### Context

StockWise needs one repository for a Next.js web application, an Express modular-monolith API, and only those internal packages that later prove genuinely shareable. The repository foundation must support reproducible installation without initializing either application or adding a task runner prematurely.

### Alternatives considered

1. npm workspaces
2. pnpm workspaces
3. Yarn workspaces
4. pnpm plus a monorepo orchestrator such as Turborepo or Nx

### Decision

Use a native **pnpm workspace** on **Node.js 24 LTS**, with one root `pnpm-lock.yaml` and an exact pnpm version in the root `packageManager` field.

Use these workspace paths:

```text
apps/web
apps/api
packages/*
```

The API owns its domain modules and Prisma assets beneath `apps/api`; they are not separate deployable services or workspace packages. `packages/*` is reserved for deliberately shared internal packages with concrete consumers. Cross-application end-to-end tests and future infrastructure live outside package-manager workspaces. Do not add Turborepo, Nx, Lerna, Changesets, or another orchestration/release layer until measured repository needs justify it.

### Why selected

- pnpm provides native workspace discovery and a single shared lockfile.
- Strict dependency visibility reduces accidental reliance on undeclared transitive dependencies.
- The `workspace:` protocol can guarantee that intentional internal dependencies resolve locally.
- Frozen-lockfile installation supports reproducible local and future CI checks.
- The layout separates deployable applications without turning modular-monolith domains into services or packages.

### Consequences

- Root dependency installation and future CI use the pinned pnpm version and frozen lockfile.
- Application directories are created only by their assigned later tasks.
- Shared packages require a specific reuse case and must not become a generic `common`, `shared`, or `utils` dumping ground.
- A future monorepo task runner or release tool requires demonstrated need and a separately reviewed decision.

## ADR-012 — Use the Next.js App Router with `src/app`

- **Date:** 2026-08-22
- **Status:** Accepted
- **Type:** Frontend architecture

### Context

The frontend baseline selected Next.js but left its routing and layout convention unresolved under `OQ-002`. The web shell needs one durable convention before application routes, layouts, providers, and future user flows are created. StockWise also has a separate Express REST backend, so the frontend boundary must not accidentally become a second business API.

### Alternatives considered

1. Next.js Pages Router
2. Next.js App Router at the repository package root
3. Next.js App Router using the `src/app` directory convention
4. Mixing Pages Router and App Router

### Decision

Use the **Next.js App Router** with the **`src/app` directory convention**. Do not use the Pages Router.

React Server Components are the default. Add `"use client"` only when a component requires client-side state, effects, event handlers, browser APIs, or a client-only provider. Route Groups such as `(auth)` and `(app)` may be introduced later only when implemented routes justify them.

StockWise core and business REST APIs remain in the Express backend under `/api/v1`. Do not implement them as Next.js Route Handlers. The shell task creates no speculative routes or feature pages.

### Why selected

- App Router is the current Next.js routing model and supports nested layouts and Server Components directly.
- `src/app` keeps application source separate from package-level configuration and generated output.
- Server Components by default minimize unnecessary client JavaScript and make client boundaries explicit.
- Deferring Route Groups avoids encoding authentication or product navigation before those flows are accepted and implemented.
- Keeping business APIs in Express preserves the accepted REST boundary and prevents duplicated backend responsibilities.

### Consequences

- All application routes and layouts are created beneath `apps/web/src/app`.
- No `pages` directory or mixed-router convention is allowed.
- Client providers must be narrow explicit boundaries beneath a Server Component root layout.
- Route Groups are added only with the routes that need them.
- Next.js Route Handlers must not host StockWise business APIs; any future framework-specific handler needs a separately justified non-business purpose and review against the Express boundary.
- `OQ-002` is resolved and no longer blocks `P1-M2-T01`.

## ADR-013 — Use opaque PostgreSQL-backed browser sessions

- **Date:** 2026-08-22
- **Status:** Accepted
- **Type:** Security and application architecture

### Context

The MVP needs browser authentication that supports immediate revocation, disabled-user access loss, and a future deployment without a separate session infrastructure dependency. JWT browser authentication, browser token storage, and refresh-token flows would add exposure and lifecycle complexity without a current need.

### Alternatives considered

1. Browser JWT with refresh token
2. Opaque server-side session backed by PostgreSQL
3. Hosted identity/session service

### Decision

Use opaque server-side sessions backed by PostgreSQL for MVP. Generate a cryptographically random session token, send it only in the `stockwise_session` HttpOnly cookie, and persist only its cryptographic hash with the user, issue/last-use, idle/absolute expiry, and revocation state. The cookie has `Path=/`, is host-only (no `Domain` attribute), `SameSite=Lax`, and `Secure` in production but not on the accepted local HTTP path.

The idle-timeout baseline is a sliding 24 hours and the absolute-timeout baseline is a fixed seven days; both remain configuration values. A valid authenticated request persists an activity touch at most once every 15 minutes, setting `lastUsedAt` to the touch time and `idleExpiresAt` to the earlier of touch time plus 24 hours or absolute expiry. A required touch failure fails authentication closed. Absolute expiry never moves.

Successful authentication always creates a fresh token. When the incoming StockWise cookie resolves to a currently valid session for the same account, revocation as `login_rotation` and fresh-session creation occur atomically. Malformed, unknown, revoked, and expired incoming values are never reused and do not independently block valid credentials.

Do not use JWT for browser authentication, store tokens in `localStorage` or `sessionStorage`, or add a refresh-token flow. Rotate the session on successful authentication, revoke the current session on logout, support revoking every session for a user, and resolve authorization server-side on every protected request. Disabled or deauthorized users lose access when their request is evaluated.

### Why selected

- PostgreSQL is already the accepted durable system of record and makes revocation queryable for the MVP.
- Hash-only session-token storage limits the impact of a session-record disclosure.
- Opaque sessions make rotation, logout, all-session revocation, and membership/status revalidation direct.

### Consequences

- The identity schema must add an appropriately indexed, hash-only session record and expiry/revocation checks.
- Cookie-based state-changing endpoints need implementation-time cross-site-request protections; this ADR does not authorize an alternate credential transport.
- The API and web client must never return or persist a browser bearer token.
- Authentication context contains trusted actor/session identity only. Membership,
  role, organization, branch, and permission resolution remains a separate
  authorization/access-management boundary.

## ADR-014 — Use a provider-abstracted Resend email lifecycle

- **Date:** 2026-08-22
- **Amended:** 2026-09-30 for explicit development delivery opt-in
- **Status:** Accepted
- **Type:** Security and integration architecture

### Context

Email/password accounts require verification, safe password recovery, and invitation delivery. Production delivery must be replaceable without coupling identity-domain behavior to a specific provider. Automated tests must not deliver real email; local development defaults to non-delivery.

### Alternatives considered

1. Direct Resend calls from identity use cases
2. Resend behind an email-provider abstraction with non-delivery/test adapters
3. AWS SES immediately

### Decision

Use Resend as the MVP production email adapter behind an email-provider abstraction. `STOCKWISE_EMAIL_PROVIDER` accepts `non_delivery` or `resend`: development defaults to non-delivery and may explicitly opt into Resend for manual UAT; test always uses non-delivery and rejects Resend; production defaults to Resend and rejects non-delivery. Resend selection requires `RESEND_API_KEY` and `STOCKWISE_EMAIL_FROM`. Development keeps its HTTP cookie/session behavior when Resend is selected. AWS SES may replace the production adapter later without changing identity-domain behavior.

Email verification, password reset, and invitations use opaque cryptographically random tokens whose cryptographic hash alone is stored. They are single use and expire after 24 hours, 30 minutes, and seven days respectively. Resending verification or reissuing an invitation invalidates the prior active token. Forgot-password responses never reveal whether an account exists; a successful reset revokes all existing sessions.

Task ownership is split deliberately: P2-M2-T01 creates only the unverified
account and no verification token or email delivery. P2-M2-T03 owns
verification-token creation, resend, provider integration/delivery, and
verification behavior.

### Why selected

- The abstraction prevents provider concerns from leaking into identity rules.
- Hash-only, single-use, expiry-bound tokens limit replay and database-disclosure risk.
- Default non-delivery and test adapters make local and automated verification deterministic and safe.

### Consequences

- Identity-domain code depends on the provider interface, never a Resend SDK directly.
- Token records require secure lookup, expiry, consumption, and replacement semantics.
- Provider failures must produce safe, non-disclosing responses and must be tested.

## ADR-015 — Require verified, minimal onboarding and invitation-led joining

- **Date:** 2026-08-22
- **Status:** Accepted
- **Type:** Product and data model

### Context

The MVP needs enough information to identify a platform user and create a first operational tenant without collecting speculative personal, legal, or billing data. New users and invited employees have different entry paths.

### Alternatives considered

1. Require broad personal, company, and billing registration data
2. Minimal verified registration plus organization/first-branch onboarding
3. Automatically create an organization for every registration or invitation

### Decision

Registration accepts only email and password, and the account must later verify
its email. The platform profile requires `displayName`; it is nullable on the
registration-stage user and supplied by the later profile/onboarding flow.
Profile phone is optional. New-organization onboarding requires organization
name and an initial branch name; branch phone and address are optional. The
creator becomes `OWNER` in the atomic onboarding result. No display-name
placeholder is derived from email.

User identity is platform-level. A user does not carry `branchId` as its complete access model; organization and branch access derive from memberships. Invited users do not automatically create an organization or account: they register/authenticate as the invited email, verify it, then use the invitation acceptance flow. Profile photo, date of birth, gender, tax ID, company registration number, organization website/logo, and billing details are not required for MVP onboarding.

### Why selected

- It collects only the fields needed for a usable retail tenant and accountable user.
- It preserves multi-organization and multi-branch access without account duplication.
- It avoids accidental tenant creation and cross-email identity linking for invitations.

### Consequences

- Schema and API work must distinguish platform profile, organization, branch, and membership data.
- New-organization onboarding must create the organization, first branch, and OWNER membership atomically and idempotently.
- Future collection of excluded fields needs a scoped product/data decision.

## ADR-016 — Use fixed organization RBAC with explicit branch assignments

- **Date:** 2026-08-22
- **Status:** Accepted
- **Type:** Authorization architecture

### Context

StockWise needs an MVP authorization model that prevents tenant and branch escalation while remaining understandable for small retailers. The prior accepted role names did not define their capability, delegation, or governance semantics.

### Alternatives considered

1. Custom roles and per-user permissions
2. Fixed RBAC with one organization role plus branch assignments
3. One branch role stored directly on each user

### Decision

Use fixed, deny-by-default RBAC: `OWNER`, `ADMIN`, `BRANCH_MANAGER`, `INVENTORY_STAFF`, and `CASHIER`. Each user has one role per organization and may have different roles in different organizations. `OWNER` and `ADMIN` have organization-wide branch access. `BRANCH_MANAGER`, `INVENTORY_STAFF`, and `CASHIER` require explicit assignments and may be assigned to multiple branches. Express enforces authorization; frontend checks are UX only.

The authoritative capability, role-governance, analytics, forecast, and AI-summary baseline is in `BUILD_SPEC.md` section 8. An OWNER manages owners and OWNER-only ownership actions; an ADMIN manages branches and non-owner memberships but cannot perform OWNER-only ownership changes. At least one OWNER must remain. Refund/void authority remains unresolved in `OQ-009`.

### Why selected

- Fixed roles and one organization role give a testable, reviewable MVP policy.
- Explicit branch assignments scope operational staff without duplicating accounts.
- Keeping refund/void outside the matrix preserves the unresolved sales-reversal decision boundary.

### Consequences

- The identity schema uses an organization-role membership plus role-less branch assignments; it must not model competing branch roles for a user.
- Policy tests must cover deny-by-default, tenant/branch isolation, delegation, last-owner protection, and immediate loss of access after deauthorization.
- Custom roles, direct user permissions, and any refund/void grants need a future accepted decision.

## ADR-017 — Fix the registration/profile boundary and registration security baseline

- **Date:** 2026-08-24
- **Status:** Accepted
- **Type:** Product, security, data, and delivery boundary

### Context

P2-M1-T02 made `User.displayName` non-null even though ADR-015 assigns display
name to the later profile/onboarding flow and registration accepts only email
and password. P2-M2-T01 also required password, duplicate, verification-next-step,
and rate-limit behavior before those implementation-sensitive rules had a
single accepted baseline.

### Alternatives considered

1. Add display name to registration or derive a placeholder from email
2. Keep display name nullable until profile/onboarding
3. Create verification tokens and send email during P2-M2-T01 or assign the
   complete verification lifecycle to P2-M2-T03
4. Return an account-specific duplicate conflict or use one generic public
   response
5. Defer all abuse control to production or establish a bounded process-local
   MVP limiter while distributed controls remain open

### Decision

Registration accepts only email and password. `User.displayName` is nullable
until the later required profile/onboarding flow; registration never derives a
placeholder from email. Correct the committed schema through a new forward
migration that drops `users.display_name` `NOT NULL`; do not edit the initial
migration. A non-null display name must still contain non-whitespace content.

Registration passwords contain 15–128 Unicode code points. Preserve the value
exactly as supplied: do not trim, Unicode-normalize, silently truncate, or
require uppercase, lowercase, digits, or symbols. Whitespace and Unicode are
allowed. Breached-password screening is deferred.

P2-M2-T01 will use `argon2@0.45.1`, Argon2id,
`memoryCost=65536` KiB, `timeCost=3`, `parallelism=4`, and the library-generated
random salt, storing the PHC-format encoded hash. Compatibility and behavior
must be benchmarked and verified in P2-M2-T01; this correction does not install
Argon2 or implement hashing.

New and canonical-email duplicate registration attempts return the same generic
`202 Accepted` public response. PostgreSQL's unique canonical email remains the
final concurrency boundary, and raw Prisma uniqueness errors never escape.

P2-M2-T01 creates the account with `emailVerifiedAt = null` and creates no
verification-token record or email delivery. P2-M2-T03 owns verification-token
creation, resend, provider integration/delivery, and verification behavior.

Registration permits five attempts per 15 minutes per canonical email through
a deterministic process-local in-memory limiter. It stores no database state,
logs neither email nor password, and returns `429` with `Retry-After` when
exhausted. Distributed/IP-aware limiting and proxy/deployment topology remain
open under `OQ-020`; this decision does not close its unrelated production
readiness questions.

### Why selected

- It preserves the accepted minimal registration/profile boundary without
  fabricating user data.
- The password and Argon2id baselines are explicit and testable while keeping
  credential material unchanged before hashing.
- A uniform duplicate response reduces account-enumeration disclosure while
  retaining database-enforced race safety.
- Verification ownership prevents P2-M2-T01 from prematurely adding provider or
  token behavior.
- The process-local limiter provides deterministic MVP abuse control without
  claiming distributed production protection.

### Consequences

- The schema correction is a new forward migration; restoring `NOT NULL` later
  requires a reviewed backfill and another forward migration.
- P2-M2-T01 remains incomplete until its route, service, persistence, hashing,
  limiter, and security tests are implemented and verified.
- P2-M2-T03 owns verification and provider failure behavior even though the
  end-to-end registration use case continues through email verification.
- `OQ-020` remains open for distributed/IP-aware controls, proxy trust, and the
  rest of production readiness.

## ADR-018 — Bound verification and recovery abuse controls for MVP

- **Date:** 2026-08-24
- **Status:** Accepted
- **Type:** Security and delivery boundary

### Context

P2-M2-T03 requires account-safe verification resend and password recovery, but
`OQ-020` intentionally leaves production-wide abuse architecture open. The task
still needs deterministic application-level behavior that cannot become an
account-existence oracle.

### Decision

Verification resend and password-reset request each use an independent
process-local fixed-window limiter. Three syntactically valid requests are
accepted per canonical email per 15 minutes; a SHA-256 derivative is the only
stored key. Every valid request consumes before account lookup and provider work
regardless of account existence, verification/status eligibility, or delivery
outcome. Attempt four and later returns `429 RATE_LIMITED` with deterministic
remaining-window `Retry-After`; success does not reset the window. Malformed
email follows validation and creates no limiter entry.

Reset completion adds no token-keyed process-local limiter. Opaque 32-byte,
hash-only, single-use, 30-minute tokens are validated for active state before
Argon2, so malformed, random, expired, revoked, replaced, consumed, and replayed
tokens do not trigger password hashing or allocate attacker-controlled keys.

These are narrow MVP exceptions. `OQ-020` remains open for distributed,
IP-aware, global/provider-wide, reverse-proxy-trust, multi-instance,
production-DoS, long-term abuse-telemetry, and other production-readiness
controls.

### Consequences

- Existing/missing/ineligible accounts have the same pre-exhaustion status/body,
  limiter count, and `Retry-After` behavior.
- The two request flows do not share counters, and no reset-completion limiter
  state exists.
- Process restart or another instance has an independent counter; this is not
  represented as production-grade distributed protection.

## ADR-019 — Persist one replay-safe first-organization onboarding result

- **Date:** 2026-08-24
- **Status:** Accepted
- **Type:** Product, data, API, and concurrency boundary

### Context

The accepted minimal onboarding fields did not define the required physical
branch code, one-time eligibility, durable replay identity, or post-success
destination. The existing multi-organization membership model intentionally
cannot use membership uniqueness alone to identify the one first-onboarding
result.

### Decision

`POST /organizations` is the authenticated verified user's one-time first-
organization command. With no persisted onboarding provenance, eligibility
requires zero `OrganizationMembership` rows of any status; a pending invitation
alone does not block it. Submitted profile values replace existing profile
values only during the successful initial transaction.

Create the initial branch with server-owned code `MAIN`; the client neither
supplies nor derives it. Required text is boundary-trimmed and nonblank. Optional
phone/address text is boundary-trimmed and blank becomes `NULL`. Preserve
internal whitespace and Unicode representation without case folding, Unicode
normalization, or phone transformation.

Persist one `FirstOrganizationOnboarding` row per user containing the created
organization, same-organization branch, canonical-request SHA-256 hash, and
completion time. Restrictive foreign keys and the composite branch/organization
relationship preserve tenant integrity. The API locks the user row and rechecks
provenance/membership inside the transaction; the per-user primary key remains
the authoritative uniqueness boundary. The transaction updates profile and
creates organization, OWNER membership, `MAIN` branch, and provenance together.

Existing provenance plus the same hash returns HTTP `200` with the original
logical resource result and no mutation. A different hash returns `409
ALREADY_ONBOARDED`; membership without provenance returns `409
ALREADY_HAS_ORGANIZATION_ACCESS`. No client idempotency key or serialized HTTP
response is stored. Success returns only safe user/organization/branch data,
role `OWNER`, and `nextStep = app`; the web client navigates to a minimal `/app`
holding route.

`GET /me/access-context` exposes only the derived
`firstOrganizationOnboarding.eligible` boolean for application entry. It is true
only when both authoritative blockers are absent: no
`FirstOrganizationOnboarding` provenance and zero `OrganizationMembership` rows
of any status. Pending invitations remain irrelevant. This display/navigation
signal does not replace the command's transactional eligibility check.

### Consequences

- This endpoint cannot create a second organization; that requires a later
  explicit capability and contract.
- OWNER is organization-wide and the initial transaction creates no branch
  assignment.
- Invitation acceptance and later branch code rules remain separate tasks.
- Request hashes, provenance identifiers, session state, and permission arrays
  never enter the public response.

## ADR-020 — Use lifecycle branches and URL-only application context

- **Date:** 2026-08-24
- **Status:** Accepted
- **Type:** Product, data, API, authorization, and frontend-state boundary

### Context

P2-M3-T02 required exact post-onboarding code rules, branch lifecycle and
concurrency behavior, effective-access representation, and a switcher state
owner. Persisting a selected branch in several places would create stale or
conflicting authority, while deactivation without serialization could leave an
organization with no active branch.

### Decision

An `OWNER` or `ADMIN`, authorized by centralized `branch.manage`, creates and
manages branches. Submitted codes are trimmed, uppercased, 1–16 characters,
match `[A-Z0-9][A-Z0-9_-]*`, are immutable, and are unique per organization;
`MAIN` has no global reservation. Names are trimmed/nonblank up to the existing
schema limit, duplicates are allowed, and optional phone/address values are
trimmed with blank mapped to `NULL`.

Branches have explicit activate/deactivate commands and no delete endpoint.
Every edit or lifecycle command includes the exact prior millisecond UTC
`updatedAt`. Mismatch returns `409 BRANCH_STALE`; matching same-state lifecycle
is idempotent. Deactivation locks the organization row and checks at least one
other active branch inside the transaction, returning `409 LAST_ACTIVE_BRANCH`
when prohibited. Assignments remain persisted but confer no active operational
authority while their branch is inactive; that authority returns on reactivation
only when the assignment and membership are otherwise active.

**Accepted clarification — 2026-10-01 (SW-PREBASE-MT-01):** Branch deactivation
does not erase historical/read-only visibility. `OWNER`/`ADMIN` retain
organization-wide read access. Other roles may retain authorized historical
reads, including branch inventory balance/history reads, through an existing
active, non-revoked assignment to that inactive branch. Active actor,
organization, membership, same-tenant scope, and the endpoint's read permission
remain required; removing/revoking the assignment removes this branch-scoped
access. A retained assignment never permits new operational work on an inactive
branch, including inventory adjustment, receiving, or POS checkout. This
clarification does not expand role permissions or change capability-specific
active-branch requirements. Active navigation/access-context remains distinct
from authorized historical reads.

Default branch listing returns active rows. Only `OWNER`/`ADMIN` may include
inactive rows; branch-only roles receive active assigned rows. Results are
unpaginated and code-ascending for MVP. `GET /me/access-context` returns only
active memberships/organizations and effective active branches: all active
branches for `OWNER`/`ADMIN`, active assigned branches for other roles.

The browser owns selection only in
`/app?organizationId=<id>&branchId=<id>`. It re-resolves candidates against
fresh access context, applies deterministic fallbacks, and canonicalizes with
`router.replace`. No database, user/session record, cookie, `localStorage`, or
`sessionStorage` selection is added. Before transition or revoked-context
fallback, it cancels and removes the previous TanStack Query prefix
`["branch-scoped", organizationId, branchId, ...]`.

After authentication, the browser enters `/app`, clears stale access-context
query state across login/logout boundaries, and waits for fresh access context.
Zero accessible organizations route to first setup only when the server-derived
first-onboarding eligibility flag is true; an ineligible zero-access user sees
the safe no-access state.

### Consequences

- URL values select navigation candidates but never prove access; every API
  endpoint continues server-side membership, scope, status, and permission
  validation.
- A refresh or access revocation can immediately remove an ineffective branch
  from navigation and its old cached branch data.
- Branch deletion, branch-code changes, selection persistence, membership
  administration, and later retail features are outside P2-M3-T02.

## ADR-021 — Serialize email invitations and full-replacement membership access

- **Date:** 2026-08-24
- **Status:** Accepted
- **Type:** Product, data, API, authorization, concurrency, and security boundary

### Context

P2-M3-T03 needed exact invitation replacement/revocation/acceptance semantics,
delegation limits, member lifecycle rules, and concurrency-safe ownership. The
base schema could bind invitation email and branch scope, but could not prove
issuer/revoker/source provenance or retain the resulting access scope. Simple
application pre-checks could also race and leave zero active owners or create
conflicting invitation outcomes.

### Decision

`OWNER` manages every role. `ADMIN` may view owner rows but may invite or mutate
only non-owner access and may never grant `OWNER`. Branch roles have no
management authority. Invitations are allowed only when no active or inactive
membership exists for the canonical email in the organization. Organization-
wide roles require an empty branch scope; branch-only roles require at least one
unique active same-organization branch.

Every create/reissue stores a fresh hash-only seven-day token in a new row and
marks the prior open invitation `REPLACED`. Explicit revoke is idempotent for
revoked/expired state, records `CANCELLED`, and cannot override acceptance.
Provider failure conditionally records `DELIVERY_FAILED`. Acceptance requires an
authenticated verified actor whose canonical email matches, revalidates branch
scope, and atomically creates membership, assignments, source provenance, an
`INVITATION_ACCEPTED` event/scope snapshot, and consumption. Same accepted-user
replay returns the linked current membership without mutation; all other bad
token states use the generic invalid-invitation family.

Member PATCH and reactivation are full desired-state replacements with exact
`updatedAt`. Organization-wide results inactivate assignments; branch-role
results activate exactly the submitted active scope. Deactivation retains role,
assignment rows, and sessions but immediately removes effective access.
Reactivation never implicitly restores prior access. Membership mutations and
invitation lifecycle transitions lock the organization first; invitation
operations then lock the invitation. Active-owner count is re-read inside that
transaction so concurrent reductions cannot leave zero active owners.

The schema retains the composite membership primary key and adds a stable
resource ID, same-tenant invitation issuer/revoker and membership-source keys,
and narrowly named immutable membership-access event/scope tables. These tables
cover only T03 access provenance; `OQ-019` remains open for a future generic
audit design. Management lists use opaque `(createdAt,id)` cursors with default
25 and maximum 100. Invitation tokens remain transient in the acceptance URL
and never enter browser storage, logs, list payloads, or UI text.

### Consequences

- Existing users and new users follow the same authenticated, verified-email
  acceptance contract; the system never creates or links accounts automatically.
- Session revocation is not a membership lifecycle side effect. Every protected
  request must re-resolve active membership and branch scope.
- Cross-tenant provenance and scope are rejected by composite foreign keys as
  well as server-side authorization.
- Ownership transfer, generic audit, invitation-specific rate limiting, and
  distributed/provider abuse controls remain outside T03.

## ADR-022 — Fix organization catalog price, unit, and lifecycle boundaries

- **Date:** 2026-08-25
- **Status:** Accepted
- **Type:** Catalog/data-model architecture

### Context

The catalog schema needs a stable organization-level price, base-unit, normalization, and lifecycle boundary before it can safely persist Products and Categories. Branch-specific pricing, quantity conversion, and product cost would otherwise cause speculative schema/API work and blur later sales, inventory, and purchasing decisions.

### Alternatives considered

1. Branch-specific current prices and effective-dated overrides in MVP
2. Multiple purchasing/selling units with automatic conversions
3. A single organization base price and one immutable base unit per Product, with later cost and transaction rules deferred

### Decision

Use option 3. Branch-level price overrides are out of MVP scope. A Product has one required organization-level non-negative `basePrice`, represented in APIs as a decimal string at scale at most four and targeted to `DECIMAL(19,4)` persistence. Excess scale is invalid rather than rounded. This configured catalog price affects future operations only; future sale items snapshot the unit price actually used. `OQ-008` was left open by this decision and is now resolved by `ADR-027` for tax, discount, currency, receipt/payment behavior, and transaction rounding.

Each Product stores exactly one immutable base unit from `EA`, `PACK`, `BOX`, `KG`, `G`, `L`, `ML`, `M`, or `CM`. `EA`, `PACK`, and `BOX` are integer-only. The others permit up to four fractional digits. Quantity APIs are decimal strings, target `DECIMAL(18,4)`, reject excess precision rather than rounding, and require positive values when an operation requests a positive amount. MVP has no unit, pack-size, or purchasing/selling-UOM conversion. Signed inventory-ledger semantics remain for inventory work; `ADR-029` later fixes derived analytics precision and prohibits mixed-unit scalar totals.

Product names are trimmed, nonblank, Unicode-preserving, and non-unique. SKU is canonical trim/NFKC/uppercase, must match `^[A-Z0-9][A-Z0-9._-]{0,63}$`, and is unique within an organization. Barcode is optional, trimmed, blank-to-null, control-character-free, at most 128 characters, and exact-match unique within an organization when present. Categories are flat with a nullable product relation. Their display names are trimmed/nonblank while an NFKC/trim/collapsed-Unicode-whitespace/lowercase key is unique within an organization.

Products and Categories use `ACTIVE`/`INACTIVE`, may reactivate, and have no hard-delete endpoint. An inactive category retains references but cannot receive a new product assignment; it does not deactivate or silently reassign products. Product reassignment to another active category or null is explicit. Category merge/bulk reassignment is excluded. Category and Product mutations use exact `updatedAt` optimistic concurrency and return `CATEGORY_STALE` or `PRODUCT_STALE` on stale state.

Product has no organization-wide cost, average-cost, COGS, or inventory-valuation field. The later Branch/Product receipt, valuation, COGS, and purchasing-cost boundary is now governed by `ADR-026`.

### Worked boundary examples

| Input or state | Result |
| --- | --- |
| Base price `"60"`, `"60.5"`, or `"60.1234"` | Accepted as an organization-level configured amount for every branch. |
| Base price `"60.12345"` or `"-1"` | Rejected; catalog input never rounds and base price is non-negative. |
| `EA` quantity `"3"` or `"3.0"` | Accepted; canonical integral output is `"3"`. |
| `EA` quantity `"3.5"` or `BOX` quantity `"1.25"` | Rejected because the unit is integer-only. |
| `KG` quantity `"0.125"` or `"0.1234"` | Accepted. `KG` quantity `"0.12345"` is rejected rather than rounded. |
| SKU `" abc-01 "` and `"Abc-01"` in one organization | Both canonicalize to `ABC-01`; the second write conflicts. |
| Barcode `" ABC-01 "` and `"ABC-01"` in one organization | Both store as the same exact trimmed value; the second write conflicts. |
| Categories `"Food"`, `" food "`, and `"FOOD"` in one organization | All have the same normalized identity; only one may exist. |
| An inactive Category referenced by active Products | References remain and products remain active, but the category cannot be assigned to another product until reactivated. |
| Product deactivation or base-price edit | Existing historical records remain unchanged; a later sale snapshots the unit price actually used. |
| Cost, average cost, COGS, or inventory valuation on Product | Not modeled in P3-M1-T02; future Branch/Product cost state follows `ADR-026`. |

### Why selected

- One base price and one base unit fit the MVP without introducing conversion, time-effective pricing, or costing machinery.
- Database-enforced organization uniqueness and explicit lifecycle rules protect catalog identity and historical references.
- Deferring transaction pricing and Product-level costing keeps sales/purchasing behavior from becoming accidental catalog truth; `ADR-026` later selects Branch/Product moving weighted-average cost.

### Consequences

- P3-M1-T02 may model Category and Product with accepted base price, unit, normalization, lifecycle, and tenant constraints, but without cost/valuation or branch-price fields.
- Future inventory, purchasing, sales, and analytics implementations must consume the accepted unit precision, `ADR-026` cost boundary, and their remaining sales/metric rules.
- A post-MVP branch-price feature requires a new accepted decision, schema/API/UI scope, and sale-price snapshot compatibility review.

## ADR-023 — Bind organization catalog capabilities to revalidated branch context

- **Date:** 2026-08-25
- **Status:** Accepted
- **Type:** Catalog API, authorization, security, and concurrency boundary

### Context

Catalog resources belong to an organization, but the accepted policy allows
branch-scoped roles to exercise catalog capabilities only within an effective
active assignment. Organization-only catalog paths therefore need an explicit
branch-context transport without treating a client identifier as authority.
Catalog list/search and lifecycle contracts also require stable pagination,
inactive visibility, safe conflicts, and exact optimistic concurrency.

### Decision

Catalog endpoints use optional query `branchId`. `OWNER`/`ADMIN` may omit it and
operate in trusted organization scope; when supplied it must resolve to an
active branch in that organization. `BRANCH_MANAGER`, `INVENTORY_STAFF`, and
`CASHIER` must supply it, and the API re-resolves active membership, role,
branch ownership/status, and active assignment from PostgreSQL on every request.
Missing required context returns `BRANCH_CONTEXT_REQUIRED`; every invalid or
ineffective supplied branch context shares one safe forbidden result.

`catalog.view` owns list/detail, `catalog.create-edit` owns create/PATCH, and
`catalog.deactivate` owns both deactivate and reactivate. Direct detail may
return inactive records. Lists default active; inactive listing requires
create/edit or lifecycle capability. Category and Product lists use filter-bound
opaque `(createdAt,id)` keyset cursors with limit 25/100. Exact-version lifecycle
commands are idempotent in the desired state. Product unit remains immutable,
price serializes at exactly four decimal places, and active same-tenant Category
assignment is protected through the write transaction.

### Consequences

- Client role, membership, assignment, permission, actor, and ownership data
  never enter trusted authorization state.
- Cross-tenant resource candidates use safe scoped queries and do not disclose
  existence; a cross-tenant Category list filter produces an empty page.
- Database uniqueness remains authoritative for normalized Category name, SKU,
  and barcode races, while the API returns only accepted domain conflict codes.
- No schema/migration, UI, inventory, costing, valuation, or branch-price model
  is introduced by this decision.
- At this decision point, sales-side `OQ-008` and `OQ-011` remained open and did not
  block catalog CRUD. `ADR-027` later resolves `OQ-008`, `ADR-029` later resolves
  `OQ-011`, and `ADR-026` governs purchasing/receiving cost without changing this
  catalog decision.

## ADR-024 — Use signed deltas, no-negative stock, and a locked balance projection

- **Date:** 2026-08-27
- **Status:** Accepted
- **Type:** Inventory quantity, authorization, concurrency, and audit boundary

### Context

Inventory needs a traceable movement history and a fast current quantity, but its
negative-stock, manual-adjustment, idempotency, lifecycle, and audit boundaries
were intentionally left open. A client-side expected-version calculation cannot
protect shared branch stock when adjustments, future receiving, and future sales
race. The quantity representation established by `ADR-022` also needed an accepted
signed-ledger interpretation without selecting a costing model, transfer lifecycle,
or generic audit system.

### Decision

`InventoryTransaction.delta` is the canonical signed decimal-string movement
quantity, persisted as `DECIMAL(18,4)`: positive increases stock, negative decreases
stock, and either textual `"0"` or `"-0"` is invalid. Input rejects excess scale and
non-integral values for `EA`, `PACK`, and `BOX`; canonical inventory output removes
meaningless trailing fractional zeros. JavaScript numbers are never authoritative
quantity truth.

MVP forbids negative inventory for every stock-decreasing movement. Within the same
PostgreSQL transaction and authoritative pessimistic branch/product balance
serialization boundary, calculate `resultingQuantity = currentQuantity + delta`.
If it is below zero, return `409 INSUFFICIENT_STOCK` and create neither an
`InventoryTransaction` nor a changed `InventoryBalance`. No OWNER, ADMIN, manager,
or other override exists. Client `expectedUpdatedAt` is not the primary stock
concurrency mechanism.

Inventory retains both an immutable append-only `InventoryTransaction` ledger and a
persisted `InventoryBalance` projection. Every successful mutation establishes or
locks balance state, validates the movement, updates balance, and appends exactly one
ledger row atomically. A balance is lazy: no Product × Branch precreation occurs; a
missing row reads as zero; a successful first movement creates it transactionally;
and a rejected first decrement leaves no durable zero row. Reconciliation requires
balance to equal the accepted projection of ledger deltas.

Manual adjustment accepts product ID, signed delta, reason, optional note, and an
opaque client-generated `Idempotency-Key`. Its source is `MANUAL_ADJUSTMENT`; ledger
sources remain extensible without defining transfer semantics. Reasons are
`STOCK_COUNT`, `DAMAGE`, `LOSS`, `FOUND`, `CORRECTION`, and `OTHER`. No reason has a
sign restriction beyond no-negative stock. Notes are optional except `OTHER`, whose
note is required and nonblank; a blank optional note becomes null. Supplied notes
trim surrounding whitespace, preserve internal Unicode/whitespace, and are not
Unicode-normalized. Credentials, tokens, and secrets do not belong in notes.

The existing `inventory.adjust` permission is the only MVP approval boundary:
`OWNER`, `ADMIN`, `BRANCH_MANAGER`, and `INVENTORY_STAFF` may adjust only a trusted
active branch; `CASHIER` remains view-only. `inventory.view` permits all five roles
within trusted branch scope. OWNER/ADMIN are organization-wide actors, but every
inventory adjustment still names and re-resolves one concrete active target branch;
branch-scoped roles also need an effective active assignment. Every adjustment
re-resolves active actor, membership, organization, target branch, and active
same-tenant Product. Product or Branch deactivation preserves balance and ledger
history but prevents new adjustments; reactivation restores eligibility if all other
conditions still hold.

Idempotency persists a deterministic key hash and canonical-request hash with
organization-scoped uniqueness sufficient to prevent duplicate physical movements.
The same key plus identical canonical request returns the original logical success;
the same key plus a different request returns `409 IDEMPOTENCY_CONFLICT`; concurrent
identical requests produce at most one physical balance/ledger mutation. There is no
accepted expiry window for inventory-mutation idempotency.

Corrections append a signed `CORRECTION` adjustment; historical ledger rows are never
edited or deleted. This decision does not require a `correctionOfTransactionId`
relationship; P3-M2-T02 must not add one unless a later accepted schema need
demonstrates it. InventoryTransaction is the bounded immutable domain provenance
record: organization, branch, product, delta, reason/note, actor user and membership/
context, source, idempotency provenance, and timestamp. Manual adjustments always
have a human authenticated actor. Future system movements need an explicit trusted
system/source identity. This does not create or resolve generic cross-domain audit
logging: `OQ-019` remains open.

### Worked boundary examples

| State or request | Result |
| --- | --- |
| Current `10`, delta `-3` | Accepted; resulting quantity `7`. |
| Current `3`, delta `-3` | Accepted; resulting quantity `0`. |
| Current `3`, delta `-4` | `INSUFFICIENT_STOCK`; no balance or ledger mutation. |
| Current `5`, concurrent `-4` and `-4` | Only one succeeds; the serialized loser observes the resulting balance and fails. Final quantity is never `-3`. |
| Current `5`, concurrent `+10` and `-4` | Both may succeed in serialized order; final quantity is `11` with no lost update. |
| No balance, first `+5` | Create balance and ledger atomically; resulting quantity `5`. |
| No balance, first `-1` | `INSUFFICIENT_STOCK`; no ledger and no required durable balance row. |
| `EA` delta `+3` or `-1` | Valid, subject to resulting quantity. `EA` `+1.5` is invalid. |
| `KG` delta `+0.125` or `-0.1234` | Valid, subject to resulting quantity. `+0.12345` is invalid. |
| Canonical output `"3.0000"`, `"2.5000"`, `"-2.2500"`, or `"0.1250"` | `"3"`, `"2.5"`, `"-2.25"`, or `"0.125"` respectively. |
| Key K, `+5`, then identical retry | One movement; retry returns the original logical success. |
| Key K, `+5`, then `+6` | `IDEMPOTENCY_CONFLICT`; no second mutation. |
| Wrong prior `+5` adjustment | Append `-5` with reason `CORRECTION`; preserve the original. |
| Inactive Product or Branch | Reject new adjustment; retain existing balance and ledger history. |

### Consequences

- P3-M2-T02 may design the tenant-safe `InventoryBalance` and
  `InventoryTransaction` schema/migration: each needs organization, branch, and
  product ownership; `InventoryBalance` is unique by branch/product; and composite
  foreign keys must prove the branch and Product share the same organization. Product
  needs the required composite relational key if it does not already provide one.
- P3-M2-T04 may implement the adjustment API only after the balance/ledger schema and
  query/history foundations exist. It must prove no oversell, no lost update, no
  ledger-without-balance, no balance-without-ledger, and no duplicate idempotent
  movement.
- This quantity foundation intentionally implements no unit cost, average cost,
  valuation, or COGS; `ADR-026` now governs future Branch/Product cost state and receipt integration. `OQ-013` is deferred from MVP by `ADR-025`: no transfer behavior
  or source lifecycle is defined. `OQ-019` remains open for generic audit logging, and `OQ-020` remains
  open for production hardening.

## ADR-025 — Defer inter-branch stock transfer from MVP

- **Date:** 2026-08-31
- **Status:** Accepted
- **Type:** Product scope and inventory delivery boundary

### Context

Inter-branch stock transfer remained an explicit high-priority decision gate after
the quantity-only inventory foundation. Its physical in-transit lifecycle,
authorization, persistence, idempotency, and ledger relationship were not accepted.

### Decision

Resolve `OQ-013` as **DEFERRED FROM MVP**. Inter-branch stock transfer remains
broader/full product scope, but the current MVP has no transfer schema, API, UI,
permission, lifecycle, ledger-source, or idempotency contract. P3-M3-T02 is deferred
without implementation.

The previously discussed `SEND → IN_TRANSIT → RECEIVE → RECEIVED` direction, with
exact quantity and no partial/discrepancy workflow, is non-binding future guidance
only. It must be re-reviewed and accepted before transfer implementation resumes.

### Why selected

The completed balance/ledger and adjustment capabilities provide a safe quantity-only
foundation, but a transfer lifecycle would add durable product and operational choices
outside the current MVP without an accepted contract.

### Consequences

- Do not add transfer fields, tables, endpoints, permissions, ledger sources, or
  idempotency behavior speculatively.
- Do not model a transfer as unrelated manual adjustments.
- P4-M1-T01 is complete as a documentation gate; P4-M1-T02 is the next planned task. A future transfer restart requires a new decision review
  and a separately bounded implementation plan.

## ADR-026 — Use exact one-shot receipts and Branch/Product moving weighted-average cost

- **Date:** 2026-08-31
- **Status:** Accepted
- **Type:** Purchasing, receiving, costing, and bounded Input VAT decision gate

### Context

Purchasing and receiving needed a complete lifecycle and historical-cost contract
before Supplier, purchase-order, receipt, or cost persistence can be implemented.
The completed inventory foundation is quantity-only and permits manual positive stock
adjustment without acquisition cost, so a future cost design must preserve unknown
cost basis rather than fabricate zero value or rewrite history.

### Decision

Resolve `OQ-021` with the following MVP purchase-order contract:

- States are `DRAFT`, `ORDERED`, `RECEIVED`, and `CANCELLED`.
- Allowed transitions are `DRAFT → ORDERED`, `DRAFT → CANCELLED`, `ORDERED → RECEIVED`, and `ORDERED → CANCELLED`. `DRAFT` is editable; `ORDERED` freezes Supplier, Branch, Product lines, quantities, expected unit costs, and accepted commercial snapshots; `RECEIVED` and `CANCELLED` are terminal.
- One PO targets exactly one Branch. One `ORDERED` PO produces at most one immutable completed Receipt. The server derives each receipt quantity exactly from the frozen PO line.
- Partial, over, short, multiple-event, damaged/discrepancy receiving; receiving without a PO; supplier returns; receipt correction; and receipt reversal are out of MVP. Manual adjustment is not a semantic receipt cost/VAT correction.
- An inactive Supplier blocks new PO creation and DRAFT Supplier selection, but an already `ORDERED` PO may be received. Inactive Product or Branch blocks receiving until reactivation. Historical records remain readable.
- A Product occurs once per PO. PO and Receipt references are server-generated, immutable, Organization-unique, and in separate logical namespaces; no generic accounting/document-numbering engine or visual format is selected.

Resolve `OQ-010` with Branch/Product moving weighted-average cost. PO
`expectedUnitCost` is planning/history data; Receipt `actualUnitCost` is the
authoritative inventory cost-basis input. Purchase variance is actual less expected
cost for reporting only and never changes quantity. Use exact PostgreSQL
`NUMERIC`/Prisma `Decimal`, not JavaScript `number`; Receipt/PO unit costs target
`DECIMAL(19,4)`, moving-average unit cost targets `DECIMAL(19,6)`, and
`ROUND_HALF_UP` applies at required persisted/display scales. MVP currency is THB
only. FIFO and cost layers are rejected.

For a known basis, receiving uses:

```text
oldInventoryValue = oldQuantity * oldAverageCost
receivedValue = receivedQuantity * actualUnitCost
newQuantity = oldQuantity + receivedQuantity
newInventoryValue = oldInventoryValue + receivedValue
newAverageCost = newInventoryValue / newQuantity
```

Cost basis is Branch/Product `UNKNOWN` or `KNOWN`. `UNKNOWN` means stock exists but
its authoritative acquisition basis is unavailable; it never means zero cost. If
positive uncosted stock exists, the first authoritative receipt initializes the known
basis for all resulting on-hand quantity at that receipt's `actualUnitCost`. This is
prospective valuation-basis initialization only: it neither backfills historical
ledger movements nor reconstructs historical acquisition cost, COGS, or valuation.
Before initialization, cost-dependent reporting is unavailable. After initialization,
manual positive/negative adjustments use current/last-known average cost; before it,
they change quantity only. At zero quantity, inventory value is exactly zero while
last-known average cost is retained; a later receipt from zero adopts its actual unit
cost as the new current average. No Opening Cost or Recost workflow is accepted.

For `KNOWN` basis, `averageUnitCost` is the authoritative retained per-unit basis and
`inventoryValue` is its materialized quantity projection. Manual adjustments retain
the average and persist `resultingQuantity * averageUnitCost`, rounded `ROUND_HALF_UP`
only at the inventory-value storage boundary. Subsequent receiving derives the old
basis from `oldQuantity * averageUnitCost`; it must not treat an independently rounded
inventory-value accumulator as authoritative or clamp negative rounding residuals.

For the bounded purchasing-side part of `OQ-008`, a Receipt may snapshot, where
applicable, organization VAT-registration state, Input VAT rate and amount, and
supplier tax-document number/date. These are document-level immutable snapshots only.
They neither create a generic Tax or allocation engine nor derive/rewrite
`actualUnitCost`. Sales payment, Output VAT, discount ordering, tender/change, sales
receipt numbering/display, and sales monetary rules were intentionally left to
`OQ-008` and are now resolved by `ADR-027`; neither decision makes a legal/tax-
compliance claim.

For MVP, while Organization has no authoritative VAT-registration master field, the
organization VAT-registration snapshot is an explicit immutable receipt-time assertion
supplied by the authorized receiving command. It is validated independently, included
in receipt-level idempotency, and is not derived from Organization master data, VAT
rate/amount, Supplier documents, or any tax-calculation behavior.

Receiving is a future single PostgreSQL transaction: receipt-level idempotency,
receipt/items, positive purchasing-provenance ledger movements, balance updates,
cost-state updates, and PO transition all commit or roll back together. Multi-line
receiving needs operation-level receipt idempotency plus unique receipt-item-to-ledger
linkage; current single-manual-movement idempotency cannot be copied to every line.
The existing purchasing authorization remains: `OWNER`, `ADMIN`, `BRANCH_MANAGER`,
and `INVENTORY_STAFF` in trusted branch scope may view purchasing costs and perform
purchasing/receiving; `CASHIER` has neither permission.

### Consequences

- P4-M1-T01 is complete as a decision/documentation gate only. It creates no code,
  schema, migration, endpoint, UI, Supplier, PO, Receipt, cost, COGS, valuation, or
  VAT-processing implementation.
- Later schema work must represent `UNKNOWN` versus `KNOWN` Branch/Product cost basis
  without changing the existing manual-adjustment API; the exact physical model is a
  bounded implementation detail of that later task.
- Future sale items snapshot the cost used at checkout when the sales milestone
  implements COGS. Analytics still requires its own accepted metric/state rules.
- P4-M1-T02 — Supplier model/API/UI is next. It must not begin until separately
  authorized.

## ADR-027 — Use THB-only atomic completed sales with recorded payment, VAT-inclusive document totals, and immutable receipt snapshots

- **Date:** 2026-09-05
- **Status:** Accepted
- **Type:** Sales, payment, Output VAT, discount, receipt, and monetary decision gate

### Context

`OQ-008` blocked the Sales/POS persistence and checkout milestones because payment,
Output VAT, discount, receipt identity, tender/change, idempotency, monetary rounding,
and cost-at-sale behavior were not yet one coherent contract. The accepted catalog
already provides one organization-level `Product.basePrice`; `ADR-022` fixes quantity
and price precision, `ADR-024` fixes no-negative stock and Branch/Product
serialization, `ADR-026` fixes Branch/Product `UNKNOWN`/`KNOWN` moving-average cost,
and `ADR-016` fixes the role and branch-scope baseline. This decision closes only the
remaining sales monetary boundary. Sales/POS code and persistence do not yet exist.

### Alternatives considered

- Persist a draft Sale, suspended cart, or stock reservation instead of retaining the
  mutable cart as client state until checkout.
- Support CARD, gateways, pending/offline payment, or split tender in addition to
  recording CASH and manually confirmed TRANSFER.
- Accept client prices, branch prices, or manual price overrides instead of reloading
  `Product.basePrice` and detecting price change with an optimistic precondition.
- Omit discounts, support line promotions, or allow combined/campaign discounts
  instead of one bounded whole-Sale manual discount.
- Assert VAT at checkout, reuse receiving Input VAT fields, add VAT on top of catalog
  price, or build product tax classes/a generic tax engine instead of using one
  authoritative Organization sales VAT profile and VAT-inclusive prices.
- Round each line independently instead of calculating the document first and
  deterministically allocating its cents.
- Block sale of available stock whose cost basis is `UNKNOWN`, or fabricate zero COGS,
  instead of completing the sale with explicit unavailable cost facts.
- Create a separate Sales Receipt aggregate or sequential fiscal numbering instead of
  projecting a receipt from one immutable completed Sale.

### Decision

Resolve `OQ-008` with the following MVP contract.

#### Sale, payment, currency, and receipt

- The mutable cart and checkout intent remain client-side. There is no persisted Cart,
  Draft Sale, or inventory reservation. Atomic success creates a Sale; existence of a
  Sale row means checkout completed successfully. The initial schema has no
  `SaleStatus` enum or status field. `OQ-009` alone will decide later reversal status
  or projection semantics.
- Sales are THB-only. The Sale snapshots currency `THB`; no FX or foreign-currency
  tender exists.
- Payment methods are exactly `CASH` and `TRANSFER`. TRANSFER means an employee has
  manually confirmed a bank/QR-style transfer. There is exactly one Payment per Sale,
  its amount equals the Sale total, and its existence under an atomically completed
  Sale means confirmed payment. There is no independent mutable Payment status.
- CASH requires a two-decimal `amountTendered` at least equal to the Sale total and
  persists server-derived `changeAmount`; `amountTendered - changeAmount =
  Payment.amount`. TRANSFER has null tender/change and may carry one trimmed optional
  reference of at most 100 characters. CARD, split payment, gateway/provider calls,
  pending/offline payment, slip upload, OCR, and automatic transfer verification are
  excluded.
- The server generates one immutable `SALE-<UUID>` reference unique within the
  Organization. Sale, SaleItems, and Payment are the customer receipt source; no
  separate Sales Receipt aggregate exists. The receipt snapshots the Organization
  name, Branch name/code, acting employee display identity, lines, totals, payment,
  and occurred-at instant needed to reproduce it. It is not a legal tax-invoice or
  fiscal-numbering claim.
- No Customer/CRM aggregate or customer name, phone, email, address, loyalty ID, or
  free-text customer data is part of checkout. A transfer reference is payment
  evidence, not customer identity.

#### Price and discount

- The server reloads the active same-Organization Product and treats
  `Product.basePrice DECIMAL(19,4)` as price authority. A checkout line supplies
  `expectedUnitPrice` only as an exact optimistic precondition; a changed price rejects
  the checkout with `PRICE_CHANGED`. SaleItem snapshots Product ID, SKU, name, base
  unit, and the accepted unit price. Duplicate Product lines are invalid. There is no
  manual price override or Branch price.
- A Sale may have no discount or one whole-Sale manual `AMOUNT` or `PERCENT` discount;
  types cannot combine. `AMOUNT` is positive, scale at most two, and strictly less
  than subtotal. `PERCENT` is positive, scale at most four, and strictly less than
  `100`; its calculated discount is `ROUND_HALF_UP(subtotal * percent / 100, 2)`.
  The final total must remain positive. A trimmed nonblank reason of at most 200
  characters is required. Persist the type, entered value, reason, and calculated
  `discountAmount` snapshot.
- `OWNER`, `ADMIN`, and an assigned `BRANCH_MANAGER` may apply a discount in their
  authorized scope. `CASHIER` may complete an undiscounted checkout but cannot apply a
  discount. `INVENTORY_STAFF` cannot sell. No coupon, BOGO, campaign, member pricing,
  line promotion, discount stacking, or delegated approval workflow exists.

#### Organization sales VAT

- Organization application configuration has `salesVatStatus` values
  `UNCONFIGURED`, `NOT_REGISTERED`, and `REGISTERED` plus nullable
  `salesVatRate DECIMAL(9,6)`. `UNCONFIGURED` is an application configuration state,
  not a legal business-registration classification, and blocks checkout with
  `VAT_CONFIGURATION_REQUIRED`.
- P5-M1-T02 initializes existing and newly created Organizations to `UNCONFIGURED`
  with a null rate; migration and onboarding must not silently assert a legal VAT
  classification.
- `REGISTERED` requires a positive rate below `100`; `NOT_REGISTERED` and
  `UNCONFIGURED` require a null rate. The rate is operational Organization data and is
  never hardcoded. `OWNER` and `ADMIN` manage it through Organization settings;
  checkout never accepts client-authored VAT status or rate.
- For `REGISTERED`, every Product sold through MVP POS is assumed subject to the one
  Organization rate. `Product.basePrice` is the final VAT-inclusive selling price.
  Discount is applied before document-level Output VAT extraction:

  ```text
  totalAmount = subtotalAmount - discountAmount
  outputVatAmount = ROUND_HALF_UP(totalAmount * vatRate / (100 + vatRate), 2)
  taxableAmount = totalAmount - outputVatAmount
  ```

- For `NOT_REGISTERED`, no Output VAT is extracted: Sale and SaleItem taxable amounts
  are null, Sale and line Output VAT amounts are `0.00`, and the VAT-rate snapshot is
  null. The Sale net amount is not labeled as a VAT taxable base.
- Each Sale snapshots the configured status/rate used. Mixed taxable/non-taxable
  baskets, Product-specific tax classes, VAT-exempt Products, zero-rated Products,
  multiple/product-specific rates, jurisdiction tax engines, VAT filing, and legal
  tax-invoice/e-tax-invoice compliance are explicit MVP exclusions.

#### Decimal calculation and allocation

- External money, price, cost, tax, discount, and quantity values are canonical
  decimal strings. PostgreSQL `NUMERIC`/Prisma `Decimal` is authoritative; JavaScript
  `number` is never monetary authority. Inputs exceeding their accepted scale are
  rejected, never silently rounded.
- Quantity is `DECIMAL(18,4)` under `ADR-022`; unit price is `DECIMAL(19,4)`; VAT rate
  is `DECIMAL(9,6)`; percentage discount is `DECIMAL(7,4)`; customer/document money,
  payment, tender, and change are `DECIMAL(38,2)`; known unit cost is
  `DECIMAL(19,6)`; COGS is `DECIMAL(38,10)`.
- Calculate exact raw `quantity * unitPrice` line extensions, sum them, and apply
  `ROUND_HALF_UP(..., 2)` once for the document subtotal. Allocate subtotal cents to
  lines using largest fractional remainder, with canonical Product ID as the stable
  tie-break. Calculate the document discount, then allocate its non-negative cents
  proportionally by the same rule. Calculate registered document Output VAT once
  after discount and allocate its non-negative cents proportionally over line net
  amounts by the same rule. Derive each line taxable amount as line net less line
  Output VAT; do not independently round a taxable base.
- Allocated components are non-negative. Every applicable line enforces
  `lineDiscount <= lineGross`, `lineNet >= 0`, `lineOutputVat <= lineNet`, and
  `lineTaxable >= 0`. Aggregates enforce:

  ```text
  sum(lineGross) = Sale.subtotalAmount
  sum(lineDiscount) = Sale.discountAmount
  sum(lineNet) = Sale.totalAmount
  sum(lineOutputVat) = Sale.outputVatAmount
  Payment.amount = Sale.totalAmount
  ```

  For `REGISTERED`, `sum(lineTaxable) = Sale.taxableAmount` and taxable plus Output VAT
  equals total. For `NOT_REGISTERED`, Sale/line taxable amounts are null and Sale/line
  Output VAT amounts are `0.00`.

#### Atomicity, stock, cost, and idempotency

- One PostgreSQL transaction revalidates actor/membership/Branch scope, claims or
  resolves checkout idempotency, locks/reads Organization VAT configuration, reloads
  active Products and prices, acquires the existing shared Branch/Product inventory
  serialization keys in sorted Product-ID order, locks balances/cost states, verifies
  stock/payment/discount/totals, creates Sale/SaleItems/one Payment, appends one
  negative `SALE` InventoryTransaction per line with unique provenance, decrements
  balances, updates cost state and COGS snapshots, and commits. Any failure rolls back
  every effect. No role has a negative-stock override.
- For `KNOWN` cost basis, each SaleItem snapshots the retained
  `averageUnitCost DECIMAL(19,6)` and `cogsAmount = ROUND_HALF_UP(quantity *
  averageUnitCost, 10)`. Remaining inventory value is
  `ROUND_HALF_UP(resultingQuantity * averageUnitCost, 10)`; reaching zero retains the
  average and stores zero value, preserving `ADR-026`.
- For `UNKNOWN` cost basis, a sale is allowed when stock is sufficient. Whether
  resulting quantity is positive or zero, InventoryCostState remains `UNKNOWN`,
  `averageUnitCost` and `inventoryValue` remain null, the SaleItem cost-basis snapshot
  is `UNKNOWN`, and its unit cost/COGS are null. A later authoritative Purchase Receipt
  from zero on-hand may initialize `KNOWN` according to `ADR-026`, but never backfills
  or mutates historical UNKNOWN SaleItems. Zero COGS is never fabricated.
- Checkout requires one printable-ASCII `Idempotency-Key` of 1–200 characters and
  persists only its deterministic hash plus a canonical-request hash, unique by
  Organization and `SALE_CHECKOUT` operation. Canonical intent contains trusted
  Organization/Branch/actor identity, Product-ID-sorted unique lines with canonical
  quantity and expected price, discount input/reason, and payment method/tender or
  transfer reference. Same key plus same intent returns the original logical Sale and
  reference with `200`; first success returns `201`; changed intent returns `409
  IDEMPOTENCY_CONFLICT`. A rolled-back attempt creates no successful claim.

#### Authorization and future reversal boundary

- `OWNER`, `ADMIN`, assigned `BRANCH_MANAGER`, and assigned `CASHIER` may checkout in
  trusted active Branch scope. Only `OWNER`, `ADMIN`, and assigned `BRANCH_MANAGER`
  may apply a discount. `OWNER`/`ADMIN` view Organization-wide sales history;
  `BRANCH_MANAGER`/`CASHIER` view assigned-Branch history. COGS visibility is limited
  to `OWNER`, `ADMIN`, and assigned `BRANCH_MANAGER`. The Express service revalidates
  authorization; the UI is not a security boundary.
- The immutable Sale retains original item/product/price, discount, VAT, payment,
  cost/COGS, actor, Branch, timestamp, reference, idempotency, and inventory-movement
  provenance so a later decision can add linked compensating records. `OQ-009`
  remains unresolved and exclusively owns void/refund/partial-refund eligibility,
  status/projection, authorization, timing, payment reversal, restocking, and
  compensating-number semantics. Future records must not rewrite the original Sale's
  monetary, payment, item, VAT, COGS, or inventory facts.

### Worked boundary examples

| Scenario | Exact result |
| --- | --- |
| Cash, known cost | `2.0000 * 60.1234 = 120.24680000`; subtotal/total `120.25`; tender `200.00`; change `79.75`. Stock `10.0000 -> 8.0000`; at average `35.123456`, COGS is `70.2469120000` and remaining value `280.9876480000`. |
| VAT-inclusive, illustrative `7.000000` | Total `107.00`; Output VAT `ROUND_HALF_UP(107.00 * 7 / 107, 2) = 7.00`; taxable `100.00`; total remains `107.00`. The rate is illustrative, not hardcoded. |
| Discount then VAT, illustrative `7.000000` | Gross lines `428.00 + 642.00 = 1070.00`; `10.0000%` discount is `107.00`, allocated `42.80/64.20`; total `963.00`; Output VAT `63.00`; taxable `900.00`. |
| Fractional quantity | `0.3750 KG * 79.9900 = 29.99625000`, document total `30.00`; stock `5.0000 -> 4.6250`. At average `45.123456`, COGS is `16.9212960000` and remaining value `208.6959840000`. |
| Rounding edge | Two exact lines of `0.33500000` sum to document subtotal `0.67`; truncate to `0.33/0.33` then allocate the residual cent by Product-ID tie-break to persist `0.34/0.33`. Independently rounding both to `0.34` is prohibited because it would produce `0.68`. |
| UNKNOWN cost reaches zero | Selling all available UNKNOWN-basis stock decrements quantity to `0.0000`; cost state remains `UNKNOWN`, average/value remain null, and SaleItem unit cost/COGS remain null. A later receipt may initialize current stock prospectively but cannot backfill the SaleItem. |

### Why selected

This contract covers the practical cash and manually confirmed transfer workflow while
keeping price, tax, totals, stock, and authorization server-authoritative. It produces
internally reconcilable customer and analytics facts, preserves explicit uncertainty
where cost is unavailable, and avoids speculative payment, tax, promotion, customer,
receipt, cart, and reversal systems.

### Consequences

- P5-M1-T01 completes only this decision and Source-of-Truth synchronization. It
  creates no Sale/Payment schema, migration, service, endpoint, or UI.
- P5-M1-T02 may add only the bounded Organization VAT, Sale, SaleItem, Payment,
  discount/VAT/cost/idempotency/provenance persistence and constraints. It does not
  own runtime checkout, API, or UI.
- P5-M2-T01 owns the atomic checkout service. P5-M2-T02 owns the target VAT-profile
  read/update and POS/checkout HTTP contracts. P5-M2-T03 owns VAT-configuration and
  checkout-blocked UI plus POS interaction. P5-M3 retains sales history/receipt work.
- `OQ-008` is resolved by this ADR. At this decision point `OQ-009`, `OQ-011`, and
  `OQ-016` remained open; `ADR-028` later resolves reversal and `ADR-029` later resolves
  analytics eligibility and reporting time.
- Sales/POS implementation remains absent until its separately authorized roadmap
  tasks are completed. The exact next task is P5-M1-T02 — Sale/payment schema.

## ADR-028 — Use linked immutable refunds with optional same-branch restock; exclude VOID from V1

- **Date:** 2026-09-19
- **Status:** Accepted
- **Type:** Sales refund, payment compensation, inventory return, and cost decision gate

### Context

`OQ-009` blocked any correction of an atomically completed Sale. `ADR-027` makes the
original Sale, SaleItems, Payment, price/VAT/discount/cost snapshots, negative `SALE`
inventory movements, and receipt immutable. `ADR-024` requires append-only stock
movements under shared Branch/Product serialization, while `ADR-026` preserves
`UNKNOWN` versus `KNOWN` moving-weighted-average cost. A reversal contract therefore
must compensate those facts without editing them, must support fractional Product
units and repeated partial operations, and at this decision point could not depend on
then-unresolved reporting timezone `OQ-016` or generic audit question `OQ-019`.

### Alternatives considered

- Add both VOID and REFUND, with VOID limited by same-day, settlement, or register-close
  rules. No accepted settlement/register lifecycle exists, and a business-day cutoff
  would depend on `OQ-016`; without one, VOID would only duplicate full REFUND.
- Mutate the original Sale/Payment or delete the original `SALE` movements. This would
  destroy the accepted immutable historical and idempotency contract.
- Require every refunded unit to return to sellable stock. This would misrepresent
  damaged, consumed, missing, or otherwise non-restockable merchandise.
- Revalue returned stock at the current moving average. This would rewrite the economic
  meaning of the historical SaleItem cost and fabricate cost for UNKNOWN sales.
- Add cost layers or a generic returns/accounting/audit subsystem. Those are broader
  than the current modular-monolith MVP need.

### Decision

Resolve `OQ-009` with the following V1 contract.

#### Terminology, eligibility, and lifecycle

- The only V1 operation is **REFUND**. VOID is unsupported and has no enum, endpoint,
  permission, status, or persistence representation. Full-sale correction uses a full
  REFUND. This avoids an artificial second name whose eligibility would require an
  unaccepted settlement or business-day boundary.
- A REFUND is an immutable linked compensating record. It never cancels, edits, or
  deletes the original Sale. The original Sale has no mutable status. Read models may
  derive `NONE`, `PARTIALLY_REFUNDED`, or `FULLY_REFUNDED` from linked refund items.
- Full refund means cumulative refunded quantity equals original sold quantity for
  every SaleItem. Partial refund selects one or more unique SaleItems and a positive
  quantity. Multiple sequential refunds are allowed until every line reaches its
  original quantity. A fully refunded Sale rejects further refund attempts.
- There is no time or calendar cutoff, so `OQ-016` remained irrelevant to refund
  eligibility and was later resolved separately by `ADR-029`. The original Branch must be active. Current Product inactivity does
  not block refund because the immutable SaleItem is the authority and inactive stock
  may still be returned to its original Branch.
- Refund quantity follows the original Product unit under `ADR-022`: `DECIMAL(18,4)`,
  no excess scale, and integral values for `EA`, `PACK`, and `BOX`. Each requested
  quantity is positive and cannot exceed `original quantity - cumulative refunded
  quantity` under the authoritative transaction lock.
- Each refund item also records `restockQuantity` in the same unit/scale, from zero
  through that operation's refund quantity. It is chosen once when the refund is
  created. V1 has no later restock-only operation for a previously refunded unit.

#### Conceptual persistence model

Future P5-M4-T02 persistence uses the minimal concepts below; names are accepted here
without creating schema in this decision task.

- `SaleRefund`: stable ID; Organization, original Branch, and original Sale links;
  immutable `REFUND-<UUID>` Organization-unique reference; currency `THB`; actor user,
  membership, and display-name snapshot; required reason; gross, discount, nullable
  taxable, Output VAT, and total refund amounts; original VAT status/rate snapshots;
  idempotency operation/hash/request hash; `completedAt` and `createdAt` UTC timestamps.
- `SaleRefundItem`: refund header and original SaleItem links; refund and restock
  quantities; reversed gross, discount, net, nullable taxable, and Output VAT amounts;
  original cost-basis state and unit-cost snapshot; nullable COGS-reversal amount.
  One original SaleItem may occur at most once in one refund operation.
- `RefundPayment`: exactly one per SaleRefund; method copied from the original Payment;
  amount equal to the SaleRefund total; nullable transfer reference; confirmed/created
  UTC timestamps. It has no independent status.
- A restocked SaleRefundItem has exactly one linked positive InventoryTransaction.
  Non-restocked refund items have none. Relations and restrictive composite keys must
  prove Organization, Branch, Sale, SaleItem, Product, refund item, and movement agree.
- All three refund records are immutable, never hard-deleted, and retain enough actor,
  reason, time, payment, item, and movement linkage for bounded operational audit.
  Generic audit-log infrastructure remains `OQ-019` and is not required.

The original Sale, SaleItem, Payment, `SALE` InventoryTransaction, price, VAT,
discount, cost, COGS, reference, timestamps, and browser receipt remain unchanged.
A refund cannot target another refund, and a refund cannot itself be edited, deleted,
refunded, or voided in V1.

#### Historical monetary, discount, and VAT authority

- Clients submit no refund amount, price, discount, VAT rate, taxable amount, or COGS.
  The server uses only immutable original Sale/SaleItem/Payment snapshots. Current
  Product price and current Organization VAT configuration are irrelevant.
- Money fields target `DECIMAL(38,2)`. Quantity remains `DECIMAL(18,4)`, original unit
  price `DECIMAL(19,4)`, VAT rate `DECIMAL(9,6)`, original unit cost
  `DECIMAL(19,6)`, and COGS reversal `DECIMAL(38,10)`. Use Prisma Decimal/PostgreSQL
  NUMERIC; JavaScript `number` is never authority.
- For one original line with quantity `Q`, and new cumulative refunded quantity `q`,
  define a cumulative target for original line net `N` and discount `D`:

  ```text
  targetNet(q) = q == Q ? N : ROUND_HALF_UP(N * q / Q, 2)
  targetDiscount(q) = q == Q ? D : ROUND_HALF_UP(D * q / Q, 2)
  targetGross(q) = targetNet(q) + targetDiscount(q)
  ```

  The current refund item's component equals the new cumulative target minus the sum
  already persisted by earlier refunds. This makes operation order deterministic and
  lets the final quantity absorb every historical cent exactly.
- For a REGISTERED original line with historical Output VAT `V`:

  ```text
  rawTargetVat(q) = q == Q ? V : ROUND_HALF_UP(V * q / Q, 2)
  targetVat(q) = min(rawTargetVat(q), targetNet(q))
  targetTaxable(q) = targetNet(q) - targetVat(q)
  ```

  The current refund uses the delta from prior persisted cumulative VAT/taxable
  targets. At `q == Q`, it absorbs the exact historical remainder. For NOT_REGISTERED,
  taxable remains null and Output VAT remains `0.00`.
- Refund header components are exact sums of refund-item components and preserve
  `gross - discount = total` plus, for REGISTERED, `taxable + Output VAT = total`.
  An operation whose total is `0.00` is invalid; V1 does not create a zero-money
  refund/payment. No legal credit-note, tax-refund, filing, or compliance claim is made.

#### Payment compensation

- Refund payment method must equal the original Payment method and is server-derived.
  The actor cannot switch methods. There is exactly one confirmed RefundPayment whose
  amount equals the server-derived refund total.
- CASH means the authorized actor manually handed back the exact refund amount. It has
  no tender, change, gateway, reference, or pending state.
- TRANSFER means the actor manually confirmed an outgoing bank/QR-style transfer. A
  trimmed nonblank reference of 1–100 characters is required. There is no provider
  call, asynchronous state, slip/OCR, or automatic verification.
- Split payment, CARD, store credit, gift card, exchange value, refund fee, and
  restocking fee are excluded.

#### Inventory, ledger, COGS, and current cost state

- Financial refund quantity and physical restock quantity are deliberately separate.
  Only `restockQuantity > 0` increases InventoryBalance. The source is
  `SALE_REFUND_RETURN`, delta is positive restock quantity, actor is the refund actor,
  and the movement links uniquely to the SaleRefundItem and thereby to the original
  SaleItem/Sale. Original negative `SALE` movements are never changed.
- Restock always targets the original Sale Branch. Cross-branch and cross-Organization
  returns are invalid. Refund without restock is allowed. Restock without a new
  positive refund quantity is not a V1 operation. Balance, ledger, and cost state move
  together; direct balance mutation is prohibited.
- Historical COGS reversal is tied to restocked quantity, not merely refunded quantity.
  A non-restocked monetary refund keeps the original cost consumed and records zero
  COGS reversal for a KNOWN-cost item.
- For an original KNOWN line with original COGS `C`, original quantity `Q`, and new
  cumulative restocked quantity `r`:

  ```text
  targetCogsReversal(r) =
    r == Q ? C : ROUND_HALF_UP(C * r / Q, 10)
  ```

  The current item's COGS reversal is the target minus prior persisted COGS reversals;
  it snapshots the original SaleItem unit cost. The final restocked quantity absorbs
  the exact historical COGS remainder. For original UNKNOWN cost, cost basis remains
  UNKNOWN and unit cost/COGS reversal remain null; zero is never fabricated.
- For positive restock, current InventoryCostState changes deterministically:
  - Current KNOWN plus original KNOWN: returned units enter at original SaleItem unit
    cost. Compute `exactValue = currentQuantity * currentAverage + restockQuantity *
    originalUnitCost`, round the new average `exactValue / newQuantity` HALF_UP to six
    decimals, and persist `exactValue` HALF_UP to ten decimals, matching the established
    receiving path. Subsequent operations continue to derive their old basis from
    quantity times the retained average under `ADR-026`. From zero quantity, the new
    average is the original unit cost.
  - Current UNKNOWN with positive current quantity plus original KNOWN: remain UNKNOWN;
    known returned cost cannot value pre-existing unknown units. If current quantity is
    zero, initialize KNOWN from the original unit cost because every resulting unit has
    a known basis.
  - Original UNKNOWN plus any current state: resulting positive inventory is UNKNOWN
    with null average/value. A KNOWN current state is conservatively downgraded rather
    than assigning its average to unknown returned units.
  - Current UNKNOWN plus original UNKNOWN remains UNKNOWN. No restock means no balance
    or cost-state change.

These transitions preserve uncertainty without cost layers or historical
reconstruction. A later authoritative receipt may initialize an UNKNOWN state only
under the existing `ADR-026` rule; it never backfills refund or Sale history.

#### Authorization, attribution, and tenancy

- Add deny-by-default capabilities `sales-refund.create`, `sales-refund.view`, and
  `sales-refund-cost.view` during implementation. No `sales-void.*` capability exists.
- `OWNER` and `ADMIN` may create/view refunds across active branches in their
  Organization. An assigned `BRANCH_MANAGER` may create/view in an active assigned
  Branch. Assigned `CASHIER` may view linked refund records with Sales history but may
  not create them. `INVENTORY_STAFF` has no refund access.
- Refund cost/unit-cost/COGS fields are visible only to `OWNER`, `ADMIN`, and assigned
  `BRANCH_MANAGER`, matching existing Sales-cost visibility. Customer/original receipt
  output never exposes them.
- Refund create requires a trimmed, Unicode-preserving, nonblank reason of 1–200
  characters. There is no approval chain, manager PIN, per-role amount threshold, or
  delegated cashier approval. The service derives actor/Organization/Branch from the
  verified session and persisted Sale; route/body IDs are candidate scope only.

#### Idempotency, concurrency, and atomicity

- Every create requires printable-ASCII `Idempotency-Key` of 1–200 characters. Persist
  only its SHA-256-derived deterministic hash plus a canonical-request hash under the
  Organization-scoped `SALE_REFUND` operation namespace.
- Canonical intent contains trusted Organization, original Branch, actor, original
  Sale ID, SaleItem-ID-sorted canonical refund/restock quantities, normalized reason,
  derived original payment method, and normalized TRANSFER reference when applicable.
  First success returns `201`; identical replay returns the same logical SaleRefund and
  reference with `200`; same key with changed intent returns `409
  IDEMPOTENCY_CONFLICT`. A rolled-back attempt leaves no successful claim.
- Lock order is: Organization/refund-idempotency advisory lock; established trusted
  authorization/Organization/Branch locks; original Sale row `FOR UPDATE`; then shared
  Branch/Product advisory locks for positive restock in sorted Product-ID order; then
  balance and cost-state rows. No refund path may acquire a Product lock before the
  original Sale lock. The Sale row serializes cumulative eligibility for all refunds
  of that Sale; sorted shared Product locks remain compatible with checkout/receiving.
- One PostgreSQL transaction revalidates authorization and active Branch; resolves
  idempotency; locks/loads original Sale, SaleItems, Payment, and prior refunds;
  validates cumulative quantities; calculates historical money/VAT/discount and cost;
  creates SaleRefund/items/one RefundPayment; takes restock locks; updates balances and
  cost states; appends `SALE_REFUND_RETURN` rows; stores the idempotency result; and
  commits. Any failure rolls back every participant.
- Stable invalid outcomes include safe Sale not-found, inactive Branch, fully refunded,
  quantity exceeded, invalid restock, zero refund amount, missing TRANSFER reference,
  forbidden, validation error, and idempotency conflict. Concurrent attempts that
  would over-refund serialize; at most the still-eligible operation succeeds.

#### History, receipt, and document behavior

- Sales History continues to show the immutable original reference and total, plus
  derived `NONE`/`PARTIALLY_REFUNDED`/`FULLY_REFUNDED`, cumulative refunded amount, and
  remaining amount. No mutable Sale status is stored, and V1 requires no new status
  filter.
- Sale detail includes immutable linked refund headers, item quantities/amounts,
  restock disposition, payment method/reference, actor/time/reason, and role-permitted
  cost fields. It may show derived remaining refundable quantities.
- The existing browser receipt remains the original Sale/SaleItems/Payment projection
  and never becomes a fictional netted Sale. Refund information appears separately in
  Sale detail and outside the original receipt print region.
- V1 has no standalone printable refund receipt, PDF, `/receipt` endpoint, or legal
  credit-note/tax-document claim. A future document requires a separate decision.

#### Explicit V1 non-goals

VOID; exchange; store credit; gift card; CARD/gateway refund; split refund payment;
pending/asynchronous provider state; refund or restocking fee; approval chain; manager
PIN; cross-branch/cross-Organization return; restock-only follow-up; refund edit/delete;
refund-of-refund; tax credit note; fiscal numbering; external accounting integration;
generic `OQ-019` audit infrastructure; Customer/CRM; cost layers; and any change to
`OQ-016` are excluded.

### Worked boundary examples

All values are exact decimal strings; examples use one line unless stated otherwise.

| # | Scenario | Exact accepted result |
| --- | --- | --- |
| 1 | Full CASH refund | Original `2.0000` units, NOT_REGISTERED net/gross `120.25`, discount/VAT `0.00`, KNOWN unit cost `35.123456`, COGS `70.2469120000`; current stock `8.0000` at the same average. Refund/restock `2.0000` returns CASH `120.25`, appends `+2.0000`, reverses COGS `70.2469120000`, and yields quantity `10.0000`, average `35.123456`, value `351.2345600000`. |
| 2 | Full TRANSFER refund | Original `1.0000`, REGISTERED net `500.00`, taxable `467.29`, VAT `32.71`, KNOWN cost `300.000000`; current quantity is zero with UNKNOWN state. Required reference `RF-20260919-001` confirms TRANSFER `500.00`; restock `1.0000` initializes KNOWN average `300.000000` and value `300.0000000000`. |
| 3 | Partial item, no restock | Original `4.0000`, gross `400.00`, discount `40.00`, net `360.00`. Refund `1.0000`, restock `0.0000` produces gross `100.00`, discount `10.00`, net/CASH refund `90.00`; no ledger/balance/cost change and KNOWN COGS reversal is `0.0000000000`. |
| 4 | Sequential partials reach exact total | Original `3.0000`, net `100.00`, discount `10.00`, gross `110.00`. Three `1.0000` refunds produce net `33.33`, `33.34`, `33.33`; discount `3.33`, `3.34`, `3.33`; gross `36.66`, `36.68`, `36.66`. Cumulative values are exactly `100.00`, `10.00`, and `110.00`; the Sale derives FULLY_REFUNDED. |
| 5 | Fractional quantity | Original `0.3750 KG`, net `30.00`, KNOWN unit cost `45.123456`, COGS `16.9212960000`. Refund `0.1250`, restock `0.1000` returns `10.00`, appends `+0.1000`, and reverses COGS `4.5123456000`; quantity scale remains four. |
| 6 | VAT-inclusive partial | Original quantity `2.0000`, REGISTERED net `107.00`, taxable `100.00`, VAT `7.00`. Refund `0.5000` targets net `26.75`, VAT `1.75`, taxable `25.00`; current VAT configuration is not read. |
| 7 | Historical discount allocation | Original quantity `2.0000`, gross `428.00`, discount `42.80`, net `385.20`, VAT `25.20`, taxable `360.00`. Refund `1.0000` reverses gross `214.00`, discount `21.40`, net `192.60`, VAT `12.60`, taxable `180.00`. |
| 8 | Returned known cost differs from current average | Current quantity `5.0000` at `50.000000`; restock `2.0000` from an original KNOWN SaleItem at `30.000000`. Exact input and persisted value are `310.0000000000`; new average is `44.285714`. Historical COGS reversal is `60.0000000000`. A later operation derives its old basis from quantity times that retained average, as `ADR-026` already requires. |
| 9 | Original UNKNOWN cost | Original UNKNOWN item refunds/restocks `1.0000` into current `4.0000` KNOWN units at `25.000000`. Quantity becomes `5.0000`; cost state becomes UNKNOWN with null average/value, and refund unit cost/COGS reversal remain null. Zero is never fabricated. |
| 10 | Concurrent over-refund | The Sale has one line with `1.0000` remaining; two different keys concurrently request `1.0000`. The Sale-row lock lets one commit; the second then sees the Sale fully refunded and returns `409 SALE_ALREADY_FULLY_REFUNDED`. Exactly one payment and at most one return movement exist. If another line remained but this selected line were exhausted, the error would be `409 REFUND_QUANTITY_EXCEEDED`. |
| 11 | Identical retry | Repeating the same key, actor, Sale, sorted items/quantities, reason, and payment evidence returns `200` with the original `REFUND-<UUID>` and creates no duplicate payment, refund item, or ledger row. |
| 12 | Changed intent with same key | Reusing the key with changed quantity, restock quantity, reason, Sale, actor, or TRANSFER reference returns `409 IDEMPOTENCY_CONFLICT` and performs no mutation. |

### Why selected

One REFUND concept covers full correction and customer return without inventing an
unavailable settlement/day boundary for VOID. Separating financial quantity from
restock quantity represents real non-restockable outcomes, while immutable links and
historical allocation/cost authority preserve explainability. Conservative UNKNOWN
transitions avoid fabricated inventory value, and existing lock/idempotency patterns
keep the design compatible with checkout and receiving.

### Consequences

- `OQ-009` is resolved. No refund eligibility rule depends on reporting time;
  `ADR-029` later resolves `OQ-016` for analytics/calendar presentation.
- P5-M4-T01 is a documentation gate only; it creates no schema, migration, permission,
  service, endpoint, inventory/payment mutation, or UI.
- P5-M4-T02 may implement only this bounded REFUND contract. VOID and every listed
  non-goal require a later accepted decision and separately planned task.
- Analytics receives immutable refund facts. `ADR-029` later resolves `OQ-011` by
  recognizing financial refund and optional restock/COGS facts in refund event time.

## ADR-029 — Use Organization IANA reporting time and event-period operational analytics

- **Date:** 2026-09-20
- **Status:** Accepted
- **Type:** Analytics metric, reporting-time, authorization, and query decision gate

### Context

`OQ-011` and `OQ-016` blocked deterministic Analytics V1. Persisted Sales and refunds
already contain immutable document-first money/VAT/discount and historical COGS facts;
refund financial quantity and optional restock quantity are deliberately different.
Inventory has an append-oriented ledger plus current balance/cost projections. The
analytics contract must interpret those facts without rewriting them, must not turn
UNKNOWN cost into zero, and must not let browser/server locale define business dates.

### Alternatives considered

1. Fix every tenant to `Asia/Bangkok`. This matches the THB-first MVP but prevents a
   tenant from selecting another valid reporting calendar.
2. Give each Branch its own timezone. This makes Organization totals and comparisons
   span incompatible calendar buckets and adds configuration the current Branch model
   does not need.
3. Snapshot timezone on every event. This preserves original bucket labels but adds
   write-path/schema scope and yields mixed calendars after a settings change.
4. Move refunds back to original Sale periods. This silently rewrites previously shown
   periods and hides when compensation actually occurred.
5. Calculate Gross Profit from known lines while treating UNKNOWN as zero. This would
   fabricate cost and contradict `ADR-026`/`ADR-027`.
6. Add rollup/materialized tables now. No measured workload justifies another source of
   truth before direct normalized-table queries are implemented and profiled.

### Decision

#### Reporting timezone and periods

- Each Organization has one required IANA timezone; V1 has no Branch timezone. The
  explicit new/backfill default is `Asia/Bangkok`, and `OWNER`/`ADMIN` may change it
  through later Organization-settings implementation. UTC `timestamptz` storage is
  unchanged. Missing/invalid persisted timezone is an error, never a query-time fallback
  to the server/browser/default.
- On-demand history always re-buckets with the Organization's current timezone. A
  change never rewrites events; persisted snapshots retain their original timezone and
  UTC boundaries and current reusable snapshots are invalidated for recomputation.
- Current writes use server-assigned commit-time event timestamps and accept no client
  backdating. Any future late import/repair is attributed by its authoritative event
  time; later queries may change that historical bucket and expose a later source cutoff.
- Local days begin at `00:00`; weeks begin Monday `00:00`; months and years begin on
  their first local calendar day at `00:00`. Boundaries convert with IANA/DST rules to
  half-open UTC `[startInclusive,endExclusive)` instants.
- Analytics accepts required date-only `from` inclusive and `to` exclusive plus
  `day|week|month|year` granularity, rejects date-times/unaligned ranges, and caps an
  interactive query at 366 local dates. Empty buckets are gap-filled; additive facts
  use zero and undefined ratios retain explicit null reasons.

#### Event attribution and monetary metrics

- Sale facts belong to `Sale.completedAt`; refund facts to `SaleRefund.completedAt`;
  receipts to `PurchaseReceipt.receivedAt`; and inventory movements to
  `InventoryTransaction.occurredAt`. Late refunds never change the original Sale
  period. Sale existence means completion; full/partial refunds do not remove it from
  Sale Count.
- Gross Sales is persisted SaleItem gross before whole-Sale discount and is not reduced
  by refunds. Discount and Sales After Discount are shown separately. These headline
  amounts are VAT-inclusive; Output VAT and registered taxable amounts are explicit
  breakouts, with NOT_REGISTERED taxable values remaining null.
- Refund Amount uses immutable reversed line net and financial refund quantity. Units
  Refunded and Units Restocked are distinct. Net Sales is Sales After Discount minus
  refund amount in their respective event periods and may be negative.
- AOV is Sales After Discount divided by Sale Count for Sale events only; refunds are
  excluded from both inputs. Net Sales Growth compares only complete adjacent canonical
  periods. Category share uses positive Sales After Discount and current Product
  category, with `UNCATEGORIZED`; category history can reclassify after catalog edits.

#### Cost, profit, quantity, and inventory metrics

- Net COGS is immutable SaleItem COGS in Sale periods minus persisted COGS reversal in
  refund periods. Under `ADR-028`, COGS reversal follows restock quantity, not financial
  refund quantity. A non-restocked refund has zero cost effect; a positive UNKNOWN-cost
  restock has unknown cost effect.
- Any required UNKNOWN cost makes authoritative COGS, Gross Profit, and Margin null.
  Responses may expose a clearly named known-cost subtotal and coverage counts/status,
  never as the total. Gross Profit is Net Sales minus Net COGS. Margin is returned only
  with complete cost and positive Net Sales.
- Product quantities aggregate only per Product or identical immutable base-unit group;
  no mixed-unit scalar exists. Sale, refund, restock, receipt, and adjustment quantities
  remain separately named.
- Inventory V1 accepts current on-hand, in-stock/out-of-stock counts, source-separated
  ledger movements, 28-complete-day sale-depletion velocity, coverage, and current
  inventory value. Persisted ten-decimal `InventoryCostState.inventoryValue`, not
  multiplication by the rounded average, is valuation authority. Positive UNKNOWN
  stock makes total value null with known-value/coverage metadata.
- P6-M3-T01 uses the earliest same-Branch/Product ledger `occurredAt` as the 28-day
  history eligibility marker. It must be on or before the start of the 28 complete
  Organization-local days immediately before the day containing the event cutoff.
  A pair without such history is insufficient; eligible days without SALE depletion
  are zero-demand days. Requested-period ADS remains distinct from this lookback.
- Inventory movement series and current projections have separate temporal meanings.
  The original `sourceCutoff` limits event-time movement and velocity facts across
  cursor pages. Each page reads balance, cost, coverage numerator, and availability
  in one consistent database snapshot and reports `currentSnapshotCapturedAt` for
  those mutable facts. First-page markers are captured within the same execution;
  later pages retain the event cutoff but may show newer current state. Neither
  marker is client supplied. Current projections do not provide arbitrary historical
  quantity or valuation at an old cursor cutoff. A negative or ledger-divergent
  balance suppresses coverage with `INVENTORY_INTEGRITY_ERROR`; impossible cost-state
  shape suppresses affected value with that reason. Reconciliation compares the
  current projection with all ledger deltas visible in the same snapshot, not only
  deltas passing the earlier event cutoff.
- At the time of `ADR-029`, fast/slow, low-stock, stockout-risk, overstock-risk,
  safety-stock, and reorder labels were deferred. `ADR-030` subsequently accepts
  fixed low/normal/overstock coverage labels; `ADR-031` accepts only the forecast.
  Factual zero on-hand is not a forecast-risk label.

#### Authorization, precision, and query authority

- Existing `BUSINESS_ANALYTICS_VIEW` and `INVENTORY_ANALYTICS_VIEW` own analytics
  access. `OWNER`/`ADMIN` are Organization-wide; assigned `BRANCH_MANAGER` has both for
  assigned active Branches; assigned `INVENTORY_STAFF` has inventory analytics only;
  `CASHIER` has none. Organization-wide owner/admin history includes inactive Branches.
- Cost-derived analytics additionally reuse existing `SALES_COST_VIEW`; this keeps cost
  visibility with `OWNER`, `ADMIN`, and assigned `BRANCH_MANAGER` and prevents
  `INVENTORY_STAFF` from seeing inventory value. The Express API is the boundary.
- Metric definition version is `analytics-v1`. Sale/refund money outputs retain two
  decimals; quantity four; COGS/inventory value/Gross Profit ten; AOV and percentages
  round HALF_UP to two after exact aggregation. PostgreSQL NUMERIC/Prisma Decimal and
  decimal-string JSON remain authoritative; JavaScript `number` is not.
- Analytics reads normalized operational tables with one event `sourceCutoff` and a
  transactionally consistent snapshot per execution. Inventory current projections
  additionally disclose their page-specific capture marker as specified above. V1
  introduces no warehouse, OLAP service,
  materialized view, stream, scheduled rollup, or summary table. Detail/ranking rows
  paginate stably; indexes are added only by later implementation after query-plan
  evidence.

`docs/contracts/ANALYTICS.md` contains the complete formulas, null states, bucket labels, and
hand-calculated boundary examples and is authoritative if this summary is abbreviated.

### Why selected

One Organization calendar makes cross-Branch totals comparable while retaining a
deliberate Thailand-first default. Event-period recognition matches immutable
operational history and makes late refunds visible. Direct exact-decimal aggregation is
the smallest correct architecture, and explicit UNKNOWN coverage keeps profit/value
honest without delaying non-cost analytics.

### Consequences

- `OQ-011` and `OQ-016` are resolved here. `OQ-012` is subsequently resolved for
  Forecasting V1 by `ADR-031`; `OQ-017` and `OQ-018` are subsequently resolved by `ADR-033`.
- P6-M1-T01 is documentation-only. It adds no Organization timezone column,
  migration, period engine, query repository, endpoint, dashboard, chart, job,
  forecast, AI integration, or index.
- P6-M1-T02 implements the Organization timezone persistence boundary plus canonical
  period/scope/source-cutoff/completeness engine without a settings endpoint. Later P6
  tasks implement only metrics marked Accepted; deferred/blocked classifications remain out.
- Timezone changes can alter historical on-demand bucket membership. Responses and
  snapshots must expose timezone, exact UTC boundaries, definition version, scope, and
  source cutoff so this behavior is reviewable.

## ADR-030 — Fix V1 Branch/Product stock coverage classifications

- **Date:** 2026-09-24
- **Status:** Accepted
- **Type:** Inventory analytics product threshold and scope decision

### Context

`ADR-029` accepted factual inventory coverage but deferred threshold-based labels.
P6-M3-T02 needs a bounded classification contract without waiting for Forecasting
V1 or adding configurable stock policy. `docs/contracts/ANALYTICS.md` owns the exact rule
and null-state definitions.

### Decision

- At Branch/Product grain, classify only the page-current T01 `coverageDays` using
  exact Decimal comparisons. Fixed system-wide `stock-risk-v1` labels are
  `LOW_STOCK` at `<= 7.00`, `NORMAL` at `> 7.00` and `< 60.00`, and `OVERSTOCK` at
  `>= 60.00`. The same Product can have different labels in different Branches.
- Compose a nullable classification, reason, and threshold version onto each
  existing T01 dimension. Null coverage preserves its accepted T01 reason;
  inactive Products receive null/`INACTIVE_PRODUCT` without hiding movement
  history. Current zero stock with valid zero coverage is `LOW_STOCK`, not a
  `STOCKOUT_RISK` prediction.
- Reuse T01 pagination, event `sourceCutoff`, page-current
  `currentSnapshotCapturedAt`, and `INVENTORY_ANALYTICS_VIEW` scope. This
  quantity/coverage rule does not require `SALES_COST_VIEW` or reveal cost.
  P6-M3-T03 owns HTTP/UI exposure.
- Thresholds are versioned application/domain rules, not Organization, Branch,
  or Product configuration. No schema, migration, or configuration store is
  required. Configurable thresholds would need a separate future contract.

### Consequences

- This decision narrows only `ADR-029`'s threshold deferral. M-103 fast/slow,
  M-105 `STOCKOUT_RISK`, forecasts, safety stock, lead-time policy, reorder,
  ranking, and Top-N remain outside P6-M3-T02. `ADR-031` subsequently resolves
  `OQ-012` for the forecast only; replenishment still needs its own decision.
- `LOW_STOCK` is a coverage classification, not a reorder point or purchase
  quantity. No LLM assigns any stock classification.

## ADR-031 — Fix observed-sale quantity Forecasting V1

- **Date:** 2026-09-24
- **Status:** Accepted
- **Type:** Forecast product, evaluation, and architecture decision

### Context

`OQ-012` blocks a testable Forecasting V1 definition. Existing immutable
`Sale`/`SaleItem` facts, Branch/Product scope, immutable Product units, and the
Organization reporting calendar can support a small quantity forecast. Current
stock coverage velocity is factual inventory analytics, not an accepted model.
`docs/contracts/ANALYTICS.md` owns the exact formula, output, and backtest protocol.

### Alternatives considered

Gross SALE depletion, refund-adjusted sales, revenue, and inventory need were
considered as targets. Gross observed Sale quantity retains immutable event-time
history and direct unit meaning; refunds and optional restock have separate later
events and do not retroactively alter a customer's original purchase. Inventory
need would require unresolved stock, lead-time, and safety-stock policy. A 7-day
daily forecast is the smallest useful horizon; 14/28-day and multiple horizons
add unsupported scope before lead-time policy exists. A fixed 28-day history
includes four weekday cycles and limits old-pattern drift; 56/84-day or
all-history windows need more startup time and are not justified by current data.
The 28-day mean was chosen over a same-day-of-week seasonal naive method,
weighted mean, smoothing, or ML because four weeks is too little evidence for
a reliable seasonal claim and the simple mean handles sparse zero days without
extra parameters. The last-day naive method remains a named evaluation
reference. MAE remains defined on zero-heavy daily actuals; percentage metrics
need special zero-denominator treatment, while RMSE overweights large misses.

### Decision

- Forecast one Branch/Product's observed `SaleItem.quantity` by
  `Sale.completedAt` in the Product's immutable base unit. Use seven consecutive
  Organization-local days and exactly the preceding 28 complete local days,
  including zeros. Require first Branch/Product inventory movement at or before
  the training start. No positive-Sale minimum or cross-series fallback exists.
- Version the constant daily trailing-mean model as
  `forecast-sale-mean-28d-v1`. Round daily decimal expectations HALF_UP to four
  places, including integral Product units, and sum displayed daily values for
  the seven-day total. Do not round to orderable units.
- Use no seasonality, refund adjustment, stockout correction, price/promotion,
  current stock, category, supplier, holiday, or external feature. A zero-sale
  stockout day remains observed zero and can understate latent demand. A Product
  with insufficient pair history returns `INSUFFICIENT_DATA`; an inactive Product
  returns `INACTIVE_PRODUCT` before that check; eligible all-zero history returns
  an available zero forecast.
- Derive local days from the current Organization IANA timezone and UTC
  half-open bounds. Capture server `sourceCutoff` and one MVCC read snapshot;
  training excludes the current partial day and every future event. Record
  timezone, training/horizon bounds, source cutoff, generated time, version,
  status/reason, daily quantities, and total. Event-time cutoff is not a
  commit-visibility watermark. A later commit or timezone change can alter
  on-demand recomputation; historical current Product status cannot be replayed.
- Use rolling-origin four-window, seven-day backtesting and per-Branch/Product
  daily MAE, including zeros; compare with named `last-day-naive` and disclose
  exclusions. No cross-unit scalar error or fixed accuracy threshold is accepted.
  The V1 baseline must be measured and pass deterministic fixtures; the
  reference comparison is diagnostic, with no required superiority. Historical
  live extraction has the documented late-commit limitation.
- P6-M4-T02 may compute on demand inside the Express/TypeScript analytics module
  from normalized tables. No Python/ML service, scheduler, schema, migration,
  dependency, model store, training-run table, or forecast persistence is needed.
  Quantity-only results reuse server-enforced `FORECAST_REORDER_VIEW` and
  Branch scope; `SALES_COST_VIEW` is not required. P6-M4-T04 owns HTTP/UI exposure.

### Consequences

`OQ-012` is resolved for Forecasting V1. This decision supplies a forecast input,
not `STOCKOUT_RISK`, safety stock, lead-time demand, confirmed incoming,
reorder rounding, or an automatic purchase order. P6-M4-T03 needs a separate
accepted replenishment policy before implementing those calculations; risk
classification needs a separate decision. Future seasonal or other models need
new identifiers and measured comparisons. T01 adds documentation only.

## ADR-032 — Fix advisory Reorder V1 policy

- **Date:** 2026-09-25
- **Status:** Accepted
- **Type:** Replenishment policy decision

### Context and decision

P6-M4-T03 requires a separate policy before runtime. `ADR-031` supplies an
observed-sale forecast, not lead time or a purchasing quantity. Supplier has no
lead-time field. PO `expectedDate` is optional and estimated, and receiving is
all-at-once rather than partial. `docs/contracts/ANALYTICS.md` M-107 owns the exact formula,
unavailable semantics, and output.

- Produce one advisory Branch/Product result in the Product base unit. The
  authorized caller supplies a non-persisted whole `leadTimeDays` in 1–7
  Organization-local forecast days; missing or unsupported values make the
  recommendation unavailable. Use the accepted forecast's four-place daily
  serialized daily quantities for those days. Longer horizons are unavailable rather than
  extrapolated beyond `ADR-031`'s seven days.
- Use current reconciled `InventoryBalance.quantity`, treating an absent lazy
  row as zero. Negative or ledger-divergent stock is unavailable. Fix safety
  stock and accepted incoming to zero. Reuse M-102's inventory integrity
  predicate. An `ORDERED` PO, including one with an
  optional expected date, is not confirmed to arrive in the window; other PO
  states cannot supply outstanding stock. Disclose with a static policy
  limitation that pending orders are excluded; no PO query is needed.
- Compute `rawNeed = max(0, leadTimeDemand + safetyStock - onHand -
  acceptedIncoming)` with exact Decimal arithmetic. Round up only at the
  orderable-unit boundary: whole units for `EA`/`PACK`/`BOX`; already four-place
  raw need is unchanged for the other accepted Product units. No MOQ, order multiple, purchase-unit
  conversion, or Supplier selection is inferred. Check both raw and rounded
  quantity against `DECIMAL(18,4)`; overflow is unavailable.
- Propagate unavailable forecast reasons; zero available forecast remains zero.
  Inactive Product is unavailable, while inactive Branch and inaccessible pairs
  are excluded by existing server scope. Reuse `FORECAST_REORDER_VIEW` without
  `SALES_COST_VIEW`. Read forecast, on-hand/integrity, and applicability in one
  read-only `REPEATABLE READ` snapshot with one server event cutoff. The
  existing forecast repository must be composed within that transaction,
  without nesting its current `read()` transaction. The version is `reorder-v1`.
- Return status/reason, identity/unit/versions, cutoff, lead time,
  forecast demand, on-hand, raw need, and rounded quantity. The two fixed
  zero inputs come from the versioned policy rather than duplicate result fields.
  These values suffice to explain the result. T03 is internal only. T04 owns API/UI.
  Reorder never creates or changes a PO, reserves stock, sends an order, or
  classifies `STOCKOUT_RISK`.

### Consequences and deferrals

This is a baseline planning scenario, not a supplier delivery promise. It may
understate demand because Forecasting V1 does not correct stockout-censored
Sales or cover the current partial day. It may overstate new purchasing need
when an outstanding order arrives. Nonzero safety stock, confirmed arrival
semantics, longer forecast horizons, supplier lead-time master data, MOQ/pack
conversion, supplier choice, and automated ordering need separate accepted
rules and evidence. No schema, migration, dependency, persistence, or
configuration is required for this policy gate; T03 runtime is still pending.

## ADR-033 — Bound scheduled AI insight generation

- **Date:** 2026-09-27
- **Amended:** 2026-09-30 for free-only OpenRouter routing
- **Status:** Accepted
- **Type:** Scheduled AI timing, provider, privacy, and lifecycle decision gate

### Context and decision

`ADR-007` already requires OpenRouter summaries of persisted aggregate snapshots at
four cadences. `ADR-029` owns Organization reporting time and completed half-open
periods; `BUILD_SPEC.md` owns role scope. This decision resolves `OQ-017` and
`OQ-018` for V1 without changing numerical analytics or starting Phase 7 runtime.

- Use the Organization's current IANA reporting timezone, never a separate AI
  timezone. At **06:00 local time** each day, summarize the previous complete
  local day; each Monday, the previous complete Monday-based week; each first
  day of a month, the previous complete calendar month; and each January 1,
  the previous complete calendar year. All four may be due on the same day.
  Periods retain their timezone and exact UTC half-open boundaries. Resolve a
  nonexistent 06:00 to the first valid instant after the gap; on an ambiguous
  06:00 use the earlier instant and trigger only once. Use IANA calendar
  boundaries rather than fixed 24-hour durations. Never generate for an
  incomplete current period. Generate one Organization aggregate and one
  report per active Branch at the due time; the Organization aggregate follows
  `ADR-029` and includes historical facts from inactive Branches. Do not
  generate per user or for inactive Branches; retain their earlier reports
  for authorized Organization-wide readers after deactivation.
  Branch eligibility for catch-up or replay uses immutable lifecycle history at
  the original due instant. For a pre-history due instant whose Branch status
  cannot be established, skip Branch generation rather than infer eligibility
  from current status. This does not change Organization aggregate scope.
- On each scheduler scan, consider only the **two most recent due completed
  periods per cadence and scope** before dispatch, oldest first. Older missed
  periods are skipped automatically, not drained on later scans; a controlled operational
  replay may address them within the same per-job bounds. A period already
  successfully generated is not regenerated by a duplicate trigger. Claim one
  logical `(organization, branch-or-organization scope, cadence, timezone,
  UTC period bounds)` scheduled identity before provider work; concurrent
  triggers/retries resume or observe its
  state, never start uncontrolled duplicate calls. Pin snapshot/metric and
  prompt versions at first claim for retries; model and provider are attempt
  provenance. New due periods use the currently accepted prompt version. A
  deployment changing a prompt, model, or metric version does
  not automatically regenerate an already-successful period. Only controlled
  replay may create an explicit revision, with a fresh bounded attempt budget.
  V1 has one server-controlled report language and no per-user locale setting.
  P7-M2-T03 owns crash-safe claim and attempt accounting.
- The Express-owned internal provider boundary has **OpenRouter** as its sole
  V1 external provider. Keep `OPENROUTER_API_KEY` server-only. Every attempt
  requests `openrouter/free`; OpenRouter selects the underlying free model.
  StockWise performs no paid-model fallback, user/Organization model switching,
  browser access, or provider call on reads. Preserve the actual routed model
  identifier in attempt and result provenance when supplied by a valid response.
  This free-only routing is an intentional cost-control choice for the current
  project stage.
- Each provider attempt has a **15-second timeout**. At most **three calls per
  logical job**, all requesting `openrouter/free`: the initial call and up to
  two retries after transient failures. Transient means timeout/transport
  failure, rate limiting, or provider 5xx. Do not retry for invalid input,
  missing credentials, auth/permission failure, prohibited data, or
  malformed/unsafe output. Stop after exhaustion and persist safe failure.
  Failed calls consume the same budget; scheduler duplicates cannot reset it.
- The complete serialized provider-visible request body, including every
  message, instruction, server prompt, and snapshot, must be at most
  **16 KiB UTF-8**; request at most **512 output tokens** and accept at most
  **4 KiB UTF-8** of response text. Fail closed
  before a provider call if input exceeds the bound; reject an overlong or
  invalid response. No truncation of facts, unlimited retries, currency-cost
  promise, subscription plan, or billing system. Record token/cost usage only
  when the provider reliably supplies it.
- Send only a validated, allow-listed persisted aggregate snapshot: schema
  and metric versions, scope kind, completed period/timezone/UTC bounds,
  source cutoff, completeness/null reasons, and accepted aggregate values and
  comparisons needed for narration. Use only generic `Organization summary`
  or `Branch summary` scope labels; never send business/Branch names or IDs.
  Never send
  names/emails or other customer/employee/person data, sessions, credentials,
  tokens, raw Sale/Payment/purchase/ledger/audit rows, database IDs or access,
  logs, or environment values. `ADR-029` metrics, Forecasting V1, Reorder V1,
  coverage, margins, valuation, and COGS remain deterministic authority;
  unavailable values stay unavailable. AI cannot create `STOCKOUT_RISK` or
  purchasing decisions. If every allow-listed metric is unavailable/null and
  no valid aggregate value exists (zero counts as valid), persist a deterministic
  `insufficient` state without calling the provider. Otherwise, unavailable
  facts remain null/omitted with their reasons.
- P7-M2-T02 owns a **server-controlled versioned prompt** and a strict input
  allow-list. Persist prompt version with each result. Instruct the model to
  narrate only supplied facts, disclose partial/insufficient/stale values,
  avoid invented numbers/causes, and output plain display text subject to
  validation. Review each prompt/input-shape version against privacy fixtures,
  unavailable-value cases, and output validation before use. Label the result
  as AI-generated interpretation. Changing the prompt never edits a prior
  insight; a new version is a distinct explicit
  generation, not an automatic historical backfill.
- Retain accepted aggregate snapshots and insight success/failure/insufficient
  records for **36 months after period end**; expire each together only when
  no retained insight references its snapshot. Retain sanitized provider
  telemetry for at most **30 days**. Do not persist raw requests/prompts,
  raw provider responses outside the validated insight, raw provider errors,
  or credentials for debugging. Insight provenance includes cadence, tenant
  and scope, period/timezone/UTC bounds, snapshot ID/schema/metric version and
  source cutoff, prompt version, provider, actual model, attempt count,
  generation/attempt times, and success/failure/insufficient state plus safe
  failure category. Actual provider/model and attempt time are absent, and
  attempt count is zero, when no call occurred. Do not treat `sourceCutoff` as
  a commit-visibility marker.
- Provider failure leaves deterministic analytics and retail workflows
  available. Preserve the last successful persisted insight for an authorized
  scope. The latest read returns that content, if any, with its period/age and
  the more recent failure/insufficient or stale state; it never returns failure
  text as an insight or fabricates replacement prose. Reads never contact
  OpenRouter. Only the internal system job generates; any operational replay is authorized,
  auditable, and budget-bound. The system job uses trusted tenant/Branch scope,
  not a user session. Reads enforce the existing `AI_BUSINESS_SUMMARY_VIEW`,
  `BUSINESS_ANALYTICS_VIEW`, and `SALES_COST_VIEW` together with trusted scope:
  `OWNER`/`ADMIN` Organization-wide and assigned `BRANCH_MANAGER` for active
  Branches; `INVENTORY_STAFF`/`CASHIER` none. These three permissions already
  have the same V1 role set. Generate only cost-authorized V1 snapshots and
  insights for those scopes; do not create a non-cost variant or rely on UI
  redaction to protect cost-derived prose. No new role or permission.

### Why selected

A fixed 06:00 local run follows each completed calendar boundary without
per-tenant schedule settings. Two catch-up periods and three calls per job bound
downtime bursts. One period identity prevents prompt deployments from silently
regenerating history; explicit replay retains revision control.

### Consequences

`OQ-017` and `OQ-018` are resolved for V1. P7-M1-T02 owns physical snapshot
schema/store; P7-M2 owns provider, prompt, and idempotent job implementation;
P7-M3 owns orchestration and persisted API/UI. `STOCKOUT_RISK` remains
deferred/unassigned, and P0-M2-T05 remains unchecked.

## ADR-034 — Require version-bound password and mailbox proof for OTP-first verification

- **Date:** 2026-10-08
- **Status:** Accepted; backend/schema, frontend and integration harness ACCEPTED / COMMITTED. Scoped local frontend/backend/PostgreSQL integration final review ACCEPTED on 2026-10-10 (22/22 real tests operator-reported PASS, 258/258 independent database-free PASS). Real external email delivery and production HTTPS NOT VERIFIED; Phase 8 NOT STARTED.
- **Authority:** Accepted `T02A-AUTH-VERIFICATION-ARCHITECTURE-03`

### Context

At the decision checkpoint, the historical P2 authentication baseline separated
registration from email issuance and verified through a 24-hour link. T02A requires automatic initiation,
OTP-first completion, and recovery without a durable preverification session.
Credential-version binding alone cannot prevent pending-account pre-hijacking:
a victim could receive the latest challenge for an attacker-installed password.
Mailbox possession must therefore be paired with proof of the same current
password generation. Normal same-browser registration must not ask twice for
that password.

### Superseded and extended clauses

Historical ADR text remains unchanged. This ADR governs the accepted contract,
now implemented by the synchronized T02A schema/backend cutover and frontend.
Recording the decision itself did not establish implementation or runtime evidence.

| Prior decision | Superseded or extended clause | Preserved boundary |
| --- | --- | --- |
| `ADR-013` Decision/Consequences | Extend cookie credential vocabulary with a verification-only encrypted proof; require current password-snapshot/version revalidation before issuing authenticated or verification authority | Application authentication remains opaque PostgreSQL-backed `Session`/`stockwise_session`, with existing rotation, expiry, logout, and no browser JWT/refresh-token/web-storage authentication |
| `ADR-014` Decision/task ownership | Supersede verification's link-only 24-hour token and registration-without-delivery boundary with a unified ten-minute OTP/link challenge, automatic registration initiation, and two-proof completion | Provider abstraction, Resend/non-delivery selection, reset's 30 minutes, invitation's seven days, and their hash-only single-use boundaries |
| `ADR-017` Decision/Consequences | Supersede verification issuance being absent from registration; extend pending duplicates with atomic password replacement/version advancement and matching challenge/proof | Email/password-only registration, nullable profile, exact password/Argon2 policy, generic public response, canonical-email uniqueness, five-per-15-minute registration limit |
| `ADR-018` Decision/Consequences | Extend verification delivery budgeting to registration plus resend; add durable OTP attempts and share login's failure budget with the dedicated password-proof endpoint | Independent password-reset request budget, no reset-completion limiter, eligibility-independent charging, generic responses, and unresolved `OQ-020` |

`ADR-015`, `ADR-016`, `ADR-019`, `ADR-020`, and `ADR-021` keep their verified-user,
tenant, onboarding, invitation, and authorization boundaries. Reset eligibility
remains ACTIVE and verified only. No unverified-reset or magic-link login is added.

### Decision: three separate security concepts

1. **Authenticated application session:** ordinary verified-user login creates
   the existing hash-only PostgreSQL session and application cookie. Only this
   concept establishes authentication for protected APIs.
2. **Verification password-proof context:** installation/knowledge of one exact
   password generation, scoped only to verification. No `Session` row,
   `TrustedAuthenticationContext`, organization, membership, branch, role,
   permission, or authenticated API authority.
3. **Mailbox verification challenge:** OTP or link proves mailbox possession,
   not identity authentication or password knowledge.

Email verification requires both latter concepts while the user is ACTIVE and
unverified, revalidated under the transaction lock:

```text
proof.subject = challenge.userId = user.id
proof.credentialVersion = challenge.credentialVersion = user.credentialVersion
```

Mailbox possession alone MUST NOT activate an unproven current password.
Verification never creates or rotates an authenticated application session.
The post-verification destination is **Sign in**.

### Credential version and unified challenge

`User.credentialVersion` is the authoritative positive monotonic BIGINT,
initially `1`. Every committed password replacement, even identical-password
replacement, increments it together with `passwordHash`/`passwordChangedAt`.
No client value is authority; no wrap/reset is permitted. Challenge issuance
stores an immutable version; proof installation/verification establishes that
same version. Resend/verification never advance or upgrade it.

One challenge contains:

- Six uniformly generated ASCII decimal digits, including leading zeros.
- OTP HMAC-SHA-256 under a dedicated server-only key of at least 32 bytes;
  unambiguous input binds purpose/encoding version, user ID, challenge ID,
  credential version, and the exact code. Compare fixed-length MACs in constant
  time. Raw OTP is never persisted; plain SHA-256 is insufficient for its small
  search space under database-only compromise.
- A separate existing 32-byte CSPRNG/base64url secure-link credential, persisted
  only as SHA-256.
- One absolute ten-minute expiry and five durable wrong OTP comparisons.

Lifecycle: `OPEN` permits both methods; the fifth failed comparison transitions
to `LINK_ONLY`, preserving the link until expiry. Expiry is unusable regardless
of cleanup. Success consumes the whole challenge; `CONSUMED`, `REPLACED`, and
`REVOKED` are terminal. Nothing revives. One nonterminal challenge per user is
enforced by a partial unique index; issuance terminates expired open predecessors
too. OTP requests bind email and challenge ID so old digits cannot select a
successor. Either method's success invalidates both credentials.

**T02A-UX-REMEDIATION-01 narrow amendment (2026-10-11; user-approved):**
After successful verification by either OTP or link, an explicit POST of the
**same originally issued secure link** may return a read-only
`200 {data:{status:"already_verified"}}` instead of generic `INVALID_TOKEN`,
**only before its original ten-minute challenge expiry** (database time) and
only if its hashed token matches an existing nonlegacy challenge whose
`consumedAt` and `consumedVia` are set, whose `replacedAt` and `revokedAt`
are null, and whose user is ACTIVE, verified and at the same credential
version. The transaction locks and rechecks both challenge and user rows.
No cookie, session, OTP, challenge, proof or verification authority is created,
renewed, cleared or consumed on this informational replay. No GET inspection,
new public status endpoint, token reuse for authentication, or expiry extension
is authorized. Unknown/malformed, expired (including consumed-but-expired),
replaced, revoked, legacy, stale-version, disabled or unmatched links remain
indistinguishable generic `400 INVALID_TOKEN` without account state. The
original *single-use verification* property remains absolute; this exception
is only for a bounded confirmation message, and does not change OTP replay.

Wrong usable-challenge OTP comparisons count even without password proof.
Invalid mailbox material returns generic invalid-code/token outcomes regardless
of cookie validity, except the narrowly recognized informational consumed-link
replay defined above. Only valid, unconsumed mailbox material may reveal
`VERIFICATION_PASSWORD_PROOF_REQUIRED`; correct mailbox material with missing,
invalid, phantom, expired, mismatched, or stale proof is not consumed and does
not increment the failed-code count. This ordering avoids a real/phantom-cookie
account oracle.

### Stateless verification password proof

Use **AES-256-GCM authenticated encryption**, not a readable signed claim set,
JWT, opaque stored proof, or authenticated preverification session:

- Dedicated 32-byte encryption key, isolated from OTP, session, reset, link,
  analytics, and provider material and from other environments.
- Fresh 12-byte CSPRNG nonce and full 16-byte authentication tag per issuance.
- Versioned fixed-format encrypted claims: purpose, real/non-authorizing phantom
  marker, subject UUID, credential version, issued-at, and expiry.
- Absolute ten-minute lifetime; no sliding refresh or renewal from presenting
  the cookie. No proof table or replay database/cache.
- Associated data authenticates fixed purpose, configured public web origin,
  and format/key-ID header; no algorithm negotiation.

The fixed encoding is:

```text
base64url(format[1] | keyId[4] | nonce[12] | ciphertext[42] | tag[16])
```

The 42-byte payload is purpose[1], usable[1], UUID[16], version[8], issued-at[8],
and expiry[8], with integer claims encoded unsigned big-endian (version must
remain within positive signed BIGINT range). Total 75 bytes gives 100 unpadded
base64url characters. Timestamps are epoch milliseconds. Encryption prevents
stable subject/version claims from distinguishing real from phantom registration.
The nonce supplies per-issuance randomness; no additional replay nonce claim
or persisted replay counter is required.

Reject unsupported/malformed encoding, unknown/retired-invalid key, wrong
purpose/origin, authentication failure, invalid claim ranges/lifetime, issuance
over five seconds in the future, or `now >= expiresAt`. Lifetime is exactly
600,000 milliseconds for issuance and cannot exceed that on validation.
Use fresh server/database time at completion, not client time.

Keep current and previous proof keys. Retain a non-compromised previous key at
least 605 seconds after its last issuance; do not rotate again so as to discard
it early. Emergency removal deliberately invalidates proofs. Rotate before
2^24 encryptions under a key, counting phantom issuance too. Fleet accounting
and coordinated rotation are Phase 8 gates. Local/test isolated ephemeral keys
may invalidate proofs on restart; login/password fallback recovers safely.
Do not fall back to application-session or other credentials on key failure.

### Cookie, transport, and client continuation

`__Host-stockwise_verification_proof` is cookie-only: `HttpOnly`, **always**
`Secure`, `SameSite=Strict`, `Path=/`, no `Domain`, absolute lifetime at most
600 seconds with aligned `Max-Age`/`Expires`. Reject malformed or duplicate
matching cookie values. Clear using the same attributes and expired lifetime.
Never expose proof in JSON, URLs, local/session storage, or bearer headers.
Test actual localhost Secure-cookie compatibility; use local HTTPS if needed,
never remove `Secure`. This does not change the application-cookie development
exception. The initial email GET needs no proof cookie; the same-origin POST does.

Successful verification, ordinary verified login, and successful/idempotent
current logout or successful authenticated logout-all clear the browser proof.
Application revocation semantics remain unchanged; preserve multiple
`Set-Cookie` headers. Clearing does not globally revoke stolen stateless copies:
short expiry, live eligibility, version advancement, consumption, and key
invalidation bound them. Replay within the lifetime is accepted narrowly.
Tabs share one proof account per cookie jar; last response wins and may require
password recovery. Devices can hold independent proofs for the same version.

All proof-setting/using registration, login, fallback, resend, and completion
POSTs require JSON, an exact configured public `Origin` (missing/null/mismatched
is rejected), and rejection of cross-site Fetch Metadata before mutation,
limiter charging, or cookies. No alternate CORS authority. Preserve existing
logout protections; forbid cross-origin framing of the verification surface.

Keep `/verify-email?token=<opaque-token>`. GET/scanners never consume or issue
proof. Capture into component memory and scrub the URL immediately before
unrelated redirects/telemetry; consume only through explicit JSON POST.
Use `Referrer-Policy: no-referrer` and `Cache-Control: no-store` on the page/API.
Redact sensitive URLs, bodies, Cookie/Set-Cookie headers, credentials, and
provider payloads from logs, traces, analytics, and errors at every layer.
Disable transactional click/open tracking where applicable. Initial URL
exposure to mail/web infrastructure remains a residual; fragments require
later real provider/client compatibility evidence before adoption.

Only noncredential continuation `{version, canonicalEmail, challengeId, savedAt}`
may use memory/sessionStorage, with a 30-minute UI retention limit. No password,
OTP, raw link, proof, session token, or key. Normal register/login goes directly
to OTP without email or password re-entry. Valid mailbox proof with absent
password context offers inline current-password fallback; retain mailbox
material only in memory. Browser reopen/lost state recovers through Login.
Refresh does not resend or renew proof. Preserve shadcn/ui, Light/Dark, EN/TH,
keyboard/accessibility, and responsive behavior.

### Registration, login, resend, and reset

Preserve email `.trim().toLowerCase()` and existing validation, exact 15–128
Unicode-code-point passwords, and accepted Argon2id policy. All valid permitted
registration paths perform the expensive hash before eligibility lookup.
No existence pre-read before hashing or synthetic delay. Generic `202` always
has the same body structure, same-format selector, and fresh same-shaped real
or encrypted phantom proof cookie. Phantom claims have usable=false, a fresh
random UUID subject, version `1`, and the same timestamp/encoding/key family;
they cannot complete verification. Neither outcome asserts account creation,
password change, or delivery.

- **Initial admitted registration:** atomically create pending user/password,
  version `1`, matching challenge, and prepare real proof. Emit cookie after
  commit and initiate mail after response completion.
- **Initial admission suppressed:** still create pending user/password/version,
  matching challenge immediately `REVOKED / DELIVERY_SUPPRESSED`, and real proof
  of the installed password. Send nothing; discard transient mailbox credentials.
  Later login/resend recovers.
- **ACTIVE/unverified duplicate admitted:** under user lock atomically replace
  password, advance version/timestamp, supersede open material, create matching
  successor, and prepare real proof.
- **Duplicate admission suppressed:** no password/version/challenge change;
  generic phantom continuation. Verified/disabled duplicates likewise never
  mutate pending credentials or deliver.

Prepare required cryptography before commit; failure rolls back credential
mutation. Provider failure after commit never rolls back the password/version.

Login and `POST /auth/verification-password-proof` share the existing five
credential failures per canonical email per fixed 15-minute process-local
window, using the same limiter instance. Wrong/missing credentials are generic
`INVALID_CREDENTIALS` and count; correct disabled/ineligible credentials remain
generic and non-counting. Missing accounts use the fixed dummy verifier.
Success does not reset the window.

Correct ACTIVE/unverified login returns `verification_required`, a real proof,
and current usable selector or null; no Session, `stockwise_session` issuance/
rotation/revocation, or automatic email. Correct ACTIVE/verified login retains
ordinary authentication. Revalidate the password snapshot/version under the
user lock before either authority; concurrent change fails closed.

The dedicated password-proof fallback accepts only `{email,password}`, never
creates an application session/challenge/mail, and uses real/dummy verification
plus locked version revalidation. Correct pending credentials return accepted
with real proof; correct verified credentials return the same accepted shape
with phantom proof. It cannot turn cross-device completion into ordinary login.
No public proof/status endpoint is introduced.

Resend charges the shared verification-delivery budget and, if admitted,
atomically issues against the current version after supersession. It never
creates, refreshes, clears, or upgrades password proof. A stale proof stays stale.
Known-flow email comes from continuation data; ineligible outcomes stay generic.

Reset remains ACTIVE/verified-only, hash-only 30-minute single-use, with cheap
token rejection before Argon2 and no authenticated session on completion.
Its transaction additionally advances version and invalidates open verification
material with password update, reset consumption, and all-session revocation.

### Delivery, locking, and admission

Registration retains five attempts per canonical email per 15 minutes.
Registration-triggered verification and resend share three syntactically valid
delivery requests per canonical email per fixed 15 minutes, charged before
eligibility/provider work, storing only SHA-256-derived keys. Registration
delivery-budget exhaustion remains generic `202`; explicit resend exhaustion
returns `429`/`Retry-After`. Forgot-password keeps its independent three-request
budget, and reset completion adds no limiter. OTP's five failures are durable,
not reset by process restart; random/stale selectors cannot affect successors.

Reserve capacity before pending duplicate replacement: at most 32 outstanding
verification dispatch reservations per API process, no waiting queue. Known
capacity rejection leaves existing material unchanged and stays generic.
Delivery is after commit and response finish, ten-second timeout, no automatic
retry/outbox. Track/catch promises, release reservations on every exit/abort,
bound shutdown draining, and skip known stale/expired jobs before sending.
Exact-challenge failure compensation cannot revoke successors or resurrect
predecessors. Crash-window loss is accepted best effort; resend is recovery.
Emails contain OTP plus secure link, ten-minute expiry, latest-request
supersession wording, do-not-share guidance, and ignore-unsolicited guidance;
never send password proof. Out-of-order arrivals do not change database authority.

Canonical password/verification/reset lock order is **user first, challenge/
token second**. Preliminary lookups prove nothing; reread after locking using
fresh database time. No Argon2 or provider call under locks. Attempt transitions,
completion plus `emailVerifiedAt`, duplicate replacement, and reset transitions
are atomic. Competing OTP/link/registration/resend operations either serialize
or fail closed; at most one verification success.

### Alternatives and accepted consequences

- Version-only mailbox completion was rejected: latest attacker-generated mail
  can activate an attacker-known password. Both current-version proofs are needed.
- A second password prompt on every verification was rejected for normal UX.
  Short-lived installation/knowledge proof supplies the same requirement.
- Stored opaque proof was rejected: adds lifecycle/cleanup state without a
  demonstrated revocation need beyond current version/eligibility.
- Readable signed claims were rejected for enumeration leakage; authenticated
  encryption keeps real/phantom contents indistinguishable in public encoding.
- OTP plain hashing was rejected for offline enumeration; HMAC separates
  database-only compromise from the server key. Joint key/database compromise
  remains outside that protection.
- Fragment links remain unselected without delivery/client evidence.
- External email atomicity, durable queue, and indefinite proof renewal are
  unnecessary for the accepted pre-cloud best-effort scope.

Proof-cookie theft alone is insufficient; combined mailbox/proof theft can
verify within the window. HttpOnly does not neutralize same-origin XSS.
Duplicate registration deliberately accepts request-bounded disruption over
takeover, without a guaranteed maximum disruption duration. Mailbox controllers
can legitimately re-register their own pending password; this is not MFA or
protection against full mailbox/browser compromise.

Required implementation acceptance includes pre-hijacking scenarios (old proof/
latest challenge fails; mailbox-only fails; legitimate replacement succeeds;
cross-device requires current password), phantom/error-ordering tests, crypto/
cookie/Origin negatives, version/supersession/attempt/reset/compensation races,
secret-safe telemetry, measured timing distributions, real browser transport/
refresh/reopen/multiple-tab behavior, and localized accessible UX. No such runtime
verification is claimed by recording this ADR.

Fleet-wide rate limits, IP/network/global/provider controls, trusted proxy
policy, production secret-manager/IAM integration, distributed key rotation/
usage accounting, capacity/DoS targets, and reliable outbox remain Phase 8 under
`OQ-015`/`OQ-020`. Single-process budgeting is not production-readiness approval.
At acceptance, schema/migration work required separate authorization before runtime
cutover. The committed T02A forward migration now invalidates legacy open links
while preserving terminal history. Deploy that migration with the matching backend
and dedicated keys. Scoped local real integration received separate acceptance on 2026-10-10; production deployment remains a distinct, unexecuted gate.

## ADR-035 — Adopt self-hosted Better Auth native sessions with StockWise-owned identity and authorization

- **Date:** 2026-10-12
- **Status:** Accepted decision; migration and runtime cutover NOT IMPLEMENTED / NOT VERIFIED by this ADR
- **Authority:** Explicit owner approval on 2026-10-12 for Better Auth native sessions and the bounded ADR/migration-plan task

### Context

The owner accepted replacing StockWise's custom session implementation with
self-hosted Better Auth on the existing Express API, using Prisma 7 and
PostgreSQL. Current accounts are test-only and their authentication credentials
are disposable; StockWise `User.id` UUIDs, domain records, and all foreign-key
references are not disposable. Migration must preserve them.

The owner reports that M0 proof A, native password signup before OTP, permits
pre-hijacking: a victim's mailbox proof activates an attacker-chosen password.
That composition is forbidden. The reported M0B proof recorded 31 PASS and
2 FAIL: native session-token persistence conflicted with the old hash-only
policy, and native OTP sign-in created a session. These are proof findings,
not verification of the actual StockWise root or permission to expose an OTP
registration session.

### Alternatives considered

1. Retain the custom hash-only session runtime.
2. Adapt Better Auth to the legacy hash-only session implementation.
3. Adopt Better Auth native opaque database sessions, retaining StockWise's
   identity, tenancy, and authorization boundaries.

### Decision

Accept option 3. Better Auth is self-hosted inside the existing Express API;
Prisma 7/PostgreSQL remain the persistence stack. StockWise owns stable
`User.id` UUID identity, disabled-user state, Organization/Branch relationships,
memberships, branch assignments, and deny-by-default RBAC. Better Auth session
identity does not independently grant business access. Do not replace these
boundaries with Better Auth organization/role authority or a second user identity.

Resend remains behind the existing production/non-delivery/test provider
configuration under `ADR-014`; tests never send real mail. No external delivery
or deployment is authorized by this decision.

#### Narrow supersession and effective date

For the future Better Auth runtime **only after an explicitly gated cutover**,
supersede `ADR-013`'s hash-only session-credential persistence and custom session
lifecycle implementation, and `ADR-034`'s authenticated-application-session
implementation concept, with Better Auth native database-persisted opaque
session tokens. This exception is for session credentials only, not passwords,
OTP, verification links, reset tokens, or invitation tokens. Earlier ADR text
remains historical and unchanged. The existing runtime retains its current
contract until cutover; this ADR is not evidence that it has migrated.

No JWT browser authentication, refresh-token flow, browser credential storage
in localStorage/sessionStorage, or second credential transport is introduced.
Session expiry, rotation, revocation, and reset guarantees require an explicit
compatibility mapping and real verification; selecting native lifecycle does
not silently approve weaker product guarantees.

#### Required compensating controls

- HttpOnly, host-only session cookies with `Path=/`, `SameSite=Lax`, and Secure
  cookies over HTTPS in production; validate the actual browser/proxy path.
- Same-origin CSRF/Origin checks before auth or cookie-authenticated mutations.
- Server auth secret outside the database, with least-privilege access to
  database session records, backups, and credentials.
- No session tokens or other credentials in logs, URLs, errors, traces,
  analytics, or client-visible response bodies.
- Explicit current-session and all-session revocation, including password-reset
  revocation; reject expired/revoked sessions and fail closed on dependency errors.
- Backend revalidation of ACTIVE/verified/completed-registration user state
  before trusted application context, followed by fresh StockWise access-context,
  membership, branch, and role authorization. Initial Better Auth cookie cache
  is OFF; cached cookie claims cannot bypass deauthorization.

These are acceptance requirements, not controls automatically satisfied by
installing Better Auth. Raw persisted session tokens increase database/backup
disclosure risk relative to hash-only storage. A separate server secret does
not encrypt those records or make stolen tokens harmless; the owner accepts
that trade-off subject to verified controls.

#### OTP-first registration boundary

M0B is the required candidate composition for implementation validation:
Better Auth emailOTP proves mailbox ownership first and creates an internal
authenticated session on the server; native `setPassword` is then used only
for a never-password user, followed by `signOut` before the HTTP response.
Public `signUp.email`, `signIn.emailOtp`, and `setPassword` must be disabled.
No registration auth cookie or token reaches the browser; the user explicitly
signs in afterward. The internal registration session must never construct
StockWise trusted application context or grant protected-API access.

This is custom orchestration of native operations, **not** a fully native
no-session OTP operation. Native session approval resolves the reported
hash-only policy conflict; it does not resolve the need for this composition.
Failure atomicity, crash/outage recovery, retries, stale passwordless users,
idempotency, races, and durable session cleanup remain unverified cutover gates.
Response cookie suppression or best-effort `finally` cleanup alone is insufficient.

Preserve anti-pre-hijacking, generic duplicate/no-enumeration responses,
no auto-login, protected OTP storage, rate limits, reset/invitation semantics,
and scanner-safe verification. Any incompatibility beyond the narrowly
superseded session implementation, including the M0B ordering versus
`ADR-034`'s version-bound proof/challenge contract, requires an explicit
separate decision before runtime cutover; do not silently relax `ADR-034`.

### Why selected

Native session handling avoids maintaining a second custom session mechanism
inside Better Auth. Retaining StockWise identity and server authorization avoids
domain-data migration and tenant/RBAC reinterpretation. The accepted trade-off
is recoverable session credentials in persistence plus mandatory verification
of compensating controls and registration orchestration.

### Consequences and gates

The bounded design is [Better Auth migration](../development/BETTER_AUTH_MIGRATION.md).
Only D0 records an accepted decision here. D1–D5 require implementation,
compatibility decisions where needed, and independent verification before
cutover. No dual live auth, destructive migration, user-UUID replacement,
production deployment, package installation, live development database change,
or external provider execution is authorized by this documentation task.
Topic-owned Source of Truth and HTTP contracts must be synchronized in the
authorized implementation before cutover, not rewritten as already implemented.

## ADR-036 — Use password-first pending registration for Better Auth migration

- **Date:** 2026-10-12
- **Status:** Accepted decision; isolated implementation and verification pending
- **Authority:** Explicit owner approval on 2026-10-12 for the D3 registration-order/proof change only

### Context

ADR-035 selected Better Auth native sessions but its proposed M0B registration
composition installs a password only after mailbox OTP and uses a server-internal
Better Auth session. That order is incompatible with ADR-034's version-bound
password proof and its unified OTP/link completion contract. A mailbox challenge
must not activate a password selected by someone who only controls the mailbox.
Registration also must not create or alter an existing StockWise user before
both independent proofs succeed.

### Decision

For the isolated D3 registration path, accept password-first pending
registration. Validate the existing email/password contract, derive the
Argon2id PHC hash using the accepted policy, and store it only in a standalone
pending-registration record. Do not create an active `User`, write
`User.passwordHash`, or create a Better Auth credential account before
completion. The pending record has a UUID subject, canonical unique email, and
positive credential version, initially `1`. Every fresh registration creates a
new version-bound challenge; a fresh registration for the same pending email
advances its credential version. Real OTP/link proof is bound to the pending
subject and credential version.

Completion requires both mailbox possession and proof of the exact submitted
password generation. The same browser can use its encrypted, short-lived
password-proof cookie; a different device must explicitly prove the current
password. Neither proof can be upgraded or refreshed by resend. Completion
promotes the pending UUID and already-computed Argon2id hash directly to the
Better Auth credential account in the same database transaction that consumes
the challenge and creates the StockWise `User`. Do not pass the encoded hash to
Better Auth `setPassword` as if it were a raw password; the credential account
must receive the stored hash directly. No session, automatic login, or
authenticated application authority is created. The user signs in explicitly
afterward.

Retain ADR-034's mailbox-first error precedence, OTP HMAC protection, secure
link hash, absolute ten-minute challenge expiry, five wrong-code attempts,
`LINK_ONLY` transition, single-use OTP/link rules, and narrowly bounded
informational replay of a consumed link before the original expiry. Invalid
mailbox material remains generic regardless of password proof; only valid
mailbox material with missing, invalid, or stale password proof may produce
the proof-required result. Resend rotates only the challenge, preserving the
pending password hash, credential version, and absolute ten-minute expiry; it
does not install a password, renew a proof, or extend registration lifetime.
Do not resend, replace, or otherwise mutate any existing StockWise user,
including unverified users.

Use durable fixed-window quotas: five registration attempts, three verification
delivery requests, and five credential failures per canonical email per
15-minute window. Credential snapshot checks do not charge failures or reset
the failure counter; credential-proof failures increment it. No proof, challenge,
or pending state authorizes protected API access.

### Narrow supersession

This ADR supersedes ADR-035's M0B ordering and server-internal Better Auth
registration-session/setPassword composition for D3 registration only. It
supersedes ADR-034 only to the extent that registration stages its hash and
proof in a standalone pending record instead of an active `User`; its
mailbox-proof, OTP/link, attempt, expiry, replay, transport, and delivery
protections remain in force. Reset retains its 30-minute single-use lifecycle;
invitations retain their seven-day hash-only single-use lifecycle. It does not
supersede ADR-035's accepted native session direction or its security controls,
nor any existing-user, UUID, domain-FK, tenancy, or authorization guarantees.
ADR-034 and ADR-035 remain unchanged historical records.

### Consequences and gates

The accepted design is isolated and non-live: the D3 router is separately
exported and is not mounted. Pending registration and durable quota storage
require additive tables and a forward-only migration; no live migration,
database mutation, external mail delivery, deployment, or authentication
cutover is authorized here. Implementation and verification remain pending;
restart/outage/retry recovery and independent protected-API exclusion evidence
remain required before cutover. D1/D2 evidence and earlier M0/M0B reports remain
historical and are not D3 evidence. Preserve `BETTER_AUTH_NATIVE_ENABLED=false`.
Prove that Better Auth 1.7.7's configured password verifier accepts the
directly promoted Argon2id PHC hash. Its native `setPassword` API hashes a raw
password and is not a valid promotion path.

## ADR-037 — Minimal organization name settings

- **Date:** 2026-10-25
- **Status:** Accepted
- **Authority:** Explicit owner approval for Product-ACCOUNT-01 completion

### Context

Organization GET was planned and PATCH field/permission details were blocked.
The existing Organization has a 200-character name but no business contact
fields. Existing `organization-settings.manage` grants OWNER/ADMIN authority.
The historical external name-only proposal remains unchanged evidence.

### Decision

Accept only GET/PATCH `/api/v1/organizations/{organizationId}` under the existing
capability, requiring active verified actor, active same-organization membership
and active organization. Return only id/name/updatedAt. PATCH accepts only
edge-trimmed nonblank name (maximum 200, Unicode/internal whitespace preserved,
duplicates permitted) and exact prior millisecond UTC expectedUpdatedAt.
Revalidate authority at the mutation boundary; atomically compare/update and
return the written row with a strictly advancing version. Conflicts return
409 ORGANIZATION_STALE. Preserve no-store and same-origin cookie protection.
The exact HTTP contract is owned by `docs/contracts/API.md` §7.

### Consequences

The name-only editor decision gate is closed. No schema/migration is needed.
VAT, timezone, status, ownership, membership, credentials, sessions, contact,
tax/legal and billing fields are not editable. Branch Settings retains branch
phone/address. Product-ACCESS-01 and Native Live are not authorized by this ADR.

## ADR-038 — Preserve invitation onboarding with isolated encrypted continuation

- **Date:** 2026-10-26
- **Status:** Accepted design; implementation verification and independent acceptance tracked externally
- **Authority:** Explicit Product-INVITE-UX-01 OWNER DECISION approving Option 1

### Context

The invitation bootstrap scrubs the URL and keeps the credential only in component
memory. Auth navigation loses it; memory alone cannot survive reload or same-tab
verification-link document replacement. The invitation hash cannot reconstruct
the original credential needed for acceptance.

### Decision

Allow authenticated-encrypted HttpOnly continuation cookies, selected by separately
owned per-tab flow IDs. Each has a 30-minute absolute maximum bounded by invitation
expiry, Secure/HttpOnly/Strict host-only transport, dedicated AES-256-GCM key,
purpose/origin/flow binding and fresh-session binding. Browser-wide cookies are
not tab-specific: requests require the tab selector and matching cookie, with
exclusive document ownership rejecting concurrent cloned selectors. Unsupported
storage/ownership fails closed. API §7 owns exact transport and cleanup details.

This narrowly extends ADR-021's transient transport: an encrypted credential copy
may persist in the HttpOnly cookie, never raw in web storage, history/router state,
logs or UI. Preserve hash-only database persistence, seven-day invitation expiry,
replacement/revocation, single-use membership creation, same-user read-only replay,
email binding, organization locks, role/branch/tenant authorization and provenance.
No new authentication authority or public acceptance-by-email/ID is introduced.

Verification still requires both accepted proofs and ends at explicit Sign in.
Flow-aware successful sign-in resumes the invitation; explicit Accept alone
creates membership. Navigation uses the returned membership organization, never
implicit organization creation. Ordinary OWNER onboarding remains unchanged.

### Consequences and gates

No database schema change is approved or required. Dedicated server key
provisioning is required; replacement invalidates outstanding continuations.
Logout, account switching and browser-wide session changes invalidate old flow
bindings. Cancellation removes continuation, not the original invitation;
there is no durable stateless-envelope blacklist. Existing session and invitation
checks remain mandatory on every protected use.

Cookie-capacity remediation replaces dynamic flow-named issuance with four fixed
encrypted slots (API §7), each with a 512-byte value bound. This independently
bounds namespace growth under overlapping requests. Exact slot/name/flow AAD
prevents substituting another invitation; ordinary browser mutations coordinate
under a separate origin-wide Web Lock without treating it as a cookie-store CAS.
The owner explicitly selected fail-closed original-link recovery after interrupted-
write collisions: an otherwise valid affected tab may need its original invitation
or admin reissue. This is a scoped availability tradeoff, not new authentication,
acceptance or tenant authority. Four ordinary independent flows remain supported;
session-transition invalidation remains intentional. Legacy dynamic cookies are
invalidated with bounded cleanup, not positively migrated/reissued. Existing
oversized jars require explicit browser recovery/expiry and old-writer drain.

Crypto/API/security and real browser regressions must prove OTP/link/reload
navigation, tab ownership, explicit actions, wrong-account/session rejection and
unchanged authorization. No real sends, Native Live, D5-P5, AWS, commit or push.
Independent acceptance and separate publication authorization remain required.

## 2. Explicitly superseded planning directions

The current ADRs supersede these earlier, unimplemented ideas:

| Earlier direction | Current accepted direction |
| --- | --- |
| FastAPI/Python backend | Express.js + TypeScript (`ADR-001`) |
| Python ML service now | TypeScript/SQL analytics and Forecasting V1 (`ADR-006`) |
| LLM/AI predicts product demand | Deterministic system forecast; OpenRouter summarizes only (`ADR-006`, `ADR-007`) |
| User-triggered AI generation | Scheduled daily/weekly/monthly/yearly persisted reports (`ADR-007`) |
| Google login in core MVP | Email/password + Argon2; Google future (`ADR-010`) |
| Multi-branch later | Organization -> Branch from the beginning (`ADR-003`) |
| Expense/accounting as part of scope | Retail sales/inventory/purchasing focus; expense/accounting non-goals (`BUILD_SPEC.md`) |

No implementation exists from the superseded directions in the current repository.
