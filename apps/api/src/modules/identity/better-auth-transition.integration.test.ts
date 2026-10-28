import { createApp } from "../../app.ts";
import { startApiServer } from "../../server.ts";
import { createPrismaAuthenticationRepository } from "./authentication-repository.ts";
import { createPrismaVerificationRepository } from "./verification-repository.ts";
import { createLoginService } from "./login-service.ts";
import { createLoginRouter } from "./login-router.ts";
import { createLoginLimiter } from "./login-limiter.ts";
import { argon2PasswordVerifier } from "./password-hasher.ts";
import { secureSessionTokenProvider } from "./session-token.ts";
import { testVerificationSecurity } from "../../test/identity-backend-fixture.ts";
import { defaultAuthenticationAuthority } from "../../environment.ts";

import { createPrismaCheckoutRepository } from "../sales/checkout-repository.ts";
import { createPrismaRefundRepository } from "../sales/refund-repository.ts";
import { createPrismaReceivingRepository } from "../purchasing/receiving-repository.ts";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { readMigrationSourceManifest } from "../../../../../tests/e2e/better-auth-d5/migration-contract.mts";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createBetterAuthNative } from "./better-auth-native.ts";
import { createBetterAuthApplicationRuntime } from "./better-auth-application-runtime.ts";
import { loadApiEnvironment } from "../../environment.ts";
import { getTrustedAuthenticationContext } from "./authentication-context.ts";
import { verifyLocalPostgresReceipt } from "../../../../../tests/e2e/better-auth-d5/local-runner.mts";
import { createPrismaAuthenticationSessionRepository } from "./authentication-repository.ts";
import { createPrismaCredentialLifecycleRepository } from "./credential-lifecycle-repository.ts";
import { resetTestDatabase } from "../../test/database-harness.ts";
import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient, type User } from "../../generated/prisma/client.ts";
import { loadTestDatabaseEnvironment } from "../../test/database-environment.ts";
import {
  hashPassword,
  verifyPassword,
  DUMMY_PASSWORD_HASH,
} from "./password-hasher.ts";
import { createDisposableNativeTransition } from "../../../../../tests/e2e/better-auth-d5/native-transition.mts";
import { createPasswordResetService } from "./credential-lifecycle-service.ts";
import { createPrismaBetterAuthCredentialLifecycleRepository } from "./credential-lifecycle-repository.ts";
import { argon2PasswordHasher } from "./password-hasher.ts";
import {
  createRecordingEmailProvider,
  type IdentityEmailMessage,
} from "./email-provider.ts";
import { secureOneTimeTokenProvider } from "./one-time-token.ts";

const database = loadTestDatabaseEnvironment();
const receiptText = process.env.STOCKWISE_LOCAL_DATABASE_RECEIPT;
if (!receiptText) throw new Error("Disposable transition receipt is required.");
const receipt: unknown = JSON.parse(receiptText);
const prisma = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: database.TEST_DATABASE_URL,
    idleTimeoutMillis: 0,
  }),
});
const legacyPassword = "transition fixture password é🔒";
const nativePassword = "native reset replacement password 🔐";
const nativeDummyHash =
  "$argon2id$v=19$m=65536,p=4,t=3$MELWslgkJzw87Me69Wz1tw$l9XoBv1UBhpmS40M2xzT5cHzqoSubftPd1Md5u/ZmvQ";
const origin = "https://web.example.test";
const configuration = {
  absoluteTimeoutMilliseconds: 604800000,
  idleTimeoutMilliseconds: 86400000,
  touchIntervalMilliseconds: 900000,
  secureCookie: false,
};
let nativeRuntime: { drain(): Promise<void> } | undefined;
let nativeServer: { stop(): Promise<void> } | undefined;

interface TransitionFixture {
  user: User;
  legacyHash: string;
  nativeHash: string | undefined;
  organization: { id: string } | undefined;
  membership:
    { id: string; organizationId: string; userId: string } | undefined;
}

const audit: {
  migrations: {
    migration_name: string;
    checksum: string;
    finished_at: Date | null;
    rolled_back_at: Date | null;
  }[];
  events: {
    step: string;
    observed: Record<string, string | number | boolean | null | string[]>;
  }[];
} = { migrations: [], events: [] };
async function recordEvidence(
  step: string,
  observed: Record<string, string | number | boolean | null | string[]>,
) {
  audit.events.push({ step, observed });
  const output = fileURLToPath(
    new URL(
      "../../../../../test-results/native-transition-reconciliation.json",
      import.meta.url,
    ),
  );
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(audit, null, 2));
}

