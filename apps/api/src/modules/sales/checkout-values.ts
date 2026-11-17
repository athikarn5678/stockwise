import { createHash } from "node:crypto";

import { Prisma } from "../../generated/prisma/client.ts";

const ExactDecimal = Prisma.Decimal.clone({ precision: 80 });

const DECIMAL_PATTERN = /^(\d+)(?:\.(\d+))?$/;
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{1,200}$/;
const MONEY_SCALE = 2;
const CENT = new ExactDecimal("0.01");
const ZERO = new ExactDecimal(0);

export function exactCheckoutDecimal(
  value: string | Prisma.Decimal,
): Prisma.Decimal {
  return new ExactDecimal(value);
}

export interface CheckoutLineInput {
  expectedUnitPrice: string;
  productId: string;
  quantity: string;
}

export type CheckoutDiscountInput =
  | { amount: string; reason: string; type: "AMOUNT" }
  | { percent: string; reason: string; type: "PERCENT" }
  | null;

export type CheckoutPaymentInput =
  | { amountTendered: string; method: "CASH" }
  | {
      /**
       * Optional amount the payer was shown (for example a PromptPay QR). The
       * server still recomputes the total and rejects the sale when it differs.
       */
      expectedTotalAmount?: string | null;
      method: "TRANSFER";
      reference?: string | null;
    };

export interface CheckoutIntentInput {
  discount: CheckoutDiscountInput;
  items: readonly CheckoutLineInput[];
  payment: CheckoutPaymentInput;
}

export interface CanonicalCheckoutLine {
  expectedUnitPrice: Prisma.Decimal;
  productId: string;
  quantity: Prisma.Decimal;
}

export type CanonicalCheckoutDiscount =
  | {
      amount: Prisma.Decimal;
      reason: string;
      type: "AMOUNT";
    }
  | {
      percent: Prisma.Decimal;
      reason: string;
      type: "PERCENT";
    }
  | null;

export type CanonicalCheckoutPayment =
  | { amountTendered: Prisma.Decimal; method: "CASH" }
  | {
      /** Present only when the request carried one, so older request hashes stay valid. */
      expectedTotalAmount?: Prisma.Decimal;
      method: "TRANSFER";
      reference: string | null;
    };

export interface CanonicalCheckoutIntent {
  discount: CanonicalCheckoutDiscount;
  items: CanonicalCheckoutLine[];
  payment: CanonicalCheckoutPayment;
}

export type CanonicalCheckoutIntentResult =
  | { intent: CanonicalCheckoutIntent; kind: "valid" }
  | {
      kind:
        | "duplicate_product"
        | "invalid_discount"
        | "invalid_payment"
        | "invalid_price"
        | "invalid_quantity";
    };

export interface CheckoutAmountLine {
  lineDiscount: Prisma.Decimal;
  lineGross: Prisma.Decimal;
  lineNet: Prisma.Decimal;
  lineOutputVat: Prisma.Decimal;
  lineTaxable: Prisma.Decimal | null;
  productId: string;
}

export interface CheckoutAmounts {
  discountAmount: Prisma.Decimal;
  lines: CheckoutAmountLine[];
  outputVatAmount: Prisma.Decimal;
  subtotalAmount: Prisma.Decimal;
  taxableAmount: Prisma.Decimal | null;
  totalAmount: Prisma.Decimal;
}

function parseUnsignedDecimal(
  value: string,
  maximumIntegerDigits: number,
  maximumScale: number,
): Prisma.Decimal | null {
  if (typeof value !== "string") return null;
  const match = DECIMAL_PATTERN.exec(value);
  if (match === null) return null;
  const integerDigits = (match[1] ?? "").replace(/^0+/, "") || "0";
  const fractionalDigits = match[2] ?? "";
  if (
    integerDigits.length > maximumIntegerDigits ||
    fractionalDigits.length > maximumScale
  ) {
    return null;
  }
  try {
    return exactCheckoutDecimal(value);
  } catch {
    return null;
  }
}

