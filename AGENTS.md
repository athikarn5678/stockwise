# StockWise Agent Guide

This file is the execution contract for human and AI developers working in the `stockwise` repository. Read it before every task.

| Field | Value |
| --- | --- |
| Documentation baseline | Architecture Freeze v1 |
| Last updated | 2026-10-08 |

## 1. Project overview

StockWise is a responsive, cloud-based retail platform for SMEs. It covers organization-level product and supplier management; branch-level inventory, purchasing/receiving, POS, and sales; deterministic analytics and forecasting; and scheduled aggregate summaries through OpenRouter.

The repository contains the repository/tooling foundation; identity, tenancy, authentication, onboarding, branch, invitation, and membership workflows; organization-scoped Catalog and Supplier persistence/API/UI; branch inventory balance/history/manual-adjustment persistence/API/UI; Purchase Order and Receiving persistence/API/UI; P5-M1 Sales persistence; P5-M2 atomic checkout, POS API, and responsive POS UI; complete P5-M3 Sales History list/detail/browser-receipt API/UI; the P5-M4 linked immutable refund persistence/service/API/history/UI workflow with optional per-item same-branch restock; the complete Phase 6 analytics, forecasting, reorder, and synthetic demo dataset work; `ADR-028` excludes VOID from V1, `ADR-029` defines Analytics V1 metrics/reporting time, `ADR-030` accepts the implemented fixed V1 coverage-based stock classification, `ADR-031` resolves `OQ-012` for Forecasting V1, and `ADR-032` accepts advisory Reorder V1 policy. Per `PROJECT_PLAN.md`, Phase 6 is complete; Phase 7 is complete under `ADR-033`; Milestones 7.1–7.3 are complete; P7-M1-T01/P7-M1-T02, P7-M2-T01/P7-M2-T02/P7-M2-T03, and P7-M3-T01/P7-M3-T02/P7-M3-T03 are complete. Milestone 7.4 is COMPLETE with an explicitly accepted MT-L04 verification limitation: T01/T02 verified/accepted; historical T03 execution concluded / NOT ACCEPTED at its original checkpoint (250 PASS/7 FAIL/3 BLOCKED/0 N/A/0 pending=260); REM-01 committed at cf222654767db7b183e87ea236d0218805dd0271 and REM-VERIFY-01 verifies all eight findings fixed, M11/P08 PASS. MT-L04 remains BLOCKED with user-accepted tooling-observation limitation; native layout/clipping/scaling/pagination/blank-page behavior remains unverified. Final post-remediation acceptance is satisfied with that limitation; PRE-CLOUD READY YES for the local Phase7 gate; see the external P7-M4 acceptance record. Phase 8 is started only for the time-limited AWS Academy Learner Lab demo. Its topology is `ADR-040` (ALB + ACM, optional CloudFront, ECS on EC2 with an Auto Scaling Group across two AZs, RDS PostgreSQL Multi-AZ, two NAT gateways, Secrets Manager, ECR, S3, CloudWatch; exactly one application task while the login limiter is process-local), which supersedes the `ADR-039` Compose/Caddy topology. Better Auth Native Live is required (D-03R supersedes the earlier Legacy-only choice); D5-P5 Native Live activation is in progress and not accepted. The ADR-040 deployment source (`infra/learner-lab`: Terraform, ECS task definitions, images, operator scripts; `.github/workflows/learner-lab-images.yml`) is implemented and verified locally only. Codex's independent reviews returned NEEDS FIX three times; the third review retained two P2 findings. The owner authorized Codex to implement remediation R3 for those two findings only. R3 awaits a separate independent review and is not accepted. Nothing is published or provisioned. Forecast/Reorder API/UI is implemented; `STOCKOUT_RISK` remains deferred/unassigned. The P7-M2-T01 OpenRouter provider adapter, P7-M2-T02 prompt/data-minimization layer, P7-M2-T03 idempotent insight job/persistence, P7-M3-T01 callable cadence orchestrator, P7-M3-T02 persisted insight API, and P7-M3-T03 dashboard UI are implemented; the runtime timer, generic accounting/tax/audit systems, and production infrastructure remain unimplemented. Do not treat later planned directories, commands, schemas, endpoints, or features as existing code.

## 2. Read before changing anything

1. Read this file.
2. Inspect the actual repository, current branch/status if Git exists, and existing implementation.
3. Read the authoritative document for the task:
   - Product scope/open questions: `BUILD_SPEC.md`
   - Architecture: `docs/architecture/ARCHITECTURE.md`
   - Data: `docs/architecture/DATABASE.md`
   - Analytics/formulas: `docs/contracts/ANALYTICS.md`
   - Behavior: `USE_CASE_SPECS.md`
   - HTTP contracts: `docs/contracts/API.md`
   - Delivery order/status: `PROJECT_PLAN.md`
   - Decision rationale: `docs/architecture/DECISIONS.md`
4. Search for existing code and tests before creating new abstractions.
5. Identify any blocking Open Question by its `OQ-*` ID. Do not guess its answer.

### Documentation location policy

Canonical system/project documentation required to understand, build, maintain, or operate the source code stays in the repository. Task execution, evidence, verification, acceptance, audit, remediation, and disposition records go to the external StockWise Obsidian project records. All Phase 7 and post-Phase-7 (`P7*`) task/evidence Markdown records belong in Obsidian, not repository `docs/`. Historical Phase 7 task/evidence records are maintained in the external StockWise Obsidian project records. Canonical Git references use the rewritten history; original commit identities remain provenance in the external migration index.

## 2.1 Critical Domain Decision Gate

`ADR-042` (owner decision 2026-10-30) removes INVENTORY_STAFF Catalog, Supplier,
Purchase Order/Receiving and Forecast/Reorder access. Inventory and non-cost
Inventory Analytics remain authorized. Inventory's own product projection needs
no Catalog exception. Other roles and ADR-041 single active OWNER governance/index
are unchanged. Demo30d seeding is disposable-local-only (a Production demo uses only the separate operator-only `provision-demo` action of `ADR-043`, which creates a new isolated organization and needs per-run owner approval); Demo Insight requires an
explicit synthetic Organization UUID allowlist, uses real metrics, is labeled
`Demo Insight` / `ข้อมูลตัวอย่าง`, and makes no provider calls or fake provider rows.
Independent review remains required before publication/deployment.

Repository/tooling work, application shells, and other unrelated foundation work may proceed when their own blockers are resolved. Significant business-domain implementation must not proceed until the decisions affecting that domain are accepted.

At minimum, enforce these gates:

