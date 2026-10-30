# StockWise fixed demo dataset

## Completed 30-day UAT extension (ADR-042)

`demo:seed:30d` extends this API-owned demo pipeline for an **existing** synthetic
`UAT Demo Siam Mart` organization. It preserves accounts, memberships, branches,
products and unrelated organizations. It requires exactly one active verified
OWNER, an active supplier, an existing configured sales VAT policy, at least one
active branch and three active products with positive prices. It uses the first
two branches by code and first six qualifying products by SKU. Existing excess
stock may legitimately prevent low-stock recommendations; the seeder never erases
it to manufacture a warning. Existing unrelated stock history for selected pairs
must precede the requested 30-day window. Backfilling over newer activity would
mix future stock/cost state into historical events, so it is refused. Start from
an older historical baseline or a fresh local identity/catalog fixture.

Supply an explicit Organization UUID, random seed and exclusive local reference
date. It generates 30 consecutive **completed** Organization-local days, about
300–600 synthetic sales, both CASH and TRANSFER, initial and mid-period receipts,
moving-average costs, three limited restocked refunds and demand variation.
Money/quantities use Decimal and the production calculation/transaction writers.
The historical draft PO adapter exists only in `apps/api/src/demo/`; completed
receipt/sale/refund events use injected clocks, never timestamp rewrites.

The plan and commercial values are reproducible for the same existing IDs,
catalog/settings, timezone, seed and date. Production writers retain their normal
random document IDs; reproducibility means logical transactions/amounts rather
than byte-identical generated UUIDs in independently created databases. Exact
reruns preserve the existing rows/IDs and add no duplicates. A seed-only advisory
lock serializes runs. Each domain command is atomic; interruption may leave a
valid partial run, resumed by the same manifest. Changing the manifest is refused
once its local seed provenance exists; use a fresh disposable copy. Existing live retail
writers must be stopped while preparing a historical demo copy.

Before any setup or seeding, create a **new owned local Docker PostgreSQL**
container with a random UUID label `stockwise.disposable=<uuid>` and a
`127.0.0.1:<port>:5432` binding. Existing local-runner containers with their
`stockwise.local.owner` UUID label are also supported. Apply committed migrations
only to its new empty database. Issue the local receipt **before adding fixture
accounts or any business data**:

```powershell
$env:DEMO_DATABASE_URL = 'postgresql://<local-user>:<local-password>@127.0.0.1:<port>/<fresh-name>_demo'
node apps/api/src/demo/demo-local-setup.ts --container-id <full-64-character-container-id> --receipt-file <absolute-ignored-local-receipt-path>
$env:DEMO_DISPOSABLE_RECEIPT = '<absolute-ignored-local-receipt-path>'
```

Setup requires a local named-pipe/Unix Docker daemon, a live owned container and
matching published port, independently reads its PostgreSQL system identifier,
compares the connected database, verifies emptiness, and writes a random database
marker and receipt. Each seeder rechecks the container ID/owner/binding, system ID,
database OID/name and marker before writes. A copied marker or a loopback port
forward alone fails. Keep receipts with ignored local runtime files, never in
published evidence. For `*_test` setups, the local test coordinator calls
`issueDemoDatabaseReceipt` before fixture creation and supplies
`TEST_DISPOSABLE_RECEIPT`. This does not weaken ordinary URL/collision guards.
Non-Docker instances cannot provide this proof and are refused.

A first 30-day apply requires the synthetic organization's **entire business
history to be empty**, including unselected/inactive branches and products. It
preserves identity, membership, branch, product and supplier master data. Older
baseline business history is also refused: use a fresh disposable fixture. It
never deletes history. Local provenance records the exact plan before the first
draft. Partial reruns validate recognized orders/receipts, sales/payments,
refunds, ledger and balances/costs. COMPLETE runs require an unchanged fingerprint
of every organization business row plus products/branches. Missing/changed
provenance, unrelated activity or later edits fail closed. Fixtures from before
this receipt/provenance contract are not automatically attested or upgraded;
retain them as evidence and use a new disposable database.

