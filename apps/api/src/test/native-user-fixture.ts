import type { PrismaClient } from "../generated/prisma/client.ts";
import { hashPassword } from "../modules/identity/password-hasher.ts";

/**
 * Test/seed helper: creates an ACTIVE, verified user in the exact shape the
 * Native pending-registration promotion produces (user with Native
 * registration provenance + one Better Auth credential account whose password
 * is the Argon2id PHC). It never creates a session or a Legacy hash. The
 * timestamps are fixed in the past so the Native session predicate
 * (`passwordChangedAt`/`nativeRegistrationCompletedAt` <= session creation)
 * holds for any session created later.
 */
export interface NativeFixtureUserInput {
  id: string;
  email: string;
  displayName?: string | null;
  /** Plaintext; hashed with the accepted Argon2id policy unless `passwordHash` is given. */
  password: string;
  /** Precomputed PHC (avoids re-hashing the same password for several users). */
  passwordHash?: string;
  /** Defaults to a fixed past instant. */
  at?: Date;
}

const DEFAULT_FIXTURE_INSTANT = new Date("2026-08-26T12:00:00.000Z");

export async function createNativeFixtureUser(
  prisma: Pick<PrismaClient, "user">,
  input: NativeFixtureUserInput,
) {
  const at = input.at ?? DEFAULT_FIXTURE_INSTANT;
  const phc = input.passwordHash ?? (await hashPassword(input.password));
  return prisma.user.create({
    data: {
      id: input.id,
      email: input.email,
      displayName: input.displayName ?? null,
      emailVerified: true,
      emailVerifiedAt: at,
      nativeRegistrationCompletedAt: at,
      passwordChangedAt: at,
      betterAuthAccounts: {
        create: {
          providerId: "credential",
          accountId: input.id,
          password: phc,
        },
      },
    },
  });
}
