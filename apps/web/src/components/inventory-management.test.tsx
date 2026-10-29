// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchAccessContext } from "@/branch-api-client";
import {
  createInventoryAdjustment,
  getInventoryItem,
  InventoryApiError,
  listInventory,
  listInventoryHistory,
} from "@/inventory-api-client";

import { InventoryManagement } from "./inventory-management";
import { LanguageProvider } from "@/providers/language-provider";
import { en } from "@/i18n/en";
import { th } from "@/i18n/th";

const scrollIntoView = vi.fn();
const originalScrollIntoView = Object.getOwnPropertyDescriptor(
  Element.prototype,
  "scrollIntoView",
);

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const BRANCH_ID = "20000000-0000-4000-8000-000000000001";
const PRODUCT_ID = "30000000-0000-4000-8000-000000000001";
let role: "OWNER" | "ADMIN" | "BRANCH_MANAGER" | "INVENTORY_STAFF" | "CASHIER" =
  "OWNER";
let currentSearchParams = new URLSearchParams({
  branchId: BRANCH_ID,
  organizationId: ORGANIZATION_ID,
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => currentSearchParams,
}));
vi.mock("@/branch-api-client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/branch-api-client")>();
  return { ...original, fetchAccessContext: vi.fn() };
});
vi.mock("@/inventory-api-client", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/inventory-api-client")>();
  return {
    ...original,
    createInventoryAdjustment: vi.fn(),
    getInventoryItem: vi.fn(),
    listInventory: vi.fn(),
    listInventoryHistory: vi.fn(),
  };
});

const item = {
  balance: { exists: false, quantity: "0", updatedAt: null },
  product: {
    categoryId: null,
    id: PRODUCT_ID,
    name: "Tea",
    sku: "TEA-01",
    status: "ACTIVE" as const,
    unit: "EA" as const,
  },
};

function renderInventory(localized = false) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      {localized ? (
        <LanguageProvider>
          <InventoryManagement />
        </LanguageProvider>
      ) : (
        <InventoryManagement />
      )}
    </QueryClientProvider>,
  );
  return queryClient;
}

beforeEach(() => {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: scrollIntoView,
  });
  role = "OWNER";
  currentSearchParams = new URLSearchParams({
    branchId: BRANCH_ID,
    organizationId: ORGANIZATION_ID,
  });
  vi.mocked(fetchAccessContext).mockImplementation(async () => ({
    firstOrganizationOnboarding: { eligible: false },
    organizations: [
      {
        branches: [{ code: "MAIN", id: BRANCH_ID, name: "Main" }],
        id: ORGANIZATION_ID,
        name: "Store",
        role,
      },
    ],
    user: {
      displayName: "User",
      email: "user@example.com",
      id: "40000000-0000-4000-8000-000000000001",
    },
  }));
  vi.mocked(listInventory).mockResolvedValue({
    data: [item],
    meta: { nextCursor: null },
  });
  vi.mocked(getInventoryItem).mockResolvedValue(item);
  vi.mocked(listInventoryHistory).mockResolvedValue({
    data: [
      {
        actor: {
          displayName: "User",
          id: "40000000-0000-4000-8000-000000000001",
        },
        delta: "2",
        id: "50000000-0000-4000-8000-000000000001",
        note: "Counted",
        occurredAt: "2026-08-30T12:00:00.000Z",
        reason: "STOCK_COUNT",
        source: "MANUAL_ADJUSTMENT",
      },
    ],
    meta: { nextCursor: null },
  });
  vi.mocked(createInventoryAdjustment).mockResolvedValue({
    balance: { quantity: "2" },
    transaction: {
      delta: "2",
      id: "50000000-0000-4000-8000-000000000001",
      note: null,
      occurredAt: "2026-08-30T12:00:00.000Z",
      reason: "STOCK_COUNT",
      source: "MANUAL_ADJUSTMENT",
    },
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
  if (originalScrollIntoView) {
    Object.defineProperty(
      Element.prototype,
      "scrollIntoView",
      originalScrollIntoView,
    );
  } else {
    delete (Element.prototype as Partial<Element>).scrollIntoView;
  }
});

