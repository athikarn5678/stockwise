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
  checkoutSale,
  getSalesVatProfile,
  SalesApiError,
  searchPosProducts,
  updateSalesVatProfile,
} from "@/sales-api-client";

import { PosManagement } from "./pos-management";

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
vi.mock("@/sales-api-client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/sales-api-client")>();
  return {
    ...original,
    checkoutSale: vi.fn(),
    getSalesVatProfile: vi.fn(),
    searchPosProducts: vi.fn(),
    updateSalesVatProfile: vi.fn(),
  };
});

const coffee = {
  available: true,
  availableQuantity: "5.0000",
  barcode: "8850000000000",
  basePrice: "0.1000",
  id: PRODUCT_ID,
  name: "Coffee",
  sku: "COFFEE-01",
  unit: "EA" as const,
};
const unavailableTea = {
  ...coffee,
  available: false,
  availableQuantity: "0.0000",
  id: "30000000-0000-4000-8000-000000000002",
  name: "Unavailable tea",
  sku: "TEA-02",
};
const completedSale = {
  actorDisplayNameSnapshot: "Historical cashier",
  branchCodeSnapshot: "MAIN",
  branchNameSnapshot: "Main",
  currency: "THB" as const,
  discount: null,
  discountAmount: "0.00",
  id: "50000000-0000-4000-8000-000000000001",
  items: [
    {
      id: "60000000-0000-4000-8000-000000000001",
      lineDiscount: "0.00",
      lineGross: "0.30",
      lineNet: "0.30",
      nameSnapshot: "Coffee",
      quantity: "3",
      skuSnapshot: "COFFEE-01",
      unitPrice: "0.1000",
      unitSnapshot: "EA" as const,
    },
  ],
  occurredAt: "2026-09-18T10:00:00.000Z",
  organizationNameSnapshot: "Historical shop",
  outputVatAmount: "0.00",
  payment: {
    amount: "0.30",
    amountTendered: "1.00",
    changeAmount: "0.70",
    method: "CASH" as const,
    reference: null,
  },
  reference: "SALE-001",
  subtotalAmount: "0.30",
  taxableAmount: null,
  totalAmount: "0.30",
};

function renderPos() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <PosManagement />
    </QueryClientProvider>,
  );
  return queryClient;
}

async function addCoffee() {
  await screen.findByRole("button", { name: "Add Coffee" });
  fireEvent.click(screen.getByRole("button", { name: "Add Coffee" }));
}

