// @vitest-environment jsdom

import { LanguageProvider, useLanguage } from "@/providers/language-provider";
import { en } from "@/i18n/en";
import { th } from "@/i18n/th";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchAccessContext } from "@/branch-api-client";
import {
  createPurchaseOrder,
  getPurchaseOrder,
  listPurchaseOrders,
  PurchaseOrderApiError,
  transitionPurchaseOrder,
  updatePurchaseOrder,
} from "@/purchase-order-api-client";
import { listSuppliers } from "@/supplier-api-client";
import { listProducts } from "@/catalog-api-client";
import {
  receivePurchaseOrder,
  ReceivingApiError,
} from "@/receiving-api-client";

import { PurchaseOrderManagement } from "./purchase-order-management";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const BRANCH_ID = "20000000-0000-4000-8000-000000000001";
const SUPPLIER_ID = "30000000-0000-4000-8000-000000000001";
const PRODUCT_ID = "40000000-0000-4000-8000-000000000001";
const ORDER_ID = "50000000-0000-4000-8000-000000000001";
let role: "OWNER" | "ADMIN" | "BRANCH_MANAGER" | "INVENTORY_STAFF" | "CASHIER" =
  "OWNER";
let search = new URLSearchParams({
  branchId: BRANCH_ID,
  organizationId: ORGANIZATION_ID,
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => search,
}));
vi.mock("@/branch-api-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/branch-api-client")>()),
  fetchAccessContext: vi.fn(),
}));
vi.mock("@/purchase-order-api-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/purchase-order-api-client")>()),
  createPurchaseOrder: vi.fn(),
  getPurchaseOrder: vi.fn(),
  listPurchaseOrders: vi.fn(),
  transitionPurchaseOrder: vi.fn(),
  updatePurchaseOrder: vi.fn(),
}));
vi.mock("@/supplier-api-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/supplier-api-client")>()),
  listSuppliers: vi.fn(),
}));
vi.mock("@/catalog-api-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/catalog-api-client")>()),
  listProducts: vi.fn(),
}));
vi.mock("@/receiving-api-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/receiving-api-client")>()),
  receivePurchaseOrder: vi.fn(),
}));

const order = {
  branchId: BRANCH_ID,
  cancelledAt: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  currency: "THB" as const,
  expectedDate: null,
  expectedTotal: "25.0000",
  id: ORDER_ID,
  items: [
    {
      expectedUnitCost: "12.5000",
      id: "60000000-0000-4000-8000-000000000001",
      productId: PRODUCT_ID,
      productNameSnapshot: "Tea",
      productSkuSnapshot: "TEA-1",
      quantity: "2",
    },
  ],
  orderDate: "2026-09-01",
  orderedAt: null,
  organizationId: ORGANIZATION_ID,
  receivedAt: null,
  reference: "PO-0001",
  status: "DRAFT" as const,
  supplierId: SUPPLIER_ID,
  updatedAt: "2026-09-01T00:00:00.000Z",
};
const receivedOrder = {
  ...order,
  receivedAt: "2026-09-01T00:00:02.000Z",
  status: "RECEIVED" as const,
  updatedAt: "2026-09-01T00:00:02.000Z",
};
const cancelledOrder = {
  ...order,
  cancelledAt: "2026-09-01T00:00:02.000Z",
  status: "CANCELLED" as const,
  updatedAt: "2026-09-01T00:00:02.000Z",
};

function TestLanguageToggle() {
  const { language, setLanguage } = useLanguage();
  return (
    <button onClick={() => setLanguage(language === "en" ? "th" : "en")}>
      Switch language
    </button>
  );
}
function renderManagement(localized = false) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      {localized ? (
        <LanguageProvider>
          <TestLanguageToggle />
          <PurchaseOrderManagement />
        </LanguageProvider>
      ) : (
        <PurchaseOrderManagement />
      )}
    </QueryClientProvider>,
  );
  return queryClient;
}

