# StockWise REST API Contract

| Field | Value |
| --- | --- |
| Status | Architecture Freeze v1 contract; application API functionality implemented through Phase 7; Phase 8 NOT STARTED |
| Base path | `/api/v1` |
| Style | JSON REST |
| Baseline | Architecture Freeze v1 |
| Last updated | 2026-10-08 |

## 1. Scope and authority

This document is the Source of Truth for planned HTTP resources, methods, request/response semantics, validation, errors, authentication requirements, and authorization scope.

It is not an OpenAPI file and does not imply that any endpoint exists. When implementation begins, an OpenAPI 3.1 contract may be generated/maintained from these accepted semantics, but it must not answer a blocking `OQ-*` question silently.

## 2. Contract status

- **Planned:** behavior is accepted, though implementation prerequisites may remain.
- **Blocked:** endpoint shape or behavior depends on unresolved product/architecture rules and must not be implemented as a stable contract.
- **Future:** not part of the current MVP.

## 3. Global HTTP conventions

### 3.1 Media type and encoding

- Request and response bodies use UTF-8 JSON with `Content-Type: application/json` unless an accepted asset endpoint specifies otherwise.
- Timestamps use ISO 8601 UTC instants.
- Calendar period responses also include the reporting IANA timezone.
- Money, price, cost, tax, discounts, and precise quantities are serialized as canonical decimal strings.
- IDs are opaque strings. Clients must not infer ordering/type from an ID.
- Unknown request fields should be rejected for security-sensitive writes unless a compatibility policy explicitly allows them.

### 3.2 Success envelope

Single resource:

```json
{
  "data": {},
  "meta": {
    "requestId": "opaque-request-id"
  }
}
```

Collection:

```json
{
  "data": [],
  "meta": {
    "requestId": "opaque-request-id",
    "nextCursor": null
  }
}
```

Analytics responses add definition/period/scope metadata required by `docs/contracts/ANALYTICS.md`.

### 3.3 Error envelope

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "The request is invalid.",
    "details": [
      {
        "field": "items.0.quantity",
        "code": "INVALID_VALUE",
        "message": "Quantity must be positive."
      }
    ],
    "requestId": "opaque-request-id"
  }
}
```

Rules:

- `code` is a stable machine-readable application code.
- `message` is safe for users and never contains a stack trace, SQL, secret, provider response, or inaccessible resource detail.
- `details` is optional and limited to safe validation/conflict context.
- Inaccessible cross-tenant resources use non-disclosing behavior.

### 3.4 Standard status and error mapping

| HTTP | Typical codes | Meaning |
| --- | --- | --- |
| `200` | — | Successful read/update/idempotent replay |
| `201` | — | Resource created |
| `204` | — | Successful action with no body, when used consistently |
| `400` | `VALIDATION_ERROR`, `INVALID_CURSOR` | Shape/semantic input invalid |
| `401` | `AUTHENTICATION_REQUIRED`, `INVALID_CREDENTIALS`, `SESSION_EXPIRED` | Identity not established |
| `403` | `FORBIDDEN` | Authenticated but action not permitted; use safely |
| `404` | `RESOURCE_NOT_FOUND` | Missing or intentionally undisclosed resource |
| `409` | `DUPLICATE_RESOURCE`, `STATE_CONFLICT`, `IDEMPOTENCY_CONFLICT`, `INSUFFICIENT_STOCK` | Uniqueness/current-state/business conflict |
| `413` | `VALIDATION_ERROR` | Request body exceeds the accepted transport limit |
| `422` | `BUSINESS_RULE_VIOLATION` | Valid JSON cannot satisfy an accepted domain rule; choose consistently during foundation |
| `429` | `RATE_LIMITED` | Abuse/budget limit reached |
| `500` | `INTERNAL_ERROR` | Unexpected safe server failure |
| `502`/`503`/`504` | `DEPENDENCY_UNAVAILABLE`, `SERVICE_UNAVAILABLE`, `DEPENDENCY_TIMEOUT` | External/internal dependency unavailable |

The project must choose one consistent boundary between `409` and `422` during API foundation without changing domain meaning.

### 3.5 Authentication

Browser authentication uses opaque server-side PostgreSQL sessions. The API sets the cryptographically random session token only in the `stockwise_session` HttpOnly, host-only, `Path=/`, `SameSite=Lax` cookie (`Secure` in production, not local HTTP); PostgreSQL stores only its cryptographic hash. The browser does not receive a JWT or refresh token and must not use `localStorage` or `sessionStorage` for authentication. Session idle and absolute timeouts are configurable (sliding 24 hours and fixed seven days as the baseline), and valid activity persists at most one touch per 15 minutes. The API validates expiry, revocation, and active verified account state for authentication; membership and authorization remain a separate server-resolved boundary.

`ADR-034` implements the following backend contract:
verification password proof, delivered only in the
`__Host-stockwise_verification_proof` cookie. It is an AES-256-GCM encrypted,
origin-bound, ten-minute absolute proof of password installation/knowledge for
one exact credential version. It grants no session, `TrustedAuthenticationContext`,
tenant, or protected-API authority. Completion checks it with mailbox proof;
the dedicated fallback establishes fresh proof from password input, not from
presenting an existing cookie. Only registration that installs the password,
correct-password unverified login, or correct-password pending fallback mints
real proof. Generic registration and correct-password verified fallback may
issue phantom proof; ordinary verified login instead clears it.
Resend and completion never mint, refresh, or upgrade it. Successful
verification, successful ordinary login, and successful logout clear it. The
cookie is `Secure` always, `HttpOnly`, `SameSite=Strict`, `Path=/`, host-only
(no `Domain`), `Max-Age` at most 600 seconds and never beyond the proof
expiry; duplicate or malformed proof cookies are rejected. Local browser
Secure-cookie compatibility must be verified; use local HTTPS if required,
never omit `Secure`. The proof is never returned in JSON,
URLs, web storage, or bearer headers.

This contract uses these semantic labels:

- **Public:** no authenticated state required, but abuse protection may apply.
- **Authenticated:** valid opaque server-side session required.
- **Organization-scoped:** authenticated membership plus role permission.
- **Branch-scoped:** authenticated organization membership/relationship, allowed branch, and role permission.
- **System:** least-privilege scheduled job or internal operational identity; not an end-user API.

Successful authentication rotates the session. Logout revokes the current session; an authenticated user can revoke all of their sessions. Password reset also revokes all user sessions. State-changing cookie-authenticated endpoints must receive implementation-time cross-site-request protections without creating a second credential transport.

### 3.6 Authorization and scoping

- Organization and branch path parameters select scope but never prove access.
- Server derives actor and validates membership, branch ownership, and permission on every protected request.
- Collection queries start from trusted scope; do not fetch globally and filter in memory.
- Organization aggregation includes only authorized branches and discloses its included scope.
- Price, totals, cost, user identity, and tenant ownership supplied by clients are never authoritative.

### 3.7 Validation

- Use Zod for params, query, headers, body, environment, and external response validation.
- Normalize email, SKU, and barcode exactly once by accepted rules.
- Reject invalid decimal syntax, non-finite numbers, ambiguous dates, unknown enums, excessive page size, and malformed cursors.
- Enforce length/size limits before logging or persistence.
- Database constraints remain mandatory for race-safe uniqueness.

### 3.8 Pagination, filtering, and sorting

- Use cursor pagination for potentially unbounded collections.
- Default and maximum page size are selected and tested during API foundation.
- Cursors are opaque, stable for the documented ordering, and validated.
- Default ordering includes a unique tie-breaker, normally `(createdAt desc, id desc)` or domain equivalent.
- Filters are allow-listed; arbitrary field/query injection is prohibited.

### 3.9 Idempotency

`Idempotency-Key` is required for checkout, purchase receiving, stock adjustment, and other retry-sensitive creates specified below.

- Key format/length is validated.
- The key is opaque, bounded, and not unnecessarily logged; persistence uses a
  deterministic hash and a canonical-request hash.
- Identity includes trusted tenant/branch and operation type.
- Same key + semantically same payload returns the same logical outcome.
- Same key + different payload returns `409 IDEMPOTENCY_CONFLICT`.
- Concurrent identical requests create at most one physical mutation. Inventory
  idempotency has no accepted expiry/retention window in MVP because its durable
  movement retains the necessary provenance.
- Concurrent requests with the same key create one logical operation.
- Retention duration is documented before production.

## 4. Shared resource representations

These are semantic fields, not final generated TypeScript types.

### `OrganizationSummary`

```json
{
  "id": "opaque-id",
  "name": "HCN Mart",
  "status": "active",
  "role": "OWNER"
}
```

### `BranchSummary`

```json
{
  "id": "opaque-id",
  "organizationId": "opaque-id",
  "code": "BKK-01",
  "name": "Latkrabang",
  "status": "active",
  "role": "BRANCH_MANAGER"
}
```

The accepted fixed RBAC roles are `OWNER`, `ADMIN`, `BRANCH_MANAGER`, `INVENTORY_STAFF`, and `CASHIER`. Each user has one organization role. `OWNER`/`ADMIN` have organization-wide branch access; the other roles require explicit branch assignments. Express enforces the capability and governance matrix in `BUILD_SPEC.md` section 8, including deny-by-default and the last-OWNER invariant. Resource status/lifecycle enums remain governed by their relevant open decisions.

### `Product`

```json
{
  "id": "opaque-id",
  "organizationId": "opaque-id",
  "categoryId": "opaque-id-or-null",
  "sku": "COKE-325",
  "barcode": "8850000000000",
  "name": "Coke 325 ml",
  "unit": "EA",
  "basePrice": "20.00",
  "status": "active",
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601"
}
```

`basePrice` is the required organization-level configured amount shared by every branch. It is a non-negative decimal string with at most four fractional digits; inputs with greater scale are rejected rather than rounded. `ADR-027` makes it the server-authoritative SaleItem price and the final VAT-inclusive selling price when the Organization is sales-VAT REGISTERED. Product has no organization-wide cost/valuation field; Branch/Product cost state follows `ADR-026`. Branch overrides and manual checkout price overrides are out of MVP scope.

## 5. Health and service endpoints

| Method/path | Auth | Request | Response | Validation/errors | Status |
| --- | --- | --- | --- | --- | --- |
| `GET /health` | Public | None | `200 {"status":"ok"}` while the API process handles requests; does not check dependencies | No dependency detail | Implemented in foundation |
| `GET /ready` | Deployment/internal exposure policy | None | `200 {"status":"ready"}` when every configured required dependency is ready; `503 {"status":"not_ready"}` otherwise | `503 SERVICE_UNAVAILABLE`; no connection details | Implemented in foundation; exposure policy still depends on `OQ-015` |

Health endpoints must not return environment values, versions with known exploit value, SQL errors, credentials, or OpenRouter secrets.

At this foundation stage the API has no required external dependency, so the default readiness result is ready. Future resource-owning tasks must register only their required dependency checks and must preserve the same status-only response contract.

### 5.1 Local web development path

For local development only, the Next.js server proxies its same-origin
`GET /api/health` request to the Express `GET /health` operational probe and
forwards same-origin `/api/v1/:path*` requests to the matching Express REST
path. The browser never calls the Express loopback listener directly. This
keeps `/api/v1` as the StockWise business REST base path without enabling CORS.

The root `.env` supplies `STOCKWISE_API_PORT=3001` to the API and
`STOCKWISE_API_ORIGIN=http://127.0.0.1:3001` to the Next.js server; the browser
server runs on fixed port `3000`. Both values are validated by their owning
process and the origin value is server-only.

Express does not enable CORS for this development path. It listens on
`127.0.0.1` and emits no `Access-Control-Allow-Origin` header, including for a
direct request carrying `Origin: http://localhost:3000`. The Next.js proxy is
therefore the sole browser path for the health check and web authentication API
requests.

## 6. Identity and account endpoints

### Endpoint catalog