function canonicalReason(value: string): string | null {
  if (typeof value !== "string") return null;
  const reason = value.trim();
  return reason.length >= 1 && reason.length <= 200 ? reason : null;
}

function canonicalTransferReference(
  value: string | null | undefined,
): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return undefined;
  const reference = value.trim();
  return reference.length >= 1 && reference.length <= 100
    ? reference
    : undefined;
}

function compareCanonicalIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function validCheckoutIdempotencyKey(value: string): boolean {
  return typeof value === "string" && IDEMPOTENCY_KEY_PATTERN.test(value);
}

export function canonicalizeCheckoutIntent(
  input: CheckoutIntentInput,
): CanonicalCheckoutIntentResult {
  if (!Array.isArray(input.items) || input.items.length === 0) {
    return { kind: "invalid_quantity" };
  }

  const productIds = new Set<string>();
  const items: CanonicalCheckoutLine[] = [];
  for (const item of input.items) {
    const productId =
      typeof item.productId === "string" ? item.productId.toLowerCase() : "";
    if (productId.length === 0 || productIds.has(productId)) {
      return { kind: "duplicate_product" };
    }
    productIds.add(productId);
    const quantity = parseUnsignedDecimal(item.quantity, 14, 4);
    if (quantity === null || !quantity.isPositive()) {
      return { kind: "invalid_quantity" };
    }
    const expectedUnitPrice = parseUnsignedDecimal(
      item.expectedUnitPrice,
      15,
      4,
    );
    if (expectedUnitPrice === null) return { kind: "invalid_price" };
    items.push({ expectedUnitPrice, productId, quantity });
  }
  items.sort((left, right) =>
    compareCanonicalIds(left.productId, right.productId),
  );

  let discount: CanonicalCheckoutDiscount = null;
  if (input.discount !== null) {
    const reason = canonicalReason(input.discount.reason);
    if (reason === null) return { kind: "invalid_discount" };
    if (input.discount.type === "AMOUNT") {
      const amount = parseUnsignedDecimal(input.discount.amount, 36, 2);
      if (amount === null || !amount.isPositive()) {
        return { kind: "invalid_discount" };
      }
      discount = { amount, reason, type: "AMOUNT" };
    } else if (input.discount.type === "PERCENT") {
      const percent = parseUnsignedDecimal(input.discount.percent, 3, 4);
      if (percent === null || !percent.isPositive() || !percent.lessThan(100)) {
        return { kind: "invalid_discount" };
      }
      discount = { percent, reason, type: "PERCENT" };
    } else {
      return { kind: "invalid_discount" };
    }
  }

  let payment: CanonicalCheckoutPayment;
  if (input.payment.method === "CASH") {
    const amountTendered = parseUnsignedDecimal(
      input.payment.amountTendered,
      36,
      2,
    );
    if (amountTendered === null) return { kind: "invalid_payment" };
    payment = { amountTendered, method: "CASH" };
  } else if (input.payment.method === "TRANSFER") {
    const reference = canonicalTransferReference(input.payment.reference);
    if (reference === undefined) return { kind: "invalid_payment" };
    const expected = input.payment.expectedTotalAmount;
    if (expected === undefined || expected === null) {
      payment = { method: "TRANSFER", reference };
    } else {
      const expectedTotalAmount = parseUnsignedDecimal(expected, 36, 2);
      if (expectedTotalAmount === null) return { kind: "invalid_payment" };
      payment = { expectedTotalAmount, method: "TRANSFER", reference };
    }
  } else {
    return { kind: "invalid_payment" };
  }

  return { intent: { discount, items, payment }, kind: "valid" };
}

function decimalIntegerDigits(value: Prisma.Decimal): number {
  const [integerDigits = ""] = value.abs().toFixed().split(".");
  return (integerDigits.replace(/^0+/, "") || "0").length;
}

