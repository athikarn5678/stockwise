import type { Prisma, PrismaClient } from "../generated/prisma/client.ts";

/**
 * Test-only. Runs `work` in one transaction with `session_replication_role =
 * replica`, which disables every trigger (the Native authentication guards)
 * AND foreign-key enforcement for that transaction only (`SET LOCAL`). Use it
 * solely to seed or clean up a stored state the guards forbid creating
 * directly. Never use it in a test that asserts a write is refused, because
 * the refusal being asserted would be disabled. Requires a superuser test role
 * (the guarded local/CI `_test` databases). Must not be imported outside
 * `apps/api/src/test/` and `*.test.ts` files.
 */
export async function withTriggersDisabled<T>(
  prisma: Pick<PrismaClient, "$transaction">,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
    return work(tx);
  });
}

/**
 * Test-only: inside an interactive transaction, disable triggers and foreign
 * keys for the rest of that transaction. Same restrictions as
 * `withTriggersDisabled`.
 */
export async function disableTriggers(
  tx: Prisma.TransactionClient,
): Promise<void> {
  await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
}
