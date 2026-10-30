# StockWise Build Specification

| Field | Value |
| --- | --- |
| Product | **StockWise** |
| Full name | StockWise: Smart Inventory and Sales Analytics Platform for SMEs |
| Repository | `stockwise` pnpm workspace monorepo |
| Baseline | Architecture Freeze v1 |
| Status | Application functionality implemented through Phase 7; P7-M4 COMPLETE with accepted MT-L04 verification limitation; PRE-CLOUD READY YES; Phase 8 NOT STARTED |
| Last updated | 2026-10-08 |

## 1. Purpose and source-of-truth map

This document is the product contract: it defines what StockWise is, who it serves, what it must do, and what it explicitly does not do.

Each topic has one authoritative owner. Other documents link to that owner instead of creating a second definition.

| Topic | Authoritative document |
| --- | --- |
| Product scope, goals, roles, requirements, non-goals, master open questions | `BUILD_SPEC.md` |
| Developer execution rules and Definition of Done | `AGENTS.md` |
| System boundaries and component responsibilities | `docs/architecture/ARCHITECTURE.md` |
| Logical data model, constraints, lifecycle, and transaction invariants | `docs/architecture/DATABASE.md` |
| Metric and formula definitions, forecasting, report periods, AI snapshot contract | `docs/contracts/ANALYTICS.md` |
| User-visible behavior and edge cases | `USE_CASE_SPECS.md` |
| REST resource and HTTP contracts | `docs/contracts/API.md` |
| Delivery order and status | `PROJECT_PLAN.md` |
| Architecture decision history and rationale | `docs/architecture/DECISIONS.md` |

An accepted change must update every affected authoritative document in the same change. Do not resolve uncertainty in code. Add or update an Open Question first.

## 2. Decision vocabulary

- **Product decision:** what value or behavior the product provides.
- **Architecture decision:** a durable system boundary, technology choice, or invariant.
- **Implementation detail:** a local code-level choice that may be made within accepted product and architecture constraints.
- **Open Question:** a decision that is intentionally unresolved and must not be guessed by an implementer.

## 3. Product overview

StockWise is a cloud-based retail operations platform for small and medium-sized businesses. It combines point of sale, organization-wide product management, branch-level inventory and purchasing operations, sales history, deterministic analytics, forecasting, replenishment guidance, and scheduled natural-language summaries.

It is delivered as a responsive web application usable from desktop, tablet, and phone browsers. A native mobile application is not part of the current scope.

StockWise is not a full ERP. Its scope is the retail flow:

`Product -> Purchase -> Receive -> Branch inventory -> POS sale -> Sales history -> Analytics -> Replenishment guidance -> Scheduled AI summary`

## 4. Problem statement

Small retailers often cannot justify a custom POS, inventory, purchasing, and analytics system. They may use disconnected tools or manual records, making it difficult to answer:

- What is currently in stock at each branch?
- Why did a stock balance change?
- What sold, where, when, and by whom?
- What should be reordered and when?
- Which trends matter at branch and organization level?
- How can an owner understand these results without reading many charts?

StockWise must provide one consistent operational record and decision-support layer without requiring enterprise infrastructure or specialist data staff.

## 5. Goals

1. Support the end-to-end retail workflow from purchasing and receiving through checkout and analytics.
2. Isolate each business as an `Organization` tenant and support multiple `Branch` operations from the beginning.
3. Make stock changes traceable through an inventory ledger and safe under concurrent operations.
4. Preserve accurate historical sales even when current product data changes.
5. Calculate analytics and forecasts deterministically in TypeScript and SQL, with testable formulas.
6. Use OpenRouter only to turn precomputed aggregate analytics into scheduled, persisted summaries.
7. Provide a responsive browser experience suitable for PCs, tablets, and phones.
8. Produce a maintainable cloud-ready system that can progress from MVP to production hardening without a rewrite.
9. Include measurable software/cloud experiments, documented limitations, and cost analysis as part of the project delivery.

### 5.1 Pre-launch marketing and preferences (Product-UX-01/02)

The public landing and pricing pages use the existing English/Thai language
preference and Light/Dark theme providers. Shared preference buttons toggle
immediately with one activation and retain the existing browser persistence.
An initial system-derived theme toggles from its resolved Light/Dark appearance.
Marketing content updates in place; public pages retain prerendered English
content and server-owned SEO metadata.

Approved **pre-launch marketing proposals**, not enforced subscriptions:

| Plan | THB/month | THB/year | Branches | Users |
| --- | --- | --- | --- | --- |
| Starter | 199 | 1,990 | 1 | 3 |
| Growth | 499 | 4,990 | 3 | 10 |
| Business | 999 | 9,990 | 10 | 30 |
| Enterprise | Custom quotation | Custom quotation | By agreement | By agreement |

The monthly/yearly selector changes presentation only. These figures grant no
subscription, quota, entitlement, support promise, or payment authority.
Registration does not select or purchase a plan. Enterprise is not unlimited.
No verified company sales destination is configured: show an explicit contact
unavailable notice, with no actionable Contact Sales control until an owner
supplies a verified destination. There is no new public contact endpoint or
payment collection. Account/Organization Settings, Access management, Native
activation, and cloud work remain separately scoped.

## 6. Non-goals

The following are not part of the current product scope:

- Expense management, general accounting, tax accounting, or a full ERP ledger
- HR or payroll
- Native Android or iOS applications
- Microservices
- Kubernetes
- A Python or FastAPI analytics service
- Real-time or user-triggered LLM generation
- Using an LLM as a forecasting, arithmetic, stock-decision, or transaction engine
- An AI chatbot
- Offline POS
- Full CRM, loyalty, e-commerce, or enterprise warehouse management
- Payment gateways, CARD, split tender, pending/offline payment, automatic transfer verification, or transfer-slip/OCR processing
- A generic tax engine, mixed/product-specific VAT classes or rates, VAT filing, or legal tax-invoice/e-tax-invoice compliance
- Google login in the MVP; it may be evaluated after the core project

Stock transfer is deferred from the current MVP but remains broader/full product scope; no transfer lifecycle or implementation contract is frozen. Branch price overrides remain out of MVP. `ADR-027` accepts CASH and manually confirmed TRANSFER only for Sales. `ADR-028` accepts linked REFUND compensation, including full and partial per-item quantities with optional same-branch restock, and excludes VOID from V1.

## 7. Target users

- Small retail shops and grocery stores
- Small-to-medium multi-branch retailers
- SME owners who cannot fund a custom retail platform
- Store managers, inventory staff, and cashiers who need role- and branch-scoped access

The product is retail-focused. It does not attempt to support every business type.

## 8. User roles and scope

The accepted authorization model is RBAC plus branch scope. A single user account can access multiple branches.

| Role | Default scope | Intended responsibilities |
| --- | --- | --- |
| `OWNER` | Organization | Full business visibility and governance |
| `ADMIN` | Organization | Organization administration delegated by an owner |
| `BRANCH_MANAGER` | Assigned branches | Branch operations and reporting |
| `INVENTORY_STAFF` | Assigned branches | Inventory operations and inventory-relevant analytics only (`ADR-042`) |
| `CASHIER` | Assigned branches | POS checkout and permitted sales-history actions |

These five role names are the accepted MVP RBAC policy and must not be renamed casually. Each user has one organization role per organization; `OWNER` and `ADMIN` have organization-wide branch access, while `BRANCH_MANAGER`, `INVENTORY_STAFF`, and `CASHIER` require explicit branch assignments and may be assigned to multiple branches. A user may hold different organization roles in different organizations. Server-side policy must deny by default and check organization membership, required branch assignment, role, action, and resource ownership; frontend checks are UX only.

The MVP permission baseline is:

