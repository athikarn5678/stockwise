// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AccessContext } from "@/branch-api-client";
import { BillingManagement, BillingContent } from "./billing-management";

const ORG = "10000000-0000-4000-8000-000000000001";
const OTHER_ORG = "10000000-0000-4000-8000-000000000002";
const CHECKOUT_URL = "https://checkout.stripe.com/c/pay/cs_test_session123";
const replace = vi.fn();
let searchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => searchParams,
}));

const mocks = vi.hoisted(() => {
  class BillingApiError extends Error {
    constructor(
      readonly status: number,
      readonly code: string | null = null,
    ) {
      super("Billing request failed");
    }
  }
  return {
    BillingApiError,
    getBilling: vi.fn(),
    postCheckout: vi.fn(),
    postConfirm: vi.fn(),
  };
});

vi.mock("@/billing-api-client", () => ({
  BillingApiError: mocks.BillingApiError,
  getBilling: mocks.getBilling,
  postCheckout: mocks.postCheckout,
  postConfirm: mocks.postConfirm,
}));

function accessContext(
  role: AccessContext["organizations"][number]["role"] = "OWNER",
): AccessContext {
  return {
    firstOrganizationOnboarding: { eligible: false },
    organizations: [{ branches: [], id: ORG, name: "Store", role }],
    user: {
      displayName: "Owner",
      email: "owner@example.test",
      id: "30000000-0000-4000-8000-000000000001",
    },
  };
}

function client() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
}

function renderManagement(
  role: AccessContext["organizations"][number]["role"],
) {
  searchParams = new URLSearchParams(`organizationId=${ORG}`);
  const queryClient = client();
  queryClient.setQueryData(["access-context"], accessContext(role));
  render(
    <QueryClientProvider client={queryClient}>
      <BillingManagement />
    </QueryClientProvider>,
  );
}

function renderContent({
  sessionId = null,
  navigate = vi.fn(),
}: {
  sessionId?: string | null;
  navigate?: (url: string) => void;
} = {}) {
  const queryClient = client();
  render(
    <QueryClientProvider client={queryClient}>
      <BillingContent
        navigate={navigate}
        organizationId={ORG}
        sessionId={sessionId}
      />
    </QueryClientProvider>,
  );
  return { navigate };
}

