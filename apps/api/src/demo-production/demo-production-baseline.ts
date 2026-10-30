import { createHash } from "node:crypto";

import { z } from "zod";

import { Prisma, type PrismaClient } from "../generated/prisma/client.ts";
import { createAnalyticsContextEngine } from "../modules/analytics/analytics-context.ts";
import type { AnalyticsDimensionCursorCodec } from "../modules/analytics/analytics-dimension-cursor.ts";
import { createPrismaAnalyticsInventoryRepository } from "../modules/analytics/analytics-inventory-repository.ts";
import { createAnalyticsInventoryService } from "../modules/analytics/analytics-inventory-service.ts";
import type { InventoryDimension } from "../modules/analytics/analytics-inventory-values.ts";
import { createPrismaReorderRepository } from "../modules/analytics/analytics-reorder-repository.ts";
import { createPrismaAnalyticsSalesRepository } from "../modules/analytics/analytics-sales-repository.ts";
import { createPrismaAnalyticsScopeRepository } from "../modules/analytics/analytics-scope-repository.ts";
import type { InsightReadScope } from "../modules/ai-insights/ai-insight-store.ts";

const Decimal = Prisma.Decimal.clone({ precision: 80 });

const quantityLine = z.object({
  name: z.string(),
  unit: z.string(),
  quantity: z.string(),
});
export const baselineMetricsSchema = z.object({
  netRevenue: z.string(),
  saleCount: z.number().int(),
  growthPercent: z.string().nullable(),
  topProducts: z.array(quantityLine),
  slowProducts: z.array(quantityLine),
  lowStock: z.array(
    z.object({
      branchId: z.string(),
      productId: z.string(),
      branchName: z.string(),
      name: z.string(),
      unit: z.string(),
      onHand: z.string(),
      coverageDays: z.string().nullable(),
    }),
  ),
  replenishment: z.array(
    quantityLine.extend({ branchId: z.string(), branchName: z.string() }),
  ),
});
export type BaselineMetrics = z.infer<typeof baselineMetricsSchema>;

/** Immutable, verified record of the fixed historical window, per authorized scope. */
export const baselineSchema = z.object({
  version: z.literal(1),
  from: z.string(),
  to: z.string(),
  reportingTimezone: z.string(),
  scopes: z.record(z.string(), baselineMetricsSchema),
});
export type Baseline = z.infer<typeof baselineSchema>;

type Scope = InsightReadScope;
export const scopeKey = (scope: Scope) =>
  scope.kind === "organization" ? "organization" : scope.branchId;

/**
 * Real Sales/Inventory/Reorder engines evaluated at the period-end instant for
 * one scope (the same computation as the disposable-database Demo Insight).
 */
