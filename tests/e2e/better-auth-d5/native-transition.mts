import {
  createNativeAuthTransition,
  type TransitionClient,
} from "../../../apps/api/src/modules/identity/native-auth-transition.ts";
import { verifyLocalPostgresReceipt } from "./local-runner.mts";

export type { TransitionExpectedState } from "../../../apps/api/src/modules/identity/native-auth-transition.ts";

/**
 * Non-public rehearsal tool. Authorization is the live local-runner receipt and
 * the receipt-bound database marker; the writer itself is the shared accepted
 * D5-P3 transition core. No HTTP handler or startup callsite exists.
 */
export async function createDisposableNativeTransition(input: {
  prisma: TransitionClient;
  databaseUrl: string;
  testDatabaseUrl: string;
  receipt: unknown;
}) {
  if (
    !verifyLocalPostgresReceipt(
      input.receipt,
      input.databaseUrl,
      input.testDatabaseUrl,
    )
  ) {
    throw new Error("TRANSITION_DISPOSABLE_AUTHORIZATION_REQUIRED");
  }
  const receipt = input.receipt;
  return createNativeAuthTransition({
    prisma: input.prisma,
    runId: receipt.runId,
    async assertTarget(tx) {
      const rows = await tx.$queryRaw<
        { name: string; marker: string | null }[]
      >`
        SELECT current_database() AS name, shobj_description(oid, 'pg_database') AS marker
        FROM pg_database WHERE datname = current_database()`;
      if (
        rows[0]?.name !== receipt.testDatabase ||
        rows[0]?.marker !== `stockwise-local:${receipt.marker}`
      ) {
        throw new Error("TRANSITION_DISPOSABLE_TARGET_MISMATCH");
      }
    },
  });
}
