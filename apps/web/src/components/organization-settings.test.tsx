// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchAccessContext, type AccessContext } from "@/branch-api-client";
import {
  OrganizationApiError,
  fetchOrganizationSettings,
  updateOrganizationSettings,
} from "@/organization-api-client";
import { LanguageProvider } from "@/providers/language-provider";
import { SessionLifecycleProvider } from "@/providers/session-lifecycle-provider";
import { AppShell } from "@/components/app-shell";
import { OrganizationSettings } from "./organization-settings";
import { en } from "@/i18n/en";
import { th } from "@/i18n/th";

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(`organizationId=${ORG_ID}`),
  usePathname: () => "/app/organization-settings",
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/branch-api-client", () => ({
  BranchApiError: class BranchApiError extends Error {
    constructor(readonly kind: string) {
      super(kind);
    }
  },
  fetchAccessContext: vi.fn(),
}));
vi.mock("@/organization-api-client", () => ({
  OrganizationApiError: class OrganizationApiError extends Error {
    constructor(readonly kind: string) {
      super(kind);
    }
  },
  fetchOrganizationSettings: vi.fn(),
  updateOrganizationSettings: vi.fn(),
}));

const ORG_ID = "30000000-0000-4000-8000-000000000001";
const updatedAt = "2026-10-25T10:20:30.123Z";
const organization = { id: ORG_ID, name: "North Store", updatedAt };
const context = (
  role: "OWNER" | "ADMIN" | "CASHIER",
  name = organization.name,
) => ({
  firstOrganizationOnboarding: { eligible: false },
  user: {
    id: "30000000-0000-4000-8000-000000000002",
    email: "owner@example.com",
    displayName: "Owner",
  },
  organizations: [{ id: ORG_ID, name, role, branches: [] }],
});

function renderSettings(role: "OWNER" | "ADMIN" | "CASHIER" = "OWNER") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  vi.mocked(fetchAccessContext).mockResolvedValue(context(role));
  render(
    <QueryClientProvider client={client}>
      <LanguageProvider>
        <OrganizationSettings />
      </LanguageProvider>
    </QueryClientProvider>,
  );
  return client;
}

function renderSettingsWithLifecycle() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <SessionLifecycleProvider>
        <LanguageProvider>
          <AppShell>
            <OrganizationSettings />
          </AppShell>
        </LanguageProvider>
      </SessionLifecycleProvider>
    </QueryClientProvider>,
  );
  return client;
}

function deferred<T>() {
  const { promise, resolve } = Promise.withResolvers<T>();
  return { promise, resolve };
}

