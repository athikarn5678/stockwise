// OPTIONAL synthetic demo seeding (ADR-039/ADR-040, D-08), run only inside the
// ops container by ops/ops-task.sh seed, before the first native:cutover.
//
// The accepted seeder (`apps/api/src/demo`) refuses every non-loopback,
// non-`*_demo` target. This wrapper keeps that guard intact: it listens on the
// container's own 127.0.0.1 and forwards to the private RDS endpoint taken from
// the migrator DATABASE_URL, then runs the unmodified seeder against the
// loopback address.
//
// The upstream hop uses authenticated TLS (finding F5). verified-postgres-
// forwarder.mjs negotiates PostgreSQL TLS itself and verifies the RDS CA chain,
// the validity period and the RDS hostname before forwarding a single byte.
// Verification cannot be downgraded: the source URL must ask for verify-full,
// and any no-verify or override setting is refused. The seeder's own hop is
// plaintext on the container loopback only, so its hostname guard still sees
// 127.0.0.1. It prints only the seeder's own credential-free output.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";
import { URL } from "node:url";

import {
  assertVerifiedTlsSettings,
  createVerifiedPostgresForwarder,
} from "./verified-postgres-forwarder.mjs";

const source = new URL(process.env.DATABASE_URL ?? "");
if (source.protocol !== "postgresql:" || !source.hostname)
  throw new Error("SEED_LOOPBACK_SOURCE_INVALID");
const database = decodeURIComponent(source.pathname.slice(1));
if (!/^[a-z0-9_]+_demo$/.test(database))
  throw new Error("SEED_LOOPBACK_DATABASE_NOT_DEMO");
assertVerifiedTlsSettings(source);
if (source.hostname !== process.env.STOCKWISE_DB_HOST)
  throw new Error("SEED_UPSTREAM_HOST_MISMATCH");

const ca = readFileSync(
  process.env.STOCKWISE_DATABASE_CA_FILE ??
    "/etc/stockwise/rds-global-bundle.pem",
);
let rejected = null;
const forwarder = await createVerifiedPostgresForwarder({
  upstreamHost: source.hostname,
  upstreamPort: Number(source.port || 5432),
  servername: source.hostname,
  ca,
  onRejected: (error) => {
    rejected = error;
  },
});

const target = new URL(source);
target.hostname = "127.0.0.1";
target.port = String(forwarder.port);
target.search = "";
const environment = { ...process.env, DEMO_DATABASE_URL: target.toString() };
// The seeder compares DATABASE_URL/TEST_DATABASE_URL against its target and
// refuses non-loopback values; neither applies here.
delete environment.DATABASE_URL;
delete environment.PRISMA_MIGRATE_DATABASE_URL;
delete environment.TEST_DATABASE_URL;
// Loopback hop only; the forwarder enforces verified TLS upstream.
environment.PGSSLMODE = "disable";

const child = spawn(process.execPath, ["dist/demo/demo-main.js"], {
  env: environment,
  stdio: "inherit",
});
const code = await new Promise((done) =>
  child.once("close", (status) => done(status ?? 1)),
);
await forwarder.close();
if (rejected) {
  process.stderr.write(
    `STOCKWISE_REFUSED: upstream database TLS verification failed (${rejected.message})\n`,
  );
  process.exit(code === 0 ? 1 : code);
}
process.exit(code);
