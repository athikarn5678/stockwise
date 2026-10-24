import { afterEach, describe, expect, it, vi } from "vitest";

import {
  checkoutSale,
  createSaleRefund,
  getSalesHistoryDetail,
  getSalesVatProfile,
  listSalesHistory,
  SalesApiError,
  searchPosProducts,
  updateSalesVatProfile,
} from "./sales-api-client";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const BRANCH_ID = "20000000-0000-4000-8000-000000000001";
const PRODUCT_ID = "30000000-0000-4000-8000-000000000001";
const SALE_ID = "40000000-0000-4000-8000-000000000001";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("sales API client", () => {
  it("rejects a cancelled scanner lookup even when fetch returns a late success", async () => {
    const pending = Promise.withResolvers<Response>();
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(pending.promise));
    const controller = new AbortController();
    const lookup = searchPosProducts(
      { organizationId: ORGANIZATION_ID, branchId: BRANCH_ID },
      { barcode: " 00AbC ", signal: controller.signal },
    );
    controller.abort();
    pending.resolve(
      jsonResponse({ data: { products: [] }, meta: { nextCursor: null } }),
    );
    await expect(lookup).rejects.toBeInstanceOf(SalesApiError);
  });
  it("uses the scoped POS product endpoint and only parses the safe product representation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          products: [
            {
              available: true,
              barcode: "8850000000000",
              basePrice: "60.1234",
              id: PRODUCT_ID,
              name: "Coffee",
              sku: "COFFEE",
              unit: "EA",
            },
          ],
        },
        meta: { nextCursor: "next" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const page = await searchPosProducts(
      { branchId: BRANCH_ID, organizationId: ORGANIZATION_ID },
      { barcode: "8850000000000", q: "coffee" },
    );

    expect(page.data.products[0]).toEqual(
      expect.objectContaining({ basePrice: "60.1234", name: "Coffee" }),
    );
    expect(JSON.stringify(page)).not.toMatch(/cost|quantity|cogs/i);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      `/api/v1/organizations/${ORGANIZATION_ID}/branches/${BRANCH_ID}/pos/products?limit=25&barcode=8850000000000&q=coffee`,
    );
  });

  it("sends a same-origin idempotent checkout intent and parses server totals", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          data: {
            sale: {
              actorDisplayNameSnapshot: "Historical cashier",
              branchCodeSnapshot: "MAIN",
              branchNameSnapshot: "Main",
              currency: "THB",
              discount: null,
              discountAmount: "0.00",
              id: SALE_ID,
              items: [
                {
                  id: "50000000-0000-4000-8000-000000000001",
                  lineDiscount: "0.00",
                  lineGross: "60.12",
                  lineNet: "60.12",
                  nameSnapshot: "Coffee",
                  quantity: "1",
                  skuSnapshot: "COFFEE",
                  unitPrice: "60.1234",
                  unitSnapshot: "EA",
                },
              ],
              occurredAt: "2026-09-18T10:00:00.000Z",
              organizationNameSnapshot: "Historical shop",
              outputVatAmount: "0.00",
              payment: {
                amount: "60.12",
                amountTendered: "100.00",
                changeAmount: "39.88",
                method: "CASH",
                reference: null,
              },
              reference: "SALE-001",
              subtotalAmount: "60.12",
              taxableAmount: null,
              totalAmount: "60.12",
            },
          },
        },
        201,
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const sale = await checkoutSale(
      { branchId: BRANCH_ID, organizationId: ORGANIZATION_ID },
      "checkout-key",
      {
        discount: null,
        items: [
          {
            expectedUnitPrice: "60.1234",
            productId: PRODUCT_ID,
            quantity: "1",
          },
        ],
        payment: { amountTendered: "100.00", method: "CASH" },
      },
    );

    expect(sale.totalAmount).toBe("60.12");
    expect(sale.actorDisplayNameSnapshot).toBe("Historical cashier");
    expect(sale.organizationNameSnapshot).toBe("Historical shop");
    expect(sale.items[0]?.skuSnapshot).toBe("COFFEE");
    expect(sale.taxableAmount).toBeNull();
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.credentials).toBe("same-origin");
    expect(init.headers).toMatchObject({ "Idempotency-Key": "checkout-key" });
    expect(init.body).toContain("60.1234");
  });

  it("gets and updates the owner/admin VAT profile with its exact version", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            salesVatProfile: {
              salesVatRate: null,
              salesVatStatus: "UNCONFIGURED",
              updatedAt: "2026-09-18T10:00:00.000Z",
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            salesVatProfile: {
              salesVatRate: "7.000000",
              salesVatStatus: "REGISTERED",
              updatedAt: "2026-09-18T10:01:00.000Z",
            },
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const profile = await getSalesVatProfile(ORGANIZATION_ID);
    const updated = await updateSalesVatProfile(ORGANIZATION_ID, {
      expectedUpdatedAt: profile.updatedAt,
      salesVatRate: "7.000000",
      salesVatStatus: "REGISTERED",
    });

    expect(updated.salesVatStatus).toBe("REGISTERED");
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "PATCH" });
    expect(
      String((fetchMock.mock.calls[1]?.[1] as RequestInit).body),
    ).toContain("2026-09-18T10:00:00.000Z");
  });

  it("uses the existing scoped sale reads for history and immutable detail", async () => {
    const summary = {
      actorDisplayName: "Cashier",
      createdAt: "2026-09-18T10:00:00.000Z",
      currency: "THB",
      discount: null,
      discountAmount: "0.00",
      id: SALE_ID,
      itemCount: 1,
      outputVatAmount: "0.00",
      payment: {
        amount: "60.12",
        amountTendered: "100.00",
        changeAmount: "39.88",
        method: "CASH",
        reference: null,
      },
      reference: "SALE-001",
      refundedAmount: "0.00",
      refundState: "NONE",
      remainingAmount: "60.12",
      salesVatRate: null,
      salesVatStatus: "NOT_REGISTERED",
      subtotalAmount: "60.12",
      taxableAmount: null,
      totalAmount: "60.12",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          data: { sales: [summary] },
          meta: { nextCursor: "next" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            sale: {
              ...summary,
              branchCode: "MAIN",
              branchName: "Main",
              items: [
                {
                  id: PRODUCT_ID,
                  lineDiscount: "0.00",
                  lineGross: "60.12",
                  lineNet: "60.12",
                  lineOutputVat: "0.00",
                  lineTaxable: null,
                  productId: PRODUCT_ID,
                  productName: "Historical coffee",
                  productSku: "COFFEE-OLD",
                  quantity: "1.0000",
                  remainingRefundableQuantity: "1.0000",
                  unit: "EA",
                  unitPrice: "60.1234",
                },
              ],
              organizationName: "Store",
              refunds: [],
            },
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const context = { branchId: BRANCH_ID, organizationId: ORGANIZATION_ID };
    const page = await listSalesHistory(context, {
      actorUserId: "50000000-0000-4000-8000-000000000001",
      cursor: "opaque-next",
    });
    const detail = await getSalesHistoryDetail(context, SALE_ID);

    expect(page.data.sales[0]?.totalAmount).toBe("60.12");
    expect(detail.items[0]?.productName).toBe("Historical coffee");
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "sales?limit=25&actorUserId=50000000-0000-4000-8000-000000000001&cursor=opaque-next",
    );
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(`/sales/${SALE_ID}`);
    expect(String(fetchMock.mock.calls[1]?.[0])).not.toContain("/receipt");
  });

  it("sends an idempotent linked refund intent and parses immutable refund snapshots", async () => {
    const saleItemId = "50000000-0000-4000-8000-000000000001";
    const refundId = "60000000-0000-4000-8000-000000000001";
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          data: {
            refund: {
              actorDisplayName: "Manager",
              branchId: BRANCH_ID,
              completedAt: "2026-09-19T09:00:00.000Z",
              currency: "THB",
              discountAmount: "0.00",
              grossAmount: "30.00",
              id: refundId,
              items: [
                {
                  cogsReversalAmount: "10.0000000000",
                  id: "70000000-0000-4000-8000-000000000001",
                  originalCostBasisState: "KNOWN",
                  originalUnitCost: "10.000000",
                  productId: PRODUCT_ID,
                  refundQuantity: "1",
                  restockQuantity: "1",
                  reversedLineDiscount: "0.00",
                  reversedLineGross: "30.00",
                  reversedLineNet: "30.00",
                  reversedLineOutputVat: "0.00",
                  reversedLineTaxable: null,
                  saleItemId,
                },
              ],
              organizationId: ORGANIZATION_ID,
              outputVatAmount: "0.00",
              payment: { amount: "30.00", method: "CASH", reference: null },
              reason: "Customer return",
              reference: "REFUND-001",
              saleId: SALE_ID,
              salesVatRate: null,
              salesVatStatus: "NOT_REGISTERED",
              taxableAmount: null,
              totalAmount: "30.00",
            },
          },
        },
        201,
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await createSaleRefund(
      { branchId: BRANCH_ID, organizationId: ORGANIZATION_ID },
      SALE_ID,
      "refund-key",
      {
        items: [{ quantity: "1", restockQuantity: "1", saleItemId }],
        reason: "Customer return",
        transferReference: null,
      },
    );

    expect(result).toMatchObject({
      id: refundId,
      items: [{ cogsReversalAmount: "10.0000000000" }],
      totalAmount: "30.00",
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      `/sales/${SALE_ID}/refunds`,
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: { "Idempotency-Key": "refund-key" },
      method: "POST",
    });
  });

  it.each([
    [409, "PRICE_CHANGED", "price_changed"],
    [409, "INSUFFICIENT_STOCK", "insufficient_stock"],
    [409, "VAT_CONFIGURATION_REQUIRED", "vat_configuration_required"],
    [409, "IDEMPOTENCY_CONFLICT", "idempotency_conflict"],
    [403, "FORBIDDEN", "forbidden"],
  ] as const)("maps %s safely", async (status, code, kind) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ error: { code } }, status)),
    );

    await expect(
      checkoutSale(
        { branchId: BRANCH_ID, organizationId: ORGANIZATION_ID },
        "checkout-key",
        {
          discount: null,
          items: [],
          payment: { method: "TRANSFER", reference: null },
        },
      ),
    ).rejects.toEqual(new SalesApiError(kind));
  });

  it.each([
    [409, "REFUND_QUANTITY_EXCEEDED", "refund_quantity_exceeded"],
    [409, "SALE_ALREADY_FULLY_REFUNDED", "sale_already_fully_refunded"],
    [409, "IDEMPOTENCY_CONFLICT", "idempotency_conflict"],
    [403, "FORBIDDEN", "forbidden"],
  ] as const)("maps refund %s safely", async (status, code, kind) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ error: { code } }, status)),
    );
    await expect(
      createSaleRefund(
        { branchId: BRANCH_ID, organizationId: ORGANIZATION_ID },
        SALE_ID,
        "refund-key",
        {
          items: [],
          reason: "Return",
          transferReference: null,
        },
      ),
    ).rejects.toEqual(new SalesApiError(kind));
  });
});
