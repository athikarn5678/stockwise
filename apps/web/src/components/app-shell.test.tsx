// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import HomePage from "@/app/page";
import { BILLING_CHANGED_EVENT } from "@/billing-api-client";
import { fetchAccessContext } from "@/branch-api-client";
import { RegistrationForm } from "@/components/auth/registration-form";
import { VerificationForm } from "@/components/auth/verification-form";
import { verificationLinkEntryHtml } from "@/verification-link-entry";
import type { VerificationLinkWindow } from "@/verification-link-entry";
import type { CredentialLinkWindow } from "@/credential-link-entry";
import type {
  AccessContext,
  AccessibleOrganization,
} from "@/branch-api-client";

import { AppShell } from "./app-shell";

const replace = vi.fn();
const push = vi.fn();
let pathname = "/app";
let searchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useSearchParams: () => searchParams,
  useRouter: () => ({ replace, push }),
}));

const ORG = "10000000-0000-4000-8000-000000000001";
const BRANCH = "20000000-0000-4000-8000-000000000001";
const guestPaths = [
  "/login",
  "/register",
  "/verification-resend",
  "/forgot-password",
  "/reset-password",
  "/verify-email",
];

function accessContext(
  role: AccessibleOrganization["role"] = "OWNER",
): AccessContext {
  return {
    firstOrganizationOnboarding: { eligible: false },
    organizations: [
      {
        branches: [{ code: "MAIN", id: BRANCH, name: "Main branch" }],
        id: ORG,
        name: "Store",
        role,
      },
    ],
    user: {
      displayName: "Owner",
      email: "owner@example.test",
      id: "30000000-0000-4000-8000-000000000001",
    },
  };
}

function renderShell(
  context?: AccessContext,
  children = <p>Module content</p>,
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  }),
) {
  if (context) client.setQueryData(["access-context"], context);
  render(
    <QueryClientProvider client={client}>
      <AppShell>{children}</AppShell>
    </QueryClientProvider>,
  );
  return client;
}

beforeEach(() => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  );
  pathname = "/app";
  searchParams = new URLSearchParams();
  replace.mockReset();
  push.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: "AUTHENTICATION_REQUIRED" },
        }),
        { status: 401 },
      ),
    ),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (window as VerificationLinkWindow).__stockwiseTakeVerificationLink;
  delete (window as CredentialLinkWindow).__stockwiseTakeCredentialLink;
  window.history.replaceState(null, "", "/");
});

