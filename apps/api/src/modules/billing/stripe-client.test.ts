import { describe, expect, it, vi } from "vitest";

import { BILLING_PLANS } from "./billing-plans.ts";
import {
  createStripeClient,
  StripeKeyError,
  type StripeCheckoutSession,
} from "./stripe-client.ts";

const SECRET_KEY = "sk_test_abc123";
const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const CHECKOUT_URL = "https://api.stripe.com/v1/checkout/sessions";
const SESSION_ID = "cs_test_session123";
const SESSION_URL = `https://checkout.stripe.com/c/pay/${SESSION_ID}`;

function session(
  overrides: Partial<StripeCheckoutSession> = {},
): StripeCheckoutSession {
  return {
    amount_total: 19_900,
    client_reference_id: ORGANIZATION_ID,
    currency: "thb",
    customer: "cus_abc123",
    id: SESSION_ID,
    created: 1_794_960_000,
    livemode: false,
    metadata: { organization_id: ORGANIZATION_ID, plan: "STARTER" },
    mode: "subscription",
    object: "checkout.session",
    payment_status: "paid",
    status: "complete",
    subscription: "sub_abc123",
    url: SESSION_URL,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

function client(fetchImplementation: typeof fetch) {
  return createStripeClient({ fetchImplementation, secretKey: SECRET_KEY });
}

function checkoutInput(
  plan: keyof typeof BILLING_PLANS = "STARTER",
  interval: "MONTH" | "YEAR" = "MONTH",
) {
  return {
    cancelUrl: `https://app.example.com/app/billing?organizationId=${ORGANIZATION_ID}&canceled=1`,
    interval,
    organizationId: ORGANIZATION_ID,
    plan,
    successUrl: `https://app.example.com/app/billing?organizationId=${ORGANIZATION_ID}&session_id={CHECKOUT_SESSION_ID}`,
  };
}

function fetchMock(value: Response | Promise<Response>) {
  return vi.fn<typeof fetch>(async () => value);
}

describe("Stripe test-mode client", () => {
  it("refuses every key that is not a test-mode secret key", () => {
    for (const secretKey of [
      "",
      "sk_live_abc123",
      "pk_test_abc123",
      "rk_test_abc123",
      "sk_test_",
      "sk_test_abc-123",
      "sk_test_abc123 ",
    ])
      expect(() => createStripeClient({ secretKey })).toThrow(StripeKeyError);
    expect(() =>
      createStripeClient({ secretKey: "sk_test_abc123" }),
    ).not.toThrow();
  });

  it.each([
    ["STARTER", 19_900],
    ["GROWTH", 49_900],
    ["BUSINESS", 99_900],
  ] as const)(
    "creates a monthly THB subscription Checkout Session for %s",
    async (plan, amountSatang) => {
      const fetchImplementation = fetchMock(jsonResponse(session()));
      const result = await client(fetchImplementation).createCheckoutSession(
        checkoutInput(plan),
      );

      expect(result).toEqual({ ok: true, value: session() });
      expect(fetchImplementation).toHaveBeenCalledTimes(1);
      const [url, init] = fetchImplementation.mock.calls[0]!;
      expect(url).toBe(CHECKOUT_URL);
      expect(init?.method).toBe("POST");
      expect(init?.headers).toEqual({
        Authorization: `Bearer ${SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      });
      const body = new URLSearchParams(String(init?.body));
      expect(body.getAll("mode")).toEqual(["subscription"]);
      expect(body.has("payment_method_types[0]")).toBe(false);
      expect(body.get("line_items[0][price_data][currency]")).toBe("thb");
      expect(body.get("line_items[0][price_data][unit_amount]")).toBe(
        String(amountSatang),
      );
      expect(body.get("line_items[0][price_data][recurring][interval]")).toBe(
        "month",
      );
      expect(body.get("line_items[0][quantity]")).toBe("1");
      expect(body.get("client_reference_id")).toBe(ORGANIZATION_ID);
      expect(body.get("metadata[organization_id]")).toBe(ORGANIZATION_ID);
      expect(body.get("metadata[plan]")).toBe(plan);
      expect(body.get("metadata[interval]")).toBe("MONTH");
      // Stripe decodes the form value; the literal placeholder must survive.
      expect(body.get("success_url")).toContain("{CHECKOUT_SESSION_ID}");
      expect(body.get("cancel_url")).toContain("canceled=1");
    },
  );

  it.each([
    ["STARTER", 199_000],
    ["GROWTH", 499_000],
    ["BUSINESS", 999_000],
  ] as const)(
    "creates a yearly THB subscription Checkout Session for %s",
    async (plan, amountSatang) => {
      const fetchImplementation = fetchMock(jsonResponse(session()));
      await client(fetchImplementation).createCheckoutSession(
        checkoutInput(plan, "YEAR"),
      );
      const body = new URLSearchParams(
        String(fetchImplementation.mock.calls[0]![1]?.body),
      );
      expect(body.get("line_items[0][price_data][unit_amount]")).toBe(
        String(amountSatang),
      );
      expect(body.get("line_items[0][price_data][recurring][interval]")).toBe(
        "year",
      );
      expect(body.get("metadata[interval]")).toBe("YEAR");
    },
  );

  it("reports a provider failure for live-mode objects", async () => {
    const result = await client(
      fetchMock(jsonResponse(session({ livemode: true }))),
    ).createCheckoutSession(checkoutInput());
    expect(result).toEqual({ ok: false });
  });

  it("reports a provider failure for non-2xx, malformed and thrown transports", async () => {
    await expect(
      client(
        fetchMock(jsonResponse({ error: "boom" }, 500)),
      ).createCheckoutSession(checkoutInput()),
    ).resolves.toEqual({ ok: false });
    await expect(
      client(fetchMock(jsonResponse({}))).createCheckoutSession(
        checkoutInput(),
      ),
    ).resolves.toEqual({ ok: false });
    const malformed = await client(
      fetchMock(new Response("not json", { status: 200 })),
    ).createCheckoutSession(checkoutInput());
    expect(malformed).toEqual({ ok: false });
    const thrown = await client(
      vi.fn<typeof fetch>(async () => {
        throw new Error("network down");
      }),
    ).createCheckoutSession(checkoutInput());
    expect(thrown).toEqual({ ok: false });
    // An unparseable session id is a provider failure, not a crash.
    const badId = await client(
      fetchMock(jsonResponse(session({ id: "cs_live_session123" }))),
    ).createCheckoutSession(checkoutInput());
    expect(badId).toEqual({ ok: false });
  });

  it("retrieves a session with a GET and rejects non-test ids before fetching", async () => {
    const fetchImplementation = fetchMock(jsonResponse(session()));
    const result =
      await client(fetchImplementation).retrieveCheckoutSession(SESSION_ID);
    expect(result).toEqual({ ok: true, value: session() });
    const [url, init] = fetchImplementation.mock.calls[0]!;
    expect(url).toBe(`${CHECKOUT_URL}/${SESSION_ID}`);
    expect(init?.method).toBe("GET");
    expect(init?.body).toBeUndefined();
    expect(init?.headers).toMatchObject({
      Authorization: `Bearer ${SECRET_KEY}`,
    });

    for (const sessionId of ["", "cs_live_abc123", "cs_test_", "x"]) {
      const unused = fetchMock(jsonResponse(session()));
      await expect(
        client(unused).retrieveCheckoutSession(sessionId),
      ).resolves.toEqual({ ok: false });
      expect(unused).not.toHaveBeenCalled();
    }
  });
});