| Method/path | Auth | Request | Response | Key validation/errors | Status |
| --- | --- | --- | --- | --- | --- |
| `POST /auth/register` | Public | Email and password only | `202 Accepted` `data {status: "accepted", nextStep: "verify_email", verification: {challengeId}}`; sets the verification proof cookie (real or phantom); no session, organization, or branch created | Invalid input/rate limit/database or hashing failure; canonical-email duplicates receive the same public response as new accounts | Implemented T02A `ADR-034` |
| `POST /auth/login` | Public | Email and password only | Verified account: `200`; sets a fresh opaque session cookie and returns only safe actor `id`, canonical `email`, and nullable `displayName`. Pending account: `202` `data {status: "verification_required", nextStep: "verify_email", verification: {challengeId}}` with a real proof cookie and no session | Strict validation; generic `401 INVALID_CREDENTIALS` for wrong/missing/disabled accounts; accepted login rate limit; safe database/hashing failure | Implemented T02A `ADR-034`; verified-session behavior preserved |
| `POST /auth/logout` | Safely idempotent | None | `204`; revokes a valid current session, clears its cookie, and clears the proof cookie on success | Missing/malformed/unknown/expired/revoked state is idempotent; dependency failure does not clear cookie | Implemented P2-M2-T03 with T02A `ADR-034` proof cleanup |
| `POST /auth/logout-all` | Authenticated | None | `204`; revokes all sessions for current user and clears current application/proof cookies on success | Authentication/dependency/cross-site-request failure | Implemented P2-M2-T03 with T02A `ADR-034` proof cleanup |
| `POST /auth/verify-email-code` | Public | `{ "email", "challengeId", "code" }` plus a valid proof cookie | `200` `data {status: "verified"}`; clears the proof cookie | Generic `400 INVALID_VERIFICATION_CODE` for invalid mail regardless of proof; `401 VERIFICATION_PASSWORD_PROOF_REQUIRED` only for valid mail with missing/phantom/stale proof; both proofs mandatory | Implemented T02A `ADR-034` |
| `POST /auth/verify-email` | Public | `{ "token" }`; first-time completion requires valid verification proof | First success: `200` `data {status: "verified"}` and clears proof; informational replay: `200` `data {status: "already_verified"}` with no cookie/session mutation, only for a matching consumed, unreplaced/unrevoked, nonlegacy current-version link to an ACTIVE verified user before the original ten-minute expiry | Generic `400 INVALID_TOKEN` for unknown/expired/replaced/revoked/legacy/stale links; `401 VERIFICATION_PASSWORD_PROOF_REQUIRED` only for valid pending material with unusable proof | T02A ADR-034 narrow UX amendment 2026-10-11; no live legacy-link compatibility |
| `POST /auth/verification-resend` | Public | `{ "email": "account@example.com" }` | `202` `data {status: "accepted", verification: {challengeId}}`; never creates, refreshes, or clears a proof cookie | Validation; shared mail budget three per 15 minutes per canonical email; explicit `429` with `Retry-After`; provider failure remains non-disclosing | Implemented T02A `ADR-034` |
| `POST /auth/forgot-password` | Public | `{ "email": "account@example.com" }` | Generic `202`; creates/replaces and delivers only for an eligible account | Validation; accepted three-per-15-minute limit; provider failure remains non-disclosing | Implemented by P2-M2-T03 |
| `POST /auth/reset-password` | Public | `{ "token": "opaque-token", "newPassword": "exact-value" }` | `200` reset result; atomically consumes token, updates password, increments credential version, invalidates open challenges, and revokes all sessions | Generic `400 INVALID_TOKEN`; password validation; safe dependency failure | Implemented P2-M2-T03 with T02A `ADR-034` version/challenge invalidation |
| `POST /auth/verification-password-proof` | Public | `{ "email", "password" }` | `202` `data {status: "accepted"}`; sets a real proof cookie for a correct pending account and a phantom proof cookie for a correct verified account; never creates a session, challenge, or mail | Same login limiter object; generic `401 INVALID_CREDENTIALS` for wrong/missing/disabled | Implemented T02A `ADR-034` |
| `GET /me` | Authenticated, any role or no membership | No query or user selector | Safe current profile: `id`, `email`, nullable `displayName`/`phone`, `updatedAt` | Authentication required; unknown query rejected | Implemented by Product-ACCOUNT-01 |
| `PATCH /me/profile` | Authenticated, any role or no membership | Required display name and exact `expectedUpdatedAt`; optional phone | Updated safe current profile | Strict validation; `409 PROFILE_STALE`; same-origin protection | Implemented by Product-ACCOUNT-01 |
| `GET /me/organizations` | Authenticated | Pagination if needed | Accessible organization summaries | Authentication required | Planned |
| `GET /me/access-context` | Authenticated | None | Safe active user/organization/role/effective-branch context plus first-organization onboarding eligibility | Authentication required | Implemented by P2-M3-T02; eligibility added by post-login routing fix |
| `GET /organizations/{organizationId}/branches` | Organization-scoped | Optional exact `includeInactive=true`; no pagination | Code-ascending accessible branch list | Invalid query/forbidden safely | Implemented by P2-M3-T02 |
| `POST /organizations/{organizationId}/branches` | `branch.manage` (`OWNER`/`ADMIN`) | Code, name, optional phone/address | `201` safe branch | Validation, forbidden, `BRANCH_CODE_CONFLICT` | Implemented by P2-M3-T02 |
| `PATCH /organizations/{organizationId}/branches/{branchId}` | `branch.manage` (`OWNER`/`ADMIN`) | Editable name/phone/address plus exact `expectedUpdatedAt` | Updated safe branch | Validation, safe not-found, `BRANCH_STALE` | Implemented by P2-M3-T02 |
| `POST /organizations/{organizationId}/branches/{branchId}/deactivate` | `branch.manage` (`OWNER`/`ADMIN`) | Exact `expectedUpdatedAt` | Inactive safe branch | Safe not-found, `BRANCH_STALE`, `LAST_ACTIVE_BRANCH` | Implemented by P2-M3-T02 |
| `POST /organizations/{organizationId}/branches/{branchId}/reactivate` | `branch.manage` (`OWNER`/`ADMIN`) | Exact `expectedUpdatedAt` | Active safe branch | Safe not-found, `BRANCH_STALE` | Implemented by P2-M3-T02 |

There are no Google OAuth endpoints in the MVP contract.

### Self-profile maintenance contract

`GET /me` and `PATCH /me/profile` derive the only user selector from the
server's trusted authenticated actor, independently of organization or branch
selection. Both use the canonical `{data,meta:{requestId}}` success envelope
and `Cache-Control: no-store`. The profile contains exactly `id`, canonical
read-only `email`, nullable `displayName`, nullable `phone`, and millisecond UTC
`updatedAt`. Onboarding eligibility remains available through
`GET /me/access-context`, not duplicated in the profile.

PATCH accepts exactly `displayName`, optional `phone`, and `expectedUpdatedAt`.
Display name is trimmed, required/nonblank, maximum 200 characters; phone is
trimmed, maximum 32 characters, with blank stored as `null`. Omitted phone
preserves the current value; explicit `null` is not an accepted input.
Internal whitespace and Unicode representation are preserved. The timestamp
must be the exact previous `YYYY-MM-DDTHH:mm:ss.sssZ` version. One atomic
conditional update returns its own safe updated row and advances the version,
including writes within the same millisecond; competing/stale writes return
`409 PROFILE_STALE` without replacing current values.

Unknown fields and query selectors are rejected, including user/tenant IDs,
email, roles, status and credential fields. Existing authentication and
same-origin mutation protection apply. Updating a profile neither changes
credentials/verification, revokes or rotates sessions, nor mutates memberships,
organization/branch data or first-onboarding provenance.

The `/app/profile` form is available to every authenticated account, including
accounts without memberships. It refreshes shared actor display data after
save without logging out. Dirty drafts retain their original base version
during ordinary query refresh; conflicts offer explicit reload. Save/Cancel,
internal-link and browser-unload warnings use EN/TH and the existing themes.
Security reconciliation still clears private queries/mutations and fences old
requests. One route-owned in-memory Profile/Organization Settings draft may
survive harmless focus/visibility reconciliation only after fresh matching actor
and effective organization/role/branch authority. Logout, session hints, failed
authentication/authorization, authority changes and route departure discard it.
An actor change detected by ordinary access-context refetch also hard-invalidates
private state before the new actor's content mounts. Rejected organization edits
cannot be restored after authority returns. No private web-storage persistence or
browser-history interception is introduced.

### Branch and access-context contract

Branch responses contain only `id`, `organizationId`, canonical immutable
`code`, `name`, nullable `phone`/`address`, `status`, and millisecond UTC
`updatedAt`. Create trims/uppercases code and trims other boundary text; blank
optional text becomes `null`. Branch code is 1–16 characters matching
`[A-Z0-9][A-Z0-9_-]*`. Duplicate names are allowed. Unknown fields, including
actor, role, permission, organization reassignment, or branch code in an edit,
fail strict validation.

`includeInactive` defaults false. Only `OWNER`/`ADMIN` may request true. They
list every organization branch; branch-only roles list active assigned branches
only and cannot expose inactive rows. All lists order by code ascending with ID
as a deterministic tie-breaker and are intentionally unpaginated for MVP.

Lifecycle commands are explicit and same-state commands are idempotent only
when `expectedUpdatedAt` still matches. `LAST_ACTIVE_BRANCH` is enforced inside
the serialized database transaction. Assignment rows are not changed by branch
lifecycle. All cookie-authenticated mutations use the accepted same-origin
request protection.

Access-context returns safe actor display data plus active organization
memberships, role, and effective active branches. It omits sessions, permission
arrays, assignments, inactive objects, credential data, and tokens. Clients may
use it to render navigation, never as proof that a later request is authorized.
It also returns `firstOrganizationOnboarding: { "eligible": boolean }` for the
authenticated user. `eligible` is true only when no onboarding provenance and
no organization membership row of any status exists; a pending invitation alone
does not block it. The value exposes no membership, invitation, or provenance
details and is not authorization proof for `POST /organizations`, which rechecks
eligibility transactionally.

### Registration contract

- Email uses `email.trim().toLowerCase()`; the existing 320-character limit
  applies.
- Password contains exactly 15–128 Unicode code points. Its submitted value is
  not trimmed, Unicode-normalized, silently truncated, or subject to
  character-class composition rules; whitespace and Unicode are accepted.
  Breached-password screening is deferred.
- Password storage uses the PHC-format output from `argon2@0.45.1` Argon2id
  with `memoryCost=65536` KiB, `timeCost=3`, `parallelism=4`, and the
  library-generated random salt.
- The registration limiter (5 attempts per 15 minutes per canonical email) is
  evaluated first.
- Every valid, permitted request performs the same Argon2id hash before the
  eligibility lookup; there is no account-existence pre-read before hashing.
  The implemented P2-M2-T01 baseline already follows this hash-before-lookup
  path.
- A shared mail budget of 3 valid requests per canonical email per 15 minutes
  covers signup and verification resend together. It is consumed before the
  lookup regardless of eligibility or provider, keyed by SHA-256 of the
  canonical email, and is not reset by success. Signup with the mail budget
  exhausted remains generic `202`; explicit resend with the budget exhausted
  returns `429` with `Retry-After`.
- A bounded 32 outstanding dispatch slots are reserved before a pending
  duplicate replacement.
- Initial admitted user: the user row (`credentialVersion = 1`), the bound
  verification challenge, and the prepared real proof are created atomically.
- Initial delivery suppressed: the password/user row with `credentialVersion =
  1` and the bound challenge are still created, the challenge is immediately
  `REVOKED` with reason `DELIVERY_SUPPRESSED`, and a real proof is prepared;
  no send occurs; later login/resend recovers when admission is available.
- Eligible duplicate admitted: under the user lock, the password hash,
  `credentialVersion` increment, `passwordChangedAt`, supersession, the
  successor challenge, and the prepared real proof are committed atomically.
- Duplicate suppressed: no password, version, or challenge change; the
  response is the same generic accepted result with a phantom proof.
- Verified or disabled accounts: no change; phantom proof.
- Crypto preparation failure before commit rolls back; the cookie is set only
  after commit.
- Provider dispatch happens after commit and after response finish, with a
  10-second timeout, no auto-retry, and no outbox. Dispatch is tracked,
  caught, and bounded-drained; it releases all reserved slots and aborts with
  conditional compensation on the exact issued row, never a new successor or
  the previous password. Crash loss is best-effort resend recovery. Known
  stale/expired challenges are skipped before the call. Provider latency never
  appears in the public response, and there is no delayed rollback of
  password or version.
- Every accepted registration sets a fresh same-size real/phantom proof cookie
  and returns a same-format real/phantom challenge UUID. Real proof exists only
  when registration installed the password. Phantom encrypted usable=false,
  random UUID subject, version 1, and matching timestamp/encoding/key family
  grant no authority.
- New and canonical-email duplicate attempts return the same generic `202
  Accepted` response. PostgreSQL canonical-email uniqueness is the final
  concurrency boundary; Prisma/database uniqueness details are never returned
  or logged.
- The historical P2-M2-T01 baseline predated `ADR-034`: it created no
  verification challenge or proof cookie and returned the pre-`ADR-034`
  envelope without a `verification` object. The accepted and committed T02A
  backend/frontend implement the current contract. The integration harness and
  T02A frontend/backend/PostgreSQL integration were subsequently ACCEPTED in
  the isolated local environment on 2026-10-10. This does not establish Live or
  production readiness. Real external email and production HTTPS remain
  UNVERIFIED; Phase 8 is NOT STARTED. D5 recovery/cutover and Better Auth Live
  activation remain unauthorized.

Accepted target success envelope (all accepted registrations, real or
phantom):

```json
{
  "data": {
    "status": "accepted",
    "nextStep": "verify_email",
    "verification": {
      "challengeId": "opaque-challenge-uuid"
    }
  },
  "meta": {
    "requestId": "opaque-request-id"
  }
}
```

`nextStep` asserts neither account creation nor delivery. `challengeId` is a
noncredential selector: an issued challenge UUID or same-format phantom.
It is never eligibility/password proof. The implemented baseline response
has no `verification` object.

### Isolated Better Auth D3 registration contract (not mounted)

ADR-036 defines an isolated, non-live registration surface using the existing
endpoint paths and request/response shapes below. This contract does not change
the endpoint catalog's current T02A implementation status: the D3 router is
separately exported and is not mounted, and `BETTER_AUTH_NATIVE_ENABLED` remains
false.

| Method/path | Request | Accepted result |
| --- | --- | --- |
| `POST /auth/register` | `{ "email", "password" }` | Generic `202` accepted envelope with a fresh `verification.challengeId`; real pending attempts set an encrypted proof cookie. No new `User`, `User.passwordHash`, Better Auth account, or session is created before completion; any existing user remains unchanged and duplicate responses do not disclose account state. |
| `POST /auth/verification-resend` | `{ "email" }` | Generic `202` accepted envelope with a new challenge ID; rotates challenge material only, preserving pending hash/version and original ten-minute expiry; never sets or refreshes proof. |
| `POST /auth/verification-password-proof` | `{ "email", "password" }` | `202` accepted; sets proof only after exact pending-hash verification and version recheck; no challenge, delivery, or session is created. |
| `POST /auth/verify-email-code` | `{ "email", "challengeId", "code" }` plus proof cookie | `200` verified after both proofs and atomic promotion; invalid mailbox material is generic before proof status is disclosed. |
| `POST /auth/verify-email` | `{ "token" }` plus proof cookie | `200` verified after both proofs and atomic promotion; bounded consumed-link informational replay retains ADR-034 behavior and does not create a session. |

