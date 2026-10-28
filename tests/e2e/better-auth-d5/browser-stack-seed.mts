import { createRequire } from "node:module";
import { resolve } from "node:path";

import { runNativeCutover } from "../../../apps/api/src/native-cutover/native-cutover-runner.ts";
import { assertNativeCutoverReady } from "../../../apps/api/src/modules/identity/better-auth-cutover-preflight.ts";
import { hashPassword } from "../../../apps/api/src/modules/identity/password-hasher.ts";
import { createPrismaClient } from "../../../apps/api/src/prisma/client.ts";
import { assertClusterOwned } from "../../../apps/api/src/test/disposable-ownership.ts";
import { loopbackReceiptDatabase } from "./browser-mail-capture.mts";
import { FIXTURES, FIXTURE_PASSWORD } from "./browser-stack-config.mts";

/**
 * Seeds the synthetic fixtures of the browser acceptance stack into the
 * launcher's freshly created, receipt-bound disposable database, then seals it
 * NATIVE with the accepted operator cutover (users are created while the fence
 * is LEGACY, so they receive proper enrollment provenance). Ownership of the
 * cluster is proven on a dedicated connection first; output is counts only.
 */
const receipt = loopbackReceiptDatabase(process.env);
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("BROWSER_STACK_SEED_DATABASE_URL_MISSING");

const require = createRequire(
  resolve(import.meta.dirname, "../../../apps/api/package.json"),
);
const { Client } = require("pg") as typeof import("pg");
const probe = new Client({ connectionString: databaseUrl });
await probe.connect();
try {
  await assertClusterOwned(probe, receipt);
} finally {
  await probe.end();
}

const prisma = createPrismaClient({ DATABASE_URL: databaseUrl });
try {
  const passwordHash = await hashPassword(FIXTURE_PASSWORD);
  const verifiedAt = new Date(Date.now() - 120_000);
  const createUser = (email: string, displayName: string) =>
    prisma.user.create({
      data: {
        email,
        passwordHash,
        status: "ACTIVE",
        displayName,
        emailVerified: true,
        emailVerifiedAt: verifiedAt,
        passwordChangedAt: verifiedAt,
      },
    });
  const onboard = async (userId: string, name: string) => {
    const organization = await prisma.organization.create({
      data: { name, salesVatStatus: "NOT_REGISTERED" },
    });
    await prisma.organizationMembership.create({
      data: { organizationId: organization.id, role: "OWNER", userId },
    });
    await prisma.branch.create({
      data: {
        code: "MAIN",
        name: "Main branch",
        organizationId: organization.id,
      },
    });
  };
  const owner = await createUser(FIXTURES.owner, "Browser Owner");
  await onboard(owner.id, "Synthetic Review Store");
  const second = await createUser(FIXTURES.second, "Browser Second");
  await onboard(second.id, "Synthetic Second Store");

  await runNativeCutover({
    prisma,
    confirmDatabase: receipt.testDatabase,
    resume: false,
    report: (event) => console.log(JSON.stringify(event)),
  });
  await assertNativeCutoverReady(prisma);
  console.log(JSON.stringify({ event: "seeded", users: 2, sealed: "NATIVE" }));
} finally {
  await prisma.$disconnect();
}
