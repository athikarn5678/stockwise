# Local setup (Better Auth Native)

Short developer setup. `ADR-045` makes Better Auth **Native** the only authentication authority in every runtime. Until milestone M3-T5/T6 land, the code still contains Legacy and a Native database needs the one-time `native:cutover` step; both disappear later in M3 (this file is updated then).

## Prerequisites
Node.js 24.21+, pnpm 11.19.0, Docker with Compose. Check with `node -v`, `pnpm -v`. Install with `pnpm install --frozen-lockfile`.

## 1. Environment file
1. `cp .env.example .env` (the real `.env` is gitignored; never commit or paste its values).
2. Replace every `<replace-…>` placeholder with a unique local value. Keys that must be base64url use:
   `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`
3. `STOCKWISE_BETTER_AUTH_SECRET` is **required**: at least 32 random bytes, distinct from every other key, stable across restarts. Generate it once and keep it only in `.env`.
4. While Legacy code still exists, add `STOCKWISE_AUTHENTICATION_AUTHORITY=native` to run Native locally (removed in M3-T5, after which Native is unconditional).

## 2. Database
1. `docker compose up --detach postgres` (`docker compose ps` must show it healthy).
2. Apply migrations to the local database: `pnpm --filter @stockwise/api exec prisma migrate deploy --config prisma.config.ts` (needs `DATABASE_URL` from `.env`).
3. Native needs a database whose authentication fence is sealed NATIVE. **Transitional (until M3-T6):** an *empty* database is sealed with `pnpm --filter @stockwise/api native:cutover -- --confirm-database <exact database name>`; run it only with the API stopped, never on a database holding data you cannot recreate. After M3-T6 a fresh `prisma migrate deploy` already yields a Native database and this step no longer exists.

## 3. Run
`pnpm dev:api` (needs `STOCKWISE_API_PORT` and the keys above) and `pnpm dev:web`. With the default non-delivery email provider, verification emails are not sent; use the test/e2e mailbox helpers or the harness described in `AUTH_INTEGRATION_HARNESS.md` to read OTPs.

## 4. Tests
- `pnpm verify` (format, lint, typecheck, unit/integration tests) uses `TEST_DATABASE_URL` (a loopback database ending in `_test`, different from `DATABASE_URL`). The `t3.json` Verify script loads it from `.env`.
- `pnpm test:e2e` (Playwright) needs its own `_test` database sealed NATIVE (M3 uses `stockwise_local_e2e_test`); supply it explicitly: `TEST_DATABASE_URL=<…/stockwise_local_e2e_test> pnpm test:e2e`. Ports 3000 and 3001 must be free. Restore `apps/web/next-env.d.ts` afterwards with `git restore apps/web/next-env.d.ts`; never commit it.