describe("web application shell", () => {
  it.each(["/reset-password", "/accept-invitation"])(
    "abandons an unclaimed %s credential when switching to another credential route",
    (owningPath) => {
      pathname = owningPath;
      const sessionCheck = Promise.withResolvers<Response>();
      vi.mocked(fetch).mockReturnValue(sessionCheck.promise);
      const dispose = vi.fn(() => {
        delete (window as CredentialLinkWindow).__stockwiseTakeCredentialLink;
        return { route: owningPath, token: null };
      });
      Object.defineProperty(window, "__stockwiseTakeCredentialLink", {
        configurable: true,
        value: dispose,
      });
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const content = () => (
        <QueryClientProvider client={client}>
          <AppShell>
            <p>Pending protected form</p>
          </AppShell>
        </QueryClientProvider>
      );
      const view = render(content());
      expect(dispose).not.toHaveBeenCalled();
      // Neither protected form mounts: access-context is still pending.
      pathname =
        owningPath === "/reset-password"
          ? "/accept-invitation"
          : "/reset-password";
      view.rerender(content());
      expect(dispose).toHaveBeenCalledTimes(1);
      // Back must not revive the credential from the previous route visit.
      pathname = owningPath;
      view.rerender(content());
      expect(dispose).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["network", "503", "malformed"])(
    "retries a guest %s failure without form flash until explicit 401",
    async (failure) => {
      pathname = "/register";
      if (failure === "network")
        vi.mocked(fetch).mockRejectedValueOnce(new Error("offline"));
      else
        vi.mocked(fetch).mockResolvedValueOnce(
          new Response("{}", { status: failure === "503" ? 503 : 200 }),
        );
      renderShell(undefined, <RegistrationForm />);
      await screen.findByRole("alert");
      expect(screen.queryByLabelText("Password")).toBeNull();
      const pending = Promise.withResolvers<Response>();
      vi.mocked(fetch).mockReturnValueOnce(pending.promise);
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      expect(screen.queryByLabelText("Password")).toBeNull();
      pending.resolve(
        new Response(
          JSON.stringify({ error: { code: "AUTHENTICATION_REQUIRED" } }),
          { status: 401 },
        ),
      );
      await screen.findByLabelText("Password");
      expect(replace).not.toHaveBeenCalled();
    },
  );

  it("retries a guest failure to fresh authenticated context without exposing a form", async () => {
    pathname = "/login";
    vi.mocked(fetch).mockResolvedValueOnce(new Response("{}", { status: 503 }));
    renderShell(undefined, <RegistrationForm />);
    await screen.findByRole("alert");
    const pending = Promise.withResolvers<Response>();
    vi.mocked(fetch).mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.queryByLabelText("Password")).toBeNull();
    pending.resolve(new Response(JSON.stringify({ data: accessContext() })));
    // A signed-in visit to /login returns to the landing page by default.
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it("renders public landmarks without waiting for the session probe", async () => {
    pathname = "/";
    renderShell(undefined, <HomePage />);
    expect(
      screen.getByRole("heading", { name: /Run your inventory with clarity/ }),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Skip to main content" })
        .getAttribute("href"),
    ).toBe("#main-content");
    expect(screen.getByRole("main").id).toBe("main-content");
    const publicNav = within(
      screen.getByRole("navigation", { name: "Public navigation" }),
    );
    // Guests get one call to action; a probe only decides the account slot.
    expect(
      (
        await publicNav.findByRole("link", { name: "Get started" })
      ).getAttribute("href"),
    ).toBe("/login");
    expect(publicNav.queryByRole("link", { name: "Sign in" })).toBeNull();
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(screen.queryByRole("link", { name: "Home" })).toBeNull();
    expect(
      vi
        .mocked(fetch)
        .mock.calls.every(([url]) =>
          String(url).endsWith("/me/access-context"),
        ),
    ).toBe(true);
  });

  it("does not offer Sign in after access context confirms authentication", () => {
    renderShell(accessContext());
    expect(screen.queryByRole("link", { name: "Sign in" })).toBeNull();
    expect(screen.getByRole("button", { name: "Log out" })).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "Primary navigation" });
    expect(
      within(nav).getByRole("link", { name: "Home" }).getAttribute("href"),
    ).toBe(`/app?organizationId=${ORG}&branchId=${BRANCH}`);
    expect(
      within(nav).getByRole("link", { name: "Inventory" }).getAttribute("href"),
    ).toBe(`/app/inventory?organizationId=${ORG}&branchId=${BRANCH}`);
    expect(
      within(nav)
        .getByRole("link", { name: "Point of sale" })
        .getAttribute("href"),
    ).toBe(`/app/pos?organizationId=${ORG}&branchId=${BRANCH}`);
    expect(
      within(nav)
        .getByRole("link", { name: "Sales history" })
        .getAttribute("href"),
    ).toBe(`/app/sales?organizationId=${ORG}&branchId=${BRANCH}`);
    expect(
      within(nav)
        .getByRole("link", { name: "Organization settings" })
        .getAttribute("href"),
    ).toBe(
      `/app/organization-settings?organizationId=${ORG}&branchId=${BRANCH}`,
    );
    for (const logo of screen.getAllByRole("link", { name: "StockWise" })) {
      expect(logo.getAttribute("href")).toBe(
        `/app?organizationId=${ORG}&branchId=${BRANCH}`,
      );
    }
  });

  it.each(guestPaths)(
    "opens authenticated Home from %s without showing public auth content",
    async (path) => {
      pathname = path;
      // A fresh Response per call: a body can be read only once, and the
      // shell's silent billing request may share this stub.
      vi.mocked(fetch).mockImplementation(
        async () => new Response(JSON.stringify({ data: accessContext() })),
      );
      renderShell(accessContext(), <p>Public authentication form</p>);
      expect(screen.queryByText("Public authentication form")).toBeNull();
      await waitFor(() =>
        expect(replace).toHaveBeenCalledWith(
          // Sign-in pages return to the landing page; other guest pages
          // (register, recovery) open the workspace.
          path === "/login"
            ? "/"
            : `/app?organizationId=${ORG}&branchId=${BRANCH}`,
        ),
      );
      expect(screen.queryByText("Public authentication form")).toBeNull();
    },
  );

  it.each(guestPaths)(
    "waits for explicit 401 before exposing %s to an anonymous or pending user",
    async (path) => {
      pathname = path;
      renderShell(undefined, <p>Guest form</p>);
      expect(screen.getByText(/Loading access/)).toBeTruthy();
      expect(screen.queryByText("Guest form")).toBeNull();
      await waitFor(() => expect(screen.getByText("Guest form")).toBeTruthy());
      expect(replace).not.toHaveBeenCalled();
    },
  );

  it.each(guestPaths)(
    "fails closed on unavailable access context at %s",
    async (path) => {
      pathname = path;
      vi.mocked(fetch).mockResolvedValue(new Response("{}", { status: 503 }));
      renderShell(undefined, <RegistrationForm />);
      expect(screen.queryByLabelText("Password")).toBeNull();
      expect((await screen.findByRole("alert")).textContent).toContain(
        "access context could not be loaded",
      );
      expect(
        screen.queryByRole("button", { name: "Create account" }),
      ).toBeNull();
      expect(replace).not.toHaveBeenCalled();
    },
  );

  it("does not trust a cached 401 when a guest entry rechecks a valid session", async () => {
    pathname = "/register";
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    await expect(
      client.fetchQuery({
        queryKey: ["access-context"],
        queryFn: fetchAccessContext,
      }),
    ).rejects.toMatchObject({ kind: "authentication_required" });
    const response = Promise.withResolvers<Response>();
    vi.mocked(fetch).mockReturnValue(response.promise);
    renderShell(undefined, <RegistrationForm />, client);
    expect(screen.queryByLabelText("Password")).toBeNull();
    response.resolve(new Response(JSON.stringify({ data: accessContext() })));
    await waitFor(() => expect(replace).toHaveBeenCalled());
    expect(client.getQueryData(["access-context"])).toEqual(accessContext());
    expect(screen.queryByLabelText("Password")).toBeNull();
  });

  it.each([403, 200])(
    "does not treat an unknown %s access-context response as anonymous",
    async (status) => {
      pathname = "/login";
      vi.mocked(fetch).mockResolvedValue(new Response("{}", { status }));
      renderShell(undefined, <RegistrationForm />);
      await screen.findByRole("alert");
      expect(screen.queryByLabelText("Password")).toBeNull();
      expect(replace).not.toHaveBeenCalled();
    },
  );

  it.each([403, 503])(
    "requires HTTP 401, not merely an auth error code on %s",
    async (status) => {
      pathname = "/register";
      vi.mocked(fetch).mockResolvedValue(
        new Response(
          JSON.stringify({ error: { code: "AUTHENTICATION_REQUIRED" } }),
          { status },
        ),
      );
      renderShell(undefined, <RegistrationForm />);
      await screen.findByRole("alert");
      expect(screen.queryByLabelText("Password")).toBeNull();
      expect(replace).not.toHaveBeenCalled();
    },
  );

  it("keeps stale authenticated guest content suppressed if revalidation fails", async () => {
    pathname = "/register";
    vi.mocked(fetch).mockRejectedValue(new Error("synthetic unavailable"));
    renderShell(accessContext(), <RegistrationForm />);
    expect(screen.queryByLabelText("Password")).toBeNull();
    await screen.findByRole("alert");
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });

  it.each(["/accept-invitation", "/onboarding", "/missing"])(
    "does not apply guest redirection to authenticated %s",
    (path) => {
      pathname = path;
      renderShell(accessContext());
      expect(screen.getByText("Module content")).toBeTruthy();
      expect(replace).not.toHaveBeenCalled();
    },
  );

  it("shows an authenticated visitor the mailbox-link status action without redirecting or auto-submitting", async () => {
    pathname = "/verify-email";
    window.history.replaceState(
      null,
      "",
      `/verify-email?token=${"a".repeat(43)}`,
    );
    const script = new DOMParser()
      .parseFromString(verificationLinkEntryHtml, "text/html")
      .querySelector("script")!.textContent;
    new Function(
      "window",
      "location",
      "history",
      "addEventListener",
      "fetch",
      script,
    )(
      window,
      window.location,
      window.history,
      window.addEventListener.bind(window),
      () => Promise.withResolvers().promise,
    );
    expect(window.location.search).toBe("");
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ data: accessContext() })),
    );
    renderShell(undefined, <VerificationForm />);
    await screen.findByRole("button", { name: "Check verification link" });
    expect(replace).not.toHaveBeenCalled();
    expect(
      (window as VerificationLinkWindow).__stockwiseTakeVerificationLink,
    ).toBeUndefined();
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(
      vi
        .mocked(fetch)
        .mock.calls.every(
          ([, options]) => !options?.method || options.method === "GET",
        ),
    ).toBe(true);
  });

  it("routes marketing Get Started to the login guard without a form flash", async () => {
    pathname = "/";
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    const view = render(
      <QueryClientProvider client={client}>
        <AppShell>
          <HomePage />
        </AppShell>
      </QueryClientProvider>,
    );
    const cta = await within(
      screen.getByRole("navigation", { name: "Public navigation" }),
    ).findByRole("link", { name: "Get started" });
    expect(cta.getAttribute("href")).toBe("/login");
    pathname = cta.getAttribute("href")!;
    const response = Promise.withResolvers<Response>();
    vi.mocked(fetch).mockReturnValue(response.promise);
    view.rerender(
      <QueryClientProvider client={client}>
        <AppShell>
          <RegistrationForm />
        </AppShell>
      </QueryClientProvider>,
    );
    expect(screen.queryByLabelText("Password")).toBeNull();
    response.resolve(new Response(JSON.stringify({ data: accessContext() })));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
    expect(screen.queryByRole("button", { name: "Create account" })).toBeNull();
  });
  it.each(["/", "/pricing"])(
    "keeps %s public when access context is already authenticated",
    (path) => {
      pathname = path;
      renderShell(accessContext());
      expect(screen.getByText("Module content")).toBeTruthy();
      expect(
        screen.getByRole("navigation", { name: "Public navigation" }),
      ).toBeTruthy();
      expect(screen.queryByRole("complementary")).toBeNull();
      expect(screen.queryByRole("button", { name: "Log out" })).toBeNull();
      expect(replace).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["OWNER", true, true, true, true],
    ["ADMIN", true, true, true, true],
    ["BRANCH_MANAGER", false, true, true, true],
    ["INVENTORY_STAFF", false, false, true, false],
    ["CASHIER", false, true, false, false],
  ] as const)(
    "preserves %s navigation visibility from server context",
    (role, manage, sales, analytics, suppliers) => {
      renderShell(accessContext(role));
      expect(!!screen.queryByRole("link", { name: "Manage branches" })).toBe(
        manage,
      );
      expect(!!screen.queryByRole("link", { name: "Manage members" })).toBe(
        manage,
      );
      expect(!!screen.queryByRole("link", { name: "Point of sale" })).toBe(
        sales,
      );
      expect(!!screen.queryByRole("link", { name: "Sales history" })).toBe(
        sales,
      );
      expect(!!screen.queryByRole("link", { name: "Analytics" })).toBe(
        analytics,
      );
      expect(!!screen.queryByRole("link", { name: "AI analysis" })).toBe(
        role === "OWNER" || role === "ADMIN" || role === "BRANCH_MANAGER",
      );
      expect(!!screen.queryByRole("link", { name: "Suppliers" })).toBe(
        suppliers,
      );
      expect(!!screen.queryByRole("link", { name: "Purchase orders" })).toBe(
        suppliers,
      );
      expect(!!screen.queryByRole("link", { name: "Catalog" })).toBe(
        role !== "INVENTORY_STAFF",
      );
      expect(
        !!screen.queryByRole("link", { name: "Organization settings" }),
      ).toBe(manage);
    },
  );

  it("uses resolved scope rather than forged URL candidates and marks the active module", () => {
    pathname = "/app/catalog";
    searchParams = new URLSearchParams({
      organizationId: "unavailable",
      branchId: "revoked",
    });
    renderShell(accessContext());
    const catalog = screen.getByRole("link", { name: "Catalog" });
    expect(catalog.getAttribute("href")).toBe(
      `/app/catalog?organizationId=${ORG}&branchId=${BRANCH}`,
    );
    expect(catalog.getAttribute("aria-current")).toBe("page");
    expect(
      screen.getByRole("link", { name: "Home" }).getAttribute("aria-current"),
    ).toBeNull();
  });

  it("hides AI analysis from a branch manager without an assigned branch", () => {
    const context = accessContext("BRANCH_MANAGER");
    context.organizations[0]!.branches = [];
    renderShell(context);
    expect(screen.queryByRole("link", { name: "AI analysis" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Analytics" })).toBeNull();
  });

  it("hides branch operations when no effective branch remains", () => {
    const context = accessContext("INVENTORY_STAFF");
    context.organizations[0]!.branches = [];
    renderShell(context);
    for (const name of [
      "Inventory",
      "Point of sale",
      "Sales history",
      "Purchase orders",
      "Analytics",
    ]) {
      expect(screen.queryByRole("link", { name })).toBeNull();
    }
    expect(screen.queryByRole("link", { name: "Catalog" })).toBeNull();
  });

  it("keeps logout available for an authenticated user without organization access", () => {
    const context = accessContext();
    context.organizations = [];
    renderShell(context);
    expect(
      screen.getByRole("link", { name: "Home" }).getAttribute("href"),
    ).toBe("/app");
    expect(screen.getByRole("button", { name: "Log out" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Catalog" })).toBeNull();
  });

  it("toggles the official desktop sidebar while preserving scoped links", () => {
    renderShell(accessContext());
    const menu = screen.getByRole("button", { name: "Menu" });
    expect(menu.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(menu);
    expect(menu.getAttribute("aria-expanded")).toBe("false");
    expect(
      screen.getByRole("link", { name: "Catalog" }).getAttribute("href"),
    ).toBe(`/app/catalog?organizationId=${ORG}&branchId=${BRANCH}`);
    fireEvent.click(menu);
    expect(menu.getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps keyboard focus on the trigger when the desktop sidebar collapses", () => {
    renderShell(accessContext());
    const menu = screen.getByRole("button", { name: "Menu" });
    const sidebar = document.querySelector(
      '[data-slot="sidebar"]',
    ) as HTMLElement;
    const catalog = screen.getByRole("link", { name: "Catalog" });
    expect(sidebar.hasAttribute("inert")).toBe(false);
    catalog.focus();
    expect(document.activeElement).toBe(catalog);
    fireEvent.click(menu);
    expect(menu.getAttribute("aria-expanded")).toBe("false");
    expect(sidebar.hasAttribute("inert")).toBe(true);
    expect(document.activeElement).toBe(menu);
    fireEvent.click(menu);
    expect(menu.getAttribute("aria-expanded")).toBe("true");
    expect(sidebar.hasAttribute("inert")).toBe(false);
    catalog.focus();
    expect(document.activeElement).toBe(catalog);
  });

  it("removes authenticated destinations after access-context revalidation rejects the session", async () => {
    const client = renderShell(accessContext());
    await client.invalidateQueries({ queryKey: ["access-context"] });
    await waitFor(() => expect(screen.queryByRole("complementary")).toBeNull());
    // The header link and the session-expired card both offer a real sign-in.
    expect(screen.getAllByRole("link", { name: "Sign in" })).toHaveLength(2);
    const card = screen.getByTestId("session-expired");
    expect(within(card).getByText("Session ended")).toBeTruthy();
    expect(
      within(card).getByRole("link", { name: "Sign in" }).getAttribute("href"),
    ).toBe("/login?next=%2Fapp");
    expect(screen.queryByRole("button", { name: "Log out" })).toBeNull();
  });

  it("shows the plan badge but no Billing navigation for an owner with billing enabled", async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).endsWith(`/organizations/${ORG}/billing`))
        return new Response(
          JSON.stringify({
            data: {
              access: {
                state: "ACTIVE",
                trialDaysLeft: null,
                trialEndsAt: null,
              },
              canManage: true,
              enabled: true,
              subscription: {
                interval: "MONTH",
                plan: "STARTER",
                status: "ACTIVE",
              },
            },
          }),
        );
      return new Response(JSON.stringify({ error: { code: "NOT_FOUND" } }), {
        status: 404,
      });
    });
    renderShell(accessContext());
    expect(await screen.findByText("Starter")).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "Primary navigation" });
    // Subscribing and renewing live only on /pricing: no billing entry here.
    expect(within(nav).queryByRole("link", { name: "Billing" })).toBeNull();
  });

  it("refetches the plan badge when a subscription is confirmed", async () => {
    let subscription: {
      interval: string;
      plan: string;
      status: string;
    } | null = null;
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).endsWith(`/organizations/${ORG}/billing`))
        return new Response(
          JSON.stringify({
            data: {
              access: null,
              canManage: true,
              enabled: true,
              subscription,
            },
          }),
        );
      return new Response(JSON.stringify({ error: { code: "NOT_FOUND" } }), {
        status: 404,
      });
    });
    renderShell(accessContext());
    await waitFor(() =>
      expect(
        vi
          .mocked(fetch)
          .mock.calls.some(([url]) => String(url).endsWith("/billing")),
      ).toBe(true),
    );
    expect(screen.queryByText("Growth")).toBeNull();
    subscription = { interval: "MONTH", plan: "GROWTH", status: "ACTIVE" };
    act(() => {
      window.dispatchEvent(new Event(BILLING_CHANGED_EVENT));
    });
    expect(await screen.findByText("Growth")).toBeTruthy();
  });

  it("keeps a failed billing read silent: no badge, no Billing link, no error", async () => {
    vi.mocked(fetch).mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: { code: "FORBIDDEN" } }), {
          status: 403,
        }),
    );
    renderShell(accessContext());
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByText("Starter")).toBeNull();
    const nav = screen.getByRole("navigation", { name: "Primary navigation" });
    expect(within(nav).queryByRole("link", { name: "Billing" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  function billingResponse(access: unknown) {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).endsWith(`/organizations/${ORG}/billing`))
        return new Response(
          JSON.stringify({
            data: {
              access,
              canManage: false,
              enabled: true,
              subscription: null,
            },
          }),
        );
      return new Response(JSON.stringify({ error: { code: "NOT_FOUND" } }), {
        status: 404,
      });
    });
  }

  it("shows a read-only banner linking to /pricing when the subscription expired", async () => {
    billingResponse({
      state: "EXPIRED",
      trialDaysLeft: null,
      trialEndsAt: null,
    });
    renderShell(accessContext());
    const banner = await screen.findByTestId("subscription-banner");
    expect(banner.textContent).toContain("read-only");
    expect(
      within(banner)
        .getByRole("link", { name: "View plans" })
        .getAttribute("href"),
    ).toBe("/pricing");
  });

  it("shows the days left in the trial banner and nothing when active", async () => {
    billingResponse({
      state: "TRIAL",
      trialDaysLeft: 3,
      trialEndsAt: "2026-11-21T00:00:00.000Z",
    });
    renderShell(accessContext());
    expect(
      (await screen.findByTestId("subscription-banner")).textContent,
    ).toContain("3 days");
    cleanup();
    billingResponse({
      state: "ACTIVE",
      trialDaysLeft: null,
      trialEndsAt: null,
    });
    renderShell(accessContext());
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByTestId("subscription-banner")).toBeNull();
  });
});
