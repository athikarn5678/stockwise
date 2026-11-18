import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../../app.ts";
import type { ApiLogger } from "../../logger.ts";
import { startApiServer, type RunningApiServer } from "../../server.ts";
import { createSessionAuthenticationMiddleware } from "../identity/authentication-context.ts";
import type {
  BillingReadResult,
  BillingService,
  CheckoutResult,
  ConfirmResult,
} from "./billing-service.ts";
import { createBillingRouter } from "./billing-router.ts";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const TOKEN = "A".repeat(43);
const TEST_COOKIE_NAME = "stockwise_test_session";
const logger: ApiLogger = { error() {}, info() {} };
const SUBSCRIPTION = {
  interval: "MONTH",
  plan: "STARTER",
  status: "ACTIVE",
} as const;

type Service = ReturnType<typeof fakeService>;

function fakeService() {
  return {
    read: vi.fn(async (): Promise<BillingReadResult> => ({
      access: null,
      canManage: true,
      enabled: true,
      kind: "ok",
      subscription: SUBSCRIPTION,
    })),
    checkout: vi.fn(async (): Promise<CheckoutResult> => ({
      kind: "ok",
      url: "https://checkout.stripe.com/c/pay/cs_test_session123",
    })),
    confirm: vi.fn(async (): Promise<ConfirmResult> => ({
      kind: "ok",
      subscription: SUBSCRIPTION,
    })),
  };
}

