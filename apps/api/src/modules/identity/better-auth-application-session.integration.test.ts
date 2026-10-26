import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import express, { type Request, type ErrorRequestHandler } from "express";
import { createServer } from "node:http";
import { createBetterAuthApplicationRouter } from "./better-auth-application-router.ts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../../generated/prisma/client.ts";
import { loadTestDatabaseEnvironment } from "../../test/database-environment.ts";
import { createBetterAuthApplicationSessionService } from "./better-auth-application-session.ts";
import { createBetterAuthNative } from "./better-auth-native.ts";
import { createBetterAuthSessionResolver } from "./better-auth-bridge.ts";
import { createPrismaBetterAuthSessionRepository } from "./better-auth-session-repository.ts";
import { createLoginLimiter } from "./login-limiter.ts";
import { hashPassword } from "./password-hasher.ts";
import { createAuthenticationMiddleware } from "./authentication-context.ts";
import { createPrismaAuthenticationSessionRepository } from "./authentication-repository.ts";
import { createApp } from "../../app.ts";
import { startApiServer } from "../../server.ts";

const prisma = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: loadTestDatabaseEnvironment().TEST_DATABASE_URL,
    idleTimeoutMillis: 0,
  }),
});
// The installed adapter indexes Prisma by PascalCase; its delegates differ from camelCase.
function isSessionDelegate(
  value: unknown,
): value is typeof prisma.betterAuthSession {
  return (
    typeof value === "object" &&
    value !== null &&
    "create" in value &&
    typeof value.create === "function" &&
    "deleteMany" in value &&
    typeof value.deleteMany === "function"
  );
}
const nativeSessionDelegate: unknown = Reflect.get(prisma, "BetterAuthSession");
if (!isSessionDelegate(nativeSessionDelegate))
  throw new Error("Native session delegate unavailable");
