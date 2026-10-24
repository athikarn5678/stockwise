import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { PrismaClient } from "../../generated/prisma/client.ts";
import { assessBetterAuthTransition } from "./better-auth-transition-assessment.ts";
import { isTransferableLegacyPassword } from "./better-auth-transition-password.ts";

const MIGRATION_NAME = /^(\d{14})_[a-z0-9]+(?:_[a-z0-9]+)*$/;
const FENCE_TRIGGERS = [
  ["native_auth_transition", "native_auth_transition_guard"],
  ["native_auth_enrollments", "native_auth_enrollments_immutable"],
  ["native_auth_enrollments", "native_auth_enrollments_insert_guard"],
  ["users", "users_native_auth_fence"],
  ["sessions", "sessions_native_auth_fence"],
  ["password_reset_tokens", "password_reset_tokens_native_auth_fence"],
  [
    "email_verification_challenges",
    "email_verification_challenges_native_auth_fence",
  ],
  ["better_auth_accounts", "better_auth_accounts_native_auth_fence"],
  ["better_auth_sessions", "better_auth_sessions_native_auth_fence"],
  ["better_auth_verifications", "better_auth_verifications_native_auth_fence"],
  ["pending_registrations", "pending_registrations_native_auth_fence"],
] as const;

function refusal(): Error {
  return new Error("Native cutover readiness check refused.");
}

function migrationDirectory(): string {
  // src/modules/identity and dist/modules/identity share this relative layout.
  return join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../prisma/migrations",
  );
}

async function shippedMigrations(): Promise<
  { name: string; checksum: string }[]
