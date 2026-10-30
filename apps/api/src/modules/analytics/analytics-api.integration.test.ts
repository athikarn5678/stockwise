import { createHmac, randomUUID } from "node:crypto";
import { Router } from "express";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../../app.ts";
import type { ApiLogger } from "../../logger.ts";
import { startApiServer, type RunningApiServer } from "../../server.ts";
import {
  createTestPrismaClient,
  resetTestDatabase,
} from "../../test/database-harness.ts";
import { loadTestDatabaseEnvironment } from "../../test/database-environment.ts";
import { createPrismaAuthenticationSessionRepository } from "../identity/authentication-repository.ts";
import { createAuthenticationMiddleware } from "../identity/authentication-context.ts";
import { generateSessionToken } from "../identity/session-token.ts";
import { createPrismaCheckoutRepository } from "../sales/checkout-repository.ts";
import { createPrismaAnalyticsBranchRepository } from "./analytics-branch-repository.ts";
import { createAnalyticsBranchService } from "./analytics-branch-service.ts";
import { createPrismaAnalyticsCategoryRepository } from "./analytics-category-repository.ts";
import { createAnalyticsCategoryService } from "./analytics-category-service.ts";
import { createAnalyticsContextEngine } from "./analytics-context.ts";
import { createAnalyticsDimensionCursorCodec } from "./analytics-dimension-cursor.ts";
import { createPrismaAnalyticsInventoryRepository } from "./analytics-inventory-repository.ts";
import { createPrismaForecastRepository } from "./analytics-forecast-repository.ts";
import { createForecastService } from "./analytics-forecast-service.ts";
import { createPrismaReorderRepository } from "./analytics-reorder-repository.ts";
import { createReorderService } from "./analytics-reorder-service.ts";
import { createAnalyticsInventoryService } from "./analytics-inventory-service.ts";
import { createAnalyticsRouter } from "./analytics-router.ts";
import { createPrismaAnalyticsSalesRepository } from "./analytics-sales-repository.ts";
import { createAnalyticsSalesService } from "./analytics-sales-service.ts";
import { createPrismaAnalyticsScopeRepository } from "./analytics-scope-repository.ts";

const environment = loadTestDatabaseEnvironment();
const prisma = createTestPrismaClient(environment);
const now = new Date("2026-09-23T10:00:00.000Z");
const signingKey = Buffer.alloc(32, 17);
const logger: ApiLogger = { error() {}, info() {} };
const period =
  "scope=organization&from=2026-09-21&to=2026-09-23&granularity=day";

function alteredCursor(
  cursor: string,
  changes: Record<string, unknown>,
  resign: boolean,
): string {
  const [body, signature] = cursor.split(".");
  const payload = JSON.parse(
    Buffer.from(body!, "base64url").toString("utf8"),
  ) as Record<string, unknown>;
  const changedBody = Buffer.from(
    JSON.stringify({ ...payload, ...changes }),
  ).toString("base64url");
  const changedSignature = resign
    ? createHmac("sha256", signingKey).update(changedBody).digest("base64url")
    : signature!;
  return `${changedBody}.${changedSignature}`;
}
type Role =
  "OWNER" | "ADMIN" | "BRANCH_MANAGER" | "INVENTORY_STAFF" | "CASHIER";
interface HttpBody {
  data: {
    forecast: Record<string, unknown>;
    recommendation: Record<string, unknown>;
    buckets: {
      grossSalesAmount: string;
      cost: { netCogsAmount: { value: string } };
    }[];
    categories: {
      categoryStatus: string;
      categoryKind: string;
      buckets: { categorySharePercent: { value: string } }[];
    }[];
    branches: {
      branchId: string;
      branchStatus: string;
      buckets: { grossSalesAmount: string }[];
      cost?: {
        inventoryValue: { value: string | null; reason: string | null };
      };
    }[];
    dimensions: {
      branchId: string;
      buckets: {
        saleDepletionQuantity: string;
        purchaseReceivedQuantity: string;
      }[];
      coverageDays: { value: string | null; reason: string | null };
      stockClassification: {
        classification: string | null;
        reason: string | null;
        thresholdVersion: string;
      };
      onHandQuantity: string;
      cost?: {
        inventoryValue: { value: string | null; reason: string | null };
      };
    }[];
  };
  error: { code: string };
  meta: Record<string, unknown>;
}

