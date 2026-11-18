import { describe, expect, it } from "vitest";

import { Prisma, type ProductUnit } from "../../generated/prisma/client.ts";
import {
  backtestForecast,
  buildForecast,
  createForecastWindow,
  meanDailyForecast,
  REORDER_HORIZON_DAYS,
  summarizeForecastBacktests,
} from "./analytics-forecast-values.ts";

const decimal = (value: string) => new Prisma.Decimal(value);
const cutoff = new Date("2026-09-25T05:00:00.000Z");
const window = createForecastWindow(cutoff, "Asia/Bangkok");

function forecast(
  input: {
    training?: readonly Prisma.Decimal[];
    historyStartAt?: Date | null;
    productStatus?: "ACTIVE" | "INACTIVE";
    unit?: ProductUnit;
  } = {},
) {
  return buildForecast({
    organizationId: "org",
    branchId: "branch",
    productId: "product",
    unit: input.unit ?? "EA",
    productStatus: input.productStatus ?? "ACTIVE",
    generatedAt: cutoff,
    sourceCutoff: cutoff,
    historyStartAt:
      input.historyStartAt === undefined
        ? new Date(window.trainingStartInclusive)
        : input.historyStartAt,
    window,
    training: input.training ?? Array.from({ length: 28 }, () => decimal("0")),
  });
}

