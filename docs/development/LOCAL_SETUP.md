# Local setup (Better Auth Native)

Short developer setup. `ADR-045` makes Better Auth **Native** the only authentication authority in every runtime. Legacy and the cutover step were removed in M3-T5/T6: any database created by `prisma migrate deploy` is already Native.

## Prerequisites
Node.js 24.21+, pnpm 11.19.0, Docker with Compose. Check with `node -v`, `pnpm -v`. Install with `pnpm install --frozen-lockfile`.

## 1. Environment file
1. `cp .env.example .env` (the real `.env` is gitignored; never commit or paste its values).
2. Replace every `<replace-…>` placeholder with a unique local value. Keys that must be base64url use:
   `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`
3. `STOCKWISE_BETTER_AUTH_SECRET` is **required**: at least 32 random bytes, distinct from every other key, stable across restarts. Generate it once and keep it only in `.env`.

## 2. Database
1. `docker compose up --detach postgres` (`docker compose ps` must show it healthy).
2. Apply migrations to the local database: `pnpm --filter @stockwise/api exec prisma migrate deploy --config prisma.config.ts` (needs `DATABASE_URL` from `.env`).
3. There is no cutover or sealing step: a fresh `prisma migrate deploy` already yields a Native database. A database created before migration `20261117000000_native_only_authentication` (LEGACY with users, or QUIESCED) makes that migration abort; recreate it instead (the migration is not reversible, so `pg_dump` before applying it to anything you cannot recreate).

## 3. Run
`pnpm dev:api` (needs `STOCKWISE_API_PORT` and the keys above) and `pnpm dev:web`. With the default non-delivery email provider, verification emails are not sent; use the test/e2e mailbox helpers or the harness described in `AUTH_INTEGRATION_HARNESS.md` to read OTPs.

## 4. Tests
- `pnpm verify` (format, lint, typecheck, unit/integration tests) uses `TEST_DATABASE_URL` (a loopback database ending in `_test`, different from `DATABASE_URL`). The `t3.json` Verify script loads it from `.env`.
- `pnpm test:e2e` (Playwright) needs its own `_test` database (M3 uses `stockwise_local_e2e_test`; `test:e2e` provisions and migrates it); supply it explicitly: `TEST_DATABASE_URL=<…/stockwise_local_e2e_test> pnpm test:e2e`. Ports 3000 and 3001 must be free. Restore `apps/web/next-env.d.ts` afterwards with `git restore apps/web/next-env.d.ts`; never commit it.
