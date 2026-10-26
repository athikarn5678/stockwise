import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../../app.ts";
import type { ApiLogger } from "../../logger.ts";
import { startApiServer, type RunningApiServer } from "../../server.ts";
import { loadTestDatabaseEnvironment } from "../../test/database-environment.ts";
import {
  createTestPrismaClient,
  resetTestDatabase,
} from "../../test/database-harness.ts";
import {
  createPrismaAuthenticationRepository,
  createPrismaAuthenticationSessionRepository,
  SessionTokenCollisionError,
} from "./authentication-repository.ts";
import { createLoginLimiter } from "./login-limiter.ts";
import { createLoginRouter } from "./login-router.ts";
import { createLoginService } from "./login-service.ts";
import { argon2PasswordVerifier, hashPassword } from "./password-hasher.ts";
import type { SessionConfiguration } from "./session-configuration.ts";
import { readSessionCookie, SESSION_COOKIE_NAME } from "./session-cookie.ts";
import {
  hashSessionToken,
  secureSessionTokenProvider,
} from "./session-token.ts";
import { createPrismaVerificationRepository } from "./verification-repository.ts";
import { testVerificationSecurity } from "../../test/identity-backend-fixture.ts";

interface LogEntry {
  bindings: Record<string, unknown>;
  level: "error" | "info";
  message: string;
}

const environment = loadTestDatabaseEnvironment();
const prisma = createTestPrismaClient(environment);
const NOW = new Date("2026-08-24T12:00:00.000Z");
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;
const configuration: SessionConfiguration = {
  absoluteTimeoutMilliseconds: 7 * DAY_MILLISECONDS,
  idleTimeoutMilliseconds: DAY_MILLISECONDS,
  secureCookie: false,
  touchIntervalMilliseconds: 15 * 60 * 1000,
};

afterAll(async () => {
  await resetTestDatabase(environment);
  await prisma.$disconnect();
});