describe("analytics HTTP API with PostgreSQL", () => {
  let server: RunningApiServer | undefined;
  let analyticsNow = now;

  beforeEach(async () => {
    analyticsNow = now;
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

  async function actor(organizationId: string, role: Role, branchId?: string) {
    const user = await prisma.user.create({
      data: {
        displayName: role,
        email: `${randomUUID()}@example.test`,
        emailVerifiedAt: now,
        passwordHash: "analytics-http-test",
      },
    });
    await prisma.organizationMembership.create({
      data: { organizationId, role, userId: user.id },
    });
    if (branchId !== undefined)
      await prisma.branchAssignment.create({
        data: { branchId, organizationId, userId: user.id },
      });
    const token = generateSessionToken();
    await prisma.session.create({
      data: {
        absoluteExpiresAt: new Date(now.getTime() + 86_400_000),
        idleExpiresAt: new Date(now.getTime() + 86_400_000),
        issuedAt: now,
        lastUsedAt: now,
        tokenHash: token.tokenHash,
        userId: user.id,
      },
    });
    return { id: user.id, cookie: `stockwise_session=${token.rawToken}` };
  }

  async function setup() {
    const organization = await prisma.organization.create({
      data: {
        name: "Analytics HTTP",
        reportingTimezone: "Asia/Bangkok",
        salesVatStatus: "NOT_REGISTERED",
      },
    });
    const other = await prisma.organization.create({
      data: { name: "Other", reportingTimezone: "Asia/Bangkok" },
    });
    await prisma.branch.create({
      data: { code: "OTHER", name: "Other", organizationId: other.id },
    });
    const branches = [];
    for (const code of ["A", "B", "C"] as const) {
      branches.push(
        await prisma.branch.create({
          data: { code, name: code, organizationId: organization.id },
        }),
      );
    }
    await prisma.branch.update({
      where: { id: branches[2]!.id },
      data: { status: "INACTIVE", deactivatedAt: now },
    });
    const category = await prisma.category.create({
      data: {
        name: "Old name",
        normalizedName: "old name",
        organizationId: organization.id,
      },
    });
    const product = await prisma.product.create({
      data: {
        basePrice: "10",
        categoryId: category.id,
        name: "Item",
        organizationId: organization.id,
        sku: "HTTP-ITEM",
        unit: "EA",
      },
    });
    await prisma.inventoryBalance.create({
      data: {
        branchId: branches[0]!.id,
        organizationId: organization.id,
        productId: product.id,
        quantity: "10",
      },
    });
    await prisma.inventoryCostState.create({
      data: {
        averageUnitCost: "3",
        basisState: "KNOWN",
        branchId: branches[0]!.id,
        inventoryValue: "30",
        organizationId: organization.id,
        productId: product.id,
      },
    });
    const owner = await actor(organization.id, "OWNER");
    const admin = await actor(organization.id, "ADMIN");
    const manager = await actor(
      organization.id,
      "BRANCH_MANAGER",
      branches[0]!.id,
    );
    const inventory = await actor(
      organization.id,
      "INVENTORY_STAFF",
      branches[0]!.id,
    );
    const cashier = await actor(organization.id, "CASHIER", branches[0]!.id);
    const outsider = await actor(other.id, "OWNER");
    const sale = await createPrismaCheckoutRepository(prisma, {
      now: () => new Date("2026-09-21T08:00:00.000Z"),
    }).checkout({
      actorUserId: owner.id,
      branchId: branches[0]!.id,
      idempotencyKey: randomUUID(),
      items: [
        { expectedUnitPrice: "10", productId: product.id, quantity: "1" },
      ],
      organizationId: organization.id,
      payment: { amountTendered: "10", method: "CASH" },
      discount: null,
    });
    expect(sale.kind).toBe("success");
    return {
      organization,
      outsiderOrganizationId: other.id,
      branches,
      category,
      product,
      owner,
      admin,
      manager,
      inventory,
      cashier,
      outsider,
    };
  }

  async function start(key = signingKey) {
    const cursorCodec = createAnalyticsDimensionCursorCodec(key);
    const contextEngine = createAnalyticsContextEngine({
      now: () => analyticsNow,
      scopeRepository: createPrismaAnalyticsScopeRepository(prisma),
    });
    const authenticationMiddleware = createAuthenticationMiddleware({
      configuration: {
        absoluteTimeoutMilliseconds: 86_400_000,
        idleTimeoutMilliseconds: 86_400_000,
        secureCookie: false,
        touchIntervalMilliseconds: 900_000,
      },
      now: () => now,
      repository: createPrismaAuthenticationSessionRepository(prisma),
    });
    const router = Router();
    router.use(
      createAnalyticsRouter({
        authenticationMiddleware,
        branchService: createAnalyticsBranchService({
          contextEngine,
          cursorCodec,
          repository: createPrismaAnalyticsBranchRepository(
            prisma,
            cursorCodec,
          ),
        }),
        categoryService: createAnalyticsCategoryService({
          contextEngine,
          cursorCodec,
          repository: createPrismaAnalyticsCategoryRepository(
            prisma,
            cursorCodec,
          ),
        }),
        inventoryService: createAnalyticsInventoryService({
          contextEngine,
          cursorCodec,
          repository: createPrismaAnalyticsInventoryRepository(
            prisma,
            cursorCodec,
            { now: () => analyticsNow },
          ),
        }),
        forecastService: createForecastService(
          createPrismaForecastRepository(prisma, { now: () => analyticsNow }),
        ),
        reorderService: createReorderService(
          createPrismaReorderRepository(prisma, { now: () => analyticsNow }),
        ),
        salesService: createAnalyticsSalesService({
          contextEngine,
          repository: createPrismaAnalyticsSalesRepository(prisma),
        }),
      }),
    );
    server = await startApiServer(createApp({ apiRouter: router, logger }), {
      host: "127.0.0.1",
      port: 0,
    });
  }

  async function get(organizationId: string, path: string, cookie?: string) {
    const response = await fetch(
      `http://127.0.0.1:${server!.address.port}/api/v1/organizations/${organizationId}/analytics/${path}`,
      {
        headers: cookie === undefined ? {} : { Cookie: cookie },
      },
    );
    return {
      status: response.status,
      body: (await response.json()) as HttpBody,
    };
  }

  it("serves canonical Sales buckets to authorized roles and denies other roles and tenants", async () => {
    const fixture = await setup();
    await start();
    for (const role of [fixture.owner, fixture.admin, fixture.manager]) {
      const query =
        role === fixture.manager
          ? `scope=branch&branchId=${fixture.branches[0]!.id}&from=2026-09-21&to=2026-09-23&granularity=day`
          : period;
      const result = await get(
        fixture.organization.id,
        `sales?${query}`,
        role.cookie,
      );
      expect(result.status).toBe(200);
      expect(result.body.data.buckets).toHaveLength(2);
      expect(result.body.data.buckets[0]!.grossSalesAmount).toBe("10.00");
      expect(result.body.data.buckets[0]!.cost.netCogsAmount.value).toBe(
        "3.0000000000",
      );
      expect(result.body.meta.reportingTimezone).toBe("Asia/Bangkok");
      expect(result.body.meta.periodStartInclusive).toBe(
        "2026-09-20T17:00:00.000Z",
      );
      expect(result.body.meta.sourceCutoff).toBe(now.toISOString());
      expect(result.body.meta).not.toHaveProperty("canViewCost");
    }
    for (const role of [fixture.inventory, fixture.cashier, fixture.outsider]) {
      const denied = await get(
        fixture.organization.id,
        `sales?${period}`,
        role.cookie,
      );
      expect(denied.status).toBe(403);
      expect(JSON.stringify(denied.body)).not.toMatch(
        /cogs|costCoverage|grossProfit|grossMargin/i,
      );
    }
    expect((await get(fixture.organization.id, `sales?${period}`)).status).toBe(
      401,
    );
  });

  it("validates selectors and local calendar ranges through the period engine", async () => {
    const fixture = await setup();
    await start();
    for (const query of [
      "scope=organization&from=2026-02-30&to=2026-03-01&granularity=day",
      "scope=organization&from=2026-09-21&to=2026-09-23&granularity=hour",
      "scope=organization&from=2025-01-01&to=2026-01-03&granularity=day",
      "scope=organization&from=2026-09-21&to=2026-09-23&granularity=month",
      `${period}&sourceCutoff=2020-01-01T00%3A00%3A00Z`,
      "scope=organization&from=2026-09-21&to=2026-09-23",
    ]) {
      const result = await get(
        fixture.organization.id,
        `sales?${query}`,
        fixture.owner.cookie,
      );
      expect(result.status).toBe(400);
      expect(result.body.error.code).toBe("VALIDATION_ERROR");
    }
    for (const [from, to, granularity] of [
      ["2026-09-21", "2026-09-28", "week"],
      ["2026-09-01", "2026-10-01", "month"],
      ["2026-01-01", "2027-01-01", "year"],
    ]) {
      const result = await get(
        fixture.organization.id,
        `sales?scope=organization&from=${from}&to=${to}&granularity=${granularity}`,
        fixture.owner.cookie,
      );
      expect(result.status).toBe(200);
      expect(result.body.data.buckets).toHaveLength(1);
    }
    await prisma.organization.update({
      where: { id: fixture.organization.id },
      data: { reportingTimezone: "Invalid/Zone" },
    });
    const invalidTimezone = await get(
      fixture.organization.id,
      `sales?${period}`,
      fixture.owner.cookie,
    );
    expect(invalidTimezone.status).toBe(500);
    expect(invalidTimezone.body.error.code).toBe(
      "ANALYTICS_CONFIGURATION_ERROR",
    );
    expect(JSON.stringify(invalidTimezone.body)).not.toContain("Invalid/Zone");
    for (const role of [fixture.cashier, fixture.inventory, fixture.outsider]) {
      expect(
        (await get(fixture.organization.id, `sales?${period}`, role.cookie))
          .status,
      ).toBe(403);
    }
    const deniedBranch = await get(
      fixture.organization.id,
      `sales?scope=branch&branchId=${fixture.branches[2]!.id}&from=2026-09-21&to=2026-09-23&granularity=day`,
      fixture.manager.cookie,
    );
    expect(deniedBranch.status).toBe(403);
  });

  it("pages complete Category and Branch series with signed, scope-bound cutoff", async () => {
    const fixture = await setup();
    await start();
    const secondCategory = await prisma.category.create({
      data: {
        name: "Second",
        normalizedName: "second",
        organizationId: fixture.organization.id,
      },
    });
    await prisma.product.update({
      where: { id: fixture.product.id },
      data: { categoryId: secondCategory.id },
    });
    const uncategorized = await prisma.product.create({
      data: {
        basePrice: "2",
        name: "Loose",
        organizationId: fixture.organization.id,
        sku: "LOOSE",
        unit: "EA",
      },
    });
    await prisma.inventoryBalance.create({
      data: {
        branchId: fixture.branches[0]!.id,
        organizationId: fixture.organization.id,
        productId: uncategorized.id,
        quantity: "2",
      },
    });
    await prisma.inventoryCostState.create({
      data: {
        averageUnitCost: "1",
        basisState: "KNOWN",
        branchId: fixture.branches[0]!.id,
        inventoryValue: "2",
        organizationId: fixture.organization.id,
        productId: uncategorized.id,
      },
    });
    const sale = await createPrismaCheckoutRepository(prisma, {
      now: () => new Date("2026-09-21T09:00:00.000Z"),
    }).checkout({
      actorUserId: fixture.owner.id,
      branchId: fixture.branches[0]!.id,
      idempotencyKey: randomUUID(),
      items: [
        { expectedUnitPrice: "2", productId: uncategorized.id, quantity: "1" },
      ],
      organizationId: fixture.organization.id,
      payment: { amountTendered: "2", method: "CASH" },
      discount: null,
    });
    expect(sale.kind).toBe("success");
    await prisma.category.update({
      where: { id: secondCategory.id },
      data: { status: "INACTIVE" },
    });
    const first = await get(
      fixture.organization.id,
      `categories?${period}&limit=1`,
      fixture.owner.cookie,
    );
    expect(first.status).toBe(200);
    expect(first.body.data.categories).toHaveLength(1);
    expect(first.body.data.categories[0]!.categoryStatus).toBe("INACTIVE");
    expect(first.body.data.categories[0]!.buckets).toHaveLength(2);
    expect(Object.keys(first.body.data.categories[0]!).sort()).toEqual([
      "buckets",
      "categoryId",
      "categoryKind",
      "categoryName",
      "categoryStatus",
    ]);
    const cursor = first.body.meta.nextCursor as string;
    expect(cursor).toBeTruthy();
    analyticsNow = new Date("2026-09-24T10:00:00.000Z");
    const second = await get(
      fixture.organization.id,
      `categories?${period}&limit=1&cursor=${encodeURIComponent(cursor)}`,
      fixture.owner.cookie,
    );
    expect(second.status).toBe(200);
    expect(second.body.meta.sourceCutoff).toBe(first.body.meta.sourceCutoff);
    expect(second.body.data.categories[0]!.categoryKind).toBe("UNCATEGORIZED");
    expect(
      second.body.data.categories[0]!.buckets[0]!.categorySharePercent.value,
    ).toBe("16.67");
    expect(second.body.meta.nextCursor).toBeNull();
    const wrongOrganization = await get(
      fixture.outsiderOrganizationId,
      `categories?${period}&cursor=${encodeURIComponent(cursor)}`,
      fixture.outsider.cookie,
    );
    expect(wrongOrganization.status).toBe(400);
    expect(wrongOrganization.body.error.code).toBe("INVALID_CURSOR");
    for (const path of [
      `categories?${period}&limit=1&cursor=${encodeURIComponent(cursor.slice(0, -1) + "x")}`,
      `categories?${period}&limit=1&cursor=garbage`,
      `categories?scope=branch&branchId=${fixture.branches[0]!.id}&from=2026-09-21&to=2026-09-23&granularity=day&cursor=${encodeURIComponent(cursor)}`,
      `categories?scope=organization&from=2026-09-20&to=2026-09-23&granularity=day&cursor=${encodeURIComponent(cursor)}`,
      `branches?${period}&cursor=${encodeURIComponent(cursor)}`,
    ]) {
      const result = await get(
        fixture.organization.id,
        path,
        fixture.owner.cookie,
      );
      expect(result.status).toBe(400);
      expect(result.body.error.code).toBe("INVALID_CURSOR");
    }
    const firstBranch = await get(
      fixture.organization.id,
      `branches?${period}&limit=1`,
      fixture.owner.cookie,
    );
    expect(firstBranch.status).toBe(200);
    expect(firstBranch.body.data.branches).toHaveLength(1);
    const branchCursor = firstBranch.body.meta.nextCursor as string;
    const branchOnCategory = await get(
      fixture.organization.id,
      `categories?${period}&cursor=${encodeURIComponent(branchCursor)}`,
      fixture.owner.cookie,
    );
    expect(branchOnCategory.body.error.code).toBe("INVALID_CURSOR");
    const wrongOrdering = await get(
      fixture.organization.id,
      `branches?${period}&cursor=${encodeURIComponent(alteredCursor(branchCursor, { ordering: "category-id-asc-uncategorized-last" }, true))}`,
      fixture.owner.cookie,
    );
    expect(wrongOrdering.body.error.code).toBe("INVALID_CURSOR");
    const forgedCutoff = await get(
      fixture.organization.id,
      `branches?${period}&cursor=${encodeURIComponent(alteredCursor(branchCursor, { sourceCutoff: "2030-01-01T00:00:00.000Z" }, false))}`,
      fixture.owner.cookie,
    );
    expect(forgedCutoff.body.error.code).toBe("INVALID_CURSOR");
    const nextBranch = await get(
      fixture.organization.id,
      `branches?${period}&limit=1&cursor=${encodeURIComponent(branchCursor)}`,
      fixture.owner.cookie,
    );
    expect(nextBranch.status).toBe(200);
    expect(nextBranch.body.meta.sourceCutoff).toBe(
      firstBranch.body.meta.sourceCutoff,
    );
    expect(nextBranch.body.data.branches[0]!.buckets).toHaveLength(2);
    const all = await get(
      fixture.organization.id,
      `branches?${period}&limit=100`,
      fixture.owner.cookie,
    );
    expect(all.status).toBe(200);
    expect(all.body.data.branches).toHaveLength(3);
    expect(
      all.body.data.branches.find(
        (branch) => branch.branchId === fixture.branches[1]!.id,
      )!.buckets[0]!.grossSalesAmount,
    ).toBe("0.00");
    expect(
      all.body.data.branches.some(
        (branch) => branch.branchStatus === "INACTIVE",
      ),
    ).toBe(true);
    expect(
      (
        await get(
          fixture.organization.id,
          `branches?${period}&limit=101`,
          fixture.owner.cookie,
        )
      ).status,
    ).toBe(400);
    const manager = await get(
      fixture.organization.id,
      `branches?${period}`,
      fixture.manager.cookie,
    );
    expect(manager.status).toBe(200);
    expect(manager.body.data.branches).toHaveLength(1);
    expect(manager.body.meta.includedBranchIds).toEqual([
      fixture.branches[0]!.id,
    ]);
    expect(
      (
        await get(
          fixture.organization.id,
          `branches?scope=branch&branchId=${fixture.branches[2]!.id}&from=2026-09-21&to=2026-09-23&granularity=day`,
          fixture.manager.cookie,
        )
      ).status,
    ).toBe(403);
    await prisma.branchAssignment.updateMany({
      where: {
        organizationId: fixture.organization.id,
        branchId: fixture.branches[0]!.id,
        userId: fixture.manager.id,
      },
      data: { status: "INACTIVE", deactivatedAt: now },
    });
    expect(
      (
        await get(
          fixture.organization.id,
          `branches?${period}&cursor=${encodeURIComponent(branchCursor)}`,
          fixture.manager.cookie,
        )
      ).status,
    ).toBe(403);
    await prisma.organization.update({
      where: { id: fixture.organization.id },
      data: { reportingTimezone: "UTC" },
    });
    expect(
      (
        await get(
          fixture.organization.id,
          `branches?${period}&cursor=${encodeURIComponent(branchCursor)}`,
          fixture.owner.cookie,
        )
      ).body.error.code,
    ).toBe("INVALID_CURSOR");
    await prisma.organization.update({
      where: { id: fixture.organization.id },
      data: { reportingTimezone: "Asia/Bangkok" },
    });
    await prisma.branch.create({
      data: {
        code: "D",
        name: "New Branch",
        organizationId: fixture.organization.id,
      },
    });
    expect(
      (
        await get(
          fixture.organization.id,
          `branches?${period}&cursor=${encodeURIComponent(branchCursor)}`,
          fixture.owner.cookie,
        )
      ).body.error.code,
    ).toBe("INVALID_CURSOR");
    const freshCursor = (
      await get(
        fixture.organization.id,
        `categories?${period}&limit=1`,
        fixture.owner.cookie,
      )
    ).body.meta.nextCursor as string;
    await server!.stop();
    server = undefined;
    await start(Buffer.alloc(32, 18));
    expect(
      (
        await get(
          fixture.organization.id,
          `categories?${period}&cursor=${encodeURIComponent(freshCursor)}`,
          fixture.owner.cookie,
        )
      ).body.error.code,
    ).toBe("INVALID_CURSOR");
  });

  it("exposes inventory facts, classification, page markers, and cost only to permitted roles", async () => {
    const fixture = await setup();
    await start();
    for (const actor of [fixture.owner, fixture.admin, fixture.manager]) {
      const result = await get(
        fixture.organization.id,
        `inventory?${period}`,
        actor.cookie,
      );
      expect(result.status).toBe(200);
      expect(result.body.meta.metricDefinitionVersion).toBe("analytics-v1");
      expect(result.body.meta.currentSnapshotCapturedAt).toEqual(
        expect.any(String),
      );
      expect(result.body.data.dimensions[0]?.buckets).toHaveLength(2);
      expect(result.body.data.dimensions[0]?.cost).toBeDefined();
      expect(result.body.data.branches[0]?.cost).toBeDefined();
    }
    const staff = await get(
      fixture.organization.id,
      `inventory?${period}`,
      fixture.inventory.cookie,
    );
    expect(staff.status).toBe(200);
    expect(staff.body.meta.includedBranchIds).toEqual([
      fixture.branches[0]!.id,
    ]);
    expect(staff.body.data.dimensions).toHaveLength(1);
    expect(staff.body.data.dimensions[0]).not.toHaveProperty("cost");
    expect(staff.body.data.branches[0]).not.toHaveProperty("cost");
    expect(staff.body.data.dimensions[0]?.onHandQuantity).toBe("9.0000");
    expect(
      staff.body.data.dimensions[0]?.buckets[0]?.saleDepletionQuantity,
    ).toBe("1.0000");
    expect(staff.body.data.dimensions[0]?.coverageDays.reason).toBe(
      "INVENTORY_INTEGRITY_ERROR",
    );
    expect(staff.body.data.dimensions[0]?.stockClassification).toEqual({
      classification: null,
      reason: "INVENTORY_INTEGRITY_ERROR",
      thresholdVersion: "stock-risk-v1",
    });
    expect(JSON.stringify(staff.body)).not.toContain("STOCKOUT_RISK");
    expect(
      (
        await get(
          fixture.organization.id,
          `inventory?${period}`,
          fixture.cashier.cookie,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await get(
          fixture.organization.id,
          `inventory?${period}`,
          fixture.outsider.cookie,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await get(
          fixture.outsiderOrganizationId,
          `inventory?${period}`,
          fixture.owner.cookie,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await get(
          fixture.organization.id,
          `inventory?scope=branch&branchId=${fixture.branches[2]!.id}&from=2026-09-21&to=2026-09-23&granularity=day`,
          fixture.inventory.cookie,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await get(
          fixture.organization.id,
          `inventory?${period}&limit=101`,
          fixture.owner.cookie,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await get(
          fixture.organization.id,
          `inventory?scope=organization&from=2026-09-22&to=2026-09-21&granularity=day`,
          fixture.owner.cookie,
        )
      ).status,
    ).toBe(400);
  });

  it("pages inventory dimensions with a scope-bound event cutoff and page-current marker", async () => {
    const fixture = await setup();
    await start();
    const first = await get(
      fixture.organization.id,
      `inventory?${period}&limit=1`,
      fixture.owner.cookie,
    );
    expect(first.status).toBe(200);
    expect(first.body.data.dimensions).toHaveLength(1);
    expect(first.body.data.branches).toHaveLength(3);
    const cursor = first.body.meta.nextCursor as string;
    expect(cursor).toEqual(expect.any(String));
    analyticsNow = new Date(now.getTime() + 1);
    const next = await get(
      fixture.organization.id,
      `inventory?${period}&limit=1&cursor=${encodeURIComponent(cursor)}`,
      fixture.owner.cookie,
    );
    expect(next.status).toBe(200);
    expect(next.body.meta.sourceCutoff).toBe(first.body.meta.sourceCutoff);
    expect(next.body.meta.currentSnapshotCapturedAt).not.toBe(
      first.body.meta.currentSnapshotCapturedAt,
    );
    expect(next.body.data.dimensions[0]?.buckets).toHaveLength(2);
    const staff = await get(
      fixture.organization.id,
      `inventory?${period}&cursor=${encodeURIComponent(cursor)}`,
      fixture.inventory.cookie,
    );
    expect(staff.body.error.code).toBe("INVALID_CURSOR");
    const tampered = await get(
      fixture.organization.id,
      `inventory?${period}&cursor=${encodeURIComponent(cursor.slice(0, -1) + "x")}`,
      fixture.owner.cookie,
    );
    expect(tampered.body.error.code).toBe("INVALID_CURSOR");
    const empty = await get(
      fixture.organization.id,
      `inventory?scope=branch&branchId=${fixture.branches[1]!.id}&from=2026-09-21&to=2026-09-23&granularity=day`,
      fixture.owner.cookie,
    );
    expect(empty.status).toBe(200);
    expect(empty.body.data.branches).toHaveLength(1);
  });

  it("serializes a classified row and preserves UNKNOWN current cost", async () => {
    const fixture = await setup();
    const membership = await prisma.organizationMembership.findUniqueOrThrow({
      where: {
        organizationId_userId: {
          organizationId: fixture.organization.id,
          userId: fixture.owner.id,
        },
      },
    });
    await prisma.inventoryTransaction.create({
      data: {
        organizationId: fixture.organization.id,
        branchId: fixture.branches[0]!.id,
        productId: fixture.product.id,
        actorUserId: fixture.owner.id,
        actorMembershipId: membership.id,
        delta: "10",
        occurredAt: new Date("2026-08-01T00:00:00.000Z"),
        source: "MANUAL_ADJUSTMENT",
        adjustmentReason: "FOUND",
        idempotencyKeyHash: "a".repeat(64),
        canonicalRequestHash: "b".repeat(64),
      },
    });
    await prisma.inventoryCostState.update({
      where: {
        branchId_productId: {
          branchId: fixture.branches[0]!.id,
          productId: fixture.product.id,
        },
      },
      data: {
        basisState: "UNKNOWN",
        averageUnitCost: null,
        inventoryValue: null,
      },
    });
    await start();
    const result = await get(
      fixture.organization.id,
      `inventory?${period}`,
      fixture.owner.cookie,
    );
    expect(result.status).toBe(200);
    const row = result.body.data.dimensions.find(
      (item) => item.branchId === fixture.branches[0]!.id,
    )!;
    expect(row.coverageDays).toEqual({ value: "252.00", reason: null });
    expect(row.stockClassification).toEqual({
      classification: "OVERSTOCK",
      reason: null,
      thresholdVersion: "stock-risk-v1",
    });
    expect(row.cost?.inventoryValue).toEqual({
      value: null,
      reason: "INCOMPLETE_COST_COVERAGE",
    });
    expect(
      result.body.data.branches.find(
        (branch) => branch.branchId === fixture.branches[0]!.id,
      )?.cost?.inventoryValue,
    ).toEqual({
      value: null,
      reason: "INCOMPLETE_COST_COVERAGE",
    });
  });

  it("returns an empty inventory dimension page and factual zero availability", async () => {
    const organization = await prisma.organization.create({
      data: { name: "Empty analytics", reportingTimezone: "Asia/Bangkok" },
    });
    const branch = await prisma.branch.create({
      data: { code: "EMPTY", name: "Empty", organizationId: organization.id },
    });
    const owner = await actor(organization.id, "OWNER");
    await start();
    const result = await get(
      organization.id,
      `inventory?${period}`,
      owner.cookie,
    );
    expect(result.status).toBe(200);
    expect(result.body.data.dimensions).toEqual([]);
    expect(result.body.data.branches).toEqual([
      expect.objectContaining({
        branchId: branch.id,
        activeProductCount: 0,
        inStockProductCount: 0,
        outOfStockProductCount: 0,
      }),
    ]);
    expect(result.body.meta.nextCursor).toBeNull();
  });

  it("exposes scoped forecast and advisory reorder without cost or purchasing fields", async () => {
    const fixture = await setup();
    await start();
    const pair = `branchId=${fixture.branches[0]!.id}&productId=${fixture.product.id}`;
    for (const user of [fixture.owner, fixture.admin, fixture.manager]) {
      const result = await get(
        fixture.organization.id,
        `forecast?${pair}`,
        user.cookie,
      );
      expect(result.status).toBe(200);
      expect(result.body.data.forecast).toMatchObject({
        forecastVersion: "forecast-sale-mean-28d-v1",
        status: "UNAVAILABLE",
        reason: "INSUFFICIENT_DATA",
        sourceCutoff: now.toISOString(),
        days: [],
        horizonTotal: null,
      });
      expect(JSON.stringify(result.body)).not.toMatch(
        /cost|supplier|purchaseOrder|unitPrice/i,
      );
    }
    for (const user of [fixture.inventory, fixture.cashier, fixture.outsider]) {
      expect(
        (await get(fixture.organization.id, `forecast?${pair}`, user.cookie))
          .status,
      ).toBe(403);
      expect(
        (
          await get(
            fixture.organization.id,
            `reorder-recommendations?${pair}&leadTimeDays=2`,
            user.cookie,
          )
        ).status,
      ).toBe(403);
    }
    const outsideBranch = `branchId=${fixture.branches[1]!.id}&productId=${fixture.product.id}`;
    expect(
      (
        await get(
          fixture.organization.id,
          `forecast?${outsideBranch}`,
          fixture.manager.cookie,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await get(
          fixture.organization.id,
          `reorder-recommendations?${outsideBranch}&leadTimeDays=2`,
          fixture.inventory.cookie,
        )
      ).status,
    ).toBe(403);
    expect(
      (await get(fixture.organization.id, `forecast?${pair}`, undefined))
        .status,
    ).toBe(401);
    expect(
      (
        await get(
          fixture.organization.id,
          `forecast?branchId=bad&productId=${fixture.product.id}`,
          fixture.owner.cookie,
        )
      ).status,
    ).toBe(400);

    const membership = await prisma.organizationMembership.findFirstOrThrow({
      where: {
        organizationId: fixture.organization.id,
        userId: fixture.owner.id,
      },
    });
    await prisma.inventoryTransaction.create({
      data: {
        organizationId: fixture.organization.id,
        branchId: fixture.branches[0]!.id,
        productId: fixture.product.id,
        actorUserId: fixture.owner.id,
        actorMembershipId: membership.id,
        occurredAt: new Date("2026-08-20T00:00:00.000Z"),
        delta: "10",
        source: "MANUAL_ADJUSTMENT",
        adjustmentReason: "FOUND",
        idempotencyKeyHash: createHmac("sha256", signingKey)
          .update(randomUUID())
          .digest("hex"),
        canonicalRequestHash: createHmac("sha256", signingKey)
          .update(randomUUID())
          .digest("hex"),
      },
    });
    const forecast = await get(
      fixture.organization.id,
      `forecast?${pair}`,
      fixture.owner.cookie,
    );
    expect(forecast.status).toBe(200);
    expect(forecast.body.data.forecast).toMatchObject({
      status: "AVAILABLE",
      reason: null,
      horizonTotal: "0.2499",
      unit: "EA",
    });
    expect(forecast.body.data.forecast.days).toHaveLength(7);
    const missing = await get(
      fixture.organization.id,
      `reorder-recommendations?${pair}`,
      fixture.owner.cookie,
    );
    expect(missing.body.data.recommendation).toMatchObject({
      status: "UNAVAILABLE",
      reason: "LEAD_TIME_REQUIRED",
    });
    for (const leadTimeDays of ["-1", "0", "1.5", "8"]) {
      const invalid = await get(
        fixture.organization.id,
        `reorder-recommendations?${pair}&leadTimeDays=${leadTimeDays}`,
        fixture.owner.cookie,
      );
      expect(invalid.status).toBe(200);
      expect(invalid.body.data.recommendation).toMatchObject({
        status: "UNAVAILABLE",
        reason: "UNSUPPORTED_LEAD_TIME",
      });
    }
    const reorder = await get(
      fixture.organization.id,
      `reorder-recommendations?${pair}&leadTimeDays=2`,
      fixture.owner.cookie,
    );
    expect(reorder.body.data.recommendation).toMatchObject({
      reorderVersion: "reorder-v1",
      forecastVersion: "forecast-sale-mean-28d-v1",
      status: "AVAILABLE",
      leadTimeDemand: "0.0714",
      onHand: "9.0000",
      rawNeed: "0.0000",
      recommendedQuantity: "0.0000",
      sourceCutoff: now.toISOString(),
    });
    expect(JSON.stringify(reorder.body)).not.toMatch(
      /cost|supplier|purchaseOrder|unitPrice/i,
    );
    await prisma.inventoryBalance.update({
      where: {
        branchId_productId: {
          branchId: fixture.branches[0]!.id,
          productId: fixture.product.id,
        },
      },
      data: { quantity: "8" },
    });
    const integrity = await get(
      fixture.organization.id,
      `reorder-recommendations?${pair}&leadTimeDays=2`,
      fixture.owner.cookie,
    );
    expect(integrity.body.data.recommendation).toMatchObject({
      status: "UNAVAILABLE",
      reason: "INVENTORY_INTEGRITY_ERROR",
      recommendedQuantity: null,
    });
    await prisma.product.update({
      where: { id: fixture.product.id },
      data: { status: "INACTIVE" },
    });
    expect(
      (
        await get(
          fixture.organization.id,
          `forecast?${pair}`,
          fixture.owner.cookie,
        )
      ).body.data.forecast.reason,
    ).toBe("INACTIVE_PRODUCT");
    expect(
      (
        await get(
          fixture.organization.id,
          `reorder-recommendations?${pair}&leadTimeDays=2`,
          fixture.owner.cookie,
        )
      ).body.data.recommendation.reason,
    ).toBe("INACTIVE_PRODUCT");
  });
});