The registration hash is the accepted Argon2id PHC value in standalone pending
storage, never an active `User.passwordHash` or native account before
completion. Password proof and mailbox challenge bind to the same pending UUID
and credential version. Same-browser verification uses the encrypted proof
cookie; cross-device completion requires explicit proof of the current
password. Completion atomically creates `User` with the pending UUID and writes
the already-computed PHC hash directly to `BetterAuthAccount.password`; it
never passes that PHC string as raw input to Better Auth `setPassword`. No
session or automatic login is produced; explicit sign-in follows completion.

Existing OTP HMAC/link hashing, ten-minute absolute expiry, five wrong-code
attempts followed by `LINK_ONLY`, OTP single-use, consumed-link informational
replay only before original expiry, and mailbox-first error precedence remain
required. A resend cannot replace the password or upgrade/renew proof. Durable
fixed-window budgets are five registrations, three delivery requests, and five
credential failures per canonical email per 15 minutes; credential snapshot
checks neither increment nor reset the failure counter, while failed credential
proof increments it. Existing `User` rows and UUID/FK relationships are never
adopted or modified. and isolated database/security verification were
independently ACCEPTED on 2026-10-12 (external D3 isolated final acceptance).
This router remains unmounted in the normal Legacy runtime, and these
native D3 endpoints are not exposed to Live traffic. This does not imply
D4/D5 completion or cutover authorization.

### Registration/login security requirements

- Do not return password hashes or credential metadata.
- Do not reveal account existence through materially different messages/timing where practical.
- Apply rate limiting and security telemetry without logging submitted email or password values.
- Do not return raw session, verification, reset, or invitation tokens, or
  verification proof values, in persisted resources, logs, or general response
  payloads.
- Verification, reset, and invitation delivery use the provider abstraction.
  Development defaults to non-delivery and may explicitly select Resend for
  manual UAT; test rejects Resend; production defaults to Resend and rejects
  non-delivery.
- Forgot-password and resend responses are account-safe and non-disclosing.
  Verification challenges are single-consumption with a 10-minute expiry, and
  reset tokens are single-use and expiry-bound; successful reset revokes every
  user session, increments the credential version, and invalidates open
  verification challenges.

### Login and authenticated-session contract

- Request validation accepts only `email` and `password`, rejects unknown
  fields, canonicalizes email with the registration policy, and preserves the
  password exactly without trimming, normalization, or truncation.
- After the shared login/fallback limiter check, read hash and credential version
  together as a snapshot and verify outside locks. Missing accounts use the
  fixed valid dummy Argon2 PHC hash through the centralized verifier.
- Wrong password, missing canonical account, and disabled user all return
  `401 INVALID_CREDENTIALS` with the same public message. Wrong/missing
  attempts increment the existing five-failures per 15-minute fixed window; a
  disabled account with the correct password is non-counting, and success does
  not reset the window.
- Correct-password ACTIVE/unverified login rechecks the demonstrated snapshot
  version and eligibility under the user lock before issuing proof,
  and returns `202` with `data {status: "verification_required",
  nextStep: "verify_email", verification: {challengeId}}` where
  `challengeId` is the usable non-terminal challenge UUID or `null`, plus a
  real proof cookie. No `Session` row, `stockwise_session` cookie, rotation,
  or incoming revocation occurs, and no automatic mail is sent.
- Correct password with an `ACTIVE` verified account: `200` with the existing
  actor/session behavior, but the server revalidates the snapshot
  `credentialVersion` before issuing authority and clears the proof cookie.
  A concurrent version change fails closed with the generic invalid result.
- Successful verified authentication generates a fresh 32-byte CSPRNG token
  and stores only its deterministic SHA-256 hash. The database session
  identifier and token hash are never serialized. A currently valid same-user
  incoming cookie session is revoked as `login_rotation` atomically with
  fresh-session creation.
- Initial idle expiry is login plus 24 hours and absolute expiry is login plus
  seven days by default. Valid authenticated requests persist a touch at most
  once per 15 minutes, setting idle expiry to
  `min(now + idle timeout, absolute expiry)`. Required touch failure, expiry,
  revocation, unknown token, disabled/unverified actor, and database failure all
  fail authentication closed.
- The shared login/fallback limiter processes five credential failures per canonical
  email per fixed 15-minute process-local window. Success is allowed before
  exhaustion and does not reset the active window. Subsequent attempts after
  five failures receive `429 RATE_LIMITED` and remaining-window `Retry-After`.
  Malformed requests do not create limiter keys. The
  `POST /auth/verification-password-proof` fallback shares this same limiter
  object. Distributed/IP-aware/global controls and proxy trust remain under
  `OQ-020`.
- The implemented P2-M2-T02 baseline rejects unverified accounts with `401
  INVALID_CREDENTIALS` and returns no `202` verification shape.

Verified login returns exactly this public shape (with `displayName` as a
string when already populated):

```json
{
  "data": {
    "user": {
      "id": "opaque-user-id",
      "email": "user@example.com",
      "displayName": null
    }
  },
  "meta": {
    "requestId": "opaque-request-id"
  }
}
```

Pending login returns the same shape as registration with `status`
`"verification_required"` and nullable `challengeId`:

```json
{
  "data": {
    "status": "verification_required",
    "nextStep": "verify_email",
    "verification": {
      "challengeId": null
    }
  },
  "meta": {
    "requestId": "opaque-request-id"
  }
}
```

Both responses return no session ID/hash, password data, membership, role,
organization, branch, permission, or authorization state. Organization/branch
options belong to later onboarding and access-management work.

### Logout and credential-lifecycle contract

- `POST /auth/logout` is safely idempotent for a missing, malformed, unknown,
  expired, or already revoked cookie. A syntactically valid token is hashed for
  lookup; a matching open session is revoked as `logout`. The cookie is cleared
  only after the revocation attempt succeeds. On success it also clears the
  verification proof cookie; there is no global stateless revocation of proofs.
  `POST /auth/logout-all` requires a valid authenticated context, revokes every
  open session for that actor as `logout_all`, and clears application/proof cookies.
  Both cookie-authenticated writes reject a cross-site Fetch Metadata signal
  or a mismatched supplied `Origin`; `SameSite=Lax` remains the primary browser
  cookie control.
- The cleared `stockwise_session` cookie retains `Path=/`, `HttpOnly`,
  `SameSite=Lax`, host-only scope, and production-only `Secure`, and adds
  `Max-Age=0` plus the epoch `Expires` value. The cleared proof cookie retains
  `Path=/`, `HttpOnly`, `SameSite=Strict`, host-only scope, `Secure`, and adds
  `Max-Age=0` plus the epoch `Expires` value. Logout never returns a session
  ID, raw token, token hash, or proof value.
- Verification resend is also initial verification issuance. Eligible means an
  active, unverified account. Issuance binds a fresh challenge to the current
  `credentialVersion`, stores only the OTP MAC and link hash, expires after
  10 minutes, and serializes replacement by locking the user row first. Every
  prior non-terminal challenge is terminalized as `REPLACED` (expired open
  challenges are terminalized when replaced) before the new challenge is
  created. Resend never creates, refreshes, clears, or upgrades a proof.
  The synchronized T02A backend replaces historical 24-hour link-only
  verification; completion requires both proofs (valid mail plus valid password
  proof) and
  conditionally consumes the challenge and sets `emailVerifiedAt` in one
  transaction; replay and concurrent duplicate completion produce one success
  at most.
- Forgot-password is eligible only for an active verified account. Issuance
  uses the same 32-byte/hash-only boundary, expires after 30 minutes, and
  serializes replacement through the user row. Completion validates token
  state before Argon2, then conditionally consumes the token, updates the
  accepted Argon2id PHC password hash/`passwordChangedAt`, increments
  `credentialVersion`, invalidates the user's open verification challenge, and
  revokes every open user session as `password_reset` in one transaction. It
  does not create a session or log the user in. The historical P2-M2-T03
  implementation omitted the version increment and challenge invalidation;
  the synchronized T02A backend now implements both.
- Verification-resend successes use exactly `202` with
  `data {status: "accepted", verification: {challengeId}}` for eligible,
  missing, already verified, disabled, non-delivered, and provider-failed
  outcomes; the `challengeId` is the fresh UUID for eligible outcomes.
  Forgot-password successes use exactly `202
  {"data":{"status":"accepted"},"meta":{"requestId":"..."}}` for the same
  outcomes. Provider failure conditionally revokes the just issued challenge
  or token; raw provider errors never enter the response. Verification
  completion returns `200` with `data.status = "verified"`; reset completion
  returns `200` with `data.status = "password_reset"`.
- Production uses Resend through the API-owned provider interface. Development
  defaults to a no-op non-delivery adapter and may explicitly select Resend;
  tests inject a deterministic recording adapter and cannot select Resend.
  The provider request has a ten-second timeout and no automatic retry;
  provider response bodies, message payloads, API keys, and complete sensitive
  links are not logged.

The registration limiter (5 per 15 minutes per canonical email) is evaluated
first on signup. The shared mail budget allows three valid requests per
canonical email per 15 minutes across signup and verification resend, keys
only a SHA-256 derivative, and consumes before account lookup and provider
work regardless of eligibility or delivery outcome. Attempt beyond the budget
returns `429 RATE_LIMITED` with deterministic remaining-window `Retry-After`
on explicit resend; signup with the budget exhausted remains generic `202`.
Success does not reset the window. Malformed email creates no entry. The
login limiter (five failures per 15 minutes) is shared by login and the
verification-password-proof fallback. Reset completion has no separate MVP
limiter and rejects malformed, unknown, expired, revoked, replaced, or
consumed tokens before Argon2. These are narrow application-level exceptions
only: all distributed/IP/global/provider, proxy-trust, multi-instance,
production DoS, and long-term telemetry behavior remains open under `OQ-020`.

### Email verification (ADR-034) contract

The accepted target replaces the 24-hour link-only verification token with a
unified mailbox challenge carrying both a 6-digit code and a link, and makes
completion require two independent proofs: the mailbox proof (code or link)
and the password proof.

- Challenge: one record per issuance binds `userId`, the immutable
  `credentialVersion` at issuance, an OTP MAC, and a link hash. The code is 6
  uniform ASCII digits with leading zeros allowed; its MAC is HMAC-SHA256
  under an OTP-dedicated key of at least 32 bytes binding purpose, encoding,
  user ID, challenge ID, version, and code, compared with
  `timingSafeEqual`. The raw code is never persisted. The link is 32 random
  bytes, base64url-encoded to 43 characters, stored only as its SHA-256 hash.
  Both share one 10-minute expiry from issuance. Five durable wrong code
  comparisons move the challenge to `LINK_ONLY` (the link survives); either
  method consumes both. States are `OPEN`, `LINK_ONLY`, effective `EXPIRED`,
  `CONSUMED`, `REPLACED`, and `REVOKED`. Exactly one non-terminal challenge
  exists per user (partial unique index); expired open challenges are
  terminalized when replaced.
- Wrong well-formed code on an otherwise usable matching challenge increments
  attempts even without proof. Unknown/stale/terminal requests cannot affect
  successors. Valid OTP/link with unusable proof returns
  `401 VERIFICATION_PASSWORD_PROOF_REQUIRED` without consumption; a correct
  OTP in this case adds no failure. Unknown, unusable and expired mailbox
  material returns `400 INVALID_VERIFICATION_CODE` or `400 INVALID_TOKEN`
  regardless of proof. The sole exception is the bounded, hash-matched,
  consumed-link informational replay described in ADR-034; there is no general
  public proof/account/challenge status endpoint.
- Completion endpoints: `POST /auth/verify-email-code` with body exactly
  `{ "email", "challengeId", "code" }`, and `POST /auth/verify-email` with
  body exactly `{ "token" }`. First-time verification requires the proof cookie
  and returns `200` with `data.status = "verified"`, clearing proof. A known
  previously consumed link may return `200 already_verified` without proof
  **only before its original 10-minute expiry** and without mutation or authority;
  random, replaced, revoked, legacy, disabled and stale links remain invalid.
- Both proofs are mandatory and bound to the same issuance:
  `proof.subject = challenge.userId = user.id` and
  `proof.credentialVersion = challenge.credentialVersion = user.credentialVersion`, re-checked
  under the user lock with fresh database time; the user must be `ACTIVE` and
  unverified. An old-version proof against a newer challenge fails (accepted
  scenario A), and a mailbox proof without a valid password proof fails
  (accepted scenario B).
- Verification password proof: AES-256-GCM under a dedicated 32-byte key,
  separate environment, purpose, and all other keys; 12-byte random nonce and
  16-byte tag. The fixed encrypted claims are purpose, usable (phantom) flag,
  UUID subject, 64-bit version, and iat/exp. The envelope is 1 format byte +
  4-byte key ID + 12-byte nonce + 42-byte ciphertext + 16-byte tag = 75
  bytes, exactly 100 base64url characters. AAD binds the fixed purpose, the
  configured origin, and the format/key header. Lifetime is 10 minutes
  absolute with no sliding; the server rejects authentication, format, key,
  purpose, origin, lifetime, and expiry failures, and future iat beyond 5
  seconds. Current and previous keys are accepted; the previous key is
  retained at least 605 seconds after its last issuance and is not
  prematurely discarded by normal rotation; emergency removal invalidates
  proofs under it. The per-key 2^24 encryption ceiling is enforced with fleet
  accounting deferred to Phase 8.
