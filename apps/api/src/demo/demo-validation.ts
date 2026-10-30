import assert from "node:assert/strict";

import { Prisma, type PrismaClient } from "../generated/prisma/client.ts";
import {
  can,
  createTrustedAuthorizationContext,
  createTrustedBranchScope,
  PERMISSIONS,
} from "../modules/identity/authorization-policy.ts";
import { createAnalyticsContextEngine } from "../modules/analytics/analytics-context.ts";
import { createAnalyticsDimensionCursorCodec } from "../modules/analytics/analytics-dimension-cursor.ts";
import { createPrismaAnalyticsBranchRepository } from "../modules/analytics/analytics-branch-repository.ts";
import { createPrismaAnalyticsCategoryRepository } from "../modules/analytics/analytics-category-repository.ts";
import { createPrismaForecastRepository } from "../modules/analytics/analytics-forecast-repository.ts";
import { createPrismaAnalyticsInventoryRepository } from "../modules/analytics/analytics-inventory-repository.ts";
import { createPrismaReorderRepository } from "../modules/analytics/analytics-reorder-repository.ts";
import { createPrismaAnalyticsSalesRepository } from "../modules/analytics/analytics-sales-repository.ts";
import { createPrismaAnalyticsScopeRepository } from "../modules/analytics/analytics-scope-repository.ts";
import { demoId } from "./demo-values.ts";

const organizationId = demoId("organization", "DEMO-ORGANIZATION");
const ownerId = demoId("user", "demo-owner@example.invalid");
const fixedNow = () => new Date("2026-09-25T17:00:00.000Z");
const branchId = (branch: string) => demoId("branch", branch);
const productId = (sku: string) => demoId("product", sku);

