import { describe, expect, it } from "vitest";

import {
  buildAiAnalyzeSnapshot,
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
        }),
        day("2026-11-12", "1.30", { saleCount: 2 }),
      ],
      period,
    });

    expect(snapshot.totals).toEqual({
      averageOrderValue: "15.90",
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