describe("inventory management UI", () => {
  it("scrolls to the newly selected product history without changing the filter", async () => {
    const other = {
      ...item,
      product: {
        ...item.product,
        id: "30000000-0000-4000-8000-000000000002",
        name: "Coffee",
        sku: "COFFEE-01",
      },
    };
    vi.mocked(listInventory).mockResolvedValue({
      data: [item, other],
      meta: { nextCursor: null },
    });
    vi.mocked(getInventoryItem).mockImplementation(
      async (_context, productId) => (productId === PRODUCT_ID ? item : other),
    );
    renderInventory();
    fireEvent.click(await screen.findByRole("button", { name: /Tea/ }));
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
    const status = screen.getByLabelText(en.inventoryProductStatus);
    fireEvent.click(screen.getByRole("button", { name: /Coffee/ }));
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(2));
    expect(status).toHaveProperty("value", "ACTIVE");
    expect(getInventoryItem).toHaveBeenLastCalledWith(
      { organizationId: ORGANIZATION_ID, branchId: BRANCH_ID },
      other.product.id,
    );
    expect(listInventoryHistory).toHaveBeenLastCalledWith(
      { organizationId: ORGANIZATION_ID, branchId: BRANCH_ID },
      other.product.id,
      { cursor: null },
    );
    expect(
      screen
        .getByRole("button", { name: /Coffee/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });
  it.each(["en", "th"] as const)(
    "reveals the selected history after delayed content and on repeated clicks in %s",
    async (language) => {
      localStorage.setItem("stockwise.language", language);
      const detail = Promise.withResolvers<typeof item>();
      const history =
        Promise.withResolvers<
          Awaited<ReturnType<typeof listInventoryHistory>>
        >();
      vi.mocked(getInventoryItem).mockReturnValueOnce(detail.promise);
      vi.mocked(listInventoryHistory).mockReturnValueOnce(history.promise);
      renderInventory(true);
      const button = await screen.findByRole("button", { name: /Tea/ });
      fireEvent.click(button);
      await screen.findByText(
        (language === "th" ? th : en).uiLoadingProductInventory,
      );
      expect(scrollIntoView).not.toHaveBeenCalled();
      await act(async () => detail.resolve(item));
      expect(scrollIntoView).not.toHaveBeenCalled();
      await act(async () =>
        history.resolve({ data: [], meta: { nextCursor: null } }),
      );
      const section = screen.getByRole("region", {
        name: (language === "th" ? th : en).uiTransactionHistory,
      });
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
      expect(scrollIntoView.mock.contexts[0]).toBe(section);
      expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "start" });
      expect(document.activeElement).toBe(section);
      expect(section.className).toContain("scroll-mt-20");
      fireEvent.click(button);
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(2));
      expect(button.getAttribute("aria-pressed")).toBe("true");
      expect(listInventoryHistory).toHaveBeenCalledWith(
        { organizationId: ORGANIZATION_ID, branchId: BRANCH_ID },
        PRODUCT_ID,
        { cursor: null },
      );
    },
  );
  it.each([
    ["MANUAL_ADJUSTMENT", "Manual adjustment"],
    ["PURCHASE_RECEIVE", "Purchase receive"],
    ["SALE", "Sale"],
    ["SALE_REFUND_RETURN", "Sale refund return"],
  ] as const)(
    "labels %s history by its stored provenance",
    async (source, label) => {
      vi.mocked(listInventoryHistory).mockResolvedValue({
        data: [
          {
            actor: {
              displayName: "User",
              id: "40000000-0000-4000-8000-000000000001",
            },
            delta: "2",
            id: "50000000-0000-4000-8000-000000000002",
            note: null,
            occurredAt: "2026-09-02T10:00:00.000Z",
            reason: null,
            source,
          },
        ],
        meta: { nextCursor: null },
      });
      renderInventory();
      await screen.findByText("Tea");
      fireEvent.click(screen.getByRole("button", { name: /Tea/ }));
      expect(await screen.findByText(`+2 · ${label}`)).toBeTruthy();
    },
  );

  it("renders a lazy zero balance and chronological history without numeric conversion", async () => {
    renderInventory();
    expect(
      await screen.findByRole("heading", { name: "Inventory" }),
    ).toBeTruthy();
    await screen.findByText("Tea");
    expect(screen.getByText("0 EA")).toBeTruthy();
    expect(screen.getByText("No persisted balance (zero)")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Tea/ }));
    expect(await screen.findByText("+2 · STOCK COUNT")).toBeTruthy();
    expect(screen.getByText(/2026-08-30 12:00:00 UTC/)).toBeTruthy();
  });

  it("renders a purchase receipt movement without a manual-adjustment reason", async () => {
    vi.mocked(listInventoryHistory).mockResolvedValue({
      data: [
        {
          actor: {
            displayName: "Receiver",
            id: "40000000-0000-4000-8000-000000000001",
          },
          delta: "2",
          id: "50000000-0000-4000-8000-000000000002",
          note: null,
          occurredAt: "2026-09-02T10:00:00.000Z",
          reason: null,
          source: "PURCHASE_RECEIVE",
        },
      ],
      meta: { nextCursor: null },
    });
    renderInventory();
    await screen.findByText("Tea");
    fireEvent.click(screen.getByRole("button", { name: /Tea/ }));
    expect(await screen.findByText("+2 · Purchase receive")).toBeTruthy();
    expect(screen.getAllByText(/Purchase receive/)).toHaveLength(2);
  });

  it.each(["OWNER", "ADMIN", "BRANCH_MANAGER", "INVENTORY_STAFF"] as const)(
    "offers the adjustment form to %s",
    async (adjustmentRole) => {
      role = adjustmentRole;
      renderInventory();
      await screen.findByText("Tea");
      fireEvent.click(screen.getByRole("button", { name: /Tea/ }));
      expect(
        await screen.findByRole("form", { name: "Adjust stock for Tea" }),
      ).toBeTruthy();
    },
  );

  it("keeps the cashier view-only in the UI", async () => {
    role = "CASHIER";
    renderInventory();
    await screen.findByText("Tea");
    fireEvent.click(screen.getByRole("button", { name: /Tea/ }));
    expect(
      screen.queryByRole("form", { name: "Adjust stock for Tea" }),
    ).toBeNull();
    expect(
      (await screen.findByText(/can view inventory but cannot adjust stock/i))
        .textContent,
    ).toMatch(/can view inventory but cannot adjust stock/i);
  });

  it("rejects fractional integer-unit input and OTHER without a note before the API", async () => {
    renderInventory();
    await screen.findByText("Tea");
    fireEvent.click(screen.getByRole("button", { name: /Tea/ }));
    const form = await screen.findByRole("form", {
      name: "Adjust stock for Tea",
    });
    fireEvent.change(screen.getByLabelText("Signed adjustment (EA)"), {
      target: { value: "+1.5" },
    });
    fireEvent.submit(form);
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /check the adjustment/i,
    );
    expect(createInventoryAdjustment).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Signed adjustment (EA)"), {
      target: { value: "+1" },
    });
    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "OTHER" },
    });
    fireEvent.submit(form);
    expect(createInventoryAdjustment).not.toHaveBeenCalled();
  });

  it("submits a string delta with one idempotency key and refreshes the affected branch inventory", async () => {
    const queryClient = renderInventory();
    await screen.findByText("Tea");
    fireEvent.click(screen.getByRole("button", { name: /Tea/ }));
    const form = await screen.findByRole("form", {
      name: "Adjust stock for Tea",
    });
    fireEvent.change(screen.getByLabelText("Signed adjustment (EA)"), {
      target: { value: "+2" },
    });
    fireEvent.submit(form);

    await waitFor(() =>
      expect(createInventoryAdjustment).toHaveBeenCalledWith(
        { branchId: BRANCH_ID, organizationId: ORGANIZATION_ID },
        expect.any(String),
        expect.objectContaining({ delta: "+2", productId: PRODUCT_ID }),
      ),
    );
    await waitFor(() => expect(listInventory).toHaveBeenCalledTimes(2));
    expect(
      queryClient.getQueryData([
        "branch-scoped",
        ORGANIZATION_ID,
        BRANCH_ID,
        "inventory",
      ]),
    ).toBeUndefined();
  });

  it("shows safe domain failures from an adjustment", async () => {
    const { InventoryApiError } = await import("@/inventory-api-client");
    vi.mocked(createInventoryAdjustment).mockRejectedValue(
      new InventoryApiError("insufficient_stock"),
    );
    renderInventory();
    await screen.findByText("Tea");
    fireEvent.click(screen.getByRole("button", { name: /Tea/ }));
    const form = await screen.findByRole("form", {
      name: "Adjust stock for Tea",
    });
    fireEvent.change(screen.getByLabelText("Signed adjustment (EA)"), {
      target: { value: "-2" },
    });
    fireEvent.submit(form);
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /would make stock negative/i,
    );
  });

  it("keeps the same idempotency key for a transport retry of an unchanged submission", async () => {
    vi.mocked(createInventoryAdjustment)
      .mockRejectedValueOnce(new InventoryApiError("unavailable"))
      .mockResolvedValueOnce({
        balance: { quantity: "2" },
        transaction: {
          delta: "2",
          id: "50000000-0000-4000-8000-000000000001",
          note: null,
          occurredAt: "2026-08-30T12:00:00.000Z",
          reason: "FOUND",
          source: "MANUAL_ADJUSTMENT",
        },
      });
    renderInventory();
    await screen.findByText("Tea");
    fireEvent.click(screen.getByRole("button", { name: /Tea/ }));
    const form = await screen.findByRole("form", {
      name: "Adjust stock for Tea",
    });
    fireEvent.change(screen.getByLabelText("Signed adjustment (EA)"), {
      target: { value: "+2" },
    });
    fireEvent.submit(form);
    await screen.findByRole("alert");
    fireEvent.submit(form);

    await waitFor(() =>
      expect(createInventoryAdjustment).toHaveBeenCalledTimes(2),
    );
    const firstKey = vi.mocked(createInventoryAdjustment).mock.calls[0]?.[1];
    const retryKey = vi.mocked(createInventoryAdjustment).mock.calls[1]?.[1];
    expect(retryKey).toBe(firstKey);
  });

  it("accepts a fractional-unit decimal string without rounding it", async () => {
    const kilogramItem = {
      ...item,
      product: { ...item.product, unit: "KG" as const },
    };
    vi.mocked(listInventory).mockResolvedValue({
      data: [kilogramItem],
      meta: { nextCursor: null },
    });
    vi.mocked(getInventoryItem).mockResolvedValue(kilogramItem);
    renderInventory();
    await screen.findByText("Tea");
    fireEvent.click(screen.getByRole("button", { name: /Tea/ }));
    const form = await screen.findByRole("form", {
      name: "Adjust stock for Tea",
    });
    fireEvent.change(screen.getByLabelText("Signed adjustment (KG)"), {
      target: { value: "+0.1250" },
    });
    fireEvent.submit(form);

    await waitFor(() =>
      expect(createInventoryAdjustment).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ delta: "+0.1250" }),
      ),
    );
  });

  it("loads the next chronological history page with the server cursor", async () => {
    vi.mocked(listInventoryHistory)
      .mockResolvedValueOnce({
        data: [],
        meta: { nextCursor: "next-history" },
      })
      .mockResolvedValueOnce({
        data: [
          {
            actor: {
              displayName: "User",
              id: "40000000-0000-4000-8000-000000000001",
            },
            delta: "1",
            id: "60000000-0000-4000-8000-000000000001",
            note: null,
            occurredAt: "2026-08-30T12:00:01.000Z",
            reason: "FOUND",
            source: "MANUAL_ADJUSTMENT",
          },
        ],
        meta: { nextCursor: null },
      });
    renderInventory();
    await screen.findByText("Tea");
    fireEvent.click(screen.getByRole("button", { name: /Tea/ }));
    await screen.findByRole("button", { name: "Load more history" });
    fireEvent.click(screen.getByRole("button", { name: "Load more history" }));

    await waitFor(() =>
      expect(listInventoryHistory).toHaveBeenLastCalledWith(
        { branchId: BRANCH_ID, organizationId: ORGANIZATION_ID },
        PRODUCT_ID,
        { cursor: "next-history" },
      ),
    );
    expect(await screen.findByText("+1 · FOUND")).toBeTruthy();
  });

  it("shows the documented empty and unavailable balance states", async () => {
    vi.mocked(listInventory).mockResolvedValueOnce({
      data: [],
      meta: { nextCursor: null },
    });
    renderInventory();
    expect(
      await screen.findByText(/no products match this inventory view/i),
    ).toBeTruthy();
    cleanup();
    vi.mocked(listInventory).mockRejectedValueOnce(
      new InventoryApiError("unavailable"),
    );
    renderInventory();
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /temporarily unavailable/i,
    );
  });

  it("uses a distinct branch-scoped query after the URL context changes", async () => {
    const branchTwo = "20000000-0000-4000-8000-000000000002";
    const queryClient = renderInventory();
    await screen.findByText("Tea");
    currentSearchParams = new URLSearchParams({
      branchId: branchTwo,
      organizationId: ORGANIZATION_ID,
    });
    vi.mocked(fetchAccessContext).mockResolvedValue({
      firstOrganizationOnboarding: { eligible: false },
      organizations: [
        {
          branches: [{ code: "B", id: branchTwo, name: "Beta" }],
          id: ORGANIZATION_ID,
          name: "Store",
          role,
        },
      ],
      user: {
        displayName: "User",
        email: "user@example.com",
        id: "40000000-0000-4000-8000-000000000001",
      },
    });
    queryClient.invalidateQueries({ queryKey: ["access-context"] });
    await waitFor(() =>
      expect(listInventory).toHaveBeenLastCalledWith(
        { branchId: branchTwo, organizationId: ORGANIZATION_ID },
        expect.anything(),
      ),
    );
  });
});
