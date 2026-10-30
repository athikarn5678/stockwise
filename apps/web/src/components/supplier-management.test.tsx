// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAccessContext } from "@/branch-api-client";
import { SupplierManagement } from "./supplier-management";

const organizationId = "10000000-0000-4000-8000-000000000001";
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams({ organizationId }),
}));
vi.mock("@/branch-api-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/branch-api-client")>()),
  fetchAccessContext: vi.fn(),
}));

function setup(
  failure?: "create" | "list",
  role: "OWNER" | "INVENTORY_STAFF" = "OWNER",
) {
  vi.mocked(fetchAccessContext).mockResolvedValue({
    firstOrganizationOnboarding: { eligible: false },
    organizations: [{ branches: [], id: organizationId, name: "Store", role }],
    user: {
      displayName: "Owner",
      email: "owner@example.test",
      id: "20000000-0000-4000-8000-000000000001",
    },
  });
  const supplier = {
    id: "30000000-0000-4000-8000-000000000001",
    organizationId,
    name: "Tea Supply",
    contactName: null,
    email: null,
    phone: null,
    address: null,
    status: "ACTIVE",
    createdAt: "2026-10-04T00:00:00.000Z",
    updatedAt: "2026-10-04T00:00:00.000Z",
  };
  const persisted: (typeof supplier)[] = [];
  const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
    if (init?.method === "POST") {
      if (failure === "create")
        return new Response(
          JSON.stringify({ error: { code: "VALIDATION_ERROR" } }),
          { status: 400 },
        );
      persisted.push(supplier);
      return new Response(JSON.stringify({ data: { supplier } }), {
        status: 201,
      });
    }
    if (failure === "list" && persisted.length > 0)
      return new Response("unavailable", { status: 503 });
    return new Response(
      JSON.stringify({
        data: { suppliers: persisted },
        meta: { nextCursor: null },
      }),
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <SupplierManagement />
    </QueryClientProvider>,
  );
  return { fetchMock, persisted };
}
async function create() {
  const form = (
    await screen.findByRole("button", { name: "Create supplier" })
  ).closest("form")!;
  const input = form.querySelector<HTMLInputElement>('input[name="name"]')!;
  fireEvent.change(input, { target: { value: "Tea Supply" } });
  fireEvent.submit(form);
  return input;
}
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("Supplier creation through the API client", () => {
  it("denies direct supplier page access to inventory staff before supplier requests", async () => {
    const { fetchMock } = setup(undefined, "INVENTORY_STAFF");
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "Create supplier" }),
    ).toBeNull();
  });
  it("creates once, refreshes the record, and resets the form without a false error", async () => {
    const { fetchMock, persisted } = setup();
    const input = await create();
    await screen.findByRole("heading", { name: "Tea Supply" });
    await waitFor(() => expect(input.value).toBe(""));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      fetchMock.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
    expect(persisted).toHaveLength(1);
  });
  it("retains the input and reports a genuine failed create", async () => {
    const { persisted } = setup("create");
    const input = await create();
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Check the supplier fields and try again.",
    );
    expect(input.value).toBe("Tea Supply");
    expect(persisted).toHaveLength(0);
  });
  it("reports a genuine refresh failure after persistence without retaining duplicate-retry input", async () => {
    const { persisted } = setup("list");
    const input = await create();
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Supplier data could not be loaded. Try again.",
    );
    await waitFor(() => expect(input.value).toBe(""));
    expect(persisted).toHaveLength(1);
  });
});
