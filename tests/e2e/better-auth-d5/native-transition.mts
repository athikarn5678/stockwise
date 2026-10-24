import { createHash, randomUUID } from "node:crypto";
import {
  Prisma,
  type BetterAuthAccount,
} from "../../../apps/api/src/generated/prisma/client.ts";
import { isTransferableLegacyPassword } from "../../../apps/api/src/modules/identity/better-auth-transition-password.ts";
import { assessBetterAuthTransition } from "../../../apps/api/src/modules/identity/better-auth-transition-assessment.ts";
import { verifyLocalPostgresReceipt } from "./local-runner.mts";

type Transaction = Prisma.TransactionClient;
interface TransitionClient {
  $transaction<T>(
    operation: (transaction: Transaction) => Promise<T>,
    options?: {
      isolationLevel?: Prisma.TransactionIsolationLevel;
      maxWait?: number;
      timeout?: number;
    },
  ): Promise<T>;
}
type Mode = "LEGACY" | "QUIESCED" | "NATIVE";
type Gate = { state: Mode; run_id: string | null; baseline: Baseline | null };
type Baseline = { table: string; count: string; digest: string }[];
export type TransitionExpectedState = {
  credentialVersion: bigint;
  passwordChangedAt: Date;
  updatedAt: Date;
};
type Result = {
  outcome: "TRANSITIONED" | "REPLAY" | "INELIGIBLE" | "CONFLICT";
  reason: string;
};
const excludedTables = new Set([
  "_prisma_migrations",
  "sessions",
  "password_reset_tokens",
  "email_verification_challenges",
  "better_auth_accounts",
  "better_auth_sessions",
  "better_auth_verifications",
  "pending_registrations",
  "pending_registration_quotas",
  "pending_registration_credential_attempts",
  "native_password_reset_quotas",
  "native_auth_transition",
  "native_auth_enrollments",
]);
function identifier(value: string) {
  if (!/^[a-z_]+$/.test(value))
    throw new Error("TRANSITION_SCHEMA_UNSUPPORTED");
  return Prisma.raw(`"public"."${value}"`);
}
async function tables(tx: Transaction) {
  return tx.$queryRaw<
    { tablename: string }[]
  >`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`;
}
async function baseline(tx: Transaction): Promise<Baseline> {
  const result: Baseline = [];
  for (const { tablename } of await tables(tx)) {
    if (excludedTables.has(tablename)) continue;
    // Bind every business row, not merely user FK counts. Never return row data.
    const projection =
      tablename === "users"
        ? Prisma.sql`to_jsonb(t) - ARRAY['password_hash','better_auth_email_verified','native_registration_completed_at','credential_version','password_changed_at','updated_at']::text[]`
        : Prisma.sql`to_jsonb(t)`;
    const rows = await tx.$queryRaw<
      { count: string; digest: string }[]
    >(Prisma.sql`
      SELECT count(*)::text AS count,
        encode(sha256(convert_to(COALESCE(jsonb_agg(row_value ORDER BY row_value::text)::text, '[]'), 'UTF8')), 'hex') AS digest
      FROM (SELECT ${projection} AS row_value FROM ${identifier(tablename)} t) snapshot`);
    const row = rows[0];
    if (!row) throw new Error("TRANSITION_RECONCILIATION_FAILED");
    result.push({ table: tablename, ...row });
  }
  return result;
}
async function gate(tx: Transaction, lock = false): Promise<Gate> {
  const rows = await tx.$queryRaw<Gate[]>(Prisma.sql`
    SELECT state, run_id, baseline FROM native_auth_transition WHERE id = true ${lock ? Prisma.sql`FOR SHARE` : Prisma.empty}`);
  if (!rows[0]) throw new Error("TRANSITION_FENCE_MISSING");
  return rows[0];
}
interface UserState {
  user: Prisma.UserGetPayload<{
    include: { memberships: { select: { organizationId: true } } };
  }>;
  accounts: BetterAuthAccount[];
  completed: boolean;
}
async function userState(
  tx: Transaction,
  userId: string,
): Promise<UserState | null> {
  const user = await tx.user.findUnique({
    where: { id: userId },
    include: { memberships: { select: { organizationId: true } } },
  });
  if (!user) return null;
  const accounts = await tx.betterAuthAccount.findMany({
    where: { OR: [{ userId }, { accountId: userId }] },
    orderBy: { id: "asc" },
  });
  const onboarding = await tx.firstOrganizationOnboarding.count({
    where: { userId },
  });
  return {
    user,
    accounts,
    completed:
      user.displayName !== null &&
      user.displayName.trim() !== "" &&
      (user.memberships.length > 0 || onboarding > 0),
  };
}
function sourceDigest(state: UserState) {
  const { user, completed } = state;
  // Internal generation binding only. This digest is stored in provenance, never
  // included in summaries/errors/logs; the credential itself stays in its stores.
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: user.id,
        email: user.email,
        status: user.status,
        disabledAt: user.disabledAt,
        displayName: user.displayName,
        phone: user.phone,
        emailVerifiedAt: user.emailVerifiedAt,
        emailVerified: user.emailVerified,
        passwordHash: user.passwordHash,
        passwordChangedAt: user.passwordChangedAt,
        credentialVersion: user.credentialVersion.toString(),
        completed,
      }),
    )
    .digest("hex");
}
function eligibility(state: UserState, now: Date): string {
  const { user, accounts } = state;
  const assessment = assessBetterAuthTransition(
    {
      userId: user.id,
      status: user.status,
      disabledAt: user.disabledAt,
      emailVerifiedAt: user.emailVerifiedAt,
      emailVerified: user.emailVerified,
      nativeRegistrationCompletedAt: user.nativeRegistrationCompletedAt,
      passwordChangedAt: user.passwordChangedAt,
      credentialVersion: user.credentialVersion,
      legacyPassword: isTransferableLegacyPassword(user.passwordHash)
        ? "PRESENT"
        : "ABSENT",
      accounts: accounts.map((a) => ({
        userId: a.userId,
        accountId: a.accountId,
        providerId: a.providerId,
        passwordPresent: a.password !== null,
      })),
    },
    now,
  );
  const sourceIssue = assessment.issues.find((issue) =>
    [
      "INVALID_TIME",
      "INVALID_CREDENTIAL_VERSION",
      "DISABLED_USER",
      "UNVERIFIED_USER",
      "VERIFICATION_MISMATCH",
      "LEGACY_CREDENTIAL_UNAVAILABLE",
    ].includes(issue),
  );
  if (sourceIssue) return sourceIssue;
  if (!state.completed) return "INCOMPLETE_ONBOARDING";
  return "ELIGIBLE";
}
async function clock(tx: Transaction) {
  const rows = await tx.$queryRaw<
    { now: Date }[]
  >`SELECT clock_timestamp() AS now`;
  if (!rows[0]) throw new Error("TRANSITION_CLOCK_UNAVAILABLE");
  return rows[0].now;
}

