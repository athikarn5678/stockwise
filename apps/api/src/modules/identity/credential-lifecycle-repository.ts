import { Prisma, type PrismaClient } from "../../generated/prisma/client.ts";

export interface IssuedIdentityToken {
  id: string;
  recipient: string;
}

export interface ValidPasswordResetToken {
  tokenId: string;
  userId: string;
}

export interface PasswordResetRepository {
  completePasswordReset(input: {
    completedAt: Date;
    passwordHash: string;
    tokenId: string;
    userId: string;
  }): Promise<boolean>;
  findValidPasswordResetToken(input: {
    now: Date;
    tokenHash: string;
  }): Promise<ValidPasswordResetToken | null>;
  issuePasswordResetToken(input: {
    email: string;
    expiresAt: Date;
    issuedAt: Date;
    tokenHash: string;
  }): Promise<IssuedIdentityToken | null>;
  revokePasswordResetToken(input: {
    revokedAt: Date;
    tokenId: string;
  }): Promise<void>;
  confirmPasswordResetDelivery?(input: { tokenId: string }): Promise<void>;
}

export class OneTimeTokenCollisionError extends Error {
  constructor() {
    super("The generated one-time token hash collided.");
    this.name = "OneTimeTokenCollisionError";
  }
}

class InvalidPasswordResetStateError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTokenHashTarget(target: unknown): boolean {
  if (typeof target === "string") {
    return target.includes("token_hash") || target.includes("tokenHash");
  }

  return (
    Array.isArray(target) &&
    target.some((field) => field === "token_hash" || field === "tokenHash")
  );
}

function hasDriverAdapterTokenHashConstraint(meta: unknown): boolean {
  if (!isRecord(meta) || !isRecord(meta.driverAdapterError)) {
    return false;
  }

  const cause = meta.driverAdapterError.cause;
  return (
    isRecord(cause) &&
    cause.kind === "UniqueConstraintViolation" &&
    isRecord(cause.constraint) &&
    isTokenHashTarget(cause.constraint.fields)
  );
}

function isTokenHashConflict(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002" &&
    (isTokenHashTarget(error.meta?.target) ||
      hasDriverAdapterTokenHashConstraint(error.meta))
  );
}

async function lockUserByEmail(
  transaction: Prisma.TransactionClient,
  email: string,
): Promise<string | null> {
  const rows = await transaction.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT id FROM users WHERE email = ${email} FOR UPDATE`,
  );
  return rows[0]?.id ?? null;
}

async function lockUserById(
  transaction: Prisma.TransactionClient,
  userId: string,
): Promise<string | null> {
  const rows = await transaction.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`,
  );
  return rows[0]?.id ?? null;
}

