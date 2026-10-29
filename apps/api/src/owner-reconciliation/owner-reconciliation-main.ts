import { databaseUrlSchema } from "../environment.ts";
import { createPrismaClient } from "../prisma/client.ts";
import {
  ReconciliationRefusal,
  runOwnerReconciliation,
  type ReconciliationMode,
} from "./owner-reconciliation.ts";

function write(line: string): void {
  process.stdout.write(`${line}\n`);
}

function readMode(value: string | undefined): ReconciliationMode {
  if (value === "verify" || value === "dry-run" || value === "apply")
    return value;
  throw new Error("RECONCILE_MODE_INVALID");
}

async function main(): Promise<void> {
  const mode = readMode(process.env.STOCKWISE_RECONCILE_MODE);
  const encoded = process.env.STOCKWISE_RECONCILE_SPEC_B64;
  const rawSpec =
    encoded === undefined || encoded.length === 0
      ? undefined
      : Buffer.from(encoded, "base64").toString("utf8");
  if (mode !== "verify" && rawSpec === undefined)
    throw new Error("RECONCILE_SPEC_MISSING");
  const confirmDigest = process.env.STOCKWISE_RECONCILE_CONFIRM_DIGEST;
  const databaseUrl = databaseUrlSchema.parse(process.env.DATABASE_URL);
  const prisma = createPrismaClient({ DATABASE_URL: databaseUrl });
  try {
    const fence = await prisma.$queryRaw<
      Array<{ state: string }>
    >`SELECT state FROM native_auth_transition`;
    if (fence[0]?.state !== "NATIVE")
      throw new Error("RECONCILE_REQUIRES_NATIVE");
    await runOwnerReconciliation(
      prisma,
      {
        ...(confirmDigest === undefined ? {} : { confirmDigest }),
        mode,
        ...(rawSpec === undefined ? {} : { rawSpec }),
      },
      write,
    );
    write(`STOCKWISE_RECONCILE:${mode}:COMPLETE`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  // Driver and parser errors can echo values; only fixed codes pass through.
  const message =
    error instanceof ReconciliationRefusal
      ? error.message
      : error instanceof Error && /^RECONCILE_[A-Z_]+$/.test(error.message)
        ? error.message
        : "RECONCILE_FAILED";
  process.stderr.write(`STOCKWISE_REFUSED: ${message}\n`);
  process.exitCode = 1;
});