const origin = "https://web.example.test";
const secret = "d4-isolated-test-only-secret-not-real";
const configuration = {
  secureCookie: true,
  absoluteTimeoutMilliseconds: 604800000,
  idleTimeoutMilliseconds: 86400000,
  touchIntervalMilliseconds: 900000,
};
const native = createBetterAuthNative({
  prisma,
  secret,
  publicWebOrigin: origin,
  secureCookie: true,
});
const service = createBetterAuthApplicationSessionService({
  prisma,
  native,
  publicWebOrigin: origin,
  configuration,
  limiter: createLoginLimiter(),
  pendingRegistrationService: {
    provePassword: async () => ({ outcome: "invalid" }),
  },
});
const resolver = createBetterAuthSessionResolver({
  native,
  repository: createPrismaBetterAuthSessionRepository(prisma),
  configuration,
  publicWebOrigin: origin,
});
const password = "  isolated password é🔒  ";
let hash: string;
beforeAll(async () => {
  hash = await hashPassword(password);
});
afterAll(async () => {
  await prisma.$disconnect();
});
async function account() {
  const user = await prisma.user.create({
    data: {
      email: `${randomUUID()}@example.test`,
      emailVerified: true,
      emailVerifiedAt: new Date(),
      nativeRegistrationCompletedAt: new Date(),
      betterAuthAccounts: {
        create: {
          accountId: "temporary",
          providerId: "credential",
          password: hash,
        },
      },
    },
  });
  await prisma.betterAuthAccount.updateMany({
    where: { userId: user.id },
    data: { accountId: user.id },
  });
  return user;
}
async function login(email: string, credential = password, cookie = "") {
  return service.login(
    { email, password: credential },
    new Headers({ origin, cookie }),
  );
}
async function establish(email: string) {
  const result = await login(email);
  if (result.outcome !== "authenticated")
    throw new Error(`Login failed: ${result.outcome}`);
  const cookie = result.cookies[0]?.split(";")[0];
  if (!cookie) throw new Error("No cookie");
  const session = await native.api.getSession({
    headers: new Headers({ cookie }),
    query: { disableCookieCache: true, disableRefresh: true },
  });
  if (!session) throw new Error("Native cookie unresolved");
  return { result, cookie, session };
}
function request(cookie: string): Request {
  return { method: "GET", headers: { cookie } } as Request;
}
describe("native APPLICATION lifecycle on guarded PostgreSQL", () => {
  it("binds PHC login to APPLICATION/current version and real native cookie/Bridge; rejects tampering and revokes on logout", async () => {
    const user = await account();
    const { result, cookie, session } = await establish(user.email);
    expect(result.user).toEqual({
      id: user.id,
      email: user.email,
      displayName: null,
    });
    expect(result.cookies[0]).toMatch(/HttpOnly/i);
    expect(result.cookies[0]).toMatch(/Secure/i);
    expect(result.cookies[0]).toMatch(/SameSite=Lax/i);
    expect(result.cookies[0]).not.toMatch(/Domain=/i);
    const stored = await prisma.betterAuthSession.findUniqueOrThrow({
      where: { id: session.session.id },
    });
    expect(stored.stockwisePurpose).toBe("APPLICATION");
    expect(stored.stockwiseCredentialVersion).toBe(user.credentialVersion);
    expect((await resolver(request(cookie)))?.actor.id).toBe(user.id);
    expect(await resolver(request(`${cookie}x`))).toBeNull();
    expect(await resolver(request(`${cookie}; ${cookie}`))).toBeNull();
    expect(
      (await service.logout(new Headers({ origin, cookie }))).outcome,
    ).toBe("logged_out");
    expect(await resolver(request(cookie))).toBeNull();
    expect(
      await prisma.betterAuthSession.findUnique({ where: { id: stored.id } }),
    ).toBeNull();
  });
  it("rejects a real Native session on a separately composed Legacy server", async () => {
    const user = await account();
    const { cookie } = await establish(user.email);
    expect(await resolver(request(cookie))).not.toBeNull();
    const router = express.Router();
    router.get(
      "/protected",
      createAuthenticationMiddleware({
        configuration,
        repository: createPrismaAuthenticationSessionRepository(prisma),
      }),
      (_request, response) => response.json({ authorized: true }),
    );
    const server = await startApiServer(
      createApp({
        apiRouter: router,
        logger: { info() {}, error() {} },
      }),
      { host: "127.0.0.1", port: 0 },
    );
    try {
      const response = await fetch(
        `http://127.0.0.1:${server.address.port}/api/v1/protected`,
        {
          headers: { cookie },
        },
      );
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({
        error: { code: "AUTHENTICATION_REQUIRED" },
      });
      expect(response.headers.has("set-cookie")).toBe(false);
    } finally {
      await server.stop();
    }
  });
  it("logout-all rejects unauthenticated/cross-origin requests and revokes every authenticated session", async () => {
    const user = await account();
    const first = await establish(user.email);
    const second = await establish(user.email);
    const other = await account();
    const unrelated = await establish(other.email);
    expect(await resolver(request(first.cookie))).not.toBeNull();
    expect(await resolver(request(second.cookie))).not.toBeNull();
    expect(await service.logoutAll(new Headers({ origin }))).toEqual({
      outcome: "authentication_required",
    });
    expect(
      await service.logoutAll(
        new Headers({
          origin: "https://attacker.example.test",
          cookie: first.cookie,
        }),
      ),
    ).toEqual({ outcome: "forbidden" });
    expect(await resolver(request(first.cookie))).not.toBeNull();
    expect(await resolver(request(second.cookie))).not.toBeNull();
    expect(
      await service.logoutAll(new Headers({ origin, cookie: first.cookie })),
    ).toMatchObject({ outcome: "logged_out" });
    expect(await resolver(request(first.cookie))).toBeNull();
    expect(await resolver(request(second.cookie))).toBeNull();
    expect(await resolver(request(unrelated.cookie))).not.toBeNull();
    expect(
      await prisma.betterAuthSession.count({ where: { userId: user.id } }),
    ).toBe(0);
  });
  it("does not revoke sessions for a native cookie invalidated by credential-version change", async () => {
    const user = await account();
    const { cookie, session } = await establish(user.email);
    await prisma.user.update({
      where: { id: user.id },
      data: { credentialVersion: { increment: 1 } },
    });
    expect(await service.logoutAll(new Headers({ origin, cookie }))).toEqual({
      outcome: "authentication_required",
    });
    expect(
      await prisma.betterAuthSession.findUnique({
        where: { id: session.session.id },
      }),
    ).not.toBeNull();
  });
  it("retains every session when logout-all persistence fails", async () => {
    const user = await account();
    const first = await establish(user.email);
    const second = await establish(user.email);
    const functionName = `logout_test_fail_${randomUUID().replaceAll("-", "")}`;
    const triggerName = `logout_test_fail_${randomUUID().replaceAll("-", "")}`;
    await prisma.$executeRawUnsafe(
      `CREATE FUNCTION "${functionName}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.user_id = '${user.id}'::uuid THEN RAISE EXCEPTION 'synthetic revocation failure'; END IF; RETURN OLD; END $$`,
    );
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER "${triggerName}" BEFORE DELETE ON better_auth_sessions FOR EACH ROW EXECUTE FUNCTION "${functionName}"()`,
    );
    try {
      await expect(
        service.logoutAll(new Headers({ origin, cookie: first.cookie })),
      ).rejects.toThrow("synthetic revocation failure");
    } finally {
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS "${triggerName}" ON better_auth_sessions`,
      );
      await prisma.$executeRawUnsafe(
        `DROP FUNCTION IF EXISTS "${functionName}"()`,
      );
    }
    expect(await resolver(request(first.cookie))).not.toBeNull();
    expect(await resolver(request(second.cookie))).not.toBeNull();
  });
  it.each([65, 128])(
    "accepts %i supplementary code points against the exact PHC",
    async (length) => {
      const user = await account();
      const unicodePassword = "\u{1f512}".repeat(length);
      await prisma.betterAuthAccount.updateMany({
        where: { userId: user.id },
        data: { password: await hashPassword(unicodePassword) },
      });
      expect((await login(user.email, unicodePassword)).outcome).toBe(
        "authenticated",
      );
      expect(
        await prisma.betterAuthSession.count({
          where: { userId: user.id, stockwisePurpose: "APPLICATION" },
        }),
      ).toBe(1);
    },
  );
  it("rejects 129 supplementary code points as input without a session", async () => {
    const user = await account();
    expect(await login(user.email, "\u{1f512}".repeat(129))).toEqual({
      outcome: "validation_error",
    });
    expect(
      await prisma.betterAuthSession.count({ where: { userId: user.id } }),
    ).toBe(0);
  });
  it.each([
    "wrong_password",
    "unverified",
    "disabled",
    "unfinished",
    "missing_account",
  ])("creates no session for %s", async (state) => {
    const user = await account();
    if (state === "unverified")
      await prisma.user.update({
        where: { id: user.id },
        data: { emailVerified: false, emailVerifiedAt: null },
      });
    if (state === "disabled")
      await prisma.user.update({
        where: { id: user.id },
        data: { status: "DISABLED", disabledAt: new Date() },
      });
    if (state === "unfinished")
      await prisma.user.update({
        where: { id: user.id },
        data: { nativeRegistrationCompletedAt: null },
      });
    if (state === "missing_account")
      await prisma.betterAuthAccount.deleteMany({ where: { userId: user.id } });
    expect(
      await login(
        user.email,
        state === "wrong_password" ? "wrong test-only password" : password,
      ),
    ).toEqual({ outcome: "invalid" });
    if (["unverified", "disabled", "unfinished"].includes(state)) {
      for (let attempt = 0; attempt < 6; attempt++)
        expect(await login(user.email)).toEqual({ outcome: "invalid" });
      for (let attempt = 0; attempt < 5; attempt++)
        expect(await login(user.email, "wrong test-only password")).toEqual({
          outcome: "invalid",
        });
      expect(
        (await login(user.email, "wrong test-only password")).outcome,
      ).toBe("limited");
    }
    expect(
      await prisma.betterAuthSession.count({ where: { userId: user.id } }),
    ).toBe(0);
  });
  it("rejects missing accounts generically", async () => {
    expect(await login(`${randomUUID()}@example.test`)).toEqual({
      outcome: "invalid",
    });
  });
  it("rejects stale credential version and expiry immediately", async () => {
    const user = await account();
    const first = await establish(user.email);
    await prisma.user.update({
      where: { id: user.id },
      data: { credentialVersion: { increment: 1 } },
    });
    expect(await resolver(request(first.cookie))).toBeNull();
    const second = await establish(user.email);
    await prisma.betterAuthSession.update({
      where: { id: second.session.session.id },
      data: { expiresAt: new Date(Date.now() - 1) },
    });
    expect(await resolver(request(second.cookie))).toBeNull();
  });
  it("rotates only the presented session and serializes concurrent failure admission", async () => {
    const user = await account();
    const first = await establish(user.email);
    expect((await login(user.email, password, first.cookie)).outcome).toBe(
      "authenticated",
    );
    expect(await resolver(request(first.cookie))).toBeNull();
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () =>
        login(user.email, "wrong test-only password"),
      ),
    );
    expect(
      attempts.filter((value) => value.outcome === "invalid"),
    ).toHaveLength(5);
    expect(
      attempts.filter((value) => value.outcome === "limited"),
    ).toHaveLength(3);
    expect((await login(user.email)).outcome).toBe("limited");
  });
  it("does not report logout success when native deletion silently fails", async () => {
    const user = await account();
    const { cookie, session } = await establish(user.email);
    const failure = vi
      .spyOn(nativeSessionDelegate, "deleteMany")
      .mockResolvedValueOnce({ count: 0 });
    try {
      const app = express();
      app.use(express.json());
      app.use(
        "/api/v1",
        createBetterAuthApplicationRouter({
          service,
          continuationKey: Buffer.alloc(32).toString("base64url"),
          publicWebOrigin: origin,
        }),
      );
      const fail: ErrorRequestHandler = (_error, _request, response, _next) => {
        void _next; // Express requires four parameters to recognize error middleware.
        response.status(500).json({ error: "Internal server error" });
      };
      app.use(fail);
      const server = createServer(app);
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      try {
        const address = server.address();
        if (!address || typeof address === "string")
          throw new Error("No listener");
        const response = await fetch(
          `http://127.0.0.1:${address.port}/api/v1/auth/logout`,
          {
            method: "POST",
            headers: { origin, cookie, "content-type": "application/json" },
            body: "{}",
          },
        );
        expect(response.status).toBe(500);
        expect(response.headers.get("set-cookie")).toBeNull();
        expect(failure).toHaveBeenCalled();
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    } finally {
      failure.mockRestore();
    }
    expect(
      await prisma.betterAuthSession.findUnique({
        where: { id: session.session.id },
      }),
    ).not.toBeNull();
    expect((await resolver(request(cookie)))?.actor.id).toBe(user.id);
  });
  it.each(["reset", "disabled", "unfinished"])(
    "denies and compensates a %s race before cookie release",
    async (state) => {
      const user = await account();
      const create = nativeSessionDelegate.create.bind(nativeSessionDelegate);
      const race = vi
        .spyOn(nativeSessionDelegate, "create")
        .mockImplementationOnce((args) => {
          const pending = create(args);
          const then = pending.then.bind(pending);
          pending.then = (fulfilled, rejected) =>
            then(async (provisional) => {
              expect(provisional.stockwisePurpose).toBeNull();
              expect(provisional.stockwiseCredentialVersion).toBeNull();
              // This committed mutation must not wait behind password-verification row locks.
              await prisma.$transaction(async (tx) => {
                await tx.$queryRaw`SELECT id FROM users WHERE id = ${user.id}::uuid FOR UPDATE`;
                if (state === "reset") {
                  await tx.user.update({
                    where: { id: user.id },
                    data: {
                      credentialVersion: { increment: 1 },
                      passwordChangedAt: new Date(),
                    },
                  });
                  await tx.betterAuthAccount.updateMany({
                    where: { userId: user.id },
                    data: {
                      password: await hashPassword(
                        "replacement test-only password",
                      ),
                    },
                  });
                } else {
                  await tx.user.update({
                    where: { id: user.id },
                    data:
                      state === "disabled"
                        ? { status: "DISABLED", disabledAt: new Date() }
                        : { nativeRegistrationCompletedAt: null },
                  });
                }
              });
              return provisional;
            }).then(fulfilled, rejected);
          return pending;
        });
      try {
        expect(await login(user.email)).toEqual({ outcome: "invalid" });
        expect(
          await prisma.betterAuthSession.count({ where: { userId: user.id } }),
        ).toBe(0);
        for (let attempt = 0; attempt < 5; attempt++)
          expect(await login(user.email, "wrong test-only password")).toEqual({
            outcome: "invalid",
          });
        expect(
          (await login(user.email, "wrong test-only password")).outcome,
        ).toBe("limited");
      } finally {
        race.mockRestore();
      }
    },
  );
  it.each([false, true])(
    "preserves finalization failure when compensation fails: %s",
    async (cleanupFails) => {
      const user = await account();
      const original = new Error("Test-only finalization failure");
      const finalization = vi
        .spyOn(prisma, "$transaction")
        .mockRejectedValueOnce(original);
      const cleanup = vi.spyOn(prisma.betterAuthSession, "deleteMany");
      if (cleanupFails)
        cleanup.mockRejectedValueOnce(new Error("Test-only cleanup failure"));
      try {
        await expect(login(user.email)).rejects.toBe(original);
        expect(cleanup).toHaveBeenCalled();
        const sessions = await prisma.betterAuthSession.findMany({
          where: { userId: user.id },
        });
        if (cleanupFails) {
          expect(sessions).toHaveLength(1);
          expect(sessions[0]?.stockwisePurpose).toBeNull();
          expect(sessions[0]?.stockwiseCredentialVersion).toBeNull();
        } else {
          expect(sessions).toEqual([]);
        }
      } finally {
        finalization.mockRestore();
        cleanup.mockRestore();
        await prisma.betterAuthSession.deleteMany({
          where: { userId: user.id },
        });
      }
    },
  );
  it("enforces Bridge idle and absolute boundaries independently of native expiry", async () => {
    const user = await account();
    const { cookie, session } = await establish(user.email);
    const stored = await prisma.betterAuthSession.findUniqueOrThrow({
      where: { id: session.session.id },
    });
    for (const cutoff of [
      stored.updatedAt.getTime() + configuration.idleTimeoutMilliseconds,
      stored.createdAt.getTime() + configuration.absoluteTimeoutMilliseconds,
    ]) {
      const boundary = createBetterAuthSessionResolver({
        native,
        repository: createPrismaBetterAuthSessionRepository(prisma),
        configuration,
        publicWebOrigin: origin,
        now: () => new Date(cutoff),
      });
      expect(await boundary(request(cookie))).toBeNull();
    }
  });

  it("slides idle activity at fifteen minutes without rotating identity or extending absolute expiry", async () => {
    const user = await account();
    const { cookie, session } = await establish(user.email);
    const initial = await prisma.betterAuthSession.findUniqueOrThrow({
      where: { id: session.session.id },
    });
    let time = initial.updatedAt.getTime();
    const active = createBetterAuthSessionResolver({
      native,
      repository: createPrismaBetterAuthSessionRepository(prisma),
      configuration,
      publicWebOrigin: origin,
      now: () => new Date(time),
    });
    const stored = () =>
      prisma.betterAuthSession.findUniqueOrThrow({
        where: { id: initial.id },
      });
    time += configuration.touchIntervalMilliseconds - 1;
    expect((await active(request(cookie)))?.sessionId).toBe(initial.id);
    expect((await stored()).updatedAt).toEqual(initial.updatedAt);
    time += 1;
    expect((await active(request(cookie)))?.actor.id).toBe(user.id);
    expect((await stored()).updatedAt.getTime()).toBe(time);
    // Keep activity below the idle boundary while crossing the original idle deadline.
    for (let halfDay = 1; halfDay <= 13; halfDay++) {
      time = initial.createdAt.getTime() + halfDay * 43200000;
      expect((await active(request(cookie)))?.sessionId).toBe(initial.id);
    }
    expect(await stored()).toMatchObject({
      id: initial.id,
      token: initial.token,
      createdAt: initial.createdAt,
      expiresAt: initial.expiresAt,
      stockwisePurpose: "APPLICATION",
      stockwiseCredentialVersion: initial.stockwiseCredentialVersion,
    });
    const lastActivity = (await stored()).updatedAt;
    time =
      initial.createdAt.getTime() + configuration.absoluteTimeoutMilliseconds;
    expect(await active(request(cookie))).toBeNull();
    expect((await stored()).updatedAt).toEqual(lastActivity);
  });

  it("expires after inactivity following a successful activity touch and never revives", async () => {
    const user = await account();
    const { cookie, session } = await establish(user.email);
    const initial = await prisma.betterAuthSession.findUniqueOrThrow({
      where: { id: session.session.id },
    });
    let time =
      initial.updatedAt.getTime() + configuration.touchIntervalMilliseconds;
    const inactive = createBetterAuthSessionResolver({
      native,
      repository: createPrismaBetterAuthSessionRepository(prisma),
      configuration,
      publicWebOrigin: origin,
      now: () => new Date(time),
    });
    expect((await inactive(request(cookie)))?.actor.id).toBe(user.id);
    const lastActivity = new Date(time);
    time += configuration.idleTimeoutMilliseconds;
    expect(await inactive(request(cookie))).toBeNull();
    expect(
      (
        await prisma.betterAuthSession.findUniqueOrThrow({
          where: { id: initial.id },
        })
      ).updatedAt,
    ).toEqual(lastActivity);
  });

  it("rejects the fixed absolute boundary even if native expiry is later and idle activity is fresh", async () => {
    const user = await account();
    const { cookie, session } = await establish(user.email);
    const initial = await prisma.betterAuthSession.findUniqueOrThrow({
      where: { id: session.session.id },
    });
    const deadline =
      initial.createdAt.getTime() + configuration.absoluteTimeoutMilliseconds;
    await prisma.betterAuthSession.update({
      where: { id: initial.id },
      data: {
        expiresAt: new Date(deadline + configuration.idleTimeoutMilliseconds),
        updatedAt: new Date(deadline - 1),
      },
    });
    const expired = createBetterAuthSessionResolver({
      native,
      repository: createPrismaBetterAuthSessionRepository(prisma),
      configuration,
      publicWebOrigin: origin,
      now: () => new Date(deadline),
    });
    expect(await expired(request(cookie))).toBeNull();
    expect(
      (
        await prisma.betterAuthSession.findUniqueOrThrow({
          where: { id: initial.id },
        })
      ).updatedAt.getTime(),
    ).toBe(deadline - 1);
  });

  it.each([
    "disabled",
    "unverified",
    "unfinished",
    "credential_version",
    "purpose",
    "missing_account",
  ])("does not touch a due session with %s authority", async (state) => {
    const user = await account();
    const { cookie, session } = await establish(user.email);
    const initial = await prisma.betterAuthSession.findUniqueOrThrow({
      where: { id: session.session.id },
    });
    if (state === "purpose")
      await prisma.betterAuthSession.update({
        where: { id: initial.id },
        data: { stockwisePurpose: null },
      });
    else if (state === "missing_account")
      await prisma.betterAuthAccount.deleteMany({ where: { userId: user.id } });
    else
      await prisma.user.update({
        where: { id: user.id },
        data:
          state === "disabled"
            ? { status: "DISABLED", disabledAt: new Date() }
            : state === "unverified"
              ? { emailVerified: false, emailVerifiedAt: null }
              : state === "unfinished"
                ? { nativeRegistrationCompletedAt: null }
                : { credentialVersion: { increment: 1 } },
      });
    const before = await prisma.betterAuthSession.findUniqueOrThrow({
      where: { id: initial.id },
    });
    const invalid = createBetterAuthSessionResolver({
      native,
      repository: createPrismaBetterAuthSessionRepository(prisma),
      configuration,
      publicWebOrigin: origin,
      now: () =>
        new Date(
          before.updatedAt.getTime() + configuration.touchIntervalMilliseconds,
        ),
    });
    expect(await invalid(request(cookie))).toBeNull();
    expect(
      (
        await prisma.betterAuthSession.findUniqueOrThrow({
          where: { id: initial.id },
        })
      ).updatedAt,
    ).toEqual(before.updatedAt);
  });

  it("fails closed and rolls back when the required activity write fails", async () => {
    const user = await account();
    const { cookie, session } = await establish(user.email);
    const initial = await prisma.betterAuthSession.findUniqueOrThrow({
      where: { id: session.session.id },
    });
    const failure = new Error("Test-only activity write failure");
    const active = createBetterAuthSessionResolver({
      native,
      repository: createPrismaBetterAuthSessionRepository({
        $transaction: (action) =>
          prisma.$transaction(async (tx) => {
            const write = vi
              .spyOn(tx.betterAuthSession, "update")
              .mockRejectedValueOnce(failure);
            try {
              return await action(tx);
            } finally {
              write.mockRestore();
            }
          }),
      }),
      configuration,
      publicWebOrigin: origin,
      now: () =>
        new Date(
          initial.updatedAt.getTime() + configuration.touchIntervalMilliseconds,
        ),
    });
    await expect(active(request(cookie))).rejects.toBe(failure);
    expect(
      (
        await prisma.betterAuthSession.findUniqueOrThrow({
          where: { id: initial.id },
        })
      ).updatedAt,
    ).toEqual(initial.updatedAt);
  });

  it("rejects stale native selection when logout commits before activity resolution", async () => {
    const user = await account();
    const { cookie, session } = await establish(user.email);
    const selected = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const active = createBetterAuthSessionResolver({
      native: {
        api: {
          async getSession(input) {
            const result = await native.api.getSession(input);
            selected.resolve();
            await release.promise;
            return result;
          },
        },
      },
      repository: createPrismaBetterAuthSessionRepository(prisma),
      configuration,
      publicWebOrigin: origin,
      now: () => new Date(Date.now() + configuration.touchIntervalMilliseconds),
    });
    const pending = active(request(cookie));
    try {
      await selected.promise;
      expect(
        (await service.logout(new Headers({ origin, cookie }))).outcome,
      ).toBe("logged_out");
    } finally {
      release.resolve();
    }
    expect(await pending).toBeNull();
    expect(
      await prisma.betterAuthSession.findUnique({
        where: { id: session.session.id },
      }),
    ).toBeNull();
  });

  it("cannot restore a session when logout contends with an in-flight activity write", async () => {
    const user = await account();
    const { cookie, session } = await establish(user.email);
    const writing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const active = createBetterAuthSessionResolver({
      native,
      repository: createPrismaBetterAuthSessionRepository({
        $transaction: (action) =>
          prisma.$transaction(async (tx) => {
            const update = tx.betterAuthSession.update.bind(
              tx.betterAuthSession,
            );
            const write = vi
              .spyOn(tx.betterAuthSession, "update")
              .mockImplementationOnce((args) => {
                const pending = update(args);
                const then = pending.then.bind(pending);
                pending.then = (fulfilled, rejected) =>
                  then(async (result) => {
                    writing.resolve();
                    await release.promise;
                    return result;
                  }).then(fulfilled, rejected);
                return pending;
              });
            try {
              return await action(tx);
            } finally {
              write.mockRestore();
            }
          }),
      }),
      configuration,
      publicWebOrigin: origin,
      now: () => new Date(Date.now() + configuration.touchIntervalMilliseconds),
    });
    const touching = active(request(cookie));
    await writing.promise;
    const logout = service.logout(new Headers({ origin, cookie }));
    let blocked = false;
    try {
      for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
        const rows = await prisma.$queryRaw<{ blocked: boolean }[]>`
          SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database()
              AND wait_event_type = 'Lock'
              AND query ILIKE '%better_auth_sessions%'
          ) AS blocked
        `;
        blocked = rows[0]?.blocked === true;
      }
    } finally {
      release.resolve();
    }
    const [authority, result] = await Promise.all([touching, logout]);
    expect(blocked).toBe(true);
    expect(authority?.sessionId).toBe(session.session.id);
    expect(result.outcome).toBe("logged_out");
    expect(await resolver(request(cookie))).toBeNull();
    expect(
      await prisma.betterAuthSession.findUnique({
        where: { id: session.session.id },
      }),
    ).toBeNull();
  });
});