async function fixture({
  eligible = true,
  emailVerified = true,
  verifiedAt = new Date(),
  status = "ACTIVE",
  displayName = "Transition fixture",
  passwordHash,
  account = false,
  nativeCompletedAt = null,
}: {
  eligible?: boolean;
  emailVerified?: boolean;
  verifiedAt?: Date | null;
  status?: "ACTIVE" | "DISABLED";
  displayName?: string | null;
  passwordHash?: string;
  account?: boolean;
  nativeCompletedAt?: Date | null;
} = {}) {
  const id = randomUUID();
  const now = new Date();
  const hash =
    passwordHash ??
    (eligible ? await hashPassword(legacyPassword) : DUMMY_PASSWORD_HASH);
  const user = await prisma.user.create({
    data: {
      id,
      email: `${id}@example.test`,
      passwordHash: hash,
      status,
      disabledAt: status === "DISABLED" ? now : null,
      displayName,
      emailVerified,
      emailVerifiedAt: verifiedAt,
      nativeRegistrationCompletedAt: nativeCompletedAt,
      passwordChangedAt: now,
    },
  });
  let organization: { id: string } | undefined;
  let membership:
    { id: string; organizationId: string; userId: string } | undefined;
  if (eligible) {
    organization = await prisma.organization.create({
      data: { name: `Transition ${id}`, salesVatStatus: "NOT_REGISTERED" },
    });
    membership = await prisma.organizationMembership.create({
      data: { organizationId: organization.id, role: "OWNER", userId: id },
    });
  }
  let nativeHash: string | undefined;
  if (account) {
    nativeHash = await hashPassword("preexisting Native account password");
    await prisma.betterAuthAccount.create({
      data: {
        userId: id,
        accountId: id,
        providerId: "credential",
        password: nativeHash,
      },
    });
  }
  return { user, legacyHash: hash, nativeHash, organization, membership };
}
async function seedBusinessHistory(actor: TransitionFixture) {
  if (!actor.organization || !actor.membership)
    throw new Error("Business actor membership fixture is unavailable.");
  const { user, organization, membership } = actor;
  const branch = await prisma.branch.create({
    data: {
      code: `TR-${randomUUID().slice(0, 8).toUpperCase()}`,
      name: "Transition history branch",
      organizationId: organization.id,
    },
  });
  const otherOrganization = await prisma.organization.create({
    data: { name: `Transition other tenant ${user.id}` },
  });
  const otherBranch = await prisma.branch.create({
    data: {
      code: `TR-${randomUUID().slice(0, 8).toUpperCase()}`,
      name: "Transition other tenant branch",
      organizationId: otherOrganization.id,
    },
  });
  const foreignOwner = await fixture({ eligible: false });
  await prisma.organizationMembership.create({
    data: {
      organizationId: otherOrganization.id,
      role: "OWNER",
      userId: foreignOwner.user.id,
    },
  });
  const assignedUser = await fixture();
  await prisma.organizationMembership.create({
    data: {
      organizationId: organization.id,
      role: "BRANCH_MANAGER",
      userId: assignedUser.user.id,
    },
  });
  await prisma.branchAssignment.create({
    data: {
      branchId: branch.id,
      organizationId: organization.id,
      userId: assignedUser.user.id,
    },
  });
  const product = await prisma.product.create({
    data: {
      basePrice: "10",
      name: "Transition history product",
      organizationId: organization.id,
      sku: `TR-${randomUUID().slice(0, 8).toUpperCase()}`,
      unit: "EA",
    },
  });
  await prisma.$transaction([
    prisma.inventoryBalance.create({
      data: {
        branchId: branch.id,
        organizationId: organization.id,
        productId: product.id,
        quantity: "10",
      },
    }),
    prisma.inventoryTransaction.create({
      data: {
        actorUserId: user.id,
        actorMembershipId: membership.id,
        branchId: branch.id,
        organizationId: organization.id,
        productId: product.id,
        delta: "10",
        source: "MANUAL_ADJUSTMENT",
        adjustmentReason: "STOCK_COUNT",
        idempotencyKeyHash: randomBytes(32).toString("hex"),
        canonicalRequestHash: randomBytes(32).toString("hex"),
      },
    }),
  ]);
  await prisma.inventoryCostState.create({
    data: {
      averageUnitCost: "3",
      basisState: "KNOWN",
      branchId: branch.id,
      inventoryValue: "30",
      organizationId: organization.id,
      productId: product.id,
    },
  });
  const checkout = await createPrismaCheckoutRepository(prisma).checkout({
    actorUserId: user.id,
    branchId: branch.id,
    discount: null,
    idempotencyKey: randomUUID(),
    items: [{ expectedUnitPrice: "10", productId: product.id, quantity: "2" }],
    organizationId: organization.id,
    payment: { amountTendered: "20", method: "CASH" },
  });
  if (checkout.kind !== "success")
    throw new Error("Historical sale fixture failed.");
  const refund = await createPrismaRefundRepository(prisma).createRefund({
    actorUserId: user.id,
    branchId: branch.id,
    idempotencyKey: randomUUID(),
    items: [
      {
        quantity: "1",
        restockQuantity: "1",
        saleItemId: checkout.sale.items[0]!.id,
      },
    ],
    organizationId: organization.id,
    reason: "Transition preservation fixture",
    saleId: checkout.sale.id,
    transferReference: null,
  });
  if (refund.kind !== "success")
    throw new Error("Historical refund fixture failed.");
  const supplier = await prisma.supplier.create({
    data: {
      name: "Transition history supplier",
      organizationId: organization.id,
    },
  });
  const order = await prisma.purchaseOrder.create({
    data: {
      branchId: branch.id,
      createdByMembershipId: membership.id,
      createdByUserId: user.id,
      expectedTotal: "6",
      items: {
        create: [
          {
            expectedUnitCost: "3",
            productId: product.id,
            productNameSnapshot: product.name,
            productSkuSnapshot: product.sku,
            quantity: "2",
          },
        ],
      },
      orderDate: new Date(),
      orderedAt: new Date(),
      organizationId: organization.id,
      reference: `TR-PO-${randomUUID()}`,
      status: "ORDERED",
      supplierId: supplier.id,
    },
    include: { items: true },
  });
  const receipt = await createPrismaReceivingRepository(
    prisma,
  ).receivePurchaseOrder({
    actorUserId: user.id,
    actualCosts: [
      { actualUnitCost: "3", purchaseOrderItemId: order.items[0]!.id },
    ],
    idempotencyKey: randomUUID(),
    organizationId: organization.id,
    purchaseOrderId: order.id,
    vat: {
      inputVatAmount: null,
      inputVatRate: null,
      organizationVatRegistered: false,
      supplierTaxDocumentDate: null,
      supplierTaxDocumentNumber: null,
    },
  });
  if (receipt.kind !== "success")
    throw new Error("Historical receipt fixture failed.");
  return {
    branch,
    otherBranch,
    otherOrganization,
    product,
    assignedUser,
    saleId: checkout.sale.id,
    refundId: refund.refund.id,
    receiptId: receipt.receipt.id,
  };
}

async function businessActorReferences(userId: string) {
  return {
    memberships: await prisma.organizationMembership.findMany({
      where: { userId },
      orderBy: { id: "asc" },
      select: {
        id: true,
        userId: true,
        organizationId: true,
        role: true,
        status: true,
        sourceInvitationId: true,
      },
    }),
    branchAssignments: await prisma.branchAssignment.findMany({
      where: { userId },
      orderBy: [{ organizationId: "asc" }, { branchId: "asc" }],
      select: {
        userId: true,
        organizationId: true,
        branchId: true,
        status: true,
        deactivatedAt: true,
      },
    }),
    inventoryTransactions: await prisma.inventoryTransaction.findMany({
      where: { actorUserId: userId },
      orderBy: { id: "asc" },
      select: {
        id: true,
        actorUserId: true,
        actorMembershipId: true,
        organizationId: true,
        branchId: true,
        productId: true,
      },
    }),
    sales: await prisma.sale.findMany({
      where: { actorUserId: userId },
      orderBy: { id: "asc" },
      select: {
        id: true,
        actorUserId: true,
        actorMembershipId: true,
        organizationId: true,
        branchId: true,
      },
    }),
    refunds: await prisma.saleRefund.findMany({
      where: { actorUserId: userId },
      orderBy: { id: "asc" },
      select: {
        id: true,
        actorUserId: true,
        actorMembershipId: true,
        organizationId: true,
        branchId: true,
      },
    }),
    receipts: await prisma.purchaseReceipt.findMany({
      where: { receivedByUserId: userId },
      orderBy: { id: "asc" },
      select: {
        id: true,
        receivedByUserId: true,
        receivedByMembershipId: true,
        organizationId: true,
        branchId: true,
      },
    }),
  };
}

