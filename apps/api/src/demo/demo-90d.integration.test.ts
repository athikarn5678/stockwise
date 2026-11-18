import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";

import { Router } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../app.ts";
import { loadApiEnvironment } from "../environment.ts";
import { Prisma } from "../generated/prisma/client.ts";
import { loadTestDatabaseEnvironment } from "../test/database-environment.ts";
import {
  createTestPrismaClient,
  resetTestDatabase,
} from "../test/database-harness.ts";
import { ORGANIZATION_ROLES } from "../modules/identity/authorization-policy.ts";
import { createBetterAuthApplicationRuntime } from "../modules/identity/better-auth-application-runtime.ts";
import { createRecordingEmailProvider } from "../modules/identity/email-provider.ts";
import { createBranchRouter } from "../modules/organizations/branch-router.ts";
import { createBranchService } from "../modules/organizations/branch-service.ts";
import { createPrismaBranchRepository } from "../modules/organizations/branch-repository.ts";
import { createAnalyticsContextEngine } from "../modules/analytics/analytics-context.ts";
import { createAnalyticsDimensionCursorCodec } from "../modules/analytics/analytics-dimension-cursor.ts";
import type { InventoryDimension } from "../modules/analytics/analytics-inventory-values.ts";
import { createAnalyticsInventoryService } from "../modules/analytics/analytics-inventory-service.ts";
import { createPrismaAnalyticsInventoryRepository } from "../modules/analytics/analytics-inventory-repository.ts";
import { createPrismaAnalyticsSalesRepository } from "../modules/analytics/analytics-sales-repository.ts";
import { createPrismaAnalyticsScopeRepository } from "../modules/analytics/analytics-scope-repository.ts";
import {
  createDemoInsightReader,
  DEMO_INSIGHT_HEADINGS,
} from "../modules/ai-insights/demo-insight.ts";
import { bootstrapDemo90d, demo90dCatalog } from "./demo-90d-bootstrap.ts";
import { demoWindowShape } from "./demo-30d-plan.ts";
import {
  assertDemoHistory,
  readDemoProvenance,
} from "./demo-30d-provenance.ts";
import { runDemo30d } from "./demo-30d-runner.ts";

// Gated on both the guarded disposable target and its ownership receipt: the
// demo runner attests the receipt itself before any write.
const configured =
  !!process.env.TEST_DATABASE_URL && !!process.env.TEST_DISPOSABLE_RECEIPT;
const suite = describe.skipIf(!configured);
const environment = loadTestDatabaseEnvironment();
const prisma = createTestPrismaClient(environment);

/** Test-only credential; ≥15 code points, as the demo policy requires. */
const DEMO_PASSWORD = "M4-S1-Integration-Demo-2026!";
/** The exclusive local boundary of the 90-day window, one day after the seed. */
const REFERENCE_DATE = "2026-11-17";
const SEED = 90;
const ORDER_COUNT = 3 * Math.ceil(demoWindowShape(REFERENCE_DATE).days / 15);
/** Bootstrap instant is before the window that starts 90 days back. */
const BOOTSTRAP_CREATED_AT = new Date("2026-08-05T00:00:00.000Z");
/** The window ends 2026-11-16T17:00Z; analytics must observe it as complete. */
const ANALYTICS_NOW = new Date("2026-11-17T17:00:00.000Z");
const PUBLIC_WEB_ORIGIN = "https://web.example.test";
const NATIVE_COOKIE_PREFIX = "stockwise_native.session_token=";
const recordedEmail = createRecordingEmailProvider();
const cursorCodec = createAnalyticsDimensionCursorCodec(Buffer.alloc(32, 11));

const catalog = demo90dCatalog();
const organizationId = catalog.organization.id;
const ownerUserId = catalog.users.find((user) => user.role === "OWNER")!.id;

const apiEnvironment = loadApiEnvironment({
  DATABASE_URL: environment.TEST_DATABASE_URL,
  STOCKWISE_RUNTIME_ENV: "test",
  STOCKWISE_API_PORT: "3104",
  STOCKWISE_PUBLIC_WEB_ORIGIN: PUBLIC_WEB_ORIGIN,
  STOCKWISE_BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
  STOCKWISE_INVITATION_CONTINUATION_KEY: randomBytes(32).toString("base64url"),
  STOCKWISE_ANALYTICS_CURSOR_HMAC_KEY: randomBytes(32).toString("base64url"),
  STOCKWISE_VERIFICATION_OTP_KEY: randomBytes(32).toString("base64url"),
  STOCKWISE_VERIFICATION_OTP_KEY_ID: "1",
  STOCKWISE_VERIFICATION_PROOF_KEY: randomBytes(32).toString("base64url"),
  STOCKWISE_VERIFICATION_PROOF_KEY_ID: "1",
});

