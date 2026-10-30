import { writeFile } from "node:fs/promises";

import { Router } from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createApp } from "../app.ts";
import { Prisma } from "../generated/prisma/client.ts";
import { startApiServer, type RunningApiServer } from "../server.ts";
import { loadTestDatabaseEnvironment } from "../test/database-environment.ts";
import {
  createTestPrismaClient,
  resetTestDatabase,
} from "../test/database-harness.ts";
import { createDemo30dTestFixture } from "../test/demo-30d-fixture.ts";
import { createPrismaAuthenticationSessionRepository } from "../modules/identity/authentication-repository.ts";
import { createAuthenticationMiddleware } from "../modules/identity/authentication-context.ts";
import { generateSessionToken } from "../modules/identity/session-token.ts";
import { ORGANIZATION_ROLES } from "../modules/identity/authorization-policy.ts";
import { createPrismaCatalogRepository } from "../modules/catalog/catalog-repository.ts";
import { createCatalogRouter } from "../modules/catalog/catalog-router.ts";
import { createPrismaSupplierRepository } from "../modules/suppliers/supplier-repository.ts";
import { createSupplierRouter } from "../modules/suppliers/supplier-router.ts";
import { createPrismaInventoryRepository } from "../modules/inventory/inventory-repository.ts";
import { createInventoryRouter } from "../modules/inventory/inventory-router.ts";
import { createPrismaPurchaseOrderRepository } from "../modules/purchasing/purchase-order-repository.ts";
import { createPurchaseOrderRouter } from "../modules/purchasing/purchase-order-router.ts";
import { createPrismaReceivingRepository } from "../modules/purchasing/receiving-repository.ts";
import { createReceivingRouter } from "../modules/purchasing/receiving-router.ts";
import { createAnalyticsContextEngine } from "../modules/analytics/analytics-context.ts";
import { createAnalyticsDimensionCursorCodec } from "../modules/analytics/analytics-dimension-cursor.ts";
import { createPrismaAnalyticsScopeRepository } from "../modules/analytics/analytics-scope-repository.ts";
import { createPrismaAnalyticsSalesRepository } from "../modules/analytics/analytics-sales-repository.ts";
import { createAnalyticsSalesService } from "../modules/analytics/analytics-sales-service.ts";
import { createPrismaAnalyticsCategoryRepository } from "../modules/analytics/analytics-category-repository.ts";
import { createAnalyticsCategoryService } from "../modules/analytics/analytics-category-service.ts";
import { createPrismaAnalyticsBranchRepository } from "../modules/analytics/analytics-branch-repository.ts";
import { createAnalyticsBranchService } from "../modules/analytics/analytics-branch-service.ts";
import { createPrismaAnalyticsInventoryRepository } from "../modules/analytics/analytics-inventory-repository.ts";
import { createAnalyticsInventoryService } from "../modules/analytics/analytics-inventory-service.ts";
import { createPrismaForecastRepository } from "../modules/analytics/analytics-forecast-repository.ts";
import { createForecastService } from "../modules/analytics/analytics-forecast-service.ts";
import { createPrismaReorderRepository } from "../modules/analytics/analytics-reorder-repository.ts";
import { createReorderService } from "../modules/analytics/analytics-reorder-service.ts";
import { createAnalyticsRouter } from "../modules/analytics/analytics-router.ts";
import { createDemoInsightReader } from "../modules/ai-insights/demo-insight.ts";
import { createPrismaAiInsightReader } from "../modules/ai-insights/ai-insight-store.ts";
import { createAiInsightRouter } from "../modules/ai-insights/ai-insight-router.ts";
import { buildDemo30dPlan } from "./demo-30d-plan.ts";
import { prepareDemo30d, runDemo30d } from "./demo-30d-runner.ts";
import { loadDemoDatabaseEnvironment } from "./demo-environment.ts";

const configured =
  !!process.env.TEST_DATABASE_URL && !!process.env.TEST_DISPOSABLE_RECEIPT;