async function checkoutCash() {
  fireEvent.change(screen.getByLabelText("Amount tendered (THB)"), {
    target: { value: "1.00" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Complete sale" }));
  await waitFor(() => expect(checkoutSale).toHaveBeenCalled());
}

beforeEach(() => {
  role = "OWNER";
  currentSearchParams = new URLSearchParams({
    branchId: BRANCH_ID,
    organizationId: ORGANIZATION_ID,
  });
  vi.stubGlobal("crypto", { randomUUID: vi.fn(() => "checkout-key-one") });
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
      displayName: "Cashier",
      email: "cashier@example.test",
      id: "40000000-0000-4000-8000-000000000001",
    },
  }));
  vi.mocked(getSalesVatProfile).mockResolvedValue({
    salesVatRate: null,
    salesVatStatus: "NOT_REGISTERED",
    updatedAt: "2026-09-18T10:00:00.000Z",
  });
  vi.mocked(updateSalesVatProfile).mockResolvedValue({
    salesVatRate: null,
    salesVatStatus: "NOT_REGISTERED",
    updatedAt: "2026-09-18T10:01:00.000Z",
  });
  vi.mocked(searchPosProducts).mockResolvedValue({
    data: { products: [coffee] },
    meta: { nextCursor: null },
  });
  vi.mocked(checkoutSale).mockResolvedValue(completedSale);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("POS management UI", () => {
  it("preserves extra price digits and submits the original exact price", async () => {
    vi.mocked(searchPosProducts).mockResolvedValue({
      data: { products: [{ ...coffee, basePrice: "4.1230" }] },
      meta: { nextCursor: null },
    });
    renderPos();
    expect(await screen.findByText("THB 4.123")).toBeTruthy();
    await addCoffee();
    expect(screen.getByText(/THB 4.123 \/ EA/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Amount tendered (THB)"), {
      target: { value: "5.00" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Complete sale" }));
    await waitFor(() =>
      expect(checkoutSale).toHaveBeenCalledWith(
        expect.anything(),
        "checkout-key-one",
        expect.objectContaining({
          items: [expect.objectContaining({ expectedUnitPrice: "4.1230" })],
        }),
      ),
    );
  });

  it("renders the authorized branch POS with safe product data only", async () => {
    renderPos();
    expect(
      await screen.findByRole("heading", { name: "Point of sale" }),
    ).toBeTruthy();
    expect(screen.getByText(/MAIN.*Main/)).toBeTruthy();
    expect(await screen.findByText("THB 0.10")).toBeTruthy();
    expect(screen.queryByText(/cost|cogs/i)).toBeNull();
    await waitFor(() =>
      expect(searchPosProducts).toHaveBeenCalledWith(
        { branchId: BRANCH_ID, organizationId: ORGANIZATION_ID },
        expect.objectContaining({ q: "" }),
      ),
    );
  });

  it("keeps button styling when callers add layout classes", async () => {
    renderPos();
    const add = await screen.findByRole("button", { name: "Add Coffee" });
    const search = screen.getByRole("button", { name: /^Search$/ });
    expect(add.getAttribute("data-slot")).toBe("button");
    expect(add.classList.contains("bg-primary")).toBe(true);
    expect(add.classList.contains("w-full")).toBe(true);
    expect(search.getAttribute("data-slot")).toBe("button");
    expect(search.classList.contains("self-end")).toBe(true);
  });

  it("submits a name/SKU search and provides a no-results state", async () => {
    vi.mocked(searchPosProducts).mockResolvedValue({
      data: { products: [] },
      meta: { nextCursor: null },
    });
    renderPos();
    await screen.findByText(/no products match/i);
    fireEvent.change(screen.getByLabelText("Search products"), {
      target: { value: "coffee" },
    });
    fireEvent.submit(screen.getByRole("form", { name: "Search POS products" }));
    await waitFor(() =>
      expect(searchPosProducts).toHaveBeenLastCalledWith(
        { branchId: BRANCH_ID, organizationId: ORGANIZATION_ID },
        expect.objectContaining({ q: "coffee" }),
      ),
    );
  });

  it("auto-adds one exact available barcode match without pointer-only interaction", async () => {
    renderPos();
    await screen.findByRole("button", { name: "Add Coffee" });
    fireEvent.change(screen.getByLabelText("Scan or enter barcode"), {
      target: { value: "8850000000000" },
    });
    fireEvent.submit(screen.getByRole("form", { name: "Scan POS barcode" }));
    expect(
      await screen.findByRole("list", { name: "Cart items" }),
    ).toBeTruthy();
    expect(screen.getByDisplayValue("1")).toBeTruthy();
  });

  it("serializes rapid repeated barcode scans into the existing cart and exact price", async () => {
    renderPos();
    await screen.findByRole("button", { name: "Add Coffee" });
    const input = screen.getByLabelText("Scan or enter barcode");
    for (let index = 0; index < 3; index += 1) {
      fireEvent.change(input, { target: { value: coffee.barcode } });
      fireEvent.submit(screen.getByRole("form", { name: "Scan POS barcode" }));
    }
    await waitFor(() => expect(screen.getByDisplayValue("3")).toBeTruthy());
    expect(
      screen.getAllByRole("button", { name: "Remove Coffee from cart" }),
    ).toHaveLength(1);
    await checkoutCash();
    expect(checkoutSale).toHaveBeenLastCalledWith(
      expect.anything(),
      "checkout-key-one",
      expect.objectContaining({
        items: [
          { productId: PRODUCT_ID, quantity: "3", expectedUnitPrice: "0.1000" },
        ],
      }),
    );
  });

  it("waits for in-flight scans before checkout instead of losing an item", async () => {
    renderPos();
    await addCoffee();
    let finish!: (value: Awaited<ReturnType<typeof searchPosProducts>>) => void;
    vi.mocked(searchPosProducts).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    fireEvent.change(screen.getByLabelText("Scan or enter barcode"), {
      target: { value: coffee.barcode },
    });
    fireEvent.submit(screen.getByRole("form", { name: "Scan POS barcode" }));
    expect(
      screen.getByRole("button", { name: "Complete sale" }),
    ).toHaveProperty("disabled", true);
    fireEvent.submit(
      screen.getByRole("form", { name: "Checkout current sale" }),
    );
    expect(checkoutSale).not.toHaveBeenCalled();
    await act(async () =>
      finish({ data: { products: [coffee] }, meta: { nextCursor: null } }),
    );
    await waitFor(() => expect(screen.getByDisplayValue("2")).toBeTruthy());
    await checkoutCash();
    expect(checkoutSale).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        items: [expect.objectContaining({ quantity: "2" })],
      }),
    );
  });

  it("clears scanner/cart state and ignores late results when the authorized branch changes", async () => {
    const client = renderPos();
    await addCoffee();
    let finish!: (value: Awaited<ReturnType<typeof searchPosProducts>>) => void;
    vi.mocked(searchPosProducts).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    fireEvent.change(screen.getByLabelText("Scan or enter barcode"), {
      target: { value: coffee.barcode },
    });
    fireEvent.submit(screen.getByRole("form", { name: "Scan POS barcode" }));
    const access = await fetchAccessContext();
    currentSearchParams.set("branchId", "20000000-0000-4000-8000-000000000002");
    act(() =>
      client.setQueryData(["access-context"], {
        ...access,
        organizations: [
          {
            ...access.organizations[0],
            branches: [
              {
                code: "SECOND",
                id: currentSearchParams.get("branchId"),
                name: "Second",
              },
            ],
          },
        ],
      }),
    );
    await screen.findByText(/SECOND — Second/);
    await act(async () =>
      finish({ data: { products: [coffee] }, meta: { nextCursor: null } }),
    );
    expect(screen.queryByRole("list", { name: "Cart items" })).toBeNull();
    expect(screen.getByText("Ready to scan.")).toBeTruthy();
  });

  it("adds an item again, decrements/removes it, and clears the cart", async () => {
    renderPos();
    await addCoffee();
    fireEvent.click(screen.getByRole("button", { name: "Add Coffee" }));
    expect(screen.getByDisplayValue("2")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Decrease Coffee quantity" }),
    );
    expect(screen.getByDisplayValue("1")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Decrease Coffee quantity" }),
    );
    expect(screen.queryByRole("list", { name: "Cart items" })).toBeNull();
    await addCoffee();
    fireEvent.click(screen.getByRole("button", { name: "Clear cart" }));
    expect(screen.getByText(/add an available product/i)).toBeTruthy();
  });

  it("does not allow an unavailable product to be added", async () => {
    vi.mocked(searchPosProducts).mockResolvedValue({
      data: { products: [unavailableTea] },
      meta: { nextCursor: null },
    });
    renderPos();
    const unavailable = await screen.findByRole("button", {
      name: "Unavailable",
    });
    expect(unavailable).toHaveProperty("disabled", true);
    expect(screen.queryByRole("list", { name: "Cart items" })).toBeNull();
  });

  it("uses exact decimal display math for cart subtotal", async () => {
    renderPos();
    await addCoffee();
    fireEvent.click(screen.getByRole("button", { name: "Add Coffee" }));
    fireEvent.click(screen.getByRole("button", { name: "Add Coffee" }));
    expect(screen.getAllByText("THB 0.30")).toHaveLength(2);
  });

  it("switches between labelled CASH and TRANSFER payment controls", async () => {
    renderPos();
    await addCoffee();
    expect(screen.getByLabelText("Amount tendered (THB)")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Transfer" }));
    expect(screen.getByLabelText("Transfer reference (optional)")).toBeTruthy();
    expect(screen.queryByLabelText("Amount tendered (THB)")).toBeNull();
  });

  it.each(["OWNER", "ADMIN", "BRANCH_MANAGER"] as const)(
    "shows whole-sale discount controls to %s",
    async (discountRole) => {
      role = discountRole;
      renderPos();
      expect(await screen.findByLabelText("Discount type")).toBeTruthy();
    },
  );

  it("does not offer discount controls to CASHIER", async () => {
    role = "CASHIER";
    renderPos();
    await screen.findByRole("heading", { name: "Point of sale" });
    expect(screen.queryByLabelText("Discount type")).toBeNull();
    expect(getSalesVatProfile).not.toHaveBeenCalled();
  });

  it("posts a successful CASH sale and retains the authoritative result until new sale", async () => {
    renderPos();
    await addCoffee();
    await checkoutCash();
    expect(
      await screen.findByRole("heading", { name: "Sale completed" }),
    ).toBeTruthy();
    const receipt = screen.getByLabelText("Printable receipt");
    expect(receipt.textContent).toContain("Sale SALE-001");
    expect(receipt.textContent).toContain("Historical shop");
    expect(receipt.textContent).toContain("Cashier: Historical cashier");
    expect(receipt.textContent).toContain("3 EA × THB 0.10");
    expect(receipt.textContent).toContain(
      "Tendered THB 1.00 · Change THB 0.70",
    );
    const print = vi.spyOn(window, "print").mockImplementation(() => {});
    fireEvent.click(screen.getByRole("button", { name: "Print receipt" }));
    expect(print).toHaveBeenCalledTimes(1);
    print.mockRestore();
    expect(checkoutSale).toHaveBeenCalledWith(
      { branchId: BRANCH_ID, organizationId: ORGANIZATION_ID },
      "checkout-key-one",
      expect.objectContaining({
        payment: { amountTendered: "1.00", method: "CASH" },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "New sale" }));
    expect(await screen.findByText(/add an available product/i)).toBeTruthy();
    expect(screen.queryByLabelText("Printable receipt")).toBeNull();
  });

  it("posts a successful TRANSFER sale with its optional reference", async () => {
    vi.mocked(checkoutSale).mockResolvedValue({
      ...completedSale,
      payment: {
        amount: "0.30",
        amountTendered: null,
        changeAmount: null,
        method: "TRANSFER",
        reference: "TX-100",
      },
    });
    renderPos();
    await addCoffee();
    fireEvent.click(screen.getByRole("radio", { name: "Transfer" }));
    fireEvent.change(screen.getByLabelText("Transfer reference (optional)"), {
      target: { value: "TX-100" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Complete sale" }));
    await waitFor(() =>
      expect(checkoutSale).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          payment: { method: "TRANSFER", reference: "TX-100" },
        }),
      ),
    );
    expect(await screen.findByText(/Transfer · TX-100/)).toBeTruthy();
  });

  it("prevents duplicate in-flight checkout clicks", async () => {
    let resolveCheckout: ((sale: typeof completedSale) => void) | undefined;
    vi.mocked(checkoutSale).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCheckout = resolve;
        }),
    );
    renderPos();
    await addCoffee();
    fireEvent.change(screen.getByLabelText("Amount tendered (THB)"), {
      target: { value: "1" },
    });
    const button = screen.getByRole("button", { name: "Complete sale" });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(checkoutSale).toHaveBeenCalledTimes(1));
    expect(
      screen.getByRole("button", { name: "Completing sale…" }),
    ).toHaveProperty("disabled", true);
    expect(
      screen
        .getByRole("button", { name: "Increase Coffee quantity" })
        .matches(":disabled"),
    ).toBe(true);
    resolveCheckout?.(completedSale);
  });

  it.each([
    ["price_changed", /price changed/i],
    ["insufficient_stock", /stock is no longer sufficient/i],
    ["vat_configuration_required", /VAT profile is configured/i],
    ["idempotency_conflict", /represents different sale details/i],
    ["forbidden", /not available for your current access/i],
  ] as const)(
    "keeps cart visible for %s checkout errors",
    async (kind, message) => {
      vi.mocked(checkoutSale).mockRejectedValue(new SalesApiError(kind));
      renderPos();
      await addCoffee();
      await checkoutCash();
      expect((await screen.findByRole("alert")).textContent).toMatch(message);
      expect(screen.getByDisplayValue("1")).toBeTruthy();
    },
  );

  it("keeps the same idempotency key for an unchanged ambiguous retry and rotates it after a changed sale", async () => {
    vi.stubGlobal("crypto", {
      randomUUID: vi
        .fn()
        .mockReturnValueOnce("key-one")
        .mockReturnValueOnce("key-two"),
    });
    vi.mocked(checkoutSale)
      .mockRejectedValueOnce(new SalesApiError("unavailable"))
      .mockRejectedValueOnce(new SalesApiError("unavailable"))
      .mockRejectedValueOnce(new SalesApiError("unavailable"));
    renderPos();
    await addCoffee();
    await checkoutCash();
    await checkoutCash();
    fireEvent.click(
      screen.getByRole("button", { name: "Increase Coffee quantity" }),
    );
    await checkoutCash();
    await waitFor(() => expect(checkoutSale).toHaveBeenCalledTimes(3));
    expect(vi.mocked(checkoutSale).mock.calls.map((call) => call[1])).toEqual([
      "key-one",
      "key-one",
      "key-two",
    ]);
  });

  it("blocks owner checkout while the authoritative VAT state is unconfigured and exposes the bounded form", async () => {
    vi.mocked(getSalesVatProfile).mockResolvedValue({
      salesVatRate: null,
      salesVatStatus: "UNCONFIGURED",
      updatedAt: "2026-09-18T10:00:00.000Z",
    });
    renderPos();
    await addCoffee();
    expect(
      await screen.findByRole("form", { name: "Sales VAT profile" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Complete sale" }),
    ).toHaveProperty("disabled", true);
  });

  it("shows branch context feedback without sending arbitrary branch IDs", async () => {
    currentSearchParams = new URLSearchParams({
      organizationId: ORGANIZATION_ID,
    });
    vi.mocked(fetchAccessContext).mockResolvedValue({
      firstOrganizationOnboarding: { eligible: false },
      organizations: [
        { branches: [], id: ORGANIZATION_ID, name: "Store", role: "CASHIER" },
      ],
      user: {
        displayName: "Cashier",
        email: "cashier@example.test",
        id: "40000000-0000-4000-8000-000000000001",
      },
    });
    renderPos();
    expect(
      await screen.findByRole("heading", { name: "Branch context required" }),
    ).toBeTruthy();
    expect(searchPosProducts).not.toHaveBeenCalled();
  });
});
