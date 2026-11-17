import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../../app.ts";
import type { ApiLogger } from "../../logger.ts";
import { startApiServer, type RunningApiServer } from "../../server.ts";
import { loadTestDatabaseEnvironment } from "../../test/database-environment.ts";
import {
  NATIVE_TEST_SESSION_COOKIE,
  createNativeTestAuthenticationMiddleware,
  createNativeTestSession,
  type NativeTestSession,
} from "../../test/native-session-fixture.ts";
import {
  createTestPrismaClient,
  resetTestDatabase,
} from "../../test/database-harness.ts";
import { createPrismaSelfProfileRepository } from "./profile-repository.ts";
import { createSelfProfileRouter } from "./profile-router.ts";
import { createSelfProfileService } from "./profile-service.ts";
import type { SessionConfiguration } from "./session-configuration.ts";

const environment = loadTestDatabaseEnvironment();
const prisma = createTestPrismaClient(environment);
const NOW = new Date("2026-10-25T12:00:00.000Z");
const TOKEN = "Q".repeat(43);
const configuration: SessionConfiguration = {
  absoluteTimeoutMilliseconds: 7 * 24 * 60 * 60 * 1000,
  idleTimeoutMilliseconds: 24 * 60 * 60 * 1000,
  secureCookie: false,
  touchIntervalMilliseconds: 15 * 60 * 1000,
};
const logger: ApiLogger = { error() {}, info() {} };
describe("self-profile PostgreSQL integration", () => {
  let server: RunningApiServer | undefined;
  const nativeSessions = new Map<string, NativeTestSession>();
  beforeEach(async () => {
    nativeSessions.clear();
    await resetTestDatabase(environment);
  });
  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });
  afterAll(async () => {
    await resetTestDatabase(environment);
    await prisma.$disconnect();
  });

  async function start() {
    const router = createSelfProfileRouter({
      authenticationMiddleware: createNativeTestAuthenticationMiddleware(
        prisma,
        { configuration, now: () => NOW },
      ),
      profileService: createSelfProfileService({
        repository: createPrismaSelfProfileRepository(prisma, () => NOW),
      }),
      publicWebOrigin: "http://localhost:3000",
    });
    server = await startApiServer(createApp({ apiRouter: router, logger }), {
      host: "127.0.0.1",
      port: 0,
    });
    return `http://${server.address.host}:${server.address.port}/api/v1`;
  }

  async function createActor({
    email = "self-profile@example.com",
    phone = null,
    token = TOKEN,
  }: { email?: string; phone?: string | null; token?: string } = {}) {
    const user = await prisma.user.create({
      data: {
        displayName: null,
        email,
        emailVerifiedAt: new Date(NOW.getTime() - 1_000),
        passwordHash: "$argon2id$fixture",
        phone,
      },
    });
    nativeSessions.set(
      token,
      await createNativeTestSession(prisma, user.id, {
        createdAt: NOW,
        updatedAt: NOW,
        expiresAt: new Date(NOW.getTime() + 24 * 60 * 60 * 1000),
      }),
    );
    // The Native double promotes the user; return the persisted state.
    return prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  }

  const authenticatedCookie = (token: string) => ({
    cookie:
      nativeSessions.get(token)?.cookie ??
      `${NATIVE_TEST_SESSION_COOKIE}=unknown`,
  });

  it("allows a membership-less actor to read and atomically win only one update per version", async () => {
    const user = await createActor({ phone: "+66 1 234 5678" });
    const sessionBefore = await prisma.betterAuthSession.findUniqueOrThrow({
      where: { id: nativeSessions.get(TOKEN)!.id },
    });
    const base = await start();
    const get = await fetch(`${base}/me`, {
      headers: authenticatedCookie(TOKEN),
    });
    expect(get.status).toBe(200);
    expect(get.headers.get("cache-control")).toBe("no-store");
    const { data } = (await get.json()) as {
      data: {
        id: string;
        email: string;
        displayName: string | null;
        phone: string | null;
        updatedAt: string;
      };
    };
    expect(data).toMatchObject({
      id: user.id,
      email: user.email,
      displayName: null,
      phone: "+66 1 234 5678",
    });
    expect(Object.keys(data).sort()).toEqual([
      "displayName",
      "email",
      "id",
      "phone",
      "updatedAt",
    ]);
    const responses = await Promise.all([
      fetch(`${base}/me/profile`, {
        method: "PATCH",
        headers: {
          ...authenticatedCookie(TOKEN),
          "content-type": "application/json",
          origin: "http://localhost:3000",
        },
        body: JSON.stringify({
          displayName: "First",
          expectedUpdatedAt: data.updatedAt,
        }),
      }),
      fetch(`${base}/me/profile`, {
        method: "PATCH",
        headers: {
          ...authenticatedCookie(TOKEN),
          "content-type": "application/json",
          origin: "http://localhost:3000",
        },
        body: JSON.stringify({
          displayName: "Second",
          expectedUpdatedAt: data.updatedAt,
        }),
      }),
    ]);
    expect(responses.map(({ status }) => status).sort()).toEqual([200, 409]);
    const current = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    expect(["First", "Second"]).toContain(current.displayName);
    expect(current.updatedAt.getTime()).toBeGreaterThan(
      new Date(data.updatedAt).getTime(),
    );
    expect(current.email).toBe(user.email);
    expect(current.phone).toBe("+66 1 234 5678");
    expect(current.passwordHash).toBe(user.passwordHash);
    expect(current.credentialVersion).toBe(user.credentialVersion);
    expect(current.passwordChangedAt).toEqual(user.passwordChangedAt);
    expect(current.emailVerifiedAt).toEqual(user.emailVerifiedAt);
    expect(
      await prisma.organizationMembership.count({ where: { userId: user.id } }),
    ).toBe(0);
    const blankPhone = await fetch(`${base}/me/profile`, {
      method: "PATCH",
      headers: {
        ...authenticatedCookie(TOKEN),
        "content-type": "application/json",
        origin: "http://localhost:3000",
      },
      body: JSON.stringify({
        displayName: current.displayName,
        phone: "   ",
        expectedUpdatedAt: current.updatedAt.toISOString(),
      }),
    });
    expect(blankPhone.status).toBe(200);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).phone,
    ).toBeNull();
    // Native revocation deletes the row, so findUniqueOrThrow also proves the
    // session was not revoked; updatedAt is the Native activity timestamp.
    const sessionAfter = await prisma.betterAuthSession.findUniqueOrThrow({
      where: { id: sessionBefore.id },
    });
    expect(sessionAfter).toMatchObject({
      id: sessionBefore.id,
      token: sessionBefore.token,
      userId: user.id,
      updatedAt: sessionBefore.updatedAt,
    });
  });

  it("cannot mutate another authenticated user's profile using IDs, headers, query, or body", async () => {
    const victim = await createActor({
      email: "profile-victim@example.com",
      phone: "victim-phone",
    });
    const attackerToken = "R".repeat(43);
    const attacker = await createActor({
      email: "profile-attacker@example.com",
      phone: "attacker-phone",
      token: attackerToken,
    });
    const base = await start();
    const victimBefore = await prisma.user.findUniqueOrThrow({
      where: { id: victim.id },
    });
    const actorBefore = await prisma.user.findUniqueOrThrow({
      where: { id: attacker.id },
    });
    const headers = {
      ...authenticatedCookie(attackerToken),
      "content-type": "application/json",
      origin: "http://localhost:3000",
      "x-user-id": victim.id,
    };
    const body = {
      displayName: "Attacker update",
      expectedUpdatedAt: actorBefore.updatedAt.toISOString(),
    };
    const forgedQuery = await fetch(`${base}/me/profile?userId=${victim.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify(body),
    });
    expect(forgedQuery.status).toBe(400);
    const forgedBody = await fetch(`${base}/me/profile`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ ...body, userId: victim.id }),
    });
    expect(forgedBody.status).toBe(400);
    const ownUpdate = await fetch(`${base}/me/profile`, {
      method: "PATCH",
      headers,
      body: JSON.stringify(body),
    });
    expect(ownUpdate.status).toBe(200);
    const victimAfter = await prisma.user.findUniqueOrThrow({
      where: { id: victim.id },
    });
    const actorAfter = await prisma.user.findUniqueOrThrow({
      where: { id: attacker.id },
    });
    expect(victimAfter).toMatchObject({
      displayName: victimBefore.displayName,
      phone: victimBefore.phone,
      updatedAt: victimBefore.updatedAt,
    });
    expect(actorAfter.displayName).toBe("Attacker update");
  });
});
