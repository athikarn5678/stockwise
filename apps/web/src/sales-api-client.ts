import { z } from "zod";
import { privateFetch, readPrivateJson } from "@/session-lifecycle";

const productUnitSchema = z.enum([
  "EA",
  "PACK",
  "BOX",
  "KG",
  "G",
  "L",
  "ML",
  "M",
  "CM",
]);
const timestampSchema = z.string().datetime({ offset: false, precision: 3 });
const apiErrorSchema = z.object({ error: z.object({ code: z.string() }) });

const salesVatProfileSchema = z.object({
  salesVatRate: z.string().nullable(),
  salesVatStatus: z.enum(["UNCONFIGURED", "NOT_REGISTERED", "REGISTERED"]),
  updatedAt: timestampSchema,
});
const posProductSchema = z.object({
  available: z.boolean(),
  availableQuantity: z.string(),
  barcode: z.string().nullable(),
  basePrice: z.string(),
  id: z.string().uuid(),
  name: z.string(),
  sku: z.string(),
  unit: productUnitSchema,
});
const checkoutDiscountSchema = z.discriminatedUnion("type", [
  z.object({
    amount: z.string(),
    reason: z.string(),
    type: z.literal("AMOUNT"),
  }),
  z.object({
    percent: z.string(),
    reason: z.string(),
    type: z.literal("PERCENT"),
  }),
]);
const saleSchema = z.object({
  actorDisplayNameSnapshot: z.string(),
  branchCodeSnapshot: z.string(),
  branchNameSnapshot: z.string(),
  currency: z.literal("THB"),
  discount: checkoutDiscountSchema.nullable(),
  discountAmount: z.string(),
  id: z.string().uuid(),
  items: z.array(
    z.object({
      id: z.string().uuid(),
      lineDiscount: z.string(),
      lineGross: z.string(),
      lineNet: z.string(),
      nameSnapshot: z.string(),
      quantity: z.string(),
      skuSnapshot: z.string(),
      unitPrice: z.string(),
      unitSnapshot: productUnitSchema,
    }),
  ),
  occurredAt: timestampSchema,
  organizationNameSnapshot: z.string(),
  outputVatAmount: z.string(),
  payment: z.discriminatedUnion("method", [
    z.object({
      amount: z.string(),
      amountTendered: z.string(),
      changeAmount: z.string(),
      method: z.literal("CASH"),
      reference: z.null(),
    }),
    z.object({
      amount: z.string(),
      amountTendered: z.null(),
      changeAmount: z.null(),
      method: z.literal("TRANSFER"),
      reference: z.string().nullable(),
    }),
  ]),
  reference: z.string(),
  subtotalAmount: z.string(),
  taxableAmount: z.string().nullable(),
  totalAmount: z.string(),
});

