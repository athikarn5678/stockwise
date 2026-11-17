import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "../generated/prisma/client.ts";
import { loadTestDatabaseEnvironment } from "../test/database-environment.ts";
import { resetTestDatabase } from "../test/database-harness.ts";
import { createNativeFixtureUser } from "../test/native-user-fixture.ts";

/**
 * Database-level refusal tests for `guard_native_auth_dml` (ADR-045 section 3,
 * migration 20261117000000). Every assertion runs with the guards ENABLED:
 * nothing here uses the trigger-bypass helper. Each rule has a refused case
 * and the matching allowed case, so loosening or removing a rule fails a test.
 */
const environment = loadTestDatabaseEnvironment();
const prisma = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: environment.TEST_DATABASE_URL,
    idleTimeoutMillis: 0,
  }),
});
const PHC = "$argon2id$v=19$m=65536,t=3,p=4$guard-test-only-verifier";
const FUTURE = () => new Date(Date.now() + 3_600_000);

beforeAll(async () => {
  await resetTestDatabase(environment);
});
afterAll(async () => {
  await resetTestDatabase(environment);
  await prisma.$disconnect();
});

const email = () => `${randomUUID()}@example.test`;
/** Fully provisioned Native user (verified, registered, credential account). */
const nativeUser = () =>
  createNativeFixtureUser(prisma, {
    id: randomUUID(),
    email: email(),
    password: "unused",
    passwordHash: PHC,
  });
/** A user row with no Native provenance and no credential account. */
const bareUser = () => prisma.user.create({ data: { email: email() } });
const AT = new Date("2026-09-01T00:00:00.000Z");
const LATER = new Date("2026-09-02T00:00:00.000Z");

describe("users guard", () => {
  it("allows ordinary updates and inserts without provenance", async () => {
    const user = await bareUser();
    await expect(
      prisma.user.update({
        where: { id: user.id },
        data: { displayName: "Changed" },
      }),
    ).resolves.toMatchObject({ displayName: "Changed" });
  });

  it("refuses user deletion", async () => {
    const user = await bareUser();
    await expect(
      prisma.user.delete({ where: { id: user.id } }),
    ).rejects.toThrow(/user deletion is not permitted/);
  });

  it("refuses to decrease or zero the credential version but allows an increase", async () => {
    const user = await bareUser();
    await expect(
      prisma.user.update({
        where: { id: user.id },
        data: { credentialVersion: { increment: 1 } },
      }),
    ).resolves.toMatchObject({ credentialVersion: 2n });
    await expect(
      prisma.user.update({
        where: { id: user.id },
        data: { credentialVersion: 1n },
      }),
    ).rejects.toThrow(/credential version cannot decrease/);
    await expect(
      prisma.user.update({
        where: { id: user.id },
        data: { credentialVersion: 0n },
      }),
    ).rejects.toThrow(/credential version cannot decrease/);
  });

  it("makes password_hash immutable", async () => {
    const user = await bareUser();
    await expect(
      prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: "$argon2id$v=19$other" },
      }),
    ).rejects.toThrow(/password_hash is immutable/);
    await expect(
      prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: user.passwordHash },
      }),
    ).resolves.toMatchObject({ id: user.id });
  });

  it.each(["nativeRegistrationCompletedAt", "emailVerifiedAt"] as const)(
    "makes %s write-once (NULL to value allowed; value to other or NULL refused)",
    async (column) => {
      const user = await bareUser();
      expect(user[column]).toBeNull();
      await expect(
        prisma.user.update({ where: { id: user.id }, data: { [column]: AT } }),
      ).resolves.toMatchObject({ [column]: AT });
      // Writing the same value again is not a change.
      await expect(
        prisma.user.update({ where: { id: user.id }, data: { [column]: AT } }),
      ).resolves.toMatchObject({ [column]: AT });
      await expect(
        prisma.user.update({
          where: { id: user.id },
          data: { [column]: LATER },
        }),
      ).rejects.toThrow(/write-once/);
      await expect(
        prisma.user.update({
          where: { id: user.id },
          data: { [column]: null },
        }),
      ).rejects.toThrow(/write-once/);
    },
  );
});