describe("forecast-sale-mean-28d-v1 values", () => {
  it("uses 28 complete days and seven local forecast days, with a partial-day gap", () => {
    expect(window.trainingDays).toHaveLength(28);
    expect(window.trainingEndExclusive).toBe("2026-09-24T17:00:00.000Z");
    expect(window.horizonDays).toHaveLength(7);
    expect(window.horizonStartInclusive).toBe("2026-09-25T17:00:00.000Z");
    expect(
      createForecastWindow(new Date("2026-09-24T17:00:00.000Z"), "Asia/Bangkok")
        .horizonStartInclusive,
    ).toBe("2026-09-24T17:00:00.000Z");
  });

  it("honors 23-hour and 25-hour DST days", () => {
    const spring = createForecastWindow(
      new Date("2026-03-10T17:00:00.000Z"),
      "America/New_York",
    );
    const fall = createForecastWindow(
      new Date("2026-11-03T17:00:00.000Z"),
      "America/New_York",
    );
    const springDay = spring.trainingDays.find(
      (day) => day.localDate === "2026-03-08",
    )!;
    const fallDay = fall.trainingDays.find(
      (day) => day.localDate === "2026-11-01",
    )!;
    expect(
      new Date(springDay.bucketEndExclusive).getTime() -
        new Date(springDay.bucketStartInclusive).getTime(),
    ).toBe(23 * 60 * 60 * 1000);
    expect(
      new Date(fallDay.bucketEndExclusive).getTime() -
        new Date(fallDay.bucketStartInclusive).getTime(),
    ).toBe(25 * 60 * 60 * 1000);
  });

  it("builds a contiguous 30-day horizon with the same daily bounds", () => {
    const thirty = createForecastWindow(
      new Date("2026-09-25T05:00:00.000Z"),
      "Asia/Bangkok",
      REORDER_HORIZON_DAYS,
    );
    expect(thirty.trainingDays).toHaveLength(28);
    expect(thirty.horizonDays).toHaveLength(30);
    expect(thirty.horizonDays[0]?.localDate).toBe("2026-09-26");
    expect(thirty.horizonDays[29]?.localDate).toBe("2026-10-25");
    expect(thirty.horizonStartInclusive).toBe("2026-09-25T17:00:00.000Z");
    expect(thirty.horizonEndExclusive).toBe("2026-10-25T17:00:00.000Z");
    expect(thirty.horizonEndExclusive).toBe(
      thirty.horizonDays[29]?.bucketEndExclusive,
    );
    for (const [index, day] of thirty.horizonDays.entries()) {
      expect(
        new Date(day.bucketEndExclusive).getTime() -
          new Date(day.bucketStartInclusive).getTime(),
      ).toBe(24 * 60 * 60 * 1000);
      if (index > 0)
        expect(day.bucketStartInclusive).toBe(
          thirty.horizonDays[index - 1]?.bucketEndExclusive,
        );
    }
  });

  it("keeps a 30-day horizon contiguous across both DST transitions", () => {
    const spring = createForecastWindow(
      new Date("2026-03-01T05:00:00.000Z"),
      "America/New_York",
      REORDER_HORIZON_DAYS,
    );
    const fall = createForecastWindow(
      new Date("2026-10-20T04:00:00.000Z"),
      "America/New_York",
      REORDER_HORIZON_DAYS,
    );
    for (const window of [spring, fall]) {
      expect(window.horizonDays).toHaveLength(30);
      expect(window.horizonEndExclusive).toBe(
        window.horizonDays[29]?.bucketEndExclusive,
      );
      for (const [index, day] of window.horizonDays.entries()) {
        if (index > 0)
          expect(day.bucketStartInclusive).toBe(
            window.horizonDays[index - 1]?.bucketEndExclusive,
          );
      }
    }
    const springDay = spring.horizonDays.find(
      (day) => day.localDate === "2026-03-08",
    )!;
    const fallDay = fall.horizonDays.find(
      (day) => day.localDate === "2026-11-01",
    )!;
    expect(
      new Date(springDay.bucketEndExclusive).getTime() -
        new Date(springDay.bucketStartInclusive).getTime(),
    ).toBe(23 * 60 * 60 * 1000);
    expect(
      new Date(fallDay.bucketEndExclusive).getTime() -
        new Date(fallDay.bucketStartInclusive).getTime(),
    ).toBe(25 * 60 * 60 * 1000);
    expect(
      new Date(fall.horizonEndExclusive).getTime() -
        new Date(fall.horizonStartInclusive).getTime(),
    ).toBe(30 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000);
  });

  it("rejects a non-positive forecast horizon", () => {
    expect(() => createForecastWindow(cutoff, "Asia/Bangkok", 0)).toThrow();
    expect(() => createForecastWindow(cutoff, "Asia/Bangkok", 7.5)).toThrow();
  });

  it("uses exact Decimal mean, HALF_UP daily rounding, and sum of rounded days", () => {
    const training = [
      decimal("1"),
      ...Array.from({ length: 27 }, () => decimal("0")),
    ];
    expect(meanDailyForecast(training)).toBe("0.0357");
    const result = forecast({ training });
    expect(result).toMatchObject({
      forecastVersion: "forecast-sale-mean-28d-v1",
      unit: "EA",
      status: "AVAILABLE",
      reason: null,
      horizonTotal: "0.2499",
    });
    if (result.status !== "AVAILABLE")
      throw new Error("Expected available forecast.");
    expect(result.days).toHaveLength(7);
    expect(result.days.every((day) => day.quantity === "0.0357")).toBe(true);
    expect(
      new Prisma.Decimal(1).div(28).times(7).toDecimalPlaces(4).toFixed(4),
    ).toBe("0.2500");
    expect(
      meanDailyForecast([
        decimal("0.0014"),
        ...Array.from({ length: 27 }, () => decimal("0")),
      ]),
    ).toBe("0.0001");
  });

  it("repeats the same 28-day mean over a 30-day horizon without changing the 7-day default", () => {
    const thirtyWindow = createForecastWindow(
      cutoff,
      "Asia/Bangkok",
      REORDER_HORIZON_DAYS,
    );
    const training = [
      decimal("1"),
      ...Array.from({ length: 27 }, () => decimal("0")),
    ];
    const thirty = buildForecast({
      organizationId: "org",
      branchId: "branch",
      productId: "product",
      unit: "EA",
      productStatus: "ACTIVE",
      generatedAt: cutoff,
      sourceCutoff: cutoff,
      historyStartAt: new Date(thirtyWindow.trainingStartInclusive),
      window: thirtyWindow,
      training,
    });
    expect(thirty).toMatchObject({
      status: "AVAILABLE",
      horizonDays: 30,
      horizonStartInclusive: "2026-09-25T17:00:00.000Z",
      horizonEndExclusive: "2026-10-25T17:00:00.000Z",
      horizonTotal: "1.0710",
    });
    if (thirty.status !== "AVAILABLE") throw new Error("fixture");
    expect(thirty.days).toHaveLength(30);
    expect(thirty.days.every((day) => day.quantity === "0.0357")).toBe(true);
    const seven = forecast({ training });
    expect(seven).toMatchObject({ horizonDays: 7, horizonTotal: "0.2499" });
    if (seven.status !== "AVAILABLE") throw new Error("fixture");
    expect(seven.days).toHaveLength(7);
    expect(thirty.days.slice(0, 7)).toEqual(seven.days);
  });

  it("keeps zero history available and integral units as decimal expectations", () => {
    expect(forecast()).toMatchObject({
      status: "AVAILABLE",
      horizonTotal: "0.0000",
    });
    const result = forecast({
      training: [
        decimal("40"),
        ...Array.from({ length: 27 }, () => decimal("0")),
      ],
      unit: "PACK",
    });
    expect(result.status).toBe("AVAILABLE");
    if (result.status === "AVAILABLE")
      expect(result.days[0]?.quantity).toBe("1.4286");
  });

  it("returns accepted unavailable shape and inactive precedence", () => {
    const missing = forecast({ historyStartAt: null });
    expect(missing).toMatchObject({
      status: "UNAVAILABLE",
      reason: "INSUFFICIENT_DATA",
      days: [],
      horizonTotal: null,
    });
    expect(missing.trainingStartInclusive).toBe(window.trainingStartInclusive);
    expect(forecast({ historyStartAt: new Date(cutoff) })).toMatchObject({
      status: "UNAVAILABLE",
      reason: "INSUFFICIENT_DATA",
    });
    expect(
      forecast({ historyStartAt: null, productStatus: "INACTIVE" }),
    ).toMatchObject({
      status: "UNAVAILABLE",
      reason: "INACTIVE_PRODUCT",
      days: [],
      horizonTotal: null,
    });
  });
});

