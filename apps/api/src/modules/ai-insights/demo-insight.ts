import { Prisma, type PrismaClient } from "../../generated/prisma/client.ts";
import { DEMO_30D_ORGANIZATION } from "../../demo/demo-30d-plan.ts";
import {
  readDemoProvenance,
  demoBusinessFingerprint,
} from "../../demo/demo-30d-provenance.ts";
import { localDateToUtcBoundary } from "../analytics/analytics-period.ts";
import { createAnalyticsContextEngine } from "../analytics/analytics-context.ts";
import type { AnalyticsDimensionCursorCodec } from "../analytics/analytics-dimension-cursor.ts";
import { createPrismaAnalyticsInventoryRepository } from "../analytics/analytics-inventory-repository.ts";
import { createAnalyticsInventoryService } from "../analytics/analytics-inventory-service.ts";
import type { InventoryDimension } from "../analytics/analytics-inventory-values.ts";
import { createPrismaReorderRepository } from "../analytics/analytics-reorder-repository.ts";
import { createPrismaAnalyticsSalesRepository } from "../analytics/analytics-sales-repository.ts";
import { createPrismaAnalyticsScopeRepository } from "../analytics/analytics-scope-repository.ts";
import {
  createPrismaAiInsightReader,
  type InsightReadScope,
} from "./ai-insight-store.ts";

const Decimal = Prisma.Decimal.clone({ precision: 80 });

