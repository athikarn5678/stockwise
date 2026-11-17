import { z } from "zod";

import { canonicalizeBarcode } from "../catalog/catalog-values.ts";

const exactTimestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => !Number.isNaN(Date.parse(value)))
  .transform((value) => new Date(value));

const limitSchema = z.preprocess(
  (value) => value ?? "25",
  z
    .string()
    .regex(/^[1-9]\d{0,2}$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(100)),
);

const optionalSearchSchema = z
  .string()
  .max(200)
  .optional()
  .transform((value) => value?.trim() ?? "");

const absoluteTimestampSchema = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value));

const optionalBarcodeSchema = z
  .string()
  .max(128)
  .optional()
  .transform((value, context): string | undefined => {
    if (value === undefined) return undefined;
    try {
      const barcode = canonicalizeBarcode(value);
      if (barcode !== null) return barcode;
    } catch {
      // Fall through to the boundary validation error below.
    }
    context.addIssue({ code: "custom", message: "Invalid barcode." });
    return z.NEVER;
  });

const checkoutLineSchema = z
  .object({
    expectedUnitPrice: z.string(),
    productId: z.string().uuid(),
    quantity: z.string(),
  })
  .strict();

const checkoutDiscountSchema = z.discriminatedUnion("type", [
  z
    .object({
      amount: z.string(),
      reason: z.string(),
      type: z.literal("AMOUNT"),
    })
    .strict(),
  z
    .object({
      percent: z.string(),
      reason: z.string(),
      type: z.literal("PERCENT"),
    })
    .strict(),
]);

const checkoutPaymentSchema = z.discriminatedUnion("method", [
  z.object({ amountTendered: z.string(), method: z.literal("CASH") }).strict(),
  z
    .object({
      expectedTotalAmount: z.string().nullable().optional(),
      method: z.literal("TRANSFER"),
      reference: z.string().nullable().optional(),
    })
    .strict()
    .transform(({ expectedTotalAmount, ...value }) => ({
      ...value,
      ...(expectedTotalAmount === undefined || expectedTotalAmount === null
        ? {}
        : { expectedTotalAmount }),
      reference: value.reference ?? null,
    })),
]);

const refundLineSchema = z
  .object({
    quantity: z.string(),
    restockQuantity: z.string(),
    saleItemId: z.string().uuid(),
  })
  .strict();

export const organizationSalesParamsSchema = z
  .object({ organizationId: z.string().uuid() })
  .strict();

export const branchSalesParamsSchema = z
  .object({
    branchId: z.string().uuid(),
    organizationId: z.string().uuid(),
  })
  .strict();

export const saleDetailParamsSchema = branchSalesParamsSchema.extend({
  saleId: z.string().uuid(),
});

export const posProductSearchQuerySchema = z
  .object({
    barcode: optionalBarcodeSchema,
    cursor: z.string().min(1).max(2048).optional(),
    limit: limitSchema,
    q: optionalSearchSchema,
  })
  .strict();

export const salesHistoryQuerySchema = z
  .object({
    actorUserId: z.string().uuid().optional(),
    createdAtFrom: absoluteTimestampSchema.optional(),
    createdAtTo: absoluteTimestampSchema.optional(),
    cursor: z.string().min(1).max(2048).optional(),
    limit: limitSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.createdAtFrom !== undefined &&
      value.createdAtTo !== undefined &&
      value.createdAtFrom >= value.createdAtTo
    ) {
      context.addIssue({
        code: "custom",
        message: "createdAtFrom must be before createdAtTo.",
        path: ["createdAtTo"],
      });
    }
  });

export const salesVatProfileUpdateSchema = z
  .object({
    expectedUpdatedAt: exactTimestampSchema,
    salesVatRate: z.string().nullable(),
    salesVatStatus: z.enum(["UNCONFIGURED", "NOT_REGISTERED", "REGISTERED"]),
  })
  .strict();

export const checkoutRequestSchema = z
  .object({
    discount: checkoutDiscountSchema.nullable().optional(),
    items: z.array(checkoutLineSchema).min(1),
    payment: checkoutPaymentSchema,
  })
  .strict()
  .transform((value) => ({ ...value, discount: value.discount ?? null }));

export const promptPayQuoteRequestSchema = z
  .object({
    discount: checkoutDiscountSchema.nullable().optional(),
    items: z.array(checkoutLineSchema).min(1),
  })
  .strict()
  .transform((value) => ({ ...value, discount: value.discount ?? null }));

export const refundRequestSchema = z
  .object({
    items: z.array(refundLineSchema).min(1),
    reason: z.string(),
    transferReference: z.string().nullable().optional(),
  })
  .strict()
  .transform((value) => ({
    ...value,
    transferReference: value.transferReference ?? null,
  }));

export type PosProductSearchQuery = z.infer<typeof posProductSearchQuerySchema>;
export type SalesHistoryQuery = z.infer<typeof salesHistoryQuerySchema>;
export type SalesVatProfileUpdateInput = z.infer<
  typeof salesVatProfileUpdateSchema
>;