- Proof cookie: `__Host-stockwise_verification_proof`, `Secure` always,
  `HttpOnly`, `SameSite=Strict`, `Path=/`, no `Domain`, `Max-Age` at most 600
  seconds and bounded by proof expiry. Duplicate or malformed proof cookies
  are rejected. The proof is never returned in JSON, URLs, web storage, or
  bearer headers. Test localhost Secure-cookie support during implementation;
  use local HTTPS if needed. Never downgrade this proof cookie in any environment.
- Real proofs are minted only by registration that actually installed the
  password and by correct-password login or fallback. Every generic accepted
  registration sets a fresh same-size real/phantom cookie and same-format
  challenge selector. Phantom encrypts `usable=false`, a random UUID subject, and
  version 1, and grants no authority. Resend never creates, refreshes,
  clears, or upgrades a proof. Successful verification, ordinary verified
  login, and successful logout clear the proof; there is no global stateless
  revocation. One cookie per browser means tabs use last-response-wins
  availability; devices are independent.
- Fallback: `POST /auth/verification-password-proof` with body exactly
  `{ "email", "password" }`. It shares the login limiter object, verifies
  real or dummy hashes, re-checks the version under the user lock, and returns
  `202` with `data {status: "accepted"}`: a real proof cookie for a correct
  pending account, a phantom proof cookie for a correct verified account, and
  generic `401 INVALID_CREDENTIALS` for wrong, missing, or disabled. It never
  creates a session, challenge, or mail. The inline fallback retains the
  code/link in memory and retries completion; there is no second password in
  normal register or login.
- Origin/CSRF: proof-setting and proof-use requests (register, login,
  fallback, resend, and completion) require the exact configured origin
  (missing, null, or mismatched `Origin` is rejected), strict JSON, and
  `Sec-Fetch-Site: cross-site` rejection before quota, mutation, or cookie
  work, with no CORS. Existing logout CSRF protection is not weakened.
- Link page: `GET /verify-email?token=opaque` never consumes the challenge
  and never issues proof. A frontend request boundary returns token-free bootstrap
  HTML without Next.js hydration for token-bearing entry requests. It captures
  the credential in a one-use memory closure and replaces the current URL/history
  before fetching and adopting the clean `/verify-email` document. Only that
  clean request enters the App Router; its serialized URL/query and history tree
  contain no credential. The component takes the handoff into transient memory;
  reload, abandonment, and document pagehide discard it. No private router
  structures are mutated. Consumption requires the user's explicit same-origin
  JSON POST, never scanner GET or automatic page load.
  The page and API require `Referrer-Policy: no-referrer` and
  `Cache-Control: no-store`, including malformed/oversized JSON errors handled
  before authentication routers. Redact sensitive query/cookie/body/header values
  from logs, errors, traces, and analytics. Disable transactional click/open tracking
  where applicable. The link has no fragment.
- Email: contains the code and the link with the 10-minute expiry. The most
  recent requested challenge invalidates older ones; users are told not to
  share codes and to ignore unsolicited ones.
- Client continuation: only `version`, `canonicalEmail`, `challengeId`, and
  `savedAt` may use memory/sessionStorage for at most 30 minutes. Password,
  OTP, and link exist only transiently for input/submission, never in storage;
  proof remains HttpOnly and secrets never enter JavaScript. Normal register/
  login reaches OTP without email/password re-entry. Only valid mailbox proof
  with unusable password proof reveals inline fallback. Reopen recovers through
  Login; refresh does not resend/renew. Preserve Light/Dark, EN/TH, accessibility,
  and existing shadcn/ui direction.
- Frontend boundary: T02A-AUTH-VERIFICATION-WEB-01 implements registration and
  pending-login continuation at `/verify-email`, explicit link confirmation,
  mailbox-first inline password proof, and continuation-aware `/verification-resend`.
  The storage helper validates and allowlists the four continuation fields,
  rejects future/expired timestamps, and never extends retention on refresh.
  The production verification documents have no-store/no-referrer protection.
  All web documents enforce `X-Frame-Options: DENY` and CSP
  `frame-ancestors 'none'`: registration/login or other SPA entry documents
  cannot be framed to bypass verification-route headers. Embedding StockWise
  in frames is unsupported. Next.js development mode overrides the clean page's
  Cache-Control to `no-cache, must-revalidate`; production is the no-store target.
  Resend responses commit only for the mounted, unchanged continuation revision
  and request identity; unmount cancels the request, and late resolution cannot
  overwrite a cleared or superseded flow. Verification and password-proof work
  likewise require the active mounted request and original continuation revision/
  identity before retrying mailbox credentials or applying success/failure state.
  SPA unmount and pagehide invalidate that work and discard transient credentials;
  transport abort is best-effort, not the stale-response safety boundary. A cleared
  and identically recreated continuation is a new revision, not the prior flow.
  Native OTP normalization maps both selection endpoints through ASCII-digit
  filtering and six-digit truncation; keyboard replacement and selection-aware
  paste preserve the resulting caret without changing focus.
  Independent frontend acceptance re-review is accepted. T02A frontend/backend/
  PostgreSQL integration was subsequently ACCEPTED in the isolated local
  environment on 2026-10-10. Real external email and production HTTPS remain
  unverified; isolated acceptance does not establish Live or production readiness.
  Verification grants no session.
- Local/single-process limits only; cloud is not production readiness.
  Fleet, IP/global, provider, proxy, secret-manager IAM, key-rotation
  accounting, capacity, DoS, and outbox behavior are deferred to Phase 8.

## 7. Organization, branch, and membership endpoints

| Method/path | Auth | Request | Response | Key validation/errors | Status |
| --- | --- | --- | --- | --- | --- |
| `POST /organizations` | Authenticated verified account; first-onboarding/replay rules below | Required display, organization, and initial branch names; optional profile/branch phone and branch address | `200`; initial creation or identical replay of safe user/organization/`MAIN` branch/OWNER context | Strict validation; `ALREADY_ONBOARDED`; `ALREADY_HAS_ORGANIZATION_ACCESS`; safe dependency failure | Implemented by P2-M3-T01 |
| `GET /organizations/{organizationId}` | `organization-settings.manage` (OWNER/ADMIN) | No query | Only `id`, `name`, `updatedAt` | Validation; safe forbidden | Implemented by Product-ACCOUNT-01 (ADR-037) |
| `PATCH /organizations/{organizationId}` | `organization-settings.manage` (OWNER/ADMIN) | Exactly `name`, `expectedUpdatedAt` | Only `id`, `name`, `updatedAt` | Validation; safe forbidden; `409 ORGANIZATION_STALE` | Implemented by Product-ACCOUNT-01 (ADR-037) |
| `POST /organizations/{organizationId}/branches` | `OWNER` or `ADMIN` | Code, name; optional phone/address | Created branch | Duplicate code, invalid state | Planned after identity foundation |
| `GET /organizations/{organizationId}/members` | `OWNER` or `ADMIN` | `includeInactive`, opaque cursor, limit | Safe member/user/role/status/configured branch scope page | Invalid cursor, forbidden | Implemented by P2-M3-T03 |
| `GET /organizations/{organizationId}/invitations` | `OWNER` or `ADMIN` | Opaque cursor, limit | Open invitation metadata/scope page; no token/hash | Invalid cursor, forbidden | Implemented by P2-M3-T03 |
| `POST /organizations/{organizationId}/invitations` | `OWNER` for OWNER; `OWNER`/`ADMIN` for non-owner | Exact email, role, full branch IDs | `201` safe invitation state | Existing membership, invalid scope, escalation, provider failure | Implemented by P2-M3-T03 |
| `POST /organizations/{organizationId}/invitations/{invitationId}/revoke` | Same delegation as target invitation | No body | Current safe invitation state | Accepted final state, forbidden | Implemented by P2-M3-T03 |
| `POST /invitations/accept` | Authenticated verified invited email | Exact opaque invitation token | Current membership plus replay flag | Generic invalid invitation, invalid current scope, existing membership | Implemented by P2-M3-T03 |
| `PATCH /organizations/{organizationId}/members/{membershipId}` | `OWNER` for OWNER changes; `OWNER`/`ADMIN` for non-owner | Exact role, full branch IDs, expected `updatedAt` | Updated safe membership | Last owner, escalation, stale/state/scope | Implemented by P2-M3-T03 |
| `POST /organizations/{organizationId}/members/{membershipId}/deactivate` | Same delegation as target membership | Expected `updatedAt` | Inactive safe membership | Last owner, stale, forbidden/not found | Implemented by P2-M3-T03 |
| `POST /organizations/{organizationId}/members/{membershipId}/reactivate` | Same delegation as desired/current role | Exact role, full branch IDs, expected `updatedAt` | Active safe membership | Escalation, stale/state/scope | Implemented by P2-M3-T03 |

No endpoint may accept an arbitrary `organizationId` in the body as ownership truth.

### Organization name settings (ADR-037)

Owner approved the minimal name-only contract on 2026-10-25. Both endpoints
require an authenticated active verified actor, active membership in the selected
active organization, and existing `organization-settings.manage` (OWNER/ADMIN).
The UUID path selects a resource, never authority. Inaccessible organizations,
including other tenants and branch-role access, receive the same safe forbidden
response without disclosing existence. GET accepts no query. Authenticated
responses use `Cache-Control: no-store` and the canonical success envelope with
only `{id,name,updatedAt}` in `data`.

PATCH accepts exactly `{name,expectedUpdatedAt}` and no query. Name is trimmed
only at its edges, nonblank, at most 200 characters; internal whitespace and
Unicode are preserved and duplicate names are allowed. `expectedUpdatedAt` is
the exact previous millisecond UTC timestamp. Required actor, membership,
permission and organization state are revalidated at the transaction boundary.
An atomic conditional PostgreSQL update returns its own row and advances the
version by at least one millisecond, including same-millisecond writes. A stale
or competing version returns `409 ORGANIZATION_STALE` without replacing data.
Existing same-origin/cookie mutation protection remains required.

Unknown fields are rejected, including organization reassignment, status,
membership, role, ownership, VAT state/rate, reporting timezone, contact,
tax/legal and billing fields. No schema migration, credential/session change,
ownership transfer or organization contact-field contract is introduced.
Branch phone/address remain Branch Settings.

### Membership invitation and assignment contract

All request bodies are strict. Invitation create accepts exactly:

```json
{
  "email": "staff@example.com",
  "role": "CASHIER",
  "branchIds": ["opaque-branch-id"]
}
```

The API canonicalizes email. `OWNER` may issue any role; `ADMIN` may issue only
non-owner roles. `OWNER`/`ADMIN` invitations require `branchIds: []`.
`BRANCH_MANAGER`, `INVENTORY_STAFF`, and `CASHIER` require at least one unique
active same-organization branch. Inactive or cross-tenant IDs return the same
safe `400 INVALID_BRANCH_SCOPE`. Any active/inactive membership for that
canonical email returns `409 MEMBERSHIP_ALREADY_EXISTS` without mutation.

Creating for the same organization/email reissues only when the actor may manage
both the existing replaceable invitation's role and the requested new role/scope.
These checks occur inside the existing organization-locked transaction before any
replacement write. In particular, `ADMIN` cannot replace an open OWNER invitation
by requesting a non-owner role; this returns the established `403 FORBIDDEN`,
leaves the original invitation/scope/token validity unchanged, creates no new row
and performs no delivery. Expired but otherwise nonterminal replaceable rows use
the same delegation checks. Authorized reissue marks the prior open row terminal
`REPLACED`, creates a new hash-only seven-day token row and delivers only the new
transient URL. Delivery failure conditionally revokes that row and returns
`503 INVITATION_DELIVERY_FAILED`. Explicit revoke is `POST` with no body.
Revoked and expired outcomes are safe/idempotent `200`; an accepted invitation
returns `409 INVITATION_FINALIZED`. `ADMIN` cannot revoke an OWNER invitation.

Acceptance accepts exactly `{ "token": "opaque-token" }`. Malformed, unknown,
expired, revoked, replaced, wrong-email, or another-actor consumed tokens return
the generic `400 INVALID_INVITATION`. Invalid current branch scope returns `409
INVITATION_SCOPE_INVALID` and leaves the invitation unconsumed. Success returns
HTTP `200` with `{ membership, replayed }`. The first success atomically creates
the membership, assignments, source provenance, and bounded access event while
consuming the invitation. Replay by that same accepted user returns the linked
current membership with `replayed: true` and performs no mutation. A concurrent
membership winner returns `409 MEMBERSHIP_ALREADY_EXISTS` and terminalizes the
invitation so it cannot later mutate that membership.

Member PATCH/reactivate accept exactly:

```json
{
  "role": "BRANCH_MANAGER",
  "branchIds": ["opaque-branch-id"],
  "expectedUpdatedAt": "2026-08-24T18:00:00.000Z"
}
```

This is full replacement. PATCH requires an active membership; reactivation
requires an inactive membership unless the exact active desired state is an
idempotent no-op. Deactivate accepts only `expectedUpdatedAt`; matching-version
inactive deactivation is idempotent. Exact timestamp mismatch returns `409
MEMBERSHIP_STALE`. Organization-wide results inactivate configured assignments;
branch roles activate exactly the requested active scope. Deactivation retains
role, assignments, and sessions but subsequent server access-context and
authorization evaluation excludes the membership. Organization-row locking
enforces `409 LAST_ACTIVE_OWNER` under concurrent demotion/deactivation.

Member and open-invitation lists use ascending `(createdAt,id)` opaque cursors,
default limit 25, maximum 100. Member listing defaults to active rows and accepts
`includeInactive=true`. Responses omit sessions, permission internals, token
hashes/raw values, provider payloads, and persistence internals. Cross-tenant
resource identifiers use safe forbidden/not-found behavior without revealing
existence.