- Identity/onboarding/authorization follow `ADR-013`–`ADR-021` and the superseding verification contract `ADR-034`. T02A's synchronized forward schema migration and backend/security cutover are implemented; T02A-AUTH-VERIFICATION-WEB-01 implements the OTP/link/password-proof frontend, with independent frontend acceptance review accepted; scoped local frontend/backend/PostgreSQL integration was independently accepted on 2026-10-10 (22/22 real-response scenarios reported PASS; 258/258 database-free checks independently rerun); real external email delivery and production HTTPS remain unverified. Deploy the migration with the matching backend and dedicated verification keys, never with legacy verification writers. Historical P2 task descriptions below are implementation provenance, not the current verification runtime.
- Inventory mutations: `ADR-024`; quantity representation is accepted by `ADR-022`
- POS/sales monetary behavior: `ADR-027` plus `ADR-016`, `ADR-022`, `ADR-024`, and `ADR-026`; `OQ-008` is resolved
- Refund behavior: `ADR-028` plus `ADR-016`, `ADR-022`, `ADR-024`, `ADR-026`, and `ADR-027`; `OQ-009` is resolved and VOID is excluded from V1
- Purchasing/receiving behavior: `ADR-024`, `ADR-026`; quantity representation is accepted by `ADR-022`
- Analytics periods/base metrics: `ADR-029`; fixed Branch/Product coverage
  classification: `ADR-030`; Forecasting V1: `ADR-031` (`OQ-012` resolved);
  stockout risk still requires a separate accepted policy; reorder follows `ADR-032` plus any
  metric-specific dependency documented in `docs/contracts/ANALYTICS.md`
- Learner Lab demo hosting and its IAM exception: `ADR-040` (superseding the `ADR-039` topology); real-production
  hosting remains `OQ-015`/`OQ-020`

The accepted MVP roles are `OWNER`, `ADMIN`, `BRANCH_MANAGER`, `INVENTORY_STAFF`, and `CASHIER`. Authorization is fixed, deny-by-default RBAC from `ADR-016` and `BUILD_SPEC.md` section 8: a user has one organization role per organization; `OWNER`/`ADMIN` have organization-wide branch access; the remaining roles need explicit branch assignments. The Express API, not the frontend, is the security boundary. At least one OWNER must remain. `ADR-028` allows refund creation only for `OWNER`, `ADMIN`, and assigned `BRANCH_MANAGER`; authorized `CASHIER` may view refund records but cannot create them, and `INVENTORY_STAFF` has no refund access.

`OQ-017`/`OQ-018` are resolved for Scheduled AI V1 by `ADR-033`. Other cloud/operations questions `OQ-015`, `OQ-019`, and `OQ-020` remain phase-specific and do not block Repository Foundation or unrelated domain work.

## 3. Accepted technology baseline

| Concern | Choice |
| --- | --- |
| Repository | One `stockwise` pnpm workspace; `apps/web`, `apps/api`, and justified `packages/*` |
| Runtime/package manager | Node.js 24 LTS (minimum/CI 24.21.0) + pnpm 11.19.0 |
| Frontend | Next.js + TypeScript |
| Backend | Express.js + TypeScript |
| API | REST under `/api/v1` |
| Database | PostgreSQL |
| ORM/migrations | Prisma |
| Validation | Zod |
| UI | Tailwind CSS + shadcn/ui |
| Charts | Recharts |
| Server state | TanStack Query |
| Password hashing | Argon2 |
| AI | OpenRouter, scheduled aggregate summaries only |
| Cloud | AWS: RDS PostgreSQL, S3, VPC, CloudWatch, EventBridge; SQS only if justified |
| Packaging/CI | Docker + GitHub Actions |

P7-M4-T01 accepted Node 24.21.0, Next.js/Next ESLint plugin 16.3.8,
PostgreSQL 16.15-alpine, and API/web Node types 24.19.0. Other direct
dependencies remain pinned; selected compatible transitive security fixes and
the two deferred Prisma MySQL-tooling advisories are recorded in
the external P7-M4-T01 baseline record. The baseline is verified and accepted;
P7-M4-T02 completed fresh automated regression; see the external P7-M4-T02 regression record
for evidence and the pre-existing refund FK-name mismatch. Historical T03 execution concluded with 250 PASS, 7 FAIL, 3 BLOCKED and 0 pending; original acceptance NOT MET remains historical in the external P7-M4-T03 UAT record. Later verified remediation, M11/P08 PASS and explicit user acceptance of L04 as a BLOCKED tooling-observation limitation satisfy the final canonical review: P7-M4 COMPLETE, PRE-CLOUD READY YES; Phase8 NOT STARTED at that review. See the external P7-M4 acceptance record; native print-preview behavior remains unverified.

Do not introduce Python, FastAPI, microservices, Kubernetes, another database, GraphQL, another ORM, or a second frontend/backend framework without an accepted architecture decision.

## 4. Project structure

### Historical foundation structure snapshot

The following tree records the repository at the earlier foundation stage; it is
not an exhaustive description of the current repository structure:

```text
.github/workflows/ci.yml
package.json
pnpm-workspace.yaml
pnpm-lock.yaml
.env.example
.gitignore
.gitattributes
compose.yaml
tsconfig.base.json
tsconfig.json
eslint.config.mjs
prettier.config.mts
.prettierignore
vitest.config.mts
test/smoke.test.ts
apps/web/package.json
apps/web/components.json
apps/web/next.config.ts
apps/web/postcss.config.mjs
apps/web/tsconfig.json
apps/web/src/environment.ts
apps/web/src/app/layout.tsx
apps/web/src/app/page.tsx
apps/web/src/app/onboarding/page.tsx
apps/web/src/app/app/page.tsx
apps/web/src/app/app/branches/page.tsx
apps/web/src/application-context.ts
apps/web/src/branch-api-client.ts
apps/web/src/components/app-shell.tsx
apps/web/src/components/application-context-shell.tsx
apps/web/src/components/branch-management.tsx
apps/web/src/components/auth/onboarding-form.tsx
apps/web/src/providers/query-provider.tsx
apps/api/package.json
apps/api/tsconfig.json
apps/api/tsconfig.build.json
apps/api/prisma/schema.prisma
apps/api/prisma/migrations/20260822104545_identity_tenancy_schema/migration.sql
apps/api/prisma/migrations/20260824120921_make_user_display_name_nullable/migration.sql
apps/api/prisma/migrations/20260824173000_first_organization_onboarding/migration.sql
apps/api/prisma/migrations/20260825120000_category_product_schema/migration.sql
apps/api/src/environment.ts
apps/api/src/logger.ts
apps/api/src/app.ts
apps/api/src/server.ts
apps/api/src/main.ts
apps/api/src/prisma/identity-tenancy-schema.test.ts
apps/api/src/modules/identity/authorization-policy.ts
apps/api/src/modules/identity/authorization-policy.test.ts
apps/api/src/modules/identity/password-hasher.ts
apps/api/src/modules/identity/password-hasher.test.ts
apps/api/src/modules/identity/registration-limiter.ts
apps/api/src/modules/identity/registration-limiter.test.ts
apps/api/src/modules/identity/registration-repository.ts
apps/api/src/modules/identity/registration-repository.test.ts
apps/api/src/modules/identity/registration-service.ts
apps/api/src/modules/identity/registration-service.test.ts
apps/api/src/modules/identity/registration-router.ts
apps/api/src/modules/identity/registration-router.test.ts
apps/api/src/modules/identity/registration.integration.test.ts
apps/api/src/modules/identity/credential-schemas.ts
apps/api/src/modules/identity/login-limiter.ts
apps/api/src/modules/identity/login-service.ts
apps/api/src/modules/identity/login-router.ts
apps/api/src/modules/identity/session-token.ts
apps/api/src/modules/identity/session-cookie.ts
apps/api/src/modules/identity/session-configuration.ts
apps/api/src/modules/identity/authentication-repository.ts
apps/api/src/modules/identity/authentication-context.ts
apps/api/src/modules/identity/authentication.integration.test.ts
apps/api/src/modules/identity/credential-lifecycle-repository.ts
apps/api/src/modules/identity/credential-lifecycle-service.ts
apps/api/src/modules/identity/credential-lifecycle-router.ts
apps/api/src/modules/identity/email-request-limiter.ts
apps/api/src/modules/identity/one-time-token.ts
apps/api/src/modules/identity/email-provider.ts
apps/api/src/modules/identity/email-provider-configuration.ts
apps/api/src/modules/identity/credential-lifecycle.integration.test.ts
apps/api/src/modules/identity/first-organization-onboarding-schema.ts
apps/api/src/modules/identity/first-organization-onboarding-repository.ts
apps/api/src/modules/identity/first-organization-onboarding-service.ts
apps/api/src/modules/identity/first-organization-onboarding-router.ts
apps/api/src/modules/identity/first-organization-onboarding.integration.test.ts
apps/api/src/modules/organizations/branch-schemas.ts
apps/api/src/modules/organizations/branch-repository.ts
apps/api/src/modules/organizations/branch-service.ts
apps/api/src/modules/organizations/branch-router.ts
apps/api/src/modules/organizations/branch.integration.test.ts
apps/api/src/modules/catalog/catalog-values.ts
apps/api/src/modules/catalog/catalog-values.test.ts
apps/api/src/modules/catalog/catalog-schema.test.ts
apps/api/src/modules/catalog/catalog-schemas.ts
apps/api/src/modules/catalog/catalog-schemas.test.ts
apps/api/src/modules/catalog/catalog-repository.ts
apps/api/src/modules/catalog/catalog-service.ts
apps/api/src/modules/catalog/catalog-router.ts
apps/api/src/modules/catalog/catalog-router.test.ts
apps/api/src/modules/catalog/catalog.integration.test.ts
```