describe("login and authenticated sessions with PostgreSQL", () => {
  let runningServer: RunningApiServer | undefined;

  beforeEach(async () => {
    await resetTestDatabase(environment);
  });

  afterEach(async () => {
    await runningServer?.stop();
    runningServer = undefined;
  });

  async function seedUser({
    email = "user@example.com",
    password = "password-long-enough",
    verified = true,
  }: {
    email?: string;
    password?: string;
    verified?: boolean;
  } = {}) {
    return prisma.user.create({
      data: {
        displayName: null,
        email,
        emailVerifiedAt: verified ? new Date(NOW.getTime() - 1_000) : null,
        passwordHash: await hashPassword(password),
      },
    });
  }

  async function startLoginApplication(
    now: () => Date = () => NOW,
  ): Promise<{ entries: LogEntry[]; url: string }> {
    const entries: LogEntry[] = [];
    const logger: ApiLogger = {
      error(bindings, message) {
        entries.push({ bindings, level: "error", message });
      },
      info(bindings, message) {
        entries.push({ bindings, level: "info", message });
      },
    };
    const repository = createPrismaAuthenticationRepository(prisma);
    const loginService = createLoginService({
      configuration,
      now,
      passwordVerifier: argon2PasswordVerifier,
      repository,
      tokenProvider: secureSessionTokenProvider,
      verificationRepository: createPrismaVerificationRepository(prisma),
      security: testVerificationSecurity(),
    });
    const apiRouter = createLoginRouter({
      configuration,
      limiter: createLoginLimiter(),
      loginService,
      continuationKey: Buffer.alloc(32).toString("base64url"),
      publicWebOrigin: "http://localhost:3000",
    });
    const app = createApp({ apiRouter, logger });
    runningServer = await startApiServer(app, {
      host: "127.0.0.1",
      port: 0,
    });

    return {
      entries,
      url: `http://${runningServer.address.host}:${runningServer.address.port}/api/v1/auth/login`,
    };
  }

  function login(
    url: string,
    email: string,
    password: string,
    cookie?: string,
  ): Promise<Response> {
    return fetch(url, {
      body: JSON.stringify({ email, password }),
      headers: {
        "content-type": "application/json",
        Origin: "http://localhost:3000",
        ...(cookie === undefined ? {} : { cookie }),
      },
      method: "POST",
    });
  }

  it("creates one hash-only session with the accepted cookie and lifetime", async () => {
    const password = "  Unicode password é🔒  ";
    const user = await seedUser({ password });
    const { entries, url } = await startLoginApplication();

    const response = await login(url, " USER@EXAMPLE.COM ", password);
    const responseText = await response.text();
    const setCookie =
      response.headers
        .getSetCookie()
        .find((value) => value.startsWith(`${SESSION_COOKIE_NAME}=`)) ?? "";
    const rawToken = readSessionCookie(setCookie);
    const sessions = await prisma.session.findMany();

    expect(response.status).toBe(200);
    expect(JSON.parse(responseText)).toEqual({
      data: {
        user: { displayName: null, email: user.email, id: user.id },
      },
      meta: { requestId: response.headers.get("x-request-id") },
    });
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).not.toContain("Secure");
    expect(setCookie).not.toContain("Domain=");
    expect(rawToken).not.toBeNull();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      lastUsedAt: sessions[0]?.issuedAt,
      revokedAt: null,
      userId: user.id,
    });
    const session = sessions[0]!;
    expect(
      session.absoluteExpiresAt.getTime() - session.issuedAt.getTime(),
    ).toBe(7 * DAY_MILLISECONDS);
    expect(session.idleExpiresAt.getTime() - session.issuedAt.getTime()).toBe(
      DAY_MILLISECONDS,
    );
    expect(sessions[0]?.tokenHash).toBe(hashSessionToken(rawToken ?? ""));
    expect(sessions[0]?.tokenHash).not.toBe(rawToken);
    expect(responseText).not.toContain(password);
    expect(responseText).not.toContain(sessions[0]?.tokenHash ?? "missing");
    expect(JSON.stringify(entries)).not.toContain(password);
    expect(JSON.stringify(entries)).not.toContain(rawToken);
    expect(JSON.stringify(entries)).not.toContain(sessions[0]?.tokenHash);
  });

  it("denies wrong, nonexistent, and disabled accounts without sessions", async () => {
    const verified = await seedUser();
    await seedUser({ email: "unverified@example.com", verified: false });
    await prisma.user.create({
      data: {
        disabledAt: new Date(NOW.getTime() - 1_000),
        displayName: null,
        email: "disabled@example.com",
        emailVerifiedAt: new Date(NOW.getTime() - 2_000),
        passwordHash: await hashPassword("password-long-enough"),
        status: "DISABLED",
      },
    });
    const { url } = await startLoginApplication();

    const responses = await Promise.all([
      login(url, verified.email, "wrong-password-long-enough"),
      login(url, "missing@example.com", "wrong-password-long-enough"),
      login(url, "disabled@example.com", "password-long-enough"),
    ]);
    const bodies = await Promise.all(
      responses.map(
        async (response) =>
          (await response.json()) as {
            error: { code: string; message: string };
          },
      ),
    );

    expect(responses.map((response) => response.status)).toEqual([
      401, 401, 401,
    ]);
    expect(
      bodies.map((body) => ({
        code: body.error.code,
        message: body.error.message,
      })),
    ).toEqual(
      Array.from({ length: 3 }, () => ({
        code: "INVALID_CREDENTIALS",
        message: "The email or password is incorrect.",
      })),
    );
    expect(await prisma.session.count()).toBe(0);
    expect(await prisma.emailVerificationChallenge.count()).toBe(0);
  });

  it("rotates a valid same-user session and returns an independent fresh token", async () => {
    const user = await seedUser();
    let currentTime = NOW;
    const { url } = await startLoginApplication(() => currentTime);
    const first = await login(url, user.email, "password-long-enough");
    const firstToken = readSessionCookie(first.headers.get("set-cookie") ?? "");

    currentTime = new Date(NOW.getTime() + 1_000);
    const second = await login(
      url,
      user.email,
      "password-long-enough",
      `${SESSION_COOKIE_NAME}=${firstToken ?? ""}`,
    );
    const secondToken = readSessionCookie(
      second.headers.get("set-cookie") ?? "",
    );
    const sessions = await prisma.session.findMany({
      orderBy: { issuedAt: "asc" },
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(secondToken).not.toBe(firstToken);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({
      revocationReason: "login_rotation",
      revokedAt: sessions[1]?.issuedAt,
    });
    expect(sessions[1]).toMatchObject({ revokedAt: null, userId: user.id });
  });

  it("never reuses malformed or unknown client tokens", async () => {
    await seedUser();
    const { url } = await startLoginApplication();
    const unknownToken = "Z".repeat(43);

    const malformed = await login(
      url,
      "user@example.com",
      "password-long-enough",
      `${SESSION_COOKIE_NAME}=client-chosen`,
    );
    const unknown = await login(
      url,
      "user@example.com",
      "password-long-enough",
      `${SESSION_COOKIE_NAME}=${unknownToken}`,
    );
    const malformedResult = readSessionCookie(
      malformed.headers.get("set-cookie") ?? "",
    );
    const unknownResult = readSessionCookie(
      unknown.headers.get("set-cookie") ?? "",
    );

    expect(malformed.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(malformedResult).not.toBe("client-chosen");
    expect(unknownResult).not.toBe(unknownToken);
    expect(await prisma.session.count()).toBe(2);
  });

  it("creates independent sessions for concurrent successful logins", async () => {
    await seedUser();
    const { url } = await startLoginApplication();

    const responses = await Promise.all([
      login(url, "user@example.com", "password-long-enough"),
      login(url, "user@example.com", "password-long-enough"),
    ]);
    const tokens = responses.map((response) =>
      readSessionCookie(response.headers.get("set-cookie") ?? ""),
    );

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(tokens[0]).not.toBe(tokens[1]);
    expect(await prisma.session.count()).toBe(2);
  });

  it("rolls back old-session revocation when fresh-session creation collides", async () => {
    const user = await seedUser();
    const [clock] = await prisma.$queryRaw<Array<{ now: Date }>>`
      SELECT clock_timestamp() AS now
    `;
    if (clock === undefined) throw new Error("Test database clock missing.");
    const oldTokenHash = hashSessionToken("A".repeat(43));
    const oldSession = await prisma.session.create({
      data: {
        absoluteExpiresAt: new Date(clock.now.getTime() + 7 * DAY_MILLISECONDS),
        idleExpiresAt: new Date(clock.now.getTime() + DAY_MILLISECONDS),
        issuedAt: clock.now,
        lastUsedAt: clock.now,
        tokenHash: oldTokenHash,
        userId: user.id,
      },
    });
    const sessionRepository =
      createPrismaAuthenticationSessionRepository(prisma);
    await expect(
      sessionRepository.resolveSession({
        configuration,
        now: clock.now,
        tokenHash: oldTokenHash,
      }),
    ).resolves.toMatchObject({ sessionId: oldSession.id });
    const repository = createPrismaAuthenticationRepository(prisma);

    await expect(
      repository.establishSession({
        absoluteExpiresAt: new Date(clock.now.getTime() + 7 * DAY_MILLISECONDS),
        existingTokenHash: oldTokenHash,
        idleExpiresAt: new Date(clock.now.getTime() + DAY_MILLISECONDS),
        issuedAt: clock.now,
        tokenHash: oldTokenHash,
        userId: user.id,
        passwordHash: user.passwordHash,
        credentialVersion: user.credentialVersion,
      }),
    ).rejects.toBeInstanceOf(SessionTokenCollisionError);

    expect(
      await prisma.session.findUnique({ where: { id: oldSession.id } }),
    ).toMatchObject({
      revocationReason: null,
      revokedAt: null,
    });
    expect(await prisma.session.count()).toBe(1);
  });
});

describe("authenticated session resolution with PostgreSQL", () => {
  beforeEach(async () => {
    await resetTestDatabase(environment);
  });

  interface SeedSessionOptions {
    absoluteExpiresAt?: Date;
    emailVerifiedAt?: Date | null;
    idleExpiresAt?: Date;
    lastUsedAt?: Date;
    revokedAt?: Date | null;
    status?: "ACTIVE" | "DISABLED";
    token?: string;
  }

  async function seedSession({
    absoluteExpiresAt = new Date(NOW.getTime() + 7 * DAY_MILLISECONDS),
    emailVerifiedAt = new Date(NOW.getTime() - 1_000),
    idleExpiresAt = new Date(NOW.getTime() + DAY_MILLISECONDS),
    lastUsedAt = NOW,
    revokedAt = null,
    status = "ACTIVE",
    token = "A".repeat(43),
  }: SeedSessionOptions = {}) {
    const user = await prisma.user.create({
      data: {
        disabledAt:
          status === "DISABLED" ? new Date(NOW.getTime() - 1_000) : null,
        displayName: null,
        email: `${token[0]?.toLowerCase()}@example.com`,
        emailVerifiedAt,
        passwordHash: "encoded-password-hash",
        status,
      },
    });
    const session = await prisma.session.create({
      data: {
        absoluteExpiresAt,
        idleExpiresAt,
        issuedAt: new Date(NOW.getTime() - DAY_MILLISECONDS),
        lastUsedAt,
        revokedAt,
        revocationReason: revokedAt === null ? null : "test_revocation",
        tokenHash: hashSessionToken(token),
        userId: user.id,
      },
    });

    return { session, token, user };
  }

  it("resolves a valid session without a write before the touch interval", async () => {
    const lastUsedAt = new Date(NOW.getTime() - 14 * 60 * 1000);
    const { session, token, user } = await seedSession({ lastUsedAt });
    const repository = createPrismaAuthenticationSessionRepository(prisma);

    await expect(
      repository.resolveSession({
        configuration,
        now: NOW,
        tokenHash: hashSessionToken(token),
      }),
    ).resolves.toEqual({
      actor: { displayName: null, email: user.email, id: user.id },
      sessionId: session.id,
    });
    expect(
      await prisma.session.findUnique({ where: { id: session.id } }),
    ).toMatchObject({
      idleExpiresAt: session.idleExpiresAt,
      lastUsedAt,
    });
  });

  it("slides idle expiry at the touch threshold without moving absolute expiry", async () => {
    const lastUsedAt = new Date(NOW.getTime() - 15 * 60 * 1000);
    const absoluteExpiresAt = new Date(NOW.getTime() + 7 * DAY_MILLISECONDS);
    const { session, token } = await seedSession({
      absoluteExpiresAt,
      lastUsedAt,
    });
    const repository = createPrismaAuthenticationSessionRepository(prisma);

    expect(
      await repository.resolveSession({
        configuration,
        now: NOW,
        tokenHash: hashSessionToken(token),
      }),
    ).not.toBeNull();
    expect(
      await prisma.session.findUnique({ where: { id: session.id } }),
    ).toMatchObject({
      absoluteExpiresAt,
      idleExpiresAt: new Date(NOW.getTime() + DAY_MILLISECONDS),
      lastUsedAt: NOW,
    });
  });

  it("caps a sliding idle expiry at the immutable absolute expiry", async () => {
    const absoluteExpiresAt = new Date(NOW.getTime() + 60 * 60 * 1000);
    const { session, token } = await seedSession({
      absoluteExpiresAt,
      idleExpiresAt: new Date(NOW.getTime() + 30 * 60 * 1000),
      lastUsedAt: new Date(NOW.getTime() - 15 * 60 * 1000),
    });
    const repository = createPrismaAuthenticationSessionRepository(prisma);

    expect(
      await repository.resolveSession({
        configuration,
        now: NOW,
        tokenHash: hashSessionToken(token),
      }),
    ).not.toBeNull();
    expect(
      await prisma.session.findUnique({ where: { id: session.id } }),
    ).toMatchObject({
      absoluteExpiresAt,
      idleExpiresAt: absoluteExpiresAt,
      lastUsedAt: NOW,
    });
  });

  it("fails closed when a required persisted touch fails", async () => {
    const lastUsedAt = new Date(NOW.getTime() - 15 * 60 * 1000);
    const { session, token } = await seedSession({ lastUsedAt });
    const touchFailingPrisma = prisma.$extends({
      query: {
        session: {
          updateMany() {
            throw new Error("injected session-touch failure");
          },
        },
      },
    });
    const repository =
      createPrismaAuthenticationSessionRepository(touchFailingPrisma);

    await expect(
      repository.resolveSession({
        configuration,
        now: NOW,
        tokenHash: hashSessionToken(token),
      }),
    ).rejects.toThrow("injected session-touch failure");
    expect(
      await prisma.session.findUnique({ where: { id: session.id } }),
    ).toMatchObject({
      idleExpiresAt: session.idleExpiresAt,
      lastUsedAt,
    });
  });

  it.each([
    {
      name: "idle-expired",
      values: {
        idleExpiresAt: NOW,
        lastUsedAt: new Date(NOW.getTime() - 60 * 60 * 1000),
      },
    },
    {
      name: "absolute-expired",
      values: {
        absoluteExpiresAt: NOW,
        idleExpiresAt: new Date(NOW.getTime() - 1),
        lastUsedAt: new Date(NOW.getTime() - 60 * 60 * 1000),
      },
    },
    { name: "revoked", values: { revokedAt: new Date(NOW.getTime() - 1) } },
    { name: "disabled-user", values: { status: "DISABLED" as const } },
    { name: "unverified-user", values: { emailVerifiedAt: null } },
  ])(
    "denies a $name session without reviving or touching it",
    async ({ values }) => {
      const { session, token } = await seedSession(values);
      const repository = createPrismaAuthenticationSessionRepository(prisma);

      await expect(
        repository.resolveSession({
          configuration,
          now: NOW,
          tokenHash: hashSessionToken(token),
        }),
      ).resolves.toBeNull();
      expect(
        await prisma.session.findUnique({ where: { id: session.id } }),
      ).toMatchObject({
        idleExpiresAt: session.idleExpiresAt,
        lastUsedAt: session.lastUsedAt,
      });
    },
  );
});