async function lockPasswordResetTokenById(
  transaction: Prisma.TransactionClient,
  tokenId: string,
): Promise<string | null> {
  const rows = await transaction.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT id FROM password_reset_tokens WHERE id = ${tokenId} FOR UPDATE`,
  );
  return rows[0]?.id ?? null;
}

async function freshDbTime(
  transaction: Prisma.TransactionClient,
): Promise<Date> {
  const rows = await transaction.$queryRaw<Array<{ now: Date }>>(
    Prisma.sql`SELECT clock_timestamp() AS now`,
  );
  const now = rows[0]?.now;
  if (now === undefined) {
    throw new Error("Credential lifecycle clock query returned no row.");
  }
  return now;
}

/** Isolated native reset persistence; never exposes legacy logout authority. */
export function createPrismaBetterAuthCredentialLifecycleRepository(
  prisma: PrismaClient,
): PasswordResetRepository {
  const repository = createCredentialLifecycleRepository(prisma);
  return {
    completePasswordReset: repository.completePasswordReset,
    findValidPasswordResetToken: repository.findValidPasswordResetToken,
    issuePasswordResetToken: repository.issuePasswordResetToken,
    revokePasswordResetToken: repository.revokePasswordResetToken,
    async confirmPasswordResetDelivery({ tokenId }) {
      await prisma.$transaction(async (transaction) => {
        const candidate = await transaction.passwordResetToken.findUnique({
          where: { id: tokenId },
          select: { userId: true },
        });
        if (candidate === null) return;
        await lockUserById(transaction, candidate.userId);
        await lockPasswordResetTokenById(transaction, tokenId);
        const now = await freshDbTime(transaction);
        if (!(await nativeEligibleForDelivery(transaction, candidate.userId)))
          return;
        await transaction.passwordResetToken.updateMany({
          where: {
            id: tokenId,
            requiresNativeDeliveryConfirmation: true,
            deliveryConfirmedAt: null,
            consumedAt: null,
            replacedAt: null,
            revokedAt: null,
            expiresAt: { gt: now },
          },
          data: { deliveryConfirmedAt: now },
        });
      });
    },
  };
}

async function nativeEligibleForDelivery(
  transaction: Prisma.TransactionClient,
  userId: string,
): Promise<boolean> {
  const user = await transaction.user.findUnique({
    where: { id: userId },
    select: {
      status: true,
      disabledAt: true,
      emailVerified: true,
      emailVerifiedAt: true,
      nativeRegistrationCompletedAt: true,
    },
  });
  const account = await transaction.betterAuthAccount.findUnique({
    where: {
      providerId_accountId: { providerId: "credential", accountId: userId },
    },
    select: { userId: true, password: true },
  });
  return (
    user !== null &&
    user.status === "ACTIVE" &&
    user.disabledAt === null &&
    user.emailVerified &&
    user.emailVerifiedAt !== null &&
    user.nativeRegistrationCompletedAt !== null &&
    account?.userId === userId &&
    account.password !== null
  );
}

function createCredentialLifecycleRepository(
  prisma: PrismaClient,
): PasswordResetRepository {
  return {
    async issuePasswordResetToken(input) {
      try {
        return await prisma.$transaction(async (transaction) => {
          const userId = await lockUserByEmail(transaction, input.email);
          if (userId === null) {
            return null;
          }

          const user = await transaction.user.findUnique({
            where: { id: userId },
            select: { email: true, emailVerifiedAt: true, status: true },
          });
          if (
            user === null ||
            user.status !== "ACTIVE" ||
            user.emailVerifiedAt === null
          ) {
            return null;
          }

          if (!(await nativeEligibleForDelivery(transaction, userId))) {
            return null;
          }
          const issuedAt = await freshDbTime(transaction);
          const expiresAt = new Date(issuedAt.getTime() + 30 * 60 * 1000);

          await transaction.passwordResetToken.updateMany({
            where: {
              consumedAt: null,
              replacedAt: null,
              revokedAt: null,
              userId,
            },
            data: { replacedAt: issuedAt },
          });
          const token = await transaction.passwordResetToken.create({
            data: {
              expiresAt,
              issuedAt,
              requiresNativeDeliveryConfirmation: true,
              tokenHash: input.tokenHash,
              userId,
            },
            select: { id: true },
          });

          return { id: token.id, recipient: user.email };
        });
      } catch (error: unknown) {
        if (isTokenHashConflict(error)) {
          throw new OneTimeTokenCollisionError();
        }
        throw error;
      }
    },

    async revokePasswordResetToken({ revokedAt, tokenId }) {
      await prisma.passwordResetToken.updateMany({
        where: {
          consumedAt: null,
          id: tokenId,
          replacedAt: null,
          revokedAt: null,
        },
        data: { revokedAt },
      });
    },

    async findValidPasswordResetToken({ now, tokenHash }) {
      now = await freshDbTime(prisma);
      const token = await prisma.passwordResetToken.findUnique({
        where: { tokenHash },
        select: {
          consumedAt: true,
          requiresNativeDeliveryConfirmation: true,
          deliveryConfirmedAt: true,
          expiresAt: true,
          id: true,
          replacedAt: true,
          revokedAt: true,
          user: { select: { emailVerifiedAt: true, status: true } },
          userId: true,
        },
      });

      if (
        token === null ||
        token.consumedAt !== null ||
        token.revokedAt !== null ||
        token.replacedAt !== null ||
        !token.requiresNativeDeliveryConfirmation ||
        token.deliveryConfirmedAt === null ||
        now >= token.expiresAt ||
        token.user.status !== "ACTIVE" ||
        token.user.emailVerifiedAt === null
      ) {
        return null;
      }

      if (!(await nativeEligibleForDelivery(prisma, token.userId))) {
        return null;
      }

      return { tokenId: token.id, userId: token.userId };
    },

    async completePasswordReset({ passwordHash, tokenId, userId }) {
      try {
        await prisma.$transaction(async (transaction) => {
          const lockedUserId = await lockUserById(transaction, userId);
          if (lockedUserId === null) {
            throw new InvalidPasswordResetStateError();
          }

          // Same lock order as D4-N1 finalization; Argon2 already finished outside.
          await transaction.$queryRaw`
            SELECT id FROM better_auth_accounts
            WHERE user_id = ${userId}::uuid AND provider_id = 'credential'
            FOR UPDATE`;
          if (!(await nativeEligibleForDelivery(transaction, userId))) {
            throw new InvalidPasswordResetStateError();
          }

          const lockedTokenId = await lockPasswordResetTokenById(
            transaction,
            tokenId,
          );
          if (lockedTokenId === null) {
            throw new InvalidPasswordResetStateError();
          }

          const now = await freshDbTime(transaction);

          const user = await transaction.user.findUnique({
            where: { id: userId },
            select: { emailVerifiedAt: true, status: true },
          });
          if (
            user === null ||
            user.status !== "ACTIVE" ||
            user.emailVerifiedAt === null
          ) {
            throw new InvalidPasswordResetStateError();
          }

          const token = await transaction.passwordResetToken.findUnique({
            where: { id: tokenId },
            select: {
              consumedAt: true,
              requiresNativeDeliveryConfirmation: true,
              deliveryConfirmedAt: true,
              expiresAt: true,
              replacedAt: true,
              revokedAt: true,
              userId: true,
            },
          });
          if (
            token === null ||
            token.userId !== userId ||
            token.consumedAt !== null ||
            token.revokedAt !== null ||
            token.replacedAt !== null ||
            !token.requiresNativeDeliveryConfirmation ||
            token.deliveryConfirmedAt === null ||
            now >= token.expiresAt
          ) {
            throw new InvalidPasswordResetStateError();
          }

          await transaction.betterAuthAccount.update({
            where: {
              providerId_accountId: {
                providerId: "credential",
                accountId: userId,
              },
            },
            data: { password: passwordHash },
          });

          await transaction.user.update({
            where: { id: userId },
            data: {
              credentialVersion: { increment: 1 },
              passwordChangedAt: now,
            },
          });

          await transaction.passwordResetToken.update({
            where: { id: tokenId },
            data: { consumedAt: now },
          });

          // Deletes APPLICATION and provisional sessions; late old-password
          // writers cannot finalize against the new version/PHC.
          await transaction.betterAuthSession.deleteMany({
            where: { userId },
          });
          if (
            await transaction.betterAuthSession.count({ where: { userId } })
          ) {
            throw new Error("Native password reset revocation failed");
          }
        });
        return true;
      } catch (error: unknown) {
        if (error instanceof InvalidPasswordResetStateError) {
          return false;
        }
        throw error;
      }
    },
  };
}