async function openOrderedPurchaseOrder() {
  vi.mocked(getPurchaseOrder).mockResolvedValue({
    ...order,
    status: "ORDERED",
  });
  const queryClient = renderManagement();
  await screen.findByText("PO-0001");
  fireEvent.click(screen.getByRole("button", { name: /PO-0001/ }));
  await screen.findByRole("heading", { name: "Receive full purchase order" });
  fireEvent.change(screen.getByLabelText("Tea actual unit cost"), {
    target: { value: "12.5000" },
  });
  return queryClient;
}

function confirmReceive() {
  fireEvent.click(
    screen.getByRole("button", { name: "Receive full purchase order" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Confirm receive" }));
}

function enterVatSnapshot() {
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: "Organization VAT registration asserted for this receipt",
    }),
  );
  fireEvent.change(screen.getByLabelText("Input VAT rate"), {
    target: { value: "7.000000" },
  });
  fireEvent.change(screen.getByLabelText("Input VAT amount"), {
    target: { value: "0.8750" },
  });
  fireEvent.change(screen.getByLabelText("Supplier tax document number"), {
    target: { value: "TAX-100" },
  });
  fireEvent.change(screen.getByLabelText("Supplier tax document date"), {
    target: { value: "2026-09-01" },
  });
}

beforeEach(() => {
  role = "OWNER";
  search = new URLSearchParams({
    branchId: BRANCH_ID,
    organizationId: ORGANIZATION_ID,
  });
  vi.mocked(fetchAccessContext).mockResolvedValue({
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
      email: "user@example.test",
      id: "70000000-0000-4000-8000-000000000001",
    },
  });
  vi.mocked(listSuppliers).mockResolvedValue({
    data: {
      suppliers: [
        {
          address: null,
          contactName: null,
          createdAt: "2026-09-01T00:00:00.000Z",
          email: null,
          id: SUPPLIER_ID,
          name: "Tea Supply",
          organizationId: ORGANIZATION_ID,
          phone: null,
          status: "ACTIVE",
          updatedAt: "2026-09-01T00:00:00.000Z",
        },
      ],
    },
    meta: { nextCursor: null },
  });
  vi.mocked(listProducts).mockResolvedValue({
    data: {
      products: [
        {
          barcode: null,
          basePrice: "1.0000",
          categoryId: null,
          createdAt: "2026-09-01T00:00:00.000Z",
          description: null,
          id: PRODUCT_ID,
          name: "Tea",
          organizationId: ORGANIZATION_ID,
          sku: "TEA-1",
          status: "ACTIVE",
          unit: "EA",
          updatedAt: "2026-09-01T00:00:00.000Z",
        },
        {
          barcode: null,
          basePrice: "2.0000",
          categoryId: null,
          createdAt: "2026-09-01T00:00:00.000Z",
          description: null,
          id: "40000000-0000-4000-8000-000000000002",
          name: "Coffee",
          organizationId: ORGANIZATION_ID,
          sku: "COFFEE-1",
          status: "ACTIVE",
          unit: "KG",
          updatedAt: "2026-09-01T00:00:00.000Z",
        },
      ],
    },
    meta: { nextCursor: null },
  });
  vi.mocked(listPurchaseOrders).mockResolvedValue({
    data: {
      purchaseOrders: [
        { ...order, items: undefined } as Omit<typeof order, "items">,
      ],
    },
    meta: { nextCursor: null },
  });
  vi.mocked(getPurchaseOrder).mockResolvedValue(order);
  vi.mocked(createPurchaseOrder).mockResolvedValue(order);
  vi.mocked(updatePurchaseOrder).mockResolvedValue(order);
  vi.mocked(transitionPurchaseOrder).mockResolvedValue({
    ...order,
    status: "ORDERED",
    orderedAt: "2026-09-01T00:00:01.000Z",
    updatedAt: "2026-09-01T00:00:01.000Z",
  });
  vi.mocked(receivePurchaseOrder).mockResolvedValue({
    branchId: BRANCH_ID,
    createdAt: "2026-09-01T00:00:02.000Z",
    id: "90000000-0000-4000-8000-000000000001",
    inputVatAmount: null,
    inputVatRate: null,
    items: [
      {
        actualUnitCost: "12.5000",
        id: "90000000-0000-4000-8000-000000000002",
        productId: PRODUCT_ID,
        productNameSnapshot: "Tea",
        productSkuSnapshot: "TEA-1",
        purchaseOrderItemId: "60000000-0000-4000-8000-000000000001",
        receivedQuantity: "2",
      },
    ],
    organizationId: ORGANIZATION_ID,
    organizationVatRegisteredSnapshot: false,
    purchaseOrderId: ORDER_ID,
    receivedAt: "2026-09-01T00:00:02.000Z",
    receivedByUserId: "70000000-0000-4000-8000-000000000001",
    reference: "REC-0001",
    supplierId: SUPPLIER_ID,
    supplierTaxDocumentDate: null,
    supplierTaxDocumentNumber: null,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("purchase order management UI", () => {
  it("formats frozen receiving costs without formatting quantities or entered costs", async () => {
    vi.mocked(getPurchaseOrder).mockResolvedValue({
      ...order,
      status: "ORDERED",
      items: [
        { ...order.items[0]!, expectedUnitCost: "4.1230", quantity: "1.2500" },
      ],
    });
    renderManagement();
    await screen.findByText("PO-0001");
    fireEvent.click(screen.getByRole("button", { name: /PO-0001/ }));
    expect(await screen.findByText("Expected: 4.123 THB")).toBeTruthy();
    expect(screen.getByText("Quantity: 1.2500")).toBeTruthy();
    expect(screen.getByText("Expected total: 25.00 THB")).toBeTruthy();
    const input = screen.getByLabelText("Tea actual unit cost");
    fireEvent.change(input, { target: { value: "4.1230" } });
    expect(input).toHaveProperty("value", "4.1230");
  });

  it("creates a DRAFT with string quantity and cost and prevents a duplicate product line", async () => {
    renderManagement();
    const form = await screen.findByRole("form", {
      name: "Create draft purchase order",
    });
    await waitFor(() => expect(listSuppliers).toHaveBeenCalled());
    fireEvent.change(within(form).getByLabelText("Supplier"), {
      target: { value: SUPPLIER_ID },
    });
    fireEvent.change(within(form).getByLabelText("Product line 1 product"), {
      target: { value: PRODUCT_ID },
    });
    await waitFor(() =>
      expect(
        within(form).getByLabelText("Product line 1 quantity (EA)"),
      ).toBeTruthy(),
    );
    fireEvent.change(
      within(form).getByLabelText("Product line 1 quantity (EA)"),
      {
        target: { value: "2" },
      },
    );
    fireEvent.change(
      within(form).getByLabelText("Product line 1 expected unit cost (THB)"),
      {
        target: { value: "12.5000" },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Add product line" }));
    fireEvent.change(within(form).getByLabelText("Product line 2 product"), {
      target: { value: "40000000-0000-4000-8000-000000000002" },
    });
    const secondProduct = within(form).getByLabelText(
      "Product line 2 product",
    ) as HTMLSelectElement;
    expect(
      Array.from(secondProduct.options).some(
        (option) => option.value === PRODUCT_ID,
      ),
    ).toBe(false);
    fireEvent.change(
      within(form).getByLabelText("Product line 2 quantity (KG)"),
      { target: { value: "0.5" } },
    );
    fireEvent.change(
      within(form).getByLabelText("Product line 2 expected unit cost (THB)"),
      { target: { value: "8" } },
    );
    fireEvent.submit(form);
    await waitFor(() =>
      expect(createPurchaseOrder).toHaveBeenCalledWith(
        { branchId: BRANCH_ID, organizationId: ORGANIZATION_ID },
        expect.objectContaining({
          items: [
            {
              expectedUnitCost: "12.5000",
              productId: PRODUCT_ID,
              quantity: "2",
            },
            {
              expectedUnitCost: "8",
              productId: "40000000-0000-4000-8000-000000000002",
              quantity: "0.5",
            },
          ],
          supplierId: SUPPLIER_ID,
        }),
      ),
    );
  });

  it("uses the server updatedAt for DRAFT edits and renders the returned total", async () => {
    renderManagement();
    await screen.findByText("PO-0001");
    fireEvent.click(screen.getByRole("button", { name: /PO-0001/ }));
    const form = await screen.findByRole("form", {
      name: "Save draft changes",
    });
    expect(
      screen.getByText("Server-calculated expected total: 25.00 THB"),
    ).toBeTruthy();
    fireEvent.submit(form);
    await waitFor(() =>
      expect(updatePurchaseOrder).toHaveBeenCalledWith(
        { branchId: BRANCH_ID, organizationId: ORGANIZATION_ID },
        ORDER_ID,
        expect.objectContaining({
          expectedUpdatedAt: "2026-09-01T00:00:00.000Z",
        }),
      ),
    );
  });

  it("requires ORDER confirmation and sends only the constrained lifecycle action", async () => {
    renderManagement();
    await screen.findByText("PO-0001");
    fireEvent.click(screen.getByRole("button", { name: /PO-0001/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Order purchase order" }),
    );
    expect(await screen.findByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm order" }));
    await waitFor(() =>
      expect(transitionPurchaseOrder).toHaveBeenCalledWith(
        { branchId: BRANCH_ID, organizationId: ORGANIZATION_ID },
        expect.objectContaining({
          id: ORDER_ID,
          updatedAt: "2026-09-01T00:00:00.000Z",
        }),
        "ORDERED",
      ),
    );
  });

  it("refreshes on a stale write without replaying it", async () => {
    vi.mocked(updatePurchaseOrder).mockRejectedValue(
      new PurchaseOrderApiError("stale"),
    );
    renderManagement();
    await screen.findByText("PO-0001");
    fireEvent.click(screen.getByRole("button", { name: /PO-0001/ }));
    fireEvent.submit(
      await screen.findByRole("form", { name: "Save draft changes" }),
    );
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /changed elsewhere/i,
    );
    expect(updatePurchaseOrder).toHaveBeenCalledTimes(1);
  });

  it("does not give CASHIER purchase-order actions", async () => {
    role = "CASHIER";
    vi.mocked(fetchAccessContext).mockResolvedValue({
      firstOrganizationOnboarding: { eligible: false },
      organizations: [
        {
          branches: [{ code: "MAIN", id: BRANCH_ID, name: "Main" }],
          id: ORGANIZATION_ID,
          name: "Store",
          role: "CASHIER",
        },
      ],
      user: {
        displayName: "User",
        email: "user@example.test",
        id: "70000000-0000-4000-8000-000000000001",
      },
    });
    renderManagement();
    expect(
      await screen.findByText(
        "You do not have permission to manage purchase orders.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole("form", { name: "Create draft purchase order" }),
    ).toBeNull();
  });

  it("keeps one idempotency key for an ambiguous retry and replaces it after input changes", async () => {
    vi.stubGlobal("crypto", {
      randomUUID: vi
        .fn()
        .mockReturnValueOnce("key-one")
        .mockReturnValueOnce("key-two"),
    });
    vi.mocked(getPurchaseOrder).mockResolvedValue({
      ...order,
      status: "ORDERED",
    });
    vi.mocked(receivePurchaseOrder)
      .mockRejectedValueOnce(new TypeError("network"))
      .mockRejectedValueOnce(new TypeError("network"));
    renderManagement();
    await screen.findByText("PO-0001");
    fireEvent.click(screen.getByRole("button", { name: /PO-0001/ }));
    await screen.findByRole("heading", { name: "Receive full purchase order" });
    fireEvent.change(screen.getByLabelText("Tea actual unit cost"), {
      target: { value: "12.5000" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Receive full purchase order" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm receive" }));
    await screen.findByRole("alert");
    expect(screen.getByText(/status is unknown/i)).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Receive full purchase order" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm receive" }));
    await waitFor(() => expect(receivePurchaseOrder).toHaveBeenCalledTimes(2));
    expect(vi.mocked(receivePurchaseOrder).mock.calls[0]![3]).toBe("key-one");
    expect(vi.mocked(receivePurchaseOrder).mock.calls[1]![3]).toBe("key-one");
    fireEvent.change(screen.getByLabelText("Tea actual unit cost"), {
      target: { value: "13" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Receive full purchase order" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm receive" }));
    await waitFor(() => expect(receivePurchaseOrder).toHaveBeenCalledTimes(3));
    expect(vi.mocked(receivePurchaseOrder).mock.calls[2]![3]).toBe("key-two");
  });

  it("blocks a second confirmation while receiving is pending", async () => {
    let resolveReceive: undefined | (() => void);
    vi.mocked(receivePurchaseOrder).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveReceive = () =>
            resolve({
              branchId: BRANCH_ID,
              createdAt: "2026-09-01T00:00:02.000Z",
              id: "90000000-0000-4000-8000-000000000001",
              inputVatAmount: null,
              inputVatRate: null,
              items: [],
              organizationId: ORGANIZATION_ID,
              organizationVatRegisteredSnapshot: false,
              purchaseOrderId: ORDER_ID,
              receivedAt: "2026-09-01T00:00:02.000Z",
              receivedByUserId: "70000000-0000-4000-8000-000000000001",
              reference: "REC-0001",
              supplierId: SUPPLIER_ID,
              supplierTaxDocumentDate: null,
              supplierTaxDocumentNumber: null,
            });
        }),
    );
    vi.mocked(getPurchaseOrder).mockResolvedValue({
      ...order,
      status: "ORDERED",
    });
    renderManagement();
    await screen.findByText("PO-0001");
    fireEvent.click(screen.getByRole("button", { name: /PO-0001/ }));
    await screen.findByRole("heading", { name: "Receive full purchase order" });
    fireEvent.change(screen.getByLabelText("Tea actual unit cost"), {
      target: { value: "12.5000" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Receive full purchase order" }),
    );
    const confirm = screen.getByRole("button", { name: "Confirm receive" });
    fireEvent.click(confirm);
    await waitFor(() => expect(receivePurchaseOrder).toHaveBeenCalledTimes(1));
    for (const button of screen.getAllByRole("button", {
      name: "Receiving…",
    }))
      expect(button).toHaveProperty("disabled", true);
    fireEvent.click(screen.getAllByRole("button", { name: "Receiving…" })[1]!);
    expect(receivePurchaseOrder).toHaveBeenCalledTimes(1);
    resolveReceive?.();
  });

  it.each([
    [
      "VAT registration assertion",
      () =>
        fireEvent.click(
          screen.getByRole("checkbox", {
            name: "Organization VAT registration asserted for this receipt",
          }),
        ),
    ],
    [
      "VAT rate",
      () =>
        fireEvent.change(screen.getByLabelText("Input VAT rate"), {
          target: { value: "8" },
        }),
    ],
    [
      "VAT amount",
      () =>
        fireEvent.change(screen.getByLabelText("Input VAT amount"), {
          target: { value: "0.8751" },
        }),
    ],
    [
      "supplier tax document number",
      () =>
        fireEvent.change(
          screen.getByLabelText("Supplier tax document number"),
          { target: { value: "TAX-101" } },
        ),
    ],
    [
      "supplier tax document date",
      () =>
        fireEvent.change(screen.getByLabelText("Supplier tax document date"), {
          target: { value: "2026-09-02" },
        }),
    ],
  ])(
    "creates a new idempotency key when %s changes after an ambiguous result",
    async (_field, changeIntent) => {
      vi.stubGlobal("crypto", {
        randomUUID: vi
          .fn()
          .mockReturnValueOnce("vat-key-one")
          .mockReturnValueOnce("vat-key-two"),
      });
      vi.mocked(receivePurchaseOrder).mockRejectedValue(
        new TypeError("network"),
      );
      await openOrderedPurchaseOrder();
      enterVatSnapshot();
      confirmReceive();
      await screen.findByRole("alert", { name: "" });
      expect(vi.mocked(receivePurchaseOrder).mock.calls[0]![3]).toBe(
        "vat-key-one",
      );

      if (_field === "VAT registration assertion") {
        changeIntent();
        fireEvent.change(screen.getByLabelText("Input VAT rate"), {
          target: { value: "" },
        });
        fireEvent.change(screen.getByLabelText("Input VAT amount"), {
          target: { value: "" },
        });
        fireEvent.change(
          screen.getByLabelText("Supplier tax document number"),
          {
            target: { value: "" },
          },
        );
        fireEvent.change(screen.getByLabelText("Supplier tax document date"), {
          target: { value: "" },
        });
      } else {
        changeIntent();
      }
      confirmReceive();
      await waitFor(() =>
        expect(receivePurchaseOrder).toHaveBeenCalledTimes(2),
      );
      expect(vi.mocked(receivePurchaseOrder).mock.calls[1]![3]).toBe(
        "vat-key-two",
      );
    },
  );

  it("keeps an idempotency conflict visible without replaying or rotating its key", async () => {
    vi.stubGlobal("crypto", {
      randomUUID: vi
        .fn()
        .mockReturnValueOnce("conflict-key-one")
        .mockReturnValueOnce("conflict-key-two"),
    });
    vi.mocked(receivePurchaseOrder).mockRejectedValue(
      new ReceivingApiError("idempotency_conflict"),
    );
    await openOrderedPurchaseOrder();
    confirmReceive();
    expect(
      await screen.findByText(/represents different receipt intent/i),
    ).toBeTruthy();
    expect(receivePurchaseOrder).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Tea actual unit cost")).toHaveProperty(
      "value",
      "12.5000",
    );

    fireEvent.change(screen.getByLabelText("Tea actual unit cost"), {
      target: { value: "13" },
    });
    confirmReceive();
    await waitFor(() => expect(receivePurchaseOrder).toHaveBeenCalledTimes(2));
    expect(vi.mocked(receivePurchaseOrder).mock.calls[0]![3]).toBe(
      "conflict-key-one",
    );
    expect(vi.mocked(receivePurchaseOrder).mock.calls[1]![3]).toBe(
      "conflict-key-two",
    );
  });

  it.each([
    ["RECEIVED", receivedOrder],
    ["CANCELLED", cancelledOrder],
  ])(
    "refreshes authoritative %s state after a receive state conflict without replaying",
    async (_status, refreshedOrder) => {
      vi.mocked(receivePurchaseOrder).mockRejectedValue(
        new ReceivingApiError("state_conflict"),
      );
      vi.mocked(getPurchaseOrder)
        .mockResolvedValueOnce({ ...order, status: "ORDERED" })
        .mockResolvedValueOnce(refreshedOrder);
      const queryClient = renderManagement();
      await screen.findByText("PO-0001");
      fireEvent.click(screen.getByRole("button", { name: /PO-0001/ }));
      await screen.findByRole("heading", {
        name: "Receive full purchase order",
      });
      const invalidate = vi.spyOn(queryClient, "invalidateQueries");
      fireEvent.change(screen.getByLabelText("Tea actual unit cost"), {
        target: { value: "12.5000" },
      });
      confirmReceive();
      expect(await screen.findByText(/changed state/i)).toBeTruthy();
      await waitFor(() => expect(getPurchaseOrder).toHaveBeenCalledTimes(2));
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: [
          "branch-scoped",
          ORGANIZATION_ID,
          BRANCH_ID,
          "purchase-orders",
          "detail",
          ORDER_ID,
        ],
      });
      expect(
        screen.queryByRole("heading", { name: "Receive full purchase order" }),
      ).toBeNull();
      expect(receivePurchaseOrder).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["201 first success", "200 exact replay"])(
    "renders the authoritative receipt and refreshes only current-scope purchase-order and inventory queries for %s",
    async (successKind) => {
      void successKind;
      vi.mocked(getPurchaseOrder)
        .mockResolvedValueOnce({ ...order, status: "ORDERED" })
        .mockResolvedValueOnce(receivedOrder);
      const queryClient = renderManagement();
      await screen.findByText("PO-0001");
      fireEvent.click(screen.getByRole("button", { name: /PO-0001/ }));
      await screen.findByRole("heading", {
        name: "Receive full purchase order",
      });
      const invalidate = vi.spyOn(queryClient, "invalidateQueries");
      fireEvent.change(screen.getByLabelText("Tea actual unit cost"), {
        target: { value: "12.5000" },
      });
      confirmReceive();
      expect(
        await screen.findByText("Receipt REC-0001 completed"),
      ).toBeTruthy();
      expect(getPurchaseOrder).toHaveBeenCalledTimes(2);
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: [
          "branch-scoped",
          ORGANIZATION_ID,
          BRANCH_ID,
          "purchase-orders",
          "list",
        ],
      });
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ["branch-scoped", ORGANIZATION_ID, BRANCH_ID, "inventory"],
      });
      for (const call of invalidate.mock.calls) {
        const key = call[0]?.queryKey;
        expect(key?.slice(0, 3)).toEqual([
          "branch-scoped",
          ORGANIZATION_ID,
          BRANCH_ID,
        ]);
      }
      expect(
        screen.queryByRole("heading", { name: "Receive full purchase order" }),
      ).toBeNull();
    },
  );

  it("keeps the confirmed receipt and invalidates current scope when its follow-up PO read fails", async () => {
    vi.mocked(getPurchaseOrder)
      .mockResolvedValueOnce({ ...order, status: "ORDERED" })
      .mockRejectedValueOnce(new PurchaseOrderApiError("unavailable"));
    const queryClient = renderManagement();
    await screen.findByText("PO-0001");
    fireEvent.click(screen.getByRole("button", { name: /PO-0001/ }));
    await screen.findByRole("heading", {
      name: "Receive full purchase order",
    });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    fireEvent.change(screen.getByLabelText("Tea actual unit cost"), {
      target: { value: "12.5000" },
    });
    confirmReceive();
    expect(await screen.findByText("Receipt REC-0001 completed")).toBeTruthy();
    expect(await screen.findByText(/could not be refreshed/i)).toBeTruthy();
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: [
        "branch-scoped",
        ORGANIZATION_ID,
        BRANCH_ID,
        "purchase-orders",
        "detail",
        ORDER_ID,
      ],
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["branch-scoped", ORGANIZATION_ID, BRANCH_ID, "inventory"],
    });
  });

  it("labels receiving fields and gives the confirmation dialog keyboard focus", async () => {
    await openOrderedPurchaseOrder();
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Organization VAT registration asserted for this receipt",
      }),
    );
    const cost = screen.getByLabelText("Tea actual unit cost");
    expect(cost.getAttribute("aria-describedby")).not.toBeNull();
    expect(
      screen.getByRole("checkbox", {
        name: "Organization VAT registration asserted for this receipt",
      }),
    ).toBeTruthy();
    for (const label of [
      "Input VAT rate",
      "Input VAT amount",
      "Supplier tax document number",
      "Supplier tax document date",
    ])
      expect(
        screen.getByLabelText(label).getAttribute("aria-describedby"),
      ).not.toBeNull();

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Organization VAT registration asserted for this receipt",
      }),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Receive full purchase order" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Confirm irreversible receipt",
    });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Cancel" }),
    );
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Confirm receive" }),
    );
  });
});

it("retranslates draft validation while preserving entered values and avoiding writes", async () => {
  localStorage.clear();
  renderManagement(true);
  const form = await screen.findByRole("form", {
    name: en.uiCreateDraftPurchaseOrder,
  });
  fireEvent.submit(form);
  expect(await screen.findByText(en.uiChooseAnActiveSupplier)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Switch language" }));
  expect(screen.getByRole("alert").textContent).toBe(
    th.uiChooseAnActiveSupplier,
  );
  expect(
    screen.getByRole("form", { name: th.uiCreateDraftPurchaseOrder }),
  ).toBeTruthy();
  expect(createPurchaseOrder).not.toHaveBeenCalled();
  localStorage.clear();
});
