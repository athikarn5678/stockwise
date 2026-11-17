import express from "express";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { getTrustedAuthenticationContext } from "../modules/identity/authentication-context.ts";
import { loadTestDatabaseEnvironment } from "./database-environment.ts";
import {
  createTestPrismaClient,
  resetTestDatabase,
} from "./database-harness.ts";
import {
  createNativeTestAuthenticationMiddleware,
  createNativeTestSession,
} from "./native-session-fixture.ts";

const environment = loadTestDatabaseEnvironment();
const prisma = createTestPrismaClient(environment);

async function serve<T>(
  action: (url: string) => Promise<T>,
  now?: () => Date,
): Promise<T> {
  const app = express();
  app.get(
    "/who",
    createNativeTestAuthenticationMiddleware(prisma, now ? { now } : {}),
    (_request, response) => {
      response.json({
        id: getTrustedAuthenticationContext(response)?.actor.id,
      });
    },
  );
  const server = await new Promise<import("node:http").Server>((resolve) => {
    const started = app.listen(0, "127.0.0.1", () => resolve(started));
  });
  try {
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("no address");
    return await action(`http://127.0.0.1:${address.port}/who`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function user(email: string, verified = true) {
  return prisma.user.create({
    data: {
      email,
      emailVerifiedAt: verified ? new Date("2026-08-26T12:00:00.000Z") : null,
    },
  });
}

describe("native session test double", () => {
  beforeEach(async () => {
    await resetTestDatabase(environment);
  });
  afterAll(async () => {
    await resetTestDatabase(environment);
    await prisma.$disconnect();
  });

  it("authenticates a verified user through the real Native session rules", async () => {
    const verified = await user("verified@example.test");
    const session = await createNativeTestSession(prisma, verified.id);
    await serve(async (url) => {
      const response = await fetch(url, {
        headers: { cookie: session.cookie },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ id: verified.id });
    });
  });

  it("denies missing, malformed, unknown and tampered cookies", async () => {
    const verified = await user("verified@example.test");
    const session = await createNativeTestSession(prisma, verified.id);
    await serve(async (url) => {
      for (const cookie of [
        undefined,
        "stockwise_native_test_session=garbage",
        session.cookie.replace(/.$/, session.cookie.endsWith("a") ? "b" : "a"),
        `${session.cookie}; ${session.cookie}`,
      ]) {
        const response = await fetch(url, {
          headers: cookie === undefined ? {} : { cookie },
        });
        expect(response.status).toBe(401);
      }
    });
  });

  it("keeps ineligible users ineligible: unverified, disabled, expired, stale version", async () => {
    const unverified = await user("unverified@example.test", false);
    const disabled = await user("disabled@example.test");
    await prisma.user.update({
      where: { id: disabled.id },
      data: { status: "DISABLED", disabledAt: new Date() },
    });
    const expired = await user("expired@example.test");
    const stale = await user("stale@example.test");
    const sessions = [
      await createNativeTestSession(prisma, unverified.id),
      await createNativeTestSession(prisma, disabled.id),
      await createNativeTestSession(prisma, expired.id, {
        expiresAt: new Date(Date.now() - 1000),
      }),
      await createNativeTestSession(prisma, stale.id),
    ];
    // A password change after login makes the session's credential version stale.
    await prisma.user.update({
      where: { id: stale.id },
      data: { credentialVersion: { increment: 1 } },
    });
    await serve(async (url) => {
      for (const session of sessions) {
        const response = await fetch(url, {
          headers: { cookie: session.cookie },
        });
        expect(response.status).toBe(401);
      }
    });
  });

  it("applies idle expiry from the injected clock", async () => {
    const verified = await user("idle@example.test");
    const session = await createNativeTestSession(prisma, verified.id);
    const later = () => new Date(Date.now() + 25 * 60 * 60 * 1000);
    await serve(async (url) => {
      const response = await fetch(url, {
        headers: { cookie: session.cookie },
      });
      expect(response.status).toBe(401);
    }, later);
  });
});