The web and API packages have separate strict Zod environment schemas. P1-M2-T04 defines the local path: the API binds to `127.0.0.1:3001`, and Next.js serves the browser at `http://localhost:3000` with same-origin `/api/health` and `/api/v1/:path*` rewrites to Express; the server-only loopback origin never enters a client bundle. P1-M3 established local PostgreSQL, API-owned Prisma, and the isolated database test harness. P2-M1 established identity/tenancy persistence and pure authorization policy. P2-M2 established the authentication lifecycle. P2-M3-T01 established atomic first onboarding. P2-M3-T02 adds authenticated effective access-context and policy-authorized branch create/list/edit/activate/deactivate without a schema migration. Branch code is canonical and immutable; exact `updatedAt` versions reject stale writes; an organization-row lock prevents zero active branches; assignments persist but confer no active operational/navigation authority while a branch is inactive; valid retained assignments may still authorize historical read-only access under ADR-020. `/app` resolves URL-only candidates from fresh access-context, removes prior `branch-scoped` TanStack Query cache before switching, and exposes `/app/branches` only for OWNER/ADMIN UX. P2-M3-T03 adds hash-only invitation create/reissue/revoke/accept; safe member/invitation pagination; exact-version full role/scope replacement, deactivate/reactivate, and last-owner locking; tenant-safe access provenance; `/app/members`; and transient `/accept-invitation`. The API remains the authorization boundary; OWNER/ADMIN receive no branch assignments. P3-M1-T02 adds Category/Product persistence and pure normalization/value helpers. P3-M1-T03 adds strict Category/Product list/detail/create/PATCH/deactivate/reactivate, filter-bound `(createdAt,id)` cursor search, exact four-place price serialization, stale/unique conflict mapping, and server-revalidated optional branch-context authorization. P3-M1-T04 adds `/app/catalog` with typed same-origin API calls, URL/access-context-scoped TanStack Query keys, role-aware category/product forms and lifecycle controls, safe stale/conflict states, and real Chromium/axe coverage. At that historical foundation snapshot, composite tenant foreign keys and organization-scoped unique indexes remained the database boundary and no inventory, cost, branch price, or supplier relation was present.

### Approved physical boundaries

`ADR-011` defines this layout. Application and infrastructure directories are created only by their assigned later tasks:

```text
apps/
  web/                 # Next.js application
  api/                 # Express modular monolith
    src/modules/       # API-owned domain modules
    prisma/            # API-owned schema and migrations
packages/              # Deliberately shared internal packages only when justified
docs/                  # Technical Source of Truth documents
tests/e2e/             # Cross-application end-to-end tests
infra/                 # Deployment/infrastructure configuration
```

Only `apps/*` and `packages/*` are pnpm package workspaces. Likely domain modules are identity, organizations, branches, catalog, inventory, suppliers, purchasing, sales/POS, analytics, and AI insights. Do not create a catch-all `utils`, `common`, or `shared` dumping ground.

## 5. Architecture rules

1. Use a **modular monolith**. Keep one deployable backend until an accepted ADR says otherwise.
2. `Organization` is the tenant boundary; `Branch` is the operational boundary.
3. Products, categories, and suppliers are organization-scoped.
4. Inventory, sales, POS, purchase orders, and receiving are branch-scoped.
5. A user may access multiple branches. Do not model a user with one `branchId` as the complete membership model.
6. Derive trusted organization/branch scope from authenticated memberships and authorization policy. A request body, query parameter, path parameter, or header is not proof of access.
7. Keep HTTP controllers thin. Put validation at boundaries, business rules in use-case/domain services, and persistence behind module-owned data access.
8. Avoid circular dependencies. Cross-module writes must go through an explicit use case or stable interface.
9. Core retail workflows must not depend on OpenRouter availability.
10. Analytics and forecasts are deterministic TypeScript/SQL logic. The LLM summarizes an aggregate snapshot only.
11. Optional AWS services such as SQS require a demonstrated workload need and an accepted update to architecture/decisions.

## 6. Coding conventions

These rules are accepted; exact formatter/linter configuration is part of Repository Foundation.

- Use TypeScript in strict mode. Do not silence errors with broad `any`, unsafe casts, or blanket ignores.
- Prefer small, cohesive modules and functions with domain names over framework names.
- Keep side effects at boundaries and make calculation code pure where practical.
- Use dependency injection through explicit constructors/factories or parameters; do not hide mutable global state.
- Validate external input once at the boundary with Zod and pass typed values inward.
- Return intentional domain/application errors and map them to the canonical API error envelope.
- Use async/await consistently; handle rejected promises and provider timeouts explicitly.
- Never use JavaScript `number` arithmetic as the source of truth for money. Use Prisma `Decimal`/a deliberate decimal representation.
- Add comments for invariants and surprising trade-offs, not for obvious syntax.
- Avoid speculative abstractions, premature generic repositories, and unused extension points.

## 7. Naming conventions

- TypeScript files and directories: use the convention selected during foundation consistently; do not mix styles within a module.
- React components and exported types/classes: `PascalCase`.
- Functions, variables, and object properties: `camelCase`.
- Constants: `UPPER_SNAKE_CASE` only for true constants/environment keys.
- Database tables/columns and Prisma mapping: select one consistent convention during schema foundation and document it in `docs/architecture/DATABASE.md`.
- REST paths: plural kebab-case resources under `/api/v1`.
- Zod schemas: descriptive names ending in `Schema`.
- Tests: name by behavior, for example `rejects checkout from another branch`.
- IDs in documentation: `FR-*`, `UC-*`, `OQ-*`, `ADR-*`, and plan task IDs are stable; do not renumber casually.

## 8. Database rules

