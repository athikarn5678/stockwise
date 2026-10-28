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
  createSaleRefund,
  getSalesHistoryDetail,
  listSalesHistory,
  SalesApiError,
  type SalesHistoryDetail,
} from "@/sales-api-client";

import { SalesHistoryManagement } from "./sales-history-management";
import { SaleReceipt } from "./sale-receipt";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const BRANCH_ID = "20000000-0000-4000-8000-000000000001";
const SALE_ID = "30000000-0000-4000-8000-000000000001";
const CASHIER_ID = "40000000-0000-4000-8000-000000000001";
const scrollIntoView = vi.fn();
const originalScrollIntoView = Object.getOwnPropertyDescriptor(
  Element.prototype,
  "scrollIntoView",
);
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
    createSaleRefund: vi.fn(),
    getSalesHistoryDetail: vi.fn(),
    listSalesHistory: vi.fn(),
  };
});

const summary = {
  actorDisplayName: "Historical cashier",
  createdAt: "2026-09-18T10:00:00.000Z",
  currency: "THB" as const,
  discount: null,
  discountAmount: "0.00",
  id: SALE_ID,
  itemCount: 1,
  outputVatAmount: "0.00",
  payment: {
    amount: "12.34",
    amountTendered: "20.00",
    changeAmount: "7.66",
    method: "CASH" as const,
    reference: null,
  },
  reference: "SALE-IMMUTABLE-001",
  refundedAmount: "0.00",
  refundState: "NONE" as const,
  remainingAmount: "12.34",
  salesVatRate: null,
  salesVatStatus: "NOT_REGISTERED" as const,
  subtotalAmount: "12.34",
  taxableAmount: null,
  totalAmount: "12.34",
};
const detail: SalesHistoryDetail = {
  ...summary,
  branchCode: "MAIN",
  branchName: "Main",
  items: [
    {
      id: "50000000-0000-4000-8000-000000000001",
      lineDiscount: "0.00",
      lineGross: "12.34",
      lineNet: "12.34",
      lineOutputVat: "0.00",
      lineTaxable: null,
      productId: "60000000-0000-4000-8000-000000000001",
      productName: "Historical coffee",
      productSku: "COFFEE-OLD",
      quantity: "1.0000",
      remainingRefundableQuantity: "1.0000",
      unit: "EA",
      unitPrice: "12.3400",
    },
  ],
  organizationName: "Store",
  refunds: [],
};

function renderSales() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <SalesHistoryManagement />
    </QueryClientProvider>,
  );
  return queryClient;
}

function mockAccess(roleValue: typeof role) {
  vi.mocked(fetchAccessContext).mockResolvedValue({
    firstOrganizationOnboarding: { eligible: false },
    organizations: [
      {
        branches: [{ code: "MAIN", id: BRANCH_ID, name: "Main" }],
        id: ORGANIZATION_ID,
        name: "Store",
        role: roleValue,
      },
    ],
    user: { displayName: "Owner", email: "owner@example.test", id: CASHIER_ID },
  });
}

beforeEach(() => {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: scrollIntoView,
  });
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
  role = "OWNER";
  currentSearchParams = new URLSearchParams({
    branchId: BRANCH_ID,
    organizationId: ORGANIZATION_ID,
  });
  mockAccess(role);
  vi.mocked(listSalesHistory).mockResolvedValue({
    data: { sales: [summary] },
    meta: { nextCursor: "opaque-next" },
  });
  vi.mocked(getSalesHistoryDetail).mockResolvedValue(detail);
  vi.mocked(createSaleRefund).mockResolvedValue({
    actorDisplayName: "Owner",
    branchId: BRANCH_ID,
    completedAt: "2026-09-19T09:00:00.000Z",
    currency: "THB",
    discountAmount: "0.00",
    grossAmount: "12.34",
    id: "70000000-0000-4000-8000-000000000001",
    items: [
      {
        id: "80000000-0000-4000-8000-000000000001",
        productId: detail.items[0]!.productId,
        refundQuantity: "1",
        restockQuantity: "1",
        reversedLineDiscount: "0.00",
        reversedLineGross: "12.34",
        reversedLineNet: "12.34",
        reversedLineOutputVat: "0.00",
        reversedLineTaxable: null,
        saleItemId: detail.items[0]!.id,
      },
    ],
    organizationId: ORGANIZATION_ID,
    outputVatAmount: "0.00",
    payment: { amount: "12.34", method: "CASH", reference: null },
    reason: "Customer return",
    reference: "REFUND-001",
    saleId: SALE_ID,
    salesVatRate: null,
    salesVatStatus: "NOT_REGISTERED",
    taxableAmount: null,
    totalAmount: "12.34",
  });
  vi.stubGlobal("print", vi.fn());
});

