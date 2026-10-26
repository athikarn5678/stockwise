import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient, type Prisma } from "../../generated/prisma/client.ts";
import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "pg";
import { createApp } from "../../app.ts";
import { startApiServer } from "../../server.ts";
import { loadApiEnvironment } from "../../environment.ts";
import { loadTestDatabaseEnvironment } from "../../test/database-environment.ts";
import { createBetterAuthApplicationRuntime } from "./better-auth-application-runtime.ts";
import { getTrustedAuthenticationContext } from "./authentication-context.ts";
import { createPrismaAuthenticationRepository } from "./authentication-repository.ts";
import { createPrismaVerificationRepository } from "./verification-repository.ts";
import { createLoginService } from "./login-service.ts";
import { createLoginRouter } from "./login-router.ts";
import { createLoginLimiter } from "./login-limiter.ts";
import { argon2PasswordVerifier, hashPassword } from "./password-hasher.ts";
import { secureSessionTokenProvider } from "./session-token.ts";
import { testVerificationSecurity } from "../../test/identity-backend-fixture.ts";
import { createDisposableNativeTransition } from "../../../../../tests/e2e/better-auth-d5/native-transition.mts";
import { verifyLocalPostgresReceipt } from "../../../../../tests/e2e/better-auth-d5/local-runner.mts";
import { assertNativeCutoverReady } from "./better-auth-cutover-preflight.ts";
import { BETTER_AUTH_NATIVE_ENABLED } from "./better-auth-native.ts";
const deliveredMessages: { kind: string; url: string }[] = [];

const database = loadTestDatabaseEnvironment();
const receiptText = process.env.STOCKWISE_LOCAL_DATABASE_RECEIPT;
if (!receiptText) throw new Error("Disposable transition receipt is required.");
const receipt: unknown = JSON.parse(receiptText);
const origin = "https://web.example.test";
const legacyPassword = "disposable Legacy password 🔒";
const nativeSecret = randomBytes(32).toString("base64url");
let prisma = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: database.TEST_DATABASE_URL,
    idleTimeoutMillis: 0,
  }),
});
let nativeServer: { stop(): Promise<void> } | undefined;
let nativeRuntime: { drain(): Promise<void> } | undefined;
let activeWorker: ChildProcess | undefined;
const evidence = {
  events: [] as {
    step: string;
    observed: Record<string, string | number | boolean | null>;
  }[],
};
const evidenceFile = fileURLToPath(
  new URL(
    "../../../../../test-results/native-cutover-reconciliation.json",
    import.meta.url,
  ),
);
async function record(
  step: string,
  observed: Record<string, string | number | boolean | null>,
) {
  evidence.events.push({ step, observed });
  await mkdir(dirname(evidenceFile), { recursive: true });
  await writeFile(evidenceFile, JSON.stringify(evidence, null, 2));
}
await record("rehearsal-started", { status: "running" });
async function spawnNativeWorker(secret: string | null) {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["SystemRoot", "WINDIR", "PATH", "Path", "TEMP", "TMP"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  Object.assign(env, {
    DATABASE_URL: process.env.DATABASE_URL,
    TEST_DATABASE_URL: database.TEST_DATABASE_URL,
    STOCKWISE_ALLOW_STOCKWISE_TEST: "1",
    STOCKWISE_LOCAL_DATABASE_RECEIPT: receiptText,
    STOCKWISE_RUNTIME_ENV: "test",
    STOCKWISE_API_PORT: "3103",
    STOCKWISE_PUBLIC_WEB_ORIGIN: origin,
    STOCKWISE_ANALYTICS_CURSOR_HMAC_KEY: randomBytes(32).toString("base64url"),
    STOCKWISE_VERIFICATION_OTP_KEY: randomBytes(32).toString("base64url"),
    STOCKWISE_VERIFICATION_OTP_KEY_ID: "1",
    STOCKWISE_VERIFICATION_PROOF_KEY: randomBytes(32).toString("base64url"),
    STOCKWISE_VERIFICATION_PROOF_KEY_ID: "1",
  });
  if (secret !== null) env.STOCKWISE_BETTER_AUTH_SECRET = secret;
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      fileURLToPath(
        new URL(
          "../../../../../tests/e2e/better-auth-d5/native-cutover-worker.mts",
          import.meta.url,
        ),
      ),
    ],
    { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );
  activeWorker = child;
  child.stderr.resume();
  let buffered = "";
  const startup = Promise.withResolvers<{
    port: number | null;
    refused: boolean;
  }>();
  child.stdout.on("data", (chunk: Buffer) => {
    buffered += chunk.toString();
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      const ready = /^READY (\d+)$/.exec(line);
      if (ready?.[1])
        startup.resolve({ port: Number(ready[1]), refused: false });
      else if (line === "REFUSED")
        startup.resolve({ port: null, refused: true });
    }
  });
  child.once("error", startup.reject);
  child.once("close", () =>
    startup.reject(new Error("Native child exited before readiness.")),
  );
  // Real child-process watchdog, not a sleep: fake timers cannot bound an OS process.
  const timer = setTimeout(
    () => startup.reject(new Error("Native child readiness timed out.")),
    10_000,
  );
  try {
    return { child, ...(await startup.promise) };
  } finally {
    clearTimeout(timer);
  }
}