1. PostgreSQL and Prisma are the only accepted primary persistence stack.
2. Every business record must carry or derive its organization ownership. Branch-owned records must be verified to belong to that same organization.
3. Use both an `InventoryBalance` projection and append-oriented `InventoryTransaction` ledger.
4. Never update a stock balance without creating the corresponding ledger entry in the same transaction.
5. Checkout, receiving, adjustments, and reversal flows must use database transactions and be safe under concurrency.
6. Sale items and purchase/receipt lines must retain historical snapshots needed to explain past totals and costs.
7. Store money/cost in PostgreSQL `NUMERIC`/`DECIMAL` and Prisma `Decimal`.
8. Enforce invariants with database constraints and indexes as well as application validation.
9. Store event timestamps in UTC. Analytics/reporting uses the required Organization
   IANA timezone and local-calendar half-open boundaries from `ADR-029`; V1 has no
   Branch reporting timezone and never uses server/browser local time as authority.
10. Use explicit idempotency for retryable creates such as checkout and scheduled snapshots.
11. Do not hard-delete ledger, completed sale, payment, or completed receipt history. Use an explicit lifecycle/reversal rule.
12. Physical ID types, exact columns, status enums, delete/retention behavior, costing, and receipt numbering must follow `docs/architecture/DATABASE.md` and unresolved Open Questions.

## 9. Migration policy

- Prisma migrations must be generated, reviewed, and committed with the schema change only when the user has authorized the implementation task.
- Never edit an already-applied shared/production migration to change history. Create a forward migration.
- Never run destructive/reset/drop/truncate commands against a shared, staging, or production database.
- Never run `prisma migrate reset` or equivalent without the user explicitly naming and authorizing the disposable target.
- Before applying a migration, inspect the generated SQL for table rewrites, dropped/renamed objects, nullable-to-required changes, uniqueness failures, locks, and data backfill needs.
- Pair schema changes with application changes, tests, rollback/forward-recovery notes, and documentation updates.
- Do not create a migration for a model affected by a blocking Open Question.
- Treat production data migration and deployment as separate, explicitly authorized work.

## 10. API rules

- Use REST under `/api/v1` and the contracts in `docs/contracts/API.md`.
- Authenticate and authorize on the server for every protected endpoint.
- Validate path, query, header, and body input with Zod.
- Recalculate trusted prices, totals, organization scope, branch scope, and actor on the server.
- Use a consistent success representation and the canonical error envelope.
- Use appropriate HTTP status codes without leaking stack traces, SQL details, secrets, existence of inaccessible tenant resources, or provider internals.
- Paginate list endpoints and define stable sorting.
- Require idempotency keys where `docs/contracts/API.md` specifies retry-safe creation.
- Do not publish an endpoint whose behavior depends on an unresolved product rule. Mark the contract blocked instead.
- Update `docs/contracts/API.md`, use cases, and tests in the same change as a contract change.

## 11. Security rules

- Registration passwords contain 15–128 Unicode code points and are preserved exactly: do not trim, normalize, truncate, or add composition rules. Whitespace and Unicode are allowed; breached-password screening is deferred.
- P2-M2-T01 uses `argon2@0.45.1` Argon2id with `memoryCost=65536` KiB, `timeCost=3`, `parallelism=4`, a library-generated salt, and PHC-format storage. Never log, return, or persist plaintext passwords.
- New and canonical-email duplicate registration attempts return the same generic `202 Accepted` public response. Registration permits five attempts per 15 minutes per canonical email in deterministic process-local memory, logs neither email nor password, and returns `429` with `Retry-After` when exhausted. Distributed/IP-aware controls and proxy trust remain `OQ-020`.
- `ADR-034` is the implemented OTP-first backend verification contract: registration establishes version-bound pending credentials, initiates verification, and returns real/phantom continuation without authenticated authority. Follow its atomic duplicate-replacement/admission rules and the API/database contracts; mailbox-only verification is not supported. T02A-AUTH-VERIFICATION-WEB-01 implements the frontend OTP/link continuation and dedicated password fallback; independent frontend acceptance review and scoped local frontend/backend/PostgreSQL integration final review are ACCEPTED; external email delivery and production HTTPS remain unverified.
- Browser authentication uses only the `ADR-013` opaque, hash-only PostgreSQL session in an HttpOnly host-only `SameSite=Lax` cookie (`Secure` in production). Do not add JWT browser authentication, web-storage tokens, or refresh-token flows.
- D5-P5 candidate (not yet accepted): `STOCKWISE_AUTHENTICATION_AUTHORITY` selects exactly one authority per process. Production is Native-only under `ADR-035`/`ADR-039` (Better Auth native opaque database sessions, same cookie attributes); development/test default to Legacy. Native requires a database sealed NATIVE by the operator `native:cutover` command and the D5-P4 preflight; Legacy refuses any database whose fence has left LEGACY. Never add a fallback between authorities.
- Login uses `stockwise_session` with `Path=/`, no `Domain`, and `Secure` only when required `STOCKWISE_RUNTIME_ENV=production`; local HTTP development uses `development`. Session idle, absolute, and touch-minute values are API-owned configuration with accepted baselines `1440`, `10080`, and `15`.
- Login and the dedicated verification-password-proof fallback share five credential failures per canonical email per fixed 15-minute process-local window. Only credential failures count; success does not reset the window. Missing accounts use the fixed dummy Argon2 verifier. Revalidate the password snapshot/version before issuing any authority.
- Only ordinary ACTIVE/verified login creates/rotates `stockwise_session`. Correct-password ACTIVE/unverified login returns `verification_required` plus verification-only proof, no Session/application-cookie mutation or automatic mail. Proof cannot construct `TrustedAuthenticationContext` or grant tenant authority.
- `ADR-034` registration/resend share three verification-delivery requests per canonical email per 15 minutes; reset request retains its independent three-request budget. Reset remains ACTIVE/verified-only, rejects invalid tokens before Argon2, and advances credential version/revokes sessions atomically without creating one. `OQ-020` remains open for distributed/cloud hardening.
- Verification requires both the current-version password proof and unified ten-minute OTP/link challenge. OTP uses dedicated HMAC and five durable failures (`LINK_ONLY` thereafter); link stays 32-byte/hash-only. The stateless AES-GCM proof cookie is always Secure/HttpOnly/Strict, even locally; it is never JS-visible or stored in a proof table. Resend never changes proof. Follow `ADR-034` for crypto, phantom responses, Origin, locking, and delivery rules rather than inventing variants.
- Reset retains its 30-minute hash-only token. Provider selection remains development/test non-delivery and production Resend, with explicit development Resend opt-in, test rejection, and production non-delivery rejection. Never log passwords, OTPs, proof/session/link/reset credentials or hashes, provider secrets/payloads, or sensitive URLs/headers.
- Apply rate limiting/abuse controls to authentication and other sensitive endpoints.
- Prevent horizontal and vertical privilege escalation with organization, branch, and role checks.
- Use generic not-found/forbidden behavior that does not reveal another tenant's data.
- Never commit secrets or include them in examples. Provide redacted `.env.example` names only.
- Keep secrets and personal data out of logs, analytics snapshots, AI prompts, errors, fixtures, and screenshots.
- OpenRouter receives only minimized aggregates and never database credentials or direct database access.
- Use least-privilege credentials and private RDS networking in production.
- Review new dependencies for maintenance, license, size, and known security issues.

