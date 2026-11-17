# StockWise fixed demo dataset

## One-command 90-day demo from an empty database (M4-S1)

`demo:seed:90d` builds the whole synthetic demo on a **new, empty, disposable**
database in one command. It extends the pipeline below instead of replacing it:
a bootstrap writes the identity and catalog, then the existing 30-day runner and
provenance (`apps/api/src/demo/demo-30d-*.ts`, parameterised by a "shape") write
the activity through the production domain writers (purchasing, receiving,
checkout, refund, inventory adjustment) with injected clocks.

What it creates (organization `UAT Demo Siam Mart`, `Asia/Bangkok`, VAT not
registered):

- 3 branches `MAIN`, `NORTH`, `EAST`; 4 categories; 12 products `DEMO-P01`…`DEMO-P12`
  (EA/PACK/KG/L; `P01` sells most, `P12` least); 2 suppliers.
- 5 users, one per role, each with a verified Native credential account.
- 90 consecutive completed Organization-local days ending the day before the
  reference date: about 950 CASH/TRANSFER sales (more at weekends, slow growth),
  18 purchase orders that are ordered and received (every 15 days per branch),
  9 refunds with restock, and 9 manual stock adjustments (`DAMAGE`,
  `STOCK_COUNT`, `LOSS`). Four of the twelve products are ordered with a small
  surplus, so some stock is low at the end (reorder/forecast demos).

Local run (Docker is required for the disposable-database receipt described in
the next section; the receipt and `_demo` database name are unchanged guards):

```bash
export DEMO_DATABASE_URL='postgresql://<local-user>:<local-password>@127.0.0.1:<port>/<fresh-name>_demo'
export DEMO_DISPOSABLE_RECEIPT='<absolute-ignored-local-receipt-path>'   # see demo-local-setup.ts
pnpm demo:seed:90d --preview     # no writes: target check + plan counts
pnpm demo:seed:90d               # apply: bootstrap + 90 days
```

Options: `--reference-date YYYY-MM-DD` (default: today in `Asia/Bangkok`; the plan
covers the 90 days before it), `--seed <n>` (default `90`), `--preview`. A rerun
without `--reference-date` reuses the recorded reference date, so it validates
and replays the existing rows without duplicates (the second run is a no-op).
Changing the seed/date after the first run is refused; use a fresh database.
A full local apply takes under a minute.

Passwords: set `DEMO_USER_PASSWORD` (15–128 characters) to choose one. If it is
unset, **local runs only** use the documented default
`StockWise-Demo-2026!`. Never use that default on any shared or hosted
database; the Learner Lab target refuses to run without `DEMO_USER_PASSWORD`.
Credentials and hashes are never printed.

| Role | Email | Branches | What to try |
| --- | --- | --- | --- |
| OWNER | `demo-owner@example.invalid` | all | Everything: members/invitations, branches, catalog, suppliers, purchase orders and receiving, POS, sales history, refunds, analytics, forecast/reorder, AI analysis |
| ADMIN | `demo-admin@example.invalid` | all | Same as OWNER except owner governance (owner membership/transfer) |
| BRANCH_MANAGER | `demo-manager@example.invalid` | MAIN, NORTH | Branch operations in those two branches only: inventory and adjustments, purchase orders/receiving, POS with discounts, refunds, analytics, forecast/reorder, AI analysis; `EAST` is invisible |
| INVENTORY_STAFF | `demo-inventory@example.invalid` | NORTH | Inventory balances, history and manual adjustments, non-cost inventory analytics; no catalog, suppliers, purchase orders or forecast (ADR-042) |
| CASHIER | `demo-cashier@example.invalid` | MAIN | POS checkout (CASH/TRANSFER) and sales history; can view but not create refunds |

Demo Insight (`STOCKWISE_DEMO_INSIGHT_ORGANIZATION_ID` = the printed
organization id; development/test, and production only for this deterministic demo organization per ADR-048) renders deterministic text from
the real metrics with five fixed headings, labelled `ข้อมูลตัวอย่าง` / `Demo
Insight`, and makes no provider call: `ภาพรวม / Overview`, `ยอดขาย / Sales`,
`สินค้าขายดีและขายช้า / Products`, `ข้อสังเกต / Notes & risks`,
`สิ่งที่ควรทำ / Recommended actions`.

### AWS Learner Lab

The same dataset seeds through the existing deploy path: `operator/deploy.sh
--release <release.env> --var-file terraform/demo.tfvars --seed-demo`, or on its
own `operator/run-ops-task.sh seed` after `prepare` (migrations + grants) and
before the application task starts. The ops task runs `seed-through-loopback.mjs`,
which keeps the loopback/`*_demo` guard and starts `dist/demo/demo-seed-main.js`
with `STOCKWISE_DEMO_SEED_TARGET=learner-lab-ops`. A Docker receipt cannot exist
in ECS, so that target uses a narrower proof instead (`verifyLearnerLabSeedTarget`):
ops role, loopback forwarder to a `*_demo` database that is not production-looking,
and a database that is **empty** or holds only the deterministic demo organization.
Any other organization/user/product/sale makes it refuse. The password is the
generated `demo_user_password` in the `<name_prefix>/database` Secrets Manager
secret (the ops task receives it as `DEMO_USER_PASSWORD`). A rerun is a no-op.
The migrator role holds no database-level `CREATE`, so `roles.sql` pre-creates
the `stockwise_demo` provenance schema (owned by the migrator, no access for the
runtime role): run `run-ops-task.sh bootstrap-roles` (idempotent) once before the
first seed, also on an already bootstrapped database. The same flag also lets the
legacy `demo:seed:30d` skip the Docker receipt under the same conditions (ops
role, `*_demo` loopback target, empty or demo-organization-only database); the
database-content check is what protects real tenants.
The seed may take several minutes over the RDS hop; if the ECS wait times out,
rerun `run-ops-task.sh seed`, which resumes the same manifest.

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
from the migration SQL). The database is Native directly from its migrations
(`ADR-045`): seeding writes the demo users together with one Better Auth
credential account each (`users` has no hash column; no cutover step), and
every other Better Auth table must be empty. Seeding is optional for
the AWS Academy demo (`infra/learner-lab/README.md`). To verify seeding and a
Native sign-in of a seeded user on a receipt-owned disposable
PostgreSQL (Docker required):

```powershell
node tests/e2e/demo-seed/demo-seed-check.mts
```
