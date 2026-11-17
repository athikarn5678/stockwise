import { Prisma, type PrismaClient } from "../../generated/prisma/client.ts";
import { Temporal } from "@js-temporal/polyfill";

import { validateIanaTimeZone } from "../analytics/analytics-period.ts";
import type { createAnalyticsCategoryService } from "../analytics/analytics-category-service.ts";
import type { createAnalyticsSalesService } from "../analytics/analytics-sales-service.ts";

const ExactDecimal = Prisma.Decimal.clone({ precision: 80 });
const CATEGORY_PAGE_LIMIT = 100;
const CATEGORY_PAGE_CAP = 10;

type CategorySeries =
  Awaited<
    ReturnType<ReturnType<typeof createAnalyticsCategoryService>["read"]>
  > extends infer Outcome
    ? Outcome extends {
        kind: "success";
        page: { series: readonly (infer Series)[] };
      }
      ? Series
      : never
    : never;

export type AiAnalyzeScope =
  | Readonly<{ kind: "organization" }>
  | Readonly<{ branchId: string; kind: "branch" }>;

export type AiAnalyzeSnapshotPeriod = Readonly<{
  days: number;
  from: string;
  scope: AiAnalyzeScope["kind"];
  timezone: string;
  to: string;
}>;

export type AiAnalyzeSnapshot = Readonly<{
  bestDay: Readonly<{ date: string; netSalesAmount: string }> | null;
  categories: Readonly<{
    bottom: readonly Readonly<{ name: string; netSalesAmount: string }>[];
    top: readonly Readonly<{ name: string; netSalesAmount: string }>[];
  }>;
  cost:
    | Readonly<{
        costCoverage: "complete";
        grossMarginPercent: string | null;
        grossProfitAmount: string;
      }>
    | Readonly<{ costNote: "unavailable" }>;
  days: readonly Readonly<{
    date: string;
    netSalesAmount: string;
    refundAmount: string;
    refundCount: number;
    saleCount: number;
    salesAfterDiscountAmount: string;
  }>[];
  period: AiAnalyzeSnapshotPeriod;
  totals: Readonly<{
    averageOrderValue: string | null;
    netSalesAmount: string;
    refundAmount: string;
    refundCount: number;
    saleCount: number;
  }>;
  worstDay: Readonly<{ date: string; netSalesAmount: string }> | null;
}>;

export type AiAnalyzeSnapshotOutcome =
  | Readonly<{ kind: "ok"; snapshot: AiAnalyzeSnapshot }>
  | Readonly<{ kind: "forbidden" }>
  | Readonly<{ kind: "unavailable" }>;

export type AiAnalyzeSnapshotRequest = Readonly<{
  actorUserId: string;
  days: number;
  organizationId: string;
  scope: AiAnalyzeScope;
}>;

type OrganizationReader = Pick<PrismaClient, "organization">;

function decimal(value: string): InstanceType<typeof ExactDecimal> {
  return new ExactDecimal(value);
}

function sum(values: readonly string[]): InstanceType<typeof ExactDecimal> {
  return values.reduce(
    (total, value) => total.add(decimal(value)),
    new ExactDecimal(0),
  );
}

function localToday(timeZone: string, nowMilliseconds: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone,
    year: "numeric",
  }).format(new Date(nowMilliseconds));
}

/** Deterministic snapshot of the last N completed local days; no identifiers. */
export function buildAiAnalyzeSnapshot(input: {
  categorySeries: readonly Readonly<{
    categoryKind: "CATEGORY" | "UNCATEGORIZED";
    categoryName: string;
    buckets: readonly Readonly<{ netSalesAmount: string }>[];
  }>[];
  days: readonly Readonly<{
    cost?:
      | Readonly<{
          costCoverage: string;
          grossProfitAmount: Readonly<{ value: string | null }>;
        }>
      | undefined;
    date: string;
    netSalesAmount: string;
    refundAmount: string;
    refundCount: number;
    saleCount: number;
    salesAfterDiscountAmount: string;
  }>[];
  period: AiAnalyzeSnapshotPeriod;
}): AiAnalyzeSnapshot {
  const totalSales = sum(input.days.map((day) => day.netSalesAmount));
  const totalRefunds = sum(input.days.map((day) => day.refundAmount));
  // ANALYTICS.md M-007: AOV = SalesAfterDiscount / SaleCount (refunds excluded).
  const totalSalesAfterDiscount = sum(
    input.days.map((day) => day.salesAfterDiscountAmount),
  );
  const saleCount = input.days.reduce((total, day) => total + day.saleCount, 0);
  const refundCount = input.days.reduce(
    (total, day) => total + day.refundCount,
    0,
  );

  const categoryTotals = new Map<string, InstanceType<typeof ExactDecimal>>();
  for (const series of input.categorySeries) {
    const name =
      series.categoryKind === "UNCATEGORIZED"
        ? "Uncategorized"
        : series.categoryName;
    categoryTotals.set(
      name,
      sum(series.buckets.map((bucket) => bucket.netSalesAmount)).add(
        categoryTotals.get(name) ?? new ExactDecimal(0),
      ),
    );
  }
  const ranked = [...categoryTotals.entries()]
    .sort(([leftName, left], [rightName, right]) => {
      const compared = right.comparedTo(left);
      return compared !== 0 ? compared : leftName.localeCompare(rightName);
    })
    .map(([name, amount]) =>
      Object.freeze({ name, netSalesAmount: amount.toFixed(2) }),
    );
  const top = ranked.slice(0, 5);
  const topNames = new Set(top.map((category) => category.name));
  const bottom = ranked
    .slice(-5)
    .reverse()
    .filter((category) => !topNames.has(category.name));

  const grossProfitValues: string[] = [];
  let costAvailable = true;
  for (const day of input.days) {
    const dayCost = day.cost;
    const grossProfit =
      dayCost?.costCoverage === "complete"
        ? dayCost.grossProfitAmount.value
        : null;
    if (grossProfit === null) {
      costAvailable = false;
      break;
    }
    grossProfitValues.push(grossProfit);
  }
  const grossProfit = costAvailable ? sum(grossProfitValues) : null;
  const cost: AiAnalyzeSnapshot["cost"] =
    grossProfit === null
      ? { costNote: "unavailable" }
      : {
          costCoverage: "complete",
          grossMarginPercent:
            totalSales.isZero() || totalSales.isNegative()
              ? null
              : grossProfit.div(totalSales).mul(100).toFixed(2),
          grossProfitAmount: grossProfit.toFixed(2),
        };

  const ordered = [...input.days].sort((left, right) =>
    decimal(right.netSalesAmount).comparedTo(decimal(left.netSalesAmount)),
  );
  const first = ordered[0];
  const last = ordered.at(-1);

  return Object.freeze({
    bestDay:
      first === undefined
        ? null
        : { date: first.date, netSalesAmount: first.netSalesAmount },
    categories: Object.freeze({ bottom, top }),
    cost,
    days: input.days,
    period: input.period,
    totals: {
      averageOrderValue:
        saleCount === 0
          ? null
          : totalSalesAfterDiscount.div(saleCount).toFixed(2),
      netSalesAmount: totalSales.toFixed(2),
      refundAmount: totalRefunds.toFixed(2),
      refundCount,
      saleCount,
    },
    worstDay:
      last === undefined
        ? null
        : { date: last.date, netSalesAmount: last.netSalesAmount },
  });
}

