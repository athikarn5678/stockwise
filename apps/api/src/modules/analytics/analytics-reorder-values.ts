import { Prisma, type ProductUnit } from "../../generated/prisma/client.ts";
import {
  FORECAST_HORIZON_DAYS,
  type ForecastDay,
  type ForecastResult,
} from "./analytics-forecast-values.ts";
import { hasInventoryIntegrityError } from "./analytics-inventory-integrity.ts";

const Decimal = Prisma.Decimal.clone({ precision: 80 });
const ZERO = new Decimal(0);
const MAX_QUANTITY = new Decimal("99999999999999.9999");
export const REORDER_VERSION = "reorder-v1" as const;
/** Planning lead time options are exactly 7 and 30 days (ADR-032 amendment). */
export const SUPPORTED_LEAD_TIME_DAYS = [7, 30] as const;
export type SupportedLeadTimeDays = (typeof SUPPORTED_LEAD_TIME_DAYS)[number];

export function isSupportedLeadTime(
  days: number,
): days is SupportedLeadTimeDays {
  return SUPPORTED_LEAD_TIME_DAYS.some((supported) => supported === days);
}

type ReorderReason =
  | "INACTIVE_PRODUCT"
  | "INSUFFICIENT_DATA"
  | "LEAD_TIME_REQUIRED"
  | "UNSUPPORTED_LEAD_TIME"
  | "INVENTORY_INTEGRITY_ERROR"
  | "QUANTITY_OUT_OF_RANGE";

interface ReorderContext {
  branchId: string;
  productId: string;
  unit: ProductUnit;
  forecastVersion: ForecastResult["forecastVersion"];
  reorderVersion: typeof REORDER_VERSION;
  sourceCutoff: string;
  leadTimeDays: number | null;
  dailyForecast: readonly ForecastDay[] | null;
  onHand: string | null;
}

export type ReorderResult =
  | Readonly<
      ReorderContext & {
        status: "AVAILABLE";
        reason: null;
        leadTimeDays: SupportedLeadTimeDays;
        onHand: string;
        leadTimeDemand: string;
        rawNeed: string;
        recommendedQuantity: string;
      }
    >
  | Readonly<
      ReorderContext & {
        status: "UNAVAILABLE";
        reason: ReorderReason;
        leadTimeDemand: null;
        rawNeed: null;
        recommendedQuantity: null;
      }
    >;

export interface ReorderStock {
  onHand: Prisma.Decimal;
  ledgerQuantity: Prisma.Decimal;
  invalidSourceCount: bigint;
}

function orderQuantity(
  rawNeed: Prisma.Decimal,
  unit: ProductUnit,
): Prisma.Decimal {
  switch (unit) {
    case "EA":
    case "PACK":
    case "BOX":
      return rawNeed.ceil();
    case "KG":
    case "G":
    case "L":
    case "ML":
    case "M":
    case "CM":
      return rawNeed;
  }
  const exhaustive: never = unit;
  throw new Error(`Unsupported Product unit: ${exhaustive}`);
}

export function buildReorder(input: {
  forecast: ForecastResult;
  leadTimeDays?: number;
  stock?: ReorderStock;
}): ReorderResult {
  const { forecast, stock } = input;
  const context: ReorderContext = {
    branchId: forecast.branchId,
    productId: forecast.productId,
    unit: forecast.unit,
    forecastVersion: forecast.forecastVersion,
    reorderVersion: REORDER_VERSION,
    sourceCutoff: forecast.sourceCutoff,
    leadTimeDays: input.leadTimeDays ?? null,
    dailyForecast:
      forecast.status === "AVAILABLE"
        ? forecast.days.slice(0, FORECAST_HORIZON_DAYS)
        : null,
    onHand: null,
  };
  const unavailable = (
    reason: ReorderReason,
    onHand: string | null = null,
  ): ReorderResult => ({
    ...context,
    onHand,
    status: "UNAVAILABLE",
    reason,
    leadTimeDemand: null,
    rawNeed: null,
    recommendedQuantity: null,
  });
  if (forecast.status === "UNAVAILABLE") return unavailable(forecast.reason);
  const days = input.leadTimeDays;
  if (days === undefined) return unavailable("LEAD_TIME_REQUIRED");
  if (!isSupportedLeadTime(days)) return unavailable("UNSUPPORTED_LEAD_TIME");
  if (forecast.days.length < days)
    throw new Error(
      "Reorder requires a forecast horizon that covers the lead time.",
    );
  if (stock === undefined) throw new Error("Reorder stock read is required.");
  if (hasInventoryIntegrityError({ ...stock, unit: forecast.unit }))
    return unavailable("INVENTORY_INTEGRITY_ERROR");
  const onHand = new Decimal(stock.onHand).toFixed(4);
  const leadTimeDemand = forecast.days
    .slice(0, days)
    .reduce((sum, day) => sum.plus(new Decimal(day.quantity)), ZERO);
  const rawNeed = Decimal.max(ZERO, leadTimeDemand.minus(stock.onHand));
  if (rawNeed.gt(MAX_QUANTITY))
    return unavailable("QUANTITY_OUT_OF_RANGE", onHand);
  const recommendedQuantity = orderQuantity(rawNeed, forecast.unit);
  if (recommendedQuantity.gt(MAX_QUANTITY))
    return unavailable("QUANTITY_OUT_OF_RANGE", onHand);
  return {
    ...context,
    onHand,
    leadTimeDays: days,
    status: "AVAILABLE",
    reason: null,
    leadTimeDemand: leadTimeDemand.toFixed(4),
    rawNeed: rawNeed.toFixed(4),
    recommendedQuantity: recommendedQuantity.toFixed(4),
  };
}