| Capability | Authorized roles and scope |
| --- | --- |
| Product/category view | `OWNER`, `ADMIN`, assigned `BRANCH_MANAGER` and `CASHIER`; `INVENTORY_STAFF` none |
| Inventory view | All roles within allowed branch scope, including the narrow product identity returned by Inventory endpoints |
| Product/category create or edit; supplier view/create/edit; purchase orders/receiving | `OWNER`, `ADMIN`, assigned `BRANCH_MANAGER`; `INVENTORY_STAFF`/`CASHIER` none |
| Stock adjustment | `OWNER`, `ADMIN`, assigned `BRANCH_MANAGER` and `INVENTORY_STAFF`; `CASHIER` none |
| Product deactivate | `OWNER`, `ADMIN`, `BRANCH_MANAGER`; branch managers are limited to assigned branches |
| POS/checkout | `OWNER`, `ADMIN`, `BRANCH_MANAGER`, `CASHIER`; branch-only roles are limited to assigned branches |
| Apply a whole-Sale discount | `OWNER`, `ADMIN`, `BRANCH_MANAGER`; branch managers are limited to assigned branches; `CASHIER` cannot discount |
| Configure Organization sales VAT | `OWNER`, `ADMIN` only |
| Sales history | `OWNER`/`ADMIN` organization-wide; `BRANCH_MANAGER` and `CASHIER` in their assigned-branch scope as required for operations |
| Sales cost/COGS visibility | `OWNER`/`ADMIN` organization-wide; `BRANCH_MANAGER` assigned branches; `CASHIER`/`INVENTORY_STAFF` none |
| Create a refund | `OWNER`/`ADMIN` organization-wide; `BRANCH_MANAGER` assigned branches; `CASHIER`/`INVENTORY_STAFF` none |
| View refund records | Same scope as Sales history; `INVENTORY_STAFF` none |
| View refund cost/COGS | Same scope as Sales cost/COGS visibility |
| Analytics | `OWNER`/`ADMIN` organization-wide; `BRANCH_MANAGER` assigned branches; `INVENTORY_STAFF` inventory-relevant analytics only; `CASHIER` none |
| Forecast/reorder | `OWNER`/`ADMIN` organization-wide; `BRANCH_MANAGER` assigned branches; `INVENTORY_STAFF`/`CASHIER` none |
| AI business summaries | `OWNER`/`ADMIN` organization-wide; `BRANCH_MANAGER` assigned branches; `INVENTORY_STAFF`/`CASHIER` none |

`OWNER` has full organization operational access and performs OWNER-only ownership actions; an organization has exactly one active OWNER (`ADR-041`). `OWNER` and `ADMIN` manage memberships only for roles strictly below their own and may assign only roles strictly below their own, so nobody can create, promote, invite, or reactivate an OWNER, and nobody can change, deactivate, or remove themselves. `ADMIN` manages branches and BRANCH_MANAGER/INVENTORY_STAFF/CASHIER memberships but cannot manage another ADMIN, promote to ADMIN or OWNER, transfer ownership, or perform OWNER-only destructive ownership actions. `BRANCH_MANAGER` cannot manage organization settings, create/delete branches, or administer users/roles. `INVENTORY_STAFF` cannot check out, refund, administer employees, access broad analytics, view cost-derived analytics/inventory value, or view management AI summaries. `CASHIER` cannot edit products, adjust stock, create refunds, manage purchasing/suppliers, access analytics/forecasting/AI insights, or administer employees. Cost-derived analytics require the relevant analytics permission plus existing `SALES_COST_VIEW`; do not duplicate this policy in frontend role checks. The single OWNER cannot be removed, demoted, or leave (`ADR-041`). V1 has no VOID action or approval workflow.

`ADR-042` additionally denies `INVENTORY_STAFF` Catalog, Supplier, purchasing/receiving and Forecast/Reorder pages, navigation and APIs. Inventory's own product projection remains available through `inventory.view`; it grants no Catalog access. Inventory analytics is unchanged. An explicitly allowlisted synthetic organization may display labeled deterministic `Demo Insight` / `ข้อมูลตัวอย่าง` text from real analytics, independently of OpenRouter; ordinary AI summary authorization still applies.

## 9. Tenant and operational model

- `Organization` is the tenant and business ownership boundary.
- An organization has one or more branches.
- `Branch` is the operational boundary for inventory, sales, POS, and purchase receiving.
- A product catalog and suppliers belong to an organization.
- Inventory balances and inventory transactions belong to a branch and product.
- Every sale belongs to exactly one branch and records the acting user.
- Every purchase order and receipt targets a branch.
- Users can belong to an organization and be assigned to one or more branches.
- Organization-wide views aggregate only branches the user is authorized to access.
- The client must never be trusted to establish `organizationId`, `branchId`, price, cost, totals, or permissions.

## 10. Core product capabilities

### 10.1 Identity, organization, and branches

- Register with only email and password; complete the required user profile after registration.
- Preserve passwords exactly as submitted and hash them as PHC-encoded Argon2id
  using `argon2@0.45.1`, `memoryCost=65536` KiB, `timeCost=3`, and
  `parallelism=4`; never store plaintext or reversible passwords.
- Create a new organization through the accepted onboarding flow or join one through an accepted invitation.
- Create and manage branches with authorized roles.
- Assign users to organization and branch scopes.
- Switch active branch without signing in again.
- View an allowed organization-level aggregate when the role permits it.
- Use opaque server-side sessions backed by PostgreSQL: a cryptographically random browser token is stored only in an HttpOnly cookie and only its cryptographic hash is stored in the database.
- Verify email/password accounts using the `ADR-034` OTP-first backend contract in section 10.9 and the T02A-AUTH-VERIFICATION-WEB-01 frontend; independent acceptance review remains pending. Preserve safe password recovery and provider-abstracted production delivery.
- Invite employees by email with an expiring, single-use invitation that establishes the accepted organization role and branch scope atomically.
- Sign out by revoking the current session; support revoking all sessions for a user.

Branch management is fixed by `ADR-020`. After first onboarding, an authorized
`OWNER` or `ADMIN` supplies a code that is trimmed, uppercased, 1–16 characters,
starts with an ASCII alphanumeric character, and otherwise contains only ASCII
alphanumeric characters, `_`, or `-`. Codes are unique per organization and
immutable; `MAIN` is not globally reserved. Branches are activated/deactivated,
never deleted. Every edit or lifecycle command carries the exact prior
millisecond UTC `updatedAt`; stale commands fail rather than overwrite.

Application organization/branch selection lives only in `/app` URL query
parameters and is re-resolved from the freshly fetched server access context.
It is navigation state, never authentication or authorization evidence. The
browser stores no selected organization/branch in a session, user row, cookie,
`localStorage`, or `sessionStorage`.

Product-ACCOUNT-01 organization settings is name-only under owner-approved
ADR-037: active verified OWNER/ADMIN in an active organization may read/update
its edge-trimmed nonblank name (maximum 200, duplicate names allowed).
Exact optimistic versions prevent overwrite; VAT, reporting timezone, status,
roles, ownership, contact/legal/billing fields and authentication remain
unchanged. Branch phone/address stays in Branch Settings. No migration.

Membership access management is fixed by `ADR-021`. `OWNER` may invite and
manage every accepted role; `ADMIN` may invite and manage only non-owner roles.
An invitation is allowed only when no membership of any status exists for the
canonical email in that organization. Reissue always replaces the prior open
invitation with a fresh seven-day hash-only token. Acceptance requires the
authenticated, verified, canonical invited email and atomically creates exactly
one membership, the full branch scope, source-invitation provenance, and a
bounded access event. A same-user replay returns the existing logical result
without another mutation.

Membership role/scope edits and reactivation are full desired-state
replacements protected by the exact prior millisecond UTC `updatedAt`.
Organization-wide roles have no effective assignments; branch-only roles need
at least one active same-organization branch. Deactivation preserves configured
assignment rows, grants no access immediately, and does not globally revoke the
user's sessions. Every later authorization request re-evaluates membership
state. Organization-row serialization prevents concurrent changes from leaving
zero active owners.

Google login is a future feature. No JWT browser authentication, browser token storage in `localStorage`/`sessionStorage`, refresh-token flow, automatic invitation account creation, or naive cross-email account linking is part of the MVP.

### 10.2 Product catalog

