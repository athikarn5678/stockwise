import { parseArgs } from "node:util";

import { z } from "zod";

import { createPrismaClient } from "../prisma/client.ts";
import { loadDemoDatabaseEnvironment } from "./demo-environment.ts";
import { runDemo30d } from "./demo-30d-runner.ts";

async function main() {
  const { values } = parseArgs({
    options: {
      "organization-id": { type: "string" },
      "reference-date": { type: "string" },
      seed: { type: "string", default: "30" },
      apply: { type: "boolean", default: false },
    },
  });
  const options = z
    .object({
      organizationId: z.uuid(),
      referenceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      seed: z.coerce.number().int().min(0).max(4_294_967_295),
      apply: z.boolean(),
    })
    .parse({
      organizationId: values["organization-id"],
      referenceDate: values["reference-date"],
      seed: values.seed,
      apply: values.apply,
    });
  const { databaseUrl } = loadDemoDatabaseEnvironment();
  const prisma = createPrismaClient({ DATABASE_URL: databaseUrl });
  try {
    process.stdout.write(
      `${JSON.stringify(await runDemo30d(prisma, options), null, 2)}\n`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  const safeMessage =
    error instanceof Error &&
    /^(?:Demo30d |Demo generation |DEMO_DATABASE_URL |DATABASE_URL |TEST_DATABASE_URL |Root \.env |root \.env )/.test(
      error.message,
    )
      ? error.message
      : "Demo30d refused or failed. Check the disposable target, synthetic allowlist, arguments and existing manifest.";
  process.stderr.write(`${safeMessage}\n`);
  process.exitCode = 1;
});
