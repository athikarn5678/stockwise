import { Temporal } from "@js-temporal/polyfill";

import { Prisma, type ProductUnit } from "../../generated/prisma/client.ts";
import { localDateToUtcBoundary } from "./analytics-period.ts";

const Decimal = Prisma.Decimal.clone({ precision: 80, rounding: 4 });
const ZERO = new Decimal(0);
export const FORECAST_VERSION = "forecast-sale-mean-28d-v1" as const;
export const FORECAST_REFERENCE_VERSION = "last-day-naive" as const;
/** The published forecast endpoint and its chart stay at seven days. */
export const FORECAST_HORIZON_DAYS = 7 as const;
/** Reorder needs a longer horizon to cover its 30-day planning lead time. */
export const REORDER_HORIZON_DAYS = 30 as const;

export interface ForecastDayBounds {
  localDate: string;
  bucketStartInclusive: string;
  bucketEndExclusive: string;
}

export interface ForecastWindow {
  reportingTimezone: string;
  trainingStartInclusive: string;
  trainingEndExclusive: string;
  horizonStartInclusive: string;
  horizonEndExclusive: string;
  trainingDays: readonly ForecastDayBounds[];
  horizonDays: readonly ForecastDayBounds[];
}

export type ForecastDay = ForecastDayBounds & Readonly<{ quantity: string }>;

interface ForecastContext {
  organizationId: string;
  branchId: string;
  productId: string;
  unit: ProductUnit;
  forecastVersion: typeof FORECAST_VERSION;
  generatedAt: string;
  sourceCutoff: string;
  reportingTimezone: string;
  trainingStartInclusive: string;
  trainingEndExclusive: string;
  historyStartAt: string | null;
  horizonDays: number;
  horizonStartInclusive: string;
  horizonEndExclusive: string;
}

export type ForecastResult =
  | Readonly<
      ForecastContext & {
        status: "AVAILABLE";
        reason: null;
        days: readonly ForecastDay[];
        horizonTotal: string;
      }
    >
  | Readonly<
      ForecastContext & {
        status: "UNAVAILABLE";
        reason: "INSUFFICIENT_DATA" | "INACTIVE_PRODUCT";
        days: readonly [];
        horizonTotal: null;
      }
    >;

function dayBounds(
  date: Temporal.PlainDate,
  timezone: string,
): ForecastDayBounds {
  return {
    localDate: date.toString(),
    bucketStartInclusive: localDateToUtcBoundary(
      date.toString(),
      timezone,
    ).toISOString(),
    bucketEndExclusive: localDateToUtcBoundary(
      date.add({ days: 1 }).toString(),
      timezone,
    ).toISOString(),
  };
}

export function createForecastWindow(
  sourceCutoff: Date,
  reportingTimezone: string,
  horizonLength: number = FORECAST_HORIZON_DAYS,
): ForecastWindow {
  if (!Number.isInteger(horizonLength) || horizonLength < 1)
    throw new Error("Forecast horizon must be a positive whole day count.");
  const localDay = Temporal.Instant.fromEpochMilliseconds(
    sourceCutoff.getTime(),
  )
    .toZonedDateTimeISO(reportingTimezone)
    .toPlainDate();
  const currentMidnight = localDateToUtcBoundary(
    localDay.toString(),
    reportingTimezone,
  );
  const horizonStart =
    currentMidnight.getTime() === sourceCutoff.getTime()
      ? localDay
      : localDay.add({ days: 1 });
  const trainingStart = localDay.subtract({ days: 28 });
  const trainingDays = Array.from({ length: 28 }, (_, index) =>
    dayBounds(trainingStart.add({ days: index }), reportingTimezone),
  );
  const horizonDays = Array.from({ length: horizonLength }, (_, index) =>
    dayBounds(horizonStart.add({ days: index }), reportingTimezone),
  );
  return {
    reportingTimezone,
    trainingStartInclusive: trainingDays[0]!.bucketStartInclusive,
    trainingEndExclusive: currentMidnight.toISOString(),
    horizonStartInclusive: horizonDays[0]!.bucketStartInclusive,
    horizonEndExclusive:
      horizonDays[horizonDays.length - 1]!.bucketEndExclusive,
    trainingDays,
    horizonDays,
  };
}

export function meanDailyForecast(training: readonly Prisma.Decimal[]): string {
  if (training.length !== 28)
    throw new Error("Forecast requires 28 complete local days.");
  const total = training.reduce((sum, value) => sum.plus(value), ZERO);
  return total.div(28).toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4);
}

export function buildForecast(input: {
  organizationId: string;
  branchId: string;
  productId: string;
  unit: ProductUnit;
  productStatus: "ACTIVE" | "INACTIVE";
  generatedAt: Date;
  sourceCutoff: Date;
  historyStartAt: Date | null;
  window: ForecastWindow;
  training: readonly Prisma.Decimal[];
}): ForecastResult {
  const context: ForecastContext = {
    organizationId: input.organizationId,
    branchId: input.branchId,
    productId: input.productId,
    unit: input.unit,
    forecastVersion: FORECAST_VERSION,
    generatedAt: input.generatedAt.toISOString(),
    sourceCutoff: input.sourceCutoff.toISOString(),
    reportingTimezone: input.window.reportingTimezone,
    trainingStartInclusive: input.window.trainingStartInclusive,
    trainingEndExclusive: input.window.trainingEndExclusive,
    historyStartAt: input.historyStartAt?.toISOString() ?? null,
    horizonDays: input.window.horizonDays.length,
    horizonStartInclusive: input.window.horizonStartInclusive,
    horizonEndExclusive: input.window.horizonEndExclusive,
  };
  const reason =
    input.productStatus === "INACTIVE"
      ? "INACTIVE_PRODUCT"
      : input.historyStartAt === null ||
          input.historyStartAt.getTime() >
            new Date(input.window.trainingStartInclusive).getTime()
        ? "INSUFFICIENT_DATA"
        : null;
  if (reason !== null) {
    return {
      ...context,
      status: "UNAVAILABLE",
      reason,
      days: [],
      horizonTotal: null,
    };
  }
  const dailyQuantity = meanDailyForecast(input.training);
  const days = input.window.horizonDays.map((day) => ({
    ...day,
    quantity: dailyQuantity,
  }));
  const horizonTotal = days
    .reduce((total, day) => total.plus(new Decimal(day.quantity)), ZERO)
    .toFixed(4);
  return { ...context, status: "AVAILABLE", reason: null, days, horizonTotal };
}