describe("better_auth_accounts guard", () => {
  it("refuses an account for a user without Native registration provenance", async () => {
    const user = await bareUser();
    await expect(
      prisma.betterAuthAccount.create({
        data: {
          userId: user.id,
          accountId: user.id,
          providerId: "credential",
          password: PHC,
        },
      }),
    ).rejects.toThrow(/requires Native registration provenance/);
    await prisma.user.update({
      where: { id: user.id },
      data: { nativeRegistrationCompletedAt: AT },
    });
    await expect(
      prisma.betterAuthAccount.create({
        data: {
          userId: user.id,
          accountId: user.id,
          providerId: "credential",
          password: PHC,
        },
      }),
    ).resolves.toMatchObject({ userId: user.id });
  });

  it("refuses deleting or re-pointing an account but allows a password change", async () => {
    const user = await nativeUser();
    const account = await prisma.betterAuthAccount.findFirstOrThrow({
      where: { userId: user.id },
    });
    await expect(
      prisma.betterAuthAccount.delete({ where: { id: account.id } }),
    ).rejects.toThrow(/cannot be deleted/);
    await expect(
      prisma.betterAuthAccount.update({
        where: { id: account.id },
        data: { accountId: randomUUID() },
      }),
    ).rejects.toThrow(/identity is immutable/);
    await expect(
      prisma.betterAuthAccount.update({
        where: { id: account.id },
        data: { providerId: "other" },
      }),
    ).rejects.toThrow(/identity is immutable/);
    const other = await nativeUser();
    await expect(
      prisma.betterAuthAccount.update({
        where: { id: account.id },
        data: { userId: other.id },
      }),
    ).rejects.toThrow(/identity is immutable/);
    await expect(
      prisma.betterAuthAccount.update({
        where: { id: account.id },
        data: { password: `${PHC}-changed` },
      }),
    ).resolves.toMatchObject({ password: `${PHC}-changed` });
  });
});

describe("better_auth_sessions guard", () => {
  it("refuses a provisional session for an ineligible user and allows an eligible one", async () => {
    const bare = await bareUser();
    await expect(
      prisma.betterAuthSession.create({
        data: { token: randomUUID(), userId: bare.id, expiresAt: FUTURE() },
      }),
    ).rejects.toThrow(/requires an active verified Native user/);
    const unverified = await nativeUser();
    await prisma.user.update({
      where: { id: unverified.id },
      data: { emailVerified: false },
    });
    await expect(
      prisma.betterAuthSession.create({
        data: {
          token: randomUUID(),
          userId: unverified.id,
          expiresAt: FUTURE(),
        },
      }),
    ).rejects.toThrow(/requires an active verified Native user/);
    const disabled = await nativeUser();
    await prisma.user.update({
      where: { id: disabled.id },
      data: { status: "DISABLED", disabledAt: new Date() },
    });
    await expect(
      prisma.betterAuthSession.create({
        data: {
          token: randomUUID(),
          userId: disabled.id,
          expiresAt: FUTURE(),
        },
      }),
    ).rejects.toThrow(/requires an active verified Native user/);
    const eligible = await nativeUser();
    await expect(
      prisma.betterAuthSession.create({
        data: {
          token: randomUUID(),
          userId: eligible.id,
          expiresAt: FUTURE(),
        },
      }),
    ).resolves.toMatchObject({ userId: eligible.id });
  });

  it.each([
    ["better_auth_email_verified", { emailVerified: false }],
    ["email_verified_at", { emailVerifiedAt: null }],
    [
      "native_registration_completed_at",
      { nativeRegistrationCompletedAt: null },
    ],
    ["an ACTIVE status", { status: "DISABLED" as const, disabledAt: AT }],
  ])(
    "refuses a provisional session when only %s is missing",
    async (_clause, missing) => {
      // Everything except the clause under test is satisfied.
      const user = await prisma.user.create({
        data: {
          email: email(),
          emailVerified: true,
          emailVerifiedAt: AT,
          nativeRegistrationCompletedAt: AT,
          ...missing,
        },
      });
      await expect(
        prisma.betterAuthSession.create({
          data: { token: randomUUID(), userId: user.id, expiresAt: FUTURE() },
        }),
      ).rejects.toThrow(/requires an active verified Native user/);
    },
  );

  it("refuses inserting an already-finalized session", async () => {
    const user = await nativeUser();
    await expect(
      prisma.betterAuthSession.create({
        data: {
          token: randomUUID(),
          userId: user.id,
          expiresAt: FUTURE(),
          stockwisePurpose: "APPLICATION",
          stockwiseCredentialVersion: user.credentialVersion,
        },
      }),
    ).rejects.toThrow(/requires an active verified Native user/);
  });

  it("finalizes only with the current credential version and then pins identity", async () => {
    const user = await nativeUser();
    const session = await prisma.betterAuthSession.create({
      data: { token: randomUUID(), userId: user.id, expiresAt: FUTURE() },
    });
    await expect(
      prisma.betterAuthSession.update({
        where: { id: session.id },
        data: {
          stockwisePurpose: "APPLICATION",
          stockwiseCredentialVersion: user.credentialVersion + 1n,
        },
      }),
    ).rejects.toThrow(/finalization or update is invalid/);
    await expect(
      prisma.betterAuthSession.update({
        where: { id: session.id },
        data: {
          stockwisePurpose: "APPLICATION",
          stockwiseCredentialVersion: user.credentialVersion,
        },
      }),
    ).resolves.toMatchObject({ stockwisePurpose: "APPLICATION" });
    await expect(
      prisma.betterAuthSession.update({
        where: { id: session.id },
        data: { token: randomUUID() },
      }),
    ).rejects.toThrow(/finalization or update is invalid/);
    await expect(
      prisma.betterAuthSession.update({
        where: { id: session.id },
        data: { stockwisePurpose: null, stockwiseCredentialVersion: null },
      }),
    ).rejects.toThrow(/finalization or update is invalid/);
    const other = await nativeUser();
    await expect(
      prisma.betterAuthSession.update({
        where: { id: session.id },
        data: { userId: other.id },
      }),
    ).rejects.toThrow(/finalization or update is invalid/);
    await expect(
      prisma.betterAuthSession.delete({ where: { id: session.id } }),
    ).resolves.toMatchObject({ id: session.id });
  });
});