## 12. Dependency policy

- Prefer platform/framework capabilities and existing dependencies.
- Add a runtime dependency only when it provides clear value that would be risky or wasteful to reproduce.
- Before adding one, record the purpose, alternatives considered, maintenance/security/license status, and bundle/runtime impact in the implementation plan.
- Pin and lock dependencies through the selected package manager. Do not hand-edit a lockfile.
- Avoid overlapping libraries for the same concern.
- Major-version upgrades and framework replacements require their own reviewed task; architecture changes require an ADR.
- SQS, Redis, a job framework, a second service, or a second language is not a harmless dependency—it changes architecture and needs explicit approval.

## 13. Testing requirements

Every implementation task must add or update tests proportionate to risk.

- **Unit tests:** calculations, state transitions, validation, permission decisions, and error mapping.
- **Database integration tests:** constraints, tenant/branch isolation, Prisma queries, atomic checkout/receiving, ledger-balance consistency, idempotency, and concurrency.
- **API integration tests:** authentication/authorization, valid/invalid input, duplicates, missing records, conflict handling, and stable error envelopes.
- **Frontend tests:** critical component behavior, loading/empty/error states, accessibility, and responsive behavior.
- **End-to-end tests:** critical happy and failure paths from onboarding through purchase/receive, checkout, history, analytics, and persisted AI insight.
- **Analytics tests:** fixed fixtures with hand-verifiable expected values, time boundaries, empty/insufficient data, aggregation, and forecast evaluation.
- **Security tests:** cross-organization and unauthorized-branch access must fail without leaking data.

Do not replace database/concurrency tests with mocks when the risk is in transaction or isolation behavior.

## 14. Commands and environment setup

Prerequisites are Node.js 24 LTS and pnpm 11.19.0. These repository-root commands are verified:

```powershell
pnpm install --frozen-lockfile
pnpm list --recursive --depth -1
pnpm build
pnpm dev:api
pnpm dev:web
pnpm format
pnpm format:check
pnpm lint
pnpm start:api
pnpm start:web
pnpm test
pnpm test:db
pnpm test:e2e
pnpm test:watch
pnpm typecheck
```

The first command installs every current workspace from the committed lockfile without permitting lockfile changes. The second lists the private `stockwise` root plus `@stockwise/api` and `@stockwise/web`. `pnpm build` builds every workspace package that exposes a build script. `pnpm dev:api` runs the TypeScript API entry with Node.js watch mode, and `pnpm start:api` serves the compiled API; both require `STOCKWISE_API_PORT` and server-only `DATABASE_URL`, and bind only to `127.0.0.1`. `pnpm dev:web` and `pnpm start:web` use fixed port `3000`; Next.js loads the root `.env` when present and requires its server-only `STOCKWISE_API_ORIGIN` to configure the local health rewrite. `pnpm format` writes Prettier formatting for applicable non-generated, non-Markdown files; `pnpm format:check` checks the same scope without writing. `pnpm lint` runs the shared ESLint correctness rules plus Next.js Core Web Vitals rules for `apps/web`. `pnpm test` and `pnpm test:watch` regenerate the API Prisma client first, then provision the guarded `TEST_DATABASE_URL`, apply committed migrations with `prisma migrate deploy`, reset its data, and run Vitest with one-shot and interactive behavior respectively. Both discover root and workspace `*.test.ts`/`*.test.tsx` files, while cross-application tests under `tests/e2e` remain excluded for their dedicated runner. `pnpm test:db` applies the same migrations and runs only the database harness tests. `pnpm test:e2e` builds the API and runs the Playwright Chromium suite against real local Next.js and compiled Express servers plus the guarded, disposable `TEST_DATABASE_URL`; it requires both fixed ports `3000` and `3001` to be free. `pnpm typecheck` validates root tooling input, generates Next.js route types, regenerates the API Prisma client, and runs strict API/web package TypeScript validation.

The web and API packages expose verified package-scoped `lint`, `test`, `typecheck`, and `build` scripts. The API package additionally exposes package-scoped `dev`, `start`, `test:db`, `prisma:generate`, `prisma:validate`, `prisma:migrate:dev`, and `prisma:connectivity-check` scripts. `prisma:migrate:dev` requires a caller-supplied migration name and a populated local `DATABASE_URL`; migration SQL must be reviewed before application. The last command executes only a non-domain `SELECT 1` query and requires that same local URL.

For the local PostgreSQL development baseline, install Docker Desktop or Docker Engine with Docker Compose. Copy `.env.example` to `.env`, replace every `STOCKWISE_POSTGRES_*` placeholder with unique non-production local values, then use these verified commands:

```powershell
docker compose config --quiet
docker compose up --detach postgres
docker compose ps
docker compose exec --no-TTY postgres psql --username <local-user> --dbname <local-database> --command "SELECT 1;"
docker compose down
```

`compose.yaml` uses the fixed `postgres:16.15-alpine` image, exposes PostgreSQL only on `127.0.0.1:$STOCKWISE_POSTGRES_PORT`, and persists cluster data in the named `stockwise-postgres-data` volume. `docker compose down` removes the development container and network but preserves that volume; do not add `--volumes` unless local data deletion is explicitly intended. This is local development infrastructure only, not a production deployment. Docker Engine 29.7.2 and Docker Compose 5.4.0 validated the baseline on 2026-08-22.

The Phase 1 foundation tasks collectively must establish exact root commands, strict TypeScript, linting, formatting, test baseline, safe environment examples, and verified documentation. Keep the tasks bounded as defined in `PROJECT_PLAN.md`.

`P1-M1-T01 — Repository Foundation & Tooling` established only the approved workspace/package-manager root, lockfile, repository conventions, and ignore policy after resolving `OQ-001`. It did not initialize Next.js or include TypeScript/lint/format configuration, test-runner setup, `.env.example`, Express, Prisma, PostgreSQL/Docker, authentication, domain logic, AWS resources, analytics, or AI; those belong to later Phase 1 tasks.

`P1-M1-T02 — TypeScript and code-quality baseline` established the shared strict TypeScript policy, ESLint correctness rules, Prettier formatting policy, and the verified root quality commands above. It did not add an application shell, test runner, environment contract, database, domain, or infrastructure implementation.

`P1-M1-T03 — Test baseline and root test scripts` established Vitest, the verified one-shot `pnpm test` command, an interactive `pnpm test:watch` script, reusable root discovery configuration, and one non-domain smoke test. It did not add coverage tooling, browser/DOM testing, end-to-end tooling, an application shell, an environment contract, database, domain, or infrastructure implementation.

`P1-M1-T05 — CI quality gates` established one least-privilege GitHub Actions workflow for pushes and pull requests. On Ubuntu 24.04 with Node.js 24.19.0 and pnpm 11.19.0, it performs a frozen-lockfile install followed by the existing `format:check`, `lint`, `typecheck`, and `test` scripts. `P1-M2-T01` adds the verified root `build` gate after tests. `P1-M3-T03` adds one ephemeral PostgreSQL 16.11 test service and test-only `TEST_DATABASE_URL` because the suite now includes guarded database tests. The workflow uses immutable action commit pins and adds no cache, matrix, secret, deployment, or release behavior.