export type ForecastBacktest =
  | Readonly<{
      status: "UNAVAILABLE";
      reason: "INSUFFICIENT_EVALUATION_HISTORY";
    }>
  | Readonly<{
      status: "AVAILABLE";
      reason: null;
      forecastVersion: typeof FORECAST_VERSION;
      referenceVersion: typeof FORECAST_REFERENCE_VERSION;
      origins: readonly [28, 35, 42, 49];
      evaluatedDays: 28;
      zeroActualDayCount: number;
      forecastAbsoluteErrors: readonly string[];
      referenceAbsoluteErrors: readonly string[];
      forecastMae: string;
      referenceMae: string;
    }>;

export function backtestForecast(input: {
  actuals: readonly Prisma.Decimal[];
  historyEligibleAtFirstOrigin: boolean;
}): ForecastBacktest {
  if (input.actuals.length !== 56 || !input.historyEligibleAtFirstOrigin) {
    return { status: "UNAVAILABLE", reason: "INSUFFICIENT_EVALUATION_HISTORY" };
  }
  const origins = [28, 35, 42, 49] as const;
  const forecastAbsoluteErrors: string[] = [];
  const referenceAbsoluteErrors: string[] = [];
  let forecastErrorSum = ZERO;
  let referenceErrorSum = ZERO;
  let zeroActualDayCount = 0;
  for (const origin of origins) {
    const forecast = new Decimal(
      meanDailyForecast(input.actuals.slice(origin - 28, origin)),
    );
    const reference = input.actuals[origin - 1]!;
    for (let day = origin; day < origin + 7; day += 1) {
      const actual = input.actuals[day]!;
      if (actual.isZero()) zeroActualDayCount += 1;
      const forecastError = new Decimal(actual).minus(forecast).abs();
      const referenceError = new Decimal(actual).minus(reference).abs();
      forecastAbsoluteErrors.push(forecastError.toFixed(4));
      referenceAbsoluteErrors.push(referenceError.toFixed(4));
      forecastErrorSum = forecastErrorSum.plus(forecastError);
      referenceErrorSum = referenceErrorSum.plus(referenceError);
    }
  }
  return {
    status: "AVAILABLE",
    reason: null,
    forecastVersion: FORECAST_VERSION,
    referenceVersion: FORECAST_REFERENCE_VERSION,
    origins,
    evaluatedDays: 28,
    zeroActualDayCount,
    forecastAbsoluteErrors,
    referenceAbsoluteErrors,
    forecastMae: forecastErrorSum
      .div(28)
      .toDecimalPlaces(4, Decimal.ROUND_HALF_UP)
      .toFixed(4),
    referenceMae: referenceErrorSum
      .div(28)
      .toDecimalPlaces(4, Decimal.ROUND_HALF_UP)
      .toFixed(4),
  };
}

export interface ForecastBacktestPair {
  branchId: string;
  productId: string;
  unit: string;
  actuals: readonly Prisma.Decimal[];
  historyEligibleAtFirstOrigin: boolean;
}

export function summarizeForecastBacktests(
  pairs: readonly ForecastBacktestPair[],
) {
  const results = pairs.map((pair) => ({
    branchId: pair.branchId,
    productId: pair.productId,
    unit: pair.unit,
    evaluation: backtestForecast(pair),
  }));
  const byUnit = new Map<
    string,
    {
      unit: string;
      eligibleCount: number;
      excludedCount: number;
      forecastMae: string[];
      referenceMae: string[];
      zeroActualDayCounts: number[];
    }
  >();
  for (const result of results) {
    const group = byUnit.get(result.unit) ?? {
      unit: result.unit,
      eligibleCount: 0,
      excludedCount: 0,
      forecastMae: [],
      referenceMae: [],
      zeroActualDayCounts: [],
    };
    if (result.evaluation.status === "AVAILABLE") {
      group.eligibleCount += 1;
      group.forecastMae.push(result.evaluation.forecastMae);
      group.referenceMae.push(result.evaluation.referenceMae);
      group.zeroActualDayCounts.push(result.evaluation.zeroActualDayCount);
    } else {
      group.excludedCount += 1;
    }
    byUnit.set(result.unit, group);
  }
  return {
    results,
    eligiblePairCount: results.filter(
      (result) => result.evaluation.status === "AVAILABLE",
    ).length,
    excludedPairCount: results.filter(
      (result) => result.evaluation.status === "UNAVAILABLE",
    ).length,
    byUnit: [...byUnit.values()].sort((left, right) =>
      left.unit.localeCompare(right.unit),
    ),
  };
}