export async function computeScopeMetrics(
  prisma: PrismaClient,
  cursorCodec: AnalyticsDimensionCursorCodec,
  request: { actorUserId: string; organizationId: string; scope: Scope },
  range: { from: string; to: string },
  now: Date,
): Promise<BaselineMetrics | null> {
  const window = { ...range, granularity: "day" as const };
  const contextEngine = createAnalyticsContextEngine({
    scopeRepository: createPrismaAnalyticsScopeRepository(prisma),
    now: () => now,
  });
  const resolved = await contextEngine.resolve({
    ...request,
    ...window,
    analyticsKind: "business",
  });
  if (resolved.kind !== "success") return null;
  const sales = await createPrismaAnalyticsSalesRepository(prisma).read(
    resolved.context,
  );
  const inventoryService = createAnalyticsInventoryService({
    contextEngine,
    cursorCodec,
    repository: createPrismaAnalyticsInventoryRepository(prisma, cursorCodec, {
      now: () => now,
    }),
  });
  const dimensions: InventoryDimension[] = [];
  let cursor: string | undefined;
  do {
    const page = await inventoryService.read({
      ...request,
      ...window,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    if (page.kind !== "success") return null;
    dimensions.push(...page.page.series);
    cursor = page.page.nextCursor ?? undefined;
  } while (cursor);
  const sum = (values: readonly string[]) =>
    values.reduce((total, value) => total.plus(value), new Decimal(0));
  const netRevenue = sum(sales.buckets.map((b) => b.netSalesAmount)).toFixed(2);
  const firstHalf = sum(
    sales.buckets.slice(0, 15).map((b) => b.netSalesAmount),
  );
  const secondHalf = sum(sales.buckets.slice(15).map((b) => b.netSalesAmount));
  const growthPercent = firstHalf.gt(0)
    ? secondHalf.minus(firstHalf).div(firstHalf).times(100).toFixed(2)
    : null;
  const products = new Map<
    string,
    { id: string; name: string; unit: string; quantity: Prisma.Decimal }
  >();
  for (const item of dimensions) {
    const current = products.get(item.productId) ?? {
      id: item.productId,
      name: item.productName,
      unit: item.productUnit,
      quantity: new Decimal(0),
    };
    current.quantity = current.quantity.plus(
      sum(item.buckets.map((b) => b.saleDepletionQuantity)),
    );
    products.set(item.productId, current);
  }
  // Rank within each base unit; adding kilograms and individual units is not meaningful.
  const units = [...new Set([...products.values()].map((p) => p.unit))].sort();
  const pick = (direction: 1 | -1) =>
    units.map(
      (unit) =>
        [...products.values()]
          .filter((p) => p.unit === unit)
          .sort(
            (a, b) =>
              direction * b.quantity.cmp(a.quantity) ||
              a.id.localeCompare(b.id),
          )[0]!,
    );
  const line = (p: {
    name: string;
    unit: string;
    quantity: Prisma.Decimal;
  }) => ({
    name: p.name,
    unit: p.unit,
    quantity: p.quantity.toFixed(4),
  });
  const lowStock = dimensions
    .filter((p) => p.stockClassification.classification === "LOW_STOCK")
    .map((p) => ({
      branchId: p.branchId,
      productId: p.productId,
      branchName: p.branchName,
      name: p.productName,
      unit: p.productUnit,
      onHand: p.onHandQuantity,
      coverageDays: p.coverageDays.value,
    }));
  const replenishment: BaselineMetrics["replenishment"] = [];
  for (const item of lowStock) {
    const result = await createPrismaReorderRepository(prisma, {
      now: () => now,
    }).read({
      actorUserId: request.actorUserId,
      organizationId: request.organizationId,
      branchId: item.branchId,
      productId: item.productId,
      leadTimeDays: 7,
    });
    if (
      result.kind === "success" &&
      result.recommendation.status === "AVAILABLE"
    )
      replenishment.push({
        name: item.name,
        unit: item.unit,
        branchId: item.branchId,
        branchName: item.branchName,
        quantity: result.recommendation.recommendedQuantity,
      });
  }
  return {
    netRevenue,
    saleCount: sales.buckets.reduce((n, b) => n + b.saleCount, 0),
    growthPercent,
    topProducts: pick(1)
      .filter((p) => p.quantity.gt(0))
      .map(line),
    slowProducts: pick(-1).map(line),
    lowStock,
    replenishment,
  };
}

export function renderBaselineInsight(input: {
  metrics: BaselineMetrics;
  language: "en" | "th";
  from: string;
  to: string;
  reportingTimezone: string;
}) {
  const { metrics, from, to } = input;
  const th = input.language === "th";
  const productText = (p: { name: string; quantity: string; unit: string }) =>
    `${p.name}: ${p.quantity} ${p.unit}`;
  const lines = [
    th
      ? `รายได้สุทธิ ${metrics.netRevenue} THB จาก ${metrics.saleCount} รายการขาย`
      : `Net revenue ${metrics.netRevenue} THB from ${metrics.saleCount} sales.`,
    metrics.growthPercent === null
      ? th
        ? "ยังไม่มีฐานเปรียบเทียบรายได้"
        : "Revenue comparison has no positive baseline."
      : th
        ? `รายได้ครึ่งหลังเทียบครึ่งแรกของช่วงนี้: ${metrics.growthPercent}%`
        : `Second-half revenue versus first half: ${metrics.growthPercent}%.`,
    `${th ? "สินค้าขายดี แยกตามหน่วย" : "Top products by base unit"}: ${metrics.topProducts.map(productText).join("; ") || (th ? "ยังไม่มีการขาย" : "no sales")}.`,
    `${th ? "สินค้าขายช้า แยกตามหน่วย" : "Slow-moving products by base unit"}: ${metrics.slowProducts.map(productText).join("; ") || "—"}.`,
    `${th ? "สินค้าใกล้หมด แยกตามสาขา" : "Low-stock branch/product pairs"}: ${metrics.lowStock.map((p) => `${p.branchName} / ${p.name}: ${p.onHand} ${p.unit}, ${p.coverageDays} ${th ? "วัน" : "days"}`).join("; ") || (th ? "ไม่มีรายการที่คำนวณได้" : "none with available coverage")}.`,
    `${th ? "ข้อเสนอแนะเติมสินค้า ระยะวางแผน 7 วัน" : "Advisory replenishment with a 7-day planning lead time"}: ${metrics.replenishment.map((p) => `${p.branchName} / ${productText(p)}`).join("; ") || (th ? "ไม่มีคำแนะนำที่พร้อมใช้งาน" : "no available recommendations")}.`,
  ];
  return {
    label: th ? "ข้อมูลตัวอย่าง" : "Demo Insight",
    mode: "DEMO" as const,
    provider: null,
    providerCalls: 0 as const,
    explanation: th
      ? `ข้อความตัวอย่างจากข้อมูลย้อนหลังคงที่ที่ตรวจสอบแล้ว (${from} ถึง ${to}) ยอดขายใหม่จาก POS หลังช่วงนี้ไม่รวมอยู่ ไม่ได้สร้างโดย OpenRouter`
      : `Deterministic demo text from a fixed, verified historical baseline (${from} to ${to}). New live POS sales after this period are not included. Not generated by OpenRouter.`,
    content: lines.join("\n"),
    from,
    to,
    reportingTimezone: input.reportingTimezone,
    metrics,
  };
}

const historyQueries: ReadonlyArray<readonly [string, string]> = [
  [
    "sales",
    "SELECT to_jsonb(t)::text AS r FROM sales t WHERE t.organization_id=$1::uuid AND t.completed_at < $2 ORDER BY t.id",
  ],
  [
    "sale_items",
    "SELECT to_jsonb(t)::text AS r FROM sale_items t WHERE t.organization_id=$1::uuid AND t.sale_id IN (SELECT id FROM sales WHERE organization_id=$1::uuid AND completed_at < $2) ORDER BY t.id",
  ],
  [
    "payments",
    "SELECT to_jsonb(t)::text AS r FROM payments t WHERE t.organization_id=$1::uuid AND t.sale_id IN (SELECT id FROM sales WHERE organization_id=$1::uuid AND completed_at < $2) ORDER BY t.id",
  ],
  [
    "sale_refunds",
    "SELECT to_jsonb(t)::text AS r FROM sale_refunds t WHERE t.organization_id=$1::uuid AND t.completed_at < $2 ORDER BY t.id",
  ],
  [
    "sale_refund_items",
    "SELECT to_jsonb(t)::text AS r FROM sale_refund_items t WHERE t.organization_id=$1::uuid AND t.sale_refund_id IN (SELECT id FROM sale_refunds WHERE organization_id=$1::uuid AND completed_at < $2) ORDER BY t.id",
  ],
  [
    "refund_payments",
    "SELECT to_jsonb(t)::text AS r FROM refund_payments t WHERE t.organization_id=$1::uuid AND t.sale_refund_id IN (SELECT id FROM sale_refunds WHERE organization_id=$1::uuid AND completed_at < $2) ORDER BY t.id",
  ],
  [
    "purchase_orders",
    "SELECT to_jsonb(t)::text AS r FROM purchase_orders t WHERE t.organization_id=$1::uuid AND t.created_at < $2 ORDER BY t.id",
  ],
  [
    "purchase_order_items",
    "SELECT to_jsonb(t)::text AS r FROM purchase_order_items t WHERE t.organization_id=$1::uuid AND t.purchase_order_id IN (SELECT id FROM purchase_orders WHERE organization_id=$1::uuid AND created_at < $2) ORDER BY t.id",
  ],
  [
    "purchase_receipts",
    "SELECT to_jsonb(t)::text AS r FROM purchase_receipts t WHERE t.organization_id=$1::uuid AND t.received_at < $2 ORDER BY t.id",
  ],
  [
    "purchase_receipt_items",
    "SELECT to_jsonb(t)::text AS r FROM purchase_receipt_items t WHERE t.organization_id=$1::uuid AND t.purchase_order_id IN (SELECT id FROM purchase_orders WHERE organization_id=$1::uuid AND created_at < $2) ORDER BY t.id",
  ],
  [
    "inventory_transactions",
    "SELECT to_jsonb(t)::text AS r FROM inventory_transactions t WHERE t.organization_id=$1::uuid AND t.occurred_at < $2 ORDER BY t.id",
  ],
];

/**
 * SHA-256 over every business event strictly before the period-end instant.
 * Later live sales, receipts, refunds and adjustments are dated at or after it,
 * and the digest excludes mutable projections (balances, cost states) and
 * master data, so it stays valid while the presenter keeps trading but changes
 * if any historical event is altered, removed or added.
 */
export async function historyDigest(
  prisma: PrismaClient | Prisma.TransactionClient,
  organizationId: string,
  boundary: Date,
): Promise<string> {
  const run = async (tx: Prisma.TransactionClient) => {
    await tx.$executeRaw`SET LOCAL TIME ZONE 'UTC'`;
    const digest = createHash("sha256");
    for (const [table, sql] of historyQueries) {
      const rows = await tx.$queryRawUnsafe<Array<{ r: string }>>(
        sql,
        organizationId,
        boundary,
      );
      digest.update(table).update(String(rows.length));
      for (const row of rows) digest.update(row.r);
    }
    return digest.digest("hex");
  };
  if ("$transaction" in prisma)
    return prisma.$transaction(run, {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      timeout: 30_000,
    });
  return run(prisma);
}