- Manage organization-level categories and products.
- Store SKU, optional barcode, name, description, one immutable base unit, product status, and one organization-level base selling price. Product has no organization-wide cost, valuation, or COGS field; implemented Branch/Product cost state follows `ADR-026`.
- Enforce organization-scoped SKU and barcode uniqueness rules.
- Search and filter products for management and POS use.
- Preserve past sale snapshots when current product details change.

P3-M1-T02 implements only the organization-scoped Category/Product persistence
foundation, accepted normalization helpers, tenant uniqueness, composite
Category ownership, lifecycle enums, base price, and base unit. Catalog REST
management/search remains P3-M1-T03; no inventory, cost/valuation, branch-price,
or operational quantity persistence is part of the catalog model.

Branch-level price overrides are out of MVP scope. Every branch uses the Product's organization-level base selling price; a catalog-price change affects future operations only, and SaleItems snapshot the actual unit price used at sale time.

### 10.3 Branch inventory

- Read current product balances by branch.
- Record every stock change as an append-oriented inventory transaction.
- Maintain a query-efficient balance projection consistent with the ledger.
- Receive stock, sell stock, adjust stock, and record reversals when the relevant business rules allow them.
- Show inventory history and low-stock information.
- Prevent lost updates and overselling: MVP never permits a resulting negative
  balance, and no role has an override.

The stock-transfer MVP scope is deferred by `ADR-025`. Inventory balances retain
the quantity projection, while P4-M3-T01 implements separate tenant-safe
Branch/Product cost and valuation persistence under `ADR-026`.

### 10.4 Suppliers and purchasing

- Manage organization-level suppliers.
- Create purchase orders for a target branch.
- Add purchase-order line items and follow the `DRAFT` → `ORDERED` → `RECEIVED` / `CANCELLED` lifecycle accepted by `ADR-026`.
- Receive goods all at once from one ordered PO into its target branch; the server derives receipt quantity from frozen PO quantities.
- Support an atomic receipt that creates receipt records, ledger entries, balance changes, Branch/Product moving-average cost changes, and the PO transition together.
- Preserve historical purchase and receipt values independently of current product values.

Partial/over/short receipt, multiple receipt events, receiving without a PO, supplier returns, and receipt reversal are excluded from MVP. P4-M3-T01 implements the Branch/Product `InventoryCostState` projection with the `UNKNOWN` versus `KNOWN` cost-basis semantics from `ADR-026`; P4-M3-T02 exposes the existing exact receive command through authenticated HTTP without adding another transaction implementation.

### 10.5 POS and sales

- Search products and accept barcode input.
- Build and validate a transient client-side cart. Do not persist a Draft Sale or reserve inventory.
- Recalculate prices and totals on the server. `Product.basePrice` is authoritative; each line sends `expectedUnitPrice` only as an optimistic price-change precondition and snapshots the accepted Product identity, unit, and price.
- Record exactly one confirmed Payment per Sale using CASH or manually confirmed TRANSFER. CASH records tender/change; TRANSFER may record one bounded optional reference. No Payment status, split, CARD, gateway, pending, or offline payment exists.
- Use THB only. Allow no discount or one manager-or-higher whole-Sale `AMOUNT` or `PERCENT` manual discount with a required reason; apply discount before Output VAT extraction.
- Require authoritative Organization `UNCONFIGURED` / `NOT_REGISTERED` / `REGISTERED` sales VAT configuration. Existing and newly created Organizations start `UNCONFIGURED` with a null rate, and checkout remains blocked until an OWNER or ADMIN explicitly configures it. For REGISTERED, treat every MVP POS Product as subject to the single Organization rate and its `basePrice` as VAT-inclusive; do not support mixed/product-specific/exempt/zero-rated/multiple-rate tax behavior.
- Calculate document totals with exact Decimal arithmetic and deterministic largest-remainder line allocation according to `ADR-027`.
- Create the Sale, immutable SaleItem snapshots, one Payment, negative `SALE` inventory transactions, inventory balance updates, cost-state reduction, COGS snapshots, and checkout idempotency result in one database transaction.
- Roll back the whole checkout if any required operation fails.
- A successfully persisted Sale is completed by existence; the initial model has no Sale status. Use immutable `SALE-<UUID>` identity and project the printable customer receipt from Sale/SaleItems/Payment rather than persisting a second Receipt aggregate.
- View authorized sales history, sale details, and a printable browser receipt without exposing COGS to unauthorized roles.
- Record a full or partial REFUND only as linked immutable compensation. A refund may reverse positive per-item quantities up to each line's remaining refundable quantity and separately records a restock quantity from zero through that refund quantity.
- Derive refund money, discount, VAT, taxable value, and cost only from immutable original SaleItem allocations and cost snapshots. Never re-price from current Product or VAT configuration.
- Match the original CASH or manually confirmed TRANSFER method, use one confirmed refund payment, require a reason, serialize cumulative quantity, and commit refund/payment/restock/ledger/cost/idempotency effects atomically.
- Keep the original Sale, SaleItems, Payment, SALE ledger rows, receipt, VAT/discount, and historical COGS immutable. Show linked refunds separately in history/detail; V1 has no VOID or printable refund document.

`ADR-027` governs checkout payment, Output VAT, discounts, reference/receipt, rounding, UNKNOWN cost, idempotency, and atomicity. `ADR-028` governs refunds and resolves `OQ-009`; VOID remains explicitly outside V1.

### 10.6 Analytics and forecasting

- Calculate sales and inventory metrics using the definitions in `docs/contracts/ANALYTICS.md`.
- Support branch-level results and authorized organization-level aggregation.
- Use one configurable Organization IANA reporting timezone, defaulting explicitly to
  `Asia/Bangkok`; store event timestamps in UTC and derive half-open daily,
  Monday-based weekly, monthly, and yearly local-calendar periods under `ADR-029`.
- Provide sales totals, units, transaction counts, average order value, category performance, branch performance, trends, and movement indicators.
- Provide stock coverage and the fixed V1 Branch/Product `LOW_STOCK`/`NORMAL`/
  `OVERSTOCK` coverage classification under `ADR-030`. Forecast-derived
  `STOCKOUT_RISK` requires a later accepted definition; `ADR-032` accepts advisory
  Reorder V1 policy, implemented internally by P6-M4-T03; P6-M4-T04 owns
  forecast/reorder API/UI exposure.
- Calculate forecasting in the application using TypeScript and SQL. No Python service is used now.
- Retain reproducible metric inputs or snapshots needed for reports and experiments.
- Compare forecast results with actual values using accepted evaluation metrics.

`OQ-011`/`OQ-016` are resolved by `ADR-029`. `docs/contracts/ANALYTICS.md` is the only place
where accepted formulas, null semantics, period boundaries, or explicit deferrals may
be changed. `ADR-030` accepts only the fixed coverage classification; `ADR-031`
resolves `OQ-012` for Forecasting V1. `ADR-032` accepts Reorder V1's zero
safety-stock and other replenishment rules; its internal runtime is implemented
by P6-M4-T03. P6-M4-T04 owns transport and presentation.
Stockout risk still requires a separate accepted policy.

### 10.7 Scheduled AI summaries

- Generate four report cadences: daily, weekly, monthly, and yearly.
- Build an aggregate analytics snapshot before contacting OpenRouter.
- Send no customer-level personal data, raw transaction records, secrets, or database access to OpenRouter.
- Ask OpenRouter to summarize the supplied facts, not to calculate metrics or forecast demand.
- Persist the generated insight and its provenance so dashboards read a cached result rather than invoking the provider.
- Make scheduled generation idempotent and resilient to provider failure.
- Preserve the last successful insight and surface stale/failed status without blocking core retail workflows.

`ADR-033` resolves `OQ-017`/`OQ-018` for schedule times, bounded catch-up,
provider/model, retry budget, prompt, and retention. Scheduled jobs use the
Organization timezone/period rules from `ADR-029`.

### 10.8 Cloud and operations

The accepted AWS building blocks are:

- Amazon RDS for PostgreSQL
- Amazon S3 for object storage when product or report assets require it
- Amazon VPC for production network isolation
- Amazon CloudWatch for logs, metrics, and alerts
- Amazon EventBridge for production schedules
- Docker for application packaging
- GitHub Actions for CI/CD
- Amazon SQS only when asynchronous workload complexity or scale justifies it

