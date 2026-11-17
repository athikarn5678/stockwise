import { createHash, randomBytes, randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { Router, type Request } from "express";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../app.ts";
import { loadApiEnvironment } from "../../environment.ts";
import { PrismaClient } from "../../generated/prisma/client.ts";
import { loadTestDatabaseEnvironment } from "../../test/database-environment.ts";
import { startApiServer, type RunningApiServer } from "../../server.ts";
import { createBetterAuthApplicationRouter } from "./better-auth-application-router.ts";
import { createBetterAuthApplicationRuntime } from "./better-auth-application-runtime.ts";
import { createBetterAuthApplicationSessionService } from "./better-auth-application-session.ts";
import { createBetterAuthNative } from "./better-auth-native.ts";
import { createLoginLimiter } from "./login-limiter.ts";
import { requireBetterAuthSecret } from "./better-auth-secret.ts";
import { createPendingRegistrationRepository } from "./pending-registration-repository.ts";
import { createPendingRegistrationRouter } from "./pending-registration-router.ts";
import { createPendingRegistrationService } from "./pending-registration-service.ts";
import { hashPassword } from "./password-hasher.ts";
import { verifyPassword } from "./password-hasher.ts";
import { createNativeFixtureUser } from "../../test/native-user-fixture.ts";
import {
  createVerificationSecurity,
  verificationSecurityConfiguration,
} from "./verification-security.ts";

type Endpoint = "login" | "verification-password-proof";
type GateModel = "user" | "pendingRegistration";
type Deferred = { promise: Promise<void>; resolve: () => void };

const origin = "http://localhost:3102";
const password = "a sufficiently long test password";
const wrongPassword = "a sufficiently long incorrect password";
const environment = loadApiEnvironment({
  DATABASE_URL: loadTestDatabaseEnvironment().TEST_DATABASE_URL,
  STOCKWISE_RUNTIME_ENV: "test",
  STOCKWISE_API_PORT: "3103",
  STOCKWISE_PUBLIC_WEB_ORIGIN: origin,
  STOCKWISE_BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
  STOCKWISE_INVITATION_CONTINUATION_KEY: randomBytes(32).toString("base64url"),
  STOCKWISE_ANALYTICS_CURSOR_HMAC_KEY: Buffer.alloc(32, 17).toString(
    "base64url",
  ),
  STOCKWISE_VERIFICATION_OTP_KEY: Buffer.alloc(32, 18).toString("base64url"),
  STOCKWISE_VERIFICATION_OTP_KEY_ID: "1",
  STOCKWISE_VERIFICATION_PROOF_KEY: Buffer.alloc(32, 19).toString("base64url"),
  STOCKWISE_VERIFICATION_PROOF_KEY_ID: "1",
});
const prisma = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: environment.DATABASE_URL,
    idleTimeoutMillis: 0,
  }),
});
const pendingRepository = createPendingRegistrationRepository(prisma);
const security = createVerificationSecurity(
  verificationSecurityConfiguration(environment),
);
const gates = new Map<
  string,
  { model: GateModel; entered: Deferred; release: Deferred; used: boolean }
>();
const observedEmails = new Set<string>();
let observePath: ((path: string) => void) | undefined;
let passwordHash: string;

function deferred(): Deferred {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { promise, resolve: () => resolve() };
}

async function pauseAfterQuery(model: GateModel, email: string | undefined) {
  const gate = email === undefined ? undefined : gates.get(email);
  if (gate !== undefined && gate.model === model && !gate.used) {
    gate.used = true;
    gate.entered.resolve();
    await gate.release.promise;
  }
}

const prismaWithGate = prisma.$extends({
  query: {
    pendingRegistration: {
      async findUnique({ args, query }) {
        const result = await query(args);
        await pauseAfterQuery(
          "pendingRegistration",
          typeof args.where.email === "string" ? args.where.email : undefined,
        );
        return result;
      },
    },
    user: {
      async findUnique({ args, query }) {
        const result = await query(args);
        await pauseAfterQuery(
          "user",
          typeof args.where.email === "string" ? args.where.email : undefined,
        );
        return result;
      },
    },
  },
});

let runtime: { router: Router; drain(): Promise<void> };
let server: RunningApiServer;
let base: string;

