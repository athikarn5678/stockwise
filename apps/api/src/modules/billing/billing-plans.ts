import { z } from "zod";

/**
 * Server-owned price list (ADR-047, ADR-050). Amounts are integer satang (THB
 * minor units) so no floating-point money exists. The web pricing page shows
 * the same THB figures; the browser never supplies an amount.
 */
export const BILLING_PLANS = {
  STARTER: {
    amountSatang: { MONTH: 19_900, YEAR: 199_000 },
    label: "Starter",
  },
  GROWTH: {
    amountSatang: { MONTH: 49_900, YEAR: 499_000 },
    label: "Growth",
  },
  BUSINESS: {
    amountSatang: { MONTH: 99_900, YEAR: 999_000 },
    label: "Business",
  },
} as const;

export type BillingPlan = keyof typeof BILLING_PLANS;
export type BillingInterval = "MONTH" | "YEAR";

export const billingPlanSchema = z.enum(["STARTER", "GROWTH", "BUSINESS"]);
export const billingIntervalSchema = z.enum(["MONTH", "YEAR"]);

export function planAmountSatang(
  plan: BillingPlan,
  interval: BillingInterval,
): number {
  return BILLING_PLANS[plan].amountSatang[interval];
}

/** Stripe's recurring interval name for a StockWise billing interval. */
export function stripeInterval(interval: BillingInterval): "month" | "year" {
  return interval === "YEAR" ? "year" : "month";
}
