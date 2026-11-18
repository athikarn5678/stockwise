import { describe, expect, it } from "vitest";
import { Prisma, type ProductUnit } from "../../generated/prisma/client.ts";
import {
  buildForecast,
  createForecastWindow,
  REORDER_HORIZON_DAYS,
  type ForecastResult,
} from "./analytics-forecast-values.ts";
import { buildReorder } from "./analytics-reorder-values.ts";

const cutoff = new Date("2026-09-25T05:00:00Z");
const window = createForecastWindow(cutoff, "Asia/Bangkok");
const decimal = (value: string) => new Prisma.Decimal(value);

function forecast(
  unit: ProductUnit = "EA",
  status: "ACTIVE" | "INACTIVE" = "ACTIVE",
  horizonLength?: number,
) {
  return buildForecast({
    organizationId: "org",
    branchId: "branch",
    productId: "product",
    unit,
    productStatus: status,
    generatedAt: cutoff,
    sourceCutoff: cutoff,
    historyStartAt: new Date(window.trainingStartInclusive),
    window:
      horizonLength === undefined
        ? window
        : createForecastWindow(cutoff, "Asia/Bangkok", horizonLength),
    training: Array.from({ length: 28 }, () => decimal("1")),
  });
}

function stock(
  onHand: string,
  ledgerQuantity = onHand,
  invalidSourceCount = 0n,
) {
  return {
    onHand: decimal(onHand),
    ledgerQuantity: decimal(ledgerQuantity),
    invalidSourceCount,
  };
}