const suite = describe.skipIf(!configured);
const environment = loadTestDatabaseEnvironment();
const prisma = createTestPrismaClient(environment);
const now = new Date("2026-10-29T17:00:00Z");
const cursorCodec = createAnalyticsDimensionCursorCodec(Buffer.alloc(32, 9));
let fixture: Awaited<ReturnType<typeof createDemo30dTestFixture>>;
let target: Awaited<ReturnType<typeof prepareDemo30d>>;
let server: RunningApiServer;
const cookies = new Map<string, string>();
const options = () => ({
  organizationId: fixture.organization.id,
  referenceDate: "2026-10-30",
  seed: 30,
});

async function databaseFingerprint() {
  return JSON.stringify(
    await prisma.$queryRaw`SELECT
    (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM sales t) AS sales,
    (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM purchase_orders t) AS orders,
    (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM purchase_receipts t) AS receipts,
    (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM inventory_transactions t) AS ledger,
    (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM inventory_balances t) AS balances,
    (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM sale_refunds t) AS refunds,
    (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM payments t) AS payments`,
  );
}

async function get(path: string, role = "OWNER") {
  return fetch(
    `http://127.0.0.1:${server.address.port}/api/v1/organizations/${fixture.organization.id}/${path}`,
    { headers: { Cookie: cookies.get(role) ?? "" } },
  );
}

