import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { createPrismaClient } from "../../../apps/api/src/prisma/client.ts";
import { loadDemoDatabaseEnvironment } from "../../../apps/api/src/demo/demo-environment.ts";
import { verifyDemoDatabase } from "../../../apps/api/src/demo/demo-local-database.ts";
import { createDemo30dTestFixture } from "../../../apps/api/src/test/demo-30d-fixture.ts";

const { values } = parseArgs({
  options: {
    "state-file": { type: "string" },
    "output-environment": { type: "string" },
  },
});
if (!values["state-file"] || !values["output-environment"])
  throw new Error(
    "Explicit local state and environment output paths are required.",
  );
const { databaseUrl } = loadDemoDatabaseEnvironment();
const prisma = createPrismaClient({ DATABASE_URL: databaseUrl });
try {
  await verifyDemoDatabase(prisma, databaseUrl);
  if ((await prisma.organization.count()) || (await prisma.user.count()))
    throw new Error(
      "Browser setup requires a fresh disposable migrated demo database; it never resets an existing target.",
    );
  const fixture = await createDemo30dTestFixture(prisma);
  await writeFile(
    values["state-file"],
    JSON.stringify(
      {
        organizationId: fixture.organization.id,
        branchId: fixture.branches[0]!.id,
        otherBranchId: fixture.branches[1]!.id,
        otherOrganizationId: fixture.other.id,
        productId: fixture.products[0]!.id,
      },
      null,
      2,
    ),
  );
  const key = () => randomBytes(32).toString("base64url");
  await writeFile(
    values["output-environment"],
    [
      `DATABASE_URL=${databaseUrl}`,
      "STOCKWISE_RUNTIME_ENV=development",
      "STOCKWISE_AUTHENTICATION_AUTHORITY=legacy",
      "STOCKWISE_API_PORT=3231",
      "STOCKWISE_API_ORIGIN=http://127.0.0.1:3231",
      "STOCKWISE_PUBLIC_WEB_ORIGIN=http://localhost:3230",
      "STOCKWISE_EMAIL_PROVIDER=non_delivery",
      `STOCKWISE_INVITATION_CONTINUATION_KEY=${key()}`,
      `STOCKWISE_ANALYTICS_CURSOR_HMAC_KEY=${key()}`,
      `STOCKWISE_VERIFICATION_OTP_KEY=${key()}`,
      "STOCKWISE_VERIFICATION_OTP_KEY_ID=1",
      `STOCKWISE_VERIFICATION_PROOF_KEY=${key()}`,
      "STOCKWISE_VERIFICATION_PROOF_KEY_ID=1",
      `STOCKWISE_DEMO_INSIGHT_ORGANIZATION_ID=${fixture.organization.id}`,
      "",
    ].join("\n"),
    { flag: "wx" },
  );
  process.stdout.write(
    "Created synthetic fixture and local-only environment. Run demo:seed:30d preview before --apply.\n",
  );
} finally {
  await prisma.$disconnect();
}
