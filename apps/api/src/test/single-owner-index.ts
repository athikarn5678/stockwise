import { readFileSync } from "node:fs";

import type { PrismaClient } from "../generated/prisma/client.ts";

// Tests that model organizations as they were before ADR-041 reconciliation
// (two active OWNERs) must run without the migration's unique index, then put
// it back so later test files see the committed schema.
const MIGRATION_SQL = readFileSync(
  new URL(
    "../../prisma/migrations/20261030000000_single_active_owner/migration.sql",
    import.meta.url,
  ),
  "utf8",
);

export async function dropSingleOwnerIndex(
  prisma: PrismaClient,
): Promise<void> {
  await prisma.$executeRawUnsafe(
    `DROP INDEX IF EXISTS "organization_memberships_single_active_owner_key"`,
  );
}

export async function restoreSingleOwnerIndex(
  prisma: PrismaClient,
): Promise<void> {
  await dropSingleOwnerIndex(prisma);
  await prisma.$executeRawUnsafe(MIGRATION_SQL);
}
