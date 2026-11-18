import { z } from "zod";

import {
  BILLING_PLANS,
  planAmountSatang,
  stripeInterval,
  type BillingInterval,
  type BillingPlan,
} from "./billing-plans.ts";

const STRIPE_API = "https://api.stripe.com";
const TIMEOUT_MILLISECONDS = 15_000;
const TEST_SECRET_KEY = /^sk_test_[A-Za-z0-9]+$/;

/** Checkout session ids from test mode start with `cs_test_`. */
export const CHECKOUT_SESSION_ID = /^cs_test_[A-Za-z0-9]+$/;

export class StripeKeyError extends Error {
  constructor() {
    super("Stripe is test mode only: a sk_test_ secret key is required.");
  }
}

const checkoutSessionSchema = z.object({
  id: z.string().regex(CHECKOUT_SESSION_ID),
  object: z.literal("checkout.session"),
  amount_total: z.number().int().nullable(),
  /** Unix seconds; a renewal must come from a session created after the row expired. */
  created: z.number().int().nonnegative(),
  client_reference_id: z.string().nullable(),
  currency: z.string().nullable(),
  customer: z.string().nullable(),
  livemode: z.boolean(),
  metadata: z.record(z.string(), z.string()).nullable(),
  mode: z.string(),
  payment_status: z.string(),
  status: z.string().nullable(),
  subscription: z.string().nullable(),
  url: z.string().nullable().optional(),
});

export type StripeCheckoutSession = z.infer<typeof checkoutSessionSchema>;

export type StripeResult<T> =
  Readonly<{ ok: true; value: T }> | Readonly<{ ok: false }>;

export type StripeClient = Readonly<{
  createCheckoutSession(input: {
    cancelUrl: string;
    interval: BillingInterval;
    organizationId: string;
    plan: BillingPlan;
    successUrl: string;
  }): Promise<StripeResult<StripeCheckoutSession>>;
  retrieveCheckoutSession(
    sessionId: string,
  ): Promise<StripeResult<StripeCheckoutSession>>;
}>;

/** Refuses any key that is not a Stripe test-mode secret key. */
export function createStripeClient({
  secretKey,
  fetchImplementation = fetch,
}: {
  secretKey: string;
  fetchImplementation?: typeof fetch;
}): StripeClient {
  if (!TEST_SECRET_KEY.test(secretKey)) throw new StripeKeyError();

  async function call(
    path: string,
    init: { body?: URLSearchParams; method: "GET" | "POST" },
  ): Promise<StripeResult<StripeCheckoutSession>> {
    try {
      const response = await fetchImplementation(`${STRIPE_API}${path}`, {
        ...(init.body === undefined ? {} : { body: init.body.toString() }),
        headers: {
          Authorization: `Bearer ${secretKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        method: init.method,
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MILLISECONDS),
      });
      if (!response.ok) return { ok: false };
      const parsed = checkoutSessionSchema.safeParse(await response.json());
      // A live-mode object is never accepted, whatever key produced it.
      if (!parsed.success || parsed.data.livemode) return { ok: false };
      return { ok: true, value: parsed.data };
    } catch {
      return { ok: false };
    }
  }

  return {
    createCheckoutSession(input) {
      const plan = BILLING_PLANS[input.plan];
      // No payment_method_types: current Stripe API versions reject it and use
      // the Dashboard payment-method settings instead (card enabled there).
      const body = new URLSearchParams({
        cancel_url: input.cancelUrl,
        client_reference_id: input.organizationId,
        "line_items[0][price_data][currency]": "thb",
        "line_items[0][price_data][product_data][name]": `StockWise ${plan.label}`,
        "line_items[0][price_data][recurring][interval]": stripeInterval(
          input.interval,
        ),
        "line_items[0][price_data][unit_amount]": String(
          planAmountSatang(input.plan, input.interval),
        ),
        "line_items[0][quantity]": "1",
        mode: "subscription",
        "metadata[interval]": input.interval,
        "metadata[organization_id]": input.organizationId,
        "metadata[plan]": input.plan,
        success_url: input.successUrl,
      });
      return call("/v1/checkout/sessions", { body, method: "POST" });
    },
    retrieveCheckoutSession(sessionId) {
      if (!CHECKOUT_SESSION_ID.test(sessionId))
        return Promise.resolve({ ok: false });
      return call(`/v1/checkout/sessions/${sessionId}`, { method: "GET" });
    },
  };
}
