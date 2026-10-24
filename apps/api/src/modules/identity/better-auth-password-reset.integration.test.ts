import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import express, { type ErrorRequestHandler, type Request } from "express";
import { createServer } from "node:http";
import { afterAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../../generated/prisma/client.ts";
import { loadTestDatabaseEnvironment } from "../../test/database-environment.ts";
import {
  createPasswordResetService,
  type PasswordResetService,
} from "./credential-lifecycle-service.ts";
import {
  createPrismaBetterAuthCredentialLifecycleRepository,
  type PasswordResetRepository,
} from "./credential-lifecycle-repository.ts";
import { createBetterAuthPasswordResetRouter } from "./credential-lifecycle-router.ts";
import { createBetterAuthApplicationSessionService } from "./better-auth-application-session.ts";
import { createBetterAuthNative } from "./better-auth-native.ts";
import { createBetterAuthSessionResolver } from "./better-auth-bridge.ts";
import { createPrismaBetterAuthSessionRepository } from "./better-auth-session-repository.ts";
import { createLoginLimiter } from "./login-limiter.ts";
import { createNativePasswordResetLimiter } from "./native-password-reset-limiter.ts";
import {
  argon2PasswordHasher,
  hashPassword,
  verifyPassword,
  type PasswordHasher,
} from "./password-hasher.ts";
import {
  createRecordingEmailProvider,
  type IdentityEmailProvider,
  type RecordingIdentityEmailProvider,
} from "./email-provider.ts";
import {
  hashOneTimeToken,
  secureOneTimeTokenProvider,
  type OneTimeTokenProvider,
} from "./one-time-token.ts";
import {
  hashSessionToken,
  secureSessionTokenProvider,
} from "./session-token.ts";
import { createLoginService } from "./login-service.ts";
import { createPrismaAuthenticationRepository } from "./authentication-repository.ts";
import type { SessionConfiguration } from "./session-configuration.ts";

const environment = loadTestDatabaseEnvironment();
const prisma = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: environment.TEST_DATABASE_URL,
    idleTimeoutMillis: 0,
  }),
});
const origin = "https://web.example.test";
const secret = "d4-isolated-test-only-secret-not-real";
const configuration: SessionConfiguration = {
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
const loginService = createBetterAuthApplicationSessionService({
  prisma,
  native,
  publicWebOrigin: origin,
  configuration,
  limiter: createLoginLimiter(),
  pendingRegistrationService: {
    provePassword: async () => ({ outcome: "invalid" }),
  },
});
const bridge = createBetterAuthSessionResolver({
  native,
  repository: createPrismaBetterAuthSessionRepository(prisma),
  configuration,
  publicWebOrigin: origin,
});
const initialPassword = "native reset initial password é🔒";
const newPassword = "native reset replacement password 🔐";

afterAll(async () => {
  await prisma.$disconnect();
});

function makeLifecycle({
  emailProvider = createRecordingEmailProvider(),
  tokenProvider = secureOneTimeTokenProvider,
  passwordHasher = argon2PasswordHasher,
  now,
  repository,
}: {
  emailProvider?: IdentityEmailProvider;
  tokenProvider?: OneTimeTokenProvider;
  passwordHasher?: PasswordHasher;
  now?: () => Date;
  repository?: PasswordResetRepository;
} = {}): PasswordResetService {
  return createPasswordResetService({
    emailProvider,
    passwordHasher,
    publicWebOrigin: origin,
    repository:
      repository ?? createPrismaBetterAuthCredentialLifecycleRepository(prisma),
    tokenProvider,
    ...(now === undefined ? {} : { now }),
  });
}

async function seedLegacySession(userId: string) {
  const token = randomBytes(32).toString("base64url");
  const issuedAt = new Date();
  return prisma.session.create({
    data: {
      absoluteExpiresAt: new Date(issuedAt.getTime() + 604800000),
      idleExpiresAt: new Date(issuedAt.getTime() + 86400000),
      issuedAt,
      lastUsedAt: issuedAt,
      tokenHash: hashSessionToken(token),
      userId,
    },
  });
}

async function seedMembership(userId: string) {
  const organization = await prisma.organization.create({
    data: { name: `Reset test ${randomBytes(8).toString("hex")}` },
  });
  return prisma.organizationMembership.create({
    data: { organizationId: organization.id, role: "OWNER", userId },
  });
}

async function seedUser(
  email = `${randomBytes(12).toString("hex")}@example.test`,
) {
  const legacyHash = await hashPassword("legacy-only password");
  const credentialHash = await hashPassword(initialPassword);
  const user = await prisma.user.create({
    data: {
      email,
      emailVerified: true,
      emailVerifiedAt: new Date(),
      nativeRegistrationCompletedAt: new Date(),
      passwordHash: legacyHash,
      betterAuthAccounts: {
        create: {
          accountId: "placeholder",
          providerId: "credential",
          password: credentialHash,
        },
      },
    },
  });
  await prisma.betterAuthAccount.updateMany({
    where: { userId: user.id },
    data: { accountId: user.id },
  });
  return { user, legacyHash, credentialHash };
}

async function establish(email: string, password = initialPassword) {
  const result = await loginService.login(
    { email, password },
    new Headers({ origin }),
  );
  if (result.outcome !== "authenticated")
    throw new Error(`Native login failed: ${result.outcome}`);
  const cookie = result.cookies[0]?.split(";")[0];
  if (cookie === undefined) throw new Error("Native login omitted its cookie");
  const nativeSession = await native.api.getSession({
    headers: new Headers({ cookie }),
    query: { disableCookieCache: true, disableRefresh: true },
  });
  if (nativeSession === null)
    throw new Error("Native login cookie did not resolve");
  return { cookie, nativeSession };
}

function request(cookie: string): Request {
  return { method: "GET", headers: { cookie } } as Request;
}

function recordedToken(
  provider: RecordingIdentityEmailProvider,
  index = -1,
): string {
  const message = provider.messages.at(index);
  if (message?.kind !== "password_reset")
    throw new Error("Expected recorded password reset email");
  const token = new URL(message.url).searchParams.get("token");
  if (token === null) throw new Error("Recorded reset email omitted token");
  return token;
}

async function runHttpSmoke(
  lifecycle: PasswordResetService,
  emailProvider: RecordingIdentityEmailProvider,
) {
  const account = await seedUser();
  const app = express();
  app.use(express.json());
  app.use(
    "/api/v1",
    createBetterAuthPasswordResetRouter({
      lifecycleService: lifecycle,
      passwordResetLimiter: createNativePasswordResetLimiter(prisma),
      publicWebOrigin: origin,
    }),
  );
  const fail: ErrorRequestHandler = (_error, _request, response, _next) => {
    void _next;
    response.status(500).json({ error: "Internal server error" });
  };
  app.use(fail);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("No HTTP listener");
  const url = `http://127.0.0.1:${address.port}/api/v1`;
  try {
    const asked = await fetch(`${url}/auth/forgot-password`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ email: account.user.email }),
    });
    expect(asked.status).toBe(202);
    const rawToken = recordedToken(emailProvider);
    const completed = await fetch(`${url}/auth/reset-password`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ token: rawToken, newPassword }),
    });
    expect(completed.status).toBe(200);
    expect(
      await prisma.user
        .findUniqueOrThrow({ where: { id: account.user.id } })
        .then((row) => row.credentialVersion),
    ).toBe(account.user.credentialVersion + 1n);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