export function documentMoneyFitsStorage(value: Prisma.Decimal): boolean {
  return decimalIntegerDigits(value) <= 36;
}

function allocateByLargestRemainder(
  total: Prisma.Decimal,
  weightedLines: readonly { productId: string; weight: Prisma.Decimal }[],
): Prisma.Decimal[] {
  if (total.isZero()) return weightedLines.map(() => new ExactDecimal(0));
  const weightTotal = weightedLines.reduce(
    (sum, line) => sum.plus(line.weight),
    new ExactDecimal(0),
  );
  if (!weightTotal.isPositive()) {
    throw new Error("A positive allocation requires a positive weight total.");
  }

  const shares = weightedLines.map((line, index) => {
    const exact = total.times(line.weight).dividedBy(weightTotal);
    const allocated = exact.toDecimalPlaces(
      MONEY_SCALE,
      Prisma.Decimal.ROUND_FLOOR,
    );
    return {
      allocated,
      index,
      productId: line.productId,
      remainder: exact.minus(allocated),
    };
  });
  const allocatedTotal = shares.reduce(
    (sum, share) => sum.plus(share.allocated),
    new ExactDecimal(0),
  );
  const residualDecimal = total.minus(allocatedTotal).times(100);
  if (!residualDecimal.isInteger() || residualDecimal.isNegative()) {
    throw new Error("Allocation residual must be non-negative whole cents.");
  }
  let residual = BigInt(residualDecimal.toFixed(0));
  const ranked = [...shares].sort((left, right) => {
    const remainderOrder = right.remainder.comparedTo(left.remainder);
    return remainderOrder !== 0
      ? remainderOrder
      : compareCanonicalIds(left.productId, right.productId);
  });
  let cursor = 0;
  while (residual > 0n) {
    const share = ranked[cursor];
    if (share === undefined) {
      throw new Error("Allocation residual exceeded the line count.");
    }
    share.allocated = share.allocated.plus(CENT);
    cursor += 1;
    residual -= 1n;
  }
  return shares
    .sort((left, right) => left.index - right.index)
    .map((share) => share.allocated);
}

