import { databaseUrlSchema } from "../environment.ts";
import { createPrismaClient } from "../prisma/client.ts";
import {
  ProvisionRefusal,
  runProvision,
  type ProvisionMode,
} from "./demo-production-provision.ts";

function write(line: string): void {
  process.stdout.write(`${line}\n`);
}

function readMode(value: string | undefined): ProvisionMode {
  if (
    value === "verify" ||
    value === "dry-run" ||
    value === "apply" ||
    value === "retire"
  )
    return value;
  throw new Error("DEMOPROD_MODE_INVALID");
}

async function main(): Promise<void> {
  const mode = readMode(process.env.STOCKWISE_DEMO_MODE);
  const encoded = process.env.STOCKWISE_DEMO_SPEC_B64;
  const rawSpec =
    encoded === undefined || encoded.length === 0
      ? undefined
      : Buffer.from(encoded, "base64").toString("utf8");
  if (mode !== "verify" && rawSpec === undefined)
    throw new Error("DEMOPROD_SPEC_MISSING");
  const confirmDigest = process.env.STOCKWISE_DEMO_CONFIRM_DIGEST;
  const prisma = createPrismaClient({
    DATABASE_URL: databaseUrlSchema.parse(process.env.DATABASE_URL),
  });
  try {
    const fence = await prisma.$queryRaw<
      Array<{ state: string }>
    >`SELECT state FROM native_auth_transition`;
    if (fence[0]?.state !== "NATIVE")
      throw new Error("DEMOPROD_REQUIRES_NATIVE");
    await runProvision(
      prisma,
      {
        mode,
        ...(rawSpec === undefined ? {} : { rawSpec }),
        ...(confirmDigest === undefined ? {} : { confirmDigest }),
      },
      write,
    );
    write(`STOCKWISE_DEMO:${mode}:COMPLETE`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  // Driver and parser errors can echo values; only fixed codes pass through.
  const message =
    error instanceof ProvisionRefusal
      ? error.message
      : error instanceof Error && /^DEMOPROD_[A-Z_]+$/.test(error.message)
        ? error.message
        : "DEMOPROD_FAILED";
  process.stderr.write(`STOCKWISE_REFUSED: ${message}\n`);
  process.exitCode = 1;
});