SQS is not a mandatory MVP dependency. Exact frontend/backend hosting, ingress, secrets management, infrastructure-as-code tooling, regions, availability strategy, and cost targets remain open.

### 10.9 Email verification and credential recovery (accepted `ADR-034` target)

The `ADR-034` schema/backend/security contract below is implemented by T02A;
T02A-AUTH-VERIFICATION-WEB-01 implements the web OTP/link continuation flow, pending independent acceptance review. It
replaces the historical delivery behavior labelled as historical in section 11
and `OQ-004`. Cryptographic, key-management, and envelope details are owned by
`ADR-034` and are not duplicated here.

- **Dual proof.** Verification requires mailbox proof (valid OTP **or** link)
  and current-version password proof, matching subject and version under lock.
  Either proof alone is insufficient. An old browser proof must not verify
  a successor challenge for an attacker-installed password. Version advancement
  through reset or pending-account replacement invalidates older proof.
- **Unified challenge.** Each verification challenge carries one 6-digit code
  and one opaque link sharing a single 10-minute expiry. The most recently
  requested challenge invalidates the older one. Five durable wrong code
  comparisons downgrade the challenge to link-only (the link survives); either
  method consumes both.
- **Login behavior.** A correct password on an `ACTIVE` unverified account
  returns a verification-required result with a real proof cookie and no
  session. A verified account gets the existing session behavior with the
  proof cleared. Wrong, missing, or disabled credentials return a generic
  `401`.
- **Fallback.** Only after valid mailbox proof, missing/expired/stale/invalid
  password proof triggers inline current-password fallback. It shares login's
  limiter and never creates a session, challenge, or email.
- **Reset.** Password reset is `ACTIVE` verified-only, 30-minute, hash-only,
  and single-use. Completion atomically replaces the password, increments the
  credential version, invalidates open verification challenges, and revokes
  all sessions.
- **Mail budget.** Signup and resend share a budget of three valid requests
  per canonical email per 15 minutes; reset has its own independent budget.
  Signup budget exhaustion still returns the generic `202`; an explicit resend
  returns `429` with `Retry-After`.
- **Delivery and phantom behavior.** Admitted registration initiates best-effort
  delivery only after commit and response completion. Initial suppression still
  creates the account/version, bound revoked challenge, and real installation
  proof. Suppressed pending duplicates and verified/disabled duplicates change
  no password/version/challenge and receive same-shaped phantom continuation.
  Provider failure cannot roll back a committed password. Resend never creates,
  refreshes, clears, or upgrades proof.
- **Browser and privacy.** Normal registration/login reaches OTP without email
  or password re-entry; unusable proof offers inline fallback after valid
  mailbox proof. Browser reopen recovers through Login. Only noncredential
  continuation may use sessionStorage, never password, OTP, link, or proof.
  The UI supports existing Light/Dark themes and English/Thai.
  Sensitive verification data (codes, tokens,
  proof cookies, and submitted passwords) is redacted from all logs, errors,
  traces, and analytics; the verification page uses no-referrer and no-store,
  and the link is captured before any redirect or telemetry.
- **CSRF recovery.** Cross-site requests to the proof-setting and
  proof-using endpoints (register, login, fallback, resend, completion) are
  rejected before quota, mutation, or cookie changes; the existing logout
  CSRF behavior is not weakened.

## 11. Functional requirements

Identifiers below are stable references for plans, use cases, tests, and APIs.

### Identity and authorization

- **FR-IAM-001:** The system shall register and authenticate MVP users with email and password. Registration accepts no profile, organization, or branch field.
- **FR-IAM-002:** The system shall store PHC-encoded Argon2id password verifiers created by `argon2@0.45.1` with `memoryCost=65536` KiB, `timeCost=3`, `parallelism=4`, and a library-generated random salt.
- **FR-IAM-003:** The system shall authorize every business operation by organization membership, branch scope where applicable, and role permission.
- **FR-IAM-004:** One user shall be able to access multiple authorized branches using one account.
- **FR-IAM-005:** A user shall not access a tenant, branch, or aggregate outside their authorization scope.
- **FR-IAM-006:** Browser authentication shall use a cryptographically random opaque session token in an HttpOnly cookie; PostgreSQL stores only its hash and the API authorizes every protected request server-side.
- **FR-IAM-007:** Sessions shall rotate on successful authentication, expire after configurable sliding 24-hour idle and fixed seven-day absolute baselines, and be revocable individually or for all user sessions. Valid authenticated activity persists a touch at most once per 15 minutes and never extends absolute expiry.
- **FR-IAM-008:** Email/password accounts shall verify before access. The `ADR-034` contract requires mailbox proof (OTP or secure link) plus current-version password proof. OTP uses dedicated HMAC; link/reset/invitation credentials remain random, hash-only, single-use, and expiry-bound.
- **FR-IAM-009:** New-organization onboarding shall require display name, organization name, and initial branch name, create the creator's `OWNER` membership atomically, and collect only the approved optional profile/branch phone and branch-address fields.
- **FR-IAM-010:** Invitations shall be email-bound, require authentication and verified ownership of the invited email before acceptance, and create the organization membership and branch assignments atomically and idempotently.
- **FR-IAM-011:** Each user shall maintain positive BIGINT `credentialVersion`, initially 1; every committed password replacement, including identical-password replacement, shall atomically increment it with `passwordHash` and `passwordChangedAt`. It is never client-authoritative. (Implemented `ADR-034` backend contract.)
- **FR-IAM-012:** The system shall issue a stateless encrypted password-proof cookie for verification completion and the login fallback. The proof shall not create a session, grant tenant authority, or substitute for the opaque session; it shall be rejected unless its subject and version match the locked user's identity and current credential version. (Implemented `ADR-034` backend contract.)
- **FR-IAM-013:** Correct-password ACTIVE/unverified login shall return `verification_required`, a usable selector or null, and real proof, without Session/application-cookie mutation or automatic mail. ACTIVE/verified login retains session behavior and clears proof. Both revalidate the password snapshot/version. (Implemented `ADR-034` backend contract.)
- **FR-IAM-014:** Reset remains ACTIVE/verified-only, 30-minute hash-only, with invalid-token rejection before Argon2. Its atomic password/reset/session transition additionally advances credential version and invalidates open verification material without creating a session. (Implemented `ADR-034` backend delta.)
- **FR-IAM-015:** Every authenticated account, regardless of organization role or membership, shall view its own read-only email and maintain its display name and optional profile phone through server-derived self identity, strict validation and optimistic concurrency. Profile edits shall not change email, credentials, verification, sessions, memberships or tenant data. Organization name-only maintenance is approved by ADR-037; other organization business fields remain excluded.

First-organization onboarding is a one-time, authenticated, verified-user flow.
The initial branch code is the server-owned constant `MAIN` and is never an
input or name-derived value. Required onboarding text is boundary-trimmed and
must remain nonblank; optional phone/address text is boundary-trimmed and blank
becomes `NULL`. Internal whitespace and Unicode representation are preserved.
A persisted `FirstOrganizationOnboarding` record keyed uniquely by platform
user stores the organization, same-organization branch, SHA-256 canonical
request hash, and completion time. With no provenance, any existing membership
of any status blocks the flow, while a pending invitation alone does not.
Identical retries recover the original logical result; a different retry or a
membership-only account receives the accepted conflict without mutation.

Registration passwords contain 15–128 Unicode code points. The API preserves
the submitted string exactly: it does not trim, Unicode-normalize, silently
truncate, or impose uppercase, lowercase, digit, or symbol composition rules.
Whitespace and Unicode are allowed. Breached-password screening is deferred.

**Historical implementation (superseded by the implemented `ADR-034` backend
contract):** P2-M2-T01 creates the platform user with
`emailVerifiedAt = null` but creates no verification token and sends no email;
the user first receives a verification email only on a manual resend, and
verification completion consumed the link token alone. P2-M2-T03 owns
verification-token creation, resend, provider integration/delivery, and
verification behavior.