async function stopNativeWorker(child: ChildProcess, kill = false) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = Promise.withResolvers<void>();
  child.once("close", closed.resolve);
  if (kill) child.kill();
  else child.stdin?.end("STOP\n");
  await closed.promise;
}
async function cancelPreflightBeforeCommit(prisma: PrismaClient) {
  const pidReady = Promise.withResolvers<number>();
  const wrapped = new Proxy(prisma, {
    get(target, property, receiver) {
      if (property !== "$transaction")
        return Reflect.get(target, property, receiver);
      return (
        operation: (tx: Prisma.TransactionClient) => Promise<void>,
        options?: {
          isolationLevel?: Prisma.TransactionIsolationLevel;
          maxWait?: number;
          timeout?: number;
        },
      ) =>
        target.$transaction(async (tx) => {
          await operation(tx);
          const rows = await tx.$queryRaw<
            { pid: number }[]
          >`SELECT pg_backend_pid() AS pid`;
          pidReady.resolve(rows[0]!.pid);
          await tx.$queryRaw`SELECT pg_sleep(30)`;
        }, options);
    },
  }) as PrismaClient;
  const readiness = assertNativeCutoverReady(wrapped);
  const pid = await pidReady.promise;
  const canceller = new Client({
    connectionString: database.TEST_DATABASE_URL,
  });
  await canceller.connect();
  try {
    const result = await canceller.query<{ cancelled: boolean }>(
      "SELECT pg_cancel_backend($1) AS cancelled",
      [pid],
    );
    expect(result.rows[0]?.cancelled).toBe(true);
    await expect(readiness).rejects.toThrow(
      "Native cutover readiness check refused.",
    );
  } finally {
    await canceller.end();
  }
}