The seed-only advisory lock is held on a dedicated PostgreSQL **session**, not a
180-second outer transaction. Domain commands retain their own bounded atomic
transactions. Lock waiting is bounded; the run deadline is checked between awaited
commands. The session closes only after the current command settles, so exceeding
the deadline cannot release the lock while commands continue. Resume with the same
manifest after an interrupted/expired run. Keep other application writers stopped.

Preview is the default and performs no application writes:

```powershell
$env:DEMO_DATABASE_URL = 'postgresql://<local-user>:<local-password>@127.0.0.1:<port>/<fresh-name>_demo'
pnpm --filter @stockwise/api demo:seed:30d --organization-id <synthetic-org-uuid> --reference-date 2026-10-30 --seed 30
# Review the preview's signature, local range and counts, then explicitly apply:
pnpm --filter @stockwise/api demo:seed:30d --organization-id <synthetic-org-uuid> --reference-date 2026-10-30 --seed 30 --apply
# Identical command validates/replays existing operations without duplicate rows.
```

The CLI uses the existing demo database URL guard: explicit process-only input,
loopback PostgreSQL, `_demo` suffix, no production/staging/test names, production
runtime rejection, and no collision with process/root `.env` runtime/test URLs.
No user password is needed for the extension; it never changes credentials.
Both this extension and the original `demo:seed` also require positive disposable-instance proof as described below.

For a **new disposable local browser fixture only**, migrate a fresh `_demo`
database using the committed migration chain, then:

```powershell
node tests/e2e/demo-30d/setup.mts --state-file <absolute-state-json> --output-environment apps/api/.env.demo30d
```

Setup refuses existing users/organizations, creates synthetic five-role accounts
and an unrelated tenant, and writes runtime test keys only to the ignored local
environment file. Never put the runtime file in Obsidian or commit it. Read the
Organization UUID from the state file, run the preview/apply commands above, then
start the local stack:

```powershell
# Separate terminal; development/Legacy is confined to this disposable fixture.
node --env-file=apps/api/.env.demo30d apps/api/src/main.ts
# Separate terminal; set the server-only proxy origin for build and start.
$env:STOCKWISE_API_ORIGIN = 'http://127.0.0.1:3231'
pnpm build
pnpm --filter @stockwise/web exec next start --hostname 127.0.0.1 --port 3230
# Browser check against that stack; no global reset or Production connection.
$env:DEMO30D_BROWSER_STATE = '<absolute-state-json>'
pnpm exec playwright test --config playwright.demo-30d.config.ts --project chromium
```

The fixture accounts are `demo30d-<role-in-lowercase>@example.invalid`, with the
synthetic test-only password defined in `apps/api/src/test/demo-30d-fixture.ts`.
These are disposable fixture credentials, never real account changes. The API's
`STOCKWISE_DEMO_INSIGHT_ORGANIZATION_ID` explicitly enables the labeled bilingual
Demo Insight only for this synthetic Organization UUID; no OpenRouter key is
needed. Existing persisted AI reports remain separate. Demo text uses real calculations at the COMPLETE seed provenance's fixed reporting boundary and preserves unavailable Forecast/Reorder behavior. Production rejects this configuration.

The ordinary test runner needs a separate guarded `_test` database. It does not
require Docker attestation: the three receipt-dependent demo suites intentionally
skip when `TEST_DISPOSABLE_RECEIPT` is absent (24 tests). Other tests still run,
including the normal CI PostgreSQL service configuration. The original fixed-reference
demo fixture's two tests retain their separate `DEMO_DATABASE_URL` /
`DEMO_USER_PASSWORD` opt-in.

```powershell
$env:TEST_DATABASE_URL = 'postgresql://<local-user>:<local-password>@127.0.0.1:<port>/<fresh-name>_test'
Remove-Item Env:TEST_DISPOSABLE_RECEIPT -ErrorAction SilentlyContinue
pnpm test
```

To run all receipt-dependent tests, create a **fresh owned local Docker instance**
as above, with its initial empty `POSTGRES_DB` ending `_test`. Issue a real receipt
against that instance before fixture data is created (the ordinary test global
setup applies committed migrations):

