import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BillingApiError,
  getBilling,
  postCheckout,
  postConfirm,
} from "./billing-api-client";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const SESSION_ID = "cs_test_session123";

afterEach(() => vi.restoreAllMocks());

describe("billing API client", () => {
  it("reads the organization billing state from the same origin", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            access: { state: "ACTIVE", trialDaysLeft: null, trialEndsAt: null },
            canManage: true,
            enabled: true,
            subscription: {
              interval: "MONTH",
              plan: "STARTER",
              status: "ACTIVE",
            },
          },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(getBilling(ORGANIZATION_ID)).resolves.toEqual({
      access: { state: "ACTIVE", trialDaysLeft: null, trialEndsAt: null },
      canManage: true,
      enabled: true,
      subscription: { interval: "MONTH", plan: "STARTER", status: "ACTIVE" },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/organizations/${ORGANIZATION_ID}/billing`,
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("starts checkout with only the plan and interval and returns the URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: { url: "https://checkout.stripe.com/c/pay/cs_test_session123" },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(postCheckout(ORGANIZATION_ID, "GROWTH")).resolves.toBe(
      "https://checkout.stripe.com/c/pay/cs_test_session123",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/organizations/${ORGANIZATION_ID}/billing/checkout`,
      expect.objectContaining({
        body: JSON.stringify({ interval: "MONTH", plan: "GROWTH" }),
        credentials: "same-origin",
        method: "POST",
      }),
    );
  });

  it("confirms a session and returns the stored subscription", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            subscription: {
              interval: "YEAR",
              plan: "BUSINESS",
              status: "ACTIVE",
            },
          },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(postConfirm(ORGANIZATION_ID, SESSION_ID)).resolves.toEqual({
      interval: "YEAR",
      plan: "BUSINESS",
      status: "ACTIVE",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/organizations/${ORGANIZATION_ID}/billing/confirm`,
      expect.objectContaining({
        body: JSON.stringify({ sessionId: SESSION_ID }),
        method: "POST",
      }),
    );
  });

  it("preserves the HTTP status and canonical error code", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ error: { code: "CHECKOUT_NOT_COMPLETE" } }),
            { status: 409 },
          ),
        ),
    );
    await expect(
      postConfirm(ORGANIZATION_ID, SESSION_ID),
    ).rejects.toMatchObject({ code: "CHECKOUT_NOT_COMPLETE", status: 409 });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("{}", { status: 403 })),
    );
    await expect(getBilling(ORGANIZATION_ID)).rejects.toMatchObject({
      status: 403,
    });
  });

  it("reports malformed responses and unreachable transports as status 0", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("{}", { status: 200 })),
    );
    await expect(getBilling(ORGANIZATION_ID)).rejects.toBeInstanceOf(
      BillingApiError,
    );
    await expect(getBilling(ORGANIZATION_ID)).rejects.toMatchObject({
      status: 0,
    });

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(getBilling(ORGANIZATION_ID)).rejects.toMatchObject({
      status: 0,
    });
  });
});
