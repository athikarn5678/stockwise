import { createHash, randomUUID } from "node:crypto";

import {
  Prisma,
  type PrismaClient,
  type PendingRegistration,
} from "../../generated/prisma/client.ts";
import type {
  PendingCredentialSnapshot,
  PendingRegistrationRepository,
} from "./pending-registration-contract.ts";
import type {
  VerificationChallengeMaterial,
  VerificationSecurity,
} from "./verification-security.ts";

const WINDOW = 900_000;
const CREDENTIAL_LEASE = 60_000;
const LIMITS = { registration: 5, delivery: 3, credential: 5 } as const;
const HASH = /^\$argon2id\$v=19\$m=65536,(?:t=3,p=4|p=4,t=3)\$/;

type Client = Pick<PrismaClient, "$transaction">;
async function clock(tx: Prisma.TransactionClient): Promise<Date> {
  const rows = await tx.$queryRaw<
    Array<{ now: Date }>
  >`SELECT clock_timestamp() AS now`;
  const now = rows[0]?.now;
  if (!now) throw new Error("Pending registration clock unavailable.");
  return now;
}
async function lockEmail(tx: Prisma.TransactionClient, email: string) {
  // Shared across D3 workers. Legacy inserts remain protected by users.email uniqueness.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${email}, 3636))`;
  await tx.$queryRaw`SELECT id FROM pending_registrations WHERE email = ${email} FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM users WHERE email = ${email} FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM better_auth_accounts WHERE provider_id = 'credential'
    AND user_id = (SELECT id FROM users WHERE email = ${email}) FOR UPDATE`;
}
async function existingUser(tx: Prisma.TransactionClient, email: string) {
  return tx.user.findUnique({ where: { email }, select: { id: true } });
}
function challengeData(material: VerificationChallengeMaterial) {
  return {
    challengeId: material.challenge.id,
    otpMac: material.challenge.otpMac,
    otpKeyId: material.challenge.otpKeyId,
    linkTokenHash: material.challenge.linkTokenHash,
    failedOtpAttempts: 0,
    revokedAt: null,
  };
}
async function pendingPasswordEligible(
  tx: Prisma.TransactionClient,
  row: PendingRegistration,
  now: Date,
) {
  return (
    row.passwordHash !== null &&
    row.consumedAt === null &&
    row.expiresAt > now &&
    (await existingUser(tx, row.email)) === null
  );
}

async function nativeCredential(tx: Prisma.TransactionClient, email: string) {
  const user = await tx.user.findUnique({
    where: { email },
    select: {
      id: true,
      status: true,
      disabledAt: true,
      emailVerified: true,
      emailVerifiedAt: true,
      nativeRegistrationCompletedAt: true,
      credentialVersion: true,
      passwordChangedAt: true,
    },
  });
  if (!user) return null;
  const account = await tx.betterAuthAccount.findUnique({
    where: {
      providerId_accountId: { providerId: "credential", accountId: user.id },
    },
    select: { userId: true, password: true },
  });
  return account !== null &&
    account.userId === user.id &&
    account.password !== null &&
    HASH.test(account.password)
    ? {
        kind: "verified" as const,
        id: user.id,
        credentialVersion: user.credentialVersion,
        passwordHash: account.password,
        nativeRegistrationCompletedAt: user.nativeRegistrationCompletedAt,
        passwordChangedAt: user.passwordChangedAt,
        eligible:
          user.status === "ACTIVE" &&
          user.disabledAt === null &&
          user.emailVerified &&
          user.emailVerifiedAt !== null &&
          user.nativeRegistrationCompletedAt !== null,
      }
    : null;
}
async function eligible(
  tx: Prisma.TransactionClient,
  row: PendingRegistration,
  now: Date,
) {
  return (
    row.passwordHash !== null &&
    row.challengeId !== null &&
    row.consumedAt === null &&
    row.revokedAt === null &&
    row.expiresAt > now &&
    (await existingUser(tx, row.email)) === null
  );
}