describe("native credential reset with guarded PostgreSQL", () => {
  it("applies the additive reset migration forward without changing existing UUIDs, tokens or foreign keys", async () => {
    const { user } = await seedUser();
    const membership = await seedMembership(user.id);
    const legacyToken = secureOneTimeTokenProvider.generate();
    const issuedAt = new Date();
    const token = await prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: legacyToken.tokenHash,
        issuedAt,
        expiresAt: new Date(issuedAt.getTime() + 1800000),
      },
    });
    const client = new Client({
      connectionString: environment.TEST_DATABASE_URL,
    });
    const schema = `reset_migration_${randomBytes(8).toString("hex")}`;
    const migrationsRoot = new URL(
      "../../../prisma/migrations/",
      import.meta.url,
    );
    const target = "20261012050000_native_password_reset_delivery_quota";
    await client.connect();
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      // Historical migrations manage their own transactions; confine them to
      // this newly owned schema, never the disposable target's public tables.
      await client.query(`SET search_path TO "${schema}"`);
      const migrations = (
        await readdir(migrationsRoot, { withFileTypes: true })
      )
        .filter((entry) => entry.isDirectory() && entry.name < target)
        .map((entry) => entry.name)
        .sort();
      for (const migration of migrations)
        await client.query(
          await readFile(
            new URL(`${migration}/migration.sql`, migrationsRoot),
            "utf8",
          ),
        );
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO users SELECT (json_populate_record(NULL::users, row_to_json(u))).* FROM public.users u WHERE id = $1",
        [user.id],
      );
      await client.query(
        "INSERT INTO organizations SELECT (json_populate_record(NULL::organizations, row_to_json(o))).* FROM public.organizations o WHERE id = $1",
        [membership.organizationId],
      );
      await client.query(
        "INSERT INTO organization_memberships SELECT (json_populate_record(NULL::organization_memberships, row_to_json(m))).* FROM public.organization_memberships m WHERE user_id = $1",
        [user.id],
      );
      await client.query(
        "INSERT INTO password_reset_tokens (id, user_id, token_hash, issued_at, expires_at, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [
          token.id,
          user.id,
          token.tokenHash,
          token.issuedAt,
          token.expiresAt,
          token.createdAt,
          token.updatedAt,
        ],
      );
      const snapshot = async () => ({
        users: (await client.query("SELECT * FROM users")).rows,
        memberships: (
          await client.query("SELECT * FROM organization_memberships")
        ).rows,
        foreignKeys: (
          await client.query(
            "SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE contype = 'f' AND connamespace = $1::regnamespace ORDER BY conname",
            [schema],
          )
        ).rows,
      });
      const before = await snapshot();
      await client.query(
        await readFile(
          new URL(`${target}/migration.sql`, migrationsRoot),
          "utf8",
        ),
      );
      expect(await snapshot()).toEqual(before);
      expect(
        (
          await client.query(
            "SELECT * FROM password_reset_tokens WHERE id = $1",
            [token.id],
          )
        ).rows,
      ).toEqual([
        {
          id: token.id,
          user_id: user.id,
          token_hash: token.tokenHash,
          issued_at: token.issuedAt,
          expires_at: token.expiresAt,
          consumed_at: null,
          revoked_at: null,
          replaced_at: null,
          created_at: token.createdAt,
          updated_at: token.updatedAt,
          requires_native_delivery_confirmation: false,
          delivery_confirmed_at: null,
        },
      ]);
      for (const [key, attempts] of [
        ["a".repeat(64), 0],
        ["a".repeat(64), 4],
        ["not-a-hash", 1],
      ] as const) {
        await client.query("SAVEPOINT invalid_quota");
        await expect(
          client.query(
            "INSERT INTO native_password_reset_quotas VALUES ($1, clock_timestamp(), $2)",
            [key, attempts],
          ),
        ).rejects.toMatchObject({ code: "23514" });
        await client.query("ROLLBACK TO SAVEPOINT invalid_quota");
      }
      await client.query(
        "INSERT INTO native_password_reset_quotas VALUES ($1, clock_timestamp(), 3)",
        ["a".repeat(64)],
      );
      await client.query("SAVEPOINT duplicate_quota");
      await expect(
        client.query(
          "INSERT INTO native_password_reset_quotas VALUES ($1, clock_timestamp(), 1)",
          ["a".repeat(64)],
        ),
      ).rejects.toMatchObject({ code: "23505" });
      await client.query("ROLLBACK TO SAVEPOINT duplicate_quota");
    } finally {
      await client.query("ROLLBACK");
      await client.query(`DROP SCHEMA "${schema}" CASCADE`);
      await client.end();
    }
  });
  it("replaces only Better Auth PHC, atomically revokes native authority, preserves legacy state, and denies old Bridge cookies", async () => {
    const { user, legacyHash, credentialHash } = await seedUser();
    const legacySession = await seedLegacySession(user.id);
    const membership = await seedMembership(user.id);
    const first = await establish(user.email);
    const second = await establish(user.email);
    const nativeSessionIds = [
      first.nativeSession.session.id,
      second.nativeSession.session.id,
    ];
    const oldVersion = user.credentialVersion;
    const oldChangedAt = user.passwordChangedAt;
    const provider = createRecordingEmailProvider();
    const lifecycle = makeLifecycle({ emailProvider: provider });
    await lifecycle.requestPasswordReset(user.email);
    const rawToken = recordedToken(provider);
    const tokenRecord = await prisma.passwordResetToken.findFirstOrThrow({
      where: { userId: user.id },
    });
    expect(tokenRecord.tokenHash).toBe(hashOneTimeToken(rawToken));
    expect(tokenRecord.tokenHash).not.toBe(rawToken);
    expect(
      tokenRecord.expiresAt.getTime() - tokenRecord.issuedAt.getTime(),
    ).toBe(30 * 60 * 1000);
    expect(await lifecycle.resetPassword({ rawToken, newPassword })).toBe(true);
    expect(
      await lifecycle.resetPassword({
        rawToken,
        newPassword: "replay password",
      }),
    ).toBe(false);

    const after = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    const account = await prisma.betterAuthAccount.findFirstOrThrow({
      where: { userId: user.id, providerId: "credential" },
    });
    expect(account.password).toMatch(/^\$argon2id\$v=19\$m=65536,p=4,t=3\$/);
    expect(await verifyPassword(account.password!, newPassword)).toBe(true);
    expect(account.password).not.toBe(credentialHash);
    expect(after.credentialVersion).toBe(oldVersion + 1n);
    expect(after.passwordChangedAt.getTime()).toBeGreaterThanOrEqual(
      oldChangedAt.getTime(),
    );
    expect(after.passwordHash).toBe(legacyHash);
    expect(
      await prisma.betterAuthSession.count({ where: { userId: user.id } }),
    ).toBe(0);
    expect(
      await prisma.session.findUnique({ where: { id: legacySession.id } }),
    ).not.toBeNull();
    expect(
      await prisma.organizationMembership.findUnique({
        where: {
          organizationId_userId: {
            organizationId: membership.organizationId,
            userId: user.id,
          },
        },
      }),
    ).toMatchObject({ id: membership.id });
    expect(
      await prisma.betterAuthSession.findMany({
        where: { id: { in: nativeSessionIds } },
      }),
    ).toEqual([]);
    expect(
      await native.api.getSession({
        headers: new Headers({ cookie: first.cookie }),
        query: { disableCookieCache: true, disableRefresh: true },
      }),
    ).toBeNull();
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(1);
    expect(
      await prisma.passwordResetToken.findUniqueOrThrow({
        where: { id: tokenRecord.id },
      }),
    ).toMatchObject({
      consumedAt: expect.any(Date),
      deliveryConfirmedAt: expect.any(Date),
    });
    for (const established of [first, second])
      expect(await bridge(request(established.cookie))).toBeNull();
    expect(
      (
        await loginService.login(
          { email: user.email, password: initialPassword },
          new Headers({ origin }),
        )
      ).outcome,
    ).toBe("invalid");
    expect(
      (
        await loginService.login(
          { email: user.email, password: newPassword },
          new Headers({ origin }),
        )
      ).outcome,
    ).toBe("authenticated");
    expect(
      await prisma.betterAuthSession.count({ where: { userId: user.id } }),
    ).toBe(1);
    const unexpectedProof = () => {
      throw new Error(
        "Verified legacy login must not enter verification proof",
      );
    };
    const legacyLogin = createLoginService({
      configuration,
      passwordVerifier: { verify: verifyPassword },
      repository: createPrismaAuthenticationRepository(prisma),
      tokenProvider: secureSessionTokenProvider,
      verificationRepository: { proveCredentialSnapshot: unexpectedProof },
      security: { prove: unexpectedProof, phantom: unexpectedProof },
    });
    expect(
      (
        await legacyLogin.login({
          email: user.email,
          password: "legacy-only password",
          existingTokenHash: null,
        })
      ).outcome,
    ).toBe("authenticated");
    expect(
      (
        await legacyLogin.login({
          email: user.email,
          password: newPassword,
          existingTokenHash: null,
        })
      ).outcome,
    ).toBe("credential_failure");
  });

  it.each([
    "disabled",
    "unverified_flag",
    "unverified_at",
    "unfinished",
    "missing_account",
  ] as const)(
    "does not issue or send a token for native-ineligible %s users",
    async (state) => {
      const { user } = await seedUser();
      if (state === "unverified_flag")
        await prisma.user.update({
          where: { id: user.id },
          data: { emailVerified: false },
        });
      if (state === "unverified_at")
        await prisma.user.update({
          where: { id: user.id },
          data: { emailVerifiedAt: null },
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
        await prisma.betterAuthAccount.deleteMany({
          where: { userId: user.id },
        });
      const provider = createRecordingEmailProvider();
      await makeLifecycle({ emailProvider: provider }).requestPasswordReset(
        user.email,
      );
      expect(provider.messages).toEqual([]);
      expect(
        await prisma.passwordResetToken.count({ where: { userId: user.id } }),
      ).toBe(0);
    },
  );

  it("rejects expired, replaced, and unknown tokens; replacement invalidates the previous link", async () => {
    const { user } = await seedUser();
    const provider = createRecordingEmailProvider();
    const lifecycle = makeLifecycle({ emailProvider: provider });
    await lifecycle.requestPasswordReset(user.email);
    const first = recordedToken(provider);
    await lifecycle.requestPasswordReset(user.email);
    const second = recordedToken(provider);
    expect(
      await lifecycle.resetPassword({ rawToken: first, newPassword }),
    ).toBe(false);
    expect(
      await lifecycle.resetPassword({
        rawToken: randomBytes(32).toString("base64url"),
        newPassword,
      }),
    ).toBe(false);
    const current = await prisma.passwordResetToken.findFirstOrThrow({
      where: { userId: user.id, tokenHash: hashOneTimeToken(second) },
    });
    await prisma.passwordResetToken.update({
      where: { id: current.id },
      data: { expiresAt: new Date(Date.now() - 1) },
    });
    expect(
      await lifecycle.resetPassword({ rawToken: second, newPassword }),
    ).toBe(false);
  });
  it.each([-20, 20])(
    "anchors native expiry to PostgreSQL time with %i-minute application clock skew",
    async (skewMinutes) => {
      const { user } = await seedUser();
      const beforeIssue = new Date();
      const provider = createRecordingEmailProvider();
      const issuer = makeLifecycle({
        emailProvider: provider,
        now: () => new Date(Date.now() + skewMinutes * 60 * 1000),
      });
      await issuer.requestPasswordReset(user.email);
      const rawToken = recordedToken(provider);
      const afterIssue = new Date();
      const token = await prisma.passwordResetToken.findFirstOrThrow({
        where: { tokenHash: hashOneTimeToken(rawToken) },
      });
      expect(token.expiresAt.getTime() - token.issuedAt.getTime()).toBe(
        30 * 60 * 1000,
      );
      expect(token.issuedAt.getTime()).toBeGreaterThanOrEqual(
        beforeIssue.getTime() - 2_000,
      );
      expect(token.issuedAt.getTime()).toBeLessThanOrEqual(
        afterIssue.getTime() + 2_000,
      );
      expect(
        await makeLifecycle({
          now: () => new Date(Date.now() - skewMinutes * 60 * 1000),
        }).resetPassword({ rawToken, newPassword }),
      ).toBe(true);

      const expiredProvider = createRecordingEmailProvider();
      await makeLifecycle({
        emailProvider: expiredProvider,
        now: () => new Date(Date.now() - skewMinutes * 60 * 1000),
      }).requestPasswordReset(user.email);
      const expiredToken = recordedToken(expiredProvider);
      const expiredRecord = await prisma.passwordResetToken.findFirstOrThrow({
        where: { tokenHash: hashOneTimeToken(expiredToken) },
      });
      await prisma.$executeRaw`
      UPDATE password_reset_tokens
      SET issued_at = clock_timestamp() - interval '31 minutes',
          expires_at = clock_timestamp() - interval '1 minute'
      WHERE id = ${expiredRecord.id}::uuid`;
      const passwordHasher: PasswordHasher = {
        hash: vi.fn(argon2PasswordHasher.hash),
      };
      expect(
        await makeLifecycle({
          now: () => new Date(Date.now() + skewMinutes * 60 * 1000),
          passwordHasher,
        }).resetPassword({ rawToken: expiredToken, newPassword }),
      ).toBe(false);
      expect(passwordHasher.hash).not.toHaveBeenCalled();
    },
  );

  it("retries token-hash collisions and compensates a failed email delivery", async () => {
    const { user } = await seedUser();
    const firstRaw = randomBytes(32).toString("base64url");
    const secondRaw = randomBytes(32).toString("base64url");
    const tokens = [firstRaw, secondRaw];
    const tokenProvider: OneTimeTokenProvider = {
      generate: vi.fn(() => {
        const rawToken = tokens.shift();
        if (rawToken === undefined)
          throw new Error("Unexpected token generation");
        return { rawToken, tokenHash: hashOneTimeToken(rawToken) };
      }),
    };
    const collisionClockRows = await prisma.$queryRaw<Array<{ now: Date }>>`
      SELECT clock_timestamp() - interval '1 minute' AS now`;
    const collisionIssuedAt = collisionClockRows[0]?.now;
    if (collisionIssuedAt === undefined)
      throw new Error("Missing database time");
    await prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: hashOneTimeToken(firstRaw),
        issuedAt: collisionIssuedAt,
        expiresAt: new Date(collisionIssuedAt.getTime() + 1800000),
      },
    });
    const provider = createRecordingEmailProvider();
    await makeLifecycle({
      emailProvider: provider,
      tokenProvider,
    }).requestPasswordReset(user.email);
    expect(tokenProvider.generate).toHaveBeenCalledTimes(2);
    expect(recordedToken(provider)).toBe(secondRaw);

    const failedProvider: IdentityEmailProvider = {
      send: vi.fn().mockRejectedValue(new Error("private provider failure")),
    };
    await makeLifecycle({ emailProvider: failedProvider }).requestPasswordReset(
      user.email,
    );
    expect(failedProvider.send).toHaveBeenCalledTimes(1);
    const requests = await prisma.passwordResetToken.findMany({
      where: { userId: user.id },
      orderBy: { issuedAt: "desc" },
    });
    expect(requests[0]?.revokedAt).toBeInstanceOf(Date);
  });
  it("rejects a link delivered before provider failure when token compensation also fails", async () => {
    const { user } = await seedUser();
    let deliveredUrl: string | undefined;
    const provider: IdentityEmailProvider = {
      send: vi.fn(async (message) => {
        deliveredUrl = message.url;
        throw new Error("provider failed after delivery");
      }),
    };
    const baseRepository =
      createPrismaBetterAuthCredentialLifecycleRepository(prisma);
    const repository: PasswordResetRepository = {
      ...baseRepository,
      revokePasswordResetToken: vi
        .fn()
        .mockRejectedValue(new Error("repository revoke failed")),
    };
    await makeLifecycle({
      emailProvider: provider,
      repository,
    }).requestPasswordReset(user.email);
    expect(provider.send).toHaveBeenCalledTimes(1);
    if (deliveredUrl === undefined)
      throw new Error("Provider did not deliver URL");
    const rawToken = new URL(deliveredUrl).searchParams.get("token");
    if (rawToken === null) throw new Error("Delivered URL omitted token");
    const pending = await prisma.passwordResetToken.findFirstOrThrow({
      where: { tokenHash: hashOneTimeToken(rawToken) },
    });
    expect(pending).toMatchObject({
      deliveryConfirmedAt: null,
      requiresNativeDeliveryConfirmation: true,
      revokedAt: null,
    });
    const passwordHasher: PasswordHasher = {
      hash: vi.fn(argon2PasswordHasher.hash),
    };
    expect(
      await makeLifecycle({ passwordHasher }).resetPassword({
        rawToken,
        newPassword,
      }),
    ).toBe(false);
    expect(passwordHasher.hash).not.toHaveBeenCalled();
  });

  it("does not acknowledge a delayed delivery after a replacement token is issued", async () => {
    const { user } = await seedUser();
    let deliveredUrl: string | undefined;
    let signalDelivered!: () => void;
    let releaseDelivery!: () => void;
    const delivered = new Promise<void>((resolve) => {
      signalDelivered = resolve;
    });
    const deliveryGate = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    const provider: IdentityEmailProvider = {
      async send(message) {
        deliveredUrl = message.url;
        signalDelivered();
        await deliveryGate;
      },
    };
    const pendingRequest = makeLifecycle({
      emailProvider: provider,
    }).requestPasswordReset(user.email);
    try {
      await delivered;
      const firstToken =
        deliveredUrl === undefined
          ? null
          : new URL(deliveredUrl).searchParams.get("token");
      if (firstToken === null) throw new Error("Delivered URL omitted token");
      const passwordHasher: PasswordHasher = {
        hash: vi.fn(argon2PasswordHasher.hash),
      };
      expect(
        await makeLifecycle({ passwordHasher }).resetPassword({
          rawToken: firstToken,
          newPassword,
        }),
      ).toBe(false);
      expect(passwordHasher.hash).not.toHaveBeenCalled();
      const replacementProvider = createRecordingEmailProvider();
      await makeLifecycle({
        emailProvider: replacementProvider,
      }).requestPasswordReset(user.email);
      releaseDelivery();
      await pendingRequest;
      const first = await prisma.passwordResetToken.findFirstOrThrow({
        where: { tokenHash: hashOneTimeToken(firstToken) },
      });
      expect(first).toMatchObject({
        deliveryConfirmedAt: null,
        replacedAt: expect.any(Date),
      });
      expect(
        await prisma.passwordResetToken.findFirstOrThrow({
          where: {
            tokenHash: hashOneTimeToken(recordedToken(replacementProvider)),
          },
        }),
      ).toMatchObject({ deliveryConfirmedAt: expect.any(Date) });
    } finally {
      releaseDelivery();
      await pendingRequest;
    }
  });

  it("allows only one concurrent completion", async () => {
    const { user } = await seedUser();
    const provider = createRecordingEmailProvider();
    const lifecycle = makeLifecycle({ emailProvider: provider });
    await lifecycle.requestPasswordReset(user.email);
    const rawToken = recordedToken(provider);
    const results = await Promise.all([
      lifecycle.resetPassword({
        rawToken,
        newPassword: "concurrent password one",
      }),
      lifecycle.resetPassword({
        rawToken,
        newPassword: "concurrent password two",
      }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(
      await prisma.user
        .findUniqueOrThrow({ where: { id: user.id } })
        .then((row) => row.credentialVersion),
    ).toBe(user.credentialVersion + 1n);
  });

  it("rechecks database expiry after password hashing before changing native credentials", async () => {
    const { user } = await seedUser();
    const provider = createRecordingEmailProvider();
    const lifecycle = makeLifecycle({ emailProvider: provider });
    await lifecycle.requestPasswordReset(user.email);
    const rawToken = recordedToken(provider);
    const tokenRecord = await prisma.passwordResetToken.findFirstOrThrow({
      where: { userId: user.id, tokenHash: hashOneTimeToken(rawToken) },
    });
    const passwordHasher: PasswordHasher = {
      async hash(password) {
        await prisma.passwordResetToken.update({
          where: { id: tokenRecord.id },
          data: { expiresAt: new Date(Date.now() - 1) },
        });
        return argon2PasswordHasher.hash(password);
      },
    };
    expect(
      await makeLifecycle({ passwordHasher }).resetPassword({
        rawToken,
        newPassword,
      }),
    ).toBe(false);
    expect(
      await prisma.user.findUniqueOrThrow({ where: { id: user.id } }),
    ).toMatchObject({
      credentialVersion: user.credentialVersion,
    });
  });

  it("rolls back password reset and revocation when native-session deletion fails inside PostgreSQL", async () => {
    const { user, credentialHash } = await seedUser();
    const nativeSession = await establish(user.email);
    const provider = createRecordingEmailProvider();
    const lifecycle = makeLifecycle({ emailProvider: provider });
    await lifecycle.requestPasswordReset(user.email);
    const rawToken = recordedToken(provider);
    const token = await prisma.passwordResetToken.findFirstOrThrow({
      where: { userId: user.id, tokenHash: hashOneTimeToken(rawToken) },
    });
    const challengeIssuedAt = new Date();
    const challenge = await prisma.emailVerificationChallenge.create({
      data: {
        credentialVersion: user.credentialVersion,
        issuedAt: challengeIssuedAt,
        expiresAt: new Date(challengeIssuedAt.getTime() + 10 * 60 * 1000),
        failedOtpAttempts: 0,
        otpMac: randomBytes(32).toString("hex"),
        otpKeyId: 1,
        linkTokenHash: randomBytes(32).toString("hex"),
        userId: user.id,
      },
    });
    const functionName = `reset_test_fail_${randomBytes(8).toString("hex")}`;
    const triggerName = `reset_test_fail_${randomBytes(8).toString("hex")}`;
    await prisma.$executeRawUnsafe(
      `CREATE FUNCTION "${functionName}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.user_id = '${user.id}'::uuid THEN RAISE EXCEPTION 'test-only reset failure'; END IF; RETURN OLD; END $$`,
    );
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER "${triggerName}" BEFORE DELETE ON better_auth_sessions FOR EACH ROW EXECUTE FUNCTION "${functionName}"()`,
    );
    try {
      await expect(
        lifecycle.resetPassword({ rawToken, newPassword }),
      ).rejects.toThrow("test-only reset failure");
    } finally {
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS "${triggerName}" ON better_auth_sessions`,
      );
      await prisma.$executeRawUnsafe(
        `DROP FUNCTION IF EXISTS "${functionName}"()`,
      );
    }
    expect(
      await prisma.user.findUniqueOrThrow({ where: { id: user.id } }),
    ).toMatchObject({
      credentialVersion: user.credentialVersion,
      passwordChangedAt: user.passwordChangedAt,
    });
    expect(
      await prisma.betterAuthAccount.findFirstOrThrow({
        where: { userId: user.id, providerId: "credential" },
      }),
    ).toMatchObject({ password: credentialHash });
    expect(
      await prisma.betterAuthSession.findUnique({
        where: { id: nativeSession.nativeSession.session.id },
      }),
    ).not.toBeNull();
    expect(
      await prisma.passwordResetToken.findUniqueOrThrow({
        where: { id: token.id },
      }),
    ).toMatchObject({ consumedAt: null, revokedAt: null });
    expect(
      await prisma.emailVerificationChallenge.findUniqueOrThrow({
        where: { id: challenge.id },
      }),
    ).toMatchObject({ revokedAt: null, revocationReason: null });
    expect(
      (
        await loginService.login(
          { email: user.email, password: initialPassword },
          new Headers({ origin }),
        )
      ).outcome,
    ).toBe("authenticated");
  });

  it("does not finalize a provisional native login created before reset", async () => {
    const { user } = await seedUser();
    const provider = createRecordingEmailProvider();
    const lifecycle = makeLifecycle({ emailProvider: provider });
    await lifecycle.requestPasswordReset(user.email);
    const rawToken = recordedToken(provider);
    // Better Auth's adapter resolves the PascalCase delegate, not the domain delegate.
    const delegate: unknown = Reflect.get(prisma, "BetterAuthSession");
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
    if (!isSessionDelegate(delegate))
      throw new Error("Native session delegate unavailable");
    const create = delegate.create.bind(delegate);
    let signalCreated!: () => void;
    let releaseCreate!: () => void;
    const created = new Promise<void>((resolve) => {
      signalCreated = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const delayed = vi
      .spyOn(delegate, "create")
      .mockImplementationOnce((args) => {
        const pending = create(args);
        const then = pending.then.bind(pending);
        pending.then = (fulfilled, rejected) =>
          then(async (provisional) => {
            expect(provisional.stockwisePurpose).toBeNull();
            signalCreated();
            await gate;
            return provisional;
          }).then(fulfilled, rejected);
        return pending;
      });
    try {
      const login = loginService.login(
        { email: user.email, password: initialPassword },
        new Headers({ origin }),
      );
      await created;
      expect(await lifecycle.resetPassword({ rawToken, newPassword })).toBe(
        true,
      );
      releaseCreate();
      // Reset deletes the provisional session before native resolution; login
      // must fail closed without returning an authenticated result or cookies.
      await expect(login).rejects.toThrow();
    } finally {
      releaseCreate();
      delayed.mockRestore();
    }
    expect(
      await prisma.betterAuthSession.count({ where: { userId: user.id } }),
    ).toBe(0);
  });

  it("rejects issued tokens after native eligibility changes and suppresses ineligible provider sends", async () => {
    const { user } = await seedUser();
    const provider = createRecordingEmailProvider();
    const lifecycle = makeLifecycle({ emailProvider: provider });
    await lifecycle.requestPasswordReset(user.email);
    const rawToken = recordedToken(provider);
    await prisma.user.update({
      where: { id: user.id },
      data: { status: "DISABLED", disabledAt: new Date() },
    });
    expect(await lifecycle.resetPassword({ rawToken, newPassword })).toBe(
      false,
    );
    const failingProvider: IdentityEmailProvider = {
      send: vi.fn().mockRejectedValue(new Error("private delivery detail")),
    };
    await expect(
      makeLifecycle({ emailProvider: failingProvider }).requestPasswordReset(
        user.email,
      ),
    ).resolves.toBeUndefined();
    expect(failingProvider.send).not.toHaveBeenCalled();
  });

  it("exercises the isolated HTTP routes without real mail", async () => {
    const provider = createRecordingEmailProvider();
    await runHttpSmoke(makeLifecycle({ emailProvider: provider }), provider);
  });

  it("rejects a selected session when password reset commits before activity resolution", async () => {
    const { user } = await seedUser();
    const { cookie, nativeSession } = await establish(user.email);
    const provider = createRecordingEmailProvider();
    const lifecycle = makeLifecycle({ emailProvider: provider });
    await lifecycle.requestPasswordReset(user.email);
    const rawToken = recordedToken(provider);
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
    const touching = active(request(cookie));
    try {
      await selected.promise;
      expect(await lifecycle.resetPassword({ rawToken, newPassword })).toBe(
        true,
      );
    } finally {
      release.resolve();
    }
    expect(await touching).toBeNull();
    expect(
      await prisma.betterAuthSession.findUnique({
        where: { id: nativeSession.session.id },
      }),
    ).toBeNull();
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: user.id } }))
        .credentialVersion,
    ).toBe(user.credentialVersion + 1n);
  });

  it("password reset revokes a session even when activity holds its revocation locks", async () => {
    const { user } = await seedUser();
    const { cookie, nativeSession } = await establish(user.email);
    const provider = createRecordingEmailProvider();
    const hashed = Promise.withResolvers<void>();
    const lifecycle = makeLifecycle({
      emailProvider: provider,
      passwordHasher: {
        async hash(password) {
          const result = await hashPassword(password);
          hashed.resolve();
          return result;
        },
      },
    });
    await lifecycle.requestPasswordReset(user.email);
    const rawToken = recordedToken(provider);
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
    const reset = lifecycle.resetPassword({ rawToken, newPassword });
    let blocked = false;
    try {
      await hashed.promise;
      for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
        const rows = await prisma.$queryRaw<{ blocked: boolean }[]>`
          SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database()
              AND wait_event_type = 'Lock'
              AND query ILIKE '%users%'
          ) AS blocked
        `;
        blocked = rows[0]?.blocked === true;
      }
    } finally {
      release.resolve();
    }
    const [authority, completed] = await Promise.all([touching, reset]);
    expect(blocked).toBe(true);
    expect(authority?.sessionId).toBe(nativeSession.session.id);
    expect(completed).toBe(true);
    expect(await bridge(request(cookie))).toBeNull();
    expect(
      await prisma.betterAuthSession.findUnique({
        where: { id: nativeSession.session.id },
      }),
    ).toBeNull();
  });
});