describe("four-origin forecast backtest", () => {
  it("evaluates four non-overlapping seven-day windows against last-day-naive", () => {
    const actuals = Array.from({ length: 56 }, (_, index) =>
      decimal(index < 28 ? "0" : "1"),
    );
    const result = backtestForecast({
      actuals,
      historyEligibleAtFirstOrigin: true,
    });
    expect(result.status).toBe("AVAILABLE");
    if (result.status !== "AVAILABLE")
      throw new Error("Expected evaluable history.");
    expect(result.origins).toEqual([28, 35, 42, 49]);
    expect(result.forecastAbsoluteErrors).toHaveLength(28);
    expect(result.referenceAbsoluteErrors).toHaveLength(28);
    expect(result.forecastMae).toBe("0.6250");
    expect(result.referenceMae).toBe("0.2500");
    expect(result.forecastAbsoluteErrors.slice(0, 7)).toEqual(
      Array(7).fill("1.0000"),
    );
    expect(result.forecastAbsoluteErrors.slice(7, 14)).toEqual(
      Array(7).fill("0.7500"),
    );
  });

  it("excludes incomplete history and never uses an origin's evaluation days in its training", () => {
    expect(
      backtestForecast({
        actuals: Array(55).fill(decimal("0")),
        historyEligibleAtFirstOrigin: true,
      }),
    ).toEqual({
      status: "UNAVAILABLE",
      reason: "INSUFFICIENT_EVALUATION_HISTORY",
    });
    expect(
      backtestForecast({
        actuals: Array(56).fill(decimal("0")),
        historyEligibleAtFirstOrigin: false,
      }),
    ).toEqual({
      status: "UNAVAILABLE",
      reason: "INSUFFICIENT_EVALUATION_HISTORY",
    });
    const actuals = Array.from({ length: 56 }, (_, index) =>
      decimal(index === 28 ? "28" : "0"),
    );
    const result = backtestForecast({
      actuals,
      historyEligibleAtFirstOrigin: true,
    });
    if (result.status !== "AVAILABLE")
      throw new Error("Expected evaluable history.");
    expect(result.forecastAbsoluteErrors[0]).toBe("28.0000");
    expect(result.forecastAbsoluteErrors[7]).toBe("1.0000");
    expect(result.referenceAbsoluteErrors[7]).toBe("0.0000");
    const lastDaySpike = Array.from({ length: 56 }, (_, index) =>
      decimal(index === 34 ? "28" : "0"),
    );
    const reference = backtestForecast({
      actuals: lastDaySpike,
      historyEligibleAtFirstOrigin: true,
    });
    if (reference.status !== "AVAILABLE")
      throw new Error("Expected evaluable history.");
    expect(reference.referenceAbsoluteErrors[7]).toBe("28.0000");
  });

  it("reports pair exclusions and unit-separated MAE distributions without mixing units", () => {
    const zeroes = Array.from({ length: 56 }, () => decimal("0"));
    const summary = summarizeForecastBacktests([
      {
        branchId: "a",
        productId: "ea",
        unit: "EA",
        actuals: zeroes,
        historyEligibleAtFirstOrigin: true,
      },
      {
        branchId: "b",
        productId: "ea",
        unit: "EA",
        actuals: zeroes.slice(1),
        historyEligibleAtFirstOrigin: true,
      },
      {
        branchId: "a",
        productId: "kg",
        unit: "KG",
        actuals: zeroes,
        historyEligibleAtFirstOrigin: true,
      },
    ]);
    expect(summary.eligiblePairCount).toBe(2);
    expect(summary.excludedPairCount).toBe(1);
    expect(summary.byUnit).toEqual([
      {
        unit: "EA",
        eligibleCount: 1,
        excludedCount: 1,
        forecastMae: ["0.0000"],
        referenceMae: ["0.0000"],
        zeroActualDayCounts: [28],
      },
      {
        unit: "KG",
        eligibleCount: 1,
        excludedCount: 0,
        forecastMae: ["0.0000"],
        referenceMae: ["0.0000"],
        zeroActualDayCounts: [28],
      },
    ]);
  });
});