describe("Reorder V1 values", () => {
  it.each([
    [undefined, "LEAD_TIME_REQUIRED"],
    [0, "UNSUPPORTED_LEAD_TIME"],
    [-1, "UNSUPPORTED_LEAD_TIME"],
    [1, "UNSUPPORTED_LEAD_TIME"],
    [1.5, "UNSUPPORTED_LEAD_TIME"],
    [6, "UNSUPPORTED_LEAD_TIME"],
    [8, "UNSUPPORTED_LEAD_TIME"],
    [31, "UNSUPPORTED_LEAD_TIME"],
  ] as const)("rejects lead time %s", (leadTimeDays, reason) => {
    const result = buildReorder({
      forecast: forecast(),
      ...(leadTimeDays === undefined ? {} : { leadTimeDays }),
    });
    expect(result).toMatchObject({
      status: "UNAVAILABLE",
      reason,
      leadTimeDemand: null,
      rawNeed: null,
      recommendedQuantity: null,
    });
    expect(result.dailyForecast).toHaveLength(7);
  });

  it("accepts seven and thirty days and sums serialized daily values", () => {
    const base = forecast();
    if (base.status !== "AVAILABLE") throw new Error("fixture");
    const rounded: ForecastResult = {
      ...base,
      days: base.days.map((day) => ({ ...day, quantity: "0.1071" })),
    };
    const thirtyBase = forecast("EA", "ACTIVE", REORDER_HORIZON_DAYS);
    if (thirtyBase.status !== "AVAILABLE") throw new Error("fixture");
    expect(thirtyBase.days).toHaveLength(30);
    const roundedThirty: ForecastResult = {
      ...thirtyBase,
      days: thirtyBase.days.map((day) => ({ ...day, quantity: "0.1071" })),
    };
    const seven = buildReorder({
      forecast: rounded,
      leadTimeDays: 7,
      stock: stock("0"),
    });
    const thirty = buildReorder({
      forecast: roundedThirty,
      leadTimeDays: 30,
      stock: stock("0"),
    });
    expect(seven).toMatchObject({
      status: "AVAILABLE",
      leadTimeDays: 7,
      leadTimeDemand: "0.7497",
      rawNeed: "0.7497",
    });
    expect(thirty).toMatchObject({
      status: "AVAILABLE",
      leadTimeDays: 30,
      leadTimeDemand: "3.2130",
      rawNeed: "3.2130",
      recommendedQuantity: "4.0000",
    });
    expect(seven.sourceCutoff).toBe(cutoff.toISOString());
    expect(seven.dailyForecast).toHaveLength(7);
    expect(thirty.dailyForecast).toHaveLength(7);
    expect(thirty.dailyForecast?.[0]?.localDate).toBe("2026-09-26");
    expect(seven.dailyForecast?.[0]?.localDate).toBe("2026-09-26");
  });

  it("requires a forecast horizon that covers the lead time", () => {
    expect(() =>
      buildReorder({
        forecast: forecast(),
        leadTimeDays: 30,
        stock: stock("0"),
      }),
    ).toThrow(/forecast horizon/);
  });

  it.each([
    ["2", "5.0000"],
    ["1", "6.0000"],
    ["0.9999", "6.0001"],
    ["0", "7.0000"],
  ])("floors demand minus %s on hand", (onHand, rawNeed) => {
    expect(
      buildReorder({
        forecast: forecast("KG"),
        leadTimeDays: 7,
        stock: stock(onHand),
      }),
    ).toMatchObject({
      status: "AVAILABLE",
      rawNeed,
      recommendedQuantity: rawNeed,
    });
  });

  it.each(["EA", "PACK", "BOX"] as const)(
    "ceilings %s and checks the boundary",
    (unit) => {
      const base = forecast(unit);
      if (base.status !== "AVAILABLE") throw new Error("fixture");
      for (const [quantity, expected] of [
        ["0.0000", "0.0000"],
        ["0.0001", "1.0000"],
        ["1.0000", "7.0000"],
        ["1.0001", "8.0000"],
      ] as const) {
        const result = buildReorder({
          forecast: {
            ...base,
            days: base.days.map((day) => ({ ...day, quantity })),
          },
          leadTimeDays: 7,
          stock: stock("0"),
        });
        expect(result.recommendedQuantity).toBe(expected);
      }
    },
  );

  it.each(["KG", "G", "L", "ML", "M", "CM"] as const)(
    "preserves four-place %s",
    (unit) => {
      const base = forecast(unit);
      if (base.status !== "AVAILABLE") throw new Error("fixture");
      const result = buildReorder({
        forecast: {
          ...base,
          days: base.days.map((day) => ({ ...day, quantity: "1.0001" })),
        },
        leadTimeDays: 7,
        stock: stock("0"),
      });
      expect(result).toMatchObject({
        rawNeed: "7.0007",
        recommendedQuantity: "7.0007",
      });
    },
  );

  it("rejects raw and post-ceiling overflow", () => {
    const base = forecast();
    if (base.status !== "AVAILABLE") throw new Error("fixture");
    for (const quantity of ["100000000000000.0000", "99999999999999.0001"]) {
      const result = buildReorder({
        forecast: {
          ...base,
          days: base.days.map((day) => ({ ...day, quantity })),
        },
        leadTimeDays: 7,
        stock: stock("0"),
      });
      expect(result).toMatchObject({
        status: "UNAVAILABLE",
        reason: "QUANTITY_OUT_OF_RANGE",
        rawNeed: null,
        recommendedQuantity: null,
      });
      expect(result.dailyForecast).toHaveLength(7);
    }
  });

  it("keeps forecast reason precedence and leaves derived guidance null", () => {
    const inactive = buildReorder({
      forecast: forecast("EA", "INACTIVE"),
      leadTimeDays: 7,
    });
    const insufficient = buildForecast({
      organizationId: "org",
      branchId: "branch",
      productId: "product",
      unit: "EA",
      productStatus: "ACTIVE",
      generatedAt: cutoff,
      sourceCutoff: cutoff,
      historyStartAt: null,
      window,
      training: Array.from({ length: 28 }, () => decimal("0")),
    });
    expect(inactive).toMatchObject({
      status: "UNAVAILABLE",
      reason: "INACTIVE_PRODUCT",
      dailyForecast: null,
      onHand: null,
    });
    expect(
      buildReorder({ forecast: insufficient, leadTimeDays: 7 }),
    ).toMatchObject({
      status: "UNAVAILABLE",
      reason: "INSUFFICIENT_DATA",
      leadTimeDemand: null,
    });
    expect(
      buildReorder({
        forecast: forecast(),
        leadTimeDays: 7,
        stock: stock("-1"),
      }),
    ).toMatchObject({
      status: "UNAVAILABLE",
      reason: "INVENTORY_INTEGRITY_ERROR",
      onHand: null,
    });
    expect(
      buildReorder({
        forecast: forecast(),
        leadTimeDays: 0,
        stock: stock("-1"),
      }),
    ).toMatchObject({ status: "UNAVAILABLE", reason: "UNSUPPORTED_LEAD_TIME" });
  });

  it("accepts an available zero forecast and versioned output", () => {
    const base = forecast();
    if (base.status !== "AVAILABLE") throw new Error("fixture");
    expect(
      buildReorder({
        forecast: {
          ...base,
          days: base.days.map((day) => ({ ...day, quantity: "0.0000" })),
        },
        leadTimeDays: 7,
        stock: stock("0"),
      }),
    ).toMatchObject({
      status: "AVAILABLE",
      reason: null,
      rawNeed: "0.0000",
      recommendedQuantity: "0.0000",
      reorderVersion: "reorder-v1",
    });
  });

  it.each([stock("1", "0"), stock("1", "1", 1n), stock("1.5", "1.5")])(
    "rejects unreconciled or fractional integer-unit stock",
    (current) => {
      const result = buildReorder({
        forecast: forecast(),
        leadTimeDays: 7,
        stock: current,
      });
      expect(result).toMatchObject({
        status: "UNAVAILABLE",
        reason: "INVENTORY_INTEGRITY_ERROR",
        onHand: null,
      });
      expect(result.dailyForecast).toHaveLength(7);
    },
  );
});