export function calculateCheckoutAmounts(input: {
  discount: CanonicalCheckoutDiscount;
  lines: readonly {
    productId: string;
    quantity: Prisma.Decimal;
    unitPrice: Prisma.Decimal;
  }[];
  salesVatRate: Prisma.Decimal | null;
  salesVatStatus: "NOT_REGISTERED" | "REGISTERED";
}): CheckoutAmounts | null {
  const rawLines = input.lines.map((line) => ({
    productId: line.productId,
    weight: exactCheckoutDecimal(line.quantity).times(line.unitPrice),
  }));
  const rawSubtotal = rawLines.reduce(
    (sum, line) => sum.plus(line.weight),
    new ExactDecimal(0),
  );
  const subtotalAmount = rawSubtotal.toDecimalPlaces(
    MONEY_SCALE,
    Prisma.Decimal.ROUND_HALF_UP,
  );
  if (
    !subtotalAmount.isPositive() ||
    !documentMoneyFitsStorage(subtotalAmount)
  ) {
    return null;
  }

  let discountAmount = ZERO;
  if (input.discount?.type === "AMOUNT") {
    if (!input.discount.amount.lessThan(subtotalAmount)) return null;
    discountAmount = exactCheckoutDecimal(input.discount.amount);
  } else if (input.discount?.type === "PERCENT") {
    discountAmount = subtotalAmount
      .times(input.discount.percent)
      .dividedBy(100)
      .toDecimalPlaces(MONEY_SCALE, Prisma.Decimal.ROUND_HALF_UP);
  }
  const totalAmount = subtotalAmount.minus(discountAmount);
  if (
    !totalAmount.isPositive() ||
    !documentMoneyFitsStorage(discountAmount) ||
    !documentMoneyFitsStorage(totalAmount)
  ) {
    return null;
  }

  const lineGross = allocateByLargestRemainder(subtotalAmount, rawLines);
  const discountWeights = lineGross.map((weight, index) => ({
    productId: input.lines[index]!.productId,
    weight,
  }));
  const lineDiscount = allocateByLargestRemainder(
    discountAmount,
    discountWeights,
  );
  const lineNet = lineGross.map((gross, index) =>
    gross.minus(lineDiscount[index]!),
  );

  let outputVatAmount = ZERO;
  let taxableAmount: Prisma.Decimal | null = null;
  let lineOutputVat = lineNet.map(() => new ExactDecimal(0));
  let lineTaxable: Array<Prisma.Decimal | null> = lineNet.map(() => null);
  if (input.salesVatStatus === "REGISTERED") {
    if (
      input.salesVatRate === null ||
      !input.salesVatRate.isPositive() ||
      !input.salesVatRate.lessThan(100)
    ) {
      return null;
    }
    outputVatAmount = totalAmount
      .times(input.salesVatRate)
      .dividedBy(new ExactDecimal(100).plus(input.salesVatRate))
      .toDecimalPlaces(MONEY_SCALE, Prisma.Decimal.ROUND_HALF_UP);
    taxableAmount = totalAmount.minus(outputVatAmount);
    const vatWeights = lineNet.map((weight, index) => ({
      productId: input.lines[index]!.productId,
      weight,
    }));
    lineOutputVat = allocateByLargestRemainder(outputVatAmount, vatWeights);
    lineTaxable = lineNet.map((net, index) => net.minus(lineOutputVat[index]!));
  } else if (input.salesVatRate !== null) {
    return null;
  }

  const lines = input.lines.map((line, index) => ({
    lineDiscount: lineDiscount[index]!,
    lineGross: lineGross[index]!,
    lineNet: lineNet[index]!,
    lineOutputVat: lineOutputVat[index]!,
    lineTaxable: lineTaxable[index]!,
    productId: line.productId,
  }));
  return {
    discountAmount,
    lines,
    outputVatAmount,
    subtotalAmount,
    taxableAmount,
    totalAmount,
  };
}

export function checkoutIdempotencyKeyHash(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

export function checkoutCanonicalRequestHash(input: {
  actorUserId: string;
  branchId: string;
  intent: CanonicalCheckoutIntent;
  organizationId: string;
}): string {
  const discount =
    input.intent.discount === null
      ? null
      : input.intent.discount.type === "AMOUNT"
        ? {
            amount: input.intent.discount.amount.toString(),
            reason: input.intent.discount.reason,
            type: input.intent.discount.type,
          }
        : {
            percent: input.intent.discount.percent.toString(),
            reason: input.intent.discount.reason,
            type: input.intent.discount.type,
          };
  const payment =
    input.intent.payment.method === "CASH"
      ? {
          amountTendered: input.intent.payment.amountTendered.toString(),
          method: input.intent.payment.method,
        }
      : {
          ...(input.intent.payment.expectedTotalAmount === undefined
            ? {}
            : {
                expectedTotalAmount:
                  input.intent.payment.expectedTotalAmount.toFixed(2),
              }),
          method: input.intent.payment.method,
          reference: input.intent.payment.reference,
        };
  return createHash("sha256")
    .update(
      JSON.stringify({
        actorUserId: input.actorUserId.toLowerCase(),
        branchId: input.branchId.toLowerCase(),
        discount,
        items: input.intent.items.map((item) => ({
          expectedUnitPrice: item.expectedUnitPrice.toString(),
          productId: item.productId,
          quantity: item.quantity.toString(),
        })),
        operation: "SALE_CHECKOUT",
        organizationId: input.organizationId.toLowerCase(),
        payment,
      }),
      "utf8",
    )
    .digest("hex");
}