beforeEach(() => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  vi.stubGlobal("BroadcastChannel", undefined);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("organization settings", () => {
  it("restricts settings to owner and admin roles", async () => {
    vi.mocked(fetchOrganizationSettings).mockResolvedValue(organization);
    renderSettings("CASHIER");
    expect((await screen.findByRole("alert")).textContent).toContain(
      "You do not have permission",
    );
    expect(fetchOrganizationSettings).not.toHaveBeenCalled();
  });

  it("validates, cancels, saves a trimmed name and refreshes the shared organization name", async () => {
    vi.mocked(fetchOrganizationSettings).mockResolvedValue(organization);
    const updated = {
      ...organization,
      name: "New  Store",
      updatedAt: "2026-10-25T10:20:31.456Z",
    };
    vi.mocked(updateOrganizationSettings).mockResolvedValue(updated);
    const client = renderSettings("ADMIN");
    const input = await screen.findByLabelText("Organization name");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Enter an organization name",
    );
    fireEvent.change(input, { target: { value: "  New  Store  " } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(input).toHaveProperty("value", "North Store");
    fireEvent.change(input, { target: { value: "  New  Store  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByRole("status");
    expect(updateOrganizationSettings).toHaveBeenCalledWith(ORG_ID, {
      name: "New  Store",
      expectedUpdatedAt: updatedAt,
    });
    await waitFor(() =>
      expect(client.getQueryData(["access-context"])).toMatchObject({
        organizations: [{ id: ORG_ID, name: "New  Store" }],
      }),
    );
    expect(client.getQueryData(["organization-settings", ORG_ID])).toEqual(
      updated,
    );
  });

  it.each([
    { language: "en", copy: en },
    { language: "th", copy: th },
  ])(
    "announces server validation in $language, preserves the draft and accepts a corrected retry",
    async ({ language, copy }) => {
      const languagePreference = vi
        .spyOn(Storage.prototype, "getItem")
        .mockReturnValue(language);
      try {
        vi.mocked(fetchOrganizationSettings).mockResolvedValue(organization);
        const updated = {
          ...organization,
          name: "Corrected Store",
          updatedAt: "2026-10-25T10:20:32.456Z",
        };
        vi.mocked(updateOrganizationSettings)
          .mockReset()
          .mockRejectedValueOnce(new OrganizationApiError("validation"))
          .mockResolvedValueOnce(updated);
        const client = renderSettings("ADMIN");
        const input = await screen.findByLabelText(
          copy.organizationSettingsName,
        );
        const save = screen.getByRole("button", { name: copy.saveChanges });
        const cancel = screen.getByRole("button", { name: copy.cancel });
        fireEvent.change(input, { target: { value: "Server rejected draft" } });
        fireEvent.click(save);

        const alert = await screen.findByRole("alert");
        expect(alert.textContent).toBe(copy.organizationSettingsValidation);
        expect(screen.getAllByRole("alert")).toHaveLength(1);
        expect(input).toHaveProperty("value", "Server rejected draft");
        expect(input).toHaveProperty("disabled", false);
        expect(input.getAttribute("aria-invalid")).toBe("true");
        expect(input.getAttribute("aria-describedby")).toBe(alert.id);
        expect(save).toHaveProperty("disabled", false);
        expect(cancel).toHaveProperty("disabled", false);

        fireEvent.change(input, { target: { value: "   " } });
        expect(screen.queryByRole("alert")).toBeNull();
        fireEvent.click(save);
        expect(screen.getAllByRole("alert")).toHaveLength(1);
        expect(screen.getByRole("alert").textContent).toBe(
          copy.organizationSettingsValidation,
        );
        expect(updateOrganizationSettings).toHaveBeenCalledTimes(1);

        fireEvent.change(input, { target: { value: "Corrected Store" } });
        expect(screen.queryByRole("alert")).toBeNull();
        fireEvent.click(save);
        await screen.findByText(copy.organizationSettingsSaved);
        expect(input).toHaveProperty("value", updated.name);
        expect(input).toHaveProperty("disabled", false);
        expect(screen.queryByRole("alert")).toBeNull();
        expect(input.getAttribute("aria-invalid")).not.toBe("true");
        expect(input.getAttribute("aria-describedby")).toBeNull();
        expect(client.getQueryData(["organization-settings", ORG_ID])).toEqual(
          updated,
        );
        expect(
          client.getQueryData<AccessContext>(["access-context"])
            ?.organizations[0]?.name,
        ).toBe(updated.name);
        expect(updateOrganizationSettings).toHaveBeenLastCalledWith(ORG_ID, {
          name: updated.name,
          expectedUpdatedAt: updatedAt,
        });
      } finally {
        languagePreference.mockRestore();
        vi.mocked(updateOrganizationSettings).mockReset();
      }
    },
  );

  it("does not retain or restore an edit rejected as forbidden through session reconciliation", async () => {
    const pendingAccess = deferred<AccessContext>();
    vi.mocked(fetchAccessContext)
      .mockResolvedValueOnce(context("OWNER"))
      .mockReturnValue(pendingAccess.promise);
    vi.mocked(fetchOrganizationSettings).mockResolvedValue(organization);
    vi.mocked(updateOrganizationSettings).mockRejectedValue(
      new OrganizationApiError("forbidden"),
    );
    const client = renderSettingsWithLifecycle();

    const input = await screen.findByLabelText("Organization name");
    fireEvent.change(input, { target: { value: "Forbidden draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByRole("alert");
    await waitFor(() =>
      expect(client.getQueryState(["access-context"])?.fetchStatus).toBe(
        "fetching",
      ),
    );

    fireEvent.blur(window);
    fireEvent.focus(window);
    await waitFor(() =>
      expect(screen.queryByLabelText("Organization name")).toBeNull(),
    );
    pendingAccess.resolve(context("OWNER"));

    const restoredInput = await screen.findByLabelText("Organization name");
    expect(restoredInput).toHaveProperty("value", "North Store");
    expect(screen.getByRole("button", { name: "Save changes" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(updateOrganizationSettings).toHaveBeenCalledTimes(1);
  });

  it("keeps the organization name unchanged while a save is pending", async () => {
    vi.mocked(fetchOrganizationSettings).mockResolvedValue(organization);
    const pendingUpdate = deferred<typeof organization>();
    vi.mocked(updateOrganizationSettings).mockReturnValue(
      pendingUpdate.promise,
    );
    renderSettings();

    const input = await screen.findByLabelText("Organization name");
    fireEvent.change(input, { target: { value: "Pending Store" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(input).toHaveProperty("disabled", true);
    fireEvent.change(input, { target: { value: "Injected while saving" } });
    expect(input).toHaveProperty("value", "Pending Store");
    pendingUpdate.resolve({
      ...organization,
      name: "Pending Store",
      updatedAt: "2026-10-25T10:20:31.456Z",
    });
    await screen.findByText("Organization name saved.");
    expect(input).toHaveProperty("value", "Pending Store");
  });

  it("holds a stale edit until explicit reload and adopts the new server version", async () => {
    vi.mocked(fetchOrganizationSettings)
      .mockResolvedValueOnce(organization)
      .mockResolvedValueOnce({
        ...organization,
        name: "Remote Store",
        updatedAt: "2026-10-25T10:20:31.123Z",
      });
    vi.mocked(updateOrganizationSettings).mockRejectedValue(
      new OrganizationApiError("stale"),
    );
    renderSettings();
    const input = await screen.findByLabelText("Organization name");
    fireEvent.change(input, { target: { value: "Local Store" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/changed elsewhere/)).toBeTruthy();
    expect(input).toHaveProperty("value", "Local Store");
    fireEvent.click(
      screen.getByRole("button", { name: "Reload organization" }),
    );
    await waitFor(() => expect(input).toHaveProperty("value", "Remote Store"));
    fireEvent.change(input, { target: { value: "Next Store" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(updateOrganizationSettings).toHaveBeenLastCalledWith(ORG_ID, {
        name: "Next Store",
        expectedUpdatedAt: "2026-10-25T10:20:31.123Z",
      }),
    );
  });
});