const vatProfileResponseSchema = z.object({
  data: z.object({ salesVatProfile: salesVatProfileSchema }),
});
const posProductsResponseSchema = z.object({
  data: z.object({ products: z.array(posProductSchema) }),
  meta: z.object({ nextCursor: z.string().nullable() }),
});
const checkoutResponseSchema = z.object({
  data: z.object({ sale: saleSchema }),
});
const refundItemSchema = z.object({
  cogsReversalAmount: z.string().nullable().optional(),
  id: z.string().uuid(),
  originalCostBasisState: z.enum(["KNOWN", "UNKNOWN"]).optional(),
  originalUnitCost: z.string().nullable().optional(),
  productId: z.string().uuid(),
  refundQuantity: z.string(),
  restockQuantity: z.string(),
  reversedLineDiscount: z.string(),
  reversedLineGross: z.string(),
  reversedLineNet: z.string(),
  reversedLineOutputVat: z.string(),
  reversedLineTaxable: z.string().nullable(),
  saleItemId: z.string().uuid(),
});
const refundSchema = z.object({
  actorDisplayName: z.string(),
  branchId: z.string().uuid(),
  completedAt: timestampSchema,
  currency: z.literal("THB"),
  discountAmount: z.string(),
  grossAmount: z.string(),
  id: z.string().uuid(),
  items: z.array(refundItemSchema),
  organizationId: z.string().uuid(),
  outputVatAmount: z.string(),
  payment: z.object({
    amount: z.string(),
    method: z.enum(["CASH", "TRANSFER"]),
    reference: z.string().nullable(),
  }),
  reason: z.string(),
  reference: z.string(),
  saleId: z.string().uuid(),
  salesVatRate: z.string().nullable(),
  salesVatStatus: z.enum(["NOT_REGISTERED", "REGISTERED"]),
  taxableAmount: z.string().nullable(),
  totalAmount: z.string(),
});
const refundResponseSchema = z.object({
  data: z.object({ refund: refundSchema }),
});
const salesHistorySummarySchema = z.object({
  actorDisplayName: z.string(),
  createdAt: timestampSchema,
  currency: z.literal("THB"),
  discount: checkoutDiscountSchema.nullable(),
  discountAmount: z.string(),
  id: z.string().uuid(),
  itemCount: z.number().int().nonnegative(),
  outputVatAmount: z.string(),
  payment: saleSchema.shape.payment,
  reference: z.string(),
  refundedAmount: z.string(),
  refundState: z.enum(["NONE", "PARTIALLY_REFUNDED", "FULLY_REFUNDED"]),
  remainingAmount: z.string(),
  salesVatRate: z.string().nullable(),
  salesVatStatus: z.enum(["NOT_REGISTERED", "REGISTERED"]),
  subtotalAmount: z.string(),
  taxableAmount: z.string().nullable(),
  totalAmount: z.string(),
});
const salesHistoryDetailSchema = salesHistorySummarySchema.extend({
  branchCode: z.string(),
  branchName: z.string(),
  items: z.array(
    z.object({
      cogsAmount: z.string().nullable().optional(),
      costBasisState: z.enum(["KNOWN", "UNKNOWN"]).optional(),
      id: z.string().uuid(),
      lineDiscount: z.string(),
      lineGross: z.string(),
      lineNet: z.string(),
      lineOutputVat: z.string(),
      lineTaxable: z.string().nullable(),
      productId: z.string().uuid(),
      productName: z.string(),
      productSku: z.string(),
      quantity: z.string(),
      remainingRefundableQuantity: z.string(),
      unit: z.string(),
      unitCost: z.string().nullable().optional(),
      unitPrice: z.string(),
    }),
  ),
  organizationName: z.string(),
  refunds: z.array(refundSchema),
});
const salesHistoryListResponseSchema = z.object({
  data: z.object({ sales: z.array(salesHistorySummarySchema) }),
  meta: z.object({ nextCursor: z.string().nullable() }),
});
const salesHistoryDetailResponseSchema = z.object({
  data: z.object({ sale: salesHistoryDetailSchema }),
});

export type SalesVatProfile = z.infer<typeof salesVatProfileSchema>;
export type PosProduct = z.infer<typeof posProductSchema>;
export type PosUnit = z.infer<typeof productUnitSchema>;
export type CompletedSale = z.infer<typeof saleSchema>;
export type SalesHistorySummary = z.infer<typeof salesHistorySummarySchema>;
export type SalesHistoryDetail = z.infer<typeof salesHistoryDetailSchema>;
export type SaleRefund = z.infer<typeof refundSchema>;
export type RefundInput = {
  items: Array<{
    quantity: string;
    restockQuantity: string;
    saleItemId: string;
  }>;
  reason: string;
  transferReference: string | null;
};
export type CheckoutInput = {
  discount:
    | { amount: string; reason: string; type: "AMOUNT" }
    | { percent: string; reason: string; type: "PERCENT" }
    | null;
  items: Array<{
    expectedUnitPrice: string;
    productId: string;
    quantity: string;
  }>;
  payment:
    | { amountTendered: string; method: "CASH" }
    | { method: "TRANSFER"; reference: string | null };
};
export type SalesRequestContext = { branchId: string; organizationId: string };

export type SalesApiErrorKind =
  | "authentication_required"
  | "branch_inactive"
  | "forbidden"
  | "idempotency_conflict"
  | "insufficient_stock"
  | "invalid_cursor"
  | "price_changed"
  | "product_inactive"
  | "product_not_found"
  | "sale_not_found"
  | "sale_already_fully_refunded"
  | "refund_quantity_exceeded"
  | "stale_vat_profile"
  | "unavailable"
  | "validation"
  | "vat_configuration_required";

export class SalesApiError extends Error {
  constructor(readonly kind: SalesApiErrorKind) {
    super(kind);
  }
}

function salesPath(context: SalesRequestContext, suffix: string): string {
  return `organizations/${context.organizationId}/branches/${context.branchId}/${suffix}`;
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await privateFetch(`/api/v1/${path}`, {
      ...init,
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        ...(init?.body === undefined
          ? {}
          : { "content-type": "application/json" }),
        ...init?.headers,
      },
    });
  } catch {
    throw new SalesApiError("unavailable");
  }
  const body = await readPrivateJson(response).catch(() => null);
  if (!response.ok) throw errorFromResponse(response.status, body);
  return body;
}

