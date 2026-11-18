// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SubscriptionBanner } from "@/components/subscription-banner";
import { SUBSCRIPTION_REQUIRED_EVENT, privateFetch } from "@/session-lifecycle";
import {
  SubscriptionProvider,
  useSubscriptionWriteGate,
} from "./subscription-provider";

const ORG = "10000000-0000-4000-8000-000000000001";

function Probe() {
  const { writeBlocked } = useSubscriptionWriteGate();
  return <button disabled={writeBlocked}>Save</button>;
}

function billing(state: "ACTIVE" | "TRIAL" | "EXPIRED") {
  return new Response(
    JSON.stringify({
      data: {
        access: { state, trialDaysLeft: null, trialEndsAt: null },
        canManage: true,
        enabled: true,
        subscription: null,
      },
    }),
  );
}

describe("subscription provider and write gate", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("disables gated actions only while the organization is EXPIRED", async () => {
    vi.mocked(fetch).mockImplementation(async () => billing("EXPIRED"));
    render(
      <SubscriptionProvider organizationId={ORG}>
        <Probe />
      </SubscriptionProvider>,
    );
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
          .disabled,
      ).toBe(true),
    );
  });

  it("keeps actions enabled for TRIAL, ACTIVE and when the billing read fails", async () => {
    for (const response of [
      () => billing("TRIAL"),
      () => billing("ACTIVE"),
      () => new Response("{}", { status: 403 }),
    ]) {
      vi.mocked(fetch).mockImplementation(async () => response());
      const view = render(
        <SubscriptionProvider organizationId={ORG}>
          <Probe />
        </SubscriptionProvider>,
      );
      await waitFor(() => expect(fetch).toHaveBeenCalled());
      expect(
        (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
      view.unmount();
      vi.mocked(fetch).mockClear();
    }
  });

  it("refetches the state after a 402 SUBSCRIPTION_REQUIRED answer", async () => {
    let access: "ACTIVE" | "EXPIRED" = "ACTIVE";
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) =>
      String(input).endsWith("/billing")
        ? billing(access)
        : new Response(
            JSON.stringify({ error: { code: "SUBSCRIPTION_REQUIRED" } }),
            { status: 402 },
          ),
    );
    render(
      <SubscriptionProvider organizationId={ORG}>
        <Probe />
      </SubscriptionProvider>,
    );
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    access = "EXPIRED";
    await act(async () => {
      await privateFetch("/api/v1/organizations/x/categories", {
        method: "POST",
      });
    });
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
          .disabled,
      ).toBe(true),
    );
  });

  it("raises the event only for the SUBSCRIPTION_REQUIRED code", async () => {
    const listener = vi.fn();
    window.addEventListener(SUBSCRIPTION_REQUIRED_EVENT, listener);
    vi.mocked(fetch).mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: { code: "OTHER" } }), {
          status: 402,
        }),
    );
    await privateFetch("/api/v1/anything", { method: "POST" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(listener).not.toHaveBeenCalled();
    window.removeEventListener(SUBSCRIPTION_REQUIRED_EVENT, listener);
  });

  it("explains a refused write with a clear notice until dismissed", async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) =>
      String(input).endsWith("/billing")
        ? billing("ACTIVE")
        : new Response(
            JSON.stringify({ error: { code: "SUBSCRIPTION_REQUIRED" } }),
            { status: 402 },
          ),
    );
    render(
      <SubscriptionProvider organizationId={ORG}>
        <SubscriptionBanner />
      </SubscriptionProvider>,
    );
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("subscription-refused")).toBeNull();
    await act(async () => {
      await privateFetch("/api/v1/organizations/x/categories", {
        method: "POST",
      });
    });
    const notice = await screen.findByTestId("subscription-refused");
    expect(notice.textContent).toContain("needs an active subscription");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("subscription-refused")).toBeNull();
  });
});