afterEach(() => {
  cleanup();
  if (originalScrollIntoView)
    Object.defineProperty(
      Element.prototype,
      "scrollIntoView",
      originalScrollIntoView,
    );
  else Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("sales history UI", () => {
  it("scrolls to rendered detail only after loading succeeds without moving focus", async () => {
    let resolveDetail!: (sale: SalesHistoryDetail) => void;
    vi.mocked(getSalesHistoryDetail).mockReturnValue(
      new Promise((resolve) => {
        resolveDetail = resolve;
      }),
    );
    renderSales();
    const button = await screen.findByRole("button", { name: "View detail" });
    expect(scrollIntoView).not.toHaveBeenCalled();
    button.focus();
    fireEvent.click(button);
    expect(await screen.findByText("Loading sale detail…")).toBeTruthy();
    expect(screen.queryByLabelText("Printable receipt")).toBeNull();
    expect(scrollIntoView).not.toHaveBeenCalled();

    await act(async () => resolveDetail(detail));
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
    const section = scrollIntoView.mock.instances[0] as HTMLElement;
    expect(section.contains(screen.getByLabelText("Printable receipt"))).toBe(
      true,
    );
    expect(
      section.contains(screen.getByRole("heading", { name: detail.reference })),
    ).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "start",
    });
    expect(document.activeElement).toBe(button);
  });

  it("does not scroll again for input changes, repeated selection, reprint, or detail refetch", async () => {
    const client = renderSales();
    const button = await screen.findByRole("button", { name: "View detail" });
    fireEvent.click(button);
    await screen.findByLabelText("Printable receipt");
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText("Cashier user ID (optional)"), {
      target: { value: "unfinished filter" },
    });
    fireEvent.click(button);
    fireEvent.click(screen.getByRole("button", { name: "Print receipt" }));
    vi.mocked(getSalesHistoryDetail).mockResolvedValue({
      ...detail,
      items: [{ ...detail.items[0]!, productName: "Refetched coffee" }],
    });
    await act(async () => {
      await client.invalidateQueries({
        queryKey: [
          "branch-scoped",
          ORGANIZATION_ID,
          BRANCH_ID,
          "sales",
          "detail",
          SALE_ID,
        ],
      });
    });
    await screen.findAllByText("Refetched coffee");
    expect(getSalesHistoryDetail).toHaveBeenCalledTimes(2);
    expect(window.print).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("scrolls for each different sale opened, including returning to cached detail", async () => {
    const second = {
      ...detail,
      id: "30000000-0000-4000-8000-000000000002",
      reference: "SALE-SECOND",
    };
    vi.mocked(listSalesHistory).mockResolvedValue({
      data: { sales: [summary, second] },
      meta: { nextCursor: null },
    });
    vi.mocked(getSalesHistoryDetail).mockImplementation(async (_, id) =>
      id === SALE_ID ? detail : second,
    );
    renderSales();
    await screen.findByText(second.reference);
    const buttons = screen.getAllByRole("button", { name: "View detail" });
    for (const [button, sale] of [
      [buttons[0]!, detail],
      [buttons[1]!, second],
      [buttons[0]!, detail],
    ] as const) {
      fireEvent.click(button);
      await screen.findByRole("heading", { name: sale.reference });
      expect(scrollIntoView.mock.lastCall).toEqual([
        { behavior: "smooth", block: "start" },
      ]);
    }
    expect(scrollIntoView).toHaveBeenCalledTimes(3);
  });

  it("does not scroll when the requested sale detail fails", async () => {
    vi.mocked(getSalesHistoryDetail).mockRejectedValue(
      new SalesApiError("sale_not_found"),
    );
    renderSales();
    fireEvent.click(await screen.findByRole("button", { name: "View detail" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "This sale is no longer available",
    );
    expect(screen.queryByLabelText("Printable receipt")).toBeNull();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("scrolls without smooth motion when reduced motion is preferred", async () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    renderSales();
    fireEvent.click(await screen.findByRole("button", { name: "View detail" }));
    await screen.findByLabelText("Printable receipt");
    expect(window.matchMedia).toHaveBeenCalledWith(
      "(prefers-reduced-motion: reduce)",
    );
    expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({
      behavior: "auto",
      block: "start",
    });
  });

  it("renders the receipt identity and frozen totals including registered VAT and discount", () => {
    render(
      <SaleReceipt
        sale={{
          ...detail,
          discount: {
            type: "AMOUNT",
            amount: "1.34",
            reason: "Approved discount",
          },
          discountAmount: "1.34",
          subtotalAmount: "12.34",
          taxableAmount: "10.28",
          outputVatAmount: "0.72",
          salesVatStatus: "REGISTERED",
          salesVatRate: "7",
          totalAmount: "11.00",
          items: [
            {
              ...detail.items[0]!,
              lineDiscount: "1.34",
              lineNet: "11.00",
              lineTaxable: "10.28",
              lineOutputVat: "0.72",
            },
          ],
          payment: {
            method: "CASH",
            amount: "11.00",
            amountTendered: "20.00",
            changeAmount: "9.00",
            reference: null,
          },
        }}
      />,
    );
    const receipt = screen.getByLabelText("Printable receipt");
    expect(receipt.textContent).toContain("SALE-IMMUTABLE-001");
    expect(receipt.textContent).toContain("2026-09-18 10:00:00 UTC");
    expect(receipt.textContent).toContain("Historical cashier");
    for (const value of [
      "SubtotalTHB 12.34",
      "DiscountTHB 1.34",
      "Taxable amountTHB 10.28",
      "VATTHB 0.72",
      "TotalTHB 11.00",
    ]) {
      expect(receipt.textContent).toContain(value);
    }
  });

  it("omits unsupported optional fields and renders long catalog text safely", () => {
    const productName =
      "<img src=x onerror=alert(1)> " + "Long product name ".repeat(30);
    render(
      <SaleReceipt
        sale={{
          ...detail,
          payment: {
            method: "TRANSFER",
            amount: "12.34",
            amountTendered: null,
            changeAmount: null,
            reference: null,
          },
          items: [{ ...detail.items[0]!, productName }],
        }}
      />,
    );
    const receipt = screen.getByLabelText("Printable receipt");
    expect(receipt.textContent).toContain(productName);
    expect(receipt.querySelector("img")).toBeNull();
    expect(receipt.textContent).toContain("Payment: Transfer · THB 12.34");
    expect(receipt.textContent).not.toMatch(
      /Taxable amount|Discount|Tendered|Change|Transfer reference|CARD|Stripe/,
    );
  });

  it("retains every line in a long receipt and the authoritative total without recalculation", () => {
    render(
      <SaleReceipt
        sale={{
          ...detail,
          items: Array.from({ length: 80 }, (_, index) => ({
            ...detail.items[0]!,
            id: String(index),
            productName: `Historical item ${index}`,
            unitPrice: "9007199254740993.1234",
          })),
        }}
      />,
    );
    const receipt = screen.getByLabelText("Printable receipt");
    expect(receipt.querySelectorAll("li")).toHaveLength(80);
    expect(receipt.textContent).toContain("THB 9007199254740993.1234");
    expect(receipt.textContent).toContain("TotalTHB 12.34");
  });

  it.each([
    ["4.0000", "4.00"],
    ["4.1230", "4.123"],
    ["4.1234", "4.1234"],
  ])(
    "formats immutable detail and receipt price %s without altering quantity",
    async (unitPrice, display) => {
      vi.mocked(getSalesHistoryDetail).mockResolvedValue({
        ...detail,
        items: [{ ...detail.items[0]!, unitPrice }],
      });
      renderSales();
      await screen.findByText("SALE-IMMUTABLE-001");
      fireEvent.click(screen.getByRole("button", { name: "View detail" }));
      await screen.findByLabelText("Printable receipt");
      const receipt = screen.getByLabelText("Printable receipt");
      expect(receipt.textContent).toContain(`THB ${display}`);
      expect(receipt.textContent).toContain("1.0000 EA");
      expect(
        screen.getByText(`THB ${display}`, { selector: "td" }),
      ).toBeTruthy();
      expect(receipt.textContent).toContain("THB 12.34");
    },
  );

  it("renders immutable branch-scoped history and forwards the opaque cursor", async () => {
    renderSales();
    expect(
      await screen.findByRole("heading", { name: "Sales history" }),
    ).toBeTruthy();
    expect(await screen.findByText("Historical cashier")).toBeTruthy();
    expect(
      screen.getByText(/Sale timestamps are shown in UTC\. Analytics uses/),
    ).toBeTruthy();
    expect(screen.queryByText(/OQ-016/)).toBeNull();
    expect(screen.getByText("THB 12.34")).toBeTruthy();
    await waitFor(() =>
      expect(listSalesHistory).toHaveBeenCalledWith(
        { branchId: BRANCH_ID, organizationId: ORGANIZATION_ID },
        { cursor: null },
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Load more sales" }));
    await waitFor(() =>
      expect(listSalesHistory).toHaveBeenLastCalledWith(
        { branchId: BRANCH_ID, organizationId: ORGANIZATION_ID },
        { cursor: "opaque-next" },
      ),
    );
  });

  it("shows loading, empty, and safe error states", async () => {
    vi.mocked(listSalesHistory).mockImplementation(() => new Promise(() => {}));
    renderSales();
    expect(await screen.findByText("Loading sales history…")).toBeTruthy();
    cleanup();
    vi.mocked(listSalesHistory).mockResolvedValue({
      data: { sales: [] },
      meta: { nextCursor: null },
    });
    renderSales();
    expect(await screen.findByText(/No completed sales match/i)).toBeTruthy();
    cleanup();
    vi.mocked(listSalesHistory).mockRejectedValue(
      new SalesApiError("unavailable"),
    );
    renderSales();
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /temporarily unavailable/i,
    );
  });

  it("resets the pagination chain when its exact actor filter changes", async () => {
    renderSales();
    await screen.findByText("SALE-IMMUTABLE-001");
    fireEvent.change(screen.getByLabelText("Cashier user ID (optional)"), {
      target: { value: CASHIER_ID },
    });
    fireEvent.submit(
      screen.getByRole("form", { name: "Filter sales history" }),
    );
    await waitFor(() =>
      expect(listSalesHistory).toHaveBeenLastCalledWith(
        { branchId: BRANCH_ID, organizationId: ORGANIZATION_ID },
        { actorUserId: CASHIER_ID, cursor: null },
      ),
    );
  });

  it("renders cash detail and prints the already fetched immutable sale without cost fields", async () => {
    role = "CASHIER";
    mockAccess(role);
    renderSales();
    await screen.findByText("SALE-IMMUTABLE-001");
    fireEvent.click(screen.getByRole("button", { name: "View detail" }));
    expect((await screen.findAllByText("Historical coffee")).length).toBe(2);
    expect(screen.getAllByText(/Tendered THB 20.00/)).toHaveLength(2);
    expect(screen.queryByText(/COGS|Internal cost/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Print receipt" }));
    expect(window.print).toHaveBeenCalledTimes(1);
    expect(getSalesHistoryDetail).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Printable receipt").textContent).not.toMatch(
      /COGS|cost/i,
    );
  });

  it("renders internal cost only when the authorized detail response contains it", async () => {
    const costDetail: SalesHistoryDetail = {
      ...detail,
      items: [
        {
          ...detail.items[0]!,
          cogsAmount: "4.5600000000",
          costBasisState: "KNOWN",
          unitCost: "4.560000",
        },
      ],
    };
    vi.mocked(getSalesHistoryDetail).mockResolvedValue(costDetail);
    renderSales();
    await screen.findByText("SALE-IMMUTABLE-001");
    fireEvent.click(screen.getByRole("button", { name: "View detail" }));
    expect(await screen.findByText(/COGS THB 4.56/)).toBeTruthy();
    expect(screen.getByLabelText("Printable receipt").textContent).not.toMatch(
      /COGS|cost/i,
    );
  });

  it("renders an immutable transfer reference", async () => {
    vi.mocked(getSalesHistoryDetail).mockResolvedValue({
      ...detail,
      payment: {
        amount: "12.34",
        amountTendered: null,
        changeAmount: null,
        method: "TRANSFER",
        reference: "TRANSFER-001",
      },
    });
    renderSales();
    await screen.findByText("SALE-IMMUTABLE-001");
    fireEvent.click(screen.getByRole("button", { name: "View detail" }));
    expect(await screen.findByText(/Reference TRANSFER-001/)).toBeTruthy();
    expect(screen.getByLabelText("Printable receipt").textContent).toMatch(
      /Transfer reference: TRANSFER-001/,
    );
  });

  it("lets authorized managers submit separate refund/restock quantities with a stable retry key", async () => {
    role = "BRANCH_MANAGER";
    mockAccess(role);
    vi.mocked(createSaleRefund).mockRejectedValue(
      new SalesApiError("refund_quantity_exceeded"),
    );
    renderSales();
    await screen.findByText("SALE-IMMUTABLE-001");
    fireEvent.click(screen.getByRole("button", { name: "View detail" }));
    const form = await screen.findByRole("form", {
      name: "Create sale refund",
    });

    fireEvent.submit(form);
    expect(
      await screen.findByText("Enter a refund quantity for at least one item."),
    ).toBeTruthy();
    expect(createSaleRefund).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Refund quantity"), {
      target: { value: "1" },
    });
    fireEvent.change(screen.getByLabelText("Restock quantity"), {
      target: { value: "0" },
    });
    fireEvent.submit(form);
    expect(
      await screen.findByText("Enter a reason for this refund."),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "Customer changed mind" },
    });
    fireEvent.submit(form);
    await waitFor(() => expect(createSaleRefund).toHaveBeenCalledTimes(1));
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /exceeds what remains/i,
    );
    fireEvent.submit(form);
    await waitFor(() => expect(createSaleRefund).toHaveBeenCalledTimes(2));

    const first = vi.mocked(createSaleRefund).mock.calls[0]!;
    const second = vi.mocked(createSaleRefund).mock.calls[1]!;
    expect(first[2]).toBe(second[2]);
    expect(first[3]).toEqual({
      items: [
        {
          quantity: "1",
          restockQuantity: "0",
          saleItemId: detail.items[0]!.id,
        },
      ],
      reason: "Customer changed mind",
      transferReference: null,
    });
  });

  it("requires a confirmed transfer reference before submitting a transfer refund", async () => {
    vi.mocked(getSalesHistoryDetail).mockResolvedValue({
      ...detail,
      payment: {
        amount: "12.34",
        amountTendered: null,
        changeAmount: null,
        method: "TRANSFER",
        reference: "SALE-TRANSFER",
      },
    });
    renderSales();
    await screen.findByText("SALE-IMMUTABLE-001");
    fireEvent.click(screen.getByRole("button", { name: "View detail" }));
    fireEvent.change(await screen.findByLabelText("Refund quantity"), {
      target: { value: "1" },
    });
    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "Transfer refund" },
    });
    fireEvent.submit(screen.getByRole("form", { name: "Create sale refund" }));
    expect(
      await screen.findByText("Enter the confirmed transfer reference."),
    ).toBeTruthy();
    expect(createSaleRefund).not.toHaveBeenCalled();
  });

  it("shows linked refund history to cashiers without exposing create or cost controls", async () => {
    role = "CASHIER";
    mockAccess(role);
    vi.mocked(getSalesHistoryDetail).mockResolvedValue({
      ...detail,
      refundedAmount: "12.34",
      refundState: "FULLY_REFUNDED",
      remainingAmount: "0.00",
      items: [{ ...detail.items[0]!, remainingRefundableQuantity: "0.0000" }],
      refunds: [
        {
          actorDisplayName: "Manager",
          branchId: BRANCH_ID,
          completedAt: "2026-09-19T09:00:00.000Z",
          currency: "THB",
          discountAmount: "0.00",
          grossAmount: "12.34",
          id: "70000000-0000-4000-8000-000000000001",
          items: [
            {
              id: "80000000-0000-4000-8000-000000000001",
              productId: detail.items[0]!.productId,
              refundQuantity: "1",
              restockQuantity: "0",
              reversedLineDiscount: "0.00",
              reversedLineGross: "12.34",
              reversedLineNet: "12.34",
              reversedLineOutputVat: "0.00",
              reversedLineTaxable: null,
              saleItemId: detail.items[0]!.id,
            },
          ],
          organizationId: ORGANIZATION_ID,
          outputVatAmount: "0.00",
          payment: { amount: "12.34", method: "CASH", reference: null },
          reason: "Customer return",
          reference: "REFUND-001",
          saleId: SALE_ID,
          salesVatRate: null,
          salesVatStatus: "NOT_REGISTERED",
          taxableAmount: null,
          totalAmount: "12.34",
        },
      ],
    });
    renderSales();
    await screen.findByText("SALE-IMMUTABLE-001");
    fireEvent.click(screen.getByRole("button", { name: "View detail" }));
    expect(await screen.findByText("REFUND-001")).toBeTruthy();
    expect(screen.getByText(/refunded 1, restocked 0/i)).toBeTruthy();
    expect(
      screen.queryByRole("form", { name: "Create sale refund" }),
    ).toBeNull();
    expect(screen.getByLabelText("Printable receipt").textContent).not.toMatch(
      /REFUND-001|refund|COGS|cost/i,
    );
  });

  it("keeps inventory staff out of the history UX", async () => {
    role = "INVENTORY_STAFF";
    mockAccess(role);
    renderSales();
    expect(
      await screen.findByRole("heading", { name: "Sales history unavailable" }),
    ).toBeTruthy();
    expect(listSalesHistory).not.toHaveBeenCalled();
  });
});