function errorFromResponse(status: number, body: unknown): SalesApiError {
  if (status === 401) return new SalesApiError("authentication_required");
  if (status === 403) return new SalesApiError("forbidden");
  const parsed = apiErrorSchema.safeParse(body);
  const kinds: Record<string, SalesApiErrorKind> = {
    BRANCH_INACTIVE: "branch_inactive",
    FORBIDDEN: "forbidden",
    IDEMPOTENCY_CONFLICT: "idempotency_conflict",
    INSUFFICIENT_STOCK: "insufficient_stock",
    INVALID_CURSOR: "invalid_cursor",
    PRICE_CHANGED: "price_changed",
    PRODUCT_INACTIVE: "product_inactive",
    PRODUCT_NOT_FOUND: "product_not_found",
    SALE_NOT_FOUND: "sale_not_found",
    SALE_ALREADY_FULLY_REFUNDED: "sale_already_fully_refunded",
    REFUND_QUANTITY_EXCEEDED: "refund_quantity_exceeded",
    SALES_VAT_PROFILE_STALE: "stale_vat_profile",
    VAT_CONFIGURATION_REQUIRED: "vat_configuration_required",
    VALIDATION_ERROR: "validation",
  };
  return new SalesApiError(
    parsed.success
      ? (kinds[parsed.data.error.code] ?? "unavailable")
      : "unavailable",
  );
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new SalesApiError("unavailable");
  return parsed.data;
}

export async function getSalesVatProfile(
  organizationId: string,
): Promise<SalesVatProfile> {
  return parse(
    vatProfileResponseSchema,
    await request(`organizations/${organizationId}/sales-vat-profile`),
  ).data.salesVatProfile;
}

export async function updateSalesVatProfile(
  organizationId: string,
  input: {
    expectedUpdatedAt: string;
    salesVatRate: string | null;
    salesVatStatus: SalesVatProfile["salesVatStatus"];
  },
): Promise<SalesVatProfile> {
  return parse(
    vatProfileResponseSchema,
    await request(`organizations/${organizationId}/sales-vat-profile`, {
      body: JSON.stringify(input),
      method: "PATCH",
    }),
  ).data.salesVatProfile;
}

export async function searchPosProducts(
  context: SalesRequestContext,
  options: {
    barcode?: string;
    cursor?: string | null;
    q?: string;
    signal?: AbortSignal;
  } = {},
) {
  const query = new URLSearchParams({ limit: "25" });
  if (options.barcode?.trim()) query.set("barcode", options.barcode.trim());
  if (options.cursor) query.set("cursor", options.cursor);
  if (options.q?.trim()) query.set("q", options.q.trim());
  return parse(
    posProductsResponseSchema,
    await request(`${salesPath(context, "pos/products")}?${query.toString()}`, {
      signal: options.signal ?? null,
    }),
  );
}

export async function checkoutSale(
  context: SalesRequestContext,
  idempotencyKey: string,
  input: CheckoutInput,
): Promise<CompletedSale> {
  return parse(
    checkoutResponseSchema,
    await request(salesPath(context, "sales"), {
      body: JSON.stringify(input),
      headers: { "Idempotency-Key": idempotencyKey },
      method: "POST",
    }),
  ).data.sale;
}

export async function listSalesHistory(
  context: SalesRequestContext,
  options: { actorUserId?: string; cursor?: string | null } = {},
) {
  const query = new URLSearchParams({ limit: "25" });
  if (options.actorUserId !== undefined) {
    query.set("actorUserId", options.actorUserId);
  }
  if (options.cursor !== null && options.cursor !== undefined) {
    query.set("cursor", options.cursor);
  }
  return parse(
    salesHistoryListResponseSchema,
    await request(`${salesPath(context, "sales")}?${query.toString()}`),
  );
}

export async function getSalesHistoryDetail(
  context: SalesRequestContext,
  saleId: string,
): Promise<SalesHistoryDetail> {
  return parse(
    salesHistoryDetailResponseSchema,
    await request(salesPath(context, `sales/${saleId}`)),
  ).data.sale;
}

export async function createSaleRefund(
  context: SalesRequestContext,
  saleId: string,
  idempotencyKey: string,
  input: RefundInput,
): Promise<SaleRefund> {
  return parse(
    refundResponseSchema,
    await request(salesPath(context, `sales/${saleId}/refunds`), {
      body: JSON.stringify(input),
      headers: { "Idempotency-Key": idempotencyKey },
      method: "POST",
    }),
  ).data.refund;
}
