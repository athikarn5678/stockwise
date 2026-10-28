import { parseArgs } from "node:util";

import { databaseUrlSchema } from "../environment.ts";
import { createPrismaClient } from "../prisma/client.ts";
import { runNativeCutover } from "./native-cutover-runner.ts";

const SAFE_REFUSAL =
  /^(?:NATIVE_CUTOVER_[A-Z_]+|TRANSITION_OPERATION_REFUSED:[A-Z0-9_]+)$/;

function write(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "confirm-database": { type: "string" },
      resume: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  const confirmDatabase = values["confirm-database"];
  if (confirmDatabase === undefined || confirmDatabase.length === 0)
    throw new Error("NATIVE_CUTOVER_CONFIRMATION_REQUIRED");
  let databaseUrl: string;
  try {
    // The schema's URL refinement can throw for malformed input; any failure
    // is the same fixed refusal.
    databaseUrl = databaseUrlSchema.parse(process.env.DATABASE_URL);
  } catch {
    throw new Error("NATIVE_CUTOVER_DATABASE_URL_INVALID");
  }
  const prisma = createPrismaClient({ DATABASE_URL: databaseUrl });
  try {
    const summary = await runNativeCutover({
      prisma,
      confirmDatabase,
      resume: values.resume === true,
      report: write,
    });
    write({ event: "complete", ...summary });
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  // Driver errors can echo connection details; report fixed codes only.
  const reason =
    error instanceof Error && SAFE_REFUSAL.test(error.message)
      ? error.message
      : error instanceof Error &&
          error.message === "Native cutover readiness check refused."
        ? "NATIVE_CUTOVER_READINESS_REFUSED"
        : "NATIVE_CUTOVER_FAILED";
  write({ event: "refused", reason });
  process.exitCode = 1;
});