Product-ACCESS-01 reuses these endpoints unchanged. `/app/members` localizes the
fixed-role guidance, member/configured-scope display, open invitation states and
errors; confirms consequential changes; and refreshes access context and list
queries after mutations. A refetched member version does not silently overwrite
or rebase an unsaved edit: the UI requires an explicit latest-version reload
before another write. Team drafts are component-local and reset on actor,
selected-organization or effective-authority changes. Existing private-request,
session-revalidation and Product-ACCOUNT-01 draft protections remain unchanged.
Open invitations are not a complete historical invitation listing.

Every Invite member submission requires EN/TH confirmation showing the submitted
email, requested role and branch scope (or organization-wide access), and warning
that an existing open invitation may be replaced and its previous link invalidated.
The UI must not infer absence of an invitation from paginated/stale list data.
Cancellation sends no create request. Confirmation submits the displayed payload
once, prevents repeated prompts/submissions while pending and is invalidated by
actor/organization/effective-authority or private-session changes. Reissue retains
its separate confirmation; neither confirmation is backend authorization.

### First organization onboarding contract

`POST /organizations` is the one-time first-organization command, not a generic
organization creator. Its strict body accepts exactly:

```json
{
  "displayName": "Owner Name",
  "phone": "+66 1 234 5678",
  "organizationName": "HCN Mart",
  "branchName": "Latkrabang",
  "branchPhone": "+66 2 000 0000",
  "branchAddress": "1 Main Road"
}
```

The three name fields are required. Surrounding whitespace is trimmed and the
result must be nonblank. Optional strings are trimmed and omitted/blank values
persist as `NULL`. Internal whitespace and Unicode representation are preserved;
no Unicode normalization, case folding, phone transformation, or phone format is
introduced. The request never accepts actor, organization, membership, role,
branch, code, permission, onboarding, or idempotency-key state. The API derives
the actor from the verified opaque session and assigns initial branch code
`MAIN` plus role `OWNER` server-side.

The API hashes a deterministic serialization of the canonical six-field value,
including explicit `NULL` optionals, with SHA-256. The internal hash and a unique
per-user provenance record drive replay; neither is accepted or returned. With
no provenance, eligibility requires zero organization memberships regardless of
status. A pending invitation alone is not a membership and does not block the
command. Existing provenance plus the same hash is a non-mutating replay;
different hash returns `409 ALREADY_ONBOARDED`. Membership without provenance
returns `409 ALREADY_HAS_ORGANIZATION_ACCESS`. Both conflicts use the canonical
error envelope and mutate nothing.

Initial success and identical replay return HTTP `200`:

```json
{
  "data": {
    "user": {
      "id": "opaque-user-id",
      "displayName": "Owner Name",
      "phone": null
    },
    "organization": {
      "id": "opaque-organization-id",
      "name": "HCN Mart"
    },
    "branch": {
      "id": "opaque-branch-id",
      "name": "Latkrabang",
      "code": "MAIN",
      "phone": null,
      "address": null
    },
    "role": "OWNER",
    "nextStep": "app"
  },
  "meta": {
    "requestId": "opaque-request-id"
  }
}
```

The result contains no membership/provenance identifier, request hash, session
state, token, permission list, or database representation. The web client
navigates a successful result to `/app`, which is only the P2-M3-T01 completion
holding shell.

## 8. Catalog endpoints

All paths are organization-scoped. Every endpoint authenticates and re-resolves
the active membership and authorization context from PostgreSQL. `OWNER` and
`ADMIN` may omit `branchId`; if supplied it must identify an active branch in
the organization. Other roles must supply query `branchId=<uuid>` for an active
assigned branch. Missing context returns `400 BRANCH_CONTEXT_REQUIRED`; invalid,
inactive, cross-tenant, unassigned, or revoked context returns the same safe
`403 FORBIDDEN`.

| Method/path | Permission | Request | Status |
| --- | --- | --- | --- |
| `GET /organizations/{organizationId}/categories` | `catalog.view` | `branchId`, `limit`, `cursor`, `q`, `includeInactive` | Implemented by P3-M1-T03 |
| `POST /organizations/{organizationId}/categories` | `catalog.create-edit` | Strict name/optional description | Implemented by P3-M1-T03 |
| `GET /organizations/{organizationId}/categories/{categoryId}` | `catalog.view` | Optional `branchId` | Implemented by P3-M1-T03 |
| `PATCH /organizations/{organizationId}/categories/{categoryId}` | `catalog.create-edit` | Name/description plus exact `expectedUpdatedAt` | Implemented by P3-M1-T03 |
| `POST /organizations/{organizationId}/categories/{categoryId}/deactivate` | `catalog.deactivate` | Exact `expectedUpdatedAt` | Implemented by P3-M1-T03 |
| `POST /organizations/{organizationId}/categories/{categoryId}/reactivate` | `catalog.deactivate` | Exact `expectedUpdatedAt` | Implemented by P3-M1-T03 |
| `GET /organizations/{organizationId}/products` | `catalog.view` | `branchId`, `limit`, `cursor`, `q`, `categoryId`, `includeInactive` | Implemented by P3-M1-T03 |
| `POST /organizations/{organizationId}/products` | `catalog.create-edit` | Strict accepted Product fields | Implemented by P3-M1-T03 |
| `GET /organizations/{organizationId}/products/{productId}` | `catalog.view` | Optional `branchId` | Implemented by P3-M1-T03 |
| `PATCH /organizations/{organizationId}/products/{productId}` | `catalog.create-edit` | Mutable fields plus exact `expectedUpdatedAt`; unit excluded | Implemented by P3-M1-T03 |
| `POST /organizations/{organizationId}/products/{productId}/deactivate` | `catalog.deactivate` | Exact `expectedUpdatedAt` | Implemented by P3-M1-T03 |
| `POST /organizations/{organizationId}/products/{productId}/reactivate` | `catalog.deactivate` | Exact `expectedUpdatedAt` | Implemented by P3-M1-T03 |

Category create always starts `ACTIVE`. It accepts only `name` and optional
`description`; blank descriptions become `null`, and normalized identity is
server-derived. PATCH may change name/description on either lifecycle state and
requires at least one mutable field. Missing/cross-tenant detail is
`CATEGORY_NOT_FOUND`; normalized collisions are `CATEGORY_NAME_CONFLICT`; stale
writes are `CATEGORY_STALE`.

Product create always starts `ACTIVE` and accepts only name, description, SKU,
barcode, base-price decimal string, immutable unit, and optional category.
PATCH may change every listed field except unit, status, identity, ownership,
and timestamps. An omitted category preserves the relation; `null` removes it.
New category assignments require an active same-organization Category. An
unrelated edit may retain the Product's current inactive Category. Missing or
cross-tenant categories return `CATEGORY_NOT_FOUND`; inactive new assignments
return `CATEGORY_INACTIVE`. Duplicate SKU/barcode and stale writes return
`SKU_CONFLICT`, `BARCODE_CONFLICT`, and `PRODUCT_STALE`. Product responses always
serialize `basePrice` with exactly four fractional digits and never as a JSON
number.

Lifecycle commands are exact-version, idempotent when already in the desired
state, and never delete or cascade. Direct detail may return inactive records.
Lists default to active records. `includeInactive=true` requires either
`catalog.create-edit` or `catalog.deactivate`; view-only `CASHIER` is denied.

Lists use opaque keyset cursors ordered by immutable `(createdAt ASC, id ASC)`,
default limit 25, and maximum 100. Cursors are bound to normalized filters and
scope candidates; malformed or mismatched cursors return `INVALID_CURSOR`.
Category `q` applies normalized substring matching. Product `q` OR-matches
case-insensitive name substring, canonical SKU prefix, and exact trimmed
barcode. Product `categoryId` accepts a UUID or `uncategorized`; a missing or
cross-tenant filter UUID returns an empty page without disclosing existence.

SKU, barcode, base-price, unit, normalization, optimistic concurrency, and
same-tenant constraints follow `ADR-022`/`ADR-023`. Database uniqueness remains
authoritative under races. No catalog endpoint exposes cost, valuation, COGS,
stock, quantity, branch pricing, or hard deletion.

## 9. Inventory endpoints

| Method/path | Auth | Request | Response | Key validation/errors | Status |
| --- | --- | --- | --- | --- | --- |
| `GET /organizations/{organizationId}/branches/{branchId}/inventory` | Branch inventory read | Cursor, category/status filters | Product + current balance page | Invalid filter/cursor, forbidden branch | Implemented in P3-M2-T03; `ADR-030` stock classification is planned only for the later inventory analytics endpoint, not this operational list |
| `GET /organizations/{organizationId}/branches/{branchId}/inventory/{productId}` | Branch inventory read | None | Current balance and product summary | Safe not-found/cross-tenant | Implemented in P3-M2-T03 |
| `GET /organizations/{organizationId}/branches/{branchId}/inventory/{productId}/transactions` | Branch inventory read | Cursor, source/date filters | Stable ledger page | Invalid range/cursor, safe product not-found | Implemented in P3-M2-T03 |
| `POST /organizations/{organizationId}/branches/{branchId}/inventory/adjustments` | Branch stock adjust | `Idempotency-Key`; product, signed `delta`, reason, optional note | Movement + new balance | Invalid/zero/excess-scale delta, inactive/cross-tenant resource, `INSUFFICIENT_STOCK`, `IDEMPOTENCY_CONFLICT` | Implemented in P3-M2-T04; `ADR-022`, `ADR-024` |

Adjustment request must not contain an authoritative resulting balance. The server
applies a signed delta within one PostgreSQL transaction after pessimistically
serializing the authoritative branch/product balance. A negative result returns
`409 INSUFFICIENT_STOCK` with no ledger/balance mutation. The exact header grammar
is 1–200 visible ASCII characters without spaces; only its SHA-256 hash is persisted.
New success returns `201`; an identical replay returns `200` and reconstructs the
original logical result. The accepted request and response shapes are:

```json
{
  "productId": "opaque-product-id",
  "delta": "-2.25",
  "reason": "DAMAGE",
  "note": "Damaged during handling"
}
```

```json
{
  "data": {
    "balance": { "quantity": "7.75" },
    "transaction": {
      "id": "opaque-movement-id",
      "delta": "-2.25",
      "source": "MANUAL_ADJUSTMENT",
      "reason": "DAMAGE",
      "note": "Damaged during handling",
      "occurredAt": "2026-08-30T12:00:00.000Z"
    }
  },
  "meta": { "requestId": "opaque-request-id" }
}
```

`STOCK_COUNT`, `DAMAGE`, `LOSS`, `FOUND`, `CORRECTION`, and `OTHER` are
accepted reasons. `OTHER` requires a nonblank note; other blank notes become null.
Inactive Branch/Product state returns `BRANCH_INACTIVE`/`PRODUCT_INACTIVE` at
`409`. The response never exposes idempotency hashes or membership provenance.

Stock transfer is **DEFERRED FROM MVP** by `ADR-025`. No transfer endpoint or future
endpoint contract is defined.

Inventory reads require a trusted concrete branch scope and `inventory.view`.
Branch-scoped roles require an existing active, non-revoked assignment to the
requested same-organization branch, plus an active actor, organization, and
membership. `OWNER`/`ADMIN` retain organization-wide reads but must still select
a concrete branch path. Under the 2026-10-01 clarification of `ADR-020`, an
`INACTIVE` branch alone does not revoke these authorized read-only balance and
history reads: a retained assignment may yield `200`; removing/revoking it
removes branch-scoped read access. This does not add the inactive branch to
`GET /me/access-context` or authorize new operational mutations. Inventory
adjustment still requires an `ACTIVE` branch and otherwise returns
`409 BRANCH_INACTIVE` for an otherwise authorized actor. Balance list `status`
filters Product status, not Branch status; it is `ACTIVE` by default and accepts
`INACTIVE` or `ALL`; `categoryId` accepts a same-tenant UUID or `uncategorized`. Its opaque
cursor is bound to the organization, branch, and filters and orders products by
`(createdAt ASC, id ASC)`. The result includes every matching Product, even when
it has no persisted balance: `{ exists: false, quantity: "0", updatedAt: null }`
represents the accepted lazy zero without creating a row. Direct product detail
also includes inactive products and preserves this representation.

Transaction history is scoped to one branch/product and orders immutable ledger
rows by `(occurredAt ASC, id ASC)`, matching the chronological index. Its cursor
is bound to that scope plus the optional `source`, `occurredAfter`, and
`occurredBefore` ISO-8601 UTC filters. The current source allow-list is
`MANUAL_ADJUSTMENT` or `PURCHASE_RECEIVE`. Purchase-receive rows have null
adjustment reason/note and retain their direct receipt-item provenance internally.
History returns its movement ID, canonical decimal-string delta, source/reason/note,
timestamp, and minimal actor ID/display name. It never
returns idempotency-key hashes, canonical-request hashes, membership IDs, or
other internal provenance fields.

## 10. Supplier and purchasing endpoints

### Suppliers