/** Separately composed only. Never installed in authentication-runtime or main. */
export function createPendingRegistrationRepository(
  prisma: Client,
): PendingRegistrationRepository {
  async function locked<T>(
    email: string,
    action: (
      tx: Prisma.TransactionClient,
      row: PendingRegistration | null,
      now: Date,
    ) => Promise<T>,
  ) {
    return prisma.$transaction(async (tx) => {
      await lockEmail(tx, email);
      const row = await tx.pendingRegistration.findUnique({ where: { email } });
      return action(tx, row, await clock(tx));
    });
  }
  async function complete(input: {
    email?: string;
    challengeId?: string;
    code?: string;
    linkTokenHash?: string;
    cookieHeader: string | undefined;
    security: VerificationSecurity;
  }) {
    return prisma.$transaction(async (tx) => {
      const candidate =
        input.email === undefined
          ? await tx.pendingRegistration.findUnique({
              where: { linkTokenHash: input.linkTokenHash ?? "" },
            })
          : await tx.pendingRegistration.findUnique({
              where: { email: input.email },
            });
      if (!candidate) return "invalid" as const;
      await lockEmail(tx, candidate.email);
      const row = await tx.pendingRegistration.findUnique({
        where: { email: candidate.email },
      });
      const now = await clock(tx);
      if (
        !row ||
        row.expiresAt <= now ||
        row.revokedAt !== null ||
        (input.linkTokenHash !== undefined
          ? row.linkTokenHash !== input.linkTokenHash
          : row.challengeId !== input.challengeId)
      )
        return "invalid" as const;
      if (row.consumedAt !== null) {
        if (input.linkTokenHash === undefined || row.userId === null)
          return "invalid" as const;
        const user = await tx.user.findUnique({ where: { id: row.userId } });
        const account = await tx.betterAuthAccount.findUnique({
          where: {
            providerId_accountId: {
              providerId: "credential",
              accountId: row.userId,
            },
          },
        });
        return user?.status === "ACTIVE" &&
          user.emailVerifiedAt !== null &&
          user.emailVerified &&
          user.nativeRegistrationCompletedAt !== null &&
          user.credentialVersion === row.credentialVersion &&
          account?.userId === row.userId &&
          account.password !== null
          ? ("already_verified" as const)
          : ("invalid" as const);
      }
      if (!(await eligible(tx, row, now))) return "invalid" as const;
      if (input.code !== undefined) {
        if (
          row.failedOtpAttempts >= 5 ||
          row.challengeId === null ||
          row.otpMac === null ||
          row.otpKeyId === null
        )
          return "invalid" as const;
        if (
          !input.security.matchesOtp(
            {
              userId: row.id,
              id: row.challengeId,
              credentialVersion: row.credentialVersion,
              otpKeyId: row.otpKeyId,
              otpMac: row.otpMac,
            },
            input.code,
          )
        ) {
          await tx.pendingRegistration.update({
            where: { id: row.id },
            data: { failedOtpAttempts: { increment: 1 } },
          });
          return "invalid" as const;
        }
      }
      const proof = input.security.readProof(input.cookieHeader, now);
      if (
        !proof?.usable ||
        proof.subject !== row.id ||
        proof.credentialVersion !== row.credentialVersion
      )
        return "proof_required" as const;
      // New identity only. A concurrent legacy registration can win users.email;
      // ON CONFLICT must not turn that account into a native enrollment.
      const users = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        INSERT INTO users (id, email, email_verified_at, better_auth_email_verified,
          native_registration_completed_at, credential_version, updated_at)
        VALUES (${row.id}::uuid, ${row.email}, ${now}, TRUE, ${now}, ${row.credentialVersion}, ${now})
        ON CONFLICT (email) DO NOTHING RETURNING id`);
      const userId = users[0]?.id;
      if (!userId) return "invalid" as const;
      // Better Auth 1.7.7 sign-in verifies account.password directly with the
      // configured Argon2id verifier. setPassword would hash this hash again.
      await tx.betterAuthAccount.create({
        data: {
          providerId: "credential",
          accountId: userId,
          userId,
          password: row.passwordHash,
        },
      });
      await tx.pendingRegistration.update({
        where: { id: row.id },
        data: { passwordHash: null, consumedAt: now, userId },
      });
      return "verified" as const;
    });
  }
  return {
    async admit(email, purpose) {
      const key = createHash("sha256").update(email).digest("hex");
      return prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key + purpose}, 3637))`;
        const now = await clock(tx);
        const prior = await tx.pendingRegistrationQuota.findUnique({
          where: { key_purpose: { key, purpose } },
        });
        const active =
          prior !== null && prior.windowAt.getTime() + WINDOW > now.getTime();
        const count = active ? prior.count : 0;
        const windowAt = active ? prior.windowAt : now;
        const allowed = count < LIMITS[purpose];
        if (allowed) {
          await tx.pendingRegistrationQuota.upsert({
            where: { key_purpose: { key, purpose } },
            create: { key, purpose, windowAt, count: count + 1 },
            update: { windowAt, count: count + 1 },
          });
        }
        return {
          allowed,
          retryAfterSeconds: allowed
            ? 0
            : Math.max(
                1,
                Math.ceil((windowAt.getTime() + WINDOW - now.getTime()) / 1000),
              ),
        };
      });
    },
    async reserveCredential(email) {
      const key = createHash("sha256").update(email).digest("hex");
      const purpose = "credential";
      return prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key + purpose}, 3637))`;
        const now = await clock(tx);
        const prior = await tx.pendingRegistrationQuota.findUnique({
          where: { key_purpose: { key, purpose } },
        });
        const active =
          prior !== null && prior.windowAt.getTime() + WINDOW > now.getTime();
        const count = active ? prior.count : 0;
        const windowAt = active ? prior.windowAt : now;
        // An expired worker may already have compared a wrong password. Never
        // refund unknown outcomes within their fixed window; that reopens quota.
        await tx.pendingRegistrationCredentialAttempt.deleteMany({
          where: { key, ...(active ? { expiresAt: { lte: now } } : {}) },
        });
        if (count >= LIMITS.credential)
          return {
            allowed: false as const,
            retryAfterSeconds: Math.max(
              1,
              Math.ceil((windowAt.getTime() + WINDOW - now.getTime()) / 1000),
            ),
          };
        await tx.pendingRegistrationQuota.upsert({
          where: { key_purpose: { key, purpose } },
          create: { key, purpose, windowAt, count: count + 1 },
          update: { windowAt, count: count + 1 },
        });
        const attempt = await tx.pendingRegistrationCredentialAttempt.create({
          data: {
            key,
            purpose,
            windowAt,
            expiresAt: new Date(
              Math.min(
                now.getTime() + CREDENTIAL_LEASE,
                windowAt.getTime() + WINDOW,
              ),
            ),
          },
        });
        return {
          allowed: true as const,
          attemptId: attempt.id,
          retryAfterSeconds: 0 as const,
        };
      });
    },
    async register({ email, passwordHash, security, suppressed = false }) {
      if (!HASH.test(passwordHash))
        throw new Error(
          "Pending registration requires the accepted Argon2id verifier.",
        );
      return locked(email, async (tx, row, now) => {
        if (await existingUser(tx, email)) return null;
        // Suppressed delivery may stage the first generation only. It cannot
        // replace an existing password, version, challenge, or expiry.
        if (suppressed && row !== null) return null;
        // A successful registration is terminal, including a response lost after commit.
        if (row?.consumedAt !== null && row?.consumedAt !== undefined)
          return null;
        if (row?.credentialVersion === 9223372036854775807n) return null;
        const id = row?.id ?? randomUUID();
        const version = row ? row.credentialVersion + 1n : 1n;
        const prepared = security.prepare(id, version, now);
        const data = {
          passwordHash,
          credentialVersion: version,
          issuedAt: now,
          expiresAt: prepared.challenge.expiresAt,
          ...challengeData(prepared),
          revokedAt: suppressed ? now : null,
          consumedAt: null,
          userId: null,
        };
        await tx.pendingRegistration.upsert({
          where: { email },
          create: { id, email, ...data },
          update: data,
        });
        return prepared;
      });
    },
    async resend(email, security) {
      return locked(email, async (tx, row, now) => {
        // Provider failure revokes only delivery material; resend can recover the
        // same pending password, without renewing its absolute lifetime or proof.
        if (
          !row ||
          row.passwordHash === null ||
          row.consumedAt !== null ||
          row.expiresAt <= now ||
          (await existingUser(tx, email))
        )
          return null;
        const material = security.prepareChallenge(
          row.id,
          row.credentialVersion,
          now,
        );
        material.challenge.expiresAt = row.expiresAt;
        await tx.pendingRegistration.update({
          where: { id: row.id },
          data: challengeData(material),
        });
        return material;
      });
    },
    async credentialSnapshot(email) {
      return locked(email, async (tx, row, now) => {
        if (
          row &&
          row.passwordHash !== null &&
          (await pendingPasswordEligible(tx, row, now))
        )
          return {
            kind: "pending" as const,
            id: row.id,
            credentialVersion: row.credentialVersion,
            passwordHash: row.passwordHash,
          };
        return nativeCredential(tx, email);
      });
    },
    async finishCredential(
      email,
      attemptId,
      snapshot: PendingCredentialSnapshot | null,
      security,
    ) {
      const key = createHash("sha256").update(email).digest("hex");
      const purpose = "credential";
      return prisma.$transaction(async (tx) => {
        // Every admission/finalization uses quota -> email lock order. Argon2
        // has finished before entering this transaction.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key + purpose}, 3637))`;
        const attempt =
          await tx.pendingRegistrationCredentialAttempt.findUnique({
            where: { id: attemptId },
          });
        const quota = await tx.pendingRegistrationQuota.findUnique({
          where: { key_purpose: { key, purpose } },
        });
        if (!attempt || attempt.key !== key || !quota) return null;
        await tx.pendingRegistrationCredentialAttempt.delete({
          where: { id: attemptId },
        });
        const now = await clock(tx);
        if (
          attempt.windowAt.getTime() !== quota.windowAt.getTime() ||
          attempt.expiresAt <= now ||
          quota.windowAt.getTime() + WINDOW <= now.getTime() ||
          quota.count < 1 ||
          quota.count > LIMITS.credential ||
          snapshot === null
        )
          return null;
        await lockEmail(tx, email);
        const row = await tx.pendingRegistration.findUnique({
          where: { email },
        });
        const proofTime = await clock(tx);
        // Recheck the lease/window after acquiring the email lock. An expired
        // successful comparison cannot refund an unknown slot or issue proof.
        if (
          attempt.expiresAt <= proofTime ||
          quota.windowAt.getTime() + WINDOW <= proofTime.getTime()
        )
          return null;
        let stale: boolean;
        if (snapshot.kind === "pending") {
          stale =
            !row ||
            row.id !== snapshot.id ||
            row.credentialVersion !== snapshot.credentialVersion ||
            row.passwordHash !== snapshot.passwordHash ||
            !(await pendingPasswordEligible(tx, row, proofTime));
        } else {
          const current = await nativeCredential(tx, email);
          stale =
            !current ||
            !snapshot.eligible ||
            current.id !== snapshot.id ||
            current.credentialVersion !== snapshot.credentialVersion ||
            current.passwordHash !== snapshot.passwordHash ||
            current.passwordChangedAt.getTime() !==
              snapshot.passwordChangedAt.getTime() ||
            current.nativeRegistrationCompletedAt?.getTime() !==
              snapshot.nativeRegistrationCompletedAt?.getTime() ||
            current.nativeRegistrationCompletedAt === null ||
            current.nativeRegistrationCompletedAt > proofTime ||
            current.passwordChangedAt > proofTime ||
            !current.eligible;
        }
        if (stale) {
          // Preserve durable pending admission: a changed or mismatched
          // generation cannot refund its reserved slot.
          if (snapshot.kind === "pending") return null;
          await tx.pendingRegistrationQuota.update({
            where: { key_purpose: { key, purpose } },
            data: { count: { decrement: 1 } },
          });
          return { ineligible: true as const };
        }
        await tx.pendingRegistrationQuota.update({
          where: { key_purpose: { key, purpose } },
          data: { count: { decrement: 1 } },
        });
        const result =
          snapshot.kind === "pending"
            ? security.prove(snapshot.id, snapshot.credentialVersion, proofTime)
            : security.phantom(proofTime);
        return {
          proof: result.proof,
          expiresAt:
            snapshot.kind === "pending" ? row!.expiresAt : result.expiresAt,
        };
      });
    },
    completeCode: complete,
    completeLink: complete,
    async canDeliver(challengeId) {
      return prisma.$transaction(async (tx) => {
        const row = await tx.pendingRegistration.findUnique({
          where: { challengeId },
        });
        if (!row) return false;
        await lockEmail(tx, row.email);
        const current = await tx.pendingRegistration.findUnique({
          where: { challengeId },
        });
        return (
          current !== null && (await eligible(tx, current, await clock(tx)))
        );
      });
    },
    async revokeDelivery({ challengeId }) {
      await prisma.$transaction(async (tx) => {
        const row = await tx.pendingRegistration.findUnique({
          where: { challengeId },
        });
        if (!row) return;
        await lockEmail(tx, row.email);
        await tx.pendingRegistration.updateMany({
          where: { challengeId, consumedAt: null },
          data: { revokedAt: await clock(tx) },
        });
      });
    },
    async sweepExpired(limit) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
        throw new Error("Invalid pending registration sweep bound.");
      return prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<
          Array<{ id: string }>
        >`DELETE FROM pending_registrations WHERE id IN (SELECT id FROM pending_registrations WHERE expires_at <= clock_timestamp() ORDER BY expires_at LIMIT ${limit} FOR UPDATE SKIP LOCKED) RETURNING id`;
        await tx.$executeRaw`DELETE FROM pending_registration_quotas WHERE (key, purpose) IN (SELECT key, purpose FROM pending_registration_quotas WHERE window_at <= clock_timestamp() - interval '15 minutes' ORDER BY window_at LIMIT ${limit} FOR UPDATE SKIP LOCKED)`;
        return rows.length;
      });
    },
  };
}
