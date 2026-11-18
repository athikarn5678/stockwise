// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HomePage from "@/app/page";
import PricingPage from "@/app/pricing/page";
import { PricingContent } from "./pricing-content";
import { MarketingShell } from "./marketing-shell";
import { LanguageProvider } from "@/providers/language-provider";
import { PreferenceControls } from "@/components/preference-controls";
import { en } from "@/i18n/en";
import { th } from "@/i18n/th";

const ORG = "10000000-0000-4000-8000-000000000001";
const replace = vi.fn();
let search = new URLSearchParams();
vi.mock("next/navigation", () => ({
  usePathname: () => "/pricing",
  useRouter: () => ({ push: vi.fn(), replace }),
  useSearchParams: () => search,
}));

type Role = "OWNER" | "ADMIN" | "CASHIER";
type Access = {
  state: "ACTIVE" | "TRIAL" | "EXPIRED";
  trialDaysLeft: number | null;
  trialEndsAt: string | null;
} | null;
const access = (state: "ACTIVE" | "TRIAL" | "EXPIRED"): Access => ({
  state,
  trialDaysLeft: state === "TRIAL" ? 9 : null,
  trialEndsAt: state === "TRIAL" ? "2026-11-27T00:00:00.000Z" : null,
});
type Subscription = {
  interval: "MONTH" | "YEAR";
  plan: string;
  status: string;
};
const world = {
  access: null as Access,
  billingEnabled: true,
  organizations: true,
  role: "OWNER" as Role,
  signedIn: false,
  subscription: null as Subscription | null,
};
const calls: { body: unknown; method: string; url: string }[] = [];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({
        body: init?.body ? JSON.parse(String(init.body)) : null,
        method,
        url,
      });
      if (url.endsWith("/me/access-context"))
        return world.signedIn
          ? json({
              data: {
                firstOrganizationOnboarding: { eligible: false },
                organizations: world.organizations
                  ? [
                      {
                        branches: [],
                        id: ORG,
                        name: "Siam Mart",
                        role: world.role,
                      },
                    ]
                  : [],
                user: {
                  displayName: "Mali Owner",
                  email: "mali@example.test",
                  id: "30000000-0000-4000-8000-000000000001",
                },
              },
            })
          : json({ error: { code: "AUTHENTICATION_REQUIRED" } }, 401);
      if (url.endsWith(`/organizations/${ORG}/billing`))
        return json({
          data: {
            access: world.billingEnabled ? world.access : null,
            canManage: world.role === "OWNER" && world.billingEnabled,
            enabled: world.billingEnabled,
            subscription: world.billingEnabled ? world.subscription : null,
          },
        });
      if (url.endsWith("/billing/checkout"))
        return json({
          data: { url: "https://checkout.stripe.com/c/pay/cs_test_x1" },
        });
      if (url.endsWith("/billing/confirm"))
        return json({
          data: {
            subscription: {
              interval: "YEAR",
              plan: "GROWTH",
              status: "ACTIVE",
            },
          },
        });
      if (url.endsWith("/auth/logout"))
        return new Response(null, { status: 204 });
      return json({ error: { code: "NOT_FOUND" } }, 404);
    }),
  );
}