| Method/path | Auth | Request | Response | Key validation/errors | Status |
| --- | --- | --- | --- | --- | --- |
| `GET /organizations/{organizationId}/suppliers` | Supplier view | Cursor/search/status | Suppliers | Invalid cursor/filter | Implemented by P4-M1-T02 |
| `POST /organizations/{organizationId}/suppliers` | Supplier create/edit | Bounded Supplier fields | Supplier | Validation | Implemented by P4-M1-T02 |
| `GET /organizations/{organizationId}/suppliers/{supplierId}` | Supplier view | None | Supplier | Safe not-found | Implemented by P4-M1-T02 |
| `PATCH /organizations/{organizationId}/suppliers/{supplierId}` | Supplier create/edit | Mutable bounded fields | Supplier | Validation/safe not-found | Implemented by P4-M1-T02 |
| `POST /organizations/{organizationId}/suppliers/{supplierId}/deactivate` | Supplier deactivate (`OWNER`/`ADMIN`) | Empty body | Supplier | Safe not-found | Implemented by P4-M1-T02 |
| `POST /organizations/{organizationId}/suppliers/{supplierId}/reactivate` | Supplier deactivate (`OWNER`/`ADMIN`) | Empty body | Supplier | Safe not-found | Implemented by P4-M1-T02 |

### Purchase orders and receipts

| Method/path | Auth | Request | Response | Key validation/errors | Status |
| --- | --- | --- | --- | --- | --- |
| `GET /organizations/{organizationId}/branches/{branchId}/purchase-orders` | Branch purchasing read | `cursor`, `limit`, `status`, `supplierId`, inclusive `orderDateFrom`/`orderDateTo` | Purchase order summaries | Invalid range/filter-bound cursor | Implemented by P4-M2-T02 |
| `POST /organizations/{organizationId}/branches/{branchId}/purchase-orders` | Branch purchasing write | Supplier, one line per Product, quantities, expected THB costs | Server-referenced `DRAFT` purchase order | Cross-tenant/inactive refs, invalid/duplicate lines/cost | Implemented by P4-M2-T02; `DRAFT` lifecycle follows `ADR-026`, quantity follows `ADR-022` |
| `GET /organizations/{organizationId}/branches/{branchId}/purchase-orders/{purchaseOrderId}` | Branch purchasing read | None | Order and immutable item snapshots | Safe not-found | Implemented by P4-M2-T02 |
| `PATCH /organizations/{organizationId}/branches/{branchId}/purchase-orders/{purchaseOrderId}` | Branch purchasing write | DRAFT field replacement or accepted state intent plus exact `expectedUpdatedAt` | Purchase order | Non-editable/stale/terminal-state conflict | Implemented by P4-M2-T02; lifecycle follows `ADR-026` |
| `POST /organizations/{organizationId}/branches/{branchId}/purchase-orders/{purchaseOrderId}/receipts` | `OWNER`, `ADMIN`, assigned `BRANCH_MANAGER`, or assigned `INVENTORY_STAFF` for the persisted PO branch | Mandatory `Idempotency-Key`; actual THB costs keyed by PO item plus bounded document-level Input VAT snapshot; no received quantities | `201` completed Receipt; identical replay returns the same logical Receipt with `200` | Strict transport; ORDERED/exact frozen quantity/cost/VAT/idempotency/concurrency | Implemented by P4-M3-T02; `ADR-022`, `ADR-024`, and `ADR-026` |

Receipt persistence and the atomic receiving service are implemented by P4-M3-T01;
P4-M3-T02 exposes only that existing transaction through the command above. The
service derives every receipt quantity from the frozen ORDERED PO, creates at most
one immutable receipt, and does not expose a sequence of public endpoints for
separately creating a receipt and then mutating stock. Partial/over/short/multiple
receipt, receiving without a PO, supplier returns, and receipt correction/reversal
have no MVP endpoint. The route `branchId` is a validated candidate context only;
the service authorizes against the PO's persisted Branch.

The mandatory `Idempotency-Key` follows the existing printable ASCII 1–200-character
header contract. The API does not generate or replace the key. Within one
Organization, the same key and canonical receive intent replays the same logical
Receipt without another stock/cost movement; reuse for a different actual-cost or
VAT intent returns `409 IDEMPOTENCY_CONFLICT`. The same raw key is independently
namespaced in another Organization.

```json
{
  "actualCosts": [
    {
      "purchaseOrderItemId": "opaque-uuid",
      "actualUnitCost": "12.3400"
    }
  ],
  "vat": {
    "organizationVatRegistered": true,
    "inputVatRate": "7.000000",
    "inputVatAmount": "0.8638",
    "supplierTaxDocumentNumber": "TAX-100",
    "supplierTaxDocumentDate": "2026-09-02"
  }
}
```

`actualCosts` contains exactly one mapping for every frozen PO item. Item identity is
the stable `purchaseOrderItemId`; values are non-negative decimal strings at scale at
most four and are never interpreted as JavaScript `number`. Missing, duplicate,
extra, malformed, negative, or excess-scale mappings return `400 VALIDATION_ERROR`.
The body is strict and rejects client quantities, Branch/Supplier/Product overrides,
receipt identity/timestamps, balance/cost results, and PO status.

Because MVP Organization data has no authoritative VAT-registration master field, the
receiving command supplies an explicit receipt-time VAT-registration assertion.
The service validates and snapshots that assertion independently and includes it in
receipt-level idempotency; it is not inferred from VAT amounts or Supplier documents.
Rate and amount are both null or both present; a non-VAT-registered assertion cannot
carry them. Rate accepts a non-negative decimal string at scale at most six, amount at
scale at most four, document number is nullable/trimmed/nonblank up to 100 characters,
and document date is nullable valid `YYYY-MM-DD`. Invalid combinations return
`400 VALIDATION_ERROR`; the API performs no VAT calculation.

Successful responses use `{ "data": { "receipt": ... }, "meta": {
"requestId": ... } }`. Public Receipt fields are `id`, `organizationId`, `branchId`,
`purchaseOrderId`, `supplierId`, `reference`, `receivedAt`, `createdAt`,
`receivedByUserId`, the five bounded VAT snapshot fields, and immutable `items` with
`id`, `purchaseOrderItemId`, `productId`, SKU/name snapshots, server-derived
`receivedQuantity`, and four-place `actualUnitCost`. Internal membership identity,
idempotency/canonical hashes, lock material, and database metadata are not exposed.

Stable command failures include `401 AUTHENTICATION_REQUIRED`, `403 FORBIDDEN`,
`404 PURCHASE_ORDER_NOT_FOUND`, `409 BRANCH_INACTIVE`, `409 PRODUCT_INACTIVE`,
`409 PURCHASE_ORDER_STATE_CONFLICT`, `409 PURCHASE_ORDER_RECEIPT_INVALID`,
`409 IDEMPOTENCY_CONFLICT`, and `409 RECEIPT_REFERENCE_CONFLICT`. Unexpected storage
failures use the generic `500 INTERNAL_ERROR` envelope without SQL/Prisma details.

Purchase-order creation is server-authorized for the concrete active branch and
creates a THB-only `DRAFT` with a server-generated immutable PO reference.
Expected unit cost and quantity are decimal strings with at most four fractional
places; `EA`, `PACK`, and `BOX` quantities are integral. The server derives the
four-place `expectedTotal` from the submitted lines and persists product SKU/name
snapshots. Client totals and references are not accepted.

Lists sort by descending `(createdAt,id)` and use opaque cursors bound to the
organization, route branch, status, supplier, and inclusive order-date filters.
`status` defaults to `all`; every cursor reuse with different filters returns
`400 INVALID_CURSOR`. Detail and write access re-authorize the concrete persisted
branch, not client-provided scope.

PATCH accepts either one or more DRAFT fields (`branchId`, `supplierId`,
`orderDate`, nullable `expectedDate`, and full replacement `items`) or exactly
one lifecycle intent (`ORDERED` or `CANCELLED`), always with the exact
millisecond `expectedUpdatedAt`. It returns `409 PURCHASE_ORDER_STALE` for a
version mismatch. Only `DRAFT` may be edited. `DRAFT -> ORDERED`,
`DRAFT -> CANCELLED`, and `ORDERED -> CANCELLED` are accepted; `RECEIVED` and
`CANCELLED` are terminal. ORDERED state freezes branch, supplier, lines,
quantities, expected costs, and snapshots. Ordering revalidates the referenced
Supplier and Products, recalculates the expected total, and creates no receipt,
inventory transaction, stock movement, cost update, or VAT record.

## 11. POS and sales endpoints

| Method/path | Auth | Request | Response | Key validation/errors | Status |
| --- | --- | --- | --- | --- | --- |
| `GET /organizations/{organizationId}/sales-vat-profile` | `OWNER`, `ADMIN` | None | Authoritative Organization sales VAT profile | Safe not-found/forbidden | Implemented; P5-M2-T02 |
| `PATCH /organizations/{organizationId}/sales-vat-profile` | `OWNER`, `ADMIN` | Exact `expectedUpdatedAt`; status and conditional rate | Updated sales VAT profile | Invalid state/rate, stale version, safe not-found/forbidden | Implemented; P5-M2-T02 |
| `GET /organizations/{organizationId}/branches/{branchId}/pos/products` | Branch checkout | Query/barcode/cursor | Sellable product summaries with current server price/availability indicator | Invalid query, forbidden branch | Implemented; P5-M2-T02 |
| `POST /organizations/{organizationId}/branches/{branchId}/sales` | `OWNER`, `ADMIN`, assigned `BRANCH_MANAGER`, assigned `CASHIER` | Required `Idempotency-Key`; unique cart lines, optional authorized discount, CASH/TRANSFER intent | `201` completed Sale-backed receipt; exact replay `200` | VAT config, price, stock, payment, discount, idempotency, concurrency | Implemented; P5-M2-T02; `ADR-027` |
| `GET /organizations/{organizationId}/branches/{branchId}/sales` | `OWNER`, `ADMIN`, assigned `BRANCH_MANAGER`, assigned `CASHIER` | `cursor`, `limit`, absolute `createdAtFrom`/`createdAtTo`, `actorUserId`; no V1 refund-status filter | Historical Sale summaries with derived refund state/amounts | Invalid query/range/cursor, safe forbidden | Implemented by P5-M3-T01 and P5-M4-T02 |
| `GET /organizations/{organizationId}/branches/{branchId}/sales/{saleId}` | Branch sales read | None | Immutable Sale/line/payment/cost snapshots with linked refunds and remaining quantities | Safe not-found/forbidden | Implemented by P5-M3-T01 and P5-M4-T02 |
| `POST /organizations/{organizationId}/branches/{branchId}/sales/{saleId}/refunds` | `OWNER`, `ADMIN`, assigned `BRANCH_MANAGER` | Required `Idempotency-Key`; unique SaleItem quantities/restock quantities; required reason; conditional TRANSFER reference | `201` immutable linked SaleRefund; identical replay `200` | Historical allocation, cumulative quantity, payment, restock/cost, idempotency, concurrency | Implemented by P5-M4-T02; `ADR-028`; no VOID endpoint |

Sales-history listing is ordered by `createdAt DESC, id DESC`. Its opaque, versioned
cursor is bound to the Organization, Branch, `createdAtFrom`, `createdAtTo`, and
`actorUserId` filter context and continues that two-field keyset; changing any path or
filter makes the cursor invalid. `limit` defaults to `25` and is bounded from `1` to
`100`. `createdAtFrom` is inclusive and `createdAtTo` exclusive; both accept only
RFC3339 absolute timestamps with an explicit offset or `Z`, and the former must be before
the latter. These Sales History filters intentionally remain absolute instants and do
not become Organization-calendar selectors; `ADR-029` applies its date-only reporting
range contract to analytics endpoints. `actorUserId` is an exact UUID match against the persisted Sale actor
and remains constrained by the authorized Organization/Branch query. Summary and detail
values come only from immutable Sale/SaleItem/Payment snapshots. Cost/COGS fields appear
only to OWNER, ADMIN, and assigned BRANCH_MANAGER detail readers; they never appear in
Sale summaries or cashier/customer receipt data. Browser receipt printing uses the existing
Sale detail response as its immutable data source; this phase has no separate receipt API.

Sales VAT profile target representation:

```json
{
  "salesVatStatus": "REGISTERED",
  "salesVatRate": "7",
  "updatedAt": "2026-09-05T00:00:00.000Z"
}
```

`salesVatStatus` is `UNCONFIGURED`, `NOT_REGISTERED`, or `REGISTERED`.
`UNCONFIGURED` is an application configuration state, not a legal registration
classification, and blocks checkout. REGISTERED requires a positive rate below `100`;
the other statuses require `salesVatRate: null`. The configured rate is never
hardcoded. In MVP, every Product sold by a REGISTERED Organization is assumed subject
to this one rate; mixed/product-specific/exempt/zero-rated/multiple-rate tax behavior
is unsupported. The profile is Organization authority, not checkout input.

Conceptual `PATCH` request bodies are:

```json
{
  "expectedUpdatedAt": "2026-09-05T00:00:00.000Z",
  "salesVatStatus": "REGISTERED",
  "salesVatRate": "7"
}
```

or, for either non-rate state:

```json
{
  "expectedUpdatedAt": "2026-09-05T00:00:00.000Z",
  "salesVatStatus": "NOT_REGISTERED",
  "salesVatRate": null
}
```

The endpoint accepts only exact decimal strings for the rate, enforces the conditional
state/rate rules, and uses `expectedUpdatedAt` as an exact optimistic-concurrency
precondition. Existing and newly created Organizations start `UNCONFIGURED` with a
null rate until an authorized `OWNER` or `ADMIN` explicitly changes the profile.

Accepted CASH checkout request:

```json
{
  "items": [
    {
      "productId": "opaque-id",
      "quantity": "2",
      "expectedUnitPrice": "60.1234"
    }
  ],
  "discount": {
    "type": "PERCENT",
    "percent": "10",
    "reason": "Manager-approved opening promotion"
  },
  "payment": {
    "method": "CASH",
    "amountTendered": "200.00"
  }
}
```

Accepted TRANSFER payment alternative:

```json
{
  "method": "TRANSFER",
  "reference": "optional-bank-or-qr-reference"
}
```