type DemoProvenance = NonNullable<
  Awaited<ReturnType<typeof readDemoProvenance>>
>;

let provenance: DemoProvenance | undefined;
let server: Server | undefined;
let runtime: ReturnType<typeof createBetterAuthApplicationRuntime> | undefined;
let baseUrl = "";

const seedOptions = () => ({
  organizationId,
  referenceDate: REFERENCE_DATE,
  seed: SEED,
  shape: demoWindowShape(REFERENCE_DATE),
});

function seededProvenance(): DemoProvenance {
  if (provenance === undefined)
    throw new Error("The shared demo fixture was not seeded.");
  return provenance;
}

async function post(path: string, body: unknown) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { origin: PUBLIC_WEB_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** The Native application cookie from an authenticated login response. */
function nativeSessionCookie(response: Response): string {
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith(NATIVE_COOKIE_PREFIX));
  if (cookie === undefined)
    throw new Error("Login did not set a Native application session cookie.");
  return cookie.split(";", 1)[0]!;
}

interface AccessContextBody {
  data: {
    organizations: Array<{
      id: string;
      name: string;
      role: string;
      branches: Array<{ code: string; id: string }>;
    }>;
  };
}

/** Sorted ids and row counts of every table an idempotent rerun must preserve. */
async function seedIdentity() {
  const ids = { select: { id: true }, orderBy: { id: "asc" } } as const;
  return {
    counts: {
      betterAuthAccounts: await prisma.betterAuthAccount.count(),
      inventoryTransactions: await prisma.inventoryTransaction.count(),
      purchaseOrders: await prisma.purchaseOrder.count(),
      purchaseReceipts: await prisma.purchaseReceipt.count(),
      saleRefunds: await prisma.saleRefund.count(),
      sales: await prisma.sale.count(),
      users: await prisma.user.count(),
    },
    sales: await prisma.sale.findMany(ids),
    purchaseOrders: await prisma.purchaseOrder.findMany(ids),
    purchaseReceipts: await prisma.purchaseReceipt.findMany(ids),
    saleRefunds: await prisma.saleRefund.findMany(ids),
    inventoryTransactions: await prisma.inventoryTransaction.findMany(ids),
    users: await prisma.user.findMany(ids),
    betterAuthAccounts: await prisma.betterAuthAccount.findMany(ids),
  };
}

/**
 * Demo provenance lives outside the harness-owned `public` schema, so a reset
 * leaves the previous run's row (and its fingerprint) behind. Clear only this
 * suite's row so every run starts from an actually empty demo database.
 */
async function clearDemoProvenance() {
  const relation = await prisma.$queryRaw<Array<{ exists: string | null }>>`
    SELECT to_regclass('stockwise_demo.seed_runs')::text AS exists`;
  if (!relation[0]?.exists) return;
  await prisma.$executeRaw`DELETE FROM stockwise_demo.seed_runs WHERE organization_id = ${organizationId}::uuid`;
}