function renderPage(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <LanguageProvider>{ui}</LanguageProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  replace.mockReset();
  search = new URLSearchParams();
  calls.length = 0;
});
beforeEach(() => {
  localStorage.clear();
  world.access = access("TRIAL");
  world.billingEnabled = true;
  world.organizations = true;
  world.role = "OWNER";
  world.signedIn = false;
  world.subscription = null;
  installFetch();
});
describe("public marketing", () => {
  it.each(["en", "th"] as const)(
    "removes the pricing notice without adding purchase actions in %s",
    async (language) => {
      localStorage.setItem("stockwise.language", language);
      renderPage(<PricingPage />);
      const copy = language === "th" ? th : en;
      expect(screen.queryByRole("alert")).toBeNull();
      expect(
        screen.queryByText("Proposed pricing — not available for purchase"),
      ).toBeNull();
      expect(
        screen.queryByText("ราคาเสนอเบื้องต้น — ยังไม่เปิดจำหน่าย"),
      ).toBeNull();
      expect(
        screen.queryByText(/These are proposed marketing concepts only/),
      ).toBeNull();
      expect(
        screen.queryByText(/นี่เป็นเพียงแนวคิดทางการตลาดที่เสนอไว้เท่านั้น/),
      ).toBeNull();
      expect(screen.getByText(copy.pricingBadge)).toBeTruthy();
      expect(screen.getByText(copy.pricingAccountDisclaimer)).toBeTruthy();
      expect(
        screen.queryByRole("button", {
          name: /buy|purchase|checkout|ซื้อ|ชำระเงิน/i,
        }),
      ).toBeNull();
      // A guest signs in first and comes back to /pricing to subscribe.
      await waitFor(() =>
        expect(
          screen
            .getAllByRole("link")
            .filter(
              (link) => link.getAttribute("href") === "/login?next=%2Fpricing",
            ),
        ).toHaveLength(3),
      );
    },
  );
  it("uses real navigation and labels the illustrative product data", async () => {
    renderPage(
      <MarketingShell>
        <HomePage />
      </MarketingShell>,
    );
    const nav = within(
      screen.getByRole("navigation", { name: "Public navigation" }),
    );
    for (const [name, href] of [
      ["Features", "/#features"],
      ["Pricing", "/pricing"],
      ["Get started", "/login"],
    ] as const) {
      expect(
        (await nav.findByRole("link", { name })).getAttribute("href"),
      ).toBe(href);
    }
    // Guests get exactly one call to action: no separate Sign in or register.
    expect(nav.queryByRole("link", { name: "Sign in" })).toBeNull();
    expect(nav.queryByRole("link", { name: "Dashboard" })).toBeNull();
    expect(
      nav
        .getAllByRole("link")
        .some((link) => link.getAttribute("href") === "/register"),
    ).toBe(false);
    expect(
      screen.getByRole("heading", { name: "Run your inventory with clarity." }),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("heading", { name: "The essentials, connected." })
        .closest("section")?.id,
    ).toBe("features");
  });
  it("switches billing amounts without selecting a subscription or payment", async () => {
    renderPage(<PricingPage />);
    await screen.findAllByRole("link", { name: /Sign in to subscribe/ });
    const plans = within(
      screen.getByRole("region", { name: "Proposed plans" }),
    );
    for (const [name, monthly, yearly, branches, users] of [
      ["Starter", "199", "1,990", "1 branch", "3 users"],
      ["Growth", "499", "4,990", "3 branches", "10 users"],
      ["Business", "999", "9,990", "10 branches", "30 users"],
    ] as const) {
      const card = within(
        plans.getByRole("heading", { name }).closest("article")!,
      );
      expect(card.getByText(`THB ${monthly}`, { exact: true })).toBeTruthy();
      expect(card.getByText(branches, { exact: true })).toBeTruthy();
      expect(card.getByText(users, { exact: true })).toBeTruthy();
      expect(card.getByRole("link").getAttribute("href")).toBe(
        "/login?next=%2Fpricing",
      );
      fireEvent.click(screen.getByRole("button", { name: "Yearly" }));
      expect(card.getByText(`THB ${yearly}`, { exact: true })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Monthly" }));
    }
    const enterprise = within(
      plans.getByRole("heading", { name: "Enterprise" }).closest("article")!,
    );
    expect(enterprise.queryByRole("link")).toBeNull();
    expect(enterprise.queryByRole("button")).toBeNull();
    expect(screen.getByText(/does not select a plan/)).toBeTruthy();
  });
  it("updates home and pricing in place while preserving the billing selection", () => {
    renderPage(
      <>
        <PreferenceControls />
        <HomePage />
        <PricingPage />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Yearly" }));
    fireEvent.click(screen.getByRole("button", { name: "Language" }));
    expect(
      screen.getByRole("heading", { name: th.marketingHeroTitle }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: en.marketingHeroTitle }),
    ).toBeNull();
    expect(screen.getByRole("heading", { name: th.pricingTitle })).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: th.pricingYearly })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getByText("THB 1,990")).toBeTruthy();
    expect(localStorage.getItem("stockwise.language")).toBe("th");
    fireEvent.click(screen.getByRole("button", { name: "ภาษา" }));
    expect(
      screen.getByRole("heading", { name: en.marketingHeroTitle }),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: en.pricingYearly })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });
  it("uses an accessible official Sheet and closes after navigation", async () => {
    renderPage(
      <MarketingShell>
        <p>Public content</p>
      </MarketingShell>,
    );
    const trigger = screen.getByRole("button", { name: "Menu" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "Menu" });
    const pricing = within(dialog).getByRole("link", { name: "Pricing" });
    expect(pricing.getAttribute("aria-current")).toBe("page");
    fireEvent.click(pricing);
    await waitFor(() =>
      expect(trigger.getAttribute("aria-expanded")).toBe("false"),
    );
  });
});