Conceptual completed Sale/customer-receipt response data:

```json
{
  "id": "opaque-sale-id",
  "reference": "SALE-<uuid>",
  "organizationId": "opaque-organization-id",
  "branchId": "opaque-branch-id",
  "organizationNameSnapshot": "Example Store",
  "branchNameSnapshot": "Main Branch",
  "branchCodeSnapshot": "MAIN",
  "actorDisplayNameSnapshot": "Employee Name",
  "occurredAt": "2026-09-05T00:00:00.000Z",
  "currency": "THB",
  "items": [
    {
      "productId": "opaque-product-id",
      "skuSnapshot": "SKU-001",
      "nameSnapshot": "Product",
      "unitSnapshot": "EA",
      "quantity": "2",
      "unitPrice": "60.1234",
      "lineGross": "120.25",
      "lineDiscount": "12.03",
      "lineTaxable": "101.14",
      "lineOutputVat": "7.08",
      "lineNet": "108.22"
    }
  ],
  "subtotalAmount": "120.25",
  "discount": {
    "type": "PERCENT",
    "percent": "10",
    "reason": "Manager-approved opening promotion"
  },
  "discountAmount": "12.03",
  "salesVatStatusSnapshot": "REGISTERED",
  "vatRateSnapshot": "7",
  "taxableAmount": "101.14",
  "outputVatAmount": "7.08",
  "totalAmount": "108.22",
  "payment": {
    "method": "CASH",
    "amount": "108.22",
    "amountTendered": "200.00",
    "changeAmount": "91.78",
    "reference": null
  }
}
```

The actual response uses the standard success envelope. Customer money totals and
allocations serialize with exactly two fractional digits, accepted unit prices with
exactly four fractional digits, and quantity strings with no more than four fractional
digits. Request boundaries reject rather than round values that exceed their accepted
scale. A no-discount response uses a null discount descriptor and
`discountAmount: "0.00"` in the frozen resource contract. A NOT_REGISTERED response
uses null Sale/line taxable amounts and VAT-rate snapshot plus `"0.00"` Sale/line
Output VAT. It must not label Sale net as taxable base.

Rules:

- The transient cart is not persisted before checkout. Duplicate Product lines are
  rejected. Quantity follows `ADR-022`; `expectedUnitPrice` is an exact optimistic
  precondition only. The server reloads active Product and `basePrice`, rejects a
  mismatch with `409 PRICE_CHANGED`, and computes all authoritative values.
- Discount is optional and whole-Sale only. `AMOUNT` supplies `amount` with scale at
  most two; `PERCENT` supplies `percent` with scale at most four. Both require a
  trimmed nonblank reason of at most 200 characters and manager-or-higher authority.
  Amount is positive and less than subtotal; percent is positive and below `100`.
- CASH requires `amountTendered` with scale at most two and at least the server total.
  TRANSFER has no tender/change and may carry one trimmed reference up to 100
  characters. Payment amount is not client-authored; it equals the Sale total. No
  CARD, split, gateway, pending, offline, slip, OCR, or Payment-status input exists.
- Server applies optional discount before registered document-level VAT extraction.
  It uses exact Decimal arithmetic, `ROUND_HALF_UP` at accepted document/cost
  boundaries, and deterministic Product-ID-tied largest-remainder line allocation.
  Excess-scale inputs are rejected rather than rounded.
- First success returns `201`; same `Idempotency-Key` plus the same canonical trusted
  Organization/Branch/actor, sorted lines/quantities/expected prices, discount, and
  payment intent returns the original logical Sale/reference with `200`. Changed
  intent returns `409 IDEMPOTENCY_CONFLICT`. The key is printable ASCII 1–200
  characters and only its deterministic hash is persisted.
- Stable checkout conflicts include `PRICE_CHANGED`, `INSUFFICIENT_STOCK`,
  `IDEMPOTENCY_CONFLICT`, `VAT_CONFIGURATION_REQUIRED`, and safe active-resource/
  authorization conflicts. Validation covers decimal scale, discount, payment, and
  duplicate-line rules.
- Response uses immutable Sale/SaleItem/Payment snapshot values and reference
  `SALE-<UUID>`. It contains no Sale status, Customer/CRM data, or COGS in its customer
  receipt representation. Internal cost fields require a separate authorized history
  view later.
- OpenRouter is never called in checkout.

### Refund contract

`ADR-028` resolves `OQ-009` with REFUND only. No `/void`, Sale mutation, standalone
refund-receipt, or refund-of-refund endpoint exists. P5-M4-T02 implements the
accepted create command and extend existing history/detail projections; the contract
below does not claim that runtime implementation exists yet.

The create body is strict and has this conceptual shape:

```json
{
  "items": [
    {
      "saleItemId": "uuid",
      "quantity": "1",
      "restockQuantity": "1"
    }
  ],
  "reason": "Customer returned unopened item",
  "transferReference": null
}
```

Rules:

- `items` is nonempty with unique original SaleItem IDs. `quantity` is positive and
  `restockQuantity` is non-negative and no greater than `quantity`; both follow the
  original Product unit and four-place quantity boundary. The server rejects excess
  scale, non-integral integer units, and cumulative quantity above the original line.
- The route Organization/Branch/Sale are candidate scope only. The service authorizes
  against the original Sale's persisted Organization and active Branch. Current Product
  inactivity does not block a historical refund. Cross-branch returns are invalid.
- `reason` is trimmed, Unicode-preserving, nonblank, and 1–200 characters. There is no
  time cutoff or approval input. `OWNER`, `ADMIN`, and assigned `BRANCH_MANAGER` may
  create; CASHIER and INVENTORY_STAFF may not.
- Payment method is not client-selected; it must equal the original Payment method.
  CASH requires `transferReference: null`. TRANSFER requires a trimmed nonblank
  1–100-character manual confirmation reference. Refund amount is server-derived;
  clients cannot send price, total, discount, VAT, taxable, cost, or COGS values.
- Refund money uses the cumulative-target exact-decimal algorithm in `ADR-028` over
  original SaleItem net/discount/VAT snapshots. The operation total must be positive.
  Final line quantity absorbs remaining cents so cumulative values equal the original.
- Only positive `restockQuantity` appends a positive `SALE_REFUND_RETURN` movement and
  changes balance/cost state. Historical COGS uses original SaleItem cost and restocked
  quantity; UNKNOWN stays null. Original Sale/Payment/items/`SALE` movements remain
  immutable.
- `Idempotency-Key` is mandatory printable ASCII of 1–200 characters. Under the
  Organization-scoped `SALE_REFUND` namespace, same key plus canonical trusted
  Organization/Branch/actor, Sale, sorted item quantities, reason, derived payment
  method, and transfer reference returns the original logical refund with `200`.
  First success returns `201`; changed intent returns `409 IDEMPOTENCY_CONFLICT`.
- The command serializes the original Sale before cumulative validation, then acquires
  shared Branch/Product locks for restocked Products in sorted Product-ID order. Refund,
  items, one payment, optional ledger/balance/cost updates, and idempotency result are
  one transaction.

The safe response contains immutable refund `id`, `reference`, `organizationId`,
`branchId`, `saleId`, reason, actor display snapshot, `completedAt`, currency, exact
gross/discount/taxable/VAT/total strings, matching-method payment evidence, and items
with original SaleItem/Product identity, refund/restock quantities, and monetary
components. Cost basis/unit cost/COGS reversal appear only to OWNER, ADMIN, and assigned
BRANCH_MANAGER. Internal hashes, membership IDs, lock material, and database metadata
are never exposed.

Stable command failures include `401 AUTHENTICATION_REQUIRED`, `403 FORBIDDEN`, safe
`404 SALE_NOT_FOUND`, `409 BRANCH_INACTIVE`, `409 SALE_ALREADY_FULLY_REFUNDED`, `409
REFUND_QUANTITY_EXCEEDED`, `409 IDEMPOTENCY_CONFLICT`, and `400 VALIDATION_ERROR` for
invalid quantity/restock/reason/reference or a zero-total request. Unexpected storage
failures use generic `500 INTERNAL_ERROR` without SQL/Prisma details.

The P5-M4-T02 history projection adds derived refund state (`NONE`,
`PARTIALLY_REFUNDED`, `FULLY_REFUNDED`), cumulative refunded amount, and remaining
amount while retaining the original Sale total. Detail adds linked refunds and
per-line remaining quantities. Linked refunds order by `(completedAt ASC, id ASC)`;
their items follow original SaleItem `(createdAt ASC, id ASC)` order. The browser
receipt remains the original immutable Sale projection; refund activity is displayed
separately outside its print region. V1 adds no refund-status list filter and no
printable refund document.

## 12. Analytics endpoints

`ADR-029` accepts Analytics V1 metric and reporting-time semantics. The Sales,
Category, and Branch endpoints are implemented by P6-M2-T03; Inventory by
P6-M3-T03; Forecast and Reorder by P6-M4-T04. Phase 6 API work is complete. Every
response returns the metadata required by `docs/contracts/ANALYTICS.md` and only metrics
marked Accepted.

Common query concepts:

```text
scope=branch|organization
branchId=<allowed branch when branch scope>
from=YYYY-MM-DD                 # Organization-local, inclusive
to=YYYY-MM-DD                   # Organization-local, exclusive
granularity=day|week|month|year
cursor=<opaque>                 # Implemented Category/Branch/Inventory dimension pages
limit=1..100                    # Dimension pages; default 25
```

`from`, `to`, and `granularity` are required; the API has no implicit period. Dates are
interpreted only in the Organization IANA reporting timezone. Date-times/offsets,
unaligned week/month/year boundaries, `from >= to`, and spans beyond 366 local dates
are validation errors. Week boundaries are Monday local `00:00`. The server converts
local boundaries to half-open UTC instants with IANA/DST rules and returns both forms.
Summary/timeseries buckets are ascending, gap-filled, and not paginated. Category and
Branch dimension rows use stable opaque cursors and deterministic ID ordering.
P6-M2-T02 Category/Branch dimension pages bind the cursor to metric version,
dimension, Organization, authorized Branch set, canonical range/granularity, ordering,
and source cutoff; the selected dimension series carries every requested canonical
bucket. P6-M2-T02 itself adds no HTTP endpoint. P6-M2-T03 exposes these
accepted internal row contracts without ranking or Top-N behavior.

Common success metadata includes `metricDefinitionVersion: "analytics-v1"`, scope,
included authorized Branch IDs/count, requested local dates/granularity, exact UTC
`periodStartInclusive`/`periodEndExclusive`, `reportingTimezone`, `generatedAt`,
`sourceCutoff`, and `dataStatus`. Inventory responses additionally distinguish
page-current `currentSnapshotCapturedAt` from their cursor-bound event `sourceCutoff`.
Monetary/quantity/percentage fields are decimal strings; null metrics carry a stable
reason. Cost outputs also carry cost coverage.

| Method/path | Auth | Request | Response | Key validation/errors | Status |
| --- | --- | --- | --- | --- | --- |
| `GET /organizations/{organizationId}/analytics/sales` | `BUSINESS_ANALYTICS_VIEW`; cost fields also `SALES_COST_VIEW` | Required `scope=organization` or `scope=branch&branchId={id}` plus `from`, `to`, `granularity` | Canonical bucket series with accepted Sales/discount/VAT/refund/count/AOV/growth/profit metrics | Invalid period/inaccessible scope | Implemented P6-M2-T03 |
| `GET /organizations/{organizationId}/analytics/categories` | `BUSINESS_ANALYTICS_VIEW` | Same required scope/period plus optional `cursor`, `limit` | Current Category/Uncategorized dimension page with only identity, current name/status, Gross Sales, Discount Amount, Sales After Discount, Refund Amount, Net Sales, Category Share per canonical bucket | Invalid period/cursor/inaccessible scope | Implemented P6-M2-T03 |
| `GET /organizations/{organizationId}/analytics/inventory` | `INVENTORY_ANALYTICS_VIEW`; value/cost fields also `SALES_COST_VIEW` | Scope + required range/granularity; optional opaque dimension `cursor`/`limit`, no client cutoff | T01 paginated Branch/Product movement series, page-current snapshots, Branch availability/value summaries, and each dimension's `stockClassification` object (`classification`, `reason`, `thresholdVersion`) from T02 | Null classification preserves an accepted unavailable reason; no `STOCKOUT_RISK`, ranking, or Top-N | Implemented P6-M3-T03; T01 and T02 remain internal sources; forecast follows `ADR-031` and Reorder V1 follows `ADR-032`, but neither is exposed here |
| `GET /organizations/{organizationId}/analytics/branches` | `BUSINESS_ANALYTICS_VIEW`; cost fields also `SALES_COST_VIEW` | Same required scope/period plus optional `cursor`, `limit` | Every authorized Branch, including zero-activity Branches, with current name/status and accepted P6-M2-T01 metrics per canonical bucket; no ranking | Unauthorized Branch/invalid period/cursor | Implemented P6-M2-T03 |
| `GET /organizations/{organizationId}/analytics/forecast` | `FORECAST_REORDER_VIEW` at authorized Branch scope; quantity only | Required `branchId` and `productId` UUID query parameters; no period or pagination | `data.forecast`: one `ADR-031` result with identity/unit, version, cutoff/timezone, training and horizon bounds, status/reason, seven daily values and total when available | Invalid query `400`; inaccessible scope `403`; missing/inaccessible pair `404`; invalid timezone configuration `500` | Implemented P6-M4-T04 |
| `GET /organizations/{organizationId}/analytics/reorder-recommendations` | `FORECAST_REORDER_VIEW` at authorized Branch scope; quantity only | Required `branchId` and `productId` UUID query parameters; optional numeric `leadTimeDays` query parameter | `data.recommendation`: one `ADR-032` result with identity/unit, versions, cutoff, lead time, status/reason, daily forecast context, demand, on-hand, raw need and recommended quantity | Missing lead time gives `UNAVAILABLE/LEAD_TIME_REQUIRED`; numeric noninteger/out-of-range gives `UNAVAILABLE/UNSUPPORTED_LEAD_TIME`; malformed query `400`; inaccessible scope `403`; missing/inaccessible pair `404` | Implemented P6-M4-T04 |

