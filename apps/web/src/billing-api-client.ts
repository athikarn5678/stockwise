import { z } from "zod";
import { privateFetch, readPrivateJson } from "@/session-lifecycle";

const billingPlanSchema = z.enum(["STARTER", "GROWTH", "BUSINESS"]);
const billingIntervalSchema = z.enum(["MONTH", "YEAR"]);
const subscriptionStatusSchema = z.enum([
  "ACTIVE",
  "PAST_DUE",
  "CANCELED",
  "EXPIRED",
]);
const accessSchema = z.object({
  state: z.enum(["ACTIVE", "TRIAL", "EXPIRED"]),
  trialDaysLeft: z.number().int().nullable(),
  trialEndsAt: z.string().nullable(),
});

const subscriptionSchema = z.object({
  interval: billingIntervalSchema,
  plan: billingPlanSchema,
  status: subscriptionStatusSchema,
});

const billingResponseSchema = z.object({
  data: z.object({
    access: accessSchema.nullable(),
    canManage: z.boolean(),
    enabled: z.boolean(),
    subscription: subscriptionSchema.nullable(),
  }),
});

const checkoutResponseSchema = z.object({
  data: z.object({ url: z.string() }),
});

const confirmResponseSchema = z.object({
  data: z.object({ subscription: subscriptionSchema }),
});

const errorResponseSchema = z.object({
  error: z.object({ code: z.string() }),
});

export type BillingPlan = z.infer<typeof billingPlanSchema>;
export type BillingInterval = z.infer<typeof billingIntervalSchema>;
export type SubscriptionAccess = z.infer<typeof accessSchema>;
export type SubscriptionStatus = z.infer<typeof subscriptionStatusSchema>;
export type BillingSubscription = z.infer<typeof subscriptionSchema>;
export type BillingState = z.infer<typeof billingResponseSchema>["data"];

/** Fired on `window` after a confirmed subscription so the shell badge refetches. */
export const BILLING_CHANGED_EVENT = "stockwise:billing-changed";

export class BillingApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null = null,
  ) {
    super("Billing request failed");
  }
}

async function errorCode(response: Response): Promise<string | null> {
  try {
    const parsed = errorResponseSchema.safeParse(await response.json());
    return parsed.success ? parsed.data.error.code : null;
  } catch {
    return null;
  }
}

/** Billing state of one organization; any active member may read it. */
export async function getBilling(
  organizationId: string,
  signal?: AbortSignal,
): Promise<BillingState> {
  let response: Response;
  try {
    response = await privateFetch(
      `/api/v1/organizations/${organizationId}/billing`,
      {
        credentials: "same-origin",
        headers: { accept: "application/json" },
        ...(signal ? { signal } : {}),
      },
    );
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new BillingApiError(0);
  }
  if (!response.ok)
    throw new BillingApiError(response.status, await errorCode(response));
  try {
    return billingResponseSchema.parse(await readPrivateJson(response)).data;
  } catch {
    throw new BillingApiError(0);
  }
}

/** Owner-only: start a hosted Stripe Checkout Session and return its URL. */
export async function postCheckout(
  organizationId: string,
  plan: BillingPlan,
  interval: BillingInterval = "MONTH",
): Promise<string> {
  let response: Response;
  try {
    response = await privateFetch(
      `/api/v1/organizations/${organizationId}/billing/checkout`,
      {
        body: JSON.stringify({ interval, plan }),
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        method: "POST",
      },
    );
  } catch {
    throw new BillingApiError(0);
  }
  if (!response.ok)
    throw new BillingApiError(response.status, await errorCode(response));
  try {
    return checkoutResponseSchema.parse(await readPrivateJson(response)).data
      .url;
  } catch {
    throw new BillingApiError(0);
  }
}

/** Owner-only: confirm a paid Checkout Session and persist the subscription. */
export async function postConfirm(
  organizationId: string,
  sessionId: string,
): Promise<BillingSubscription> {
  let response: Response;
  try {
    response = await privateFetch(
      `/api/v1/organizations/${organizationId}/billing/confirm`,
      {
        body: JSON.stringify({ sessionId }),
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        method: "POST",
      },
    );
  } catch {
    throw new BillingApiError(0);
  }
  if (!response.ok)
    throw new BillingApiError(response.status, await errorCode(response));
  try {
    return confirmResponseSchema.parse(await readPrivateJson(response)).data
      .subscription;
  } catch {
    throw new BillingApiError(0);
  }
}