The accepted `ADR-034` registration admission, duplicate replacement, phantom,
and two-proof completion rules are defined in section 10.9. Mail delivery is
after commit and response completion. Resend atomically replaces mailbox
material only; it never creates, refreshes, clears, or upgrades password proof.

P2-M2-T02 login permits five failed credential attempts per canonical email per
fixed 15-minute process-local window. Only credential failures count; a success
does not reset the active counter/window. After five failures, later attempts in
the window return `429` with `Retry-After`. Missing-account login runs the same
Argon2 verification path against one fixed valid dummy PHC hash. Disabled
accounts return the same generic `401` without counting against the window.
Distributed, IP-aware, global controls and proxy trust remain open under
`OQ-020`.

Under the implemented `ADR-034` backend contract, login
checks the credential first for every account state. A correct password on an
`ACTIVE` account with a pending verification returns `202`
`verification_required` with the usable challenge identifier or `null` and sets
the real password-proof cookie; it creates no session, no `stockwise_session`
cookie, and no rotation or incoming-session revocation, and sends no automatic
email. A correct password on a verified `ACTIVE` account returns `200` with the
existing session behavior, revalidates the credential version before issuing
authority, and clears the proof cookie. A wrong or missing credential, and a
correct credential on a disabled account, return the same generic
`401 INVALID_CREDENTIALS`. Concurrent credential-version changes fail closed
with the generic invalid result. A same-limiter inline fallback endpoint
accepts `{ email, password }` for the missing-proof case; it shares the login
limiter object, never creates a session, challenge, or email, and returns a
real proof cookie for a correct pending-verification password and a phantom
proof cookie for a correct verified password.

New and canonical-email duplicate registration attempts return the same generic
`202 Accepted` public response; the database unique constraint remains the
final race-safe email boundary. Registration permits five attempts per 15
minutes per canonical email through a deterministic process-local in-memory
limiter. Exhaustion returns `429` with `Retry-After`; distributed and IP-aware
controls remain part of `OQ-020`.

P2-M2-T03 adds narrow MVP abuse-control exceptions without resolving `OQ-020`.
Under the implemented `ADR-034` backend contract, the
shared mail budget is three syntactically valid requests per canonical email
per fixed 15-minute process-local window across signup and verification
resend (shared); each valid request consumes an attempt before account
lookup, regardless of account state or provider outcome, and the SHA-256-
derived limiter key contains no plaintext email. After three admitted delivery
requests, signup remains generic `202`, while explicit resend returns `429`
with deterministic `Retry-After`. Malformed email allocates no entry. Success
does not reset the window. The password-reset
request keeps its own independent three-per-15-minute canonical-email
limiter, and reset completion has no process-local token-keyed limiter:
malformed, unknown, expired, revoked, replaced, and consumed tokens are
rejected before Argon2. The OTP wrong-comparison counter is independent of
the mail budget; five durable wrong comparisons downgrade the challenge to
link-only. Reset completion increments the credential version and
invalidates any open verification challenge atomically. Distributed,
IP-aware, global/provider-wide, proxy-trust, multi-instance, production DoS,
and long-term telemetry controls remain open in `OQ-020`.

### Catalog and inventory

- **FR-CAT-001:** Products and categories shall be scoped to one organization.
- **FR-CAT-002:** SKU and barcode constraints shall be enforced within the owning organization according to `docs/architecture/DATABASE.md`.
- **FR-CAT-003:** A Product shall use exactly one immutable MVP base unit from the accepted vocabulary; quantity input is a decimal string with accepted precision and is rejected rather than rounded when invalid.
- **FR-CAT-004:** A Product shall have one organization-level non-negative base price represented by a decimal string with at most four fractional digits; it is not a branch-price override or final sales-transaction rounding rule.
- **FR-CAT-005:** Product and Category mutations shall use exact `updatedAt` optimistic concurrency and preserve historical references through lifecycle status rather than hard deletion.
- **FR-INV-001:** Stock shall be represented by both a current balance and traceable inventory transactions.
- **FR-INV-002:** Every balance mutation shall have a corresponding ledger entry created atomically.
- **FR-INV-003:** Inventory shall be scoped to a branch.
- **FR-INV-004:** A successful stock mutation shall use a signed decimal-string delta,
  atomically update the balance projection and append exactly one immutable ledger
  movement, and never leave a resulting quantity below zero.
- **FR-INV-005:** Inventory mutations shall serialize the authoritative
  branch/product balance inside PostgreSQL; a failed insufficient-stock attempt
  creates neither a ledger row nor a durable balance change.

### Purchasing

- **FR-PUR-001:** Suppliers shall be scoped to an organization.
- **FR-PUR-002:** Purchase orders and receipts shall target a branch in the same organization.
- **FR-PUR-003:** A PO shall use the accepted immutable lifecycle and one unique Product line per PO; an ordered PO produces at most one immutable completed receipt.
- **FR-PUR-004:** Receiving shall derive exact receipt quantities from the frozen PO, atomically update receipt state, ledger, balances, Branch/Product cost state, and PO state, and use receipt-level idempotency.
- **FR-PUR-005:** Purchasing uses THB only. PO/Receipt unit costs use decimal strings targeting `DECIMAL(19,4)`; the implemented Branch/Product moving-average unit cost uses `DECIMAL(19,6)` and `ROUND_HALF_UP` at that persisted boundary.
- **FR-PUR-006:** A receipt may preserve only the accepted document-level Input VAT snapshots; it shall not imply a generic Tax engine, VAT allocation engine, Output VAT, or tax reporting.

### Sales

- **FR-SALE-001:** Every sale shall be assigned to one branch and acting user.
- **FR-SALE-002:** Checkout shall validate authorization, active Product, exact server-side `basePrice` against `expectedUnitPrice`, Organization VAT configuration, totals, payment, discount permission, and no-negative stock inside its authoritative transaction.
- **FR-SALE-003:** Checkout shall commit the completed-by-existence Sale, immutable line/payment/VAT/cost snapshots, one Payment, negative `SALE` ledger movements, balances, InventoryCostState updates, and idempotency result as one database transaction.
- **FR-SALE-004:** Historical sale line values shall not change when catalog data changes.
- **FR-SALE-005:** Duplicate checkout submission shall not create duplicate sales when the same idempotency key is retried.
- **FR-SALE-006:** Sales shall use THB and exact Decimal strings. Document subtotal, discount, VAT, and total shall use `ROUND_HALF_UP` only at accepted boundaries and deterministic Product-ID-tied largest-remainder line allocation so persisted line sums equal document totals.
- **FR-SALE-007:** One Sale shall have exactly one CASH or manually confirmed TRANSFER Payment whose amount equals the Sale total. CASH tender less change shall equal that amount; no independent mutable Payment status or split payment exists.
- **FR-SALE-008:** `OWNER`, `ADMIN`, and `BRANCH_MANAGER` may apply one whole-Sale AMOUNT or PERCENT discount in authorized scope; CASHIER may sell without discount; INVENTORY_STAFF cannot sell.
- **FR-SALE-009:** Checkout shall block `UNCONFIGURED` Organization sales VAT. REGISTERED Sales use one Organization rate and VAT-inclusive prices; NOT_REGISTERED Sales persist null taxable amounts and zero Output VAT exactly as `ADR-027` defines.
- **FR-SALE-010:** A Sale may consume UNKNOWN-cost stock while preserving UNKNOWN/null cost and COGS facts; zero cost shall never be fabricated or retroactively backfilled.
- **FR-SALE-011:** Sale reference shall be immutable `SALE-<UUID>` and Sale/SaleItems/Payment shall be the customer receipt source; no separate Sales Receipt aggregate is required.
- **FR-SALE-012:** Checkout shall collect no Customer/CRM data in MVP and shall retain immutable facts/provenance for linked refunds without rewriting original Sale facts.
- **FR-SALE-013:** V1 shall support REFUND, not VOID. Refunds may be full or partial by positive SaleItem quantity, may occur sequentially, have no calendar/time cutoff, and shall never cumulatively exceed original sold quantity.
- **FR-SALE-014:** Each refund item shall record a non-negative same-branch restock quantity no greater than its refunded quantity. Only restocked quantity creates a positive `SALE_REFUND_RETURN` ledger row and changes balance/cost state; original `SALE` rows remain immutable.
- **FR-SALE-015:** Refund money shall use cumulative exact-decimal allocation from original line net, discount, and VAT snapshots, with final-quantity remainder absorption so full cumulative reversal exactly equals the original snapshots. Current Product price and Organization VAT configuration shall not participate.
- **FR-SALE-016:** Refund COGS shall be tied to restocked quantity and original SaleItem cost. KNOWN cost uses the original unit-cost snapshot; UNKNOWN remains null and may force current mixed inventory cost state to UNKNOWN rather than fabricate a value.
- **FR-SALE-017:** Each refund shall have one confirmed refund payment using the original Payment method. CASH records manual cash repayment; TRANSFER requires a bounded manual confirmation reference. No gateway, CARD, split, pending, or asynchronous state exists.
- **FR-SALE-018:** Refund creation shall require `OWNER`, `ADMIN`, or assigned `BRANCH_MANAGER` authority, an active original branch, a required reason, and Organization-scoped idempotency. Sales-history readers may view refunds; only existing Sales-cost readers may view refund cost fields.
- **FR-SALE-019:** Refund authorization, cumulative eligibility, linked immutable refund records, payment, optional restock ledger/balance/cost changes, and idempotency result shall commit or roll back in one transaction under deterministic Sale and Branch/Product locking.