export function createAiAnalyzeSnapshotBuilder(input: {
  categoryService: Pick<
    ReturnType<typeof createAnalyticsCategoryService>,
    "read"
  >;
  now?: () => number;
  organizationReader: OrganizationReader;
  salesService: Pick<ReturnType<typeof createAnalyticsSalesService>, "read">;
}) {
  return async function readSnapshot(
    request: AiAnalyzeSnapshotRequest,
  ): Promise<AiAnalyzeSnapshotOutcome> {
    const organization = await input.organizationReader.organization.findUnique(
      {
        select: { reportingTimezone: true },
        where: { id: request.organizationId },
      },
    );
    if (organization === null) return { kind: "forbidden" };
    let period: AiAnalyzeSnapshotPeriod;
    try {
      const timezone = validateIanaTimeZone(organization.reportingTimezone);
      const today = Temporal.PlainDate.from(
        localToday(timezone, (input.now ?? Date.now)()),
      );
      const from = today.subtract({ days: request.days });
      period = {
        days: request.days,
        from: from.toString(),
        scope: request.scope.kind,
        timezone,
        to: today.toString(),
      };
    } catch {
      return { kind: "unavailable" };
    }

    const scope =
      request.scope.kind === "organization"
        ? ({ kind: "organization" } as const)
        : ({ branchId: request.scope.branchId, kind: "branch" } as const);
    const selector = {
      actorUserId: request.actorUserId,
      from: period.from,
      granularity: "day" as const,
      organizationId: request.organizationId,
      scope,
      to: period.to,
    };
    const sales = await input.salesService.read(selector);
    if (sales.kind !== "success")
      return sales.kind === "forbidden"
        ? { kind: "forbidden" }
        : { kind: "unavailable" };
    // Ranking needs every category; follow the cursor, bounded.
    const categorySeries: CategorySeries[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < CATEGORY_PAGE_CAP; page += 1) {
      const categories = await input.categoryService.read({
        ...selector,
        ...(cursor === undefined ? {} : { cursor }),
        limit: CATEGORY_PAGE_LIMIT,
      });
      if (categories.kind !== "success")
        return categories.kind === "forbidden"
          ? { kind: "forbidden" }
          : { kind: "unavailable" };
      categorySeries.push(...categories.page.series);
      if (categories.page.nextCursor === null) {
        cursor = undefined;
        break;
      }
      cursor = categories.page.nextCursor;
    }
    // Top/bottom ranking over a partial category list would be wrong.
    if (cursor !== undefined) return { kind: "unavailable" };

    return {
      kind: "ok",
      snapshot: buildAiAnalyzeSnapshot({
        categorySeries: categorySeries.map((series) => ({
          buckets: series.buckets.map((bucket) => ({
            netSalesAmount: bucket.netSalesAmount,
          })),
          categoryKind: series.categoryKind,
          categoryName: series.categoryName,
        })),
        days: sales.metrics.buckets.map((bucket) => ({
          ...(bucket.cost === undefined
            ? {}
            : {
                cost: {
                  costCoverage: bucket.cost.costCoverage,
                  grossProfitAmount: bucket.cost.grossProfitAmount,
                },
              }),
          date: bucket.localStartInclusive,
          netSalesAmount: bucket.netSalesAmount,
          refundAmount: bucket.refundAmount,
          refundCount: bucket.refundCount,
          saleCount: bucket.saleCount,
          salesAfterDiscountAmount: bucket.salesAfterDiscountAmount,
        })),
        period,
      }),
    };
  };
}