async function workerRehearsal(
  mode: "interrupt" | "replay",
  userId: string,
  expected: {
    credentialVersion: bigint;
    passwordChangedAt: Date;
    updatedAt: Date;
  },
) {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["SystemRoot", "WINDIR", "PATH", "Path", "TEMP", "TMP"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  let control: Client | undefined;
  const suffix = randomUUID().replaceAll("-", "");
  const functionName = `transition_pause_${suffix}`;
  const triggerName = `transition_pause_${suffix}`;
  const key = randomBytes(4).readUInt32BE() & 0x7fffffff;
  if (mode === "interrupt") {
    if (!/^[a-f0-9-]{36}$/.test(userId))
      throw new Error("Invalid interruption target");
    control = new Client({ connectionString: database.TEST_DATABASE_URL });
    await control.connect();
    await control.query(
      `CREATE FUNCTION public.${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(1729, ${key}); RETURN NEW; END $$`,
    );
    await control.query(
      `CREATE TRIGGER ${triggerName} BEFORE INSERT ON public.native_auth_enrollments FOR EACH ROW WHEN (NEW.user_id = '${userId}'::uuid) EXECUTE FUNCTION public.${functionName}()`,
    );
    await control.query("BEGIN");
    await control.query("SELECT pg_advisory_xact_lock(1729, $1)", [key]);
  }
  // This is a resource watchdog, not a guessed synchronization delay. The
  // interruption barrier below waits for an actual database insert to finish.
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      fileURLToPath(
        new URL(
          "../../../../../tests/e2e/better-auth-d5/native-transition-worker.mts",
          import.meta.url,
        ),
      ),
    ],
    {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      timeout: 10_000,
    },
  );
  let output = "";
  child.stdout.on("data", (data: Buffer) => {
    output += data.toString();
  });
  child.stderr.resume();
  const done = Promise.withResolvers<number | null>();
  child.once("error", done.reject);
  child.once("close", done.resolve);
  const paused = Promise.withResolvers<void>();
  if (mode === "interrupt") {
    child.stdout.on("data", () => {
      if (output.includes("TRANSITION_STARTED")) paused.resolve();
    });
    child.once("close", () =>
      paused.reject(
        new Error("Transition worker exited before interruption barrier"),
      ),
    );
  }
  child.stdin.end(
    JSON.stringify({
      mode,
      userId,
      databaseUrl: process.env.DATABASE_URL,
      testDatabaseUrl: database.TEST_DATABASE_URL,
      receipt,
      expected: {
        credentialVersion: expected.credentialVersion.toString(),
        passwordChangedAt: expected.passwordChangedAt,
        updatedAt: expected.updatedAt,
      },
    }),
  );
  try {
    if (mode === "interrupt") {
      await paused.promise;
      if (!control) throw new Error("Interruption controller is unavailable");
      const deadline = Date.now() + 5000;
      let waiter: number | undefined;
      while (Date.now() < deadline && waiter === undefined) {
        const waiting = await control.query<{ pid: number }>(
          "SELECT l.pid FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE l.locktype = 'advisory' AND NOT l.granted AND l.classid = 1729 AND l.objid = $1 AND a.datname = current_database() AND a.usename = current_user",
          [key],
        );
        waiter = waiting.rows[0]?.pid;
      }
      if (waiter === undefined)
        throw new Error(
          "Worker did not reach the database interruption barrier",
        );
      child.kill();
      // Both the Node child and the exact run-owned waiting backend terminate.
      // The trigger barrier proves account insertion happened before rollback.
      await control.query("SELECT pg_terminate_backend($1, 1000)", [waiter]);
    }
    const code = await done.promise;
    if (mode === "interrupt") return "INTERRUPTED";
    if (code !== 0) throw new Error("Transition worker refused replay");
    const result: unknown = JSON.parse(output);
    if (
      typeof result !== "object" ||
      result === null ||
      !("outcome" in result) ||
      typeof result.outcome !== "string"
    )
      throw new Error("Transition worker returned invalid summary");
    return result.outcome;
  } finally {
    if (child.exitCode === null) child.kill();
    if (control) {
      await control.query("ROLLBACK");
      await control.query(
        `DROP TRIGGER IF EXISTS ${triggerName} ON public.native_auth_enrollments`,
      );
      await control.query(`DROP FUNCTION IF EXISTS public.${functionName}()`);
      await control.end();
    }
  }
}