### Analytics and AI

- **FR-AN-001:** Metric outputs shall be derived only from definitions in `docs/contracts/ANALYTICS.md`.
- **FR-AN-002:** Organization results shall aggregate authorized branch results without cross-tenant leakage.
- **FR-AN-003:** Each event shall be attributed by its accepted persisted event time in the Organization reporting timezone; later refunds shall not rewrite original Sale periods.
- **FR-AN-004:** UNKNOWN cost shall never be treated as zero; affected COGS, Gross Profit, Gross Margin, and inventory value shall be null with explicit coverage metadata.
- **FR-AN-005:** Financial refund quantity, optional physical restock quantity, and restock-driven COGS reversal shall remain distinct analytics facts.
- **FR-AN-006:** Forecasting and replenishment calculations shall run in deterministic application/database logic, not an LLM.
- **FR-AI-001:** AI reports shall be scheduled for daily, weekly, monthly, and yearly periods.
- **FR-AI-002:** OpenRouter shall receive only minimized aggregate snapshots.
- **FR-AI-003:** AI output shall be persisted and served without an on-demand provider call.
- **FR-AI-004:** Provider failure shall not block sales, stock, purchasing, or deterministic analytics.

## 12. Non-functional requirements

### Security

- Enforce tenant and branch authorization on the server for every business request and background job.
- Derive trusted scope from authenticated membership; never trust a client-supplied tenant identifier alone.
- Validate all untrusted request and environment input with Zod at system boundaries.
- Apply the accepted registration password, Argon2id, duplicate-response, and process-local rate-limit baseline above; do not log submitted email or password values.
- Keep secrets out of source, logs, error responses, analytics snapshots, AI prompts, and client bundles.
- Minimize data sent to OpenRouter and prohibit personally identifiable customer or employee data.
- Use least-privilege AWS identities, private database networking, encryption in transit, and managed encryption at rest.
- Record security-sensitive and stock-affecting actor/context data; the full audit-log product scope is open.
- OTP uses dedicated HMAC at rest; verification link/reset/invitation tokens remain random, hash-only, single-use, and expiry-bound. The separate `ADR-034` encrypted password-proof cookie is never application authentication or tenant authority.
- Redact sensitive verification data (OTP codes, verification tokens, password-proof cookies, and submitted passwords) from all logs, errors, traces, and analytics.

### Data integrity

- Use PostgreSQL transactions for checkout, receiving, adjustments, and reversals.
- Represent money and unit costs with PostgreSQL `NUMERIC`/`DECIMAL` and Prisma `Decimal`; do not use unbounded binary floating-point arithmetic for money.
- Use database constraints in addition to application validation.
- Use UTC event timestamps and one required Organization IANA reporting timezone with
  `Asia/Bangkok` as the explicit V1 default; derive periods under `ADR-029`, never from
  server/browser local time.
- Make scheduled reports and retried write requests idempotent.

### Maintainability

- Use a modular monolith with explicit domain boundaries and no circular domain dependencies.
- Keep controllers thin; business rules belong to services/use cases and data access behind module boundaries.
- Share contracts deliberately; do not create a catch-all shared package.
- Add dependencies only when a standard API or existing dependency does not reasonably solve the problem.
- Keep product, architecture, data, metric, API, use-case, and delivery documentation consistent with accepted changes.

### Reliability and observability

- Core retail workflows shall continue if OpenRouter is unavailable.
- Emit structured logs without secrets or personal data.
- Expose application health/readiness signals appropriate to the deployment.
- Monitor failed checkouts, failed receipts, scheduled-job failures, OpenRouter errors, and database saturation.
- Define backup, restore, recovery, and alert thresholds before production launch.

### Performance

- Design indexes and pagination for organization- and branch-scoped access patterns.
- Do not compute large dashboard aggregates synchronously on every page load when a reusable snapshot is appropriate.
- Numeric service-level targets are an Open Question and must be set before load-test acceptance.

### Accessibility and responsiveness

- Support current desktop, tablet, and mobile browser layouts.
- Meet WCAG 2.1 AA intent for keyboard access, semantic controls, focus visibility, labels, and contrast.
- POS interactions must remain usable on touch screens.

### Testing and experimentation

- Test domain rules, validation, authorization, tenant isolation, branch isolation, and failure paths.
- Include database-backed integration tests for atomic stock, receiving, checkout, idempotency, and concurrency.
- Include frontend component/integration tests and critical end-to-end workflows.
- Verify analytics formulas against fixed fixtures and known results.
- Compare forecasting candidates against a documented baseline using accepted evaluation metrics and reproducible synthetic or anonymized data.
- Include cloud deployment validation, limitations, and cost analysis in project delivery.

## 13. Technology baseline

| Layer | Accepted choice | Decision type |
| --- | --- | --- |
| Frontend | Next.js + TypeScript | Architecture |
| Backend | Express.js + TypeScript | Architecture |
| API | REST, versioned under `/api/v1` | Architecture |
| Database | PostgreSQL | Architecture |
| ORM/migrations | Prisma | Implementation baseline |
| Validation | Zod | Implementation baseline |
| UI | Tailwind CSS + shadcn/ui | Implementation baseline |
| Charts | Recharts | Implementation baseline |
| Server state | TanStack Query | Implementation baseline |
| Password hashing | Argon2 | Security baseline |
| AI provider | OpenRouter API, summaries only | Architecture |
| Packaging | Docker | Architecture |
| CI/CD | GitHub Actions | Implementation baseline |
| Production services | AWS RDS, S3, VPC, CloudWatch, EventBridge; SQS if justified | Architecture |

Python, FastAPI, microservices, and Kubernetes are not part of the current baseline.

## 14. Important constraints

1. This repository implements the Next.js web application, Express modular monolith, identity/access lifecycle, Catalog/Suppliers, inventory, purchasing/receiving, POS/Sales/refunds, and Analytics/Forecast/Reorder/AI application functionality through Phase 7. Phase 7 and P7-M4 are COMPLETE with the accepted MT-L04 verification limitation; PRE-CLOUD READY YES; Phase 8 NOT STARTED. The runtime timer, cloud scheduling, AWS resources, and production deployment remain unimplemented.
2. Product requirements and architecture decisions are made in planning and recorded here before Codex implements them.
3. Codex may choose local implementation details only inside accepted boundaries; it must surface product or architecture ambiguity.
4. Significant domain implementation must not start until the Critical Domain Decision Gate and every additional task-specific Open Question affecting that domain are resolved.
5. Do not expose tenant identifiers as authorization shortcuts.
6. Do not mutate stock without a ledger entry and an atomic balance update.
7. Do not use an LLM for numerical truth, forecasting, transaction decisions, or database access.
8. Do not add AWS services merely to appear cloud-native; use SQS and other optional services only with a demonstrated need.