beforeAll(async () => {
  passwordHash = await hashPassword(password);
  runtime = createBetterAuthApplicationRuntime({
    environment,
    prisma: prismaWithGate as unknown as PrismaClient,
    emailProvider: { async send() {} },
    onDeliveryFailure() {},
  });
  const router = Router();
  router.use((request: Request, _response, next) => {
    observePath?.(request.originalUrl);
    next();
  });
  router.use(runtime.router);
  server = await startApiServer(
    createApp({ apiRouter: router, logger: { info() {}, error() {} } }),
    { host: "127.0.0.1", port: 0 },
  );
  base = `http://127.0.0.1:${server.address.port}/api/v1`;
});

afterEach(async () => {
  for (const gate of gates.values()) gate.release.resolve();
  gates.clear();
  for (const email of observedEmails) {
    const key = createHash("sha256").update(email).digest("hex");
    await prisma.pendingRegistrationCredentialAttempt.deleteMany({
      where: { key, purpose: "credential" },
    });
    await prisma.pendingRegistrationQuota.deleteMany({
      where: { key, purpose: "credential" },
    });
    await prisma.pendingRegistration.deleteMany({ where: { email } });
    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });
    if (user !== null) {
      await prisma.betterAuthAccount.deleteMany({ where: { userId: user.id } });
      await prisma.user.deleteMany({ where: { id: user.id } });
    }
  }
  observedEmails.clear();
});

afterAll(async () => {
  await server?.stop();
  await runtime?.drain();
  await prisma.$disconnect();
});

async function stagePending(email: string) {
  observedEmails.add(email);
  const prepared = await pendingRepository.register({
    email,
    passwordHash,
    security,
  });
  if (prepared === null)
    throw new Error("Expected a fresh pending registration");
}

async function stageVerified(email: string) {
  observedEmails.add(email);
  // The credential account id is the user id, known before the insert. A shared
  // placeholder would let concurrent stagings collide on (provider_id,
  // account_id) until a later update; the uniqueness constraint is unchanged.
  const id = randomUUID();
  await prisma.user.create({
    data: {
      id,
      email,
      emailVerified: true,
      emailVerifiedAt: new Date(),
      nativeRegistrationCompletedAt: new Date(),
      betterAuthAccounts: {
        create: {
          accountId: id,
          providerId: "credential",
          password: passwordHash,
        },
      },
    },
  });
}

function blockAfterCredentialRead(email: string, model: GateModel) {
  const entered = deferred();
  const release = deferred();
  gates.set(email, { model, entered, release, used: false });
  return { entered: entered.promise, release };
}

