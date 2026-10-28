import { databaseUrlSchema } from "../environment.ts";
import { createPrismaClient } from "../prisma/client.ts";
import {
  provisionAccounts,
  provisionMemberships,
  uatSpecSchema,
  type UatPhase,
} from "./uat-provision.ts";

function write(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function main(): Promise<void> {
  const phase = process.env.STOCKWISE_UAT_PHASE;
  if (phase !== "accounts" && phase !== "memberships")
    throw new Error("UAT_PHASE_INVALID");
  const encoded = process.env.STOCKWISE_UAT_SPEC_B64;
  if (encoded === undefined || encoded.length === 0)
    throw new Error("UAT_SPEC_MISSING");
  let spec;
  try {
    spec = uatSpecSchema.parse(
      JSON.parse(Buffer.from(encoded, "base64").toString("utf8")),
    );
  } catch {
    throw new Error("UAT_SPEC_INVALID");
  }
  const databaseUrl = databaseUrlSchema.parse(process.env.DATABASE_URL);
  const prisma = createPrismaClient({ DATABASE_URL: databaseUrl });
  try {
    const fence = await prisma.$queryRaw<
      Array<{ state: string }>
    >`SELECT state FROM native_auth_transition`;
    if (fence[0]?.state !== "NATIVE") throw new Error("UAT_REQUIRES_NATIVE");
    const selected: UatPhase = phase;
    if (selected === "accounts") await provisionAccounts(prisma, spec, write);
    else await provisionMemberships(prisma, spec, write);
    write(`STOCKWISE_UAT:${selected}:COMPLETE`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  // Driver errors can echo connection details; only fixed UAT_ codes pass.
  const message =
    error instanceof Error &&
    /^UAT_[A-Z_]+(?:: [\w@.,\- ()]+)?$/.test(error.message)
      ? error.message
      : "UAT_PROVISIONING_FAILED";
  process.stderr.write(`STOCKWISE_REFUSED: ${message}\n`);
  process.exitCode = 1;
});