## 15. Critical Domain Decision Gate

The accepted architecture can remain frozen while product/domain decisions are open, but Codex must not invent those decisions during implementation. Repository/tooling work and unrelated application-shell work may continue when their own blockers are resolved.

These decisions are mandatory gates before the affected domain implementation:

| Affected domain | Required accepted decisions before implementation |
| --- | --- |
| Authentication and authenticated state | `ADR-013` (`OQ-003` resolved), amended by `ADR-034` for the verification-only proof-cookie exception |
| Email verification, password reset, and invitations | `ADR-014`, `ADR-021`, `ADR-034` (`OQ-004`, `OQ-006` resolved) |
| Profile and organization/first-branch onboarding | `ADR-015` (`OQ-005` resolved) |
| Authorization policies for accepted MVP roles | `ADR-016` (`OQ-022` resolved) |
| Catalog schema and management API | `ADR-022` (`OQ-014`, `OQ-023`, `OQ-024` resolved); Product retains no organization-wide cost/valuation field; implemented Branch/Product cost state follows `ADR-026` |
| Inventory mutations and stock availability | `ADR-024` plus the accepted quantity contract in `ADR-022` |
| POS checkout and sales monetary truth | `ADR-027` plus `ADR-016`, `ADR-022`, `ADR-024`, and `ADR-026` (`OQ-008` resolved) |
| Sales refund | `ADR-028` plus `ADR-016`, `ADR-022`, `ADR-024`, `ADR-026`, and `ADR-027` (`OQ-009` resolved; VOID excluded) |
| Purchasing/receiving behavior | `ADR-024`, `ADR-026` plus the accepted quantity contract in `ADR-022` |
| Analytics definitions and reporting periods | `ADR-029` (`OQ-011`, `OQ-016` resolved) |
| Forecasting V1 | `ADR-031` (`OQ-012` resolved) plus `ADR-029` reporting time and `ADR-022` quantity units |
| Stockout risk | Separate future policy decision plus `ADR-031` forecast and accepted inventory/purchasing inputs where used |
| Reorder recommendation | Accepted `ADR-032` policy plus `ADR-031` forecast, `ADR-029` reporting time, and `ADR-022` quantity units |

Other questions remain task-specific. Exact AWS topology, audit-log hardening,
and performance/recovery targets remain open for their relevant phases;
`ADR-033` resolves scheduled-report and OpenRouter V1 policy.

## 16. Decision and Open Questions register

This is the canonical list. Other documents reference these IDs and must not redefine or answer them independently.

### Resolved decisions