async function startNative() {
  const environment = loadApiEnvironment({
    DATABASE_URL: database.TEST_DATABASE_URL,
    STOCKWISE_RUNTIME_ENV: "test",
    STOCKWISE_API_PORT: "3103",
    STOCKWISE_PUBLIC_WEB_ORIGIN: origin,
    STOCKWISE_BETTER_AUTH_SECRET: nativeSecret,
    STOCKWISE_INVITATION_CONTINUATION_KEY:
      randomBytes(32).toString("base64url"),
    STOCKWISE_ANALYTICS_CURSOR_HMAC_KEY: randomBytes(32).toString("base64url"),
    STOCKWISE_VERIFICATION_OTP_KEY: randomBytes(32).toString("base64url"),
    STOCKWISE_VERIFICATION_OTP_KEY_ID: "1",
    STOCKWISE_VERIFICATION_PROOF_KEY: randomBytes(32).toString("base64url"),
    STOCKWISE_VERIFICATION_PROOF_KEY_ID: "1",
  });
  expect(() =>
    createBetterAuthApplicationRuntime({
      environment: {
        ...environment,
        STOCKWISE_BETTER_AUTH_SECRET: undefined,
      } as typeof environment,
      prisma,
      emailProvider: { async send() {} },
      onDeliveryFailure() {},
    }),
  ).toThrow(
    "Native authentication requires a dedicated canonical base64url secret of at least 32 bytes.",
  );
  expect(BETTER_AUTH_NATIVE_ENABLED).toBe(false);
  const runtime = createBetterAuthApplicationRuntime({
    environment,
    prisma,
    emailProvider: {
      async send(message) {
        deliveredMessages.push({ kind: message.kind, url: message.url });
      },
    },
    onDeliveryFailure() {},
  });
  runtime.router.get(
    "/cutover-protected",
    runtime.authenticationMiddleware,
    (_request, response) => {
      response.json({
        id: getTrustedAuthenticationContext(response)?.actor.id,
      });
    },
  );
  const server = await startApiServer(
    createApp({ apiRouter: runtime.router, logger: { error() {}, info() {} } }),
    { host: "127.0.0.1", port: 0 },
  );
  nativeRuntime = runtime;
  nativeServer = server;
  const base = `http://127.0.0.1:${server.address.port}/api/v1`;
  const post = (path: string, body: unknown, cookie?: string) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    });
  return { base, post };
}

async function startLegacy() {
  const loginService = createLoginService({
    configuration: {
      absoluteTimeoutMilliseconds: 604800000,
      idleTimeoutMilliseconds: 86400000,
      secureCookie: false,
      touchIntervalMilliseconds: 900000,
    },
    passwordVerifier: argon2PasswordVerifier,
    repository: createPrismaAuthenticationRepository(prisma),
    tokenProvider: secureSessionTokenProvider,
    verificationRepository: createPrismaVerificationRepository(prisma),
    security: testVerificationSecurity(),
  });
  const apiRouter = createLoginRouter({
    configuration: {
      absoluteTimeoutMilliseconds: 604800000,
      idleTimeoutMilliseconds: 86400000,
      secureCookie: false,
      touchIntervalMilliseconds: 900000,
    },
    limiter: createLoginLimiter(),
    loginService,
    continuationKey: Buffer.alloc(32).toString("base64url"),
    publicWebOrigin: origin,
  });
  return startApiServer(
    createApp({ apiRouter, logger: { error() {}, info() {} } }),
    { host: "127.0.0.1", port: 0 },
  );
}