async function post(endpoint: Endpoint, email: string, signal?: AbortSignal) {
  return fetch(`${base}/auth/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ email, password: wrongPassword }),
    ...(signal === undefined ? {} : { signal }),
  });
}

async function addFourFailures(email: string, endpoint: Endpoint) {
  for (let failure = 0; failure < 4; failure += 1) {
    const response = await post(endpoint, email);
    expect(response.status).toBe(401);
  }
}

async function waitForRequest(path: string) {
  const received = deferred();
  observePath = (observedPath) => {
    if (observedPath === path) received.resolve();
  };
  await received.promise;
  observePath = undefined;
}

async function expectFinalSlot(
  email: string,
  first: Response,
  second: Response,
  expectedDurableCount: number,
) {
  expect(first.status).toBe(401);
  expect(await first.json()).toMatchObject({
    error: { code: "INVALID_CREDENTIALS" },
  });
  expect(second.status).toBe(429);
  expect(second.headers.get("retry-after")).toBeTruthy();
  expect(await second.json()).toMatchObject({
    error: { code: "RATE_LIMITED" },
  });
  const key = createHash("sha256").update(email).digest("hex");
  const quota = await prisma.pendingRegistrationQuota.findUnique({
    where: { key_purpose: { key, purpose: "credential" } },
  });
  expect(quota?.count ?? 0).toBe(expectedDurableCount);
  expect(
    await prisma.pendingRegistrationCredentialAttempt.count({
      where: { key, purpose: "credential" },
    }),
  ).toBe(0);
}

describe("actual Native runtime shared login/proof admission", () => {
  it("rejects a concurrent credential-generation change after password demonstration in verified_login", async () => {
    const email = `${randomUUID()}@example.test`;
    const user = await createNativeFixtureUser(prisma, {
      id: randomUUID(),
      email,
      password,
      passwordHash,
    });
    observedEmails.add(email);
    const gate = blockAfterCredentialRead(email, "user");
    const pendingResponse = fetch(`${base}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ email, password }),
    });
    await gate.entered;
    try {
      await prisma.user.update({
        where: { id: user.id },
        data: {
          credentialVersion: { increment: 1 },
          passwordChangedAt: new Date(),
        },
      });
    } finally {
      gate.release.resolve();
    }
    const response = await pendingResponse;
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: "INVALID_CREDENTIALS" },
    });
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(
      await prisma.betterAuthSession.count({ where: { userId: user.id } }),
    ).toBe(0);
    const control = await fetch(`${base}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ email, password }),
    });
    expect(control.status).toBe(200);
    await prisma.betterAuthSession.deleteMany({ where: { userId: user.id } });
  });

  function blockablePendingService() {
    const demonstrated = deferred();
    const continueAuthority = deferred();
    const service = createPendingRegistrationService({
      delivery: { reserve: () => null, drain: async () => undefined },
      passwordHasher: { hash: hashPassword },
      passwordVerifier: {
        async verify(candidateHash, candidate) {
          const matches = await verifyPassword(candidateHash, candidate);
          demonstrated.resolve();
          await continueAuthority.promise;
          return matches;
        },
      },
      repository: pendingRepository,
      security,
    });
    return {
      demonstrated: demonstrated.promise,
      release: continueAuthority.resolve,
      service,
    };
  }

  it("rejects a concurrent generation change after password demonstration in pending_login", async () => {
    const email = `${randomUUID()}@example.test`;
    await stagePending(email);
    const fixture = blockablePendingService();
    const continuationKey = environment.STOCKWISE_INVITATION_CONTINUATION_KEY;
    if (continuationKey === undefined)
      throw new Error("The Native test environment lacks a continuation key.");
    const native = createBetterAuthNative({
      prisma,
      secret: requireBetterAuthSecret(environment),
      publicWebOrigin: origin,
      secureCookie: true,
    });
    const sessionService = createBetterAuthApplicationSessionService({
      prisma,
      native,
      publicWebOrigin: origin,
      configuration: {
        absoluteTimeoutMilliseconds: 604800000,
        idleTimeoutMilliseconds: 86400000,
        secureCookie: true,
        touchIntervalMilliseconds: 900000,
      },
      limiter: createLoginLimiter(),
      pendingRegistrationService: fixture.service,
    });
    const server = await startApiServer(
      createApp({
        apiRouter: createBetterAuthApplicationRouter({
          continuationKey,
          publicWebOrigin: origin,
          service: sessionService,
        }),
        logger: { info() {}, error() {} },
      }),
      { host: "127.0.0.1", port: 0 },
    );
    try {
      const pendingResponse = fetch(
        `http://${server.address.host}:${server.address.port}/api/v1/auth/login`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: origin },
          body: JSON.stringify({ email, password }),
        },
      );
      await fixture.demonstrated;
      try {
        await prisma.pendingRegistration.update({
          where: { email },
          data: { credentialVersion: { increment: 1 } },
        });
      } finally {
        fixture.release();
      }
      const response = await pendingResponse;
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({
        error: { code: "INVALID_CREDENTIALS" },
      });
      expect(response.headers.getSetCookie()).toEqual([]);
    } finally {
      await server.stop();
    }
    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
    expect(
      await prisma.pendingRegistration.findUniqueOrThrow({
        where: { email },
      }),
    ).toMatchObject({ credentialVersion: 2n, consumedAt: null });
    expect(
      await prisma.betterAuthSession.count({ where: { user: { email } } }),
    ).toBe(0);
  });

  it("rejects a concurrent generation change after password demonstration in fallback", async () => {
    const email = `${randomUUID()}@example.test`;
    await stagePending(email);
    const fixture = blockablePendingService();
    const server = await startApiServer(
      createApp({
        apiRouter: createPendingRegistrationRouter({
          pendingRegistrationService: fixture.service,
          publicWebOrigin: origin,
        }),
        logger: { info() {}, error() {} },
      }),
      { host: "127.0.0.1", port: 0 },
    );
    try {
      const pendingResponse = fetch(
        `http://${server.address.host}:${server.address.port}/api/v1/auth/verification-password-proof`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: origin },
          body: JSON.stringify({ email, password }),
        },
      );
      await fixture.demonstrated;
      try {
        await prisma.pendingRegistration.update({
          where: { email },
          data: { credentialVersion: { increment: 1 } },
        });
      } finally {
        fixture.release();
      }
      const response = await pendingResponse;
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({
        error: { code: "INVALID_CREDENTIALS" },
      });
      expect(response.headers.getSetCookie()).toEqual([]);
    } finally {
      await server.stop();
    }
    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
    expect(
      await prisma.pendingRegistration.findUniqueOrThrow({
        where: { email },
      }),
    ).toMatchObject({ credentialVersion: 2n, consumedAt: null });
    expect(
      await prisma.betterAuthSession.count({ where: { user: { email } } }),
    ).toBe(0);
  });

  it.each([
    {
      firstEndpoint: "verification-password-proof",
      secondEndpoint: "verification-password-proof",
      fixture: "pending",
      seedEndpoint: "verification-password-proof",
      durableCount: 5,
      gateModel: "pendingRegistration",
    },
    {
      firstEndpoint: "login",
      secondEndpoint: "verification-password-proof",
      fixture: "verified",
      seedEndpoint: "login",
      durableCount: 0,
      gateModel: "user",
    },
    {
      firstEndpoint: "verification-password-proof",
      secondEndpoint: "login",
      fixture: "verified",
      seedEndpoint: "login",
      durableCount: 1,
      gateModel: "pendingRegistration",
    },
  ] as const)(
    "serializes $firstEndpoint then $secondEndpoint after four failures",
    async ({
      firstEndpoint,
      secondEndpoint,
      fixture,
      seedEndpoint,
      durableCount,
      gateModel,
    }) => {
      const email = `${randomUUID()}@example.test`;
      if (fixture === "pending") await stagePending(email);
      else await stageVerified(email);
      await addFourFailures(email, seedEndpoint);
      const gate = blockAfterCredentialRead(email, gateModel);
      const first = post(firstEndpoint, email);
      await gate.entered;
      const secondArrived = waitForRequest(`/api/v1/auth/${secondEndpoint}`);
      const second = post(secondEndpoint, email);
      await secondArrived;
      gate.release.resolve();
      await expectFinalSlot(email, await first, await second, durableCount);
    },
  );

  it("keeps a different email progressing while proof is blocked", async () => {
    const firstEmail = `${randomUUID()}@example.test`;
    const secondEmail = `${randomUUID()}@example.test`;
    await Promise.all([stageVerified(firstEmail), stageVerified(secondEmail)]);
    const firstGate = blockAfterCredentialRead(
      firstEmail,
      "pendingRegistration",
    );
    const secondGate = blockAfterCredentialRead(
      secondEmail,
      "pendingRegistration",
    );
    const first = post("verification-password-proof", firstEmail);
    await firstGate.entered;
    const second = post("verification-password-proof", secondEmail);
    await secondGate.entered;
    secondGate.release.resolve();
    expect((await second).status).toBe(401);
    firstGate.release.resolve();
    expect((await first).status).toBe(401);
  });

  it("releases the shared queue when an in-flight proof client cancels", async () => {
    const email = `${randomUUID()}@example.test`;
    await stageVerified(email);
    await addFourFailures(email, "login");
    const gate = blockAfterCredentialRead(email, "pendingRegistration");
    const controller = new AbortController();
    const canceled = post(
      "verification-password-proof",
      email,
      controller.signal,
    );
    await gate.entered;
    const canceledResult = expect(canceled).rejects.toThrow();
    controller.abort();

    const nextArrived = waitForRequest("/api/v1/auth/login");
    const next = post("login", email);
    await nextArrived;
    gate.release.resolve();
    await canceledResult;
    expect((await next).status).toBe(429);
    const key = createHash("sha256").update(email).digest("hex");
    expect(
      (
        await prisma.pendingRegistrationQuota.findUniqueOrThrow({
          where: { key_purpose: { key, purpose: "credential" } },
        })
      ).count,
    ).toBe(1);
  });
});