describe("billing router", () => {
  let server: RunningApiServer | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  async function start({
    authenticated = true,
    service = fakeService(),
  }: {
    authenticated?: boolean;
    service?: Service;
  } = {}) {
    const authenticationMiddleware = createSessionAuthenticationMiddleware(
      async (request) =>
        authenticated &&
        request.headers.cookie === `${TEST_COOKIE_NAME}=${TOKEN}`
          ? {
              actor: {
                displayName: "Owner",
                email: "owner@example.com",
                id: "trusted-user-id",
              },
              sessionId: "session-id",
            }
          : null,
    );
    // Narrow cast: the router only calls the three service seams faked here.
    const router = createBillingRouter({
      authenticationMiddleware,
      service: service as unknown as BillingService,
    });
    server = await startApiServer(createApp({ apiRouter: router, logger }), {
      host: "127.0.0.1",
      port: 0,
    });
    return {
      service,
      url: `http://${server.address.host}:${server.address.port}/api/v1`,
    };
  }

  function request(
    url: string,
    method: "GET" | "POST" = "GET",
    body?: unknown,
  ) {
    return fetch(url, {
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      headers: {
        cookie: `${TEST_COOKIE_NAME}=${TOKEN}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      method,
    });
  }

  const billingUrl = (organizationId = ORGANIZATION_ID) =>
    `/organizations/${organizationId}/billing`;

  it("returns the billing state with a private cache policy", async () => {
    const { service, url } = await start();
    const response = await request(`${url}${billingUrl()}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      data: {
        access: null,
        canManage: true,
        enabled: true,
        subscription: SUBSCRIPTION,
      },
    });
    expect(service.read).toHaveBeenCalledWith(
      "trusted-user-id",
      ORGANIZATION_ID,
    );
  });

  it("returns a Checkout URL and a confirmed subscription", async () => {
    const { service, url } = await start();
    const checkout = await request(`${url}${billingUrl()}/checkout`, "POST", {
      plan: "GROWTH",
    });
    expect(checkout.status).toBe(200);
    expect(checkout.headers.get("cache-control")).toBe("no-store");
    expect(await checkout.json()).toEqual({
      data: { url: "https://checkout.stripe.com/c/pay/cs_test_session123" },
    });
    expect(service.checkout).toHaveBeenCalledWith({
      actorUserId: "trusted-user-id",
      interval: "MONTH",
      organizationId: ORGANIZATION_ID,
      plan: "GROWTH",
    });

    const confirm = await request(`${url}${billingUrl()}/confirm`, "POST", {
      sessionId: "cs_test_session123",
    });
    expect(confirm.status).toBe(200);
    expect(confirm.headers.get("cache-control")).toBe("no-store");
    expect(await confirm.json()).toEqual({
      data: { subscription: SUBSCRIPTION },
    });
    expect(service.confirm).toHaveBeenCalledWith({
      actorUserId: "trusted-user-id",
      organizationId: ORGANIZATION_ID,
      sessionId: "cs_test_session123",
    });
  });

  it("denies unauthenticated billing requests", async () => {
    const { service, url } = await start({ authenticated: false });
    expect((await request(`${url}${billingUrl()}`)).status).toBe(401);
    expect(
      (
        await fetch(`${url}${billingUrl()}/checkout`, {
          body: JSON.stringify({ plan: "STARTER" }),
          headers: { "content-type": "application/json" },
          method: "POST",
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${url}${billingUrl()}/confirm`, {
          body: JSON.stringify({ sessionId: "cs_test_session123" }),
          headers: { "content-type": "application/json" },
          method: "POST",
        })
      ).status,
    ).toBe(401);
    expect(service.read).not.toHaveBeenCalled();
    expect(service.checkout).not.toHaveBeenCalled();
    expect(service.confirm).not.toHaveBeenCalled();
  });

  it("rejects invalid organizations and bodies before calling the service", async () => {
    const { service, url } = await start();
    expect((await request(`${url}${billingUrl("not-a-uuid")}`)).status).toBe(
      400,
    );
    for (const body of [
      { plan: "STARTER", organizationId: "forged" },
      { plan: "ENTERPRISE" },
      { plan: "starter" },
      {},
      { plan: null },
    ]) {
      expect(
        (await request(`${url}${billingUrl()}/checkout`, "POST", body)).status,
      ).toBe(400);
    }
    for (const body of [
      { sessionId: "cs_live_session123" },
      { sessionId: "session123" },
      { sessionId: "cs_test_session123", organizationId: "forged" },
      {},
    ]) {
      expect(
        (await request(`${url}${billingUrl()}/confirm`, "POST", body)).status,
      ).toBe(400);
    }
    expect(
      (
        await request(`${url}${billingUrl("not-a-uuid")}/confirm`, "POST", {
          sessionId: "cs_test_session123",
        })
      ).status,
    ).toBe(400);
    expect(service.read).not.toHaveBeenCalled();
    expect(service.checkout).not.toHaveBeenCalled();
    expect(service.confirm).not.toHaveBeenCalled();
  });

  it("maps forbidden, disabled and conflict results", async () => {
    const forbidden = fakeService();
    forbidden.read.mockResolvedValue({ kind: "forbidden" });
    forbidden.checkout.mockResolvedValue({ kind: "forbidden" });
    forbidden.confirm.mockResolvedValue({ kind: "forbidden" });
    const denied = await start({ service: forbidden });
    expect((await request(`${denied.url}${billingUrl()}`)).status).toBe(403);
    const deniedCheckout = await request(
      `${denied.url}${billingUrl()}/checkout`,
      "POST",
      { plan: "STARTER" },
    );
    expect(deniedCheckout.status).toBe(403);
    expect(await deniedCheckout.json()).toMatchObject({
      error: { code: "FORBIDDEN" },
    });
    expect(
      (
        await request(`${denied.url}${billingUrl()}/confirm`, "POST", {
          sessionId: "cs_test_session123",
        })
      ).status,
    ).toBe(403);

    const disabled = fakeService();
    disabled.checkout.mockResolvedValue({ kind: "disabled" });
    disabled.confirm.mockResolvedValue({ kind: "disabled" });
    const hidden = await start({ service: disabled });
    expect(
      (
        await request(`${hidden.url}${billingUrl()}/checkout`, "POST", {
          plan: "STARTER",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(`${hidden.url}${billingUrl()}/confirm`, "POST", {
          sessionId: "cs_test_session123",
        })
      ).status,
    ).toBe(404);

    const conflict = fakeService();
    conflict.checkout.mockResolvedValue({ kind: "conflict" });
    conflict.confirm.mockResolvedValue({ kind: "conflict" });
    const existing = await start({ service: conflict });
    const existingCheckout = await request(
      `${existing.url}${billingUrl()}/checkout`,
      "POST",
      { plan: "STARTER" },
    );
    expect(existingCheckout.status).toBe(409);
    expect(await existingCheckout.json()).toMatchObject({
      error: { code: "SUBSCRIPTION_EXISTS" },
    });
    expect(
      (
        await request(`${existing.url}${billingUrl()}/confirm`, "POST", {
          sessionId: "cs_test_session123",
        })
      ).status,
    ).toBe(409);

    const incomplete = fakeService();
    incomplete.confirm.mockResolvedValue({ kind: "not_complete" });
    const pending = await start({ service: incomplete });
    const pendingConfirm = await request(
      `${pending.url}${billingUrl()}/confirm`,
      "POST",
      { sessionId: "cs_test_session123" },
    );
    expect(pendingConfirm.status).toBe(409);
    expect(await pendingConfirm.json()).toMatchObject({
      error: { code: "CHECKOUT_NOT_COMPLETE" },
    });
  });

  it("maps provider failures to 502", async () => {
    const failed = fakeService();
    failed.checkout.mockResolvedValue({ kind: "provider_failed" });
    failed.confirm.mockResolvedValue({ kind: "provider_failed" });
    const { url } = await start({ service: failed });
    const checkout = await request(`${url}${billingUrl()}/checkout`, "POST", {
      plan: "STARTER",
    });
    expect(checkout.status).toBe(502);
    expect(await checkout.json()).toMatchObject({
      error: { code: "BILLING_PROVIDER_FAILED" },
    });
    expect(
      (
        await request(`${url}${billingUrl()}/confirm`, "POST", {
          sessionId: "cs_test_session123",
        })
      ).status,
    ).toBe(502);
  });
});