describe("dedicated disposable D5-P4 Legacy-to-Native recovery rehearsal", () => {
  afterAll(async () => {
    if (activeWorker) await stopNativeWorker(activeWorker, true);
    await nativeServer?.stop();
    await nativeRuntime?.drain();
    await prisma.$disconnect();
  });

  it("drains Legacy, retries and seals forward, then authenticates after fresh runtime restart", async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (
      !databaseUrl ||
      !verifyLocalPostgresReceipt(
        receipt,
        databaseUrl,
        database.TEST_DATABASE_URL,
      )
    )
      throw new Error("Disposable transition receipt mismatch");
    const control = new Client({
      connectionString: database.TEST_DATABASE_URL,
    });
    await control.connect();
    try {
      const target = await control.query<{
        name: string;
        marker: string | null;
      }>(
        "SELECT current_database() AS name, shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname = current_database()",
      );
      const authorized = receipt as { testDatabase: string; marker: string };
      expect(target.rows[0]?.name).toBe(authorized.testDatabase);
      expect(target.rows[0]?.marker).toBe(
        `stockwise-local:${authorized.marker}`,
      );
    } finally {
      await control.end();
    }

    const transition = await createDisposableNativeTransition({
      prisma,
      databaseUrl,
      testDatabaseUrl: database.TEST_DATABASE_URL,
      receipt,
    });
    const id = randomUUID();
    const user = await prisma.user.create({
      data: {
        id,
        email: `${id}@example.test`,
        passwordHash: await hashPassword(legacyPassword),
        status: "ACTIVE",
        displayName: "Cutover rehearsal actor",
        emailVerified: true,
        emailVerifiedAt: new Date(),
        passwordChangedAt: new Date(),
      },
    });
    const organization = await prisma.organization.create({
      data: { name: `Cutover ${id}`, salesVatStatus: "NOT_REGISTERED" },
    });
    const membership = await prisma.organizationMembership.create({
      data: {
        organizationId: organization.id,
        role: "BRANCH_MANAGER",
        userId: id,
      },
    });
    const branch = await prisma.branch.create({
      data: {
        code: `CU-${id.slice(0, 8).toUpperCase()}`,
        name: "Cutover branch",
        organizationId: organization.id,
      },
    });
    await prisma.branchAssignment.create({
      data: {
        branchId: branch.id,
        organizationId: organization.id,
        userId: id,
      },
    });
    const unassignedBranch = await prisma.branch.create({
      data: {
        code: `CU-${randomUUID().slice(0, 8).toUpperCase()}`,
        name: "Unassigned rehearsal branch",
        organizationId: organization.id,
      },
    });
    const otherOrganization = await prisma.organization.create({
      data: { name: `Foreign cutover tenant ${id}` },
    });
    const foreignBranch = await prisma.branch.create({
      data: {
        code: `CU-${randomUUID().slice(0, 8).toUpperCase()}`,
        name: "Foreign rehearsal branch",
        organizationId: otherOrganization.id,
      },
    });

    const legacy = await startLegacy();
    const legacyLogin = await fetch(
      `http://127.0.0.1:${legacy.address.port}/api/v1/auth/login`,
      {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ email: user.email, password: legacyPassword }),
      },
    );
    expect(legacyLogin.status).toBe(200);
    const legacyCookie = legacyLogin.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    await legacy.stop();
    await record("legacy-http-and-drained", {
      loginStatus: legacyLogin.status,
      serverStopped: true,
      userUuidPreserved: true,
      branchAndAssignmentPresent: true,
    });

    const readOnlyBefore = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        return {
          mode: (
            await tx.$queryRaw<
              { state: string }[]
            >`SELECT state FROM native_auth_transition WHERE id = true`
          )[0]?.state,
          accounts: await tx.betterAuthAccount.count({ where: { userId: id } }),
          memberships: await tx.organizationMembership.count({
            where: { userId: id },
          }),
        };
      },
      { isolationLevel: "RepeatableRead" },
    );
    expect(readOnlyBefore.mode).toBe("LEGACY");
    expect(readOnlyBefore.accounts).toBe(0);
    await expect(assertNativeCutoverReady(prisma)).rejects.toThrow(
      "Native cutover readiness check refused.",
    );
    expect(
      await prisma.betterAuthAccount.count({ where: { userId: id } }),
    ).toBe(0);
    await record("legacy-preflight-refused-read-only", {
      mode: readOnlyBefore.mode!,
      accountsUnchanged: true,
      membershipPreserved: readOnlyBefore.memberships === 1,
    });

    const pidReady = Promise.withResolvers<number>();
    const interruptedRead = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        const current = await tx.$queryRaw<
          { pid: number }[]
        >`SELECT pg_backend_pid() AS pid`;
        pidReady.resolve(current[0]!.pid);
        await tx.$queryRaw`SELECT pg_sleep(30)`;
      },
      { timeout: 45_000 },
    );
    const interruptedPid = await pidReady.promise;
    const cancelClient = new Client({
      connectionString: database.TEST_DATABASE_URL,
    });
    await cancelClient.connect();
    try {
      const cancelled = await cancelClient.query<{ cancelled: boolean }>(
        "SELECT pg_cancel_backend($1) AS cancelled",
        [interruptedPid],
      );
      expect(cancelled.rows[0]?.cancelled).toBe(true);
      await expect(interruptedRead).rejects.toThrow();
    } finally {
      await cancelClient.end();
    }
    expect(
      await prisma.betterAuthAccount.count({ where: { userId: id } }),
    ).toBe(0);
    expect(
      (
        await prisma.$queryRaw<
          { state: string }[]
        >`SELECT state FROM native_auth_transition WHERE id = true`
      )[0]?.state,
    ).toBe("LEGACY");
    await record("interrupted-read-only-snapshot", {
      cancelled: true,
      mutations: 0,
      gate: "LEGACY",
    });

    const snapshot = await transition.preflight();
    expect(snapshot.mode).toBe("LEGACY");
    const source = snapshot.users.find((item) => item.userId === id);
    expect(source?.eligible).toBe(true);
    expect((await transition.quiesce()).mode).toBe("QUIESCED");
    await expect(assertNativeCutoverReady(prisma)).rejects.toThrow(
      "Native cutover readiness check refused.",
    );

    // A targeted trigger forces the writer transaction to roll back before retry.
    const trigger = `cutover_fail_${id.replaceAll("-", "")}`;
    const fn = `${trigger}_fn`;
    const injection = new Client({
      connectionString: database.TEST_DATABASE_URL,
    });
    await injection.connect();
    try {
      await injection.query(
        `CREATE FUNCTION public.${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id = '${id}'::uuid THEN RAISE EXCEPTION 'synthetic rehearsal failure'; END IF; RETURN NEW; END $$`,
      );
      await injection.query(
        `CREATE TRIGGER ${trigger} BEFORE INSERT ON public.native_auth_enrollments FOR EACH ROW EXECUTE FUNCTION public.${fn}()`,
      );
      await expect(transition.transitionUser(id, user)).rejects.toThrow();
      expect(
        await prisma.betterAuthAccount.count({ where: { userId: id } }),
      ).toBe(0);
      expect(
        await prisma.nativeAuthEnrollment.count({ where: { userId: id } }),
      ).toBe(0);
    } finally {
      await injection.query(
        `DROP TRIGGER IF EXISTS ${trigger} ON public.native_auth_enrollments`,
      );
      await injection.query(`DROP FUNCTION IF EXISTS public.${fn}()`);
      await injection.end();
    }
    const expected = {
      credentialVersion: user.credentialVersion,
      passwordChangedAt: user.passwordChangedAt,
      updatedAt: user.updatedAt,
    };
    expect((await transition.transitionUser(id, expected)).outcome).toBe(
      "TRANSITIONED",
    );
    expect((await transition.transitionUser(id, expected)).outcome).toBe(
      "REPLAY",
    );
    const reconciled = await transition.reconcile();
    expect(reconciled.mode).toBe("QUIESCED");
    expect(reconciled.identityPreserved).toBe(true);
    expect(reconciled.legacyAuthorityRemaining).toBe(0);
    expect((await transition.seal()).mode).toBe("NATIVE");
    await expect(assertNativeCutoverReady(prisma)).resolves.toBeUndefined();
    const staleLegacy = await startLegacy();
    try {
      const refused = await fetch(
        `http://127.0.0.1:${staleLegacy.address.port}/api/v1/auth/login`,
        {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body: JSON.stringify({ email: user.email, password: legacyPassword }),
        },
      );
      expect(refused.status).toBe(500);
      expect(refused.headers.has("set-cookie")).toBe(false);
      expect(await prisma.session.count({ where: { revokedAt: null } })).toBe(
        0,
      );
    } finally {
      await staleLegacy.stop();
    }
    const accountBefore = await prisma.betterAuthAccount.findFirstOrThrow({
      where: { userId: id },
    });
    const enrollmentBefore =
      await prisma.nativeAuthEnrollment.findUniqueOrThrow({
        where: { userId: id },
      });
    await expect(
      prisma.betterAuthAccount.update({
        where: { id: accountBefore.id },
        data: { accountId: randomUUID() },
      }),
    ).rejects.toThrow();

    const initial = await startNative();
    expect(
      (
        await fetch(`${initial.base}/cutover-protected`, {
          headers: { cookie: legacyCookie },
        })
      ).status,
    ).toBe(401);
    const login = await initial.post("/auth/login", {
      email: user.email,
      password: legacyPassword,
    });
    expect(login.status).toBe(200);
    const cookie = login.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    const protectedResponse = await fetch(`${initial.base}/cutover-protected`, {
      headers: { cookie },
    });
    expect(await protectedResponse.json()).toEqual({ id });
    expect((await initial.post("/auth/logout-all", {}, cookie)).status).toBe(
      204,
    );
    expect(
      (
        await fetch(`${initial.base}/cutover-protected`, {
          headers: { cookie },
        })
      ).status,
    ).toBe(401);
    const beforeResetLogin = await initial.post("/auth/login", {
      email: user.email,
      password: legacyPassword,
    });
    expect(beforeResetLogin.status).toBe(200);
    const beforeResetCookie = beforeResetLogin.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    expect(
      (await initial.post("/auth/forgot-password", { email: user.email }))
        .status,
    ).toBe(202);
    const resetMessage = deliveredMessages.find(
      (message) => message.kind === "password_reset",
    );
    expect(resetMessage).toBeDefined();
    const resetToken = new URL(resetMessage!.url).searchParams.get("token");
    expect(resetToken).toBeTruthy();
    const replacementPassword = "synthetic Native replacement password 🔐";
    expect(
      (
        await initial.post("/auth/reset-password", {
          token: resetToken,
          newPassword: replacementPassword,
        })
      ).status,
    ).toBe(200);
    const resetGeneration = await prisma.user.findUniqueOrThrow({
      where: { id },
      select: { credentialVersion: true },
    });
    expect(resetGeneration.credentialVersion).toBe(user.credentialVersion + 1n);
    expect(
      await prisma.betterAuthSession.count({ where: { userId: id } }),
    ).toBe(0);
    expect(
      (
        await fetch(`${initial.base}/cutover-protected`, {
          headers: { cookie: beforeResetCookie },
        })
      ).status,
    ).toBe(401);
    expect((await transition.transitionUser(id, expected)).outcome).toBe(
      "CONFLICT",
    );
    await expect(
      prisma.user.update({
        where: { id },
        data: {
          passwordHash: user.passwordHash,
          credentialVersion: user.credentialVersion,
          passwordChangedAt: user.passwordChangedAt,
        },
      }),
    ).rejects.toThrow();
    await expect(prisma.$executeRaw`
      UPDATE public.native_auth_transition SET state = 'LEGACY' WHERE id = true
    `).rejects.toThrow();
    await expect(assertNativeCutoverReady(prisma)).resolves.toBeUndefined();
    const accountClient = new Client({
      connectionString: database.TEST_DATABASE_URL,
    });
    await accountClient.connect();
    const nativeAccount = await accountClient.query<{
      id: string;
      password: string;
    }>(
      "SELECT id, password FROM public.better_auth_accounts WHERE user_id = $1",
      [id],
    );
    if (!nativeAccount.rows[0])
      throw new Error("Rehearsal Native account is unavailable.");
    const mismatchedCredential = `${nativeAccount.rows[0].password}x`;
    try {
      await accountClient.query(
        "UPDATE public.better_auth_accounts SET password = $1 WHERE id = $2",
        [mismatchedCredential, nativeAccount.rows[0].id],
      );
      await expect(assertNativeCutoverReady(prisma)).rejects.toThrow(
        "Native cutover readiness check refused.",
      );
    } finally {
      await accountClient.query(
        "UPDATE public.better_auth_accounts SET password = $1 WHERE id = $2",
        [nativeAccount.rows[0].password, nativeAccount.rows[0].id],
      );
      await accountClient.end();
    }
    await expect(assertNativeCutoverReady(prisma)).resolves.toBeUndefined();
    await cancelPreflightBeforeCommit(prisma);
    expect(
      await prisma.betterAuthAccount.count({ where: { userId: id } }),
    ).toBe(1);
    await record("native-read-only-preflight-cancelled-before-commit", {
      cancelled: true,
      accountsUnchanged: true,
      mode: "NATIVE",
    });
    const survivingLogin = await initial.post("/auth/login", {
      email: user.email,
      password: replacementPassword,
    });
    expect(survivingLogin.status).toBe(200);
    const survivingCookie = survivingLogin.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");

    await nativeServer?.stop();
    await nativeRuntime?.drain();
    nativeServer = undefined;
    nativeRuntime = undefined;
    await prisma.$disconnect();

    const invalid = await spawnNativeWorker("invalid");
    expect(invalid.refused).toBe(true);
    await stopNativeWorker(invalid.child, true);
    const missing = await spawnNativeWorker(null);
    expect(missing.refused).toBe(true);
    await stopNativeWorker(missing.child, true);
    const first = await spawnNativeWorker(nativeSecret);
    expect(first.refused).toBe(false);
    if (first.port === null) throw new Error("Native child did not start.");
    activeWorker = first.child;
    const childBase = `http://127.0.0.1:${first.port}/api/v1`;
    const contextResponse = await fetch(`${childBase}/me/access-context`, {
      headers: { cookie: survivingCookie },
    });
    expect(contextResponse.status).toBe(200);
    const access = (await contextResponse.json()) as {
      data: { organizations: { id: string; branches: { id: string }[] }[] };
    };
    const orgAccess = access.data.organizations.find(
      (item) => item.id === organization.id,
    );
    expect(orgAccess?.branches.map((item) => item.id)).toEqual([branch.id]);
    expect(
      access.data.organizations.flatMap((item) =>
        item.branches.map((assigned) => assigned.id),
      ),
    ).not.toContain(foreignBranch.id);
    expect(
      orgAccess?.branches.some((item) => item.id === unassignedBranch.id),
    ).toBe(false);
    const ownBranches = await fetch(
      `${childBase}/organizations/${organization.id}/branches`,
      { headers: { cookie: survivingCookie } },
    );
    expect(ownBranches.status).toBe(200);
    expect(
      ((await ownBranches.json()) as { data: { id: string }[] }).data.map(
        (item) => item.id,
      ),
    ).toEqual([branch.id]);
    const foreignBranches = await fetch(
      `${childBase}/organizations/${otherOrganization.id}/branches`,
      { headers: { cookie: survivingCookie } },
    );
    expect(foreignBranches.status).toBe(403);
    const roleDenied = await fetch(
      `${childBase}/organizations/${organization.id}/branches`,
      {
        method: "POST",
        headers: {
          origin,
          "content-type": "application/json",
          cookie: survivingCookie,
        },
        body: JSON.stringify({ code: "DENIED", name: "Not authorized" }),
      },
    );
    expect(roleDenied.status).toBe(403);
    await stopNativeWorker(first.child, true);
    activeWorker = undefined;

    const restarted = await spawnNativeWorker(nativeSecret);
    expect(restarted.refused).toBe(false);
    if (restarted.port === null)
      throw new Error("Restarted Native child did not start.");
    activeWorker = restarted.child;
    const restartedBase = `http://127.0.0.1:${restarted.port}/api/v1`;
    expect(
      (
        await fetch(`${restartedBase}/me/access-context`, {
          headers: { cookie: survivingCookie },
        })
      ).status,
    ).toBe(200);
    const nativeLogin = await fetch(`${restartedBase}/auth/login`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({
        email: user.email,
        password: replacementPassword,
      }),
    });
    expect(nativeLogin.status).toBe(200);
    const nativeCookie = nativeLogin.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    expect(
      (
        await fetch(`${restartedBase}/auth/logout`, {
          method: "POST",
          headers: {
            origin,
            "content-type": "application/json",
            cookie: nativeCookie,
          },
          body: JSON.stringify({}),
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await fetch(`${restartedBase}/me/access-context`, {
          headers: { cookie: nativeCookie },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${restartedBase}/auth/login`, {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body: JSON.stringify({ email: user.email, password: legacyPassword }),
        })
      ).status,
    ).not.toBe(200);
    await stopNativeWorker(restarted.child);
    activeWorker = undefined;
    prisma = new PrismaClient({
      adapter: new PrismaPg({
        connectionString: database.TEST_DATABASE_URL,
        idleTimeoutMillis: 0,
      }),
    });
    const sealedUser = await prisma.user.findUniqueOrThrow({
      where: { id },
      select: { credentialVersion: true, nativeRegistrationCompletedAt: true },
    });
    expect(sealedUser.credentialVersion).toBe(
      resetGeneration.credentialVersion,
    );
    expect(sealedUser.nativeRegistrationCompletedAt).toEqual(
      enrollmentBefore.enrolledAt,
    );
    expect(
      await prisma.organizationMembership.findUniqueOrThrow({
        where: {
          organizationId_id: {
            organizationId: organization.id,
            id: membership.id,
          },
        },
      }),
    ).toEqual(membership);
    expect(
      await prisma.branchAssignment.count({
        where: { branchId: branch.id, userId: id },
      }),
    ).toBe(1);
    expect(
      await prisma.betterAuthAccount.count({ where: { userId: id } }),
    ).toBe(1);
    await expect(assertNativeCutoverReady(prisma)).resolves.toBeUndefined();

    const ledgerClient = new Client({
      connectionString: database.TEST_DATABASE_URL,
    });
    await ledgerClient.connect();
    const ledger = await ledgerClient.query<{
      migration_name: string;
      checksum: string;
    }>(
      "SELECT migration_name, checksum FROM public._prisma_migrations ORDER BY migration_name DESC LIMIT 1",
    );
    const migration = ledger.rows[0];
    if (!migration) throw new Error("Disposable migration ledger is empty.");
    const tampered =
      migration.checksum === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64);
    try {
      await ledgerClient.query(
        "UPDATE public._prisma_migrations SET checksum = $1 WHERE migration_name = $2",
        [tampered, migration.migration_name],
      );
      await expect(assertNativeCutoverReady(prisma)).rejects.toThrow(
        "Native cutover readiness check refused.",
      );
    } finally {
      await ledgerClient.query(
        "UPDATE public._prisma_migrations SET checksum = $1 WHERE migration_name = $2",
        [migration.checksum, migration.migration_name],
      );
      await ledgerClient.end();
    }
    await expect(assertNativeCutoverReady(prisma)).resolves.toBeUndefined();
    await record("native-sealed-child-restart-http", {
      state: "NATIVE",
      loginStatus: nativeLogin.status,
      resetCompleted: true,
      credentialVersionPreserved: true,
      legacyCredentialAccepted: false,
      processLostAndRestarted: true,
      sessionSurvivedProcessRestart: true,
      invalidAndMissingSecretStartupRefused: true,
      nativeFeatureFlagRemainsOff: !BETTER_AUTH_NATIVE_ENABLED,
      foreignOrganizationDenied: foreignBranches.status === 403,
      unassignedBranchHidden: true,
      accountIdentityMutationRefused: true,
      branchManagementRoleDenied: roleDenied.status === 403,
      staleLegacyHttpAndCookieRefused: true,
      staleCredentialRestoreAndFenceDowngradeRefused: true,
      changedCredentialReplayRefused: true,
      userUuidPreserved: true,
      membershipPreserved: true,
      branchAssignmentPreserved: true,
      nativeAccounts: 1,
      checksumTamperRefusedAndRestored: true,
    });
  });
});
