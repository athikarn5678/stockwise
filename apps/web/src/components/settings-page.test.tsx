// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LanguageProvider } from "@/providers/language-provider";
import { SettingsPage } from "./settings-page";

const ORG = "10000000-0000-4000-8000-000000000001";
const mocks = vi.hoisted(() => ({ fetchAccessContext: vi.fn() }));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(`organizationId=${ORG}`),
}));
vi.mock("@/branch-api-client", () => ({
  fetchAccessContext: mocks.fetchAccessContext,
}));
vi.mock("@/components/self-profile", () => ({
  SelfProfile: ({ embedded }: { embedded?: boolean }) => (
    <p>profile form {embedded ? "embedded" : "page"}</p>
  ),
}));
vi.mock("@/components/organization-settings", () => ({
  OrganizationSettings: ({ embedded }: { embedded?: boolean }) => (
    <p>organization form {embedded ? "embedded" : "page"}</p>
  ),
}));

function context(role: string) {
  return {
    firstOrganizationOnboarding: { eligible: false },
    organizations: [{ branches: [], id: ORG, name: "Store", role }],
    user: { displayName: "Someone", email: "x@example.test", id: "user" },
  };
}

function renderPage() {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <LanguageProvider>
        <SettingsPage />
      </LanguageProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => mocks.fetchAccessContext.mockReset());
afterEach(() => cleanup());

describe("Settings page", () => {
  it.each(["OWNER", "ADMIN"])(
    "shows the profile and organization cards to %s",
    async (role) => {
      mocks.fetchAccessContext.mockResolvedValue(context(role));
      renderPage();
      expect(
        await screen.findByText("organization form embedded"),
      ).toBeTruthy();
      expect(screen.getByText("profile form embedded")).toBeTruthy();
      expect(
        screen.getByRole("heading", { level: 1, name: "Settings" }),
      ).toBeTruthy();
      expect(screen.getByLabelText("Organization settings")).toBeTruthy();
    },
  );

  it.each(["BRANCH_MANAGER", "INVENTORY_STAFF", "CASHIER"])(
    "shows only the profile card to %s",
    async (role) => {
      mocks.fetchAccessContext.mockResolvedValue(context(role));
      renderPage();
      expect(await screen.findByText("profile form embedded")).toBeTruthy();
      await vi.waitFor(() =>
        expect(mocks.fetchAccessContext).toHaveBeenCalled(),
      );
      expect(screen.queryByText("organization form embedded")).toBeNull();
      expect(screen.queryByLabelText("Organization settings")).toBeNull();
    },
  );
});