suite("DEMO-90D one-command seed on disposable PostgreSQL", () => {
  beforeAll(async () => {
    await resetTestDatabase(environment);
    await clearDemoProvenance();
    const bootstrap = await bootstrapDemo90d(prisma, {
      password: DEMO_PASSWORD,
      createdAt: BOOTSTRAP_CREATED_AT,
    });
    expect(bootstrap.created).toBe(true);
    expect(bootstrap.organizationId).toBe(organizationId);
    const applied = await runDemo30d(prisma, { ...seedOptions(), apply: true });
    expect(applied.status).toBe("APPLIED");
    provenance =
      (await readDemoProvenance(prisma, organizationId)) ?? undefined;
    if (provenance === undefined)
      throw new Error("The applied demo seed recorded no provenance.");

    runtime = createBetterAuthApplicationRuntime({
      environment: apiEnvironment,
      prisma,
      emailProvider: recordedEmail,
      onDeliveryFailure() {},
    });
    const router = Router();
    router.use(
      createBranchRouter({
        authenticationMiddleware: runtime.authenticationMiddleware,
        branchService: createBranchService({
          repository: createPrismaBranchRepository(prisma),
        }),
        publicWebOrigin: PUBLIC_WEB_ORIGIN,
      }),
    );
    router.use(runtime.router);
    const started = createServer(
      createApp({
        apiRouter: router,
        logger: { error() {}, info() {} },
      }),
    );
    await new Promise<void>((resolve, reject) => {
      started.once("error", reject);
      started.listen(0, "127.0.0.1", resolve);
    });
    server = started;
    const address = started.address();
    if (address === null || typeof address === "string")
      throw new Error("HTTP test server unavailable");
    baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
  }, 900_000);

  afterAll(async () => {
    if (runtime !== undefined) await runtime.drain();
    const started = server;
    if (started !== undefined)
      await new Promise<void>((resolve, reject) => {
        started.close((error) => (error ? reject(error) : resolve()));
      });
    await resetTestDatabase(environment);
    await prisma.$disconnect();
  });

  it("creates identity, catalog and 90 days of activity in one pipeline", async () => {
    const plan = seededProvenance().plan;

    const organizations = await prisma.organization.findMany({
      select: { id: true, name: true, reportingTimezone: true },
    });
    expect(organizations).toHaveLength(1);
    expect(organizations[0]).toEqual({
      id: organizationId,
      name: "Siam Mart",
      reportingTimezone: "Asia/Bangkok",
    });

    const branches = await prisma.branch.findMany({
      where: { organizationId },
      select: { code: true },
      orderBy: { code: "asc" },
    });
    expect(branches.map((branch) => branch.code)).toEqual([
      "EAST",
      "MAIN",
      "NORTH",
    ]);

    const memberships = await prisma.organizationMembership.findMany({
      where: { organizationId },
      select: {
        role: true,
        status: true,
        user: { select: { email: true, id: true } },
      },
    });
    expect(memberships).toHaveLength(5);
    expect(memberships.every((row) => row.status === "ACTIVE")).toBe(true);
    expect(new Set(memberships.map((row) => row.role))).toEqual(
      new Set(ORGANIZATION_ROLES),
    );
    expect(memberships.filter((row) => row.role === "OWNER")).toHaveLength(1);
    const roleByEmail = new Map(
      memberships.map((row) => [row.user.email, row.role]),
    );
    expect(roleByEmail).toEqual(
      new Map(catalog.users.map((user) => [user.email, user.role])),
    );
    const emailByUserId = new Map(
      memberships.map((row) => [row.user.id, row.user.email]),
    );

    expect(await prisma.product.count({ where: { organizationId } })).toBe(12);
    expect(await prisma.supplier.count({ where: { organizationId } })).toBe(2);

    // Only the three branch-scoped roles are assigned; OWNER/ADMIN stay wide.
    const assignments = await prisma.branchAssignment.findMany({
      where: { organizationId },
      select: { userId: true },
    });
    const assignedByEmail = new Map<string, number>();
    for (const assignment of assignments) {
      const email = emailByUserId.get(assignment.userId);
      if (email === undefined)
        throw new Error("A demo assignment references a foreign user.");
      assignedByEmail.set(email, (assignedByEmail.get(email) ?? 0) + 1);
    }
    expect(assignments).toHaveLength(4);
    expect(assignedByEmail.get("owner@hcn920.com")).toBeUndefined();
    expect(assignedByEmail.get("admin@hcn920.com")).toBeUndefined();
    expect(assignedByEmail.get("manager@hcn920.com")).toBe(2);
    expect(assignedByEmail.get("inventory@hcn920.com")).toBe(1);
    expect(assignedByEmail.get("cashier@hcn920.com")).toBe(1);

    expect(await prisma.sale.count({ where: { organizationId } })).toBe(
      plan.sales.length,
    );

    const orders = await prisma.purchaseOrder.findMany({
      where: { organizationId },
      select: { status: true, receipt: { select: { id: true } } },
    });
    expect(orders).toHaveLength(ORDER_COUNT);
    expect(orders.every((order) => order.status === "RECEIVED")).toBe(true);
    expect(orders.every((order) => order.receipt !== null)).toBe(true);
    expect(
      await prisma.purchaseReceipt.count({ where: { organizationId } }),
    ).toBe(ORDER_COUNT);

    const methods = await prisma.payment.findMany({
      distinct: ["method"],
      select: { method: true },
      where: { organizationId },
    });
    expect(new Set(methods.map((payment) => payment.method))).toEqual(
      new Set(["CASH", "TRANSFER"]),
    );

    expect(await prisma.saleRefund.count({ where: { organizationId } })).toBe(
      plan.sales.filter((sale) => sale.refund).length,
    );
    expect(
      await prisma.inventoryTransaction.count({
        where: { organizationId, source: "MANUAL_ADJUSTMENT" },
      }),
    ).toBe(9);

    const balances = await prisma.inventoryBalance.findMany({
      where: { organizationId },
      select: { quantity: true },
    });
    expect(balances).toHaveLength(
      catalog.branches.length * catalog.products.length,
    );
    expect(balances.every((balance) => balance.quantity.gte(0))).toBe(true);

    expect(seededProvenance().state).toBe("COMPLETE");
    expect(seededProvenance().signature).toBe(plan.signature);
    await expect(
      assertDemoHistory(prisma, plan, true),
    ).resolves.toBeUndefined();
  }, 300_000);

  it("reruns the identical pipeline without duplicating any row", async () => {
    const before = await seedIdentity();
    expect(before.counts.sales).toBe(seededProvenance().plan.sales.length);
    expect(before.counts.betterAuthAccounts).toBe(5);
    expect(before.counts.users).toBe(5);

    expect(
      await bootstrapDemo90d(prisma, {
        password: DEMO_PASSWORD,
        createdAt: BOOTSTRAP_CREATED_AT,
      }),
    ).toEqual({ organizationId, created: false });
    expect(
      (await runDemo30d(prisma, { ...seedOptions(), apply: true })).status,
    ).toBe("APPLIED");
    expect(await seedIdentity()).toEqual(before);

    // Different parameters than the recorded provenance stay refused.
    await expect(
      runDemo30d(prisma, { ...seedOptions(), seed: SEED + 1, apply: true }),
    ).rejects.toThrow(/parameters differ/);
    expect(await seedIdentity()).toEqual(before);
  }, 900_000);

  it("logs every seeded role in through real Native login with its organization role", async () => {
    for (const user of catalog.users) {
      const login = await post("/auth/login", {
        email: user.email,
        password: DEMO_PASSWORD,
      });
      expect(login.status, user.email).toBe(200);
      const cookie = nativeSessionCookie(login);
      const access = await fetch(`${baseUrl}/me/access-context`, {
        headers: { cookie },
      });
      expect(access.status, user.email).toBe(200);
      const body = (await access.json()) as AccessContextBody;
      expect(body.data.organizations, user.email).toHaveLength(1);
      expect(body.data.organizations[0], user.email).toMatchObject({
        id: organizationId,
        role: user.role,
      });
      if (user.role === "OWNER" || user.role === "ADMIN")
        expect(body.data.organizations[0]!.branches, user.email).toHaveLength(
          3,
        );
      else
        expect(
          body.data.organizations[0]!.branches.map((branch) => branch.code),
          user.email,
        ).toEqual([...user.branchCodes].sort());
      expect(
        await prisma.betterAuthSession.count({
          where: { userId: user.id, stockwisePurpose: "APPLICATION" },
        }),
      ).toBe(1);
    }

    // The store owner can sign in with the visible store address.
    const ownerLogin = await post("/auth/login", {
      email: "owner@hcn920.com",
      password: DEMO_PASSWORD,
    });
    expect(ownerLogin.status).toBe(200);

    // Seeding and logging in sent no email and left no verification or reset token.
    expect(recordedEmail.messages).toHaveLength(0);
    expect(await prisma.passwordResetToken.count()).toBe(0);
    expect(await prisma.betterAuthVerification.count()).toBe(0);

    const rejected = await post("/auth/login", {
      email: catalog.users[0]!.email,
      password: "not-the-seeded-demo-password-1",
    });
    expect(rejected.status).toBe(401);
    expect(rejected.headers.getSetCookie()).not.toContainEqual(
      expect.stringMatching(new RegExp(NATIVE_COOKIE_PREFIX)),
    );
  }, 120_000);

  it("reports non-empty real analytics for the seeded 90-day period", async () => {
    const plan = seededProvenance().plan;
    const contextEngine = createAnalyticsContextEngine({
      now: () => ANALYTICS_NOW,
      scopeRepository: createPrismaAnalyticsScopeRepository(prisma),
    });
    const resolved = await contextEngine.resolve({
      actorUserId: ownerUserId,
      analyticsKind: "business",
      from: plan.from,
      granularity: "day",
      organizationId,
      scope: { kind: "organization" },
      to: plan.to,
    });
    expect(resolved.kind).toBe("success");
    if (resolved.kind !== "success") throw new Error("analytics context");

    const sales = await createPrismaAnalyticsSalesRepository(prisma).read(
      resolved.context,
    );
    expect(sales.buckets).toHaveLength(demoWindowShape(REFERENCE_DATE).days);
    expect(sales.buckets[0]?.localStartInclusive).toBe(plan.from);
    expect(sales.buckets.reduce((count, b) => count + b.saleCount, 0)).toBe(
      plan.sales.length,
    );
    const netSales = sales.buckets.reduce(
      (total, bucket) => total.plus(bucket.netSalesAmount),
      new Prisma.Decimal(0),
    );
    expect(netSales.gt(0)).toBe(true);

    const inventoryService = createAnalyticsInventoryService({
      contextEngine,
      cursorCodec,
      repository: createPrismaAnalyticsInventoryRepository(
        prisma,
        cursorCodec,
        {
          now: () => ANALYTICS_NOW,
        },
      ),
    });
    const dimensions: InventoryDimension[] = [];
    let cursor: string | undefined;
    do {
      const page = await inventoryService.read({
        actorUserId: ownerUserId,
        from: plan.from,
        granularity: "day",
        limit: 100,
        organizationId,
        scope: { kind: "organization" },
        to: plan.to,
        ...(cursor === undefined ? {} : { cursor }),
      });
      expect(page.kind).toBe("success");
      if (page.kind !== "success") throw new Error("inventory analytics");
      dimensions.push(...page.page.series);
      expect(page.page.branches).toHaveLength(3);
      cursor = page.page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    expect(dimensions).toHaveLength(
      catalog.branches.length * catalog.products.length,
    );
    expect(new Set(dimensions.map((row) => row.branchId)).size).toBe(3);
    expect(new Set(dimensions.map((row) => row.productId)).size).toBe(12);
  }, 300_000);

  it("renders the five fixed Demo Insight headings in Thai and English", async () => {
    const plan = seededProvenance().plan;
    const reader = createDemoInsightReader({
      prisma,
      cursorCodec,
      organizationId,
      runtimeEnvironment: "test",
    });
    const headings = [
      DEMO_INSIGHT_HEADINGS.overview,
      DEMO_INSIGHT_HEADINGS.sales,
      DEMO_INSIGHT_HEADINGS.products,
      DEMO_INSIGHT_HEADINGS.notes,
      DEMO_INSIGHT_HEADINGS.actions,
    ];
    for (const [language, label] of [
      ["th", "ข้อมูลตัวอย่าง"],
      ["en", "Demo Insight"],
    ] as const) {
      const result = await reader.read({
        actorUserId: ownerUserId,
        language,
        organizationId,
        scope: { kind: "organization" },
      });
      expect(result.kind, language).toBe("success");
      if (result.kind !== "success") throw new Error("demo insight");
      expect(result.insight.providerCalls, language).toBe(0);
      expect(result.insight.provider, language).toBeNull();
      expect(result.insight.label, language).toBe(label);
      expect(result.insight.from, language).toBe(plan.from);
      expect(result.insight.to, language).toBe(plan.to);
      expect(result.insight.content, language).toContain(
        result.insight.metrics.netRevenue,
      );

      const lines = result.insight.content.split("\n");
      const positions = headings.map((heading) => lines.indexOf(heading));
      expect(
        positions.every((position) => position >= 0),
        language,
      ).toBe(true);
      for (let index = 1; index < positions.length; index += 1)
        expect(positions[index]!, language).toBeGreaterThan(
          positions[index - 1]!,
        );
    }
  }, 300_000);

  // Resets the shared fixture, so it must stay last.
  it("refuses bootstrap into a database that already holds another organization", async () => {
    await resetTestDatabase(environment);
    const foreign = await prisma.organization.create({
      data: { name: "Foreign UAT tenant" },
      select: { id: true },
    });
    await expect(
      bootstrapDemo90d(prisma, {
        password: DEMO_PASSWORD,
        createdAt: BOOTSTRAP_CREATED_AT,
      }),
    ).rejects.toThrow(/requires an empty database/);
    expect(await prisma.organization.count()).toBe(1);
    expect(await prisma.organization.count({ where: { id: foreign.id } })).toBe(
      1,
    );
    expect(
      await prisma.organization.count({ where: { id: organizationId } }),
    ).toBe(0);
    await resetTestDatabase(environment);
  }, 120_000);
});