| ID | Accepted answer | Decision record |
| --- | --- | --- |
| **OQ-001** | Use a native pnpm workspace on Node.js 24 LTS. Runtime applications use `apps/web` and `apps/api`; deliberately shared internal packages may use `packages/*` only when justified. Use one root lockfile and no monorepo orchestration framework until a measured need exists. | `ADR-011` |
| **OQ-002** | Use the Next.js App Router with the `src/app` directory convention. React Server Components are the default; use Client Components only for required client-side behavior. Route Groups may be added later only for implemented routes. StockWise business REST APIs remain in Express and must not be implemented as Next.js Route Handlers. | `ADR-012` |
| **OQ-003** | Use opaque PostgreSQL-backed server-side sessions. Send a cryptographically random session token only in the `stockwise_session` HttpOnly, host-only, `SameSite=Lax`, `Path=/` cookie (`Secure` in production, not local HTTP); store only its cryptographic hash. Do not use browser JWTs, `localStorage`/`sessionStorage`, or refresh tokens. Successful authentication creates a fresh token and atomically revokes a currently valid same-user cookie session as `login_rotation`. Enforce server-side authorization, configurable sliding 24-hour idle and fixed seven-day absolute expiry baselines, and at most one persisted activity touch per 15 minutes. | `ADR-013` |
| **OQ-004** | Require email verification. Implemented `ADR-034` backend contract: admitted registration atomically establishes password/version, unified ten-minute OTP/link challenge, and proof; delivery follows commit and response completion. Verification requires valid OTP or link plus matching current-version password proof. Pending duplicate replacement is atomic and delivery-admission gated; verified/disabled duplicates never replace. Correct-password unverified login returns verification-required without Session or automatic mail. Resend replaces mailbox material, never proof. Reset remains ACTIVE/verified-only and 30-minute, with version advancement/session revocation. T02A-AUTH-VERIFICATION-WEB-01 implements the web continuation; independent acceptance review remains pending. | `ADR-014`, `ADR-017`, superseded/extended by `ADR-034` |
| **OQ-005** | Registration accepts only email and password. The platform profile later requires display name, so `User.displayName` remains nullable until profile/onboarding; no placeholder is derived from email. New-organization onboarding requires display name, organization name, and initial branch name. Phone is optional for the platform profile and initial branch; branch address is optional. The creator becomes `OWNER`; the server assigns initial branch code `MAIN`. One persisted per-user provenance row provides request-hash replay and concurrency identity; zero memberships are required when that row does not exist. User identity is platform-level; access derives from memberships. Invitations use their own flow. | `ADR-015`, `ADR-017`, `ADR-019` |
| **OQ-006** | Use email-bound organization invitations carrying the intended role and branch scope. Their opaque, cryptographically random, hash-only token is single-use for access creation and expires in seven days; reissue invalidates the active invite. The invited email must authenticate and verify before transactional acceptance creates membership, branch assignments, source provenance, and a bounded access event. Same-actor replay returns the existing result without mutation. Existing membership of any status blocks invitation. Full-replacement edits/reactivation use exact optimistic versions; deactivation preserves assignment configuration but immediately removes effective access. No automatic account creation or naive cross-email linking. | `ADR-014`, `ADR-021` |
| **OQ-007** | MVP forbids negative inventory for every stock-decreasing movement. Inside the same PostgreSQL transaction and authoritative branch/product balance serialization boundary, the service calculates `resultingQuantity = currentQuantity + signedDelta`; a result below zero returns `409 INSUFFICIENT_STOCK` with no ledger or balance mutation. No role has an override. Inventory uses immutable signed-delta ledger movements plus an atomically maintained lazy balance projection; manual adjustments use the accepted reason/note, idempotency, lifecycle, and permission rules in `ADR-024`. | `ADR-024` |
| **OQ-008** | Keep the cart transient and create a completed-by-existence immutable Sale atomically with exactly one CASH or manually confirmed TRANSFER Payment, THB-only server-authoritative pricing, optional manager-or-higher whole-Sale AMOUNT/PERCENT discount before VAT, Organization-authoritative single-rate VAT-inclusive Output VAT, `SALE-<UUID>` Sale-backed receipt, exact Decimal/document-first largest-remainder allocation, no-negative shared inventory locking, explicit UNKNOWN COGS, and Organization-scoped checkout idempotency. The initial model has no Sale status. No Customer/CRM, split/CARD/gateway/offline payment, generic/product tax engine, separate Sales Receipt aggregate, or refund/void behavior is included. | `ADR-027` |
| **OQ-009** | Support immutable linked REFUND records, not VOID. Allow full and sequential partial per-item quantity refunds with optional per-item same-branch restock, historical snapshot-based money/VAT/discount and cost, matching-method manual refund payment, manager-or-higher creation, exact cumulative caps, Organization-scoped idempotency, deterministic Sale/product locking, one atomic transaction, and separate history/detail projections. There is no time cutoff or approval chain. | `ADR-028` |
| **OQ-010** | Use Branch/Product moving weighted-average cost. Receipt `actualUnitCost` is authoritative intake; PO `expectedUnitCost` is planning/history only. The cost basis may be `UNKNOWN` for quantity created before an authoritative receipt; the first receipt initializes the cost basis for all then-on-hand quantity without reconstructing historical cost. Later cost-dependent facts use the current known average. FIFO, cost layers, zero-cost fabrication, and an Opening Cost/Recost workflow are out of MVP. | `ADR-026` |
| **OQ-011** | Use event-period operational Analytics V1 from immutable normalized facts: completed-by-existence Sales at `Sale.completedAt`; refunds at their own `completedAt`; VAT-inclusive gross/after-discount/refund/net Sales with separate discount/VAT/taxable breakouts; AOV over Sale events; distinct financial refund/restock quantities; restock-driven COGS reversal; null cost/profit/value when required cost is UNKNOWN; product/unit-safe quantities; current-category attribution; complete-period comparisons; source-separated inventory movement, 28-day velocity/coverage, current availability/value, and then-current deferral of threshold/forecast/reorder classifications (later narrowed by `ADR-030` and `ADR-031`). | `ADR-029` |
| **OQ-012** | Forecasting V1 estimates observed `SaleItem.quantity` per Branch/Product for seven Organization-local days from the prior 28 complete local days using `forecast-sale-mean-28d-v1`. Pair history requires first inventory movement at or before the training start; eligible zero-sale days remain zero, insufficient/new pairs and inactive Products receive explicit unavailable reasons. V1 has no seasonality or stockout correction; refunds do not rewrite original Sale days. Per-pair daily MAE over four rolling-origin windows is primary, with `last-day-naive` reference and no fixed accuracy threshold. Replenishment/risk policy is separately deferred. | `ADR-031` |
| **OQ-016** | Store server-assigned event timestamps in UTC and use one required configurable Organization IANA timezone, with explicit default `Asia/Bangkok` and no Branch timezone. Derive day/week/month/year as local-calendar half-open intervals (Monday week start) with IANA/DST rules. Current writes accept no client backdating; any future late import/repair belongs to its authoritative event-time bucket. On-demand history re-buckets under the current setting after a change; persisted snapshots retain their recorded timezone/bounds. | `ADR-029` |
| **OQ-017** | Run daily, Monday-weekly, monthly, and yearly jobs at 06:00 Organization-local time for the immediately preceding complete period; apply IANA/DST disambiguation and automatically catch up only the two most recent due periods per cadence/scope, oldest first, under one idempotent logical report identity. | `ADR-033` |
| **OQ-018** | Use server-only OpenRouter requesting `openrouter/free` on every attempt, with OpenRouter selecting the underlying free model and no StockWise paid-model fallback; 15-second attempts, at most three calls/job, 16 KiB request and 512-token output bounds, a server-versioned minimized prompt, 36-month snapshot/insight and 30-day sanitized-telemetry retention, and safe stale/failure behavior. | `ADR-033` |
| **OQ-013** | **DEFERRED FROM MVP.** Inter-branch stock transfer remains broader/full product scope, but no transfer schema, API, UI, permission, lifecycle, ledger-source, or idempotency contract is part of the current MVP. A previously discussed `SEND → IN_TRANSIT → RECEIVE → RECEIVED` direction with exact quantity and no partial/discrepancy workflow is non-binding future guidance only and must be re-reviewed before implementation resumes. | `ADR-025` |
| **OQ-021** | A PO is `DRAFT`, `ORDERED`, `RECEIVED`, or `CANCELLED`; only `DRAFT` is editable, and `ORDERED` freezes Supplier, Branch, Product lines, quantities, expected unit costs, and accepted commercial snapshots. One ordered PO produces at most one all-at-once immutable receipt whose quantities are server-derived from PO lines. Partial/over/short/multiple receipt, discrepancy, receiving without a PO, supplier return, receipt reversal, and receipt correction are out of MVP. | `ADR-026` |
| **OQ-022** | Use fixed, deny-by-default RBAC with one organization role per user/organization and explicit branch assignments for branch-only roles. `OWNER`/`ADMIN` are organization-wide; `BRANCH_MANAGER`, `INVENTORY_STAFF`, and `CASHIER` are assigned-branch roles. The role, governance, delegation, capability, analytics, forecast, and AI-summary baseline in section 8 is authoritative; `ADR-028` adds the accepted refund capabilities without changing role topology. | `ADR-016`, `ADR-028` |
| **OQ-014** | Branch-level price overrides are out of MVP scope. Each Product has one organization-level required non-negative `basePrice`; its API representation is a decimal string with scale at most 4 and its target persistence representation is `DECIMAL(19,4)`. Inputs with more than four fractional digits are rejected, never rounded. All branches use that base price for future operations, while SaleItems snapshot the actual unit price used. `ADR-027` defines Sales tax, discount, receipt-total, payment, currency, and transaction rounding. | `ADR-022`, `ADR-027` |
| **OQ-023** | Each Product has exactly one immutable base unit: `EA`, `PACK`, `BOX`, `KG`, `G`, `L`, `ML`, `M`, or `CM`. `EA`, `PACK`, and `BOX` are integer-only; the other units allow up to four fractional digits. Quantity APIs use decimal strings and persistence targets `DECIMAL(18,4)`; values with excess precision are rejected, never rounded. There is no unit conversion, pack-size conversion, or separate purchasing/selling UOM in MVP. Positive requested business-operation quantities must be greater than zero. `ADR-024` applies this boundary to signed inventory-ledger deltas and canonical inventory output. | `ADR-022`, `ADR-024` |
| **OQ-024** | Product display names are trimmed, nonblank, Unicode-preserving, and may duplicate within an organization. SKU is the required organization business identifier and is canonicalized by trim, Unicode NFKC, then uppercase; it must match `^[A-Z0-9][A-Z0-9._-]{0,63}$` and is unique per organization. Barcode is optional, trimmed with blank mapped to null, exact-match unique when non-null, control-character-free, and at most 128 characters. Categories are flat; their nullable product relation allows uncategorized products. Category identity is a per-organization unique NFKC/trim/collapsed-Unicode-whitespace/lowercase key while display names retain trimmed presentation. Product and Category use `ACTIVE`/`INACTIVE`, allow reactivation, prohibit hard-delete endpoints, and use exact `updatedAt` optimistic concurrency (`PRODUCT_STALE`/`CATEGORY_STALE`). Inactive categories remain referenced but cannot be newly assigned; no merge or bulk reassignment exists. | `ADR-022` |

### Open Questions

| ID | Question | Blocks | Priority |
| --- | --- | --- | --- |
| **OQ-015** | What are the exact production hosting topology, region, ingress, secret-management, IaC, availability, backup, and cost targets? | Cloud deployment | High |
| **OQ-019** | Is a durable audit-log feature required in MVP or only production hardening? | Security/compliance | Medium |
| **OQ-020** | Beyond the accepted narrow process-local registration, login, verification-resend, and password-reset-request limiters, what distributed/IP-aware/global/provider-wide abuse controls, proxy trust, multi-instance coordination, production DoS controls, long-term abuse telemetry, measurable performance, availability, recovery, browser-support, and data-retention targets define production readiness? | Hardening/load tests | Medium |

## 17. MVP completion boundary

MVP is a feature checkpoint, not a synonym for localhost. It is complete only when the accepted core workflow runs end-to-end with appropriate tests:

```text
Register / Authenticate
        ↓
Organization
        ↓
Branch
        ↓
Product
        ↓
Supplier
        ↓
Purchase Order
        ↓
Receive Stock
        ↓
Inventory Updated
        ↓
POS Checkout
        ↓
Stock Deducted
        ↓
Sales History
        ↓
Dashboard Analytics
        ↓
Deterministic Forecasting V1
        ↓
Reorder Recommendation
        ↓
Scheduled AI Insight
```

MVP completion does not require AWS production deployment. It is the feature-complete application checkpoint reached when the accepted workflow above runs end-to-end with appropriate tests. Deterministic Forecasting V1, Reorder Recommendation, and Scheduled AI Insight are explicit MVP capabilities; they are not hidden inside a generic analytics checkpoint or deferred to cloud delivery. OpenRouter remains outside numerical analytics and forecasting and receives only precomputed aggregate analytics snapshots.

After the feature-complete MVP, the same codebase progresses through later delivery phases:

```text
Feature-complete MVP
        ↓
AWS Cloud Deployment
        ↓
Security / Performance / Observability Hardening
        ↓
Production-like System
```

AWS Cloud Deployment is therefore a later delivery phase, not a condition of MVP completion. Production hardening follows cloud deployment; the MVP is evolved rather than discarded or rebuilt.