export async function validateDemoGoldens(prisma: PrismaClient): Promise<void> {
  const scopeRepository = createPrismaAnalyticsScopeRepository(prisma);
  const engine = createAnalyticsContextEngine({
    now: fixedNow,
    scopeRepository,
  });
  const cursor = createAnalyticsDimensionCursorCodec(Buffer.alloc(32, 1));
  async function context(input: {
    from: string;
    to: string;
    granularity: "day" | "year";
  }) {
    const result = await engine.resolve({
      actorUserId: ownerId,
      organizationId,
      analyticsKind: "business",
      scope: { kind: "organization" },
      ...input,
    });
    if (result.kind !== "success")
      throw new Error("Demo OWNER business analytics scope is invalid.");
    return result.context;
  }

  const year = await context({
    from: "2025-01-01",
    to: "2026-01-01",
    granularity: "year",
  });
  const annual = (await createPrismaAnalyticsSalesRepository(prisma).read(year))
    .buckets[0]!;
  assert.equal(annual.saleCount, 730);
  assert.equal(annual.refundCount, 0);
  assert.equal(annual.grossSalesAmount, "59296.00");
  const categories = (
    await createPrismaAnalyticsCategoryRepository(prisma, cursor).read(
      year,
      10,
      null,
    )
  ).series;
  assert.equal(
    categories.find((item) => item.categoryName === "DEMO-STAPLES")?.buckets[0]
      ?.grossSalesAmount,
    "21900.00",
  );
  assert.equal(
    categories.find((item) => item.categoryKind === "UNCATEGORIZED")?.buckets[0]
      ?.grossSalesAmount,
    "636.00",
  );
  const branches = (
    await createPrismaAnalyticsBranchRepository(prisma, cursor).read(
      year,
      10,
      null,
    )
  ).series;
  assert.equal(
    branches.find((item) => item.branchId === branchId("DEMO-A"))?.buckets[0]
      ?.grossSalesAmount,
    "51996.00",
  );
  assert.equal(
    branches.find((item) => item.branchId === branchId("DEMO-B"))?.buckets[0]
      ?.grossSalesAmount,
    "7300.00",
  );
  const stableItems = await prisma.saleItem.findMany({
    where: { productId: productId("DEMO-STABLE") },
  });
  for (const [branch, quantity] of [
    ["DEMO-A", "1266.0000"],
    ["DEMO-B", "633.0000"],
  ] as const) {
    assert.equal(
      stableItems
        .filter((item) => item.branchId === branchId(branch))
        .reduce((sum, item) => sum.plus(item.quantity), new Prisma.Decimal(0))
        .toFixed(4),
      quantity,
    );
  }
  assert.equal(
    stableItems
      .reduce((sum, item) => sum.plus(item.lineGross), new Prisma.Decimal(0))
      .toFixed(2),
    "37980.00",
  );
  assert.equal(
    stableItems
      .reduce((sum, item) => sum.plus(item.lineDiscount), new Prisma.Decimal(0))
      .toFixed(2),
    "5.00",
  );
  assert.equal(
    stableItems
      .reduce((sum, item) => sum.plus(item.lineNet), new Prisma.Decimal(0))
      .toFixed(2),
    "37975.00",
  );

  const refundDay = await context({
    from: "2026-09-21",
    to: "2026-09-22",
    granularity: "day",
  });
  const refunded = (
    await createPrismaAnalyticsSalesRepository(prisma).read(refundDay)
  ).buckets[0]!;
  assert.equal(refunded.refundAmount, "50.00");
  assert.equal(refunded.cost?.refundCogsReversalAmount, "10.0000000000");

  for (const [from, to, expected] of [
    ["2025-11-01", "2025-12-01", "60"],
    ["2025-12-01", "2026-01-01", "107"],
    ["2026-01-01", "2026-02-01", "47"],
  ] as const) {
    const quantity = await prisma.saleItem.aggregate({
      _sum: { quantity: true },
      where: {
        branchId: branchId("DEMO-A"),
        productId: productId("DEMO-WEEKLY"),
        sale: {
          completedAt: {
            gte: new Date(`${from}T00:00:00+07:00`),
            lt: new Date(`${to}T00:00:00+07:00`),
          },
        },
      },
    });
    assert.equal(quantity._sum.quantity?.toString(), expected);
  }

  const inventoryContext = await engine.resolve({
    actorUserId: ownerId,
    organizationId,
    analyticsKind: "inventory",
    scope: { kind: "organization" },
    from: "2026-09-01",
    to: "2026-09-26",
    granularity: "day",
  });
  if (inventoryContext.kind !== "success")
    throw new Error("Demo OWNER inventory scope is invalid.");
  const inventory = await createPrismaAnalyticsInventoryRepository(
    prisma,
    cursor,
    { now: fixedNow },
  ).read(inventoryContext.context, 20, null, false, ownerId, {
    kind: "organization",
  });
  for (const [branch, sku, onHand, coverage, classification, reason] of [
    ["DEMO-A", "DEMO-STABLE", "3.0000", "1.50", "LOW_STOCK", null],
    ["DEMO-B", "DEMO-STABLE", "10.0000", "10.00", "NORMAL", null],
    ["DEMO-A", "DEMO-WEEKLY", "110.0000", "62.86", "OVERSTOCK", null],
    ["DEMO-A", "DEMO-WEIGHT", "1.0000", "2.00", "LOW_STOCK", null],
    ["DEMO-B", "DEMO-SPARSE", "5.0000", null, null, "NO_RECENT_DEMAND"],
  ] as const) {
    const row = inventory.series.find(
      (item) =>
        item.branchId === branchId(branch) && item.productId === productId(sku),
    );
    assert.ok(row, `Missing inventory ${branch}/${sku}`);
    assert.equal(row.onHandQuantity, onHand);
    assert.equal(row.coverageDays.value, coverage);
    assert.equal(row.stockClassification.classification, classification);
    assert.equal(row.stockClassification.reason, reason);
  }

  const forecast = createPrismaForecastRepository(prisma, { now: fixedNow });
  const reorder = createPrismaReorderRepository(prisma, { now: fixedNow });
  for (const [branch, sku, daily, total, leadTime, recommendation, reason] of [
    ["DEMO-A", "DEMO-STABLE", "2.0000", "14.0000", 2, "1.0000", null],
    ["DEMO-B", "DEMO-STABLE", "1.0000", "7.0000", 2, "0.0000", null],
    ["DEMO-A", "DEMO-WEEKLY", "1.7500", "12.2500", 2, "0.0000", null],
    ["DEMO-A", "DEMO-WEIGHT", "0.5000", "3.5000", 3, "0.5000", null],
    ["DEMO-A", "DEMO-SPARSE", "0.1429", "1.0003", 7, "1.0000", null],
    ["DEMO-B", "DEMO-SPARSE", "0.0000", "0.0000", 2, "0.0000", null],
    ["DEMO-A", "DEMO-NEW", null, null, 2, null, "INSUFFICIENT_DATA"],
    ["DEMO-A", "DEMO-ARCHIVED", null, null, 2, null, "INACTIVE_PRODUCT"],
  ] as const) {
    const identity = {
      actorUserId: ownerId,
      organizationId,
      branchId: branchId(branch),
      productId: productId(sku),
    };
    const result = await forecast.read({
      actorUserId: ownerId,
      organizationId,
      productId: identity.productId,
      scope: { kind: "branch", branchId: identity.branchId },
    });
    assert.equal(result.kind, "success");
    if (result.kind !== "success") throw new Error("Forecast access failed.");
    const pair = result.forecasts[0]!;
    assert.equal(pair.days[0]?.quantity ?? null, daily);
    assert.equal(pair.horizonTotal, total);
    assert.equal(pair.reason, reason);
    const order = await reorder.read({ ...identity, leadTimeDays: leadTime });
    assert.equal(order.kind, "success");
    if (order.kind !== "success") throw new Error("Reorder access failed.");
    assert.equal(order.recommendation.recommendedQuantity, recommendation);
    assert.equal(order.recommendation.reason, reason);
    if (branch === "DEMO-A" && sku === "DEMO-SPARSE") {
      assert.equal(order.recommendation.leadTimeDemand, "1.0003");
      assert.equal(order.recommendation.rawNeed, "0.0003");
    }
  }

  const adjustments = await prisma.inventoryTransaction.findMany({
    where: { source: "MANUAL_ADJUSTMENT" },
    orderBy: { occurredAt: "asc" },
  });
  assert.deepEqual(
    adjustments.map((row) => [row.adjustmentReason, row.delta.toString()]),
    [
      ["FOUND", "1"],
      ["DAMAGE", "-1"],
    ],
  );
  const returned = await prisma.inventoryTransaction.findMany({
    where: { source: "SALE_REFUND_RETURN" },
  });
  assert.equal(returned.length, 1);
  assert.equal(returned[0]!.delta.toFixed(4), "0.2500");

  const refundItem = await prisma.saleRefundItem.findFirstOrThrow();
  assert.equal(refundItem.refundQuantity.toFixed(4), "0.5000");
  assert.equal(refundItem.restockQuantity.toFixed(4), "0.2500");
  assert.equal(refundItem.cogsReversalAmount?.toFixed(10), "10.0000000000");
  const orders = await prisma.purchaseOrder.findMany({
    include: { receipt: true, items: true },
  });
  assert.equal(orders.length, 43);
  for (const order of orders) {
    assert.equal(order.status, "RECEIVED");
    assert.ok(
      order.orderedAt && order.receivedAt && order.orderedAt < order.receivedAt,
    );
    assert.equal(
      order.receipt?.receivedAt.toISOString(),
      order.receivedAt?.toISOString(),
    );
    assert.equal(order.receipt?.branchId, order.branchId);
  }
  const receiptCosts = new Map<string, Prisma.Decimal>();
  for (const item of await prisma.purchaseReceiptItem.findMany()) {
    const prior = receiptCosts.get(item.productId);
    if (prior) assert.equal(item.actualUnitCost.toFixed(4), prior.toFixed(4));
    receiptCosts.set(item.productId, item.actualUnitCost);
  }
  const sales = await prisma.sale.findMany({
    include: { items: true, payment: true },
  });
  assert.equal(sales.length, 1266);
  for (const sale of sales) {
    assert.ok(sale.items.length > 0);
    assert.equal(sale.payment?.amount.toFixed(2), sale.totalAmount.toFixed(2));
    assert.equal(
      sale.payment?.amountTendered?.toFixed(2),
      sale.totalAmount.toFixed(2),
    );
    assert.equal(sale.payment?.changeAmount?.toFixed(2), "0.00");
    assert.equal(
      sale.items
        .reduce((sum, item) => sum.plus(item.lineGross), new Prisma.Decimal(0))
        .toFixed(2),
      sale.subtotalAmount.toFixed(2),
    );
    assert.equal(
      sale.items
        .reduce(
          (sum, item) => sum.plus(item.lineDiscount),
          new Prisma.Decimal(0),
        )
        .toFixed(2),
      sale.discountAmount.toFixed(2),
    );
    assert.equal(
      sale.items
        .reduce((sum, item) => sum.plus(item.lineNet), new Prisma.Decimal(0))
        .toFixed(2),
      sale.totalAmount.toFixed(2),
    );
    assert.equal(
      sale.items
        .reduce(
          (sum, item) => sum.plus(item.lineOutputVat),
          new Prisma.Decimal(0),
        )
        .toFixed(2),
      sale.outputVatAmount.toFixed(2),
    );
    assert.ok(
      sale.items.every(
        (item) =>
          item.costBasisState === "KNOWN" &&
          item.unitCost !== null &&
          item.cogsAmount !== null,
      ),
    );
    for (const item of sale.items)
      assert.equal(
        item.unitCost?.toFixed(6),
        receiptCosts.get(item.productId)?.toFixed(6),
      );
  }

  const managerId = demoId("user", "demo-manager-a@example.invalid");
  const inventoryStaffId = demoId("user", "demo-inventory-b@example.invalid");
  const cashierId = demoId("user", "demo-cashier-a@example.invalid");
  const scoped = (
    actorUserId: string,
    analyticsKind: "business" | "inventory" | "forecast",
    branch: string,
  ) =>
    scopeRepository.resolve({
      actorUserId,
      analyticsKind,
      organizationId,
      candidate: { kind: "branch", branchId: branchId(branch) },
    });
  const managerA = await scoped(managerId, "business", "DEMO-A");
  assert.equal(managerA.kind, "success");
  if (managerA.kind === "success")
    assert.equal(managerA.scope.canViewCost, true);
  assert.equal(
    (await scoped(managerId, "business", "DEMO-B")).kind,
    "forbidden",
  );
  const staffB = await scoped(inventoryStaffId, "inventory", "DEMO-B");
  assert.equal(staffB.kind, "success");
  if (staffB.kind === "success") assert.equal(staffB.scope.canViewCost, false);
  assert.equal(
    (await scoped(inventoryStaffId, "forecast", "DEMO-B")).kind,
    "forbidden",
  );
  assert.equal(
    (await scoped(inventoryStaffId, "inventory", "DEMO-A")).kind,
    "forbidden",
  );
  assert.equal(
    (await scoped(cashierId, "business", "DEMO-A")).kind,
    "forbidden",
  );
  const cashier = await prisma.organizationMembership.findUniqueOrThrow({
    where: { organizationId_userId: { organizationId, userId: cashierId } },
    include: { user: true, branchAssignments: true },
  });
  const cashierContext = createTrustedAuthorizationContext({
    actor: cashier.user,
    membership: cashier,
    branchAssignments: cashier.branchAssignments,
  });
  const cashierBranch = createTrustedBranchScope({
    branchId: branchId("DEMO-A"),
    branchOrganizationId: organizationId,
    organizationId,
  });
  assert.ok(
    cashierContext &&
      cashierBranch &&
      can(cashierContext, PERMISSIONS.CHECKOUT_PERFORM, cashierBranch),
  );

  const movementRows = await prisma.inventoryTransaction.findMany({
    orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
  });
  const receiptMovementIds = new Set(
    movementRows
      .filter((row) => row.source === "PURCHASE_RECEIVE")
      .map((row) => row.purchaseReceiptItemId),
  );
  const saleMovementIds = new Set(
    movementRows
      .filter((row) => row.source === "SALE")
      .map((row) => row.saleItemId),
  );
  assert.equal(receiptMovementIds.size, 108);
  assert.equal(saleMovementIds.size, 2488);
  for (const item of await prisma.purchaseReceiptItem.findMany())
    assert.ok(receiptMovementIds.has(item.id));
  for (const sale of sales)
    for (const item of sale.items) assert.ok(saleMovementIds.has(item.id));
  const units = new Map(
    (await prisma.product.findMany()).map((item) => [item.id, item.unit]),
  );
  const running = new Map<string, Prisma.Decimal>();
  for (const row of movementRows) {
    assert.equal(row.organizationId, organizationId);
    if (units.get(row.productId) === "EA") assert.ok(row.delta.isInteger());
    const key = `${row.branchId}|${row.productId}`;
    const balance = (running.get(key) ?? new Prisma.Decimal(0)).plus(row.delta);
    assert.ok(!balance.isNegative(), `Negative inventory prefix ${key}`);
    running.set(key, balance);
  }
  for (const balance of await prisma.inventoryBalance.findMany()) {
    const key = `${balance.branchId}|${balance.productId}`;
    assert.equal(running.get(key)?.toFixed(4), balance.quantity.toFixed(4));
  }
  for (const cost of await prisma.inventoryCostState.findMany()) {
    assert.equal(cost.basisState, "KNOWN");
    assert.equal(
      cost.averageUnitCost?.toFixed(6),
      receiptCosts.get(cost.productId)?.toFixed(6),
    );
    const quantity = running.get(`${cost.branchId}|${cost.productId}`)!;
    assert.equal(
      cost.inventoryValue?.toFixed(10),
      quantity
        .times(cost.averageUnitCost!)
        .toDecimalPlaces(10, Prisma.Decimal.ROUND_HALF_UP)
        .toFixed(10),
    );
  }
}