/** Declassify database failures before they cross the tool's output boundary. */
function refuseWithRedactedCause(error: unknown): never {
  const reason =
    error instanceof Prisma.PrismaClientKnownRequestError &&
    /^P\d{4}$/.test(error.code)
      ? error.code
      : error instanceof Error && /^TRANSITION_[A-Z_]+$/.test(error.message)
        ? error.message
        : "DATABASE_FAILURE";
  // Original message/stack/metadata can contain bound credential parameters.
  throw new Error(`TRANSITION_OPERATION_REFUSED:${reason}`, {
    cause: new Error(reason),
  });
}

/**
 * Non-public rehearsal tool. No production override, environment switch, HTTP
 * handler or startup callsite exists. A future production operator is separate.
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
  const prisma = input.prisma;
  async function assertTarget(tx: Transaction) {
    const rows = await tx.$queryRaw<{ name: string; marker: string | null }[]>`
      SELECT current_database() AS name, shobj_description(oid, 'pg_database') AS marker
      FROM pg_database WHERE datname = current_database()`;
    if (
      rows[0]?.name !== receipt.testDatabase ||
      rows[0]?.marker !== `stockwise-local:${receipt.marker}`
    ) {
      throw new Error("TRANSITION_DISPOSABLE_TARGET_MISMATCH");
    }
  }
  async function execute<T>(
    operation: (tx: Transaction) => Promise<T>,
    consistent = false,
  ): Promise<T> {
    return prisma
      .$transaction(
        async (tx) => {
          await assertTarget(tx);
          await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
          return operation(tx);
        },
        {
          isolationLevel: consistent ? "RepeatableRead" : "ReadCommitted",
          maxWait: 10_000,
          timeout: 30_000,
        },
      )
      .catch(refuseWithRedactedCause);
  }
  await execute(async () => undefined);

  async function reconciliation(tx: Transaction) {
    const currentGate = await gate(tx, true);
    if (currentGate.run_id !== receipt.runId || !currentGate.baseline)
      throw new Error("TRANSITION_RUN_MISMATCH");
    const actual = await baseline(tx);
    const identityPreserved =
      actual.length === currentGate.baseline.length &&
      actual.every((row, index) => {
        const expected = currentGate.baseline?.[index];
        return (
          expected?.table === row.table &&
          expected.count === row.count &&
          expected.digest === row.digest
        );
      });
    const active = await tx.$queryRaw<{ count: string }[]>`
      SELECT ((SELECT count(*) FROM sessions WHERE revoked_at IS NULL) +
        (SELECT count(*) FROM password_reset_tokens WHERE NOT requires_native_delivery_confirmation AND consumed_at IS NULL AND revoked_at IS NULL AND replaced_at IS NULL) +
        (SELECT count(*) FROM email_verification_challenges WHERE consumed_at IS NULL AND revoked_at IS NULL AND replaced_at IS NULL))::text AS count`;
    const rows = await tx.$queryRaw<
      { count: string }[]
    >`SELECT count(*)::text AS count FROM native_auth_enrollments`;
    let remainingEligible = 0;
    const now = await clock(tx);
    for (const { id } of await tx.user.findMany({ select: { id: true } })) {
      const state = await userState(tx, id);
      if (
        state &&
        state.accounts.length === 0 &&
        state.user.nativeRegistrationCompletedAt === null &&
        eligibility(state, now) === "ELIGIBLE"
      )
        remainingEligible++;
    }
    return {
      mode: currentGate.state,
      identityPreserved,
      tablesChecked: actual.length,
      legacyAuthorityRemaining: Number(active[0]?.count ?? -1),
      enrolled: Number(rows[0]?.count ?? -1),
      remainingEligible,
    };
  }
  return {
    async preflight() {
      return execute(async (tx) => {
        const currentGate = await gate(tx);
        const now = await clock(tx);
        const ids = await tx.user.findMany({
          select: { id: true },
          orderBy: { id: "asc" },
        });
        const users = [];
        for (const { id } of ids) {
          const state = await userState(tx, id);
          if (!state) throw new Error("TRANSITION_SNAPSHOT_CHANGED");
          const sourceReason = eligibility(state, now);
          const destination =
            state.accounts.length > 0 ||
            state.user.nativeRegistrationCompletedAt !== null;
          const reason =
            sourceReason === "ELIGIBLE" && destination
              ? "EXISTING_DESTINATION"
              : sourceReason;
          users.push({
            userId: id,
            credentialVersion: state.user.credentialVersion,
            passwordChangedAt: state.user.passwordChangedAt,
            updatedAt: state.user.updatedAt,
            eligible: reason === "ELIGIBLE",
            reason,
          });
        }
        return { mode: currentGate.state, users };
      }, true);
    },
    async quiesce() {
      return execute(async (tx) => {
        // ACCESS EXCLUSIVE drains old readers and writers. Lock all public tables
        // in stable order so the business baseline is one consistent boundary.
        const all = await tables(tx);
        await tx.$executeRaw(
          Prisma.sql`LOCK TABLE ${Prisma.join(all.filter((t) => t.tablename !== "_prisma_migrations").map((t) => identifier(t.tablename)))} IN ACCESS EXCLUSIVE MODE`,
        );
        const currentGate = await gate(tx);
        if (currentGate.state !== "LEGACY") {
          if (currentGate.run_id !== receipt.runId)
            throw new Error("TRANSITION_RUN_MISMATCH");
          return { mode: currentGate.state };
        }
        const snapshot = await baseline(tx);
        await tx.$queryRaw`SELECT set_config('stockwise.transition_run', ${receipt.runId}, true)`;
        const now = await clock(tx);
        await tx.$executeRaw`UPDATE native_auth_transition SET state = 'QUIESCED', run_id = ${receipt.runId}::uuid, quiesced_at = ${now}, baseline = ${JSON.stringify(snapshot)}::jsonb WHERE id = true`;
        await tx.$executeRaw`UPDATE sessions SET revoked_at = GREATEST(${now}, issued_at), revocation_reason = 'native_cutover' WHERE revoked_at IS NULL`;
        await tx.$executeRaw`UPDATE password_reset_tokens SET revoked_at = GREATEST(${now}, issued_at) WHERE consumed_at IS NULL AND revoked_at IS NULL AND replaced_at IS NULL`;
        await tx.$executeRaw`UPDATE email_verification_challenges SET revoked_at = GREATEST(${now}, issued_at), revocation_reason = CASE WHEN is_legacy THEN 'LEGACY_CUTOVER'::verification_revocation_reason ELSE 'NATIVE_CUTOVER'::verification_revocation_reason END WHERE consumed_at IS NULL AND revoked_at IS NULL AND replaced_at IS NULL`;
        await tx.$executeRaw`UPDATE pending_registrations SET revoked_at = GREATEST(${now}, issued_at) WHERE consumed_at IS NULL AND revoked_at IS NULL`;
        await tx.betterAuthSession.deleteMany();
        await tx.betterAuthVerification.deleteMany();
        return { mode: "QUIESCED" as const };
      });
    },
    async reconcileVerification(
      userId: string,
      expected: TransitionExpectedState,
      authoritativeSource: "LEGACY_EMAIL_VERIFIED_AT",
    ) {
      return execute(async (tx) => {
        const currentGate = await gate(tx, true);
        if (
          currentGate.state !== "QUIESCED" ||
          currentGate.run_id !== receipt.runId ||
          authoritativeSource !== "LEGACY_EMAIL_VERIFIED_AT"
        )
          throw new Error("TRANSITION_RECONCILIATION_REFUSED");
        await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
        const state = await userState(tx, userId);
        if (
          !state ||
          state.accounts.length > 0 ||
          state.user.nativeRegistrationCompletedAt !== null
        )
          return { outcome: "CONFLICT" as const };
        if (
          state.user.credentialVersion !== expected.credentialVersion ||
          state.user.passwordChangedAt.getTime() !==
            expected.passwordChangedAt.getTime() ||
          state.user.updatedAt.getTime() !== expected.updatedAt.getTime()
        )
          return { outcome: "CONFLICT" as const };
        const now = await clock(tx);
        if (
          state.user.status !== "ACTIVE" ||
          state.user.disabledAt !== null ||
          (state.user.emailVerifiedAt !== null &&
            (!Number.isFinite(state.user.emailVerifiedAt.getTime()) ||
              state.user.emailVerifiedAt > now))
        )
          return { outcome: "INELIGIBLE" as const };
        const verified = state.user.emailVerifiedAt !== null;
        if (verified === state.user.emailVerified)
          return { outcome: "UNCHANGED" as const };
        await tx.$queryRaw`SELECT set_config('stockwise.transition_run', ${receipt.runId}, true)`;
        await tx.user.update({
          where: { id: userId },
          data: { emailVerified: verified },
        });
        return { outcome: "RECONCILED" as const };
      });
    },
    async transitionUser(
      userId: string,
      expected: TransitionExpectedState,
    ): Promise<Result> {
      return execute(async (tx) => {
        const currentGate = await gate(tx, true);
        if (
          currentGate.state === "LEGACY" ||
          currentGate.run_id !== receipt.runId
        )
          throw new Error("TRANSITION_NOT_QUIESCED");
        const before = await userState(tx, userId);
        await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM better_auth_accounts WHERE user_id = ${userId}::uuid OR account_id = ${userId} FOR UPDATE`;
        const state = await userState(tx, userId);
        if (!state || !before)
          return { outcome: "CONFLICT", reason: "USER_MISSING" };
        if (sourceDigest(before) !== sourceDigest(state))
          return { outcome: "CONFLICT", reason: "SOURCE_CHANGED" };
        const provenance = await tx.$queryRaw<
          {
            account_id: string;
            source_credential_version: bigint;
            source_password_changed_at: Date;
            source_digest: string;
            enrolled_at: Date;
          }[]
        >`
          SELECT account_id, source_credential_version, source_password_changed_at, source_digest, enrolled_at FROM native_auth_enrollments WHERE user_id = ${userId}::uuid AND run_id = ${receipt.runId}::uuid`;
        if (provenance[0]) {
          const prior = provenance[0];
          const account = state.accounts[0];
          const unchanged =
            state.accounts.length === 1 &&
            account?.id === prior.account_id &&
            account.userId === userId &&
            account.accountId === userId &&
            account.providerId === "credential" &&
            account.password === state.user.passwordHash &&
            state.user.credentialVersion === prior.source_credential_version &&
            state.user.passwordChangedAt.getTime() ===
              prior.source_password_changed_at.getTime() &&
            state.user.nativeRegistrationCompletedAt?.getTime() ===
              prior.enrolled_at.getTime() &&
            sourceDigest(state) === prior.source_digest &&
            expected.credentialVersion === prior.source_credential_version &&
            expected.passwordChangedAt.getTime() ===
              prior.source_password_changed_at.getTime();
          return unchanged
            ? { outcome: "REPLAY", reason: "EXACT_REPLAY" }
            : { outcome: "CONFLICT", reason: "ENROLLED_STATE_CHANGED" };
        }
        if (currentGate.state !== "QUIESCED")
          return { outcome: "CONFLICT", reason: "TRANSITION_SEALED" };
        if (
          state.accounts.length > 0 ||
          state.user.nativeRegistrationCompletedAt !== null
        )
          return { outcome: "CONFLICT", reason: "EXISTING_DESTINATION" };
        if (
          state.user.credentialVersion !== expected.credentialVersion ||
          state.user.passwordChangedAt.getTime() !==
            expected.passwordChangedAt.getTime() ||
          state.user.updatedAt.getTime() !== expected.updatedAt.getTime()
        )
          return { outcome: "CONFLICT", reason: "SOURCE_CHANGED" };
        const now = await clock(tx);
        const reason = eligibility(state, now);
        if (reason !== "ELIGIBLE") return { outcome: "INELIGIBLE", reason };
        await tx.$queryRaw`SELECT set_config('stockwise.transition_run', ${receipt.runId}, true)`;
        const accountId = randomUUID();
        await tx.betterAuthAccount.create({
          data: {
            id: accountId,
            userId,
            providerId: "credential",
            accountId: userId,
            password: state.user.passwordHash,
          },
        });
        await tx.$executeRaw`INSERT INTO native_auth_enrollments (user_id, run_id, account_id, source_credential_version, source_password_changed_at, source_digest, enrolled_at) VALUES (${userId}::uuid, ${receipt.runId}::uuid, ${accountId}::uuid, ${state.user.credentialVersion}, ${state.user.passwordChangedAt}, ${sourceDigest(state)}, ${now})`;
        await tx.user.update({
          where: { id: userId },
          data: { nativeRegistrationCompletedAt: now },
        });
        return { outcome: "TRANSITIONED", reason: "ENROLLED" };
      });
    },
    async reconcile() {
      return execute(reconciliation, true);
    },
    async seal() {
      return execute(async (tx) => {
        // Acquire the exclusive singleton lock before reconciliation so no new
        // transfer can cross the final check. Existing transfers finish first.
        await tx.$queryRaw`SELECT id FROM native_auth_transition WHERE id = true FOR UPDATE`;
        const report = await reconciliation(tx);
        if (
          !report.identityPreserved ||
          report.legacyAuthorityRemaining !== 0 ||
          report.remainingEligible !== 0
        )
          throw new Error("TRANSITION_RECONCILIATION_FAILED");
        if (report.mode === "NATIVE") return { mode: "NATIVE" as const };
        await tx.$queryRaw`SELECT set_config('stockwise.transition_run', ${receipt.runId}, true)`;
        await tx.$executeRaw`UPDATE native_auth_transition SET state = 'NATIVE', sealed_at = clock_timestamp() WHERE id = true AND state = 'QUIESCED'`;
        return { mode: "NATIVE" as const };
      });
    },
  };
}
