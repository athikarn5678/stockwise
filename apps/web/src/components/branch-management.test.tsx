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

import {
  createBranch,
  fetchAccessContext,
  fetchBranches,
} from "@/branch-api-client";

import { BranchManagement } from "./branch-management";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const BRANCH_ID = "20000000-0000-4000-8000-000000000001";

vi.mock("next/navigation", () => ({
  useSearchParams: () =>
    new URLSearchParams({
      branchId: BRANCH_ID,
      organizationId: ORGANIZATION_ID,
    }),
}));

vi.mock("@/branch-api-client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/branch-api-client")>();
  return {
    ...original,
    changeBranchLifecycle: vi.fn(),
    createBranch: vi.fn(),
    fetchAccessContext: vi.fn(),
    fetchBranches: vi.fn(),
    updateBranch: vi.fn(),
  };
});

const accessContext = {
  firstOrganizationOnboarding: { eligible: false },
  organizations: [
    {
      branches: [{ code: "MAIN", id: BRANCH_ID, name: "Main" }],
      id: ORGANIZATION_ID,
      name: "Store",
      role: "OWNER" as const,
    },
  ],
  user: {
    displayName: "Owner",
    email: "owner@example.com",
    id: "30000000-0000-4000-8000-000000000001",
  },
};
const branch = {
  address: null,
  code: "MAIN",
  id: BRANCH_ID,
  name: "Main",
  organizationId: ORGANIZATION_ID,
  phone: null,
  status: "ACTIVE" as const,
  updatedAt: "2026-08-24T12:00:00.000Z",
};

function renderManagement() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <BranchManagement />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(fetchAccessContext).mockResolvedValue(accessContext);
  vi.mocked(fetchBranches).mockResolvedValue([branch]);
  vi.mocked(createBranch).mockResolvedValue({
    ...branch,
    code: "BKK-1",
    id: "20000000-0000-4000-8000-000000000002",
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("branch management UI", () => {
  it("presents create, edit, and lifecycle controls to an OWNER", async () => {
    renderManagement();

    expect(
      await screen.findByRole("heading", { name: "Branches" }),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Create branch" })).toBeTruthy();
    expect(
      await screen.findByRole("button", { name: "Save changes" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Deactivate" })).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/^Code/), {
      target: { value: " bkk-1 " },
    });
    fireEvent.change(screen.getAllByLabelText("Name")[0]!, {
      target: { value: " Branch " },
    });
    fireEvent.submit(
      screen.getByRole("heading", { name: "Create branch" }).closest("form")!,
    );

    await waitFor(() =>
      expect(createBranch).toHaveBeenCalledWith(ORGANIZATION_ID, {
        address: "",
        code: " bkk-1 ",
        name: " Branch ",
        phone: "",
      }),
    );
  });

  it("does not load or present management controls to a branch-only role", async () => {
    vi.mocked(fetchAccessContext).mockResolvedValue({
      ...accessContext,
      organizations: [{ ...accessContext.organizations[0]!, role: "CASHIER" }],
    });
    renderManagement();

    expect(
      await screen.findByRole("heading", {
        name: "Branch management unavailable",
      }),
    ).toBeTruthy();
    expect(fetchBranches).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "Create branch" })).toBeNull();
  });
});
