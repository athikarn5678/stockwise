import { createHash, randomBytes, randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { Router, type Request } from "express";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../app.ts";
import { loadApiEnvironment } from "../../environment.ts";
import { PrismaClient } from "../../generated/prisma/client.ts";
import { loadTestDatabaseEnvironment } from "../../test/database-environment.ts";
import { startApiServer, type RunningApiServer } from "../../server.ts";
import { createBetterAuthApplicationRuntime } from "./better-auth-application-runtime.ts";
import { createPendingRegistrationRepository } from "./pending-registration-repository.ts";
import { hashPassword } from "./password-hasher.ts";
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