> {
  try {
    const root = migrationDirectory();
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw refusal();
    const members = await readdir(root, { withFileTypes: true });
    const lock = members.find(
      (member) => member.name === "migration_lock.toml",
    );
    if (!lock?.isFile() || lock.isSymbolicLink()) throw refusal();
    if ((await readFile(join(root, lock.name))).length === 0) throw refusal();
    const entries: { name: string; checksum: string }[] = [];
    const timestamps = new Set<string>();
    for (const member of members) {
      if (member.name === "migration_lock.toml") continue;
      const match = MIGRATION_NAME.exec(member.name);
      if (!member.isDirectory() || member.isSymbolicLink() || !match?.[1])
        throw refusal();
      if (timestamps.has(match[1])) throw refusal();
      timestamps.add(match[1]);
      const dir = join(root, member.name);
      const contents = await readdir(dir, { withFileTypes: true });
      if (
        contents.length !== 1 ||
        contents[0]?.name !== "migration.sql" ||
        !contents[0].isFile() ||
        contents[0].isSymbolicLink()
      )
        throw refusal();
      const sqlPath = join(dir, "migration.sql");
      const stat = await lstat(sqlPath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw refusal();
      const bytes = await readFile(sqlPath);
      if (bytes.length === 0) throw refusal();
      entries.push({
        name: member.name,
        checksum: createHash("sha256").update(bytes).digest("hex"),
      });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    if (entries.length === 0) throw refusal();
    return entries;
  } catch {
    throw refusal();
  }
}

function validBaseline(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  const tables = new Set<string>();
  return value.every((item: unknown) => {
    if (typeof item !== "object" || item === null) return false;
    const row = item as Record<string, unknown>;
    if (
      typeof row.table !== "string" ||
      row.table.length === 0 ||
      tables.has(row.table) ||
      typeof row.count !== "string" ||
      !/^\d+$/.test(row.count) ||
      typeof row.digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(row.digest)
    )
      return false;
    tables.add(row.table);
    return true;
  });
}

/** Read-only, consistent-snapshot source readiness check; not deployment approval. */
export async function assertNativeCutoverReady(
  prisma: PrismaClient,
): Promise<void> {
  const migrations = await shippedMigrations();
  try {
    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        const ledger = await tx.$queryRaw<
          {
            migration_name: string;
            checksum: string;
            finished_at: Date | null;
            rolled_back_at: Date | null;
          }[]
        >`SELECT migration_name, checksum, finished_at, rolled_back_at FROM public._prisma_migrations ORDER BY migration_name`;
        if (
          ledger.length !== migrations.length ||
          ledger.some((entry, index) => {
            const expected = migrations[index];
            return (
              !expected ||
              entry.migration_name !== expected.name ||
              entry.checksum !== expected.checksum ||
              entry.finished_at === null ||
              entry.rolled_back_at !== null
            );
          })
        )
          throw refusal();

        const fence = await tx.$queryRaw<
          {
            id: boolean;
            state: string;
            run_id: string | null;
            quiesced_at: Date | null;
            sealed_at: Date | null;
            baseline: unknown;
          }[]
        >`SELECT id, state, run_id, quiesced_at, sealed_at, baseline FROM public.native_auth_transition`;
        const gate = fence[0];
        if (
          fence.length !== 1 ||
          gate?.id !== true ||
          gate.state !== "NATIVE" ||
          gate.run_id === null ||
          gate.quiesced_at === null ||
          gate.sealed_at === null ||
          gate.quiesced_at > gate.sealed_at ||
          !validBaseline(gate.baseline)
        )
          throw refusal();

        const triggers = await tx.$queryRaw<
          { table_name: string; trigger_name: string; enabled: string }[]
        >`SELECT c.relname AS table_name, t.tgname AS trigger_name, t.tgenabled::text AS enabled
          FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND NOT t.tgisinternal`;
        for (const [table, trigger] of FENCE_TRIGGERS) {
          if (
            triggers.filter(
              (row) =>
                row.table_name === table &&
                row.trigger_name === trigger &&
                row.enabled === "O",
            ).length !== 1
          )
            throw refusal();
        }

        const liveAuthority = await tx.$queryRaw<{ count: bigint }[]>`
          SELECT (
            (SELECT count(*) FROM public.sessions WHERE revoked_at IS NULL) +
            (SELECT count(*) FROM public.password_reset_tokens
              WHERE NOT requires_native_delivery_confirmation AND consumed_at IS NULL AND revoked_at IS NULL AND replaced_at IS NULL) +
            (SELECT count(*) FROM public.email_verification_challenges
              WHERE is_legacy AND consumed_at IS NULL AND revoked_at IS NULL AND replaced_at IS NULL)
          )::bigint AS count`;
        if (liveAuthority[0]?.count !== 0n) throw refusal();

        const users = await tx.user.findMany({
          include: {
            betterAuthAccounts: true,
            nativeAuthEnrollment: true,
            memberships: { select: { organizationId: true } },
          },
          orderBy: { id: "asc" },
        });
        const accountIdMatches = await tx.betterAuthAccount.findMany({
          where: { accountId: { in: users.map((user) => user.id) } },
          select: { userId: true, accountId: true },
        });
        if (
          accountIdMatches.some(
            (account) => account.accountId !== account.userId,
          )
        )
          throw refusal();

        const onboardings = await tx.firstOrganizationOnboarding.findMany({
          select: { userId: true },
        });
        const onboardedUserIds = new Set(onboardings.map((row) => row.userId));
        const nowRows = await tx.$queryRaw<
          { now: Date }[]
        >`SELECT transaction_timestamp() AS now`;
        const now = nowRows[0]?.now;
        if (!now || gate.sealed_at > now) throw refusal();
        for (const user of users) {
          const accounts = user.betterAuthAccounts;
          const enrollment = user.nativeAuthEnrollment;
          const markedAt = user.nativeRegistrationCompletedAt;
          const nativePassword = accounts[0]?.password;
          if (accounts.length > 0 || markedAt !== null || enrollment !== null) {
            if (
              accounts.length !== 1 ||
              markedAt === null ||
              markedAt > now ||
              user.passwordChangedAt > now ||
              user.emailVerified !== (user.emailVerifiedAt !== null) ||
              accounts[0]?.userId !== user.id ||
              accounts[0]?.providerId !== "credential" ||
              accounts[0]?.accountId !== user.id ||
              nativePassword === null ||
              nativePassword === undefined ||
              !isTransferableLegacyPassword(nativePassword) ||
              user.credentialVersion < 1n ||
              (enrollment !== null &&
                (enrollment.userId !== user.id ||
                  enrollment.accountId !== accounts[0].id ||
                  enrollment.runId !== gate.run_id ||
                  enrollment.sourceCredentialVersion < 1n ||
                  enrollment.sourceCredentialVersion > user.credentialVersion ||
                  enrollment.sourcePasswordChangedAt > user.passwordChangedAt ||
                  enrollment.enrolledAt > gate.sealed_at ||
                  enrollment.sourcePasswordChangedAt > gate.quiesced_at ||
                  (enrollment.sourceCredentialVersion ===
                    user.credentialVersion &&
                    enrollment.sourcePasswordChangedAt.getTime() !==
                      user.passwordChangedAt.getTime()) ||
                  (enrollment.sourceCredentialVersion ===
                    user.credentialVersion &&
                    nativePassword !== user.passwordHash) ||
                  !/^[a-f0-9]{64}$/.test(enrollment.sourceDigest))) ||
              (enrollment === null && markedAt < gate.sealed_at)
            )
              throw refusal();
            continue;
          }

          const assessment = assessBetterAuthTransition(
            {
              userId: user.id,
              status: user.status,
              disabledAt: user.disabledAt,
              emailVerifiedAt: user.emailVerifiedAt,
              emailVerified: user.emailVerified,
              nativeRegistrationCompletedAt: markedAt,
              passwordChangedAt: user.passwordChangedAt,
              credentialVersion: user.credentialVersion,
              legacyPassword: isTransferableLegacyPassword(user.passwordHash)
                ? "PRESENT"
                : "ABSENT",
              accounts: [],
            },
            now,
          );
          const completed =
            user.displayName !== null &&
            user.displayName.trim() !== "" &&
            (user.memberships.length > 0 || onboardedUserIds.has(user.id));
          if (
            assessment.issues.some((issue) =>
              [
                "INVALID_TIME",
                "INVALID_CREDENTIAL_VERSION",
                "VERIFICATION_MISMATCH",
              ].includes(issue),
            ) ||
            (completed &&
              user.status === "ACTIVE" &&
              user.disabledAt === null &&
              user.emailVerified &&
              user.emailVerifiedAt !== null)
          )
            throw refusal();
        }

        // Older-generation, disabled-user and provisional rows confer no
        // authority through the Bridge. A future generation signals stale
        // restored credentials and requires forward recovery instead.
        const invalidSessions = await tx.$queryRaw<{ count: bigint }[]>`
          SELECT count(*)::bigint AS count FROM public.better_auth_sessions s
          LEFT JOIN public.users u ON u.id = s.user_id
          WHERE s.expires_at > transaction_timestamp()
            AND s.stockwise_purpose = 'APPLICATION'
            AND (u.id IS NULL OR s.stockwise_credential_version > u.credential_version)`;
        if (invalidSessions[0]?.count !== 0n) throw refusal();
      },
      { isolationLevel: "RepeatableRead" },
    );
  } catch {
    throw refusal();
  }
}
