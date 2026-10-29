import { readFileSync, writeFileSync } from "node:fs";

import { createPrismaClient } from "../prisma/client.ts";
import { databaseUrlSchema } from "../environment.ts";
import {
  buildOwnerReconciliationSpec,
  type OwnerApproval,
} from "./owner-reconciliation-spec.ts";
import { specDigest } from "./owner-reconciliation.ts";

/**
 * Local operator tool (not part of the ops image): resolves the approval file
 * against DATABASE_URL, which must be a RESTORED COPY of a fresh export, and
 * writes the spec. Prints only the digest and ID prefixes.
 *   node owner-reconciliation-spec-main.ts <approvals.json> <spec-out.json>
 */
const [approvalsPath, outputPath] = process.argv.slice(2);
if (approvalsPath === undefined || outputPath === undefined)
  throw new Error("usage: <approvals.json> <spec-out.json>");

const approvals = JSON.parse(
  readFileSync(approvalsPath, "utf8"),
) as OwnerApproval[];
const prisma = createPrismaClient({
  DATABASE_URL: databaseUrlSchema.parse(process.env.DATABASE_URL),
});
try {
  const spec = await buildOwnerReconciliationSpec(prisma, approvals);
  writeFileSync(outputPath, spec, { mode: 0o600 });
  process.stdout.write(
    `STOCKWISE_RECONCILE_SPEC:organizations=${approvals.length} digest=${specDigest(spec)}\n`,
  );
} catch (error: unknown) {
  process.stderr.write(
    `STOCKWISE_REFUSED: ${error instanceof Error && /^SPEC_[A-Z_]+$/.test(error.message) ? error.message : "SPEC_FAILED"}\n`,
  );
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
