import { describe, expect, it } from "vitest";

import { Prisma } from "../../generated/prisma/client.ts";
import {
  calculateCheckoutAmounts,
  canonicalizeCheckoutIntent,
  checkoutCanonicalRequestHash,
  validCheckoutIdempotencyKey,
} from "./checkout-values.ts";

describe("checkout values", () => {
  it("validates the exact printable non-space idempotency-key boundary", () => {
    expect(validCheckoutIdempotencyKey("checkout-1")).toBe(true);
    expect(validCheckoutIdempotencyKey("x".repeat(200))).toBe(true);
    expect(validCheckoutIdempotencyKey("")).toBe(false);
    expect(validCheckoutIdempotencyKey("contains space")).toBe(false);
    expect(validCheckoutIdempotencyKey("x".repeat(201))).toBe(false);
    expect(validCheckoutIdempotencyKey("line\nbreak")).toBe(false);
  });

  it("rejects duplicate products and excess quantity, price, discount, and tender scale", () => {
    const base = {
      discount: null,
      items: [{ expectedUnitPrice: "1.0000", productId: "a", quantity: "1" }],
      payment: { amountTendered: "1.00", method: "CASH" as const },
    };
    expect(
      canonicalizeCheckoutIntent({
        ...base,
        items: [
          { ...base.items[0]!, productId: "PRODUCT-A" },
          { ...base.items[0]!, productId: "product-a" },
        ],
      }).kind,
    ).toBe("duplicate_product");
    expect(
      canonicalizeCheckoutIntent({
        ...base,
        items: [{ ...base.items[0]!, quantity: "1.00001" }],
      }).kind,
    ).toBe("invalid_quantity");
    expect(
      canonicalizeCheckoutIntent({
        ...base,
        items: [{ ...base.items[0]!, expectedUnitPrice: "1.00001" }],
      }).kind,
    ).toBe("invalid_price");
    expect(
      canonicalizeCheckoutIntent({
        ...base,
        discount: { amount: "0.001", reason: "No", type: "AMOUNT" },
      }).kind,
    ).toBe("invalid_discount");
    expect(
      canonicalizeCheckoutIntent({
        ...base,
        payment: { amountTendered: "1.001", method: "CASH" },
      }).kind,
    ).toBe("invalid_payment");
  });

  it("canonicalizes semantically identical intent to one request hash", () => {
    const first = canonicalizeCheckoutIntent({
      discount: {
        percent: "10.0000",
        reason: " Manager approved ",
        type: "PERCENT",
      },
      items: [
        { expectedUnitPrice: "2.5000", productId: "b", quantity: "2.0000" },
        { expectedUnitPrice: "1.00", productId: "a", quantity: "1.0" },
      ],
      payment: { method: "TRANSFER", reference: " REF-1 " },
    });
    const second = canonicalizeCheckoutIntent({
      discount: {
        percent: "10",
        reason: "Manager approved",
        type: "PERCENT",
      },
      items: [
        { expectedUnitPrice: "1", productId: "a", quantity: "1" },
        { expectedUnitPrice: "2.5", productId: "b", quantity: "2" },
      ],
      payment: { method: "TRANSFER", reference: "REF-1" },
    });
    expect(first.kind).toBe("valid");
    expect(second.kind).toBe("valid");
    if (first.kind !== "valid" || second.kind !== "valid") return;
    const identity = {
      actorUserId: "actor",
      branchId: "branch",
      organizationId: "organization",
    };
    expect(
      checkoutCanonicalRequestHash({ ...identity, intent: first.intent }),
    ).toBe(
      checkoutCanonicalRequestHash({ ...identity, intent: second.intent }),
    );
  });

  it("allocates rounded gross cents by Product ID for equal remainders", () => {
    const result = calculateCheckoutAmounts({
      discount: null,
      lines: [
        {
          productId: "b",
          quantity: new Prisma.Decimal("1"),
          unitPrice: new Prisma.Decimal("0.335"),
        },
        {
          productId: "a",
          quantity: new Prisma.Decimal("1"),
          unitPrice: new Prisma.Decimal("0.335"),
        },
      ],
      salesVatRate: null,
      salesVatStatus: "NOT_REGISTERED",
    });
    expect(result?.subtotalAmount.toFixed(2)).toBe("0.67");
    expect(
      result?.lines.map((line) => [line.productId, line.lineGross.toFixed(2)]),
    ).toEqual([
      ["b", "0.33"],
      ["a", "0.34"],
    ]);
  });

  it("calculates AMOUNT and PERCENT discounts with exact reconciliation", () => {
    const lines = [
      {
        productId: "a",
        quantity: new Prisma.Decimal("1"),
        unitPrice: new Prisma.Decimal("100"),
      },
      {
        productId: "b",
        quantity: new Prisma.Decimal("1"),
        unitPrice: new Prisma.Decimal("50"),
      },
    ];
    const amount = calculateCheckoutAmounts({
      discount: {
        amount: new Prisma.Decimal("20"),
        reason: "Approved",
        type: "AMOUNT",
      },
      lines,
      salesVatRate: null,
      salesVatStatus: "NOT_REGISTERED",
    });
    const percent = calculateCheckoutAmounts({
      discount: {
        percent: new Prisma.Decimal("12.3456"),
        reason: "Approved",
        type: "PERCENT",
      },
      lines,
      salesVatRate: null,
      salesVatStatus: "NOT_REGISTERED",
    });
    expect(amount?.discountAmount.toFixed(2)).toBe("20.00");
    expect(amount?.totalAmount.toFixed(2)).toBe("130.00");
    expect(percent?.discountAmount.toFixed(2)).toBe("18.52");
    expect(percent?.totalAmount.toFixed(2)).toBe("131.48");
    expect(
      percent?.lines
        .reduce(
          (sum, line) => sum.plus(line.lineDiscount),
          new Prisma.Decimal(0),
        )
        .toFixed(2),
    ).toBe("18.52");

    const roundsToZero = calculateCheckoutAmounts({
      discount: {
        percent: new Prisma.Decimal("1"),
        reason: "Accepted small percentage",
        type: "PERCENT",
      },
      lines: [
        {
          productId: "a",
          quantity: new Prisma.Decimal("1"),
          unitPrice: new Prisma.Decimal("0.01"),
        },
      ],
      salesVatRate: null,
      salesVatStatus: "NOT_REGISTERED",
    });
    expect(roundsToZero?.discountAmount.toFixed(2)).toBe("0.00");
    expect(roundsToZero?.totalAmount.toFixed(2)).toBe("0.01");
  });

  it("extracts registered VAT after discount and keeps NOT_REGISTERED taxable values null", () => {
    const lines = [
      {
        productId: "a",
        quantity: new Prisma.Decimal("1"),
        unitPrice: new Prisma.Decimal("107"),
      },
    ];
    const registered = calculateCheckoutAmounts({
      discount: null,
      lines,
      salesVatRate: new Prisma.Decimal("7"),
      salesVatStatus: "REGISTERED",
    });
    const notRegistered = calculateCheckoutAmounts({
      discount: null,
      lines,
      salesVatRate: null,
      salesVatStatus: "NOT_REGISTERED",
    });
    expect(registered).toMatchObject({});
    expect(registered?.outputVatAmount.toFixed(2)).toBe("7.00");
    expect(registered?.taxableAmount?.toFixed(2)).toBe("100.00");
    expect(registered?.lines[0]?.lineOutputVat.toFixed(2)).toBe("7.00");
    expect(registered?.lines[0]?.lineTaxable?.toFixed(2)).toBe("100.00");
    expect(notRegistered?.outputVatAmount.toFixed(2)).toBe("0.00");
    expect(notRegistered?.taxableAmount).toBeNull();
    expect(notRegistered?.lines[0]?.lineTaxable).toBeNull();
  });

  it("retains exact high-precision multiplication through the DECIMAL(38,2) boundary", () => {
    const result = calculateCheckoutAmounts({
      discount: null,
      lines: [
        {
          productId: "large",
          quantity: new Prisma.Decimal("99999999999999.9999"),
          unitPrice: new Prisma.Decimal("999999999999999.9999"),
        },
      ],
      salesVatRate: null,
      salesVatStatus: "NOT_REGISTERED",
    });
    expect(result?.subtotalAmount.toFixed(2)).toBe(
      "99999999999999999890000000000.00",
    );
  });
  describe("expected total amount (PromptPay QR)", () => {
    const scope = {
      actorUserId: "11111111-1111-4111-8111-111111111111",
      branchId: "22222222-2222-4222-8222-222222222222",
      organizationId: "33333333-3333-4333-8333-333333333333",
    };
    const cart = {
      discount: null,
      items: [
        {
          expectedUnitPrice: "10",
          productId: "44444444-4444-4444-8444-444444444444",
          quantity: "2",
        },
      ],
    };
    const hash = (
      payment: Parameters<typeof canonicalizeCheckoutIntent>[0]["payment"],
    ) => {
      const result = canonicalizeCheckoutIntent({ ...cart, payment });
      if (result.kind !== "valid") throw new Error("expected a valid intent");
      return checkoutCanonicalRequestHash({ ...scope, intent: result.intent });
    };

    it("keeps every request hash that existed before the field was added byte-identical", () => {
      // Pinned from the implementation before expectedTotalAmount existed:
      // already-stored sales must still replay under their idempotency keys.
      expect(hash({ method: "TRANSFER", reference: "ref-1" })).toBe(
        "a16936662b3d99ed6f60415c0101719611564333a6d65cf80458be8f8cf8fb2b",
      );
      expect(hash({ method: "TRANSFER" })).toBe(
        "61865672420d16782219ad7317358dd0c3f7a87d98304470ab4cef9291a10387",
      );
      expect(hash({ amountTendered: "100.00", method: "CASH" })).toBe(
        "ede806fa220fe099f713d3c49a5fb390b839ffd4b8ae21870382d215912e89f5",
      );
      expect(hash({ expectedTotalAmount: null, method: "TRANSFER" })).toBe(
        hash({ method: "TRANSFER" }),
      );
    });

    it("binds a shown amount into the request hash and canonicalizes its scale", () => {
      const withAmount = hash({
        expectedTotalAmount: "20.50",
        method: "TRANSFER",
        reference: "PromptPay",
      });
      expect(withAmount).not.toBe(
        hash({ method: "TRANSFER", reference: "PromptPay" }),
      );
      expect(withAmount).not.toBe(
        hash({
          expectedTotalAmount: "20.51",
          method: "TRANSFER",
          reference: "PromptPay",
        }),
      );
      expect(
        hash({
          expectedTotalAmount: "20.5",
          method: "TRANSFER",
          reference: "PromptPay",
        }),
      ).toBe(withAmount);
    });

    it.each(["abc", "-1.00", "1.001", "", "1e2", " 1.00"])(
      "rejects the malformed shown amount %j",
      (expectedTotalAmount) => {
        expect(
          canonicalizeCheckoutIntent({
            ...cart,
            payment: { expectedTotalAmount, method: "TRANSFER" },
          }),
        ).toEqual({ kind: "invalid_payment" });
      },
    );
  });
});