`P1-M2-T01 — Next.js web shell` resolved `OQ-002` through `ADR-012` and established `apps/web` with the App Router under `src/app`, Server Components by default, one narrow TanStack Query Client Component provider, Tailwind CSS, shadcn/ui initialization metadata, an accessible responsive shell, and a web-owned empty Zod environment boundary. It adds no feature routes, Next.js Route Handlers, authentication, API implementation, database, domain behavior, or infrastructure.

`P1-M2-T02 — Express API shell` established `apps/api` with an Express app factory, empty `/api/v1` router boundary, ordered request-ID/logging and JSON middleware, safe 404/JSON/error envelopes, idempotent HTTP server shutdown, signal handling, Pino structured logs, and an API-owned empty Zod environment boundary. It adds no endpoint, health/readiness probe, domain-module directory, authentication, database, web integration, or infrastructure.

`P1-M2-T03 — Health and Readiness Endpoints` established root-level `GET /health` and `GET /ready` operational probes. Health returns only `{"status":"ok"}` when the API process can handle requests. Readiness returns only `{"status":"ready"}` when all configured required dependencies are ready, otherwise `503 {"status":"not_ready"}`; it never exposes dependency identity or failure details. With no required external dependency yet, readiness defaults to ready. Frozen install, format-check, lint, strict typecheck, 18 root tests/14 API tests, API/web builds, and a compiled-API HTTP smoke were verified on 2026-08-22. It adds no business API, web integration, database, domain module, authentication, Docker, or infrastructure.

`P1-M2-T04 — Web-to-API development path` established `STOCKWISE_API_PORT=3001` for the API loopback listener and server-only `STOCKWISE_API_ORIGIN=http://127.0.0.1:3001` for the Next.js rewrite. The browser requests same-origin `GET /api/health`; Next.js proxies it to Express `GET /health`. Express enables no CORS policy for this path and emits no cross-origin permission header. The web shell contains one narrow typed health client/view only; business REST APIs remain Express-owned under `/api/v1`. Frozen install, format-check, lint, strict typecheck, 24 tests, builds, dev/start HTTP proxy smokes, direct-origin header checks, and desktop-browser responsive smoke at 375px passed on 2026-08-22. It adds no business API, database, domain module, authentication, Docker, or infrastructure.

`P1-M3-T01 — Local PostgreSQL and Docker setup` established `compose.yaml` with a development-only PostgreSQL 16.11 container, `pg_isready` healthcheck, loopback-only host port, and named persistent volume. It establishes only Docker-owned `STOCKWISE_POSTGRES_USER`, `STOCKWISE_POSTGRES_PASSWORD`, `STOCKWISE_POSTGRES_DATABASE`, and `STOCKWISE_POSTGRES_PORT` local configuration. Compose validation, clean-start health, loopback/connectivity smoke, restart persistence, and non-destructive teardown were verified on 2026-08-22. It adds no Prisma dependency, schema, migration, database table, API database access, production deployment, or test harness.

`P1-M3-T02 — Prisma foundation` added Prisma ORM 7.9.1 to `apps/api` with the PostgreSQL `pg` driver adapter, API-owned `prisma.config.ts`, an empty PostgreSQL datasource/generator schema, and a lazy per-process Prisma client. `DATABASE_URL` is required and PostgreSQL-scheme validated only at the API boundary; it is not part of web configuration. Generated client output is ignored at `apps/api/src/generated/prisma/` and regenerated by API/root test, typecheck, and build commands; future migrations remain reviewable under `apps/api/prisma/migrations/`. Prisma generate/validate, a disposable `migrate dev` no-op, and a local PostgreSQL `SELECT 1` smoke passed on 2026-08-22. No model, business table, or migration was created.

`P1-M3-T03 — Database test harness` added API-owned, server-only test configuration and helpers without a model, business table, or migration. `TEST_DATABASE_URL` must be a loopback PostgreSQL URL whose database name ends in `_test`; it must differ from runtime `DATABASE_URL`. The harness validates that target before provisioning or cleanup, creates the disposable test database through local `postgres` when absent, truncates only its public-schema data while retaining Prisma migration metadata, removes only its own scratch schema, and runs teardown cleanup. Vitest serializes files because they share that resettable target; the helper also supports intentional rollback transactions. Focused tests verified the connection, invalid/non-loopback/equal URL rejection, direct reset guard, cleanup, rollback, and repeated execution against a separate local Compose project on `127.0.0.1:5433`; the full suite and CI use the same test-only contract. No domain migration was applied.

`P2-M1-T02 — Identity and tenancy schema` added UUID/snake-case Prisma models for users, organizations, branches, organization memberships, role-less branch assignments, hash-only PostgreSQL sessions and one-time tokens, email-bound invitations, and invitation branch scopes. Composite foreign keys enforce same-organization membership/branch and invitation/branch references; accepted invitations also bind the accepted user ID to the normalized invited email. All identity/tenancy foreign keys use restrictive update/delete actions. SQL checks and partial indexes enforce canonical emails, lifecycle/time ordering, hash/relationship uniqueness, and replacement-safe open verification/invitation records. The harness now applies committed migrations before resetting data. The last-active-OWNER, role/assignment compatibility, onboarding, and acceptance invariants remain assigned to later application transactions/policy as documented in `docs/architecture/DATABASE.md`. The 2026-08-24 forward correction makes only `User.displayName` nullable until profile/onboarding and preserves the nonblank check for present values; it does not modify initial migration history. Incremental existing-row and clean zero-to-latest PostgreSQL 16.11 migration paths, Prisma format/validate/generate, 13 schema tests, the 174-test suite, 4 focused harness tests, format-check, lint, strict typecheck, API/web builds, production audit, and diff review passed. It adds no authentication service, endpoint, Argon2 dependency, registration behavior, UI, authorization policy implementation, or later-domain model.

`P2-M1-T03 — Authorization policy foundation` added `apps/api/src/modules/identity/authorization-policy.ts`, the pure centralized permission evaluator and its 132-test unit matrix. It defines fixed typed capability names, private-branded context/scope values derived from server-resolved actor, membership, assignment, and resource ownership state, and deny-by-default organization/branch evaluation without a database query. `OWNER`/`ADMIN` have organization-wide scope; branch-only roles require active explicit assignments. OWNER-only governance remains distinct from ADMIN non-owner membership administration, and refund/void is deliberately absent pending `OQ-009`. It does not add an auth service, session middleware, endpoint, UI, Prisma model, or migration. Frozen install, format-check, lint, strict typecheck, 173 full tests, 4 harness tests, API/web builds, production audit, and diff review passed on 2026-08-24 using a removed-after-verification disposable loopback PostgreSQL Compose project.

`P2-M2-T01 — Registration and Argon2` added public `POST /api/v1/auth/register` with strict email/password-only Zod validation, surrounding-whitespace-trimmed lowercase canonical email, exact 15–128 Unicode-code-point password handling, `argon2@0.45.1` Argon2id PHC verifiers (`memoryCost=65536`, `timeCost=3`, `parallelism=4`), and a deterministic five-per-15-minute process-local limiter keyed by a SHA-256 derivative of canonical email. Valid permitted attempts use one hash-and-create path with no existence pre-read; PostgreSQL uniqueness is authoritative and the Prisma 7 driver-adapter email conflict is translated to the same generic `202` response as a new row. New rows remain unverified with null display name and create no token, email, session, organization, or branch. The accepted-config Argon2 smoke completed in approximately 44 ms on the verification host; this is compatibility evidence, not a production latency target. Frozen install, format-check, lint, strict typecheck, 163 focused identity/registration tests, 205 full tests, 4 harness tests, API/web builds, production audit, and diff review passed on 2026-08-24 against an isolated disposable PostgreSQL 16.11 Compose project.

