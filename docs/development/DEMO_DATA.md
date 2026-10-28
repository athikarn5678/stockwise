# StockWise fixed demo dataset

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
