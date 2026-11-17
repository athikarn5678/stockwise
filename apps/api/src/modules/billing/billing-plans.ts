import { z } from "zod";

/**
 * Server-owned price list (ADR-047). Amounts are integer satang (THB minor
 * units) so no floating-point money exists. The web pricing page shows the
 * same THB figures; the browser never supplies an amount.
 */
export const BILLING_PLANS = {
  STARTER: { amountSatang: 19_900, label: "Starter" },
  GROWTH: { amountSatang: 49_900, label: "Growth" },
  BUSINESS: { amountSatang: 99_900, label: "Business" },
} as const;

export type BillingPlan = keyof typeof BILLING_PLANS;

export const billingPlanSchema = z.enum(["STARTER", "GROWTH", "BUSINESS"]);