```powershell
$env:TEST_DATABASE_URL = 'postgresql://<local-user>:<local-password>@127.0.0.1:<owned-port>/<fresh-name>_test'
$env:TEST_DISPOSABLE_RECEIPT = '<absolute-ignored-local-test-receipt-path>'
node --input-type=module -e 'import { issueDemoDatabaseReceipt } from "./apps/api/src/demo/demo-local-database.ts"; await issueDemoDatabaseReceipt({ databaseUrl: process.env.TEST_DATABASE_URL, containerId: "<full-64-character-owned-container-id>", path: process.env.TEST_DISPOSABLE_RECEIPT });'
pnpm exec vitest run apps/api/src/demo/demo-30d.integration.test.ts apps/api/src/demo/demo-30d-remediation.integration.test.ts apps/api/src/demo/demo-local-database.integration.test.ts
```

With both inputs set, all 24 tests execute; no skip decision depends on whether a
receipt file exists or validates. A supplied missing, invalid or mismatched receipt
therefore fails through the unchanged verification guards rather than silently
skipping. Never substitute a fake receipt or relax seeder ownership checks. These
test opt-ins grant no seeding authority to the application or a Production target.

No Production seeding, production migration, deployment, scheduler, external
email, cloud operation or credential rotation is authorized by these commands.

## Production demo organization (ADR-043)

The disposable-database seeder above must never be pointed at Production. A Production demo is created only by the operator action, after a verified export:

```bash
infra/learner-lab/operator/run-ops-task.sh provision-demo --demo-mode dry-run --demo-spec-file <spec.json>
infra/learner-lab/operator/run-ops-task.sh provision-demo --demo-mode apply --demo-spec-file <spec.json> --demo-confirm-digest <digest printed by dry-run>
infra/learner-lab/operator/run-ops-task.sh provision-demo --demo-mode retire --demo-spec-file <spec.json> --demo-confirm-digest <retire digest printed by dry-run>
```

The spec names a new organization (never `UAT Demo Siam Mart`), two branches, six products, a supplier and the five presenter accounts by email SHA-256. Dry-run prints the approval digest and the expected 436 sales / 4 receipts / 3 refunds / THB 38,630.00 net revenue. Apply is resumable; `retire` deletes nothing. Totals depend only on the seed, not on the reference date.

## Original fixed-reference dataset

`stockwise-demo-v1` is the fixed-reference fixture specified in
[`ANALYTICS.md`](../contracts/ANALYTICS.md). It ends at 2026-09-26 00:00 in `Asia/Bangkok`.
Forecast and reorder goldens use the injected 2026-09-25T17:00:00.000Z clock;
live HTTP continues to use the real clock. This command is for disposable local
demo databases, not production.

Provision a **new, empty** local PostgreSQL database whose name ends `_demo`
and apply the repository's committed Prisma migrations to it. Set both inputs
explicitly in the process running the command:

```powershell
$env:DEMO_DATABASE_URL = 'postgresql://<local-user>:<local-password>@127.0.0.1:5432/<fresh-name>_demo'
$env:DEMO_USER_PASSWORD = '<new demo-only password of 15-128 Unicode code points>'
pnpm --filter @stockwise/api demo:seed
```

The command never reads `DEMO_DATABASE_URL` from `.env`. It rejects non-loopback,
non-`_demo`, test, production-looking, malformed, or colliding targets and checks
the migration state before writing. It creates all application rows in one
transaction, then validates the complete logical manifest, stock reconciliation,
and selected analytics, forecast, and reorder goldens. An unchanged rerun with
the same password is a no-op. Partial, changed, foreign, or post-login session
data cause a fail-closed error; rebuild in another fresh `_demo` database rather
than deleting rows. Credentials and connection URLs are never printed.

The target must hold exactly the committed migrations and the table set they
produce (`apps/api/src/demo/demo-schema.ts`; `demo-schema.test.ts` re-derives it
from the migration SQL). Seeding runs only before the Better Auth Native
transition: every Better Auth table must be empty and `native_auth_transition`
must be `LEGACY`; a QUIESCED or NATIVE database is refused. Run
`native:cutover` afterwards to enroll the seeded users. Seeding is optional for
the AWS Academy demo (`infra/learner-lab/README.md`). To verify seeding, the
cutover and a Native sign-in of a seeded user on a receipt-owned disposable
PostgreSQL (Docker required):

```powershell
node tests/e2e/demo-seed/demo-seed-check.mts
```