describe("password_reset_tokens guard", () => {
  const token = (userId: string, extra: Record<string, unknown> = {}) => ({
    userId,
    tokenHash: randomUUID().replaceAll("-", ""),
    expiresAt: FUTURE(),
    requiresNativeDeliveryConfirmation: true,
    ...extra,
  });

  it("requires Native delivery confirmation and a registered Native user to insert", async () => {
    const native = await nativeUser();
    await expect(
      prisma.passwordResetToken.create({
        data: token(native.id, { requiresNativeDeliveryConfirmation: false }),
      }),
    ).rejects.toThrow(/Native reset tokens require Native delivery/);
    const bare = await bareUser();
    await expect(
      prisma.passwordResetToken.create({ data: token(bare.id) }),
    ).rejects.toThrow(/Native reset tokens require Native delivery/);
    await expect(
      prisma.passwordResetToken.create({ data: token(native.id) }),
    ).resolves.toMatchObject({ userId: native.id });
  });

  it("refuses deleting history and tampering with authority, but allows terminal markers once", async () => {
    const native = await nativeUser();
    const row = await prisma.passwordResetToken.create({
      data: token(native.id),
    });
    await expect(
      prisma.passwordResetToken.delete({ where: { id: row.id } }),
    ).rejects.toThrow(/reset history cannot be deleted/);
    await expect(
      prisma.passwordResetToken.update({
        where: { id: row.id },
        data: { expiresAt: new Date(Date.now() + 7_200_000) },
      }),
    ).rejects.toThrow(/reset authority cannot be modified/);
    await expect(
      prisma.passwordResetToken.update({
        where: { id: row.id },
        data: { requiresNativeDeliveryConfirmation: false },
      }),
    ).rejects.toThrow(/reset authority cannot be modified/);
    await expect(
      prisma.passwordResetToken.update({
        where: { id: row.id },
        data: { deliveryConfirmedAt: AT },
      }),
    ).resolves.toMatchObject({ deliveryConfirmedAt: AT });
    await expect(
      prisma.passwordResetToken.update({
        where: { id: row.id },
        data: { deliveryConfirmedAt: LATER },
      }),
    ).rejects.toThrow(/reset authority cannot be modified/);
    const consumedAt = new Date();
    await expect(
      prisma.passwordResetToken.update({
        where: { id: row.id },
        data: { consumedAt },
      }),
    ).resolves.toMatchObject({ consumedAt });
    await expect(
      prisma.passwordResetToken.update({
        where: { id: row.id },
        data: { consumedAt: new Date(consumedAt.getTime() + 1_000) },
      }),
    ).rejects.toThrow(/reset authority cannot be modified/);
  });

  it.each(["revokedAt", "replacedAt"] as const)(
    "allows %s once and then refuses changing it",
    async (column) => {
      const native = await nativeUser();
      const row = await prisma.passwordResetToken.create({
        data: token(native.id),
      });
      const at = new Date();
      await expect(
        prisma.passwordResetToken.update({
          where: { id: row.id },
          data: { [column]: at },
        }),
      ).resolves.toMatchObject({ [column]: at });
      await expect(
        prisma.passwordResetToken.update({
          where: { id: row.id },
          data: { [column]: new Date(at.getTime() + 1_000) },
        }),
      ).rejects.toThrow(/reset authority cannot be modified/);
    },
  );

  it("refuses confirming delivery after a terminal marker", async () => {
    const native = await nativeUser();
    const row = await prisma.passwordResetToken.create({
      data: token(native.id),
    });
    await prisma.passwordResetToken.update({
      where: { id: row.id },
      data: { revokedAt: new Date() },
    });
    await expect(
      prisma.passwordResetToken.update({
        where: { id: row.id },
        data: { deliveryConfirmedAt: AT },
      }),
    ).rejects.toThrow(/reset authority cannot be modified/);
  });
});