Forecast and reorder responses include `meta.requestId`. Quantities are four-place decimal strings, never JSON numbers. `UNAVAILABLE` is a successful `200` response with null unavailable metrics; it is distinct from request/authentication errors. Both routes use a single Branch/Product grain without pagination. They return no prices, costs, Supplier, Purchase Order, or purchasing action. The forecast's current partial Organization-local day is excluded. Reorder is advisory, uses caller-selected 1–7 day planning lead time, zero safety stock, and no incoming-order credit, Supplier/MOQ, or automatic order.

Analytics error/null semantics:

- Sales returns `data.buckets`; Category returns `data.categories`; Branch returns
  `data.branches`. Dimension responses add `meta.nextCursor` (`null` at the end).
  All three return `meta` with `metricDefinitionVersion`, `scopeType`,
  `organizationId`, `includedBranchIds`, `includedBranchCount`, `granularity`,
  `localFromInclusive`, `localToExclusive`, `periodStartInclusive`,
  `periodEndExclusive`, `reportingTimezone`, `generatedAt`, `sourceCutoff`,
  `dataStatus`, and `requestId`. UTC instants are ISO strings; exact money,
  cost, and percentage values are decimal strings. Null metrics retain their reasons.
- Dimension cursors freeze the authorized execution inputs and source cutoff across
  pages. Current Category membership and labels remain live and may reclassify
  historical facts between pages; pagination is not a catalog snapshot.
- Inventory pagination selects Branch/Product dimensions ordered by
  `(branchId ASC, productId ASC)`, default 25 and maximum 100; each selected row
  carries every requested canonical movement bucket. Its signed internal cursor
  binds version/dimension, Organization, reauthorized Branch set, canonical period,
  timezone/UTC bounds, order, and original event `sourceCutoff`. Each continuation
  page reads current on-hand/value/availability under its own
  `currentSnapshotCapturedAt`; it must not present those mutable values as a
  historical snapshot at the original cutoff. P6-M3-T03 owns the HTTP
  representation. No client-supplied current cutoff is accepted.
- P6-M3-T03 inventory HTTP representation uses the existing `{ data, meta }`
  analytics envelope. `data.dimensions` is the paginated Branch/Product row array;
  each row contains current Branch/Product identity, Product unit/status, the five
  source-separated decimal-string movement quantities in every canonical `buckets`
  entry, `requestedPeriodAds`, `coverageSalesVelocity`, current
  `onHandQuantity`, `coverageDays`, and the T02 `stockClassification` object.
  `data.branches` contains the page-current unpaginated M-110 availability summary
  for every included Branch. Rows and Branch summaries include `cost` only when
  `SALES_COST_VIEW` is authorized; its exact T01 `inventoryValue` null/reason,
  `knownInventoryValue`, known/unknown Product counts, and
  `unknownQuantityByUnit` are preserved. `meta` follows the existing dimension
  metadata, including `nextCursor`, and additionally returns the page's
  `currentSnapshotCapturedAt` ISO instant. Later pages keep the original
  `sourceCutoff` while the current snapshot marker may advance.
- The `stockClassification` is page-current `stock-risk-v1` from that
  dimension's existing `coverageDays`. `LOW_STOCK` applies at `<= 7.00`, `NORMAL`
  at `> 7.00` and `< 60.00`, and `OVERSTOCK` at `>= 60.00`. If coverage is null,
  classification is null with its T01 reason; an inactive Product instead has
  null/`INACTIVE_PRODUCT`. The object needs only `INVENTORY_ANALYTICS_VIEW`, so
  assigned `INVENTORY_STAFF` may see it without cost/value fields. No additional
  risk cursor, ranking, or historical risk series is planned.
- Invalid selectors and period boundaries return `400 VALIDATION_ERROR`; malformed,
  tampered, or mismatched cursors return `400 INVALID_CURSOR`; denied scopes return
  `403 FORBIDDEN`; invalid persisted reporting timezone returns generic
  `500 ANALYTICS_CONFIGURATION_ERROR` without the persisted value.

- No eligible facts may be a successful response with zero counts and explicit null reasons, not necessarily `404`.
- Insufficient history is not a server error.
- A computation failure is not converted to a numeric zero.
- `OWNER`/`ADMIN` Organization scope includes all Organization Branch history;
  branch-only roles include only currently assigned active Branches. Organization
  responses identify only included authorized Branch scope.
- Net Sales may be negative. Margin is null when Net Sales is non-positive or required
  cost is incomplete.
- `INVENTORY_STAFF` receives only inventory-relevant non-cost analytics. `CASHIER` has
  no analytics endpoint access. Frontend role checks are not the security boundary.

## 13. Persisted AI insight endpoints

| Method/path | Auth | Request | Response | Key validation/errors | Status |
| --- | --- | --- | --- | --- | --- |
| `GET /organizations/{organizationId}/ai-insights` | Authenticated, three permissions below | `scope`, `cadence`, optional `branchId`, `limit`, `cursor` | `{data: Insight[], meta: {nextCursor}}` | `400` invalid selector/cursor, `403` forbidden | Implemented P7-M3-T02 |
| `GET /organizations/{organizationId}/ai-insights/latest` | Authenticated, three permissions below | `scope`, `cadence`, optional `branchId` | `{data: {latest, lastSuccess, stale}}` | Explicit nulls when no report exists; `403` forbidden | Implemented P7-M3-T02 |
| `GET /organizations/{organizationId}/ai-insights/{insightId}` | Authenticated, three permissions below | UUID path ID; no query | `{data: Insight}` | `404` missing or inaccessible; provenance mismatch fails closed | Implemented P7-M3-T02 |

All paths above are under `/api/v1`. `scope` is exactly `organization` or `branch`; Branch scope requires a UUID `branchId`, while Organization scope rejects it. `cadence` is exactly `DAILY`, `WEEKLY`, `MONTHLY`, or `YEARLY`. List `limit` is 1–100 (default 20); `cursor` is the UUID `nextCursor` from the preceding page. Unknown parameters are rejected. List order is descending `(periodEndExclusive, periodStartInclusive, id)`, separately for each scope and cadence. A cursor from another scope or cadence is invalid. A detail ID is scoped to the authenticated Organization before lookup.

Every read requires `AI_BUSINESS_SUMMARY_VIEW` **and** `BUSINESS_ANALYTICS_VIEW` **and** `SALES_COST_VIEW` under the existing permission policy. `OWNER` and `ADMIN` may read Organization and Branch reports, including retained reports for an inactive Branch in their Organization. `BRANCH_MANAGER` may read only a currently active, assigned Branch. `INVENTORY_STAFF` and `CASHIER` have no insight read access. Inaccessible detail IDs return the same `404` as missing IDs.

`Insight` contains `id` (for detail navigation), `scope`, optional `branchId`, `cadence`, `reportingTimezone`, UTC `periodStartInclusive`/`periodEndExclusive`, `schemaVersion`, `metricDefinitionVersion`, `sourceCutoff`, `promptVersion`, `state`, `attemptCount`, `provider`, `actualModel`, `content`, `failureCategory`, `generatedAt`, and `completedAt`. Nullable fields remain null when absent. Content is present only for `SUCCEEDED` and remains plain text inside JSON. Failure exposes only a safe category; internal provider authentication failures appear as `PROVIDER_ERROR` with attempt/provider/model metadata hidden. `INSUFFICIENT` and `IN_PROGRESS` have no content. Claim tokens, raw prompts/errors, snapshot and attempt IDs, and provider response bodies are never returned.

`latest` compares persisted reports only within the selected scope and cadence using the same business-period order. `latest` is the newest persisted state; `lastSuccess` is the newest successful report, which remains available when a newer period failed or was insufficient. `stale` is true when a persisted newest state exists but is not that last success; it is false when no reports exist. It does not claim an external freshness deadline or invent an expected period. The two reads share a repeatable-read database snapshot, so concurrent completion cannot combine incompatible states. List and detail also read persisted rows only. GET does not create snapshots, claim jobs, contact OpenRouter, or update report state.

There is deliberately **no end-user `POST .../generate` endpoint**. Reports are daily/weekly/monthly/yearly scheduled work. Any operational replay mechanism is internal/admin-only, auditable, and subject to `ADR-033` bounds.

AI read responses:

- Never call OpenRouter.
- Link to the authoritative analytics snapshot/period.
- Indicate `success`, `stale`, `failed`, `insufficient`, or equivalent accepted status.
- Treat content as untrusted display text: escape it and never render provider-supplied active HTML.
- Do not expose raw prompts, secrets, provider errors, or prohibited data.

## 14. S3/object endpoints

S3 is an accepted cloud service, but no asset upload product requirement is sufficiently defined. Do not add generic upload or presigned-URL endpoints until asset type, authorization, MIME/size limits, malware/content handling, naming, ownership, lifecycle, and retention are accepted under `OQ-015`/`OQ-020` or a new product decision.

## 15. Rate limiting and abuse controls

At minimum, define/test rate limits for:

- Registration/login/password flows
- Search endpoints vulnerable to expensive queries
- Write/idempotency endpoints
- Internal AI replays and provider-budget paths

Except for the narrow accepted MVP application limiters below, exact thresholds are configuration/production decisions under `OQ-020`. Rate-limit keys must not permit easy cross-tenant denial of service and must respect proxy/ingress trust configuration.

P2-M2-T01 and P2-M2-T02 have accepted MVP exceptions to that deferral. Registration permits
five attempts per 15 minutes per canonical email through a deterministic
process-local in-memory limiter, evaluated before any hashing or lookup. It
stores no database limiter state and logs neither email nor password. An
exhausted limit returns `429 RATE_LIMITED` with `Retry-After`.
Distributed/IP-aware limiting, cross-process coordination, and
proxy/deployment trust remain open under `OQ-020`; this baseline does not close
those questions.

Login separately permits five failed credential attempts per fixed 15-minute
window per canonical email through a SHA-256-derived process-local key. Only
credential failures count and success does not reset the active window.
Exhaustion returns `429 RATE_LIMITED` with `Retry-After`. The
`POST /auth/verification-password-proof` fallback (implemented T02A `ADR-034`) shares
this same limiter object. This does not close the remaining
distributed/IP-aware/global or proxy-trust decisions in `OQ-020`.

The shared mail budget (implemented T02A `ADR-034`) allows three valid requests per
canonical email per 15 minutes across signup and verification resend, keyed by
a SHA-256 derivative. Every syntactically valid request consumes before lookup
regardless of eligibility or provider; attempt beyond the budget returns
`429 RATE_LIMITED` plus deterministic `Retry-After` on explicit resend, while
signup with the budget exhausted remains generic `202`. Success does not reset
the window. The implemented P2-M2-T03 baseline uses an independent
three-request fixed 15-minute window for verification resend; the reset
request keeps its own independent three-request window (unchanged). Reset
completion has no MVP limiter and rejects invalid token state before Argon2.
These exceptions do not resolve `OQ-020`.

## 16. API test contract

Every endpoint implemented must cover:

- Valid request/response
- Missing, malformed, unknown, oversized, and semantically invalid input
- Unauthenticated request
- Authenticated but wrong role
- Wrong organization and unauthorized branch
- Missing/inactive/deleted dependency
- Duplicate and concurrent request where applicable
- Stable status/error code and safe response body
- Database/provider timeout or failure where applicable
- Decimal/date/cursor serialization boundaries
- No secret/stack/SQL/other-tenant leakage

High-risk commands additionally require database-backed atomicity and idempotency tests.

## 17. Decision references by API area

Canonical definitions live in `BUILD_SPEC.md`:

- Auth/session: `ADR-013`; verification/reset token/provider behavior: `ADR-014`; unified verification challenge, verification password proof, and shared mail budget: `ADR-034`; onboarding: `ADR-015`; invitation/member access lifecycle: `ADR-021`
- Role/permission exposure: `ADR-016`
- Product payload: `ADR-022`; Product has no organization-wide cost/valuation field, Branch/Product cost state follows `ADR-026`, and Sales price/VAT/discount behavior follows `ADR-027`
- Inventory adjustment: `ADR-024`; quantity representation is `ADR-022`; generic
  audit logging remains `OQ-019`
- Purchasing/receiving: `ADR-026`; quantity representation is `ADR-022`, stock policy is `ADR-024`
- Checkout/receipt/payment: `ADR-027` plus `ADR-016`, `ADR-022`, `ADR-024`, and `ADR-026`; `OQ-008` is resolved
- Refund: `ADR-028` plus the applicable Sales/inventory/cost decisions; `OQ-009` is
  resolved and VOID is excluded from V1
- Analytics periods/base metrics: `ADR-029` (`OQ-011`, `OQ-016` resolved);
  fixed coverage stock classification: `ADR-030`; internal Forecasting V1:
  `ADR-031` (`OQ-012` resolved); Reorder V1: `ADR-032`; stockout risk needs a separate decision
- AI scheduling/provider: `ADR-033` (`OQ-017`, `OQ-018` resolved)
- Hosting, S3, operational exposure: `OQ-015`, `OQ-020`
- Catalog normalization and lifecycle: `ADR-022`; supplier implementation remains sequenced for P4
