PREPARED Migration historical source review status PREPARED Migration owner scope notice # Better Auth migration

## Authority and status

[ADR-035](../architecture/DECISIONS.md#adr-035--adopt-self-hosted-better-auth-native-sessions-with-stockwise-owned-identity-and-authorization)
records the owner's 2026-10-12 acceptance of self-hosted Better Auth **native
sessions** on the existing Express API with Prisma 7/PostgreSQL. D0 is the
accepted decision. D1's isolated database gate PASS (29/29 operator PostgreSQL proof) and D2's
guarded scaffold VERIFIED IN SCOPE are recorded on 2026-10-12; the original
Codex D1/D2 review ended without a final independent verdict and must not be
treated as ACCEPT. D3's isolated implementation and independent security
review under
ADR-036 are ACCEPTED on 2026-10-12, with uncommitted, non-live code.
D4-N1 native login/logout and D4-N2 native reset have isolated acceptance;
D4-N2 independent review ACCEPTED on 2026-10-13 with operator-reported 41/41
isolated PostgreSQL and 394/394 database-free checks. D4-N3 isolated
Next.js/Express/PostgreSQL real browser integration independently ACCEPTED on
2026-10-15 after F1/F2 remediation; operator checks 25/25 focused, Journey08
1/1 and full browser 10/10, with independent read-only Codex source/artifact
review ACCEPT. **Aggregate D0-D4 integration / D4 exit gate was
independently ACCEPTED on 2026-10-15** after F1 native sliding-session
activity, F2 EN/TH recovery, native two-tab/reset/cache/accessibility
browser gaps and F3 canonical documentation reconciliation were closed.
Operator evidence: F1 60/60 database-free, 85/85 PostgreSQL, four HTTP
checks; F2 139/139 frontend, 6/6 Chromium; gap browser 10/10 PASS
with intentionally failing stale-cache negative control. The latest
browser source manifest independently matched 35/35 scoped files.
The Codex reviewer inspected source/evidence but did not rerun tests.
Original D1/D2 independent review remains incomplete and is not
retroactively ACCEPTED. D5-P1-A's historical NEEDS FIX review is preserved.
The owner reports F1–F6 independently CLOSED at source level for the historical
hardened Linux lane. Its separately administered host, trusted bootstrap and
exclusive resource-management deployment prerequisites remain OPEN for that lane.
The independently accepted local Windows/Docker architecture below is a separate
owner-approved accidental-error model, not a relaxation of those Linux contracts.
R2 source is independently ACCEPTED through the owner-transferred final review;
that provenance is not a signed approval artifact or runtime permission.
D5-P1's updated automatic local runner/source/execution evidence received a
**bounded independent review ACCEPT on 2026-10-24**. This is not acceptance of
all D5 migration/cutover gates or the historical B3-M3 package as changed source.
The active local section below supersedes historical routine-test authorization
requirements; it does not claim production readiness.
**D5-P2 scoped source/application integration independently ACCEPTED on
2026-10-24**, including F1/F2/F3 closure; no runtime tests independently rerun.
The accepted aggregate is
`f1ffaa3640d9dcd21856eb4dcddec9909806f2cd124caba8b4443c7c0024f24c`.
The actual `main.ts` selects the existing Legacy
runtime while `BETTER_AUTH_NATIVE_ENABLED=false`; the Native composition is
not constructed or mounted in normal application startup. The separately
exercised candidate now composes pending registration/verification, pending
login proof, Native login/logout/logout-all, the session bridge and Native reset.
It has no Legacy writer or fallback. D5-P3's owner-approved DEC-01/02/03
transition implementation is independently ACCEPTED within the reviewed
source/disposable boundary, including F1 closure. D5-P4 scoped Cutover Readiness
is independently **ACCEPTED**, recorded 2026-10-25 from the owner-transferred
final verdict; no confirmed blocking security or correctness findings.
D5-P5 and AWS Phase 8 remain **NOT STARTED**. Production recovery, external email,
production HTTPS and Live readiness remain separate unaccepted gates.
No live auth cutover is authorized.
This is a canonical migration design, not an execution/evidence record.
Task evidence and acceptance records belong in the external StockWise project
records under `AGENTS.md`.

D0 authorized the ADR and this design only. The subsequent bounded D1
authorization permits API dependency pins, additive schema/SQL, and DB-free
checks, not live database changes, external email, or deployment.
Existing uncommitted T02A/B work must be preserved.

Source of Truth: `AGENTS.md`, `PROJECT_PLAN.md`, `BUILD_SPEC.md`,
`docs/architecture/{ARCHITECTURE,DATABASE,DECISIONS}.md`, and
`docs/contracts/API.md`. Their existing hash-only session clauses describe the
current runtime until cutover. ADR-035 supersedes only the future session
implementation; other differences require explicit decisions. Historical
verification-status wording differs among these documents; this plan does not
resolve or upgrade those statuses and claims no root migration verification.

## Settled boundaries

- Keep the Express modular monolith, existing PostgreSQL, and API-owned Prisma 7.
  Better Auth is not a hosted identity service or a new backend.
- Preserve StockWise `User.id` UUIDs and every business/user foreign key.
  Test-only authentication credentials may be replaced; disposable accounts do
  not authorize deleting users, memberships, onboarding provenance, invitations,
  historical actors, organizations, branches, or any domain data.
- StockWise remains authoritative for ACTIVE/DISABLED users, verified identity,
  registration completion, Organization/Branch scope, membership, assignments,
  deny-by-default RBAC, and last-owner protection. Better Auth identity alone is
  insufficient for `TrustedAuthenticationContext` or business authorization.
- Accept native opaque session tokens persisted in the database after cutover.
  Keep cookie cache OFF initially, HttpOnly/host-only/Path=/, SameSite Lax,
  Secure HTTPS in production, Origin/CSRF protection, secret outside the DB,
  no credential logging, and explicit current/all-session/reset revocation.
  These controls require real verification. Database/backup token disclosure
  remains a greater risk than hash-only storage; the server secret does not
  remove that risk.
- No JWT/refresh tokens, localStorage/sessionStorage credentials, automatic
  registration login, or dual live authentication authority.
- Retain the existing `IdentityEmailProvider` boundary and `ADR-014` configuration:
  production Resend, development non-delivery unless separately opted in, test
  non-delivery/recording and rejection of Resend. No real external send here.
- Preserve exact password validation and accepted Argon2id policy, generic
  duplicate responses, anti-pre-hijacking, OTP protection, rate limiting,
  reset/invitation guarantees, and scanner-safe verification. Better Auth
  defaults are not implicit approval to change any of these.

## D5-P2 exclusive application composition

`main.ts` uses lazy factories to construct one authentication runtime. The
inactive runtime performs no factory initialization, and a refused Native
construction propagates rather than retrying Legacy. Existing business routers
receive only the selected authentication middleware; StockWise remains the
authorization boundary. The Native session reader and application session
service share one configured Native instance. Login's one-use internal writer
and transaction adapter remain implementation capabilities, not additional
public authentication authorities.

The isolated browser harness now uses `createBetterAuthApplicationRuntime`,
not a separate copy of its authentication composition. Its mailbox remains
in-memory, its PostgreSQL target receipt-bound and disposable, and its normal
application Live flag remains OFF. Historical D5-P1/B3-M3 acceptance identities
do not cover these changed source bytes.

### Native HTTP compatibility

All routes remain under `/api/v1`; the existing frontend client is unchanged.

| Routes | Candidate behavior |
| --- | --- |
| `POST /auth/register` | Existing generic `202` continuation; standalone pending hash and proof, no User/application session before both proofs |
| `POST /auth/login` | Verified Native enrollment returns safe actor and Native cookie; pending registration returns `202 verification_required`, proof and nullable challenge selector, with no session or automatic mail |
| `POST /auth/verification-password-proof` | Verification-only proof; shares the process-local login failure budget while retaining durable pending admission |
| `POST /auth/verify-email-code`, `POST /auth/verify-email` | Existing OTP/link two-proof completion, expiry/replay/error precedence; explicit sign-in afterward |
| `POST /auth/verification-resend` | Rotate mailbox challenge without changing password version, proof or pending expiry |
| `POST /auth/logout` | Idempotent current Native revocation; clear Native and verification-proof cookies only on success |
| `POST /auth/logout-all` | Require current Native application authority; lock User then session, apply the Bridge validity predicate and atomically delete that user's Native sessions; clear Native/proof cookies on success |
| `POST /auth/forgot-password`, `POST /auth/reset-password` | Existing generic recovery and Native-only credential/version/session-reset transaction |

Generic Better Auth public handlers remain denied. Existing Legacy users are
not adopted or rewritten by Native pending login, registration or resend.
Logout-all checks current purpose/version, enrollment, password timestamp,
verified/enabled state, credential presence, token and idle/absolute expiry
before revoking; it does not authorize from an unvalidated Native selector.

Password proof distinguishes retained pending credentials from mailbox delivery
material. Delivery suppression or compensation revokes OTP/link use, not the
unconsumed pending password; login may issue verification-only continuation with
a null selector and never sends mail. Explicit resend preserves the pending
password, version and absolute expiry.

Correct eligible verified Native credentials receive the same `202 accepted`
fallback response with an unusable phantom proof, never an application session.
The repository rechecks User/account state, credential version/hash, password
change and enrollment timestamps under row locks after Argon2. Correct credentials
rejected by mutable eligibility checks remain generic and do not add shared
credential failures. Unknown/wrong credentials still count. A changed/mismatched
pending snapshot or expired lease retains its durable reservation charge, as in
the existing pending-registration quota contract.

Both public credential endpoints use the same limiter-owned per-email queue
around admission and failure accounting. Login invokes the unwrapped pending
proof implementation inside that queue, avoiding nested acquisition. Success
does not reset the five-failure window; durable pending reservations remain in
force. Different emails do not share a queue.

### Native secret configuration

`STOCKWISE_BETTER_AUTH_SECRET` is an API-owned, server-only optional input to
`loadApiEnvironment`. It is required only when constructing the Native runtime:
canonical unpadded base64url encoding of at least 32 cryptographically random
bytes, distinct from analytics, OTP, current/previous proof and provider keys.
Missing, malformed or reused material refuses construction with a fixed error
that contains no supplied value. Legacy startup does not require or validate
unused Native material. Native production construction also requires an HTTPS
public web origin; test-only HTTP retains the accepted local cookie policy.

Provision this persistent value outside the database and repository through
the eventual server secret-injection mechanism; keep it stable across restarts
and replicas. The application never generates a replacement or falls back to a
default key. Secret storage/deployment is still Phase 8 work, not implemented
here. Rotation requires a separately reviewed coordinated session-invalidation
and recovery procedure; this candidate does not add old-key fallback or claim
rotation or production recovery proof. D5-P4 verifies restart with the same
synthetic persistent Native secret only in its disposable rehearsal.

### Remaining cutover dependencies

Before any separately authorized Live switch: apply/reconcile the reviewed
additive schema and owner-approved D5-P3 enrollment/account disposition under
verified writer quiescence; preserve all UUID/business FKs; verify production
backup/forward recovery, restart/outage/retry and compatible rollback boundaries;
provision the dedicated Native key; close dependency-security and independent
review gates. Never re-enable Legacy password/session authority over accounts
whose Native credentials have changed. D5-QUALITY-01 and the bounded local
D5-UX-01 authentication/onboarding gate are complete; the original UX browser
suite passes after link-action locator maintenance. D5-P4 scoped source/disposable
readiness is independently ACCEPTED; D5-P5 and AWS Phase 8 remain NOT STARTED.
Real external email and production HTTPS remain unverified.

## D5-P3 — Pre-cutover Legacy-to-Native transition

### Authority and non-public execution boundary

The owner approved DEC-01/02/03 on 2026-10-24 for source implementation and the
existing authorized disposable runner only. The earlier assessment-only
candidate/evidence remains historical; its PASS never meant a writer was complete.
The writer and durable fence have real disposable PostgreSQL verification and
scoped independent acceptance; neither grants production cutover or Live activation.

Independent review returned NEEDS FIX for candidate
`e1ea8b0c5df534f2ee4e8b1ccfb57e9b4a579589e3c34eb14b0a7793dc31ceba`:
D5-P3-F1 found equivalent dummy PHCs bypassed exact-string exclusion. That
candidate's evidence remains historical, not acceptance. The bounded remediation
and fresh verification are recorded externally in
`2026-10-24-STOCKWISE-D5-P3-F1-REMEDIATION-HANDOFF.md`.
The owner supplied the final independent ACCEPT on 2026-10-24: F1 CLOSED,
DEC-01/02 SATISFIED and DEC-03 SATISFIED within the reviewed boundary, with no new
confirmed blocking findings. Accepted 76-file aggregate:
`8aa2735c199e8e4163a31c38a90137dd18db1d462d6630ff120f8d81915ce237`.
The reviewer verified all source identities, the five-file F1 delta, all 23
migration checksums, historical evidence preservation and retained test/cleanup
results; runtime suites were not independently rerun. External closure:
`2026-10-24-STOCKWISE-D5-P3-ACCEPTANCE-CLOSURE.md`.
Original candidate/evidence bytes remain sealed; subsequent documentation and
quality changes have separate identities and do not inherit this acceptance.

`tests/e2e/better-auth-d5/native-transition.mts` exposes the non-public
`createDisposableNativeTransition` factory. It is not an HTTP route, startup
callsite, environment toggle or production CLI. Construction and every transaction
require the existing runner's exact URL/receipt and live database comment marker;
only that receipt-bound `stockwise_test_test` database is accepted. There is no
production override. Normal application selection remains Legacy with
`BETTER_AUTH_NATIVE_ENABLED=false`.

### DEC-01 — Validated direct credential transfer

Only canonical PHC encoding with Argon2id/v19, memory 65536 KiB, time 3,
parallelism 4, a 16-byte salt and 32-byte digest is transferable. Both accepted
parameter orders are parsed into one comparison identity covering algorithm,
version, parameters, canonical salt and digest; both public dummy identities
are refused regardless of order. Absent/malformed/unsupported encodings and
noncanonical base64 remain refused. Normalization is comparison-only: the original
PHC bytes are copied exactly into the canonical Native credential account, never
rehashed as a password, returned or logged. The Native verifier is unchanged.

Eligibility requires ACTIVE/not disabled, both verification fields correctly
verified, positive credential version, valid nonfuture timestamps, nonblank
display name and existing membership or first-onboarding provenance. The writer
does not create onboarding, memberships, assignments or roles. Membership presence
does not activate it or grant scope; fresh StockWise RBAC remains authoritative.

Preflight is repeatable-read discovery. Transfer checks expected generation and
password-change/update timestamps, locks User then relevant credential accounts,
and rereads source/destination state. One transaction inserts the missing canonical
credential account, append-only generation-bound provenance, and the enrollment
marker for the same UUID. It never creates a session, changes the Legacy hash or
advances the password generation without password replacement.

Any existing account, foreign/colliding selector or pre-existing Native marker is
preserved, never adopted, reassigned or overwritten. Provenance binds run, source
generation/change timestamp, internal source digest, canonical destination and
enrollment time. Exact unchanged replay returns REPLAY without writes. Any changed
source/destination, including Native reset, refuses replay. Sealed authority
accepts no new Legacy imports.

### DEC-02 — Verification and account disposition

| Source state | Transition treatment |
| --- | --- |
| Eligible verified Legacy identity, no destination | Explicit validated transfer under QUIESCED authority |
| Unverified, incomplete or disabled | Preserve UUID/business references and restrictions; do not enroll, verify or activate |
| Unsupported/missing credential | Refuse import; require separately authenticated recovery/re-enrollment, never fabricate credentials |
| Verification fields disagree | Refuse transfer until explicit frozen-source reconciliation |
| Existing/misowned/partial Native destination | Conflict/preserve; no upsert or repair |

Legacy `email_verified_at` is authoritative until freeze; D1's boolean was only a
snapshot. `reconcileVerification` requires explicit `LEGACY_EMAIL_VERIFIED_AT`,
QUIESCED matching run, locked expected generation/timestamps and no Native
destination. It derives only the boolean from that frozen timestamp; it cannot
create verification evidence or enroll a user. Stale reconciliation needs fresh
preflight. Excluded users require accepted verification/onboarding or an explicitly
authenticated recovery continuation before later authorized enrollment. Migration
is not registration and adds no public recovery/adoption endpoint.

### DEC-03 — Durable exclusion, retry and forward recovery

The additive `20261024000000_native_authentication_transition` migration follows
all 22 historical migrations without editing them. It adds:

- `NativeAuthTransition`: singleton `LEGACY -> QUIESCED -> NATIVE`, immutable
  run/baseline metadata and monotonic transition timestamps.
- `NativeAuthEnrollment`: append-only per-User generation/source/destination
  provenance with restrictive User and Native-account FKs.
- Authentication-table triggers coordinating with the singleton; stale Legacy
  credential/session/reset/verification authority is denied after freezing.
- `NATIVE_CUTOVER` for accurate nonlegacy challenge disposition.

Quiescence takes bounded ACCESS EXCLUSIVE locks on public tables in stable order,
draining database work and establishing a full business-row baseline. It atomically
changes durable state, revokes Legacy sessions and outstanding reset/challenge
authority, invalidates pre-fence pending material, and removes provisional Native
sessions/verifications. New authority cannot be minted while QUIESCED. The
transaction-local run marker permits only bounded migration mutations, never
Legacy password replacement.

Reconciliation compares complete business-table contents and immutable identity
fields, not only counts. It refuses sealing while eligible imports remain or
Legacy authority survives. NATIVE here is database authority in the disposable
rehearsal, not an application Live flag. It permanently rejects Legacy credential
changes, sessions and reset authority, while preserving accepted Native provisional
session finalization, reset delivery/version/revocation and two-proof registration.
Pre-fence pending proofs need a fresh generation; ordinary post-fence delivery
compensation/resend retains its accepted password/version/expiry behavior.

Interruption rolls back account/provenance/marker together. A fresh process can
retry current state; Native credential advances cannot be overwritten by Legacy
replay. No rollback/unseal, hash refresh or Native-to-Legacy fallback exists.
Ordinary test resets preserve a LEGACY singleton and refuse a transitioned target
instead of reconstructing Legacy authority.

### Backup, deployment and verification limits

Before separately authorized production execution, stop ingress/background writers
and drain already-admitted requests as well as database transactions. Encrypt
durable backups with externally managed keys, restore-test only an isolated
authorized target, and reconcile schema/migration identities, every UUID/business
FK, memberships/assignments/RBAC, latest acknowledged credential generations,
revocations and authority epoch. Keep credentials/personal data out of evidence.

The GUC is an internal run marker, not a permission credential. Production
application roles must not own schema, disable triggers, truncate the fence or
restore backups. An administrator restoring an old database can restore its old
fence too: external maintenance exclusion and independently retained latest
authority/checkpoint/WAL evidence are mandatory. Database locks alone do not drain
a request admitted outside a transaction. Missing latest Native authority means
remain offline and forward-recover, never reactivate stale Legacy authority.

Zero lost acknowledged authentication-state changes is the security objective,
not a verified production RPO=0 claim. No production RTO is selected: later
acceptance must measure detection, drain, backup verification, restore/replay,
identity/credential reconciliation and controlled resumption with representative
data/topology/failures, then obtain owner approval.

Disposable verification covers actual PHC/Native-verifier compatibility, populated
sale/refund/receipt/ledger FK preservation, negative states/destinations, database
contention, rollback injection, killed-process/backend retry, real HTTP auth and
post-Native-reset stale replay refusal. It is not physical backup restore,
production failover, real email, HTTPS or Live proof. Exact evidence and identities
remain external StockWise task records. D5-QUALITY-01 and D5-UX-01 are complete.
D5-P4's bounded source/disposable verification is below; D5-P5 and Phase 8
remain NOT STARTED.

## D5-P4 — Cutover preflight and controlled recovery readiness

Independently **ACCEPTED — D5-P4 scoped Cutover Readiness implementation**,
recorded 2026-10-25 from the owner-transferred final review. No confirmed blocking
security or correctness findings. This is not Live activation or production
readiness. Normal application authority remains Legacy;
`BETTER_AUTH_NATIVE_ENABLED=false`. No schema, dependency, public API or product
behavior changes are introduced.

Acceptance is bound to candidate SHA-256
`715750ada3ce0cf1b3018b9c53c06edeb4d43b09b0cedf3b60d42546a5d113da`
and expanded review SHA-256
`fca2d77b232627b418861dd1f89a5cb32a275aa57558d110dc1cb2a9bf360661`,
not a documentation-modified aggregate. The reviewer verified 14/14 candidate
and archived files, 84/84 expanded source files, 23/23 migration checksums and
143/143 historical artifacts, and freshly ran `git diff --check`. Retained runtime
evidence was inspected, not independently rerun: disposable PostgreSQL/HTTP/restart
rehearsal 1 PASS, focused Native regressions 68 PASS, PHC/local-runner regressions
11 PASS. Preflight/fail-closed startup, shared PHC compatibility, recovery/restart,
credential/session and RBAC evidence are accepted within the scoped boundary.
The separate external record is
`2026-10-25-STOCKWISE-D5-P4-ACCEPTANCE-CLOSURE.md`; original evidence is unchanged.
D5-P5 and AWS Phase 8 remain **NOT STARTED**; all production-only gates below
remain pending, with no production migration or Native Live approval.

### Source-level startup preflight

`assertNativeCutoverReady` is a reusable read-only check. `main.ts` calls it
before selecting Native and before opening a listener, only if the compile-time
Native flag is enabled by a later separately authorized task. It never invokes
the transition writer, activates Native, repairs records or falls back to Legacy.
The unmounted runtime factory remains usable by isolated historical harnesses;
it is not itself permission to bypass the production startup gate.

The check compares the exact shipped SQL migration inventory/checksums with
finished, non-rolled-back Prisma ledger entries, then uses one read-only
repeatable-read transaction to require:

- A sealed NATIVE singleton with coherent run/timestamp/baseline metadata and all
  eleven expected fence triggers enabled.
- No surviving unrevoked Legacy session, reset or verification authority.
- Canonical Native credential accounts, original UUID/enrollment bindings and
  coherent credential generations. The transition and preflight share the
  existing canonical Argon2id/dummy-exclusion validator.
- No ambiguous verification/time/generation state or complete ACTIVE/verified
  Legacy identity left without Native credentials. Missing/unsupported credentials
  for such an identity require explicit recovery/disposition before readiness;
  preflight cannot invent enrollment. Consistently disabled, unverified and
  incomplete excluded identities remain restricted and preserved.
- No unexpired application session claiming a future credential generation.
  Older-generation, disabled-user, expired and provisional session rows remain
  harmless under the existing Bridge predicate and do not prevent restart.

Post-reset generation advancement and later Native registration are valid.
Business rows may change after activation: startup validates frozen baseline
metadata, not equality with an obsolete business snapshot. The existing writer's
seal reconciliation remains the pre-cutover UUID/business-content proof.
Missing schema/files, checksum drift, dependency errors or inconsistent state
refuse with a fixed non-sensitive error. Shipped migrations must accompany both
source and compiled API deployments. Existing dedicated-secret/key-separation,
production HTTPS and Secure-cookie validation remains in the Native composition.

### Authorized disposable rehearsal

The existing automatic local runner accepts `mode: "cutover"` for the dedicated
`vitest.d5-p4-integration-db.config.mts` suite. It migrates only its fresh,
receipt/marker-bound PostgreSQL target; it neither resets a transitioned target
nor reruns the historical D5-P3 suite. The child HTTP worker independently checks
the receipt/live marker and preflight before opening its listener.

The rehearsal exercises real Legacy login followed by explicit ingress stop,
read-only cancellation, transition transaction failure/forward retry/replay,
reconciliation/seal, stale Legacy authority refusal, Native HTTP session/reset/
logout behavior, process loss/restart under the same synthetic Native secret,
invalid/missing-secret startup refusal, and real StockWise organization/branch/
role enforcement. It preserves UUIDs, memberships, assignments, Native credentials
and current generations. Checksum/account corruption probes are confined to the
disposable target and restored without disabling the fence. Migration SQL failure
and populated historical business-FK proofs remain accepted D5-P3 evidence, not
newly claimed runs. Exact results and failed development attempts are external.

### Production-only operational gates — not run by D5-P4

Before separately authorized migration/activation, retain all of the following:
encrypted backup and isolated physical restore verification; least-privilege
database roles unable to own/disable/truncate the fence; ingress/background-worker
and admitted-request drain; durable deployment/maintenance exclusion; persistent
secret provisioning and replica consistency; actual HTTPS/domain/Secure-cookie
and production email delivery; independently retained latest acknowledged
authority/generation/revocation checkpoint and restore/WAL reconciliation;
measured recovery timing and owner-approved RPO/RTO; dependency-security
disposition; independent review and explicit production migration/activation
approval. These are **NOT_RUN** operational gates, not an incomplete local
implementation or implied AWS infrastructure. An old backup can contain an old
fence: uncertain latest Native authority means remain offline and forward-recover,
never downgrade to Legacy or overwrite newer Native credentials.

## Registration: accepted isolated D3 design, not cutover proof

M0 proof A remains forbidden: native password signup before OTP lets victim
mailbox verification activate an attacker-chosen password. M0B is historical
operator evidence (31 PASS / 2 FAIL), not a test run against the actual
StockWise root. It reported the native-session persistence policy conflict and
native OTP sign-in session creation. ADR-035 resolves only the former policy
conflict. ADR-036 explicitly supersedes M0B's registration order and internal
session/setPassword composition for D3 only. Historical D1/D2 evidence,
including reported D1 29/29 and database-free 376-check results, remains
historical operator evidence; none is D3 implementation or verification.

The accepted D3 flow is:

1. A separately exported, unmounted registration router accepts the existing
   email/password request shapes and enforces canonical email, existing input
   validation, Origin protection, generic duplicate behavior, and durable
   quotas. Hash the password immediately with the accepted Argon2id policy and
   persist only its PHC hash in standalone pending-registration storage. Do not
   create a `User`, write `User.passwordHash`, create a Better Auth account, or
   retain raw password while awaiting mailbox proof.
2. A `PendingRegistration` row is unique by canonical email and has a UUID
   subject, credential version initially `1`, and absolute ten-minute expiry.
   A fresh registration creates a fresh version-bound challenge; a new
   registration attempt for that pending email advances the credential version.
   The OTP/link material binds to the same pending subject/version. Existing
   `User` records, including unverified users, are never changed or adopted.
3. Require both mailbox proof and proof of the exact pending password
   generation. Same-browser completion uses the encrypted short-lived proof
   cookie; cross-device completion requires explicit password proof. Proof is
   version-bound and cannot be obtained, refreshed, or upgraded by resend.
4. Preserve ADR-034 mailbox-first error precedence and OTP/link security:
   dedicated HMAC-protected OTP, hash-only secure link, absolute ten-minute
   expiry, five wrong OTP comparisons then `LINK_ONLY`, single-use OTP/link,
   and the narrow consumed-link informational replay only before its original
   expiry. Invalid mailbox material is generic regardless of password proof;
   valid mailbox material with absent/invalid/stale proof yields the
   proof-required result. OTP replay remains invalid.
5. Resend rotates only the challenge. It preserves pending hash, credential
   version, and the original absolute ten-minute pending-registration expiry;
   it never installs/replaces a password or issues/renews proof.
6. Once both proofs are valid, one database transaction creates the StockWise
   `User` with the pending UUID and directly promotes the existing PHC hash to
   `BetterAuthAccount.password`, while consuming the challenge. The Better Auth
   1.7.7 configured `password.verify` path must verify this PHC hash. Do not
   pass the hash to `setPassword`: that API hashes its raw `newPassword` input.
   Promotion creates no session and performs no auto-login; the user signs in
   explicitly afterward.

Durable `PendingRegistrationQuota` fixed-window budgets are five registration
attempts, three verification delivery requests, and five credential failures
per canonical email per 15-minute window. Credential snapshot checks neither
increment nor reset the failure counter; failed credential proof increments it.
Bounded cleanup removes expired pending rows and prunes only closed quota
windows. Delivery retains the existing provider boundary and non-disclosure
behavior. No real provider call is authorized.

The pending router is separately exported and not mounted. `BETTER_AUTH_NATIVE_ENABLED`
remains false. D3's isolated implementation and independent security review are
ACCEPTED; see the external acceptance record:
`D:\Documents\Notes\10 Projects\StockWise\Implementation Records\Phase 7\Post Phase 7\2026-10-12-BETTER-AUTH-D3-ISOLATED-FINAL-ACCEPTANCE.md`.
Recorded evidence: D3 DB-free 17/17; two isolated PostgreSQL runs each 30/30;
21 migrations preserving the synthetic UUID/reference snapshot and 80 existing
FK definitions; M1 regressions 376/376; direct D3 runtime smoke exit 0; typecheck,
lint, schema validation and scoped format PASS. Independent post-fix review
closed both previous MAJOR findings with no new BLOCKER/MAJOR/MINOR.
Code remains uncommitted; no native registration route or live authentication
authority is enabled. D4/D5, live cutover, production, real external email and
full process-kill/provider-outage fault-injection remain UNVERIFIED and separately
gated; browser host/cookie timing, full Next.js–Express E2E and cutover/recovery
rehearsals are not established by this acceptance.

### Bounded D4 frontend compatibility

The existing custom client consumes D3 registration, resend, password proof,
OTP and link request/response shapes without an adapter or route switch.
No native client, signup bypass, second authority, new endpoint or enabled
frontend cutover gate is introduced. Legacy same-origin calls remain unchanged.
The existing session-generation cancellation, query/mutation purge and fresh
server access-context reconciliation remain the session-cache boundary.

Verification restores only the validated nonsecret email/challenge continuation
on persisted `pageshow`; pagehide-aborted requests, OTPs, passwords and scrubbed
link credentials are not restored. Focus alone preserves the OTP draft.
The standalone resend page also invalidates and aborts pagehide-abandoned
requests; a persisted restore reloads only the saved email and allows an
explicit retry. Reset pages never restore discarded link credentials or
passwords: a persisted restore shows invalid-link feedback and offers
`/forgot-password` recovery. Missing or server-rejected reset links expose
the same recovery navigation. These frontend recovery rules do not change
server expiry, consumption, session authority, or any D5/Live gate.

Controlled web/Chromium verification is not native cookie transport or real
Next.js–Express–PostgreSQL evidence. Native sign-in/logout/reset response,
cookie, revocation and error contracts must be finalized on a separately
authorized server surface before client cutover; D5 remains required.

### Isolated D4 native password reset

The separately exported `createBetterAuthPasswordResetRouter` remains unmounted.
It requires exact same-origin JSON requests, applies no-store/no-referrer, and
retains generic forgot-password acceptance. Native request admission uses a
durable SHA-256-email-keyed PostgreSQL quota of three requests per 15 minutes,
charged before account lookup regardless of eligibility or provider outcome.
Legacy request limiting remains process-local and unchanged.
Its reset-only service uses the native repository to validate ACTIVE, verified,
completed native enrollment and a matching credential account before hashing.
Native tokens are issued pending delivery and remain unusable until provider
acknowledgement confirms the same still-current token under locks. Provider
timeout/failure cannot leave a usable pending link even if revocation fails.
Issuance and initial validation use the database clock for the exact 30-minute
lifetime; legacy token timestamps and validation remain unchanged.
Completion locks User, native credential Account, then reset token; rechecks
database-clock expiry and eligibility; updates only the native Argon2id PHC;
increments credential version; invalidates open verification challenges;
consumes the token; and deletes all native sessions in one transaction.
Legacy password hashes, legacy sessions, memberships and domain foreign keys
are preserved for the isolated, non-live verification scope. This is not
authorization to run both credential authorities after cutover.
`BETTER_AUTH_NATIVE_ENABLED=false`; public native routes remain disabled.
D4-N2 isolated independent read-only security review is **ACCEPTED** on
2026-10-13 with F1-F4 CLOSED (see external D4-N2 final acceptance record).
D4-N3 isolated Next.js/Express/PostgreSQL browser integration is independently
**ACCEPTED** on 2026-10-15 with F1/F2 CLOSED. Operator runs: 25/25 regression,
Journey08 1/1 and full browser 10/10 PASS. Codex read-only re-review inspected
final source, 22/22 scoped source hashes, ten per-spec execution receipts and
13 retained artifacts, without rerunning tests. See external
2026-10-15-BETTER-AUTH-D4-N3-ISOLATED-FINAL-ACCEPTANCE.md.
These individual D4-N2/N3 isolated acceptances did not by themselves
authorize aggregate D4 closure. A subsequent independent cross-milestone
review ACCEPTED aggregate D4 on 2026-10-15 after F1/F2, browser gaps
and F3 closure. This does NOT accept D5 recovery/cutover or authorize
native routes in Live. Evidence stays in external project records.



## Ordered milestones and exit gates

| Milestone | Bounded work | Exit gate |
| --- | --- | --- |
| D0 — Accepted ADR | Record native-session decision and this design only | ADR-035 accepted; no implementation or verification inferred |
| D1 — Additive isolated migration scaffold and tests | Select/pin compatible Better Auth version; review Prisma 7 adapter, stable UUID mapping, additive schema/SQL and recovery design in isolation, without live dev DB | Reviewed migration preserves all existing user/domain keys and constraints; isolated compatibility/constraint tests; no destructive SQL or applied-history edits |
| D2 — Express identity and middleware | Integrate native session lookup and StockWise trusted-context adapter; map stable user ID and fresh disabled/verified/completion/access checks | Session/cookie/Origin/expiry/rotation/revocation/error negatives and tenant/RBAC regressions pass; old authority disabled only at cutover, not during scaffold development |
| D3 — Isolated password-first pending registration | Implement ADR-036 behind a separately exported, unmounted router with standalone `PendingRegistration` and `PendingRegistrationQuota` storage; preserve ADR-034 OTP/link protections and provider boundary | Isolated implementation and independent security review ACCEPTED on 2026-10-12; external final acceptance record cited above covers focused pending lifecycle, proof/version binding, quotas, expiry/replay, atomic direct promotion, synthetic UUID/FK preservation and no sessions or mounted/live route. Code remains uncommitted; `BETTER_AUTH_NATIVE_ENABLED=false`. D4/D5, live cutover, production, real email and full process-kill/provider-outage fault-injection remain UNVERIFIED and separately gated; restart/outage/retry recovery and independent protected-API exclusion remain required before cutover |
| D4 - Custom frontend UX and session lifecycle (AGGREGATE ACCEPTED 2026-10-15; isolated/non-live) | Implement OTP/password continuation, explicit sign-in, expiry/disable/revocation, focus/refresh/back/multiple tabs | Independent D0-D4 final Codex ACCEPT after F1/F2/F3 and browser-gap closure. Real cookie transport, no credential leaks/auto-login, fresh cache/access-context isolation, localized accessible UX and blocked native-route bypasses supported by disposable browser/DB evidence. D5 and Live separately gated |
| D5 — Independent real E2E and cutover rehearsal | Use explicitly authorized guarded disposable test DB; independently exercise full API/web/DB flow and migration/recovery | Real E2E evidence, domain/UUID/FK preservation, restart/outage/retry proof, cutover and rollback rehearsal accepted; no production deployment implied |

D1–D5 remain migration milestones. D3's corresponding `PROJECT_PLAN.md` row
records ACCEPTED isolated implementation and independent security review only,
not live cutover. D4 aggregate independently ACCEPTED on 2026-10-15 in isolated scope;
D5-P1-A preparation does not satisfy D5-P1 acceptance or authorize P1-B/P2–P5;
Phase 8 is not started.
Each further execution requires bounded task authorization and evidence.
D1 SQL generation/review must not apply to the live development DB; DB execution
belongs only to an explicitly authorized isolated target. Never reset/drop/
truncate a runtime, shared, staging, or production database. For later isolated
DB tests use process-supplied guarded loopback `TEST_DATABASE_URL` with a `_test`
name, distinct from runtime DB; follow the harness's full safety checks, not
just its name. No DB execution is part of D0.

The D3 PostgreSQL integration suite warms eight connections before testing and
retains them until disconnect. An isolated Docker-exec relay can otherwise
exceed Prisma's default interactive-transaction acquisition deadline while
opening connections. Warm-up occurs outside transactions; the default
transaction acquisition/execution limits and parallel domain assertions remain
unchanged. This test-only setup does not change runtime pooling or D3 acceptance.

### D5-P1 local Windows/Docker architecture — 2026-10-17

Owner selected **local accidental-operator/agent-error prevention**, not resistance
to a malicious process sharing the Windows administrator account. The owner
supplied independent architecture ACCEPT, including closure of both MAJOR plan
findings, when authorizing bounded R2 source implementation. The external plan's
earlier pending-review header remains historical provenance.

This separate Windows CMD/Docker Desktop lane does not require Proxmox, a separately
administered Linux VM, hostile-host bootstrap or a daemon-wide exclusive broker.
Docker Desktop's Linux backend and the workstation administrator are trusted only
for this disposable local rehearsal. The stronger Linux lane below remains unchanged.

#### Active automatic local runner — owner decision 2026-10-22

Routine disposable testing uses the updated `local-*` runner under
`tests/e2e/better-auth-d5/`, not the historical protected
`windows-trusted-launch.cmd` / prelaunch / mailbox Supervisor deployment.
This is a new local execution implementation, **not** the accepted B3-M3
package. That immutable candidate and its acceptance remain unchanged.

The owner explicitly removed local protected/elevated approval publication,
separate-account requirements, separately published Acquire/Bootstrap/Cleanup
grants, mailbox heartbeats, per-stage review waits and the 60-second interactive
Supervisor session. One normal-user invocation owns acquisition, immediate
bootstrap, test execution and automatic outcome-independent cleanup. No publisher,
Administrator token or ChatGPT response is needed between stages.

The runner still constructs allowlisted child environments, excludes inherited
credentials and loaders, never loads checkout `.env` files, pins the Docker
endpoint/executable/image identity, forbids image pulls, and limits PostgreSQL
to 2 CPUs, 1 GiB RAM and 128 PIDs. It journals resource creation and failures.
Deletion requires exact run labels, immutable container/network identities,
volume birth and attachment validation; it never prunes. Cleanup failure,
timeout, missing test execution and failed tests cannot become PASS.

The host-native harness connects through an ephemeral `127.0.0.1`-only
published PostgreSQL port on a run-owned bridge network. This network is not
Docker `--internal`: the local engine suppresses the required published-port
mapping on internal networks. It is not an outbound-network sandbox. PostgreSQL
runs as its image's non-root `postgres` user with dropped capabilities;
test mail stays in memory and no provider credentials enter the test environment.

The explicitly named previous failed run may be reconciled only from its
original hash-chained journal/checkpoint and exact authorized resource identities.
Its historical timeout remains failed/incomplete even after successful cleanup.
No historical approval file or candidate ACL needs modification.

All older local grant/publication/readiness instructions below are historical
protocol documentation, not prerequisites or supported routine local entrypoints.
The stronger separately administered Linux lane, application authentication,
production/deployment controls, Native Live and cutover gates are unchanged.
Local Native tests exercise isolated composition only; they do not enable
`BETTER_AUTH_NATIVE_ENABLED` in the application or production environment.

From ordinary Windows CMD:

```cmd
tests\e2e\better-auth-d5\local-run.cmd "D:\path\local-test-config.json"
```

The public JSON configuration contains `mode`, absolute `dockerExecutable`,
absolute `evidenceDirectory`, and the exact locally verified digest-qualified
PostgreSQL `image` (not required for `cleanup-previous`). Modes are `smoke`,
`database`, `browser`, `all`, and the exact owner-authorized `cleanup-previous`.
No credentials belong in this configuration. No dependency/image installation
is implicit. The launcher starts installed Node with a fresh OS-only child
environment. Docker executable updates require updating its observed identity,
not an elevated approval publisher.

Native execution copies current sources outside the checkout without `.env`
files, uses existing installed dependencies, applies committed migrations only
inside the disposable cluster and invokes the existing Native database/browser
suites. Browser workers verify the local receipt against a live database marker.
`all` resets only that guarded disposable database between database and browser
checks. Browser Journey 08's human Alt+Tab proof is explicitly excluded from
unattended execution; its test remains unchanged and no focus PASS is inferred.
All requested registration/verification/login/session/authorization/logout/reset
flows remain selected. Sanitized browser results and lifecycle journals are
retained in the configured external evidence directory, including on failure.

#### Historical local execution clarification — superseded for routine tests

This clarification supersedes only the invented local CPU/RAM-capacity preflight,
mandatory owner headroom acceptance, and clean-separate-Windows-principal gate
where older planning or readiness text states them as prerequisites. It does not
supersede the fixed endpoint, exact reviewed package/executable pins, fresh
candidate/review bindings, journal/G3 protections, or any D4/P2–P5 gate.

No numerical host/backend capacity threshold or owner headroom acceptance is a
precondition for local execution. Preserve the PostgreSQL runtime limits of
2 CPUs, 1 GiB memory and 128 PIDs. Resource exhaustion, inability to allocate,
or other actual capacity failure is an honest run failure; it must not be
recast as a preflight PASS or hidden by relaxing those limits. Historical D3
observations remain provenance, not fresh runtime verification: owner-reported
WSL2 `/dev/sdd` ext4 Docker data filesystem has 1,055,762,868 KiB total,
969,200,912 KiB available (992,461,733,888 bytes), and 66,503,461 free inodes;
the owner-observed C: backing-volume availability was 371,475,188 KiB
(380,390,592,512 bytes). Earlier C: sample was 380,439,719,936 bytes.
The data VHDX metadata length was 63,458,770,944 bytes and the Docker UI
reported 31.34 GB usage / 1006.85 GB limit. These are distinct measurements,
not interchangeable free capacity; no exact VHDX maximum/allocation, quota
absence, total-inode count or mount options are established. Those missing
details are not standalone blockers for this bounded disposable test. Advanced
host quota/VHDX inspection, elevation and additional backend CPU/RAM polling
are not prerequisites. Known insufficient space, exhausted inodes, read-only
storage or an actual allocation/write failure still stops the run. Do not
change Docker Desktop settings or infer a reservation from historical samples.

The original invoking CMD/PowerShell may retain the parent's environment.
The native PowerShell launcher validates and constructs an allowlisted child
environment before any Node startup; it must not read or copy parent secret
values. This is an accidental-error control, not a sandbox: parent processes
and same-account/trusted-host actors remain outside the isolated child boundary.
The previously stated mandatory clean separate interactive principal and
pre-launch rejection of any parent credential key are superseded for this lane.
Do not modify account/global environment settings or expose parent secrets.

The native trust root reads only `PATH`, `SystemRoot`, `WINDIR`, `TEMP`, `TMP`,
`USERPROFILE`, and the six public `STOCKWISE_D5_{LAUNCH_APPROVAL,CLI_APPROVAL,SUPERVISOR_PLAN}_{PATH,SHA256}`
inputs. It never enumerates parent environment values. A fresh double-NUL-terminated
Unicode environment block is passed to x64 `CreateProcessW` before Node starts;
no `ProcessStartInfo.EnvironmentVariables` getter or compiler child is used,
since either could copy/inherit the unsanitized parent environment. In-memory
Reflection.Emit defines only the native process/wait/exit/handle calls. The
104-byte x64 STARTUPINFO layout is guarded by pointer size. CMD delayed
expansion is disabled; approval values never enter CMD command text.

The pinned verifier and Node are still hashed before dispatch. Prelaunch keeps
only the same runtime allowlist and six public controls for the zero-option,
zero-argument Supervisor; Docker receives only the runtime allowlist plus
newly generated disposable credentials where explicitly required. Prohibited
names in the actual isolated Node environment still fail closed, including
direct/pre-scrubbed programmatic attempts. Descendants inherit this isolated
environment, not the original CMD's. Source-only `windows-run.cmd` and direct
Node invocation are not new supported unsanitized operational entrypoints.

The owner starts the trusted CMD entry from `cmd.exe /d` with the existing
account and trusted Windows runtime paths. CMD and Windows PowerShell themselves
still inherit the original environment from Windows; parent memory, OS/runtime
startup behavior, inherited standard I/O/other inheritable handles and
same-account/admin access are not sandboxed. The launcher does not inspect
prohibited values or pass them into Node. This boundary does not defend against
a malicious parent, poisoned trusted runtime, or same-account process that
deliberately reintroduces secrets. No account/key deletion is required.

The accepted B3-M2 review is source/package scope only, not execution authority
or a fresh runtime verification. Every execution candidate needs fresh exact
package, source, executable, envelope, grant and review pins under the current
approved procedure; historical acceptance pins do not authorize changed bytes.

Historical protected-Supervisor contracts (not the automatic local runner):

- Read only explicitly allowlisted parent variables and construct the child
  before Node starts. Inspect the actual isolated environment's names and
  reject database/provider secrets, Docker/PostgreSQL overrides and loaders
  before input/dispatch. Never load regular `.env` files or use the development
  database as a default.
- Pin an explicitly approved local named-pipe endpoint on every Docker command;
  verify the daemon identity, UUID lease, ownership labels, immutable container and
  network IDs, volume birth, mounts and attachments before use or removal.
- The approved image reference may be `postgres:16.x-alpine@sha256:<64 hex>`
  or `postgres@sha256:<64 hex>`, never a mutable tag or bare image ID. Before any
  resource create, local image inspection must return the separately approved
  exact image ID, `linux/amd64`, and the matching `postgres@sha256:...` entry
  in `RepoDigests`. `Config.Env` must contain exactly one `PG_MAJOR=16` and
  one canonical `PG_VERSION=16.x`, with the corresponding official
  `postgres:16.x-alpine` in `RepoTags`; a requested tag must match that version.
  Inspect and `create --pull=never` use the same approved reference; container
  inspection still checks both that reference and the exact resolved image ID.
  A locally reported RepoDigest may equal the configuration/image ID; no
  registry-manifest identity or network provenance is inferred from that equality.
  This source-only compatibility change requires independent source/package
  re-review and fresh external pins; it grants no runtime or deployment approval.
- Serialize each lease with an exclusive lock and durable acquisition journal.
  Unknown/lost creation results and delayed visibility remain uncertain until
  positively reconciled; empty inventories alone never prove create quiescence.
- G3-C permits only fresh acquisition and non-destructive inspection/bootstrap.
  G3-D is a separate reviewed grant identifying exact resources, operations,
  operator and limits. Creation never implies stop, force or deletion permission.
  Volume deletion defaults to retention; specifically authorized deletion also
  needs positive birth/attachment checks, an exclusive operator window and explicit
  acceptance of Docker's residual non-atomic name-replacement race.
- Cleanup must reconcile pinned-daemon ID/name/token inventories after removal.
  Any unresolved resource or operation is **INCOMPLETE**, never an overall PASS.
- Bind exact dirty-source bytes, package/lock inputs, dynamic migration inventory
  and independently required tests before discovery; preserve child exits, signals,
  timeouts and missing-stage evidence. Parser/type checks are not runtime acceptance.

Resource acquisition (A), fresh PostgreSQL bootstrap/read-only metadata identity
checks (B), and StockWise schema/migration execution (C) are separate operations.
`createOwnedAuthDatabase` remains unchanged for its historical callers and is
**not** a resource-only API: it automatically calls `applyTestDatabaseMigrations`.
The Windows lane must not call it. R3-S may use only A/B; C requires future,
separately reviewed R3-T/P2 schema authorization. Resource-only mode cannot run
migration, reset, seed or destructive SQL.

R2 is source-only. No Docker, PostgreSQL, application, transport, migration or
cleanup execution is authorized by its implementation or database-free checks.
Independent R2 source acceptance precedes separately granted R3-S (G3-C/G3-D).
R3-T remains mandatory actual Browser → Next.js → Express → PostgreSQL transport
with separate schema-as-fixture permission before P1 acceptance or P2 advancement.
D5-P1-B and D5-P2–P5 remain **NOT STARTED**; D5-P1 is not complete. Native Live
stays disabled, and D4 acceptance, O1–O8 and D1/D2/P2 dependency-security gates
are unchanged.

The historical independent R2 review returned **NEEDS FIX** for replayable G3-D
budgets and disappearing cleanup failures. R2-REMEDIATION-01 corrected these and
the separate historical handoff-helper typing issue. The owner supplied final
independent Codex **ACCEPT** for source aggregate
`e3aed76b48426ec3faf21e066a00bba84fc1cf4e0715b0565b841cfe26d0f4c1`
(557 files and 52 required test IDs); all listed source bytes matched before
R3-S-00A edits. No full reviewer transcript or independently signed approval
artifact was supplied here. Preserve earlier review records as historical.
The changed R3-S-00A invocation closure requires fresh manifests and independent
source review before deployment/execution. Neither acceptance completes P1 nor
grants G3-C/G3-D. The October 22 D3 capacity reconciliation records owner-observed
WSL2 ext4 filesystem and host free-space values; it does not establish exact VHDX
maximum/allocation, quota absence, mount options, or runtime headroom. No capacity
threshold or owner headroom acceptance is required for execution; retain the
2-CPU/1-GiB/128-PID runtime limits and treat actual resource failure honestly.

External authority: `2026-10-17-BETTER-AUTH-D5-P1-WINDOWS-DOCKER-THREAT-MODEL-REBASE-PLAN.md`
in StockWise external Post Phase 7 Implementation Records.

The dedicated R2 entrypoint is `tests/e2e/better-auth-d5/windows-run.cmd`
(or `node tests/e2e/better-auth-d5/windows-run.mts`). It is source-check-only:
an external JSON request supplied via `STOCKWISE_D5_R2_REQUEST` contains exact
`files` (`path`/`sha256`) and independently required `requiredTests` (`id`/`file`);
`STOCKWISE_D5_R2_REQUEST_SHA256` independently pins those request bytes.
It emits a source/migration manifest with execution **NOT_RUN**, never invokes
Docker, and has no resource, schema or application execution switch. This digest
comparison is an accidental-substitution control, not a hostile-user trust root
or a grant of G3-C/G3-D. Resource APIs remain separately gated.

Resource invocation may originate in the current Windows session. Earlier
planning's requirement for a genuinely clean, separate owner-controlled logon,
and its fail-closed response when no such session exists, are superseded by the
2026-10-22 allowlisted-child-environment decision above. Parent CMD/PowerShell
environment remains in the parent; names-only inspection and child construction
must happen in native PowerShell before Node startup. This is not host isolation
or sandboxing, and parent secrets must not be read or copied.

The new `windows-*.test.mts` tests use Node's built-in runner and injected resource
transport, not the root Vitest database harness. Execute only explicitly audited
file paths; do not substitute root `pnpm test`, `test:e2e`, build or generation
commands. Database-free outcomes prove source-contract behavior only.

`windows-resource-invocation.mts` remains a separate programmatic interface, not
a switch on the source-only CMD CLI. Independent R3-S-00A review returned
**NEEDS FIX** for incomplete import recognition and unbound Node launch options.
CLOSURE-REMEDIATION-01 replaces source-pattern scanning with the existing
TypeScript compiler API in a separate pre-execution verifier. Static relative
`.mts` imports/re-exports are recursively inventoried, including cycles and
type-only local dependencies; uncertain syntax, unsupported loading mechanisms,
dynamic imports, attributes, package imports, escapes and unsafe files refuse.

The owner-transferred independent review **CLOSED F2** (exact Node launch policy
and pre-execution verification). After the loader-alias correction, the latest
review still returned F1 **NEEDS FIX** for computed Function-constructor extraction.
COMPUTED-CONSTRUCTOR-REMEDIATION rejects ambiguous computed acquisition before
alias assignment/invocation. R2 and F2 production bytes remain unchanged; the
new scanner and its explicit exception table require focused independent review.

Computed element access and computed property names accept only direct string,
no-substitution-template or numeric literal key nodes. Reserved constructor,
prototype, loader and legacy getter/setter capability names still refuse.
Identifiers, concatenations, substitution templates, coercions, parenthesized
or asserted key expressions are unsupported, not constant-folded or inferred
safe. Object declaration/parameter bindings reject reserved renamed and shorthand
keys. Object/array destructuring **assignment** patterns (including nested and
for-in/for-of expression targets) are unsupported; ordinary object/array
construction and non-loading literal data access remain allowed.

The only nonliteral data-index exceptions are 22 existing sites (17 exact access
texts) in six immutable reviewed R2/F2 library modules. Each exception requires
the exact checked root-relative path, complete **raw-file SHA256**, and whole
access-expression text in the scanner's hardcoded table. The table is never
derived from candidate files/configuration/approval, and matching does not skip
other guards or traversal. Renaming or editing a module loses its exception.
These fixed sites serialize/compare data, select manifest/array records or
validated environment fields; none acquires an executable constructor. This
narrow compatibility rule preserves accepted source rather than allowing
arbitrary indexed values. It is a new reviewed-TCB input, not self-issued
execution authority. Site inventories and review rationale are external evidence.

The supported module-loading subset remains explicit static local `.mts`
imports/re-exports/type queries and permitted `node:` imports. `node:module`
allows only named non-loading introspection exports `builtinModules`/`isBuiltin`;
its other imports/re-exports and `node:process` imports refuse. Loader and
constructor/prototype capability references, ambient global/module/Reflect
aliases and Object reflection are unsupported. Ambient `process` may be used
only as a direct, optionally wrapped/chained dot receiver for `env`, `argv`,
`execArgv`, `execPath`, `platform`, `pid`, `cwd` and `exitCode`; other ambient
process references, including aliases, destructuring and computed access, refuse.
Ambient `Object` is limited to direct `keys`, `values`, `entries`, `assign`,
`freeze`, `hasOwn`, `is` and `create` access. Lexically declared runtime values
(including receipt parameters named `process`) remain distinct from ambient
roots; type-only/ambient declarations cannot authorize runtime capabilities.
`import.meta` likewise permits only direct `url`, `filename`, `dirname` and
`main` metadata access, not an aliased metadata object or extracted resolver.
Unrelated local functions, methods and imports named `register`/`registerHooks`
remain allowed. This is a conservative syntax/binding policy for the reviewed
static-loading subset, not comprehensive JavaScript data-flow analysis or a
general JavaScript sandbox. Unsupported reflective/dynamic module acquisition
is not an alternative admission path.

The only permitted supervisor launch is Node file execution with **zero Node
options and zero supervisor arguments**. No preload, loader, eval/print, aliases,
module-resolution options, NODE_OPTIONS/NODE_PATH or equivalent inherited
injection is accepted. Mode/execArgv, Node executable hash, exact entry/cwd and
complete closure are bound to the independent deployment pin.

The externally reviewed/deployed `windows-trusted-launch.cmd` is the native trust
root: the operator verifies it independently before invoking it from clean CMD
with AutoRun disabled. Its fixed inline Windows PowerShell uses `-NoProfile
-NonInteractive -Command`, without an execution-policy override or global
configuration change. It hashes an independently approved deployment envelope,
Node and the complete verifier/parser TCB **before starting Node**. The verifier
then performs syntax-complete closure checks and byte comparisons before
dispatching the supervisor with no Node options. TypeScript 6.0.3 is the existing approved
compiler; its exact package/runtime bytes are pinned as verifier TCB, not accepted
as an arbitrary supervisor package import. No dependency installation is implied.
The launcher does not self-approve its own hash. Deployment pins and native
launcher approval remain external and absent by default.
The native launcher takes no positional arguments. After original environment
validation, the owner supplies only public, session-local
`STOCKWISE_D5_LAUNCH_APPROVAL_PATH` and
`STOCKWISE_D5_LAUNCH_APPROVAL_SHA256` for independently approved external bytes.
These data values are read as environment data, never interpolated into command
source. They cannot be used to clear prohibited inherited settings or issue
G3-C/G3-D authority.

In-supervisor observation rechecks approved bytes and actual launch arguments as
defense-in-depth, not proof that preloads did not execute. It cannot replace native
prelaunch. Source/request/configuration and opaque acquisition/run/resource binding,
separate G3-C/G3-D, retained checkpoints and no implicit schema execution remain
unchanged. Remediation requires independent focused re-review; no independent
acceptance, deployment, runtime safety or D5-P1 completion is claimed.

#### Operational Windows Supervisor — source-only B2 implementation

The owner reports independent source ACCEPT for R2, R3-S-00A, B2 and final
NONDISPATCH-02. Earlier review dispositions remain historical provenance;
source acceptance grants no deployment pin, resource execution or Native activation.

**Historical NONDISPATCH-01 received an owner-transferred independent NEEDS FIX;
NONDISPATCH-02 subsequently closed the proof-binding finding at source level.**
A genuine unused refusal proof could previously be attached to an unrelated
reservation. Proofs now belong to a journal-issued, private, once-dispatched
attempt capability bound to journal instance, owner/lease token, run, reservation,
grant digest and attempt UUID before any gate or delegation decision. Public
metadata equality cannot create a replacement capability.

The helper claims an attempt once before awaiting the gate. The journal verifies
the full pending binding before consuming the exact proof; a mismatch neither
finishes A nor consumes B's proof. Definitive refusal uses a private append path:
the generic event writer cannot manufacture `COMMAND_NOT_DISPATCHED`. Correct
proof consumption precedes durable recording; failed/interrupted recording never
restores a reusable proof or clears uncertainty. Reload restores history and
budgets, never live capabilities. Legacy version-2 rows remain readable, not a
source of new dispatch authority.

`KNOWN_NOT_DISPATCHED` never refunds allowance, manufactures a process receipt or
claims deletion. Generic and post-delegation exceptions remain `UNCERTAIN`.
Earlier failures still prevent overall PASS after later authorized cleanup.
Closed, superseded and recovered journal instances reject obsolete proofs.
The original 17 F1 expression strings and 22 occurrences remain unchanged;
resource/journal compatibility hashes and the scanner TCB identity are refreshed
candidate review inputs only. Historical acceptance does not extend automatically
to changed bytes. B3-M1 below requires focused source/package re-review; no
deployment approval, runtime readiness or D5 completion is claimed.

`windows-supervisor.mts` is the operational file entry, with
`windows-supervisor-session.mts` and `windows-supervisor-protocol.mts`.
Startup is inert without independently approved launch and session inputs.
Native CMD, prelaunch, Node file/zero-option/zero-supervisor-argument policy and
source-only `windows-run.cmd` isolation remain unchanged. The verifier/parser TCB
still has eight files; its scanner identity changes and needs externally reviewed
pins. Do not import the TypeScript/prelaunch parser into the Supervisor closure
or add loader/scanner exceptions.

#### Exact Docker CLI deployment identity — B3-M1

B3 independent package review found that an endpoint/daemon pin did not bind the
local PATH-selected Docker client. `windows-docker-cli.mts` now loads a separately
reviewed external sidecar through public session-local
`STOCKWISE_D5_CLI_APPROVAL_PATH` and `STOCKWISE_D5_CLI_APPROVAL_SHA256`.
These select approved data, never an executable override. The sidecar has exactly
`contract`, `launchApprovalSha256`, `executable`, `executableSha256`; contract is
`D5-WINDOWS-DOCKER-CLI-v1`. Its independently supplied raw-byte digest and the
already approved prelaunch-envelope digest must match. The strict
`D5-WINDOWS-PRELAUNCH-v1` schema remains unchanged. Candidate-generated hashes
are not owner approval, and no default CLI path or self-issued pin exists.

The loader rejects missing/unknown fields, wrong bindings, relative/ambiguous/
redirected paths, sidecars inside source/deployed code, executables inside source,
nonregular files and mismatched bytes. Canonical absolute paths, ordinary ancestry,
realpath equality and stable file metadata/read/hash checks establish identity.
It issues a private-registry-backed frozen capability; request JSON, copied public
metadata and serialized capabilities cannot replace it. Programmatic invocations
must receive that independently established capability separately from request
data; the Supervisor binds its sidecar to the exact approved launch-envelope hash.

The adapter requires that capability before acquisition or cleanup recovery,
binds path/hash/sidecar/envelope identities into durable lease configuration,
and rechecks sidecar/executable bytes before reservation, after an awaited dispatch
gate and in the real shell-free transport immediately before `execFile`.
Every Docker operation uses the approved absolute `.exe` with fixed arguments
passed separately; PATH, PATHEXT and request/environment executable overrides
never choose it. Fixed `--host` and daemon checks remain mandatory.

CLI byte/path/approval drift blocks further dispatch. A generic gate-time identity
failure after reservation remains conservatively `UNCERTAIN`, retaining budget
and failure history; no new definitive-refusal proof is invented. Close/release
can still preserve a checkpoint without rehashing the changed executable, while
recovery requires valid matching approval and durable configuration. Restarting
requires reloading the independent sidecar, never deserializing a capability.
There is an unavoidable pathname check-to-execution race against a concurrently
mutating trusted owner/admin; this local accidental-error model does not claim
hostile-host tamper resistance. Docker Desktop updates invalidate byte approval.
No installed Docker file, ACL, dependency or global environment is modified.

Source-only CMD, F2 native/prelaunch sources, G3-C/G3-D separation, same-process
bootstrap handle, journal/proof safeguards and no-project-schema route remain
unchanged. All151 prior database-free roots plus11 new CLI roots passed; source
and replacement-package review evidence is external. The previous B3 candidate
is retained unchanged. Source remediation and candidate packaging do not grant
independent source/package acceptance, deployment approval or runtime authority.


The existing public `STOCKWISE_D5_LAUNCH_APPROVAL_PATH`/`SHA256` envelope
provides candidate/deployment identities. The two additional public,
session-local inputs are `STOCKWISE_D5_SUPERVISOR_PLAN_PATH` and
`STOCKWISE_D5_SUPERVISOR_PLAN_SHA256`. The plan is a regular external UTF-8
file outside candidate and deployed code, pinned by independently reviewed
raw bytes. The Supervisor never creates approvals or derives review authority
from its own observed hashes. It refuses prohibited names in its actual isolated
environment before reading input, before operations and before real transport dispatch.

The exact `D5-WINDOWS-SUPERVISOR-v1` plan has these fields:

| Field | Contract |
|---|---|
| `contract`, `sessionId` | Literal contract and fresh UUID-v4 session |
| `mode` | `acquire-bootstrap` or `cleanup-only`; never a shell/command mode |
| `candidateRoot` | Same absolute root as independently approved launch envelope |
| `requestBytes`, `requestSha256` | Exact externally reviewed R2 acquire-shaped base request; configuration remains fixed throughout the session |
| `sourceSha256`, `migrationSha256` | Expected accepted inventory aggregates, revalidated against source |
| `channelDirectory`, `approvalDirectory` | Separate external operator-input and owner-review mailboxes |
| `evidenceDirectory` | Exclusively created external evidence destination; existing destination refuses replay |
| `timeoutMs` | Integer 1,000–60,000; includes startup; never extends parent deadline |
| `checkpoint` | Null for acquisition; exact owner/run/token/journal hash for cleanup-only recovery |

The plan is bounded at 2 MiB and its base request at 1 MiB. Mailbox, evidence
and journal paths must be canonical local absolute Windows paths, disjoint
from each other and candidate/deployed code. Parent directories must exist;
regular-file reads reject symlinks/junctions, changed files, oversized payloads
and invalid UTF-8. The native/Node/deployment locations remain independently
selected and approved; no installation or dependency download is implicit.

The fixed file protocol is:

| Location | Exact typed data |
|---|---|
| Input `command.json` | `D5-WINDOWS-COMMAND-v1`: `contract`, `sessionId`, positive `sequence`, `operation` (`acquire`/`bootstrap`/`cleanup`), existing `grant` (`contract`, `digestInput`); at most 64 KiB |
| Separate owner-review `authority.json` | `D5-WINDOWS-AUTHORITY-v1`: `contract`, `sessionId`, `sequence`, independently supplied `messageSha256` (raw bytes) and `grantSha256` (existing canonical payload); at most 4 KiB |
| Input `heartbeat.json` | `D5-WINDOWS-HEARTBEAT-v1`: `contract`, `sessionId`, monotonic `counter`, Unix-millisecond `time`; freshness at most three seconds, future tolerance one second |
| Input `cancel.json` | `D5-WINDOWS-CANCEL-v1`: `contract`, `sessionId`; cancellation grants no resource authority |

Publish complete files atomically. For subsequent commands publish the owner
review authority first, then the command: mismatched or partial pairs fail
closed. An unchanged consumed command is ignored while waiting for the next
sequence; changed/replayed/out-of-order input refuses. Transport data alone
cannot authorize an operation. Keep the authority mailbox owner-reviewed and
separate from the command producer; this retains the accepted local trusted-owner
model, not a cryptographic boundary against a malicious Windows administrator.
No input chooses a script, executable, arbitrary command or per-message path.

Statuses are `WAITING_APPROVAL`, `ACQUIRING`, `ACQUIRED`, `WAITING_BOOTSTRAP`,
`BOOTSTRAPPING`, `RECOVERING`, `CLEANING`, `RELEASED`, `INCOMPLETE`, `FAILED`.
The Supervisor synchronizes `context.json` before resource dispatch, fixed-field
`status.json`/append-only `events.jsonl`, and an exclusive released
`checkpoint.json`. Evidence includes lease/run/resource identities, journal
location, inventory pins and failure count, never PostgreSQL passwords,
provider/environment values, raw grants or raw exception text.

The session calls `WindowsDockerLease` with the accepted real Docker transport
and a separate trusted pre-dispatch gate. It keeps the exact returned instance
alive for separately approved bootstrap; it never reconstructs an acquisition
handle from JSON. This adds no bypass to the unchanged invocation library:
the entry performs original-environment, launch, deployment, source,
fixed-configuration and exact grant checks. After durable reservation, the gate
checks heartbeat/cancellation/deadline and the adapter synchronously revalidates
authority immediately before delegation. The real transport remains recognizable
for original-environment checks; the adapter owns resource identity, expiry and
durable command budgets. Input data cannot supply a gate or outcome capability.
Uncertain acquisition never emits `ACQUIRED` or proceeds to bootstrap.

The unchanged prelaunch child deadline is 120 seconds. B2 uses a soft limit
of at most 60 seconds, with existing per-command timeout of 30 seconds, rather
than adding an interactive stdin channel or silently extending prelaunch.
On disconnect/cancellation/deadline no next command is dispatched; an already
dispatched command may finish or time out before controlled journal release.
The native wrapper's stdout remains buffered; operators observe durable files.
Hard kill, process crash or interrupted filesystem writes can still leave an
unreleased/uncertain journal: retain evidence and resources, report INCOMPLETE,
and require reviewed reconciliation. No signal/loader exception, stale-lock
takeover, reconstructed checkpoint or automatic destructive cleanup is added.

Acquire and bootstrap require distinct scoped G3-C payloads. Successful bootstrap
then releases local supervision without deleting resources. `RELEASED` with
cleanup INCOMPLETE is not overall PASS and exits nonzero; prelaunch also reports
non-success. Cleanup requires a separate `cleanup-only` session, valid released
checkpoint, unchanged configuration/source and exact G3-D authority. Recovery
restores cleanup evidence/budgets only, never creation/bootstrap authority.
Prior safety failures survive cleanup and cannot become PASS just because
resource absence is eventually established. Project migrations/reset/seed APIs
remain unavailable.

`windows-resources.mts` exposes `WindowsDockerLease.acquire`, `bootstrap`,
`reconcile` and `cleanup`; it is not mounted in normal runtime. Acquisition creates
only a stopped container, local volume and private internal network, using direct
Docker built-ins rather than Compose to avoid partial multi-resource commands.
Every invocation uses `npipe:////./pipe/docker_engine` explicitly. There is no
published PostgreSQL port, host bind, Docker socket mount, implicit image pull or
ambient context selection. The reviewed official PostgreSQL image digest and
resolved image ID must both match.

G3-C acquisition and bootstrap are distinct pinned operations. Bootstrap additionally
binds the acquired immutable resources, waits for TCP readiness, checks fresh
cluster metadata, creates only UUID-derived disposable role/database names and
checks the empty target. Generated synthetic credentials pass through process
environment/stdin and the owned container configuration, never host credential
files, command arguments or the journal. `executeSchema` is unavailable in R2.
G3-D additionally binds exact resource identities, an explicit
`stop-5s-then-force`/removal action list, exclusive operator window and residual
volume-name-race acceptance. An approval payload never supplies its own trusted
pin: the caller must separately provide the independently reviewed digest.
All grants bind operator, endpoint/daemon, source/migration/image inputs, absolute
journal directory, expiry, command count and 30-second command deadline.

Lease directories are exclusively created; unknown, legacy or stale supervisor
state is never automatically adopted. The version-2 hash-chained journal binds
lease, run ID and acquisition token. G3-D payloads additionally bind the run ID.
Each reviewed grant digest owns one cumulative command allowance: reservations
are synced before dispatch, never refunded after uncertainty, and preserved on
retry/reload. Expiry is checked again after reservation I/O. Superseded/exhausted
grants cannot be revived; extra allowance requires freshly reviewed authority.

`closeSupervisor` releases only local supervision and emits a pinned checkpoint;
`recoverCleanup` may reopen that exact released journal with an exclusive lock,
matching source/configuration and positive acquisition history. It restores no
creation/bootstrap authority. Missing checkpoints, stale heads, partial journal
records, unreleased locks and unquiesced destructive commands fail closed.
There is no automatic takeover of a crashed supervisor or adoption by labels.

Cleanup disposition and overall verdict are separate. Durable failure records
retain category, sanitized evidence, sequence and original timestamp. Ownership,
attachment, identity and authorization violations permanently prevent overall
PASS, even when later separately authorized cleanup establishes `CLEAN`.
Missing G3-D without an authority attempt is ordinary unfinished cleanup;
invalid, expired, exhausted or mismatched submitted authority is a failure.
`assertWindowsLeasePass` checks both resource disposition and retained history.

### D5-P1-A isolated infrastructure contract

Historical first independent P1-A review returned **NEEDS FIX: five MAJOR
and one MINOR**. Subsequent focused independent Codex reviews CLOSED F1-F6
at SOURCE LEVEL by 2026-10-16; tests, deployment and runtime isolation remain
NOT_RUN. Those reviews applied to the earlier stronger Linux authority model,
not to the newly proposed Windows/Docker Desktop local rehearsal lane.
Windows pathname/reparse provenance is not claimed. For the prior Linux lane,
a separately administered host was mandatory; same-user WSL was rejected.
No standalone Linux deployment was authorized or performed. No P1-B
execution is authorized under either path until its applicable gates pass.

`tests/e2e/better-auth-d5/` contains database-free ownership, migration,
source-integrity and evidence contracts, a sanitized Node test reporter, and
a bounded infrastructure-only runner. The dedicated strict configuration is
`tsconfig.better-auth-d5.json`; these tests deliberately do not use the root
Vitest database setup.

The CLI exposes only `manifest <absolute-external-json-path>` and never launches
resources. Its current-checkout manifest includes tracked and nonignored untracked
allowlisted sources, dependencies' configuration/lockfile, domain/auth composition,
tests and SQL. Environment files, generated output and Windows dependencies are
excluded. Historical SQL and lock metadata must match HEAD; untracked additions
remain explicitly classified and must follow history. Source/execution manifests
and completed migration-ledger prefixes must match exactly; no fixed migration count
is an execution authority.

Resource execution is a separate trusted-parent API. An independently supplied
approval digest binds the owner, review validity interval, source/migration hashes,
exact execution configuration, selected image and resolved image ID, and a nonempty
required-test manifest. Discovery cannot define that required set. The runner
validates process receipts and all mandatory stages through `validateEvidence`
before success; nonzero exits, signals, timeouts, missing tests or failed cleanup
cannot be overridden by passing test rows. Approval fields record permission;
they cannot grant it. The original CLI remains manifest-only.

`source-contract.mts` captures approved bytes into a private, bounded in-memory
snapshot using Linux descriptor-rooted, no-follow traversal and identity/hash
checks. Transfer uses a USTAR archive built from those bytes, never a second tar
read of mutable checkout paths. The transferred manifest and all source/package/
lockfile bytes are verified before dependency preparation. Descriptor-pinned
manifest output uses resolved segment-aware containment and exclusive creation;
Windows lexical validation handles other drives, but safe filesystem writes
remain unsupported there. A failed output write is retained for operator review,
not removed through a racy check-then-unlink.

The candidate `handoff.cmd` is fail-closed and must not be used as a trusted launch
interface. Neither candidate `windows-launch.mts` nor its security imports may
bootstrap trust. Reviewed source files may become deployment artifacts only after
independent administration pins and protects the **complete** bootstrap dependency
closure outside the candidate tree. Bootstrap executable, Node, configuration and
working-directory locations must be trusted absolute locations, with no PATH/CWD/
argument redirection or candidate-provided approval pin. Actual deployment is BLOCKED;
this task installs nothing and grants no deployment permission.

The intended producer has a constrained transfer-only capability to a separately
administered Linux coordinator. It must have no Linux root/sudo/shell management,
Docker socket/daemon access, approval/configuration writes, snapshot reads/writes or
shared writable mounts. A VM label alone is insufficient: independently reviewed
host identity, administrators, actual producer identity and denial-of-access evidence
must establish the boundary. Target and transport selection remain owner decisions,
not a WSL fallback. Coordinator/toolchain deployment must be pinned independently of
candidate code. No Windows-to-native writable alias or synchronization is allowed.
The producer must also lack administration of the Windows bootstrap installation,
VM hypervisor, console and virtual/native disks. A producer-administered VM is not
an independent security context. The ingress service must assign native destinations
from trusted policy, never accept producer-selected commands, working directories,
approval pins, environment overrides or snapshot paths.

Before execution, independently retained denial receipts must identify the **actual
Windows producer principal**, host identity, policy/configuration fingerprint, tested
operation, observed deny result and review validity. Required probes cover bootstrap
and closure writes/redirection; Linux root/sudo/remote shell; daemon/socket/API access;
approval/security-file reads and writes; snapshot reads/writes/mutation; shared-path
and synchronization aliases; hypervisor/console/disk management; and attempts to use
the transfer capability for anything except bounded approved candidate upload.
Positive upload must not confer readback, command execution or management authority.
All such probes remain NOT_RUN here; metadata declarations alone cannot prove ACLs.


The framed candidate protocol preserves exact bytes/line endings and requires the
complete approved tracked-plus-untracked allowlist, including `.cmd` entrypoints.
Absolute/traversing paths, links/special-file records, duplicates, omissions, extras,
size/hash drift, stale pins and interrupted transfers are rejected. Dependency stores,
environment trees and Windows node_modules are never transferred. The manifest is
independently pinned, never generated-and-approved from received bytes.

A future independently deployed coordinator must read provisioned
`owner-acceptance.json` and `execution-approval.json` under protected native storage,
not from the producer stream. No coordinator service or transport is deployed here.
Approval binds source, migration inventory, exact execution configuration and tests;
owner acceptance additionally binds the independently administered host, producer
identity, constrained capability, access-control evidence, native root/filesystem and
narrow received-snapshot authority while retaining Windows as project SoT.
The intake retains ext4, mount ID/device/source/statfs identity, descriptor-rooted
no-follow ancestry and private owner permissions. DrvFs, `/mnt/*`, ambiguous mounts
and unsupported filesystems fail closed. UID permissions protect local filesystem
operations but are not proof of exclusion from a same-user Windows/WSL administrator.

Verified regular-file bytes are exclusively written through pinned directory handles,
sealed read-only, captured into the existing private in-memory snapshot and compared
with the independently approved migration manifest. Only a private receive capability
can enter the runner; mutable Windows paths and Git HEAD cannot substitute for it.
USTAR transfer comes from verified snapshot bytes and pre-install package/lock/source
verification remains mandatory. Runtime source/dependency mounts remain read-only.
Both source-tree entrypoints are disabled. Independent Windows bootstrap and Linux
separation pins are absent; even direct receiver API calls fail before intake
acquisition. The pure metadata/closure validators are not installed OS verification
or ACL enforcement. Existing bounded candidate/native snapshot mechanisms remain
behind that gate; partial private native intakes, if separately authorized later,
must be retained for exact-owner review rather than broadly deleted.
Root/admin compromise and unreviewed TCB provisioning are outside this trust claim;
no Windows reparse-point protection is asserted.


Preparation/runtime still require a separately supplied digest-pinned Linux
toolchain containing Node 24.21.0, pnpm 11.19.0, tar/timeout and the exact offline
Linux dependency store at `/opt/pnpm-store`. The runner checks the actual image ID.
Seed, preparation and runtime keep no external network, host bind or host store;
all use UID/GID 1000, read-only root/toolchain, dropped capabilities,
no-new-privileges and bounded resources/time. After trusted snapshot seeding,
preparation mounts source read-only and permits writes only to scratch and three
explicit dependency subpaths. Runtime mounts those dependencies read-only too.
Frozen offline installation disables lifecycle scripts. No image is invented,
built or pulled by this task; actual isolation probes remain unexecuted.

Acquisition intent and an uncertain state are persisted before every create.
Full container-create response IDs are retained and journaled whenever available.
Lost responses require independent immutable-ID, name and acquisition-token
inventories. Token matches are reconciliation hints, not deletion/start authority.
An unknown-ID acquisition cannot become REMOVED merely because its name disappears;
rename, delayed creation, token conflict and inspection errors remain unresolved.
Original creation errors remain separate from cleanup disposition.

Removal and attempted-acquisition absence proofs require an independently enforced
exclusive resource-management boundary. None is established: the concrete runner
hard-denies that authority, disables destructive volume cleanup and retains
**INCOMPLETE** reconciliation receipts. No caller boolean or self-issued candidate
receipt enables cleanup. Repeated volume inspection cannot make name-based deletion
atomic. A future exclusive manager/broker and daemon access controls require separate
design, approval and proof; unrelated resources must never be adopted or removed.
Existing positive owner/source/acquisition-token/immutable-identity checks remain
necessary in addition to exclusivity, never a replacement for it.
Future exclusivity proof must cover daemon identity and every mutator path, serialized
namespace management, fencing/revocation and quiescence of pending/delayed creates
before absence can be asserted. A local mutex or repeated inspection is not that
proof. Existing or restored REMOVED labels are not a substitute for reconciled
identity and absence under this boundary. No manager implementation or activation
is included here.


The PostgreSQL contract requires an explicit canonical numeric-loopback URL with
an owner-derived `stockwise_d5_<UUID-without-hyphens>_test` database and dedicated
owner role. Runtime URL inheritance, overrides, ambiguous targets, ownership or
immutable-ID/cluster/topology mismatches fail closed. This module performs no SQL,
creates no PostgreSQL resources and never delegates cleanup to the target.

Full-stack preparation fixes the future browser → Next.js → Express → single native
resolver → PostgreSQL topology and required onboarding, organization/membership,
branch, Catalog, Inventory and Sales areas. It does not mount domain/auth routers or
implement P3 E2E. Native activation, alternate authority and Legacy fallback remain
forbidden. Future PostgreSQL, browser and separately supervised API/Next execution
need their own reviewed P1-B/P3 composition; the infrastructure-only runner cannot
launch those lanes.

Evidence distinguishes PASS/FAIL/SKIP/NOT_RUN, discovered/results, real process
exits, source/migration/configuration hashes, ownership, cleanup, no-fault-requested
receipts and limitations. Required missing/skipped execution, child/retention/cleanup
failure or manifest drift prevents success. Raw child diagnostics and browser
credentials/state/traces/screenshots are not exportable evidence. Hard parent
termination can leave stopped resource metadata: container-internal deadlines bound
execution, while the retained exact-ID journal supports owner-reviewed cleanup;
there is no automatic adoption or broad stale-resource deletion.

P1-A does not prove Docker availability, toolchain/store compatibility, isolation
at runtime, shutdown/cleanup behavior, PostgreSQL ownership in a real cluster or
browser transport. No database-free test may run outside the required isolation.
The no-container-before-independent-review gate leaves those tests and all resource,
database, migration, fault and full-stack smoke checks NOT_RUN in P1-A.


### D1 physical mapping and rollout constraints

- API dependencies: `better-auth@1.7.7` and
  `@better-auth/prisma-adapter@1.7.7`; both MIT, with Prisma 7 peer support.
  Dependency acceptance is not complete: production audit reports HIGH
  `GHSA-68fv-2mgg-jv7q` (`source-map-js`) and CRITICAL
  `GHSA-jqcg-44mw-7w3h` (`proxy-addr`). These also appear through existing
  Next/Express paths; exposure and remediation need a separate scoped review.
  pnpm's native peer resolution also changes Next's `baseline-browser-mapping`
  from 2.11.16 to 2.11.27 and `caniuse-lite` from 1.0.30001809 to 1.0.30001814;
  those unrelated resolutions require disposition before accepting D1.
  Use the native library/adapter rather than a second custom authentication
  implementation. Their transitive dependencies increase the API install
  surface; no browser integration or live mount is part of D1.
- Keep `User` as the only user identity. Map native `name` to `displayName`,
  `session` to `BetterAuthSession`, `account` to `BetterAuthAccount`, and
  `verification` to `BetterAuthVerification` in the future configuration.
  Use native UUID generation and keep joins disabled initially; relation
  property names are StockWise-owned. Existing null display names are retained;
  OTP registration must not invent names from email or write blank names.
- The core schema requires optional `image`, so User adds nullable
  `better_auth_image`. Native `emailVerified` maps to
  `better_auth_email_verified`, initially false. Migration
  `20261012000000_better_auth_native_schema` snapshots true from non-null
  `email_verified_at`. This is not ongoing synchronization: legacy writers
  remain authoritative. The gated cutover must reconcile and synchronize both
  fields while auth writers are quiesced before native authority is enabled.
- `users.password_hash` stays non-null with a valid Argon2id default using
  65536 KiB / 3 iterations / 4 lanes. Its 32-byte random preimage was generated
  and discarded in memory; only public dummy PHC material persists. The legacy
  runtime still explicitly inserts actual credential hashes. No existing hash,
  credential version, user UUID, business FK, or legacy Session is replaced.
- After ADR-036 completion of both mailbox and password proof, native enrollment
  stores the already-computed Argon2id PHC value **only** in
  `better_auth_accounts.password`. Promotion is a direct transactional write;
  never pass the PHC value to raw-password `setPassword`. The configured Better
  Auth 1.7.7 verifier must prove compatibility before D3 acceptance. The domain
  dummy remains inaccessible. Legacy authority must be disabled before native
  cutover; native enrollment must never reactivate domain-password authority.
- The new tables use UUID IDs, millisecond TIMESTAMPTZ fields, indexed user
  references, restrictive update/delete FKs, unique session tokens, and unique
  `(providerId, accountId)`. Native UUID/default generation is client-side;
  raw SQL insertions must supply IDs and `updated_at`.
- SQL generation uses a schema-to-schema diff, not a DB connection. The SQL
  wraps the additive DDL and verification-flag snapshot in one transaction.
  `ALTER TABLE users` requires an exclusive lock; the snapshot updates verified
  rows and holds locks until commit. Schedule the isolated apply/recovery
  rehearsal before any authorized deployment.
- Recovery is forward-only: retain the additive tables/columns and the legacy
  runtime if deployment is deferred. Before cutover, do not populate native
  credentials or treat the backfilled boolean as trusted runtime authority.
  The separate guarded disposable PostgreSQL gates have since run: D1 reported
  29/29 PASS for forward/clean migration application, uniqueness/FK constraints
  and existing UUID/domain-row preservation; D3 subsequently verified atomic
  native credential enrollment and Better Auth verifier compatibility in two
  isolated PostgreSQL runs (30/30 each). Later D4 integration exercised the
  native schema and session paths in disposable environments. These results do
  not prove migration application on the normal development/production DB or
  satisfy D5 restart/outage/recovery, deployment and rollback rehearsals.


### Historical implementation prerequisites and remaining verification gates

The following items were original prerequisites before selecting concrete
code/schema, not a claim that every item is still unverified. The isolated
D1 gate (29/29 PostgreSQL), D3 implementation/credential promotion, D4-N1/N2
session lifecycle and reset, D4-N3 browser integration, and aggregate D4 F1
sliding-idle remediation have since been implemented and verified in their
bounded scopes, with later independent reviews where recorded. The original
D1/D2 Codex independent review remains incomplete; do not promote it to
independent ACCEPT. Normal development/production migration application,
restart/outage/retry recovery, deployment and rollback rehearsal, real email,
production HTTPS and Live cutover remain separate D5/production gates.

Original prerequisites retained for traceability:

- Exact Better Auth version, Prisma 7 driver-adapter support, dependency/license/
  security impact, model/column mapping, UUID generation and stable identity
  linkage; no parallel Better Auth user store or automatic email-based linking.
- Verify Better Auth 1.7.7's configured password verifier against the directly
  promoted Argon2id PHC hash, with the two-proof pending-registration
  transaction. Do not use `setPassword` on a precomputed hash; the no-existing-
  user / atomic-promotion / credential-version contract is defined by ADR-036.
- Native session expiry/update/rotation mapping against current 24-hour idle,
  seven-day absolute, and 15-minute touch guarantees; cookie names/path/proxy
  behavior and immediate revocation. Defaults are not a verified contract.
- Blocking every public native registration/OTP/password route, internal-session
  exclusion from application authority, token-safe server calls and all response
  paths, durable cleanup, duplicate/idempotency semantics, and failure recovery.

A material incompatibility stops the affected milestone for an explicit decision;
fast implementation is not permission to silently weaken a security invariant.
Update topic-owned Source of Truth/API/use cases and affected tests as part of
the authorized implementation before cutover. Preserve earlier ADR contents.

## Cutover and rollback acceptance checklist

- Confirm the authorized target, reviewed additive migration, recoverable backup,
  domain row/UUID/FK baseline, and restoration rehearsal without live dev data.
- Accept all prerequisite compatibility decisions and independent D5 evidence;
  validate production HTTPS separately before any later production authorization.
- Quiesce auth writers and in-flight registration/delivery before switching.
  Apply only reviewed authorized forward migrations; preserve business data.
- Invalidate legacy sessions/verification continuations with an explicit safe
  re-sign-in/re-enrollment policy; remove old live auth readers/writers/routes at
  cutover. Never accept both session systems or resurrect legacy tokens.
- Enable only the matched Better Auth backend/frontend/schema; verify login,
  logout/all-session logout, reset, registration failure recovery, invitations,
  access-context, disabled users, role/branch changes and domain workflows.
- Rollback is a rehearsed single-authority recovery procedure, not a destructive
  down migration: stop new auth, revoke native sessions/internal leftovers,
  preserve additive schema and all domain writes/UUIDs, and restore a compatible
  legacy runtime only if credential/schema recovery is proven. Otherwise fail
  closed and forward-fix. Do not reactivate old sessions or run legacy writers
  against incompatible credentials/schema.

## Non-goals and remaining approval boundaries

No implementation, packages, lockfile edits, database connection/migration,
secrets, external email, production deployment, Git mutation, OAuth/social
login, Better Auth tenant/RBAC replacement, destructive cleanup, or dual live
auth in this task. `OQ-015`/`OQ-020` cloud/operations decisions remain open;
ADR-035 is not production-readiness acceptance. No actual-root migration tests
or M0B failure-atomicity results are claimed by these documents.
