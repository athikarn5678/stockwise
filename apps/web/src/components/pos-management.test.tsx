// @vitest-environment jsdom

import { LanguageProvider, useLanguage } from "@/providers/language-provider";
import { en } from "@/i18n/en";
import { th } from "@/i18n/th";
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
  getPaymentOptions,
  getSalesVatProfile,
  quotePromptPay,
  SalesApiError,
  searchPosProducts,
  updateSalesVatProfile,
} from "@/sales-api-client";

import { PosManagement } from "./pos-management";
import { chooseOptionByValue } from "@/test/select-helpers";

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

const subscriptionGate = vi.hoisted(() => ({ blocked: false }));
vi.mock("@/providers/subscription-provider", () => ({
  useSubscriptionWriteGate: () => ({ writeBlocked: subscriptionGate.blocked }),
}));
vi.mock("@/sales-api-client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/sales-api-client")>();
  return {
    ...original,
    checkoutSale: vi.fn(),
    getPaymentOptions: vi.fn(),
    getSalesVatProfile: vi.fn(),
    quotePromptPay: vi.fn(),
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

function TestLanguageToggle() {
  const { language, setLanguage } = useLanguage();
  return (
    <button onClick={() => setLanguage(language === "en" ? "th" : "en")}>
      Switch language
    </button>
  );
}
function renderPos(localized = false) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      {localized ? (
        <LanguageProvider>
          <TestLanguageToggle />
          <PosManagement />
        </LanguageProvider>
      ) : (
        <PosManagement />
      )}
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
  vi.mocked(getPaymentOptions).mockResolvedValue({ promptPay: false });
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
  subscriptionGate.blocked = false;
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

  it("offers only Cash while PromptPay is unavailable and never Transfer", async () => {
    renderPos();
    await addCoffee();
    expect(screen.getByLabelText("Amount tendered (THB)")).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Cash" })).toBeTruthy();
    expect(screen.queryByRole("radio", { name: "Transfer" })).toBeNull();
    expect(screen.queryByLabelText("Transfer reference (optional)")).toBeNull();
    expect(screen.getAllByRole("radio")).toHaveLength(1);
  });

  it("keeps the cart quantity controls on one line with a compact input", async () => {
    renderPos();
    await addCoffee();
    const input = screen.getByLabelText("Quantity for Coffee (EA)");
    const row = input.parentElement as HTMLElement;
    expect(row.className).toContain("flex");
    expect(row.className).not.toContain("flex-wrap");
    for (const name of [
      "Decrease Coffee quantity",
      "Increase Coffee quantity",
      "Remove Coffee from cart",
    ])
      expect(row.contains(screen.getByRole("button", { name }))).toBe(true);
    // No long floating label: the field is named by aria-label alone.
    expect(input.closest("label")).toBeNull();
    expect(input.getAttribute("aria-label")).toBe("Quantity for Coffee (EA)");
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

  it("still displays a historic Transfer sale result with its reference", async () => {
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
    await checkoutCash();
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

  describe("sales VAT profile", () => {
    const form = () => screen.findByRole("form", { name: "Sales VAT profile" });
    const saveButton = () =>
      screen.queryByRole("button", { name: "Save VAT profile" });
    const statusTrigger = () => screen.getByLabelText("Sales VAT status");

    it("shows the saved value and offers Save only for a change", async () => {
      renderPos();
      await addCoffee();
      await form();
      expect(screen.getByTestId("vat-saved-summary").textContent).toBe(
        "Saved: Not registered",
      );
      expect(saveButton()).toBeNull();

      await chooseOptionByValue(statusTrigger(), "REGISTERED");
      expect(saveButton()).toBeTruthy();

      // Reverting to the saved value hides Save again.
      await chooseOptionByValue(statusTrigger(), "NOT_REGISTERED");
      expect(saveButton()).toBeNull();
      expect(updateSalesVatProfile).not.toHaveBeenCalled();
    });

    it("keeps the saved value when the page is left without saving", async () => {
      renderPos();
      await addCoffee();
      await form();
      await chooseOptionByValue(statusTrigger(), "REGISTERED");
      expect(saveButton()).toBeTruthy();
      cleanup();
      renderPos();
      await addCoffee();
      await form();
      expect(saveButton()).toBeNull();
      expect(screen.getByTestId("vat-saved-summary").textContent).toBe(
        "Saved: Not registered",
      );
      expect(updateSalesVatProfile).not.toHaveBeenCalled();
    });

    it("confirms a successful save and hides Save again", async () => {
      const profiles = [
        {
          salesVatRate: null,
          salesVatStatus: "NOT_REGISTERED" as const,
          updatedAt: "2026-09-18T10:00:00.000Z",
        },
        {
          salesVatRate: "7.000000",
          salesVatStatus: "REGISTERED" as const,
          updatedAt: "2026-09-18T10:01:00.000Z",
        },
      ];
      let calls = 0;
      vi.mocked(getSalesVatProfile).mockImplementation(
        async () => profiles[Math.min(profiles.length - 1, calls++)]!,
      );
      vi.mocked(updateSalesVatProfile).mockResolvedValue(profiles[1]!);
      renderPos();
      await addCoffee();
      await form();
      await chooseOptionByValue(statusTrigger(), "REGISTERED");
      fireEvent.change(screen.getByLabelText("VAT rate (%)"), {
        target: { value: "7.000000" },
      });
      fireEvent.click(saveButton()!);
      await waitFor(() =>
        expect(updateSalesVatProfile).toHaveBeenCalledWith(ORGANIZATION_ID, {
          expectedUpdatedAt: "2026-09-18T10:00:00.000Z",
          salesVatRate: "7.000000",
          salesVatStatus: "REGISTERED",
        }),
      );
      await waitFor(() =>
        expect(screen.getByTestId("vat-saved-summary").textContent).toContain(
          "VAT profile saved.",
        ),
      );
      expect(screen.getByTestId("vat-saved-summary").textContent).toContain(
        "Saved: Registered, VAT 7.000000%",
      );
      expect(saveButton()).toBeNull();
    });

    it("reports a failed save and keeps Save available", async () => {
      vi.mocked(updateSalesVatProfile).mockRejectedValue(
        new SalesApiError("unavailable"),
      );
      renderPos();
      await addCoffee();
      await form();
      await chooseOptionByValue(statusTrigger(), "REGISTERED");
      fireEvent.change(screen.getByLabelText("VAT rate (%)"), {
        target: { value: "7" },
      });
      fireEvent.click(saveButton()!);
      expect(await screen.findByRole("alert")).toBeTruthy();
      expect(saveButton()).toBeTruthy();
      expect(screen.getByTestId("vat-saved-summary").textContent).toBe(
        "Saved: Not registered",
      );
    });

    it("requires saving an unconfigured profile once", async () => {
      vi.mocked(getSalesVatProfile).mockResolvedValue({
        salesVatRate: null,
        salesVatStatus: "UNCONFIGURED",
        updatedAt: "2026-09-18T10:00:00.000Z",
      });
      renderPos();
      await addCoffee();
      await form();
      expect(screen.getByTestId("vat-saved-summary").textContent).toContain(
        "Not configured yet",
      );
      expect(saveButton()).toBeTruthy();
    });
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

it("retranslates retained checkout feedback without changing cart or replaying checkout", async () => {
  localStorage.clear();
  vi.mocked(checkoutSale).mockRejectedValue(new SalesApiError("unavailable"));
  renderPos(true);
  await addCoffee();
  await checkoutCash();
  await screen.findByText(
    en.uiCheckoutIsTemporarilyUnavailableYourCartWasKeptUnchanged,
  );
  fireEvent.click(screen.getByRole("button", { name: "Switch language" }));
  expect(
    await screen.findByText(
      th.uiCheckoutIsTemporarilyUnavailableYourCartWasKeptUnchanged,
    ),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: th.uiCompleteSale })).toBeTruthy();
  expect(
    screen.getByLabelText(th.uiIncreaseQuantity.replace("{name}", "Coffee")),
  ).toBeTruthy();
  expect(checkoutSale).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Switch language" }));
  expect(
    screen.getByText(
      en.uiCheckoutIsTemporarilyUnavailableYourCartWasKeptUnchanged,
    ),
  ).toBeTruthy();
  localStorage.clear();
});

const createObjectUrl = vi.fn<(file: Blob) => string>(() => "blob:slip-one");
const revokeObjectUrl = vi.fn<(url: string) => void>();

function stubObjectUrls() {
  // jsdom has no object-URL implementation; the panel must still be testable.
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: createObjectUrl,
    writable: true,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: revokeObjectUrl,
    writable: true,
  });
}

const PROMPTPAY_PAYLOAD = "00020101021229370016A000000677010111";

function enablePromptPay() {
  vi.mocked(getPaymentOptions).mockResolvedValue({ promptPay: true });
  vi.mocked(quotePromptPay).mockResolvedValue({
    amount: "0.30",
    currency: "THB",
    payload: PROMPTPAY_PAYLOAD,
  });
}

function promptPayQrImage(): HTMLElement | null {
  return screen.queryByRole("img", { name: /PromptPay QR for the amount/ });
}

function confirmButton(): HTMLElement {
  return screen.getByRole("button", { name: "Confirm payment received" });
}

async function generatePromptPayQr() {
  renderPos();
  await addCoffee();
  fireEvent.click(await screen.findByRole("radio", { name: "PromptPay" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Generate PromptPay QR" }),
  );
  return screen.findByRole("img", { name: /PromptPay QR for the amount/ });
}

function chooseSlip(name: string, type: string) {
  fireEvent.change(screen.getByLabelText(/Attach slip/), {
    target: { files: [new File(["slip"], name, { type })] },
  });
}

describe("POS PromptPay option", () => {
  beforeEach(() => {
    createObjectUrl.mockReset();
    createObjectUrl.mockReturnValue("blob:slip-one");
    revokeObjectUrl.mockReset();
    stubObjectUrls();
  });

  it("hides the option when the branch does not accept PromptPay", async () => {
    renderPos();
    await screen.findByRole("button", { name: "Add Coffee" });
    await waitFor(() =>
      expect(getPaymentOptions).toHaveBeenCalledWith({
        branchId: BRANCH_ID,
        organizationId: ORGANIZATION_ID,
      }),
    );
    expect(screen.queryByRole("radio", { name: "PromptPay" })).toBeNull();
  });

  it("treats a failed payment options request as unavailable", async () => {
    vi.mocked(getPaymentOptions).mockRejectedValue(
      new SalesApiError("unavailable"),
    );
    renderPos();
    await addCoffee();
    await waitFor(() => expect(getPaymentOptions).toHaveBeenCalled());
    expect(screen.queryByRole("radio", { name: "PromptPay" })).toBeNull();
  });

  it("shows the option next to cash, without Transfer, when the branch accepts it", async () => {
    enablePromptPay();
    renderPos();
    await addCoffee();
    expect(
      await screen.findByRole("radio", { name: "PromptPay" }),
    ).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Cash" })).toBeTruthy();
    expect(screen.queryByRole("radio", { name: "Transfer" })).toBeNull();
    expect(screen.getAllByRole("radio")).toHaveLength(2);
  });

  it("falls back to cash when the option disappears while selected", async () => {
    enablePromptPay();
    const client = renderPos();
    await addCoffee();
    const radio = await screen.findByRole("radio", { name: "PromptPay" });
    fireEvent.click(radio);
    expect(screen.getByRole("radio", { name: "PromptPay" })).toHaveProperty(
      "checked",
      true,
    );

    act(() =>
      client.setQueryData(
        ["branch-scoped", ORGANIZATION_ID, BRANCH_ID, "pos", "payment-options"],
        { promptPay: false },
      ),
    );

    await waitFor(() =>
      expect(screen.queryByRole("radio", { name: "PromptPay" })).toBeNull(),
    );
    expect(screen.getByLabelText("Amount tendered (THB)")).toBeTruthy();
    expect(checkoutSale).not.toHaveBeenCalled();
  });

  it("ignores a quote that resolves after the cart changed", async () => {
    enablePromptPay();
    let finishQuote!: (quote: {
      amount: string;
      currency: "THB";
      payload: string;
    }) => void;
    vi.mocked(quotePromptPay).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishQuote = resolve;
        }),
    );
    renderPos();
    await addCoffee();
    fireEvent.click(await screen.findByRole("radio", { name: "PromptPay" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Generate PromptPay QR" }),
    );
    await waitFor(() => expect(quotePromptPay).toHaveBeenCalled());

    fireEvent.click(
      screen.getByRole("button", { name: "Increase Coffee quantity" }),
    );
    await act(async () =>
      finishQuote({
        amount: "0.30",
        currency: "THB",
        payload: PROMPTPAY_PAYLOAD,
      }),
    );

    expect(promptPayQrImage()).toBeNull();
    expect(confirmButton()).toHaveProperty("disabled", true);
  });

  it("generates a QR for the server amount without creating a sale", async () => {
    enablePromptPay();
    const qr = await generatePromptPayQr();

    expect(getPaymentOptions).toHaveBeenCalledTimes(1);
    expect(quotePromptPay).toHaveBeenCalledWith(
      { branchId: BRANCH_ID, organizationId: ORGANIZATION_ID },
      {
        discount: null,
        items: [
          { expectedUnitPrice: "0.1000", productId: PRODUCT_ID, quantity: "1" },
        ],
      },
    );
    expect(qr.getAttribute("alt")).toContain("0.30");
    expect(qr.getAttribute("src")).toMatch(/^data:image\/svg\+xml/);
    expect(screen.getByText("Amount due THB 0.30")).toBeTruthy();
    expect(checkoutSale).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Complete sale" })).toBeNull();
  });

  it("sends exactly one TRANSFER checkout with the quoted total on confirmation", async () => {
    enablePromptPay();
    vi.mocked(checkoutSale).mockResolvedValue({
      ...completedSale,
      payment: {
        amount: "0.30",
        amountTendered: null,
        changeAmount: null,
        method: "TRANSFER",
        reference: "PromptPay",
      },
    });
    await generatePromptPayQr();
    expect(checkoutSale).not.toHaveBeenCalled();

    fireEvent.click(confirmButton());

    await waitFor(() => expect(checkoutSale).toHaveBeenCalledTimes(1));
    expect(checkoutSale).toHaveBeenCalledWith(
      { branchId: BRANCH_ID, organizationId: ORGANIZATION_ID },
      "checkout-key-one",
      expect.objectContaining({
        discount: null,
        items: [
          { expectedUnitPrice: "0.1000", productId: PRODUCT_ID, quantity: "1" },
        ],
        payment: {
          expectedTotalAmount: "0.30",
          method: "TRANSFER",
          reference: "PromptPay",
        },
      }),
    );
    expect(
      await screen.findByRole("heading", { name: "Sale completed" }),
    ).toBeTruthy();
  });

  it("labels a completed PromptPay sale as PromptPay", async () => {
    enablePromptPay();
    vi.mocked(checkoutSale).mockResolvedValue({
      ...completedSale,
      payment: {
        amount: "0.30",
        amountTendered: null,
        changeAmount: null,
        method: "TRANSFER",
        reference: "PromptPay",
      },
    });
    await generatePromptPayQr();
    fireEvent.click(confirmButton());
    await screen.findByRole("heading", { name: "Sale completed" });
    expect(screen.getAllByText("PromptPay").length).toBeGreaterThan(0);
    expect(screen.queryByText(/Transfer · PromptPay/)).toBeNull();
  });

  it("sends the whole-sale discount to the quote and clears the QR when it changes", async () => {
    enablePromptPay();
    renderPos();
    await addCoffee();
    await chooseOptionByValue(screen.getByLabelText("Discount type"), "AMOUNT");
    fireEvent.change(screen.getByLabelText("Discount amount (THB)"), {
      target: { value: "0.10" },
    });
    fireEvent.change(screen.getByLabelText("Discount reason"), {
      target: { value: "Promo" },
    });
    fireEvent.click(await screen.findByRole("radio", { name: "PromptPay" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Generate PromptPay QR" }),
    );
    await screen.findByRole("img", { name: /PromptPay QR for the amount/ });
    expect(quotePromptPay).toHaveBeenCalledWith(expect.anything(), {
      discount: { amount: "0.10", reason: "Promo", type: "AMOUNT" },
      items: [
        { expectedUnitPrice: "0.1000", productId: PRODUCT_ID, quantity: "1" },
      ],
    });

    fireEvent.change(screen.getByLabelText("Discount amount (THB)"), {
      target: { value: "0.20" },
    });

    expect(promptPayQrImage()).toBeNull();
    expect(confirmButton()).toHaveProperty("disabled", true);
    expect(checkoutSale).not.toHaveBeenCalled();
  });

  it("clears the QR when the quantity or payment method changes", async () => {
    enablePromptPay();
    await generatePromptPayQr();
    expect(confirmButton()).toHaveProperty("disabled", false);

    fireEvent.click(
      screen.getByRole("button", { name: "Increase Coffee quantity" }),
    );
    expect(promptPayQrImage()).toBeNull();
    expect(confirmButton()).toHaveProperty("disabled", true);

    fireEvent.click(
      screen.getByRole("button", { name: "Generate PromptPay QR" }),
    );
    await screen.findByRole("img", { name: /PromptPay QR for the amount/ });

    fireEvent.click(screen.getByRole("radio", { name: "Cash" }));
    fireEvent.click(screen.getByRole("radio", { name: "PromptPay" }));
    expect(promptPayQrImage()).toBeNull();
    expect(confirmButton()).toHaveProperty("disabled", true);
  });

  it("clears the QR and explains a total mismatch returned by checkout", async () => {
    enablePromptPay();
    vi.mocked(checkoutSale).mockRejectedValue(
      new SalesApiError("total_mismatch"),
    );
    await generatePromptPayQr();

    fireEvent.click(confirmButton());

    expect(
      await screen.findByText(en.uiTheTotalChangedGenerateANewPromptPayQr),
    ).toBeTruthy();
    expect(promptPayQrImage()).toBeNull();
    expect(confirmButton()).toHaveProperty("disabled", true);
  });

  it("previews a chosen slip locally and never uploads it", async () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error("no network")));
    vi.stubGlobal("fetch", fetchMock);
    enablePromptPay();
    await generatePromptPayQr();

    chooseSlip("first.png", "image/png");

    const preview = await screen.findByRole("img", {
      name: "Selected slip preview",
    });
    expect(preview.getAttribute("src")).toBe("blob:slip-one");
    expect(createObjectUrl).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();

    createObjectUrl.mockReturnValue("blob:slip-two");
    chooseSlip("second.png", "image/png");
    await waitFor(() =>
      expect(revokeObjectUrl).toHaveBeenCalledWith("blob:slip-one"),
    );
    expect(
      screen
        .getByRole("img", { name: "Selected slip preview" })
        .getAttribute("src"),
    ).toBe("blob:slip-two");

    cleanup();
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:slip-two");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("revokes the slip preview when the QR is invalidated and when it is removed", async () => {
    enablePromptPay();
    await generatePromptPayQr();
    chooseSlip("slip.png", "image/png");
    await screen.findByRole("img", { name: "Selected slip preview" });

    fireEvent.click(
      screen.getByRole("button", { name: "Increase Coffee quantity" }),
    );
    await waitFor(() =>
      expect(revokeObjectUrl).toHaveBeenCalledWith("blob:slip-one"),
    );
    expect(
      screen.queryByRole("img", { name: "Selected slip preview" }),
    ).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Generate PromptPay QR" }),
    );
    await screen.findByRole("img", { name: /PromptPay QR for the amount/ });
    createObjectUrl.mockReturnValue("blob:slip-two");
    chooseSlip("slip.png", "image/png");
    await screen.findByRole("img", { name: "Selected slip preview" });
    fireEvent.click(screen.getByRole("button", { name: "Remove slip" }));
    await waitFor(() =>
      expect(revokeObjectUrl).toHaveBeenCalledWith("blob:slip-two"),
    );
    expect(
      screen.queryByRole("img", { name: "Selected slip preview" }),
    ).toBeNull();
  });

  it("rejects a non-image slip without creating a preview", async () => {
    enablePromptPay();
    await generatePromptPayQr();

    chooseSlip("slip.txt", "text/plain");

    expect(
      await screen.findByText("Choose an image file for the slip preview."),
    ).toBeTruthy();
    expect(createObjectUrl).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("img", { name: "Selected slip preview" }),
    ).toBeNull();
  });

  it("disables the checkout action while the subscription is expired", async () => {
    subscriptionGate.blocked = true;
    renderPos();
    await addCoffee();

    expect(
      screen.getByRole("button", { name: "Complete sale" }),
    ).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Search" })).toHaveProperty(
      "disabled",
      false,
    );
  });
});
