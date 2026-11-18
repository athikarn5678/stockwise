import { describe, expect, it } from "vitest";

import type { AnalyticsProductFactRow } from "../analytics/analytics-product-facts-repository.ts";
import {
  buildAiAnalyzeProductFacts,
  EMPTY_PRODUCT_FACTS,
  LOW_STOCK_COVER_DAYS,
} from "./ai-analyze-product-facts.ts";

function row(
  name: string,
  overrides: Partial<Omit<AnalyticsProductFactRow, "name">> = {},
): AnalyticsProductFactRow {
  return {
    name,
    netQuantity: "0",
    netSalesAmount: "0.00",
    onHandQuantity: null,
    status: "ACTIVE",
    ...overrides,
  };
}

function facts(rows: readonly AnalyticsProductFactRow[], days = 7) {
  return buildAiAnalyzeProductFacts({ days, rows });
}

describe("AI analyze product facts", () => {
  it("ranks top and slowest products by quantity and net sales, ties by name", () => {
    const result = facts([
      row("Apple", { netQuantity: "5", netSalesAmount: "50.00" }),
      row("Banana", { netQuantity: "3", netSalesAmount: "30.00" }),
      row("Cherry", { netQuantity: "3", netSalesAmount: "30.00" }),
      row("Date", { netQuantity: "2", netSalesAmount: "900.00" }),
      row("Fig", { netQuantity: "4", netSalesAmount: "4.00" }),
      row("Elderberry", { netQuantity: "1", netSalesAmount: "5.00" }),
      row("Grape", { netQuantity: "1", netSalesAmount: "1.00" }),
    ]);

    expect(result.soldProductCount).toBe(7);
    expect(result.topByQuantity.map((item) => item.name)).toEqual([
      "Apple",
      "Fig",
      "Banana",
      "Cherry",
      "Date",
    ]);
    expect(result.topByQuantity[0]).toEqual({
      name: "Apple",
      netSalesAmount: "50.00",
      quantity: "5",
    });
    // Quantity ties and net-sales ties both fall back to the product name.
    expect(result.topByQuantity[2]?.name).toBe("Banana");
    expect(result.topByNetSales.map((item) => item.name)).toEqual([
      "Date",
      "Apple",
      "Banana",
      "Cherry",
      "Elderberry",
    ]);
    // Slowest lists never repeat a product from the matching top list, and are
    // ranked ascending.
    expect(result.slowestByQuantity.map((item) => item.name)).toEqual([
      "Elderberry",
      "Grape",
    ]);
    expect(result.slowestByNetSales.map((item) => item.name)).toEqual([
      "Grape",
      "Fig",
    ]);
  });

  it("treats refunded and non-positive net quantities as unsold", () => {
    const result = facts([
      row("Fully returned", {
        netQuantity: "-2",
        netSalesAmount: "-20.00",
        onHandQuantity: "0",
      }),
      row("Net zero", {
        netQuantity: "0",
        netSalesAmount: "-10.00",
        onHandQuantity: "5",
      }),
      row("Partly returned", { netQuantity: "1", netSalesAmount: "5.00" }),
      row("Never stocked", { netQuantity: "0", netSalesAmount: "0.00" }),
    ]);

    expect(result.soldProductCount).toBe(1);
    expect(result.topByQuantity).toEqual([
      { name: "Partly returned", netSalesAmount: "5.00", quantity: "1" },
    ]);
    expect(result.topByNetSales).toEqual(result.topByQuantity);
    expect(result.slowestByQuantity).toEqual([]);
    expect(result.slowestByNetSales).toEqual([]);
    // A refunded product with a balance still counts as stocked-but-unsold.
    expect(result.noSales).toEqual({
      count: 2,
      names: ["Fully returned", "Net zero"],
    });
  });

  it("lists only active, stocked products in the no-sales list", () => {
    const result = facts([
      row("Active stocked", { onHandQuantity: "0" }),
      row("Active stocked high", { onHandQuantity: "9" }),
      row("Inactive stocked", { onHandQuantity: "5", status: "INACTIVE" }),
      row("Never stocked"),
      row("Sold one", {
        netQuantity: "1",
        netSalesAmount: "1.00",
        onHandQuantity: "2",
      }),
    ]);

    // A null on-hand means "never stocked in this scope", not "zero on hand".
    expect(result.noSales).toEqual({
      count: 2,
      names: ["Active stocked", "Active stocked high"],
    });
  });

  it("separates out-of-stock from low-stock on the exact 7-day boundary", () => {
    const rows = [
      row("Boundary", {
        netQuantity: "14",
        netSalesAmount: "140.00",
        onHandQuantity: "14",
      }),
      row("Just above", {
        netQuantity: "14",
        netSalesAmount: "140.00",
        onHandQuantity: "14.02",
      }),
      row("Small exact", {
        netQuantity: "0.7",
        netSalesAmount: "0.70",
        onHandQuantity: "0.3",
      }),
      row("Cover three", {
        netQuantity: "7",
        netSalesAmount: "70.00",
        onHandQuantity: "6",
      }),
      row("No sales stocked", { onHandQuantity: "5" }),
      row("Out one", {
        netQuantity: "3",
        netSalesAmount: "9.00",
        onHandQuantity: "0",
      }),
      row("Out negative", {
        netQuantity: "1",
        netSalesAmount: "9.00",
        onHandQuantity: "-2",
      }),
      row("Out unsold", { onHandQuantity: "0" }),
    ];
    const result = facts(rows);

    expect(result.lowStock.coverDaysThreshold).toBe(7);
    // 14 / (14/7) is exactly 14/2 = 7, so the boundary is included; 7.01 is not.
    expect(result.lowStock.items.map((item) => item.name)).toEqual([
      "Small exact",
      "Cover three",
      "Boundary",
    ]);
    expect(result.lowStock.count).toBe(3);
    expect(result.lowStock.items[2]).toEqual({
      daysOfCover: "7.00",
      name: "Boundary",
      onHandQuantity: "14",
      quantitySoldInPeriod: "14",
    });
    // 0.3 / (0.7/7) stays exact: a fraction of a unit covers three days.
    expect(result.lowStock.items[0]).toEqual({
      daysOfCover: "3.00",
      name: "Small exact",
      onHandQuantity: "0.3",
      quantitySoldInPeriod: "0.7",
    });
    expect(result.lowStock.items[1]?.daysOfCover).toBe("6.00");
    expect(result.lowStock.items.map((item) => item.name)).not.toContain(
      "Just above",
    );
    // A stocked product with no sales has no pace, so it is not low stock.
    expect(result.lowStock.items.map((item) => item.name)).not.toContain(
      "No sales stocked",
    );
    expect(result.outOfStock.count).toBe(3);
    expect(result.outOfStock.items.map((item) => item.name)).toEqual([
      "Out one",
      "Out negative",
      "Out unsold",
    ]);
    expect(result.outOfStock.items[0]).toEqual({
      daysOfCover: null,
      name: "Out one",
      onHandQuantity: "0",
      quantitySoldInPeriod: "3",
    });
    expect(result.outOfStock.items[1]?.onHandQuantity).toBe("-2");
    expect(result.noSales.names).toEqual(["No sales stocked", "Out unsold"]);
  });

  it("prints decimal quantities without trailing zeros or float artifacts", () => {
    const result = facts(
      [
        row("Half unit", {
          netQuantity: "0.5000",
          netSalesAmount: "1.00",
          onHandQuantity: "0.3000",
        }),
        row("Tenth unit", {
          netQuantity: "0.1000",
          netSalesAmount: "0.30",
        }),
      ],
      3,
    );

    expect(result.topByQuantity).toEqual([
      { name: "Half unit", netSalesAmount: "1.00", quantity: "0.5" },
      { name: "Tenth unit", netSalesAmount: "0.30", quantity: "0.1" },
    ]);
    expect(result.lowStock.count).toBe(1);
    expect(result.lowStock.items).toEqual([
      {
        daysOfCover: "1.80",
        name: "Half unit",
        onHandQuantity: "0.3",
        quantitySoldInPeriod: "0.5",
      },
    ]);
    expect(result.noSales).toEqual({ count: 0, names: [] });
  });

  it("caps ranked lists at five and stock/name lists at ten while counting all", () => {
    const sold = facts(
      Array.from({ length: 12 }, (_, index) =>
        row(`T${String(index + 1).padStart(2, "0")}`, {
          netQuantity: String(index + 1),
          netSalesAmount: `${(index + 1) * 10}.00`,
        }),
      ),
    );
    expect(sold.soldProductCount).toBe(12);
    expect(sold.topByQuantity.map((item) => item.name)).toEqual([
      "T12",
      "T11",
      "T10",
      "T09",
      "T08",
    ]);
    expect(sold.slowestByQuantity.map((item) => item.name)).toEqual([
      "T01",
      "T02",
      "T03",
      "T04",
      "T05",
    ]);

    const unsold = facts(
      Array.from({ length: 12 }, (_, index) =>
        row(`N${String(index + 1).padStart(2, "0")}`, { onHandQuantity: "5" }),
      ),
    );
    expect(unsold.noSales.count).toBe(12);
    expect(unsold.noSales.names).toHaveLength(10);
    expect(unsold.noSales.names[0]).toBe("N01");
    expect(unsold.noSales.names.at(-1)).toBe("N10");

    const outOfStock = facts(
      Array.from({ length: 12 }, (_, index) =>
        row(`S${String(index + 1).padStart(2, "0")}`, {
          onHandQuantity: "0",
        }),
      ),
    );
    expect(outOfStock.outOfStock.count).toBe(12);
    expect(outOfStock.outOfStock.items).toHaveLength(10);
    expect(outOfStock.outOfStock.items[0]?.name).toBe("S01");

    const lowStock = facts(
      Array.from({ length: 12 }, (_, index) =>
        row(`L${String(index + 1).padStart(2, "0")}`, {
          netQuantity: "14",
          netSalesAmount: "14.00",
          onHandQuantity: String(index + 1),
        }),
      ),
    );
    expect(lowStock.lowStock.count).toBe(12);
    expect(lowStock.lowStock.items).toHaveLength(10);
    expect(lowStock.lowStock.items[0]).toMatchObject({
      daysOfCover: "0.50",
      name: "L01",
    });
    expect(lowStock.lowStock.items.at(-1)).toMatchObject({
      daysOfCover: "5.00",
      name: "L10",
    });
  });

  it("returns empty facts for an empty product list", () => {
    const result = facts([]);
    expect(result).toEqual(EMPTY_PRODUCT_FACTS);
    expect(result).toEqual({
      lowStock: { count: 0, coverDaysThreshold: 7, items: [] },
      noSales: { count: 0, names: [] },
      outOfStock: { count: 0, items: [] },
      slowestByNetSales: [],
      slowestByQuantity: [],
      soldProductCount: 0,
      topByNetSales: [],
      topByQuantity: [],
    });
    expect(LOW_STOCK_COVER_DAYS).toBe(7);
  });
});