beforeEach(() => {
  replace.mockReset();
  mocks.getBilling.mockResolvedValue({
    canManage: true,
    enabled: true,
    subscription: null,
  });
  mocks.postCheckout.mockResolvedValue(CHECKOUT_URL);
  mocks.postConfirm.mockResolvedValue({
    plan: "GROWTH",
    status: "ACTIVE",
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("billing management", () => {
  it("shows a not-permitted message to non-owners", () => {
    renderManagement("CASHIER");
    expect(
      screen.getByText("Only the organization owner can manage billing."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Subscribe" })).toBeNull();
    expect(mocks.getBilling).not.toHaveBeenCalled();
  });

  it("offers the three monthly plans to the owner", async () => {
    renderManagement("OWNER");
    expect(
      await screen.findAllByRole("button", { name: "Subscribe" }),
    ).toHaveLength(3);
    for (const [name, price] of [
      ["Starter", "THB 199 per month"],
      ["Growth", "THB 499 per month"],
      ["Business", "THB 999 per month"],
    ] as const) {
      expect(screen.getByRole("heading", { name })).toBeTruthy();
      expect(screen.getByText(price)).toBeTruthy();
    }
    expect(mocks.getBilling).toHaveBeenCalledWith(ORG, expect.anything());
  });

  it("starts checkout for the chosen plan and only opens Stripe's checkout", async () => {
    const { navigate } = renderContent();
    const buttons = await screen.findAllByRole("button", { name: "Subscribe" });
    fireEvent.click(buttons[0]!);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(CHECKOUT_URL));
    expect(mocks.postCheckout).toHaveBeenCalledWith(ORG, "STARTER");
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("refuses to navigate to a URL that is not Stripe's checkout", async () => {
    mocks.postCheckout.mockResolvedValue("https://evil.example/checkout");
    const { navigate } = renderContent();
    const buttons = await screen.findAllByRole("button", { name: "Subscribe" });
    fireEvent.click(buttons[0]!);
    expect(
      await screen.findByText(
        "The checkout address was not recognized, so the payment page was not opened.",
      ),
    ).toBeTruthy();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("confirms a Checkout Session exactly once and shows the active plan", async () => {
    const navigate = vi.fn();
    const queryClient = client();
    render(
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <BillingContent
            navigate={navigate}
            organizationId={ORG}
            sessionId="cs_test_session123"
          />
        </QueryClientProvider>
      </StrictMode>,
    );
    expect(await screen.findByText("Subscription active: Growth")).toBeTruthy();
    expect(mocks.postConfirm).toHaveBeenCalledTimes(1);
    expect(mocks.postConfirm).toHaveBeenCalledWith(ORG, "cs_test_session123");
    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith(
        `/app/billing?organizationId=${ORG}`,
      ),
    );
  });

  it("shows a forbidden confirmation error", async () => {
    mocks.postConfirm.mockRejectedValue(new mocks.BillingApiError(403));
    renderContent({ sessionId: "cs_test_session123" });
    expect(
      await screen.findByText(
        "This checkout does not belong to your organization.",
      ),
    ).toBeTruthy();
  });

  it("distinguishes an incomplete checkout from an existing subscription", async () => {
    mocks.postConfirm.mockRejectedValue(
      new mocks.BillingApiError(409, "CHECKOUT_NOT_COMPLETE"),
    );
    renderContent({ sessionId: "cs_test_session123" });
    expect(
      await screen.findByText(
        "The payment is not complete yet. Finish checkout and try again.",
      ),
    ).toBeTruthy();
    cleanup();

    mocks.postConfirm.mockRejectedValue(
      new mocks.BillingApiError(409, "SUBSCRIPTION_EXISTS"),
    );
    renderContent({ sessionId: "cs_test_session123" });
    expect(
      await screen.findByText("This organization already has a subscription."),
    ).toBeTruthy();
    cleanup();

    mocks.postConfirm.mockRejectedValue(new mocks.BillingApiError(502));
    renderContent({ sessionId: "cs_test_session123" });
    expect(
      await screen.findByText(
        "The payment provider is unavailable right now. Please try again later.",
      ),
    ).toBeTruthy();
  });

  it("hides plans when billing is disabled", async () => {
    mocks.getBilling.mockResolvedValue({
      canManage: false,
      enabled: false,
      subscription: null,
    });
    renderContent();
    expect(
      await screen.findByText("Billing is not available right now."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Subscribe" })).toBeNull();
  });

  it("shows the current plan and disables further subscribing", async () => {
    mocks.getBilling.mockResolvedValue({
      canManage: true,
      enabled: true,
      subscription: { plan: "STARTER", status: "ACTIVE" },
    });
    renderContent();
    expect(
      await screen.findByText("Current plan: Starter (Active)"),
    ).toBeTruthy();
    for (const button of screen.getAllByRole("button", { name: "Subscribe" }))
      expect(button).toHaveProperty("disabled", true);
    expect(mocks.postCheckout).not.toHaveBeenCalled();
  });

  it("keeps organization-scoped lookups separate from request data", async () => {
    mocks.getBilling.mockResolvedValue({
      canManage: true,
      enabled: true,
      subscription: null,
    });
    renderContent();
    await screen.findAllByRole("button", { name: "Subscribe" });
    expect(mocks.getBilling).toHaveBeenCalledWith(ORG, expect.anything());
    expect(mocks.getBilling).not.toHaveBeenCalledWith(
      OTHER_ORG,
      expect.anything(),
    );
  });
});
