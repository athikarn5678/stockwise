import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { isNativeAuthoritySessionValid } from "../modules/identity/better-auth-session-repository.ts";
import { verifyPassword } from "../modules/identity/password-hasher.ts";
import type { SessionConfiguration } from "../modules/identity/session-configuration.ts";
import { loadTestDatabaseEnvironment } from "./database-environment.ts";
import {
  createTestPrismaClient,
  resetTestDatabase,
} from "./database-harness.ts";
import { createNativeFixtureUser } from "./native-user-fixture.ts";

const environment = loadTestDatabaseEnvironment();
const prisma = createTestPrismaClient(environment);
const id = "5c0d6b46-7a4b-4a7e-9d3a-1e2f3a4b5c6d";
const password = "native fixture password 15+";
const MINUTE = 60_000;
const configuration: SessionConfiguration = {
  absoluteTimeoutMilliseconds: 7 * 24 * 60 * MINUTE,
  idleTimeoutMilliseconds: 24 * 60 * MINUTE,
  secureCookie: false,
  touchIntervalMilliseconds: 15 * MINUTE,
};

describe("native user fixture", () => {
  beforeEach(async () => {
    await resetTestDatabase(environment);
  });
  afterAll(async () => {
    await resetTestDatabase(environment);
    await prisma.$disconnect();
  });

  it("creates a Native-eligible verified user with one credential account", async () => {
    await createNativeFixtureUser(prisma, {
      id,
      email: "native-fixture@example.test",
      displayName: "Native Fixture",
      password,
    });
    const user = await prisma.user.findUniqueOrThrow({
      where: { id },
      include: { betterAuthAccounts: true },
    });
    expect(user.status).toBe("ACTIVE");
    expect(user.emailVerified).toBe(true);
    expect(user.emailVerifiedAt).not.toBeNull();
    expect(user.nativeRegistrationCompletedAt).not.toBeNull();
    expect(user.credentialVersion).toBe(1n);
    // The credential lives only in the Better Auth account (users has no hash column).
    expect(Object.keys(user)).not.toContain("passwordHash");
    expect(user.betterAuthAccounts).toHaveLength(1);
    const [account] = user.betterAuthAccounts;
    expect(account?.providerId).toBe("credential");
    expect(account?.accountId).toBe(id);
    expect(account?.userId).toBe(id);
    expect(account?.password).toMatch(/^\$argon2id\$/);
    await expect(
      verifyPassword(account?.password ?? "", password),
    ).resolves.toBe(true);
    await expect(
      verifyPassword(account?.password ?? "", "another password entirely"),
    ).resolves.toBe(false);
  });

  it("supports a finalized Native application session for the fixture user", async () => {
    await createNativeFixtureUser(prisma, {
      id,
      email: "native-fixture@example.test",
      password,
    });
    const user = await prisma.user.findUniqueOrThrow({ where: { id } });
    // Provisional insert, then finalize: the only path the Native guard allows.
    await prisma.betterAuthSession.create({
      data: {
        token: "native-fixture-session-token",
        userId: id,
        expiresAt: new Date(Date.now() + 60 * MINUTE),
      },
    });
    await prisma.betterAuthSession.update({
      where: { token: "native-fixture-session-token" },
      data: {
        stockwisePurpose: "APPLICATION",
        stockwiseCredentialVersion: user.credentialVersion,
      },
    });
    const session = await prisma.betterAuthSession.findUniqueOrThrow({
      where: { token: "native-fixture-session-token" },
      select: {
        id: true,
        userId: true,
        stockwisePurpose: true,
        stockwiseCredentialVersion: true,
        expiresAt: true,
        createdAt: true,
        updatedAt: true,
        user: {
          select: {
            id: true,
            email: true,
            displayName: true,
            status: true,
            disabledAt: true,
            emailVerifiedAt: true,
            emailVerified: true,
            passwordChangedAt: true,
            credentialVersion: true,
            nativeRegistrationCompletedAt: true,
            betterAuthAccounts: {
              where: { providerId: "credential", password: { not: null } },
              select: { id: true },
              take: 1,
            },
          },
        },
      },
    });
    const now = Date.now();
    expect(isNativeAuthoritySessionValid(session, id, now, configuration)).toBe(
      true,
    );
    // The same session is refused for another user id (negative control).
    expect(
      isNativeAuthoritySessionValid(
        session,
        "00000000-0000-4000-8000-000000000000",
        now,
        configuration,
      ),
    ).toBe(false);
  });
});
