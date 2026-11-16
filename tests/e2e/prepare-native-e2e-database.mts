import { runNativeCutover } from "../../apps/api/src/native-cutover/native-cutover-runner.ts";
import { loadTestDatabaseEnvironment } from "../../apps/api/src/test/database-environment.ts";
import {
  applyTestDatabaseMigrations,
  createTestPrismaClient,
  provisionTestDatabase,
} from "../../apps/api/src/test/database-harness.ts";

/**
 * Prepares the guarded disposable e2e database for a Native-authority API
 * process before Playwright starts its web servers. Startup refuses anything
 * that is not sealed NATIVE, so the fence transition must happen here rather
 * than in global setup. Only fixed status lines are printed: never the
 * database URL, credentials or user data.
 */
async function prepare(): Promise<void> {
  const environment = loadTestDatabaseEnvironment();
  await provisionTestDatabase(environment);
  await applyTestDatabaseMigrations(environment);
  const prisma = createTestPrismaClient(environment);

  try {
    const fence = await prisma.$queryRaw<{ state: string }[]>`
      SELECT state FROM native_auth_transition WHERE id = true
    `;
    const state = fence[0]?.state;
    if (state === "NATIVE") return;
    if (state !== "LEGACY") throw new Error("E2E_DATABASE_FENCE_UNUSABLE");

    // No conversion path exists for existing Legacy identities: only a target
    // without users may be sealed, and its data is never rewritten here.
    const users = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*)::bigint AS count FROM public.users
    `;
    if ((users[0]?.count ?? 0n) !== 0n)
      throw new Error("E2E_DATABASE_NOT_EMPTY");

    const target = await prisma.$queryRaw<{ name: string }[]>`
      SELECT current_database() AS name
    `;
    const confirmDatabase = target[0]?.name;
    if (confirmDatabase === undefined)
      throw new Error("E2E_DATABASE_TARGET_UNKNOWN");

    // Phase A only: milestone M3-T5/T6 removes this cutover call once a fresh
    // database is Native from its migrations.
    await runNativeCutover({
      prisma,
      confirmDatabase,
      resume: false,
      report: () => {},
    });
  } finally {
    await prisma.$disconnect();
  }
}

try {
  await prepare();
  process.stdout.write("e2e database ready: NATIVE\n");
} catch (error) {
  // Only the fixed error codes of this script and the cutover are printed.
  const code =
    error instanceof Error &&
    /^(E2E|NATIVE_CUTOVER)_[A-Z_]+$/.test(error.message)
      ? error.message
      : "E2E_DATABASE_PREPARE_FAILED";
  process.stdout.write(`e2e database prepare failed: ${code}\n`);
  process.exitCode = 1;
}