`P2-M2-T02 — Login and authenticated context` added public `POST /api/v1/auth/login`, the separate accepted login-failure limiter, fixed-dummy Argon2 enumeration mitigation, CSPRNG/SHA-256 session-token boundary, atomic collision-safe PostgreSQL session creation/rotation, the production-aware `stockwise_session` cookie, sliding idle/fixed absolute expiry with bounded persisted touches, and a private-branded Express authentication context containing active verified actor/session identity only. Login returns exactly safe `id`/`email`/nullable `displayName` actor data and no authorization state. No logout, verification/provider, recovery, onboarding, UI, authorization endpoint wiring, model, or migration was added. Frozen install, format-check, lint, strict typecheck, 56 focused tests, 262 full tests, 4 harness tests, API/web builds, production audit, STRIDE/leakage review, and diff checks passed on 2026-08-24 against an isolated removed-after-verification PostgreSQL 16.11 environment.

`P2-M2-T03 — Logout, verification, and credential recovery` added safely idempotent current-session logout, authenticated all-session logout, verification resend/initial issuance and atomic completion, account-safe password-reset request and atomic completion, provider-abstracted production Resend/development non-delivery/test recording adapters, 32-byte hash-only 24-hour/30-minute tokens, row-serialized replacement, provider-failure compensation, and the narrow independent three-per-15-minute process-local resend/reset-request limiters accepted by `ADR-018`. Reset validates token state before centralized Argon2 and atomically consumes the token, changes the password, and revokes all sessions without creating a new one. The reviewed schema/migrations were sufficient; no model or migration changed. Frozen install, format-check, lint, strict typecheck, 298 full tests, 4 harness tests, API/web builds, production audit, STRIDE/authored-source secret/leakage review, and diff checks passed on 2026-08-24 against an isolated disposable PostgreSQL 16.11 project. `OQ-020` remains open beyond its four narrow application-level limiter exceptions.

`P2-M3-T01 — Profile and first organization onboarding` added authenticated `POST /api/v1/organizations`, strict accepted text normalization, deterministic SHA-256 canonical request identity, server-owned initial branch code `MAIN`, unique `FirstOrganizationOnboarding` provenance, and a user-row-locked transaction that replaces submitted profile values and creates the organization, OWNER membership, branch, and provenance together. Identical requests replay HTTP `200`; different post-completion requests and membership-only users receive the accepted `409` conflicts. Pending invitations alone do not block; any membership status does. The responsive `/onboarding` form sends no actor/role/code state and navigates success to the minimal `/app` holding shell. OWNER remains organization-wide with no assignment. The forward migration passed existing-schema and clean-chain PostgreSQL 16.11 application with zero Prisma drift; 29 focused API/database tests, 30 focused web tests, 336 full tests, 4 harness tests, frozen install, Prisma format/validate/generate, format-check, lint, strict typecheck, builds, production audit, and diff/security review passed on 2026-08-24 against an isolated disposable PostgreSQL project.

`P2-M3-T02 — Branch management and switcher` added authenticated safe `GET /api/v1/me/access-context` plus branch create/list/edit/deactivate/reactivate routes. `OWNER`/`ADMIN` manage through centralized `branch.manage` with organization-wide scope and no assignments; branch-only roles list active assigned branches only. Post-onboarding codes are trimmed/uppercased, organization-unique, immutable, and limited to the accepted 1–16 ASCII grammar. Edit/lifecycle commands require the exact prior millisecond UTC `updatedAt`; stale writes return `BRANCH_STALE`. Lifecycle preserves assignments, disables their active operational/navigation authority while inactive without erasing authorized historical read-only access (ADR-020), serializes organization deactivation with a row lock, and rejects the last active branch. The minimal `/app` shell owns context only in validated URL parameters, deterministically falls back from stale/revoked candidates, and cancels/removes the old `branch-scoped` TanStack Query prefix before switching; `/app/branches` is OWNER/ADMIN UX only. The existing schema/migrations were sufficient. Thirty-two focused schema/router/PostgreSQL/HTTP/frontend tests, 367 full tests, 4 harness tests, frozen install, Prisma validate/generate, format-check, lint, strict typecheck, builds, production audit, and diff/security review passed on 2026-08-24 against an isolated disposable PostgreSQL 16.11 container.

`P2-M3-T03 — Membership invitation/assignment` adds centralized-policy-authorized invitation create/reissue/revoke/list/accept and member list/PATCH/deactivate/reactivate routes. Fresh seven-day opaque tokens are hash-only; acceptance requires the verified canonical invited email and atomically creates membership, full branch assignments, source provenance, and one bounded access event/scope snapshot. Same-user token replay is read-only. `OWNER` manages all roles; `ADMIN` manages only non-owner access; branch roles cannot manage. Exact `updatedAt` versions protect full desired-state changes, organization locks preserve the last active owner and serialize invitation races, and deactivation removes effective access without revoking sessions or deleting assignments. The forward provenance migration adds stable membership resource IDs and composite same-tenant issuer/revoker/source/event keys without creating a generic audit system; `OQ-019` remains open. The web adds OWNER/ADMIN `/app/members` and transient-token `/accept-invitation` UX; every mutation invalidates access context and management queries.

`P3-M1-T02 — Category and product schema` adds one forward migration plus Prisma `Category` and `Product` models owned by Organization. Category normalized identity, Product SKU, and non-null barcode uniqueness are organization-scoped; Product's nullable Category relation is a restrictive composite same-tenant foreign key. `basePrice` is exact non-negative `DECIMAL(19,4)` and Product stores one accepted `product_unit`; `catalog_status` supplies `ACTIVE`/`INACTIVE`. Pure helpers own Category/SKU/barcode/name/base-price canonicalization. `P3-M1-T03 — Catalog API` uses those models through strict Zod boundaries, exact optimistic versions, active-Category locking, safe race translation, and centralized catalog authorization. The model/API has no branch/stock quantity, unit conversion, supplier, cost/valuation/COGS, branch price, hard delete, or UI; those boundaries remain in their later tasks and open questions.

Across the later foundation/application-shell tasks:

1. `OQ-002` is resolved by `ADR-012`; preserve the App Router, `src/app`, Server Component default, and Express-owned business API boundary.
2. Add exact root commands only as their tooling genuinely exists.
3. Add an `.env.example` containing variable names and safe descriptions only in the environment-contract task.
4. Validate environment input with Zod when the owning process boundary exists.
5. Update this section with commands actually executed successfully; do not document guessed commands.

### Environment and configuration contract

`P1-M1-T04 — Environment example and validation contract` established the root `.env.example` ownership and handling contract. Exact names and values are added only when an owning process or infrastructure task exists and its blockers are resolved.

