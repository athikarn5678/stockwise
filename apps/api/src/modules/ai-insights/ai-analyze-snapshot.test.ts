import { describe, expect, it, vi } from "vitest";

import {
  buildAiAnalyzeSnapshot,
  createAiAnalyzeSnapshotBuilder,
  type AiAnalyzeSnapshotPeriod,
} from "./ai-analyze-snapshot.ts";

const period: AiAnalyzeSnapshotPeriod = {
  days: 3,
  from: "2026-11-10",
  scope: "branch",
  timezone: "Asia/Bangkok",
  to: "2026-11-13",
};

function day(
  date: string,
  netSalesAmount: string,
  options: {
    cost?: string | null;
    refundAmount?: string;
    refundCount?: number;
    saleCount?: number;
    salesAfterDiscountAmount?: string;
  } = {},
) {
  const grossProfit = options.cost;
  return {
    ...(grossProfit === undefined
      ? {}
      : {
          cost: {
            costCoverage: grossProfit === null ? "partial" : "complete",
            grossProfitAmount: { value: grossProfit },
          },
        }),
    date,
    netSalesAmount,
    refundAmount: options.refundAmount ?? "0.00",
    refundCount: options.refundCount ?? 0,
    saleCount: options.saleCount ?? 1,
    salesAfterDiscountAmount:
      options.salesAfterDiscountAmount ?? netSalesAmount,
  };
}

describe("AI analyze snapshot", () => {
  it("computes exact totals, ranking, and extremes deterministically", () => {
    const snapshot = buildAiAnalyzeSnapshot({
      categorySeries: [
        {
          buckets: [{ netSalesAmount: "10.10" }, { netSalesAmount: "0.20" }],
          categoryKind: "CATEGORY",
          categoryName: "Drinks",
        },
        {
          buckets: [{ netSalesAmount: "100.05" }, { netSalesAmount: "9.95" }],
          categoryKind: "CATEGORY",
          categoryName: "Food",
        },
        {
          buckets: [{ netSalesAmount: "1.00" }, { netSalesAmount: "0.00" }],
          categoryKind: "UNCATEGORIZED",
          categoryName: "UNCATEGORIZED",
        },
      ],
      days: [
        day("2026-11-10", "100.05", { saleCount: 2 }),
        day("2026-11-11", "9.95", {
          refundAmount: "5.10",
          refundCount: 1,
          saleCount: 3,
          salesAfterDiscountAmount: "15.05",
        }),
        day("2026-11-12", "1.30", { saleCount: 2 }),
      ],
      period,
    });

    expect(snapshot.totals).toEqual({
      averageOrderValue: "16.63",
      netSalesAmount: "111.30",
      refundAmount: "5.10",
      refundCount: 1,
      saleCount: 7,
    });
    expect(snapshot.categories.top).toEqual([
      { name: "Food", netSalesAmount: "110.00" },
      { name: "Drinks", netSalesAmount: "10.30" },
      { name: "Uncategorized", netSalesAmount: "1.00" },
    ]);
    expect(snapshot.categories.bottom).toEqual([]);
    expect(snapshot.bestDay).toEqual({
      date: "2026-11-10",
      netSalesAmount: "100.05",
    });
    expect(snapshot.worstDay).toEqual({
      date: "2026-11-12",
      netSalesAmount: "1.30",
    });
    expect(snapshot.cost).toEqual({ costNote: "unavailable" });
  });

  it("supports a null average and complete cost data without floats", () => {
    const snapshot = buildAiAnalyzeSnapshot({
      categorySeries: [],
      days: [
        day("2026-11-10", "0.00", { cost: "0.00", saleCount: 0 }),
        day("2026-11-11", "300.00", { cost: "100.00", saleCount: 1 }),
      ],
      period,
    });

    expect(snapshot.totals.averageOrderValue).toBe("300.00");
    expect(snapshot.cost).toEqual({
      costCoverage: "complete",
      grossMarginPercent: "33.33",
      grossProfitAmount: "100.00",
    });
    expect(
      buildAiAnalyzeSnapshot({
        categorySeries: [],
        days: [
          day("2026-11-10", "0.00", { cost: "0.00", saleCount: 0 }),
          day("2026-11-11", "0.00", { cost: "0.00", saleCount: 0 }),
        ],
        period,
      }).totals.averageOrderValue,
    ).toBeNull();
    expect(
      buildAiAnalyzeSnapshot({
        categorySeries: [],
        days: [
          day("2026-11-10", "10.00", { cost: null }),
          day("2026-11-11", "20.00", { cost: "5.00" }),
        ],
        period,
      }).cost,
    ).toEqual({ costNote: "unavailable" });
  });
});

describe("AI analyze snapshot builder", () => {
  function builder(pages: readonly (string | null)[]) {
    const read = vi.fn(async (request: { cursor?: string }) => {
      const index = request.cursor === undefined ? 0 : Number(request.cursor);
      return {
        kind: "success" as const,
        page: {
          nextCursor: pages[index] ?? null,
          series: [
            {
              buckets: [{ netSalesAmount: String(index + 1) + ".00" }],
              categoryKind: "CATEGORY" as const,
              categoryName: `Category ${index}`,
            },
          ],
        },
      };
    });
    const sales = {
      read: vi.fn(async () => ({
        kind: "success" as const,
        metrics: {
          buckets: [
            {
              cost: undefined,
              localStartInclusive: "2026-11-10",
              netSalesAmount: "5.00",
              refundAmount: "0.00",
              refundCount: 0,
              saleCount: 1,
              salesAfterDiscountAmount: "5.00",
            },
          ],
        },
      })),
    };
    return {
      read,
      run: createAiAnalyzeSnapshotBuilder({
        // The builder only calls `read`; the fakes return the shapes it reads.
        categoryService: { read } as never,
        now: () => Date.parse("2026-11-17T05:00:00Z"),
        organizationReader: {
          organization: {
            findUnique: async () => ({ reportingTimezone: "Asia/Bangkok" }),
          },
        } as never,
        salesService: sales as never,
      }),
    };
  }
  const request = {
    actorUserId: "u",
    days: 7,
    organizationId: "o",
    scope: { kind: "organization" },
  } as const;

  it("follows the category cursor so ranking uses every category", async () => {
    const { read, run } = builder(["1", "2", null]);
    const outcome = await run(request);
    expect(read).toHaveBeenCalledTimes(3);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok")
      expect(outcome.snapshot.categories.top[0]).toEqual({
        name: "Category 2",
        netSalesAmount: "3.00",
      });
  });

  it("is unavailable instead of ranking a truncated category list", async () => {
    const { run } = builder(
      Array.from({ length: 20 }, (_, i) => String(i + 1)),
    );
    expect(await run(request)).toEqual({ kind: "unavailable" });
  });
});