suite("DEMO-30D-RBAC-AI-01 on disposable PostgreSQL", () => {
  beforeAll(async () => {
    await resetTestDatabase(environment);
    fixture = await createDemo30dTestFixture(prisma);
    target = await prepareDemo30d(prisma, options());
    const before = await databaseFingerprint();
    expect(
      (await runDemo30d(prisma, { ...options(), apply: false })).status,
    ).toBe("PREVIEW");
    expect(await databaseFingerprint()).toBe(before);
    await runDemo30d(prisma, { ...options(), apply: true });
    for (const actor of fixture.actors) {
      const token = generateSessionToken();
      await prisma.session.create({
        data: {
          userId: actor.user.id,
          tokenHash: token.tokenHash,
          issuedAt: now,
          lastUsedAt: now,
          idleExpiresAt: new Date(now.getTime() + 86_400_000),
          absoluteExpiresAt: new Date(now.getTime() + 86_400_000),
        },
      });
      cookies.set(actor.role, `stockwise_session=${token.rawToken}`);
    }
    const authenticationMiddleware = createAuthenticationMiddleware({
      repository: createPrismaAuthenticationSessionRepository(prisma),
      now: () => now,
      configuration: {
        absoluteTimeoutMilliseconds: 86_400_000,
        idleTimeoutMilliseconds: 86_400_000,
        touchIntervalMilliseconds: 900_000,
        secureCookie: false,
      },
    });
    const shared = {
      authenticationMiddleware,
      publicWebOrigin: "http://localhost:3000",
    };
    const contextEngine = createAnalyticsContextEngine({
      scopeRepository: createPrismaAnalyticsScopeRepository(prisma),
      now: () => now,
    });
    const router = Router();
    router.use(
      createCatalogRouter({
        ...shared,
        catalogService: createPrismaCatalogRepository(prisma),
      }),
    );
    router.use(
      createSupplierRouter({
        ...shared,
        supplierService: createPrismaSupplierRepository(prisma),
      }),
    );
    router.use(
      createInventoryRouter({
        ...shared,
        inventoryService: createPrismaInventoryRepository(prisma),
      }),
    );
    router.use(
      createPurchaseOrderRouter({
        ...shared,
        purchaseOrderService: createPrismaPurchaseOrderRepository(prisma),
      }),
    );
    router.use(
      createReceivingRouter({
        ...shared,
        receivingService: createPrismaReceivingRepository(prisma),
      }),
    );
    router.use(
      createAnalyticsRouter({
        authenticationMiddleware,
        salesService: createAnalyticsSalesService({
          contextEngine,
          repository: createPrismaAnalyticsSalesRepository(prisma),
        }),
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
            { now: () => now },
          ),
        }),
        forecastService: createForecastService(
          createPrismaForecastRepository(prisma, { now: () => now }),
        ),
        reorderService: createReorderService(
          createPrismaReorderRepository(prisma, { now: () => now }),
        ),
      }),
    );
    router.use(
      createAiInsightRouter({
        authenticationMiddleware,
        reader: createPrismaAiInsightReader(prisma),
        demoReader: createDemoInsightReader({
          prisma,
          cursorCodec,
          organizationId: fixture.organization.id,
          runtimeEnvironment: "test",
        }),
      }),
    );
    server = await startApiServer(
      createApp({
        apiRouter: router,
        logger: { info: vi.fn(), error: vi.fn() },
      }),
      { host: "127.0.0.1", port: 0 },
    );
  }, 180_000);

  afterAll(async () => {
    await server?.stop();
    await resetTestDatabase(environment);
    await prisma.$disconnect();
  });

  it("previews a deterministic 30 completed-day plan without writes and changes output with seed", async () => {
    expect(target.plan.sales.length).toBeGreaterThanOrEqual(300);
    expect(target.plan.sales.length).toBeLessThanOrEqual(600);
    expect(new Set(target.plan.sales.map((s) => s.day)).size).toBe(30);
    const input = {
      ...options(),
      organizationId: fixture.organization.id,
      reportingTimezone: "Asia/Bangkok",
      branches: fixture.branches,
      products: target.plan.products,
      settings: target.plan.settings,
    };
    expect(buildDemo30dPlan(input)).toEqual(buildDemo30dPlan(input));
    expect(buildDemo30dPlan({ ...input, seed: 31 }).sales).not.toEqual(
      target.plan.sales,
    );
    const before = await databaseFingerprint();
    await runDemo30d(prisma, { ...options(), apply: false });
    expect(await databaseFingerprint()).toBe(before);
  });

  it("reruns exactly without duplicates, preserving the complete transaction fingerprint", async () => {
    const before = await databaseFingerprint();
    await runDemo30d(prisma, { ...options(), apply: true });
    expect(await databaseFingerprint()).toBe(before);
    expect(await prisma.sale.count()).toBe(target.plan.sales.length);
    expect(await prisma.purchaseReceipt.count()).toBe(
      target.plan.orders.length,
    );
  }, 180_000);

  it("fails closed on another tenant, changed parameters, future dates and nonlocal/production targets", async () => {
    const before = await databaseFingerprint();
    await expect(
      runDemo30d(prisma, {
        ...options(),
        organizationId: fixture.other.id,
        apply: true,
      }),
    ).rejects.toThrow(/allowlisted/);
    await expect(
      runDemo30d(prisma, { ...options(), seed: 31, apply: true }),
    ).rejects.toThrow(/parameters differ/);
    await expect(
      runDemo30d(prisma, {
        ...options(),
        referenceDate: "2099-01-01",
        apply: false,
      }),
    ).rejects.toThrow(/future/);
    for (const env of [
      { DEMO_DATABASE_URL: "postgresql://a:b@remote.invalid/a_demo" },
      {
        DEMO_DATABASE_URL: "postgresql://a:b@127.0.0.1/a_demo",
        STOCKWISE_RUNTIME_ENV: "production",
      },
      { DEMO_DATABASE_URL: "postgresql://a:b@127.0.0.1/a_production_demo" },
    ])
      expect(() =>
        loadDemoDatabaseEnvironment(env, "nonexistent-demo30d-env"),
      ).toThrow();
    expect(await databaseFingerprint()).toBe(before);
  });

  it("serializes concurrent identical seed runs without duplicate facts", async () => {
    const before = await databaseFingerprint();
    await Promise.all([
      runDemo30d(prisma, { ...options(), apply: true }),
      runDemo30d(prisma, { ...options(), apply: true }),
    ]);
    expect(await databaseFingerprint()).toBe(before);
  }, 180_000);

  it("reconciles every nonnegative stock balance, ledger and known cost projection", async () => {
    const rows = await prisma.$queryRaw<
      {
        quantity: Prisma.Decimal;
        ledger: Prisma.Decimal;
        average: Prisma.Decimal;
        value: Prisma.Decimal;
      }[]
    >`SELECT b.quantity, sum(t.delta) AS ledger, c.average_unit_cost AS average, c.inventory_value AS value FROM inventory_balances b JOIN inventory_transactions t ON t.organization_id=b.organization_id AND t.branch_id=b.branch_id AND t.product_id=b.product_id JOIN inventory_cost_states c ON c.organization_id=b.organization_id AND c.branch_id=b.branch_id AND c.product_id=b.product_id GROUP BY b.id,c.id`;
    expect(rows).toHaveLength(
      target.plan.branches.length * target.plan.products.length,
    );
    for (const row of rows) {
      expect(row.quantity.gte(0)).toBe(true);
      expect(row.quantity.eq(row.ledger)).toBe(true);
      expect(row.value.eq(row.quantity.times(row.average))).toBe(true);
    }
    const negativeHistory =
      await prisma.$queryRaw`SELECT * FROM (SELECT sum(delta) OVER (PARTITION BY branch_id,product_id ORDER BY occurred_at,id) AS quantity FROM inventory_transactions) h WHERE quantity < 0`;
    expect(negativeHistory).toEqual([]);
  });

  it("preserves payment, sale-item, receipt, refund and tenant relationships", async () => {
    const sales = await prisma.sale.findMany({
      include: { items: true, payment: true },
    });
    expect(new Set(sales.map((s) => s.payment?.method))).toEqual(
      new Set(["CASH", "TRANSFER"]),
    );
    for (const sale of sales) {
      expect(sale.payment?.amount.eq(sale.totalAmount)).toBe(true);
      expect(
        sale.items
          .reduce((n, i) => n.plus(i.lineNet), new Prisma.Decimal(0))
          .eq(sale.totalAmount),
      ).toBe(true);
      expect(
        sale.items.every(
          (i) =>
            i.organizationId === sale.organizationId &&
            i.branchId === sale.branchId,
        ),
      ).toBe(true);
    }
    const receipts = await prisma.purchaseReceipt.findMany({
      include: { purchaseOrder: true, items: true },
    });
    for (const receipt of receipts) {
      expect(receipt.purchaseOrder.status).toBe("RECEIVED");
      expect(receipt.items.length).toBe(target.plan.products.length);
    }
    const refunds = await prisma.saleRefund.findMany({
      include: { items: true, payment: true },
    });
    expect(refunds).toHaveLength(3);
    for (const refund of refunds) {
      expect(refund.payment?.amount.eq(refund.totalAmount)).toBe(true);
      expect(
        refund.items.every((i) => i.restockQuantity.lte(i.refundQuantity)),
      ).toBe(true);
    }
    expect(
      await prisma.sale.count({ where: { organizationId: fixture.other.id } }),
    ).toBe(0);
    expect(
      await prisma.organizationMembership.count({
        where: {
          organizationId: fixture.organization.id,
          role: "OWNER",
          status: "ACTIVE",
        },
      }),
    ).toBe(1);
  });

  it.each(ORGANIZATION_ROLES)(
    "enforces %s positive/negative HTTP module, inventory, forecast and AI access",
    async (role) => {
      const branchId = fixture.branches[0]!.id;
      const query = `scope=branch&branchId=${branchId}&from=2026-09-30&to=2026-10-30&granularity=day`;
      const management = ["OWNER", "ADMIN", "BRANCH_MANAGER"].includes(role);
      for (const [path, expected] of [
        [`products?branchId=${branchId}`, role !== "INVENTORY_STAFF"],
        ["suppliers", management],
        [`branches/${branchId}/purchase-orders`, management],
        [`branches/${branchId}/inventory`, true],
        [`analytics/inventory?${query}`, role !== "CASHIER"],
        [
          `analytics/forecast?branchId=${branchId}&productId=${fixture.products[0]!.id}`,
          management,
        ],
        [
          `analytics/reorder-recommendations?branchId=${branchId}&productId=${fixture.products[0]!.id}&leadTimeDays=7`,
          management,
        ],
        [
          `ai-insights/demo?scope=branch&branchId=${branchId}&language=en`,
          management,
        ],
      ] as const)
        expect((await get(path, role)).status, path).toBe(expected ? 200 : 403);
      if (!["OWNER", "ADMIN"].includes(role)) {
        expect(
          (await get(`branches/${fixture.branches[1]!.id}/inventory`, role))
            .status,
        ).toBe(403);
      }
    },
  );

  it("denies assigned inventory staff mutations at real Catalog/Supplier/PO/Receiving APIs", async () => {
    const branchId = fixture.branches[0]!.id;
    const order = await prisma.purchaseOrder.findFirstOrThrow({
      where: { branchId },
      include: { items: true },
    });
    const requests = [
      [`categories?branchId=${branchId}`, { name: "Forbidden demo category" }],
      ["suppliers", { name: "Forbidden demo supplier" }],
      [
        `branches/${branchId}/purchase-orders`,
        {
          supplierId: fixture.supplier.id,
          orderDate: "2026-10-29",
          items: [
            {
              productId: fixture.products[0]!.id,
              quantity: "1",
              expectedUnitCost: "10",
            },
          ],
        },
      ],
      [
        `branches/${branchId}/purchase-orders/${order.id}/receipts`,
        {
          actualCosts: order.items.map((i) => ({
            purchaseOrderItemId: i.id,
            actualUnitCost: i.expectedUnitCost.toFixed(4),
          })),
          vat: {
            organizationVatRegistered: false,
            inputVatRate: null,
            inputVatAmount: null,
            supplierTaxDocumentDate: null,
            supplierTaxDocumentNumber: null,
          },
        },
      ],
    ] as const;
    for (const [path, body] of requests) {
      const response = await fetch(
        `http://127.0.0.1:${server.address.port}/api/v1/organizations/${fixture.organization.id}/${path}`,
        {
          method: "POST",
          headers: {
            Cookie: cookies.get("INVENTORY_STAFF")!,
            Origin: "http://localhost:3000",
            "Content-Type": "application/json",
            "Idempotency-Key": "denied-demo30",
          },
          body: JSON.stringify(body),
        },
      );
      expect(response.status, path).toBe(403);
    }
  });

  it("reconciles 30 daily real Analytics buckets with sales less refunds and runs real Forecast/Reorder", async () => {
    const contextEngine = createAnalyticsContextEngine({
      scopeRepository: createPrismaAnalyticsScopeRepository(prisma),
      now: () => now,
    });
    const resolved = await contextEngine.resolve({
      actorUserId: target.actorUserId,
      organizationId: fixture.organization.id,
      scope: { kind: "organization" },
      analyticsKind: "business",
      from: target.plan.from,
      to: target.plan.to,
      granularity: "day",
    });
    expect(resolved.kind).toBe("success");
    if (resolved.kind !== "success") throw new Error("context");
    const actual = await createPrismaAnalyticsSalesRepository(prisma).read(
      resolved.context,
    );
    expect(actual.buckets).toHaveLength(30);
    expect(actual.buckets.reduce((n, b) => n + b.saleCount, 0)).toBe(
      target.plan.sales.length,
    );
    const sales = await prisma.sale.aggregate({ _sum: { totalAmount: true } });
    const refunds = await prisma.saleRefund.aggregate({
      _sum: { totalAmount: true },
    });
    const net = sales._sum.totalAmount!.minus(refunds._sum.totalAmount!);
    expect(
      actual.buckets
        .reduce((n, b) => n.plus(b.netSalesAmount), new Prisma.Decimal(0))
        .eq(net),
    ).toBe(true);
    const forecasts = [];
    const recommendations = [];
    for (const branch of fixture.branches)
      for (const product of fixture.products) {
        const forecast = await createPrismaForecastRepository(prisma, {
          now: () => now,
        }).read({
          actorUserId: target.actorUserId,
          organizationId: fixture.organization.id,
          scope: { kind: "branch", branchId: branch.id },
          productId: product.id,
        });
        expect(forecast.kind).toBe("success");
        if (forecast.kind !== "success") throw new Error("forecast");
        expect(forecast.forecasts[0]?.status).toBe("AVAILABLE");
        forecasts.push(forecast.forecasts[0]);
        const reorder = await createPrismaReorderRepository(prisma, {
          now: () => now,
        }).read({
          actorUserId: target.actorUserId,
          organizationId: fixture.organization.id,
          branchId: branch.id,
          productId: product.id,
          leadTimeDays: 7,
        });
        expect(reorder.kind).toBe("success");
        if (reorder.kind !== "success") throw new Error("reorder");
        expect(reorder.recommendation.status).toBe("AVAILABLE");
        recommendations.push(reorder.recommendation);
      }
    if (process.env.DEMO_30D_EVIDENCE_PATH)
      await writeFile(
        process.env.DEMO_30D_EVIDENCE_PATH,
        JSON.stringify(
          {
            signature: target.plan.signature,
            sales: target.plan.sales.length,
            receipts: target.plan.orders.length,
            netRevenue: net.toFixed(2),
            buckets: actual.buckets,
            forecasts,
            recommendations,
          },
          null,
          2,
        ),
      );
  });

  it("computes deterministic EN/TH Demo Insight, isolates tenant/scope and makes zero provider calls or fake provider rows", async () => {
    const reader = createDemoInsightReader({
      prisma,
      cursorCodec,
      organizationId: fixture.organization.id,
      runtimeEnvironment: "test",
    });
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Outbound provider forbidden"));
    try {
      const request = {
        actorUserId: target.actorUserId,
        organizationId: fixture.organization.id,
        scope: { kind: "organization" as const },
        language: "en" as const,
      };
      const first = await reader.read(request);
      expect(first).toEqual(await reader.read(request));
      expect(first.kind).toBe("success");
      if (first.kind !== "success") throw new Error("insight");
      expect(first.insight.metrics.saleCount).toBe(target.plan.sales.length);
      expect(first.insight.metrics.netRevenue).toBe("38630.00");
      expect(first.insight.metrics.growthPercent).toBe("-0.57");
      expect(first.insight.metrics.topProducts).toEqual([
        { name: "Daily Rice", unit: "EA", quantity: "879.0000" },
      ]);
      expect(first.insight.metrics.slowProducts).toEqual([
        { name: "Seasonal Gift", unit: "EA", quantity: "60.0000" },
      ]);
      const rawQuantity = await prisma.saleItem.aggregate({
        where: { productId: fixture.products[0]!.id },
        _sum: { quantity: true },
      });
      expect(rawQuantity._sum.quantity?.toFixed(4)).toBe(
        first.insight.metrics.topProducts[0]!.quantity,
      );
      expect(first.insight.content).toContain(first.insight.metrics.netRevenue);
      expect(first.insight.metrics.lowStock.length).toBeGreaterThan(0);
      expect(
        first.insight.metrics.lowStock.map((p) => p.onHand).sort(),
      ).toEqual(["2.0000", "5.0000"]);
      expect(
        first.insight.metrics.replenishment.map((p) => p.quantity).sort(),
      ).toEqual(["104.0000", "95.0000"]);
      expect(first.insight.providerCalls).toBe(0);
      expect(first.insight.provider).toBeNull();
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        for (const date of [
          "2026-10-30T12:00:00Z",
          "2026-10-31T12:00:00Z",
          "2026-11-02T12:00:00Z",
        ]) {
          vi.setSystemTime(new Date(date));
          for (const language of ["en", "th"] as const) {
            const later = await reader.read({ ...request, language });
            expect(later.kind).toBe("success");
            if (later.kind !== "success")
              throw new Error("fixed-period insight");
            expect(later.insight.from).toBe("2026-09-30");
            expect(later.insight.to).toBe("2026-10-30");
            expect(later.insight.reportingTimezone).toBe("Asia/Bangkok");
            expect(later.insight.metrics).toEqual(first.insight.metrics);
            expect(later.insight.content).toContain("38630.00");
            expect(later.insight.content).toContain("-0.57%");
          }
        }
      } finally {
        vi.useRealTimers();
      }
      expect(
        await createDemoInsightReader({
          prisma,
          cursorCodec,
          organizationId: fixture.organization.id,
          runtimeEnvironment: "production",
        }).read(request),
      ).toEqual({ kind: "not_found" });
      const thai = await reader.read({ ...request, language: "th" });
      expect(thai.kind === "success" && thai.insight.label).toBe(
        "ข้อมูลตัวอย่าง",
      );
      if (thai.kind === "success")
        expect(thai.insight.metrics).toEqual(first.insight.metrics);
      expect(
        await reader.read({ ...request, organizationId: fixture.other.id }),
      ).toEqual({ kind: "not_found" });
      expect(
        await createDemoInsightReader({
          prisma,
          cursorCodec,
          runtimeEnvironment: "test",
        }).read(request),
      ).toEqual({ kind: "not_found" });
      const manager = fixture.actors.find((a) => a.role === "BRANCH_MANAGER")!;
      const allowedBranch = await reader.read({
        ...request,
        actorUserId: manager.user.id,
        scope: { kind: "branch", branchId: fixture.branches[0]!.id },
      });
      expect(allowedBranch.kind).toBe("success");
      if (allowedBranch.kind === "success") {
        expect(allowedBranch.insight.metrics.saleCount).toBe(
          target.plan.sales.filter(
            (s) => s.branchId === fixture.branches[0]!.id,
          ).length,
        );
        expect(
          allowedBranch.insight.metrics.lowStock.every(
            (p) => p.branchId === fixture.branches[0]!.id,
          ),
        ).toBe(true);
      }
      expect(
        await reader.read({
          ...request,
          actorUserId: manager.user.id,
          scope: { kind: "branch", branchId: fixture.branches[1]!.id },
        }),
      ).toEqual({ kind: "forbidden" });
      const staff = fixture.actors.find((a) => a.role === "INVENTORY_STAFF")!;
      expect(
        await reader.read({
          ...request,
          actorUserId: staff.user.id,
          scope: { kind: "branch", branchId: fixture.branches[0]!.id },
        }),
      ).toEqual({ kind: "forbidden" });
      expect(spy).not.toHaveBeenCalled();
      expect(await prisma.aiInsightReport.count()).toBe(0);
      expect(await prisma.aiInsightAttempt.count()).toBe(0);
      expect(await prisma.analyticsSnapshot.count()).toBe(0);
    } finally {
      spy.mockRestore();
    }
  }, 60_000);

  it("refuses historical backfill into newer unrelated stock history without changing that history", async () => {
    const organization = await prisma.organization.create({
      data: {
        name: "UAT Demo Siam Mart",
        reportingTimezone: "Asia/Bangkok",
        salesVatStatus: "NOT_REGISTERED",
      },
    });
    await prisma.organizationMembership.create({
      data: {
        organizationId: organization.id,
        userId: target.actorUserId,
        role: "OWNER",
      },
    });
    const branch = await prisma.branch.create({
      data: {
        organizationId: organization.id,
        code: "MAIN",
        name: "Existing stock branch",
      },
    });
    const products = await Promise.all(
      [1, 2, 3].map((index) =>
        prisma.product.create({
          data: {
            organizationId: organization.id,
            sku: `BASELINE-${index}`,
            name: `Existing product ${index}`,
            unit: "EA",
            basePrice: "10",
          },
        }),
      ),
    );
    await prisma.supplier.create({
      data: { organizationId: organization.id, name: "Existing supplier" },
    });
    const adjusted = await createPrismaInventoryRepository(
      prisma,
      () => now,
    ).adjust({
      actorUserId: target.actorUserId,
      organizationId: organization.id,
      branchId: branch.id,
      idempotencyKey: "existing-stock-after-window-start",
      adjustment: {
        productId: products[0]!.id,
        delta: "10",
        reason: "FOUND",
        note: null,
      },
    });
    expect(adjusted.kind).toBe("success");
    const before = await databaseFingerprint();
    await expect(
      runDemo30d(prisma, {
        ...options(),
        organizationId: organization.id,
        apply: true,
      }),
    ).rejects.toThrow(/unrelated business history/);
    expect(await databaseFingerprint()).toBe(before);
    const empty = await createDemoInsightReader({
      prisma,
      cursorCodec,
      organizationId: organization.id,
      runtimeEnvironment: "test",
    }).read({
      actorUserId: target.actorUserId,
      organizationId: organization.id,
      scope: { kind: "organization" },
      language: "en",
    });
    expect(empty).toEqual({ kind: "not_found" });
  });
});