- `apps/web` owns browser/build-time configuration. Its current Zod schema requires `STOCKWISE_API_ORIGIN`, which `next.config.ts` reads from the root `.env` only to configure the local same-origin health rewrite. It is not public client configuration. Tenant scope, trusted prices/totals, credentials, database settings, provider keys, and cloud secrets are never client configuration.
- `apps/api` owns server-only runtime configuration, including `STOCKWISE_API_PORT`, PostgreSQL, authentication, and OpenRouter settings. For the Learner Lab demo, `ADR-040` puts secret values in AWS Secrets Manager. They are generated by `infra/learner-lab/operator/put-secrets.sh` and injected per key into ECS containers; only names and ARNs appear in Git and Terraform. The API container composes `DATABASE_URL` from the injected runtime-role password. This is implemented in source but not provisioned. Server-only values must not be exposed through web configuration, logs, errors, health endpoints, screenshots, analytics snapshots, or AI prompts.
- Each process validates only its own environment with a process-owned Zod schema at startup. Separate strict Next.js and Express schemas validate their implemented configuration and have process-owned tests; there is no speculative shared root schema.
- Local development values must be non-production and documented by the task that introduces the corresponding process or resource. Test values must identify isolated, disposable resources and must never target shared, staging, or production data.
- Populated `.env` and `.env.*` files remain ignored. Only redacted example files may be committed. Never place real secrets, tokens, credentials, or production values in an example.
- `P1-M2-T04` owns the verified local port/origin contract: `STOCKWISE_API_PORT=3001`, `STOCKWISE_API_ORIGIN=http://127.0.0.1:3001`, and fixed web port `3000`. `P1-M3-T01` owns the Docker-only local PostgreSQL inputs `STOCKWISE_POSTGRES_USER`, `STOCKWISE_POSTGRES_PASSWORD`, `STOCKWISE_POSTGRES_DATABASE`, and `STOCKWISE_POSTGRES_PORT`; they are non-production values, are never browser configuration, and require a unique replacement in a populated local `.env`. `P1-M3-T02` owns the API-only `DATABASE_URL`, which connects to that loopback database, is PostgreSQL-scheme validated by the API Zod boundary, and must never be web or `NEXT_PUBLIC_` configuration. P1-M3-T03 owns the server-only `TEST_DATABASE_URL`; the test harness accepts only an isolated loopback `*_test` target that differs from `DATABASE_URL`, and this value is never web configuration. P2-M2-T03 owns API-only `STOCKWISE_PUBLIC_WEB_ORIGIN`, `STOCKWISE_EMAIL_PROVIDER`, `STOCKWISE_EMAIL_FROM`, and `RESEND_API_KEY`; email delivery follows the runtime/provider policy above. None is browser or `NEXT_PUBLIC_` configuration. Reporting timezone is Organization data under `ADR-029`, not an environment value; `ADR-033` fixes scheduled AI V1 policy, P7-M2-T01 implements its provider adapter, P7-M2-T02 implements prompt preparation, and P7-M2-T03 owns the insight job. P7-M3-T01 implements callable due-period orchestration, P7-M3-T02 implements persisted reads, and P7-M3-T03 implements the dashboard UI; the runtime trigger is not implemented. P7-M4-T01 and P7-M4-T02 are complete; historical P7-M4-T03 execution concluded with all 260 cases classified and acceptance unmet at its original checkpoint. Final post-remediation acceptance is satisfied with the explicit user-accepted MT-L04 verification limitation: Phase 7 and P7-M4 COMPLETE, PRE-CLOUD READY YES; Phase 8 NOT STARTED at that review. MT-L04 remains historically BLOCKED; native layout/clipping/scaling/pagination/blank-page behavior remains unverified. Post-Phase-7 maintenance/UI tasks do not reopen Phase 7. AWS topology/secret management for real production remains `OQ-015`/`OQ-020`/Phase 8; the Learner Lab demo is governed by `ADR-040` (superseding the `ADR-039` topology).

P1-M1-T04 added no runtime validation before a process existed. P1-M2-T04 updates the web and API schemas with the only concrete local integration values; both schemas select only their owned input and reject missing, invalid, and unowned values. P1-M3-T03 adds a distinct test-only environment boundary for the database harness. All remaining configuration stays assigned to later tasks or decisions.

## 15. What agents may change

Within an explicitly assigned implementation task, agents may:

- Inspect the repository and relevant documentation.
- Create a short implementation plan.
- Change files directly required by the approved scope.
- Add focused tests and update affected Source of Truth documents.
- Run safe local checks against confirmed disposable/local resources.
- Report blocking questions, inconsistencies, and risks.

## 16. What agents must not change without explicit approval

- Product scope, roles, business rules, analytics formulas, or accepted architecture
- Answers to any `OQ-*` item
- The core tech stack or cloud topology
- Tenant, branch, authorization, stock-ledger, transaction, history, or money invariants
- Database schemas or migrations outside the assigned task
- Dependencies unrelated to the assigned task
- Secrets, credentials, production data, cloud resources, access controls, or broad filesystem permissions
- Unrelated code, formatting churn, generated artifacts, or lockfiles
- Git history or remote state

If a requested implementation cannot be completed without one of these changes, stop at the boundary, explain the evidence and impact, and ask for a decision.

## 17. Git identity, attribution, and remote actions

- Treat Codex as a coding tool, never as an author, committer, co-author, contributor, or signatory.
- Never add `Codex`, `OpenAI`, an AI agent, or a bot to authorship, trailers, contributor files, changelogs, pull-request attribution, or release attribution.
- Never add `Co-authored-by`, `Generated-by`, or similar AI attribution.
- Do not create a commit, amend, push, open a pull request, merge, tag, or release unless the user explicitly asks for that exact action.
- Before every authorized commit, verify that `user.name` resolves exactly to `Athikarn Chinjirattikan` and `user.email` resolves exactly to `67070194@kmitl.ac.th`; stop if either differs.
- Use only the user's authenticated Git hosting account for remote actions.

Finishing tests means a change is **ready for commit**; it does not authorize a commit.

## 18. Task workflow

Use this sequence for each implementation task:

1. **READ** — inspect this guide, relevant specs, repository state, existing code, and tests.
2. **PLAN** — state files/components, data/API effects, dependencies, security, tests, and order.
3. **IMPLEMENT** — make only approved, focused changes.
4. **TEST** — run relevant automated checks and inspect failures.
5. **REVIEW** — check correctness, security, validation, authorization, edge cases, architecture, and unnecessary changes.
6. **FIX** — resolve issues found within scope.
7. **TEST AGAIN** — rerun affected checks.
8. **HANDOFF** — report summary, files, checks, remaining issues, and whether the work is ready for commit.

Use one focused task/thread per coherent feature or bounded group. Do not ask one thread to build the entire project.

## 19. Definition of Done

A task is done only when all applicable statements are true:

- Scope and acceptance criteria are satisfied without silently answering Open Questions.
- Architecture, tenant/branch rules, security, stock, history, and money invariants are preserved.
- Input validation and authorization cover happy, invalid, missing, duplicate, forbidden, cross-tenant, and dependency-failure cases.
- Relevant unit, integration, end-to-end, concurrency, analytics, security, lint, format, typecheck, and build checks pass.
- No secrets, personal data, unrelated changes, unsafe casts, dead code, or unexplained dependencies were added.
- Schema changes include reviewed migrations and safe rollout/recovery notes where applicable.
- Affected Source of Truth documents and plan status are updated together.
- The final handoff lists changes, files, checks with results, and unresolved decisions.
- The work is only reported as ready for commit unless the user separately authorizes the exact Git action.