export function createDemoInsightReader(input: {
  prisma: PrismaClient;
  organizationId?: string | undefined;
  cursorCodec: AnalyticsDimensionCursorCodec;
  runtimeEnvironment: "development" | "test" | "production";
}) {
  return {
    async read(request: {
      actorUserId: string;
      organizationId: string;
      scope: InsightReadScope;
      language: "en" | "th";
    }) {
      if (
        input.runtimeEnvironment !== "development" &&
        input.runtimeEnvironment !== "test"
      )
        return { kind: "not_found" } as const;
      if (!(await createPrismaAiInsightReader(input.prisma).authorize(request)))
        return { kind: "forbidden" } as const;
      if (request.organizationId !== input.organizationId)
        return { kind: "not_found" } as const;
      const organization = await input.prisma.organization.findUnique({
        where: { id: request.organizationId },
        select: { name: true, reportingTimezone: true },
      });
      if (organization?.name !== DEMO_30D_ORGANIZATION)
        return { kind: "not_found" } as const;
      const provenance = await readDemoProvenance(
        input.prisma,
        request.organizationId,
      ).catch(() => null);
      if (
        !provenance ||
        provenance.state !== "COMPLETE" ||
        provenance.plan.reportingTimezone !== organization.reportingTimezone ||
        provenance.fingerprint !==
          (await demoBusinessFingerprint(input.prisma, request.organizationId))
      )
        return { kind: "not_found" } as const;
      const now = localDateToUtcBoundary(
        provenance.plan.to,
        organization.reportingTimezone,
      );
      const range = {
        from: provenance.plan.from,
        to: provenance.plan.to,
        granularity: "day" as const,
      };
      const contextEngine = createAnalyticsContextEngine({
        scopeRepository: createPrismaAnalyticsScopeRepository(input.prisma),
        now: () => now,
      });
      const resolved = await contextEngine.resolve({
        ...request,
        ...range,
        analyticsKind: "business",
      });
      if (resolved.kind !== "success") return { kind: "forbidden" } as const;
      const sales = await createPrismaAnalyticsSalesRepository(
        input.prisma,
      ).read(resolved.context);
      const inventoryService = createAnalyticsInventoryService({
        contextEngine,
        cursorCodec: input.cursorCodec,
        repository: createPrismaAnalyticsInventoryRepository(
          input.prisma,
          input.cursorCodec,
          { now: () => now },
        ),
      });
      const dimensions: InventoryDimension[] = [];
      let cursor: string | undefined;
      do {
        const page = await inventoryService.read({
          ...request,
          ...range,
          limit: 100,
          ...(cursor ? { cursor } : {}),
        });
        if (page.kind !== "success") return { kind: "forbidden" } as const;
        dimensions.push(...page.page.series);
        cursor = page.page.nextCursor ?? undefined;
      } while (cursor);
      const sum = (values: readonly string[]) =>
        values.reduce((total, value) => total.plus(value), new Decimal(0));
      const netRevenue = sum(
        sales.buckets.map((b) => b.netSalesAmount),
      ).toFixed(2);
      const firstHalf = sum(
        sales.buckets.slice(0, 15).map((b) => b.netSalesAmount),
      );
      const secondHalf = sum(
        sales.buckets.slice(15).map((b) => b.netSalesAmount),
      );
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
      const units = [
        ...new Set([...products.values()].map((p) => p.unit)),
      ].sort();
      const topProducts = units
        .map(
          (unit) =>
            [...products.values()]
              .filter((p) => p.unit === unit)
              .sort(
                (a, b) =>
                  b.quantity.cmp(a.quantity) || a.id.localeCompare(b.id),
              )[0]!,
        )
        .filter((p) => p.quantity.gt(0))
        .map((p) => ({
          name: p.name,
          unit: p.unit,
          quantity: p.quantity.toFixed(4),
        }));
      const slowProducts = units
        .map(
          (unit) =>
            [...products.values()]
              .filter((p) => p.unit === unit)
              .sort(
                (a, b) =>
                  a.quantity.cmp(b.quantity) || a.id.localeCompare(b.id),
              )[0]!,
        )
        .map((p) => ({
          name: p.name,
          unit: p.unit,
          quantity: p.quantity.toFixed(4),
        }));
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
      const replenishment = [];
      for (const item of lowStock) {
        const result = await createPrismaReorderRepository(input.prisma, {
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
      const th = request.language === "th";
      const productText = (p: {
        name: string;
        quantity: string;
        unit: string;
      }) => `${p.name}: ${p.quantity} ${p.unit}`;
      const lines = [
        th
          ? `รายได้สุทธิ ${netRevenue} THB จาก ${sales.buckets.reduce((n, b) => n + b.saleCount, 0)} รายการขาย`
          : `Net revenue ${netRevenue} THB from ${sales.buckets.reduce((n, b) => n + b.saleCount, 0)} sales.`,
        growthPercent === null
          ? th
            ? "ยังไม่มีฐานเปรียบเทียบรายได้"
            : "Revenue comparison has no positive baseline."
          : th
            ? `รายได้ครึ่งหลังเทียบครึ่งแรกของช่วงนี้: ${growthPercent}%`
            : `Second-half revenue versus first half: ${growthPercent}%.`,
        `${th ? "สินค้าขายดี แยกตามหน่วย" : "Top products by base unit"}: ${topProducts.map(productText).join("; ") || (th ? "ยังไม่มีการขาย" : "no sales")}.`,
        `${th ? "สินค้าขายช้า แยกตามหน่วย" : "Slow-moving products by base unit"}: ${slowProducts.map(productText).join("; ") || "—"}.`,
        `${th ? "สินค้าใกล้หมด แยกตามสาขา" : "Low-stock branch/product pairs"}: ${lowStock.map((p) => `${p.branchName} / ${p.name}: ${p.onHand} ${p.unit}, ${p.coverageDays} ${th ? "วัน" : "days"}`).join("; ") || (th ? "ไม่มีรายการที่คำนวณได้" : "none with available coverage")}.`,
        `${th ? "ข้อเสนอแนะเติมสินค้า ระยะวางแผน 7 วัน" : "Advisory replenishment with a 7-day planning lead time"}: ${replenishment.map((p) => `${p.branchName} / ${productText(p)}`).join("; ") || (th ? "ไม่มีคำแนะนำที่พร้อมใช้งาน" : "no available recommendations")}.`,
      ];
      if (
        provenance.fingerprint !==
        (await demoBusinessFingerprint(input.prisma, request.organizationId))
      )
        return { kind: "not_found" } as const;
      return {
        kind: "success" as const,
        insight: {
          label: th ? "ข้อมูลตัวอย่าง" : "Demo Insight",
          mode: "DEMO" as const,
          provider: null,
          providerCalls: 0 as const,
          explanation: th
            ? "ข้อความตัวอย่างจากข้อมูลที่คำนวณจริง ไม่ได้สร้างโดย OpenRouter"
            : "Deterministic demo text from computed metrics. Not generated by OpenRouter.",
          content: lines.join("\n"),
          from: range.from,
          to: range.to,
          reportingTimezone: organization.reportingTimezone,
          metrics: {
            netRevenue,
            saleCount: sales.buckets.reduce((n, b) => n + b.saleCount, 0),
            growthPercent,
            topProducts,
            slowProducts,
            lowStock,
            replenishment,
          },
        },
      };
    },
  };
}