describe("signed-in landing header", () => {
  it("keeps a signed-in visitor on the page with a profile menu and a dashboard button", async () => {
    world.signedIn = true;
    renderPage(
      <MarketingShell>
        <HomePage />
      </MarketingShell>,
    );
    const nav = within(
      screen.getByRole("navigation", { name: "Public navigation" }),
    );
    expect(
      (await nav.findByRole("link", { name: "Go to dashboard" })).getAttribute(
        "href",
      ),
    ).toBe("/app");
    expect(nav.queryByRole("link", { name: "Get started" })).toBeNull();
    const menu = nav.getByRole("button", { name: "Profile menu" });
    expect(menu.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(menu);
    expect(menu.getAttribute("aria-expanded")).toBe("true");
    expect(nav.getByText("Mali Owner", { selector: "p" })).toBeTruthy();
    expect(nav.getByText("mali@example.test")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(menu.getAttribute("aria-expanded")).toBe("false");
  });

  it("signs out from the profile menu and stays on the landing page", async () => {
    world.signedIn = true;
    renderPage(
      <MarketingShell>
        <HomePage />
      </MarketingShell>,
    );
    const nav = within(
      screen.getByRole("navigation", { name: "Public navigation" }),
    );
    fireEvent.click(await nav.findByRole("button", { name: "Profile menu" }));
    fireEvent.click(nav.getByRole("button", { name: "Log out" }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
    expect(
      calls.some(
        (call) => call.method === "POST" && call.url.endsWith("/auth/logout"),
      ),
    ).toBe(true);
  });
});

describe("pricing as the only place to subscribe", () => {
  const subscribeButtons = () =>
    screen.getAllByRole("button", { name: "Subscribe" });

  it("starts Stripe Checkout for the owner with the selected plan and interval", async () => {
    world.signedIn = true;
    const navigate = vi.fn();
    renderPage(<PricingContent navigate={navigate} />);
    await waitFor(() =>
      expect((subscribeButtons()[1] as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Yearly" }));
    fireEvent.click(subscribeButtons()[1]!);
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith(
        "https://checkout.stripe.com/c/pay/cs_test_x1",
      ),
    );
    const checkout = calls.find((call) =>
      call.url.endsWith("/billing/checkout"),
    );
    expect(checkout?.body).toEqual({ interval: "YEAR", plan: "GROWTH" });
  });

  it("refuses a checkout address that is not Stripe's", async () => {
    world.signedIn = true;
    const navigate = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/billing/checkout"))
          return json({ data: { url: "https://evil.test/pay" } });
        if (url.endsWith("/me/access-context"))
          return json({
            data: {
              firstOrganizationOnboarding: { eligible: false },
              organizations: [
                { branches: [], id: ORG, name: "S", role: "OWNER" },
              ],
              user: {
                displayName: null,
                email: "mali@example.test",
                id: "30000000-0000-4000-8000-000000000001",
              },
            },
          });
        return json({
          data: {
            access: access("TRIAL"),
            canManage: true,
            enabled: true,
            subscription: null,
          },
        });
      }),
    );
    renderPage(<PricingContent navigate={navigate} />);
    await waitFor(() =>
      expect((subscribeButtons()[0] as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(subscribeButtons()[0]!);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("lets an owner renew from EXPIRED and explains it", async () => {
    world.signedIn = true;
    world.access = access("EXPIRED");
    world.subscription = {
      interval: "MONTH",
      plan: "STARTER",
      status: "EXPIRED",
    };
    renderPage(<PricingContent navigate={vi.fn()} />);
    expect(await screen.findByText(en.pricingExpiredNotice)).toBeTruthy();
    await waitFor(() =>
      expect((subscribeButtons()[0] as HTMLButtonElement).disabled).toBe(false),
    );
    expect(screen.queryByText("Current plan")).toBeNull();
    expect(screen.queryByTestId("active-plan-panel")).toBeNull();
  });

  it("shows the active plan and offers no second subscription", async () => {
    world.signedIn = true;
    world.access = access("ACTIVE");
    world.subscription = { interval: "YEAR", plan: "GROWTH", status: "ACTIVE" };
    renderPage(<PricingContent navigate={vi.fn()} />);
    // One emphasized panel (not a second "Current plan" line) and a highlighted
    // card without a button-like control on the active plan.
    const panel = await screen.findByTestId("active-plan-panel");
    expect(panel.textContent).toContain("Subscription active");
    expect(panel.textContent).toContain("Growth plan · Yearly");
    expect(screen.queryByText(/Current plan:/)).toBeNull();
    const growth = screen
      .getByRole("heading", { name: "Growth", exact: true })
      .closest("article")!;
    expect(within(growth).queryByRole("button")).toBeNull();
    expect(within(growth).getByText("Current plan")).toBeTruthy();
    // Other plans cannot be bought while a subscription is active.
    const others = subscribeButtons();
    expect(others).toHaveLength(2);
    for (const button of others)
      expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("tells a non-owner that the store owner must renew", async () => {
    world.signedIn = true;
    world.role = "CASHIER";
    world.access = access("EXPIRED");
    renderPage(<PricingContent navigate={vi.fn()} />);
    expect(await screen.findByText(en.pricingNonOwnerNotice)).toBeTruthy();
    for (const button of subscribeButtons())
      expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(calls.some((call) => call.url.endsWith("/billing/checkout"))).toBe(
      false,
    );
  });

  it("leads a signed-in visitor without a store to onboarding", async () => {
    world.signedIn = true;
    world.organizations = false;
    renderPage(<PricingContent navigate={vi.fn()} />);
    const links = await screen.findAllByRole("link", {
      name: "Set up your store",
    });
    expect(links[0]!.getAttribute("href")).toBe("/onboarding");
  });

  it("keeps the buttons off when billing is not enabled", async () => {
    world.signedIn = true;
    world.billingEnabled = false;
    renderPage(<PricingContent navigate={vi.fn()} />);
    expect(await screen.findByText(en.billingUnavailable)).toBeTruthy();
    for (const button of subscribeButtons())
      expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("confirms the payment after Stripe returns, then cleans the URL", async () => {
    world.signedIn = true;
    search = new URLSearchParams({
      organizationId: ORG,
      session_id: "cs_test_x1",
    });
    renderPage(<PricingContent navigate={vi.fn()} />);
    expect(
      (await screen.findByTestId("active-plan-panel")).textContent,
    ).toContain("Growth plan · Yearly");
    expect(screen.queryByText("Subscription active: Growth")).toBeNull();
    expect(replace).toHaveBeenCalledWith(`/pricing?organizationId=${ORG}`);
    expect(
      calls.filter((call) => call.url.endsWith("/billing/confirm")),
    ).toHaveLength(1);
  });

  it("notes a canceled checkout", async () => {
    world.signedIn = true;
    search = new URLSearchParams({ organizationId: ORG, canceled: "1" });
    renderPage(<PricingContent navigate={vi.fn()} />);
    expect(await screen.findByText(en.billingCanceledNote)).toBeTruthy();
  });
});