describe("guarded disposable Legacy-to-Native transition", () => {
  afterAll(async () => {
    await nativeServer?.stop();
    await nativeRuntime?.drain();
    await prisma.$disconnect();
  });

  it("transfers only eligible Legacy credentials, fences old authority, and reconciles exact replay", async () => {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl)
      throw new Error("Disposable application database URL is required.");
    const client = new Client({ connectionString: database.TEST_DATABASE_URL });
    await client.connect();
    if (!verifyLocalPostgresReceipt(receipt, dbUrl, database.TEST_DATABASE_URL))
      throw new Error("Disposable transition receipt mismatch");
    const parsed = receipt;
    try {
      const target = await client.query<{
        name: string;
        marker: string | null;
      }>(
        "SELECT current_database() AS name, shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname = current_database()",
      );
      expect(target.rows[0]?.name).toBe(parsed.testDatabase);
      expect(
        target.rows[0]?.marker === `stockwise-local:${parsed.marker}`,
      ).toBe(true);
      await expect(
        createDisposableNativeTransition({
          prisma,
          databaseUrl: dbUrl,
          testDatabaseUrl: database.TEST_DATABASE_URL,
          receipt: null,
        }),
      ).rejects.toThrow("TRANSITION_DISPOSABLE_AUTHORIZATION_REQUIRED");
      await expect(
        createDisposableNativeTransition({
          prisma,
          databaseUrl: dbUrl,
          testDatabaseUrl: database.TEST_DATABASE_URL.replace(
            "stockwise_test_test",
            "wrong_test",
          ),
          receipt,
        }),
      ).rejects.toThrow("TRANSITION_DISPOSABLE_AUTHORIZATION_REQUIRED");
      await client.query(
        "COMMENT ON DATABASE stockwise_test_test IS 'stockwise-local:wrong-marker'",
      );
      try {
        await expect(
          createDisposableNativeTransition({
            prisma,
            databaseUrl: dbUrl,
            testDatabaseUrl: database.TEST_DATABASE_URL,
            receipt,
          }),
        ).rejects.toThrow("TRANSITION_OPERATION_REFUSED");
      } finally {
        await client.query(
          `COMMENT ON DATABASE stockwise_test_test IS 'stockwise-local:${parsed.marker}'`,
        );
      }
    } finally {
      await client.end();
    }

    const transition = await createDisposableNativeTransition({
      prisma,
      databaseUrl: dbUrl,
      testDatabaseUrl: database.TEST_DATABASE_URL,
      receipt,
    });
    audit.migrations =
      await prisma.$queryRaw`SELECT migration_name, checksum, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY migration_name`;
    const sourceMigrations = await readMigrationSourceManifest(
      fileURLToPath(new URL("../../../prisma/migrations/", import.meta.url)),
    );
    expect(
      audit.migrations.every(
        (row) => row.finished_at !== null && row.rolled_back_at === null,
      ),
    ).toBe(true);
    expect(
      audit.migrations.map((row) => ({
        name: row.migration_name,
        sha256: row.checksum,
      })),
    ).toEqual(
      sourceMigrations.migrations.map(({ name, sha256 }) => ({ name, sha256 })),
    );
    const databaseIdentity = await prisma.$queryRaw<
      { name: string; version: string }[]
    >`SELECT current_database() AS name, current_setting('server_version') AS version`;
    await recordEvidence("migration-and-target-receipt", {
      database: databaseIdentity[0]?.name ?? "",
      postgres: databaseIdentity[0]?.version ?? "",
      appliedMigrations: audit.migrations.length,
    });

    const eligible = await fixture();
    const history = await seedBusinessHistory(eligible);
    const alternateHash = eligible.legacyHash.replace(
      /\$m=65536,(?:t=3,p=4|p=4,t=3)\$/,
      eligible.legacyHash.includes("$m=65536,t=3,p=4$")
        ? "$m=65536,p=4,t=3$"
        : "$m=65536,t=3,p=4$",
    );
    expect(alternateHash !== eligible.legacyHash).toBe(true);
    const alternateGenuine = await fixture({ passwordHash: alternateHash });

    const disabled = await fixture({ status: "DISABLED" });
    const unverified = await fixture({
      emailVerified: false,
      verifiedAt: null,
    });
    const incomplete = await fixture({
      eligible: false,
      displayName: null,
      passwordHash: await hashPassword(legacyPassword),
    });
    const dummy = await fixture({
      passwordHash: DUMMY_PASSWORD_HASH,
    });
    const dummyCases = await Promise.all(
      [
        { variant: "legacy-original", subject: dummy },
        {
          variant: "legacy-reordered",
          subject: await fixture({
            passwordHash: DUMMY_PASSWORD_HASH.replace(
              "m=65536,p=4,t=3",
              "m=65536,t=3,p=4",
            ),
          }),
        },
        {
          variant: "native-original",
          subject: await fixture({ passwordHash: nativeDummyHash }),
        },
        {
          variant: "native-reordered",
          subject: await fixture({
            passwordHash: nativeDummyHash.replace(
              "m=65536,p=4,t=3",
              "m=65536,t=3,p=4",
            ),
          }),
        },
      ].map(async ({ variant, subject }) => {
        const dummyHistory = await seedBusinessHistory(subject);
        return {
          variant,
          subject,
          history: dummyHistory,
          branchBefore: await prisma.branch.findUniqueOrThrow({
            where: { id: dummyHistory.branch.id },
          }),
          businessBefore: await businessActorReferences(subject.user.id),
          assignedBefore: await businessActorReferences(
            dummyHistory.assignedUser.user.id,
          ),
        };
      }),
    );
    const malformed = await fixture({
      passwordHash: "not-an-argon2id-phc",
    });
    const unsupported = await fixture({
      passwordHash: (await hashPassword(legacyPassword)).replace(
        "m=65536",
        "m=32768",
      ),
    });
    const partialDestination = await fixture({ account: true });
    const misowned = await fixture();
    const foreignCredentialOwner = await fixture({ eligible: false });
    await prisma.betterAuthAccount.create({
      data: {
        userId: foreignCredentialOwner.user.id,
        accountId: misowned.user.id,
        providerId: "credential",
        password: await hashPassword(nativePassword),
      },
    });
    const destination = await fixture({
      eligible: true,
      account: true,
      nativeCompletedAt: new Date(),
    });
    const mismatch = await fixture({
      emailVerified: false,
      verifiedAt: new Date(),
    });
    const rollback = await fixture();
    const stale = await fixture();
    const concurrent = await fixture();
    const interrupted = await fixture();
    const assignedBefore = await businessActorReferences(
      history.assignedUser.user.id,
    );
    const oldSessionToken = secureSessionTokenProvider.generate();
    const legacyTokenHash = oldSessionToken.tokenHash;
    const issuedAt = new Date();
    await prisma.session.create({
      data: {
        userId: eligible.user.id,
        tokenHash: legacyTokenHash,
        issuedAt,
        lastUsedAt: issuedAt,
        idleExpiresAt: new Date(issuedAt.getTime() + 86400000),
        absoluteExpiresAt: new Date(issuedAt.getTime() + 604800000),
      },
    });
    const oldSessions = createPrismaAuthenticationSessionRepository(prisma);
    expect(
      (
        await oldSessions.resolveSession({
          tokenHash: legacyTokenHash,
          now: new Date(),
          configuration,
        })
      )?.actor.id,
    ).toBe(eligible.user.id);
    const legacyReset = createPrismaCredentialLifecycleRepository(prisma);
    const oldResetHash = randomBytes(32).toString("hex");
    const oldReset = await legacyReset.issuePasswordResetToken({
      email: eligible.user.email,
      issuedAt,
      expiresAt: new Date(issuedAt.getTime() + 1800000),
      tokenHash: oldResetHash,
    });
    if (!oldReset) throw new Error("Legacy recovery fixture was not issued");
    const concurrentReset = await legacyReset.issuePasswordResetToken({
      email: concurrent.user.email,
      issuedAt,
      expiresAt: new Date(issuedAt.getTime() + 1800000),
      tokenHash: randomBytes(32).toString("hex"),
    });
    if (!concurrentReset)
      throw new Error("Concurrent Legacy reset fixture was not issued");
    const oldChallenge = await prisma.emailVerificationChallenge.create({
      data: {
        userId: unverified.user.id,
        credentialVersion: unverified.user.credentialVersion,
        issuedAt,
        expiresAt: new Date(issuedAt.getTime() + 600000),
        linkTokenHash: randomBytes(32).toString("hex"),
        otpMac: randomBytes(32).toString("hex"),
        otpKeyId: 1,
        failedOtpAttempts: 0,
      },
    });
    const membershipIdsBefore = (
      await prisma.organizationMembership.findMany({
        where: { userId: eligible.user.id },
        select: { id: true },
      })
    ).map((membership) => membership.id);
    const businessBefore = await businessActorReferences(eligible.user.id);
    expect(businessBefore.sales.map((row) => row.id)).toEqual([history.saleId]);
    expect(businessBefore.refunds.map((row) => row.id)).toEqual([
      history.refundId,
    ]);
    expect(businessBefore.receipts.map((row) => row.id)).toEqual([
      history.receiptId,
    ]);
    const ledger = await prisma.inventoryTransaction.aggregate({
      where: { branchId: history.branch.id, productId: history.product.id },
      _sum: { delta: true },
    });
    const balance = await prisma.inventoryBalance.findUniqueOrThrow({
      where: {
        branchId_productId: {
          branchId: history.branch.id,
          productId: history.product.id,
        },
      },
    });
    expect(ledger._sum.delta?.equals(balance.quantity)).toBe(true);

    const environment = loadApiEnvironment({
      DATABASE_URL: database.TEST_DATABASE_URL,
      STOCKWISE_RUNTIME_ENV: "test",
      STOCKWISE_API_PORT: "3103",
      STOCKWISE_PUBLIC_WEB_ORIGIN: origin,
      STOCKWISE_BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
      STOCKWISE_INVITATION_CONTINUATION_KEY:
        randomBytes(32).toString("base64url"),
      STOCKWISE_ANALYTICS_CURSOR_HMAC_KEY:
        randomBytes(32).toString("base64url"),
      STOCKWISE_VERIFICATION_OTP_KEY: randomBytes(32).toString("base64url"),
      STOCKWISE_VERIFICATION_OTP_KEY_ID: "1",
      STOCKWISE_VERIFICATION_PROOF_KEY: randomBytes(32).toString("base64url"),
      STOCKWISE_VERIFICATION_PROOF_KEY_ID: "1",
    });
    const runtimeMail = createRecordingEmailProvider();
    let delivered = Promise.withResolvers<IdentityEmailMessage>();
    let rejectDelivery = false;
    const deliveryFailure = Promise.withResolvers<void>();
    const runtime = createBetterAuthApplicationRuntime({
      environment,
      prisma,
      emailProvider: {
        async send(message, signal) {
          if (rejectDelivery) {
            rejectDelivery = false;
            throw new Error("Synthetic non-delivery");
          }
          await runtimeMail.send(message, signal);
          delivered.resolve(message);
        },
      },
      onDeliveryFailure(kind) {
        if (kind === "verification") deliveryFailure.resolve();
      },
    });
    nativeRuntime = runtime;
    runtime.router.get(
      "/transition-protected",
      runtime.authenticationMiddleware,
      (_request, response) => {
        response.json({
          id: getTrustedAuthenticationContext(response)?.actor.id,
        });
      },
    );
    const nativeRunning = await startApiServer(
      createApp({
        apiRouter: runtime.router,
        logger: { error() {}, info() {} },
      }),
      { host: "127.0.0.1", port: 0 },
    );
    nativeServer = nativeRunning;
    const postNative = (path: string, body: unknown, cookie?: string) =>
      fetch(`http://127.0.0.1:${nativeRunning.address.port}/api/v1${path}`, {
        method: "POST",
        headers: {
          origin,
          "content-type": "application/json",
          ...(cookie ? { cookie } : {}),
        },
        body: JSON.stringify(body),
      });
    const nativeReader = createBetterAuthNative({
      prisma,
      publicWebOrigin: origin,
      secret: environment.STOCKWISE_BETTER_AUTH_SECRET!,
      secureCookie: false,
    });
    const pendingEmail = `${randomUUID()}@example.test`;
    const pendingRegistration = await postNative("/auth/register", {
      email: pendingEmail,
      password: legacyPassword,
    });
    expect(pendingRegistration.status).toBe(202);
    await delivered.promise;

    const preflight = await transition.preflight();
    expect(preflight.mode).toBe("LEGACY");
    const observation = (id: string) =>
      preflight.users.find((item) => item.userId === id);
    expect(observation(eligible.user.id)?.eligible).toBe(true);
    expect(observation(stale.user.id)?.eligible).toBe(true);
    expect(observation(unsupported.user.id)?.reason).toBe(
      "LEGACY_CREDENTIAL_UNAVAILABLE",
    );
    expect(observation(partialDestination.user.id)?.eligible).toBe(false);
    expect(observation(misowned.user.id)?.eligible).toBe(false);
    for (const user of [
      disabled,
      unverified,
      incomplete,
      ...dummyCases.map(({ subject }) => subject),
      malformed,
      destination,
      mismatch,
    ])
      expect(observation(user.user.id)?.eligible).toBe(false);

    const drainingWriter = new Client({
      connectionString: database.TEST_DATABASE_URL,
    });
    await drainingWriter.connect();
    await drainingWriter.query("BEGIN");
    await drainingWriter.query(
      "UPDATE users SET password_hash = $1, credential_version = credential_version + 1, password_changed_at = clock_timestamp(), updated_at = clock_timestamp() WHERE id = $2",
      [await hashPassword(nativePassword), stale.user.id],
    );
    const quiescing = transition.quiesce().then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    let waiting = false;
    try {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && !waiting) {
        await drainingWriter.query("SELECT pg_stat_clear_snapshot()");
        const state = await drainingWriter.query<{ waiting: boolean }>(
          "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND pg_backend_pid() = ANY(pg_blocking_pids(pid))) AS waiting",
        );
        waiting = state.rows[0]?.waiting === true;
      }
    } finally {
      await drainingWriter.query("COMMIT");
      await drainingWriter.end();
    }
    const quiescence = await quiescing;
    if ("error" in quiescence) throw quiescence.error;
    expect(quiescence.value.mode).toBe("QUIESCED");
    expect(waiting).toBe(true);
    await expect(resetTestDatabase(database)).rejects.toThrow(
      "test reset refused after authentication transition",
    );
    expect(
      await oldSessions.resolveSession({
        tokenHash: legacyTokenHash,
        now: new Date(),
        configuration,
      }),
    ).toBeNull();
    expect(
      await legacyReset.findValidPasswordResetToken({
        tokenHash: oldResetHash,
        now: new Date(),
      }),
    ).toBeNull();
    expect(
      await legacyReset.completePasswordReset({
        userId: eligible.user.id,
        tokenId: oldReset.id,
        completedAt: new Date(),
        passwordHash: await hashPassword(nativePassword),
      }),
    ).toBe(false);
    expect(
      (
        await prisma.emailVerificationChallenge.findUniqueOrThrow({
          where: { id: oldChallenge.id },
        })
      ).revokedAt !== null,
    ).toBe(true);
    const firstDummyOutcomes = new Map<string, string>();
    for (const denied of [
      disabled,
      unverified,
      incomplete,
      ...dummyCases.map(({ subject }) => subject),
      malformed,
      unsupported,
    ]) {
      const result = await transition.transitionUser(
        denied.user.id,
        denied.user,
      );
      expect(result.outcome).toBe("INELIGIBLE");
      if (dummyCases.some(({ subject }) => subject.user.id === denied.user.id))
        firstDummyOutcomes.set(denied.user.id, result.outcome);
      expect(
        await prisma.betterAuthAccount.count({
          where: { userId: denied.user.id },
        }),
      ).toBe(0);
    }
    for (const {
      variant,
      subject,
      history: dummyHistory,
      branchBefore,
      businessBefore: dummyBusiness,
      assignedBefore: dummyAssigned,
    } of dummyCases) {
      const retry = await transition.transitionUser(
        subject.user.id,
        subject.user,
      );
      expect(retry.outcome).toBe("INELIGIBLE");
      const accounts = await prisma.betterAuthAccount.count({
        where: { userId: subject.user.id },
      });
      const provenance = await prisma.nativeAuthEnrollment.count({
        where: { userId: subject.user.id },
      });
      const current = await prisma.user.findUniqueOrThrow({
        where: { id: subject.user.id },
      });
      expect(accounts).toBe(0);
      expect(provenance).toBe(0);
      expect(current.nativeRegistrationCompletedAt).toBeNull();
      expect(current.id).toBe(subject.user.id);
      expect(current.passwordHash === subject.legacyHash).toBe(true);
      expect(current.credentialVersion).toBe(subject.user.credentialVersion);
      expect(await businessActorReferences(subject.user.id)).toEqual(
        dummyBusiness,
      );
      expect(
        await businessActorReferences(dummyHistory.assignedUser.user.id),
      ).toEqual(dummyAssigned);
      expect(
        await prisma.branch.findUniqueOrThrow({
          where: { id: dummyHistory.branch.id },
        }),
      ).toEqual(branchBefore);
      expect(dummyBusiness.sales.map(({ id }) => id)).toEqual([
        dummyHistory.saleId,
      ]);
      expect(dummyBusiness.refunds.map(({ id }) => id)).toEqual([
        dummyHistory.refundId,
      ]);
      expect(dummyBusiness.receipts.map(({ id }) => id)).toEqual([
        dummyHistory.receiptId,
      ]);
      await recordEvidence("dummy-identity-refused", {
        variant,
        firstOutcome: firstDummyOutcomes.get(subject.user.id) ?? "MISSING",
        retryOutcome: retry.outcome,
        accounts,
        provenance,
        nativeMarkerNull: current.nativeRegistrationCompletedAt === null,
        uuidPreserved: current.id === subject.user.id,
        businessPreserved: true,
      });
    }
    for (const conflict of [partialDestination, misowned]) {
      expect(
        (await transition.transitionUser(conflict.user.id, conflict.user))
          .outcome,
      ).toBe("CONFLICT");
      expect(
        (
          await prisma.user.findUniqueOrThrow({
            where: { id: conflict.user.id },
          })
        ).nativeRegistrationCompletedAt,
      ).toBeNull();
    }
    expect(
      (
        await transition.reconcileVerification(
          unverified.user.id,
          unverified.user,
          "LEGACY_EMAIL_VERIFIED_AT",
        )
      ).outcome,
    ).toBe("UNCHANGED");
    expect(
      (
        await prisma.user.findUniqueOrThrow({
          where: { id: unverified.user.id },
        })
      ).emailVerified,
    ).toBe(false);
    expect(
      (
        await transition.transitionUser(mismatch.user.id, {
          credentialVersion: mismatch.user.credentialVersion,
          passwordChangedAt: mismatch.user.passwordChangedAt,
          updatedAt: mismatch.user.updatedAt,
        })
      ).outcome,
    ).toBe("INELIGIBLE");
    expect(
      (
        await transition.reconcileVerification(
          mismatch.user.id,
          {
            credentialVersion: mismatch.user.credentialVersion,
            passwordChangedAt: mismatch.user.passwordChangedAt,
            updatedAt: mismatch.user.updatedAt,
          },
          "LEGACY_EMAIL_VERIFIED_AT",
        )
      ).outcome,
    ).toBe("RECONCILED");
    const quiescedPreflight = await transition.preflight();
    expect(
      quiescedPreflight.users.find((user) => user.userId === mismatch.user.id)
        ?.eligible,
    ).toBe(true);
    const lockHolder = new Client({
      connectionString: database.TEST_DATABASE_URL,
    });
    await lockHolder.connect();
    await lockHolder.query("BEGIN");
    await lockHolder.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [
      concurrent.user.id,
    ]);
    const firstTransfer = transition.transitionUser(
      concurrent.user.id,
      concurrent.user,
    );
    const secondTransfer = transition.transitionUser(
      concurrent.user.id,
      concurrent.user,
    );
    const competingLogin = postNative("/auth/login", {
      email: concurrent.user.email,
      password: legacyPassword,
    });
    const competingReset = legacyReset.completePasswordReset({
      userId: concurrent.user.id,
      tokenId: concurrentReset.id,
      completedAt: new Date(),
      passwordHash: await hashPassword(nativePassword),
    });
    try {
      // Observe actual lock contention instead of timing the competing writers.
      const deadline = Date.now() + 5000;
      let blocked = 0;
      while (Date.now() < deadline && blocked < 2) {
        await lockHolder.query("SELECT pg_stat_clear_snapshot()");
        const waiting = await lockHolder.query<{ count: number }>(
          "WITH RECURSIVE waiting(pid) AS (SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND pg_backend_pid() = ANY(pg_blocking_pids(pid)) UNION SELECT a.pid FROM pg_stat_activity a JOIN waiting w ON w.pid = ANY(pg_blocking_pids(a.pid)) WHERE a.datname = current_database()) SELECT count(*)::int AS count FROM waiting",
        );
        blocked = waiting.rows[0]?.count ?? 0;
      }
      expect(blocked >= 2).toBe(true);
    } finally {
      await lockHolder.query("COMMIT");
      await lockHolder.end();
    }
    const transfers = await Promise.all([firstTransfer, secondTransfer]);
    expect(transfers.map((result) => result.outcome).sort()).toEqual([
      "REPLAY",
      "TRANSITIONED",
    ]);
    expect((await competingLogin).status === 200).toBe(false);
    expect(await competingReset).toBe(false);
    expect(
      (
        await postNative("/auth/login", {
          email: concurrent.user.email,
          password: legacyPassword,
        })
      ).status === 200,
    ).toBe(false);
    expect(
      await prisma.betterAuthSession.count({
        where: { userId: concurrent.user.id },
      }),
    ).toBe(0);

    expect(
      await workerRehearsal("interrupt", interrupted.user.id, interrupted.user),
    ).toBe("INTERRUPTED");
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${interrupted.user.id}::uuid FOR UPDATE`;
      expect(
        await tx.betterAuthAccount.count({
          where: { userId: interrupted.user.id },
        }),
      ).toBe(0);
      expect(
        (
          await tx.user.findUniqueOrThrow({
            where: { id: interrupted.user.id },
          })
        ).nativeRegistrationCompletedAt,
      ).toBeNull();
      expect(
        await tx.nativeAuthEnrollment.count({
          where: { userId: interrupted.user.id },
        }),
      ).toBe(0);
    });
    expect(
      await workerRehearsal("replay", interrupted.user.id, interrupted.user),
    ).toBe("TRANSITIONED");
    expect(
      await workerRehearsal("replay", interrupted.user.id, interrupted.user),
    ).toBe("REPLAY");
    expect(
      await prisma.betterAuthAccount.count({
        where: { userId: interrupted.user.id },
      }),
    ).toBe(1);

    await recordEvidence("process-interruption-and-restart", {
      destinationAccounts: await prisma.betterAuthAccount.count({
        where: { userId: interrupted.user.id },
      }),
      durableEnrollments: await prisma.nativeAuthEnrollment.count({
        where: { userId: interrupted.user.id },
      }),
    });
    const rollbackExpected = {
      credentialVersion: rollback.user.credentialVersion,
      passwordChangedAt: rollback.user.passwordChangedAt,
      updatedAt: rollback.user.updatedAt,
    };
    const sql = new Client({ connectionString: database.TEST_DATABASE_URL });
    await sql.connect();
    try {
      await sql.query(
        "CREATE FUNCTION public.transition_test_injected_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected transition rollback'; END $$",
      );
      await sql.query(
        `CREATE TRIGGER transition_test_injected_failure BEFORE INSERT ON public.native_auth_enrollments FOR EACH ROW WHEN (NEW.user_id = '${rollback.user.id}'::uuid) EXECUTE FUNCTION public.transition_test_injected_failure()`,
      );
      const refusal = await transition
        .transitionUser(rollback.user.id, rollbackExpected)
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(refusal instanceof Error).toBe(true);
      if (!(refusal instanceof Error))
        throw new Error("Injected transaction was not refused");
      expect(refusal.message.includes(rollback.legacyHash)).toBe(false);
      expect(refusal.cause instanceof Error).toBe(true);
      expect(
        typeof refusal.cause === "object" &&
          refusal.cause !== null &&
          "meta" in refusal.cause,
      ).toBe(false);
      expect(
        await prisma.betterAuthAccount.count({
          where: { userId: rollback.user.id },
        }),
      ).toBe(0);
      const provenance = await prisma.$queryRaw<
        { count: bigint }[]
      >`SELECT count(*)::bigint AS count FROM native_auth_enrollments WHERE user_id = ${rollback.user.id}::uuid`;
      expect(provenance[0]?.count).toBe(0n);
    } finally {
      await sql
        .query(
          "DROP TRIGGER IF EXISTS transition_test_injected_failure ON public.native_auth_enrollments",
        )
        .catch(() => undefined);
      await sql
        .query(
          "DROP FUNCTION IF EXISTS public.transition_test_injected_failure()",
        )
        .catch(() => undefined);
      await sql.end();
    }
    expect(
      (await transition.transitionUser(rollback.user.id, rollbackExpected))
        .outcome,
    ).toBe("TRANSITIONED");

    const expected = {
      credentialVersion: eligible.user.credentialVersion,
      passwordChangedAt: eligible.user.passwordChangedAt,
      updatedAt: eligible.user.updatedAt,
    };
    expect(
      (await transition.transitionUser(eligible.user.id, expected)).outcome,
    ).toBe("TRANSITIONED");
    expect(
      (await transition.transitionUser(eligible.user.id, expected)).outcome,
    ).toBe("REPLAY");
    expect(await workerRehearsal("replay", eligible.user.id, expected)).toBe(
      "REPLAY",
    );
    expect(
      (
        await transition.transitionUser(
          alternateGenuine.user.id,
          alternateGenuine.user,
        )
      ).outcome,
    ).toBe("TRANSITIONED");
    const alternateAccount = await prisma.betterAuthAccount.findFirstOrThrow({
      where: { userId: alternateGenuine.user.id, providerId: "credential" },
    });
    expect(alternateAccount.password === alternateHash).toBe(true);
    expect(
      (
        await transition.transitionUser(stale.user.id, {
          credentialVersion: stale.user.credentialVersion,
          passwordChangedAt: stale.user.passwordChangedAt,
          updatedAt: stale.user.updatedAt,
        })
      ).outcome,
    ).toBe("CONFLICT");
    expect(
      (
        await transition.transitionUser(destination.user.id, {
          credentialVersion: destination.user.credentialVersion,
          passwordChangedAt: destination.user.passwordChangedAt,
          updatedAt: destination.user.updatedAt,
        })
      ).outcome,
    ).toBe("CONFLICT");
    const preservedDestination = await prisma.user.findUniqueOrThrow({
      where: { id: destination.user.id },
      include: { betterAuthAccounts: true },
    });
    expect(preservedDestination.nativeRegistrationCompletedAt).toEqual(
      destination.user.nativeRegistrationCompletedAt,
    );
    expect(preservedDestination.betterAuthAccounts).toHaveLength(1);
    expect(
      preservedDestination.betterAuthAccounts[0]?.password ===
        destination.nativeHash,
    ).toBe(true);
    expect(
      await prisma.user
        .update({
          where: { id: stale.user.id },
          data: { credentialVersion: { increment: 1 } },
        })
        .then(
          () => false,
          () => true,
        ),
    ).toBe(true);

    const enrolled = await prisma.user.findUniqueOrThrow({
      where: { id: eligible.user.id },
      include: { memberships: true, betterAuthAccounts: true },
    });
    expect(enrolled.memberships.map((membership) => membership.id)).toEqual(
      membershipIdsBefore,
    );
    expect(enrolled.betterAuthAccounts).toHaveLength(1);
    expect(enrolled.betterAuthAccounts[0]?.accountId).toBe(eligible.user.id);
    expect(enrolled.betterAuthAccounts[0]?.providerId).toBe("credential");
    expect(
      await verifyPassword(
        enrolled.betterAuthAccounts[0]!.password!,
        legacyPassword,
      ),
    ).toBe(true);
    expect(enrolled.passwordHash === eligible.legacyHash).toBe(true);

    for (const snapshot of quiescedPreflight.users.filter(
      (user) => user.eligible,
    )) {
      const current = await prisma.user.findUniqueOrThrow({
        where: { id: snapshot.userId },
        select: {
          credentialVersion: true,
          passwordChangedAt: true,
          updatedAt: true,
        },
      });
      const result = await transition.transitionUser(snapshot.userId, current);
      expect(["TRANSITIONED", "REPLAY"]).toContain(result.outcome);
    }

    expect(
      await prisma.user
        .update({
          where: { id: eligible.user.id },
          data: {
            passwordHash: await hashPassword("unauthorized Legacy write"),
          },
        })
        .then(
          () => false,
          () => true,
        ),
    ).toBe(true);

    const reconciled = await transition.reconcile();
    expect(reconciled.mode).toBe("QUIESCED");
    expect(reconciled.identityPreserved).toBe(true);
    expect(reconciled.legacyAuthorityRemaining).toBe(0);
    await recordEvidence(
      "identity-fk-and-authority-reconciliation",
      reconciled,
    );
    expect((await transition.seal()).mode).toBe("NATIVE");
    expect((await transition.seal()).mode).toBe("NATIVE");
    for (const denied of [
      disabled,
      unverified,
      incomplete,
      ...dummyCases.map(({ subject }) => subject),
      malformed,
      unsupported,
      partialDestination,
      misowned,
    ]) {
      expect(
        (
          await postNative("/auth/login", {
            email: denied.user.email,
            password: legacyPassword,
          })
        ).status === 200,
      ).toBe(false);
      expect(
        await prisma.betterAuthSession.count({
          where: { userId: denied.user.id },
        }),
      ).toBe(0);
    }
    expect(await businessActorReferences(history.assignedUser.user.id)).toEqual(
      assignedBefore,
    );
    const crossTenant = await createPrismaCheckoutRepository(prisma).checkout({
      actorUserId: eligible.user.id,
      organizationId: history.otherOrganization.id,
      branchId: history.otherBranch.id,
      discount: null,
      idempotencyKey: randomUUID(),
      items: [
        {
          productId: history.product.id,
          expectedUnitPrice: "10",
          quantity: "1",
        },
      ],
      payment: { method: "CASH", amountTendered: "10" },
    });
    expect(crossTenant.kind).toBe("forbidden");
    const nativeLogin = await postNative("/auth/login", {
      email: eligible.user.email,
      password: legacyPassword,
    });
    expect(nativeLogin.status).toBe(200);
    const nativeCookie = nativeLogin.headers
      .getSetCookie()
      .map((cookie) => cookie.split(";")[0])
      .join("; ");
    const nativeSession = await nativeReader.api.getSession({
      headers: new Headers({ cookie: nativeCookie }),
      query: { disableCookieCache: true, disableRefresh: true },
    });
    expect(nativeSession?.user.id).toBe(eligible.user.id);
    expect(
      (
        await fetch(
          `http://127.0.0.1:${nativeRunning.address.port}/api/v1/transition-protected`,
          { headers: { cookie: nativeCookie } },
        )
      ).status,
    ).toBe(200);
    expect(
      await nativeReader.options.emailAndPassword!.password!.verify!({
        hash: enrolled.betterAuthAccounts[0]!.password!,
        password: legacyPassword,
      }),
    ).toBe(true);
    expect(
      await nativeReader.options.emailAndPassword!.password!.verify!({
        hash: alternateAccount.password!,
        password: legacyPassword,
      }),
    ).toBe(true);
    const alternateLogin = await postNative("/auth/login", {
      email: alternateGenuine.user.email,
      password: legacyPassword,
    });
    expect(alternateLogin.status).toBe(200);
    await recordEvidence("genuine-phc-orders-preserved", {
      originalBytesPreserved:
        enrolled.betterAuthAccounts[0]!.password === eligible.legacyHash,
      alternateBytesPreserved: alternateAccount.password === alternateHash,
      originalLoginStatus: nativeLogin.status,
      alternateLoginStatus: alternateLogin.status,
    });
    const currentStaleAccount =
      await prisma.betterAuthAccount.findUniqueOrThrow({
        where: {
          providerId_accountId: {
            providerId: "credential",
            accountId: stale.user.id,
          },
        },
      });
    expect(
      await nativeReader.options.emailAndPassword!.password!.verify!({
        hash: currentStaleAccount.password!,
        password: nativePassword,
      }),
    ).toBe(true);
    expect(await businessActorReferences(eligible.user.id)).toEqual(
      businessBefore,
    );
    const legacyAuthorityWriteDenied = await prisma.user
      .update({
        where: { id: eligible.user.id },
        data: {
          passwordHash: await hashPassword(
            "unauthorized Native-mode Legacy write",
          ),
        },
      })
      .then(
        () => false,
        () => true,
      );
    expect(legacyAuthorityWriteDenied).toBe(true);
    expect(defaultAuthenticationAuthority("test")).toBe("legacy");
    const legacyService = createLoginService({
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
      loginService: legacyService,
      continuationKey: Buffer.alloc(32).toString("base64url"),
      publicWebOrigin: "https://web.example.test",
    });
    const running = await startApiServer(
      createApp({
        apiRouter,
        logger: { error() {}, info() {} },
      }),
      { host: "127.0.0.1", port: 0 },
    );
    try {
      const response = await fetch(
        `http://${running.address.host}:${running.address.port}/api/v1/auth/login`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            Origin: "https://web.example.test",
          },
          body: JSON.stringify({
            email: eligible.user.email,
            password: legacyPassword,
          }),
        },
      );
      expect(response.status).not.toBe(200);
      expect(
        await prisma.session.count({
          where: { userId: eligible.user.id, revokedAt: null },
        }),
      ).toBe(0);
    } finally {
      await running.stop();
    }

    const emailProvider = createRecordingEmailProvider();
    const passwordReset = createPasswordResetService({
      emailProvider,
      passwordHasher: argon2PasswordHasher,
      publicWebOrigin: "https://web.example.test",
      repository: createPrismaBetterAuthCredentialLifecycleRepository(prisma),
      tokenProvider: secureOneTimeTokenProvider,
    });
    await passwordReset.requestPasswordReset(eligible.user.email);
    const message = emailProvider.messages.at(-1);
    if (message?.kind !== "password_reset")
      throw new Error("Native reset email was not recorded.");
    const rawToken = new URL(message.url).searchParams.get("token");
    if (!rawToken) throw new Error("Native reset token was not recorded.");
    expect(
      await passwordReset.resetPassword({
        rawToken,
        newPassword: nativePassword,
      }),
    ).toBe(true);
    expect(
      await passwordReset.resetPassword({
        rawToken,
        newPassword: nativePassword,
      }),
    ).toBe(false);
    expect(
      (await transition.transitionUser(eligible.user.id, expected)).outcome,
    ).toBe("CONFLICT");
    expect(await workerRehearsal("replay", eligible.user.id, expected)).toBe(
      "CONFLICT",
    );
    const afterReset = await prisma.user.findUniqueOrThrow({
      where: { id: eligible.user.id },
      include: { betterAuthAccounts: true },
    });
    expect(
      await verifyPassword(
        afterReset.betterAuthAccounts[0]!.password!,
        nativePassword,
      ),
    ).toBe(true);
    expect(afterReset.passwordHash === eligible.legacyHash).toBe(true);
    expect(
      await prisma.betterAuthSession.count({
        where: { userId: eligible.user.id },
      }),
    ).toBe(0);
    expect(
      (
        await fetch(
          `http://127.0.0.1:${nativeRunning.address.port}/api/v1/transition-protected`,
          { headers: { cookie: nativeCookie } },
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await postNative("/auth/login", {
          email: eligible.user.email,
          password: legacyPassword,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await postNative("/auth/login", {
          email: eligible.user.email,
          password: nativePassword,
        })
      ).status,
    ).toBe(200);
    const staleRestoreRefused = await prisma.user
      .update({
        where: { id: eligible.user.id },
        data: {
          credentialVersion: eligible.user.credentialVersion,
          passwordChangedAt: eligible.user.passwordChangedAt,
          passwordHash: eligible.legacyHash,
        },
      })
      .then(
        () => false,
        () => true,
      );
    expect(staleRestoreRefused).toBe(true);
    expect((await transition.reconcile()).identityPreserved).toBe(true);

    // A fresh, versioned Native registration may replace pre-fence pending
    // delivery material; the old proof generation cannot regain authority.
    delivered = Promise.withResolvers<IdentityEmailMessage>();
    const renewed = await postNative("/auth/register", {
      email: pendingEmail,
      password: nativePassword,
    });
    expect(renewed.status).toBe(202);
    const messageAfterFence = await delivered.promise;
    if (messageAfterFence.kind !== "verification")
      throw new Error("Native verification was not delivered in memory");
    const pending = await prisma.pendingRegistration.findUniqueOrThrow({
      where: { email: pendingEmail },
    });
    const oldProofCookie = pendingRegistration.headers
      .getSetCookie()
      .map((cookie) => cookie.split(";")[0])
      .join("; ");
    expect(
      (
        await postNative(
          "/auth/verify-email-code",
          {
            email: pendingEmail,
            challengeId: pending.challengeId,
            code: messageAfterFence.code,
          },
          oldProofCookie,
        )
      ).status,
    ).toBe(401);
    expect(await prisma.user.count({ where: { id: pending.id } })).toBe(0);
    const proofCookie = renewed.headers
      .getSetCookie()
      .map((cookie) => cookie.split(";")[0])
      .join("; ");
    const verified = await postNative(
      "/auth/verify-email-code",
      {
        email: pendingEmail,
        challengeId: pending.challengeId,
        code: messageAfterFence.code,
      },
      proofCookie,
    );
    expect(verified.status).toBe(200);
    expect(
      await prisma.betterAuthSession.count({ where: { userId: pending.id } }),
    ).toBe(0);
    expect(
      (
        await postNative("/auth/login", {
          email: pendingEmail,
          password: nativePassword,
        })
      ).status,
    ).toBe(200);
    const retainedEmail = `${randomUUID()}@example.test`;
    rejectDelivery = true;
    expect(
      (
        await postNative("/auth/register", {
          email: retainedEmail,
          password: legacyPassword,
        })
      ).status,
    ).toBe(202);
    await deliveryFailure.promise;
    const compensationDeadline = Date.now() + 5000;
    let retained = await prisma.pendingRegistration.findUniqueOrThrow({
      where: { email: retainedEmail },
    });
    while (retained.revokedAt === null && Date.now() < compensationDeadline) {
      retained = await prisma.pendingRegistration.findUniqueOrThrow({
        where: { email: retainedEmail },
      });
    }
    expect(retained.revokedAt !== null).toBe(true);
    delivered = Promise.withResolvers<IdentityEmailMessage>();
    expect(
      (await postNative("/auth/verification-resend", { email: retainedEmail }))
        .status,
    ).toBe(202);
    await delivered.promise;
    const recovered = await prisma.pendingRegistration.findUniqueOrThrow({
      where: { email: retainedEmail },
    });
    expect(recovered.revokedAt).toBeNull();
    expect(recovered.credentialVersion).toBe(retained.credentialVersion);
    expect(recovered.expiresAt).toEqual(retained.expiresAt);
    expect(recovered.passwordHash === retained.passwordHash).toBe(true);
    await recordEvidence("completed-native-forward-recovery-and-registration", {
      nativeDefaultOutsideProduction:
        defaultAuthenticationAuthority("test") === "native",
      migratedUserGeneration: afterReset.credentialVersion.toString(),
      migratedUserNativeAccounts: await prisma.betterAuthAccount.count({
        where: { userId: eligible.user.id },
      }),
      historicalSales: (await businessActorReferences(eligible.user.id)).sales
        .length,
      registrationSessions: await prisma.betterAuthSession.count({
        where: { userId: pending.id },
      }),
    });
  });
});
