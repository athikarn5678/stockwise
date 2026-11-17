import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { Prisma } from "../../generated/prisma/client.ts";
import {
  createTestPrismaClient,
  resetTestDatabase,
} from "../../test/database-harness.ts";
import { loadTestDatabaseEnvironment } from "../../test/database-environment.ts";

const environment = loadTestDatabaseEnvironment();
const prisma = createTestPrismaClient(environment);
const schemaPath = fileURLToPath(
  new URL("../../../prisma/schema.prisma", import.meta.url),
);

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function fixture(label: string) {
  const organization = await prisma.organization.create({
    data: { name: `${label} Organization` },
  });
  const branch = await prisma.branch.create({
    data: {
      code: `${label.slice(0, 18).toUpperCase()}-BR`,
      name: `${label} Branch`,
      organizationId: organization.id,
    },
  });
  const user = await prisma.user.create({
    data: {
      displayName: `${label} Cashier`,
      email: `${randomUUID()}@example.com`,
    },
  });
  const membership = await prisma.organizationMembership.create({
    data: { organizationId: organization.id, role: "OWNER", userId: user.id },
  });
  const product = await prisma.product.create({
    data: {
      basePrice: "10.1234",
      name: `${label} Product`,
      organizationId: organization.id,
      sku: `${label.slice(0, 18).toUpperCase()}-SKU`,
      unit: "EA",
    },
  });

  return { branch, membership, organization, product, user };
}

async function createSale(
  value: Awaited<ReturnType<typeof fixture>>,
  key: string,
  data: Partial<Prisma.SaleUncheckedCreateInput> = {},
) {
  return prisma.sale.create({
    data: {
      actorDisplayNameSnapshot: value.user.displayName ?? "Cashier",
      actorMembershipId: value.membership.id,
      actorUserId: value.user.id,
      branchCodeSnapshot: value.branch.code,
      branchId: value.branch.id,
      branchNameSnapshot: value.branch.name,
      canonicalRequestHash: hash(`${key}-request`),
      completedAt: new Date("2026-09-05T10:00:00.000Z"),
      idempotencyKeyHash: hash(`${key}-key`),
      organizationId: value.organization.id,
      organizationNameSnapshot: value.organization.name,
      outputVatAmount: "0.00",
      reference: `SALE-${randomUUID()}`,
      salesVatStatusSnapshot: "NOT_REGISTERED",
      subtotalAmount: "10.12",
      totalAmount: "10.12",
      ...data,
    },
  });
}

async function createSaleItem(
  value: Awaited<ReturnType<typeof fixture>>,
  saleId: string,
  data: Partial<Prisma.SaleItemUncheckedCreateInput> = {},
) {
  return prisma.saleItem.create({
    data: {
      branchId: value.branch.id,
      costBasisState: "UNKNOWN",
      lineDiscount: "0.00",
      lineGross: "10.12",
      lineNet: "10.12",
      lineOutputVat: "0.00",
      organizationId: value.organization.id,
      productId: value.product.id,
      productNameSnapshot: value.product.name,
      productSkuSnapshot: value.product.sku,
      productUnitSnapshot: value.product.unit,
      quantity: "1.0000",
      saleId,
      unitPrice: "10.1234",
      ...data,
    },
  });
}

async function createCashPayment(
  value: Awaited<ReturnType<typeof fixture>>,
  saleId: string,
  data: Partial<Prisma.PaymentUncheckedCreateInput> = {},
) {
  return prisma.payment.create({
    data: {
      amount: "10.12",
      amountTendered: "20.00",
      branchId: value.branch.id,
      changeAmount: "9.88",
      confirmedAt: new Date("2026-09-05T10:00:00.000Z"),
      method: "CASH",
      organizationId: value.organization.id,
      saleId,
      ...data,
    },
  });
}

describe("sales database schema", () => {
  beforeEach(async () => resetTestDatabase(environment));
  afterAll(async () => {
    await resetTestDatabase(environment);
    await prisma.$disconnect();
  });

  it("defaults Organizations to UNCONFIGURED and enforces every VAT configuration shape", async () => {
    const organization = await prisma.organization.create({
      data: { name: "VAT Configuration" },
    });

    expect(organization.salesVatStatus).toBe("UNCONFIGURED");
    expect(organization.salesVatRate).toBeNull();

    await expect(
      prisma.organization.update({
        data: { salesVatRate: "7.000000" },
        where: { id: organization.id },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.organization.update({
        data: { salesVatRate: "7.000000", salesVatStatus: "NOT_REGISTERED" },
        where: { id: organization.id },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.organization.update({
        data: { salesVatStatus: "REGISTERED" },
        where: { id: organization.id },
      }),
    ).rejects.toThrow();

    for (const invalidRate of ["0", "-0.000001", "100", "100.000001"]) {
      await expect(
        prisma.organization.update({
          data: {
            salesVatRate: invalidRate,
            salesVatStatus: "REGISTERED",
          },
          where: { id: organization.id },
        }),
      ).rejects.toThrow();
    }

    const registered = await prisma.organization.update({
      data: { salesVatRate: "7.000000", salesVatStatus: "REGISTERED" },
      where: { id: organization.id },
    });
    expect(registered.salesVatRate?.toFixed(6)).toBe("7.000000");
  });

  it("persists one completed Sale with exact snapshots and no SaleStatus or Cart model", async () => {
    const value = await fixture("completed-sale");
    const sale = await createSale(value, "completed-sale", {
      completedAt: new Date("2026-09-05T11:22:33.456Z"),
    });
    const item = await createSaleItem(value, sale.id);
    const payment = await createCashPayment(value, sale.id);

    expect(sale.reference).toMatch(/^SALE-[0-9a-f-]{36}$/);
    expect(sale.currency).toBe("THB");
    expect(sale.subtotalAmount.toFixed(2)).toBe("10.12");
    expect(sale.completedAt.toISOString()).toBe("2026-09-05T11:22:33.456Z");
    expect(item.quantity.toFixed(4)).toBe("1.0000");
    expect(item.unitPrice.toFixed(4)).toBe("10.1234");
    expect(payment.amount.toFixed(2)).toBe(sale.totalAmount.toFixed(2));

    const schema = readFileSync(schemaPath, "utf8");
    expect(schema).not.toMatch(/enum\s+SaleStatus\b/);
    expect(schema).not.toMatch(
      /model\s+(Cart|Customer|SalesReceipt|Receipt)\b/,
    );
  });

  it("enforces Organization-scoped Sale reference and SALE_CHECKOUT idempotency uniqueness", async () => {
    const first = await fixture("sale-identity-a");
    const second = await fixture("sale-identity-b");
    const reference = `SALE-${randomUUID()}`;
    const keyHash = hash("shared-checkout-key");

    await createSale(first, "identity-first", {
      idempotencyKeyHash: keyHash,
      reference,
    });
    await expect(
      createSale(first, "identity-duplicate-reference", { reference }),
    ).rejects.toThrow();
    await expect(
      createSale(first, "identity-duplicate-key", {
        idempotencyKeyHash: keyHash,
      }),
    ).rejects.toThrow();
    await expect(
      createSale(second, "identity-other-tenant", {
        idempotencyKeyHash: keyHash,
        reference,
      }),
    ).resolves.toMatchObject({ idempotencyOperation: "SALE_CHECKOUT" });
  });

  it("rejects invalid Sale currency, references, hashes, amounts, and nonpositive totals", async () => {
    const value = await fixture("sale-basics");

    for (const data of [
      { currency: "USD" },
      { reference: randomUUID() },
      { idempotencyKeyHash: "raw-key" },
      { canonicalRequestHash: "A".repeat(64) },
      { subtotalAmount: "-0.01", totalAmount: "-0.01" },
      { subtotalAmount: "0.00", totalAmount: "0.00" },
      { discountAmount: "11.00" },
      { discountAmount: "1.00", subtotalAmount: "10.00", totalAmount: "10.00" },
    ] satisfies Partial<Prisma.SaleUncheckedCreateInput>[]) {
      await expect(createSale(value, randomUUID(), data)).rejects.toThrow();
    }
  });

  it("enforces no-discount, AMOUNT, and PERCENT discount shapes", async () => {
    const value = await fixture("discounts");

    await expect(
      createSale(value, "amount-discount", {
        discountAmount: "2.00",
        discountAmountInput: "2.00",
        discountReason: "Damaged packaging",
        discountType: "AMOUNT",
        subtotalAmount: "10.00",
        totalAmount: "8.00",
      }),
    ).resolves.toBeDefined();
    await expect(
      createSale(value, "percent-discount", {
        discountAmount: "1.00",
        discountPercentInput: "10.0000",
        discountReason: "Manager discount",
        discountType: "PERCENT",
        subtotalAmount: "10.00",
        totalAmount: "9.00",
      }),
    ).resolves.toBeDefined();
    await expect(
      createSale(value, "percent-discount-rounds-to-zero", {
        discountAmount: "0.00",
        discountPercentInput: "1.0000",
        discountReason: "Small percentage",
        discountType: "PERCENT",
        subtotalAmount: "0.01",
        totalAmount: "0.01",
      }),
    ).resolves.toBeDefined();

    for (const data of [
      { discountAmount: "1.00", subtotalAmount: "10.00", totalAmount: "9.00" },
      {
        discountAmount: "1.00",
        discountAmountInput: "1.00",
        discountReason: null,
        discountType: "AMOUNT" as const,
        subtotalAmount: "10.00",
        totalAmount: "9.00",
      },
      {
        discountAmount: "1.00",
        discountAmountInput: "1.00",
        discountPercentInput: "10.0000",
        discountReason: "Mixed",
        discountType: "AMOUNT" as const,
        subtotalAmount: "10.00",
        totalAmount: "9.00",
      },
      {
        discountAmount: "1.00",
        discountPercentInput: "20.0000",
        discountReason: "Mismatched calculation",
        discountType: "PERCENT" as const,
        subtotalAmount: "10.00",
        totalAmount: "9.00",
      },
      {
        discountAmount: "1.00",
        discountPercentInput: "100.0000",
        discountReason: "Invalid percent",
        discountType: "PERCENT" as const,
        subtotalAmount: "10.00",
        totalAmount: "9.00",
      },
      {
        discountAmount: "10.00",
        discountAmountInput: "10.00",
        discountReason: "Invalid amount",
        discountType: "AMOUNT" as const,
        subtotalAmount: "10.00",
        totalAmount: "0.00",
      },
    ] satisfies Partial<Prisma.SaleUncheckedCreateInput>[]) {
      await expect(createSale(value, randomUUID(), data)).rejects.toThrow();
    }
  });

  it("enforces REGISTERED and NOT_REGISTERED Sale VAT snapshots and rejects UNCONFIGURED", async () => {
    const value = await fixture("sale-vat");

    await expect(
      createSale(value, "registered-vat", {
        outputVatAmount: "0.66",
        salesVatRateSnapshot: "7.000000",
        salesVatStatusSnapshot: "REGISTERED",
        taxableAmount: "9.46",
      }),
    ).resolves.toBeDefined();

    for (const data of [
      { salesVatStatusSnapshot: "UNCONFIGURED" as const },
      { salesVatStatusSnapshot: "REGISTERED" as const },
      {
        salesVatRateSnapshot: "7.000000",
        salesVatStatusSnapshot: "NOT_REGISTERED" as const,
      },
      {
        outputVatAmount: "0.01",
        salesVatStatusSnapshot: "NOT_REGISTERED" as const,
      },
      {
        outputVatAmount: "0.66",
        salesVatRateSnapshot: "100.000000",
        salesVatStatusSnapshot: "REGISTERED" as const,
        taxableAmount: "9.46",
      },
      {
        outputVatAmount: "0.67",
        salesVatRateSnapshot: "7.000000",
        salesVatStatusSnapshot: "REGISTERED" as const,
        taxableAmount: "9.46",
      },
    ] satisfies Partial<Prisma.SaleUncheckedCreateInput>[]) {
      await expect(createSale(value, randomUUID(), data)).rejects.toThrow();
    }
  });

  it("binds Sale branch and actor provenance to the same tenant and user", async () => {
    const first = await fixture("sale-tenant-a");
    const second = await fixture("sale-tenant-b");

    await expect(
      createSale(first, "cross-branch", { branchId: second.branch.id }),
    ).rejects.toThrow();
    await expect(
      createSale(first, "cross-membership", {
        actorMembershipId: second.membership.id,
      }),
    ).rejects.toThrow();
    await expect(
      createSale(first, "actor-user-mismatch", { actorUserId: second.user.id }),
    ).rejects.toThrow();
  });

  it("persists Product snapshots, fixed scales, one Product per Sale, and tenant-safe items", async () => {
    const first = await fixture("item-tenant-a");
    const second = await fixture("item-tenant-b");
    const sale = await createSale(first, "item-shape");
    const item = await createSaleItem(first, sale.id, {
      quantity: "1.2345",
      unitPrice: "8.7654",
    });

    expect(item.productSkuSnapshot).toBe(first.product.sku);
    expect(item.productNameSnapshot).toBe(first.product.name);
    expect(item.productUnitSnapshot).toBe("EA");
    expect(item.quantity.toFixed(4)).toBe("1.2345");
    expect(item.unitPrice.toFixed(4)).toBe("8.7654");

    await expect(createSaleItem(first, sale.id)).rejects.toThrow();
    await expect(
      createSaleItem(first, sale.id, { productId: second.product.id }),
    ).rejects.toThrow();
    await expect(
      createSaleItem(first, sale.id, {
        branchId: second.branch.id,
        organizationId: second.organization.id,
        productId: second.product.id,
      }),
    ).rejects.toThrow();
  });

  it("enforces SaleItem monetary, VAT-nullability, and UNKNOWN or KNOWN cost shapes", async () => {
    const value = await fixture("item-constraints");

    async function attempt(
      key: string,
      data: Partial<Prisma.SaleItemUncheckedCreateInput>,
    ) {
      const sale = await createSale(value, key);
      return createSaleItem(value, sale.id, data);
    }

    await expect(
      attempt("known-cost", {
        cogsAmount: "3.3333330000",
        costBasisState: "KNOWN",
        unitCost: "3.333333",
      }),
    ).resolves.toBeDefined();

    for (const [key, data] of [
      ["zero-quantity", { quantity: "0" }],
      ["negative-price", { unitPrice: "-0.0001" }],
      ["negative-gross", { lineGross: "-0.01", lineNet: "-0.01" }],
      ["discount-over-gross", { lineDiscount: "10.13", lineNet: "0.00" }],
      ["allocation-mismatch", { lineDiscount: "1.00", lineNet: "10.12" }],
      ["vat-over-net", { lineOutputVat: "10.13", lineTaxable: "0.00" }],
      ["null-taxable-with-vat", { lineOutputVat: "0.01" }],
      ["taxable-sum-mismatch", { lineOutputVat: "0.66", lineTaxable: "9.45" }],
      ["unknown-with-cost", { costBasisState: "UNKNOWN", unitCost: "0" }],
      ["known-without-cost", { costBasisState: "KNOWN" }],
      [
        "known-cogs-mismatch",
        {
          cogsAmount: "3.3333330001",
          costBasisState: "KNOWN",
          unitCost: "3.333333",
        },
      ],
    ] satisfies [string, Partial<Prisma.SaleItemUncheckedCreateInput>][]) {
      await expect(attempt(key, data)).rejects.toThrow();
    }
  });

  it("enforces exactly one Payment slot, Sale-total equality, and valid CASH or TRANSFER shapes", async () => {
    const value = await fixture("payments");
    const cashSale = await createSale(value, "cash-payment");
    await expect(createCashPayment(value, cashSale.id)).resolves.toBeDefined();
    await expect(createCashPayment(value, cashSale.id)).rejects.toThrow();

    const transferSale = await createSale(value, "transfer-payment");
    await expect(
      prisma.payment.create({
        data: {
          amount: transferSale.totalAmount,
          branchId: value.branch.id,
          confirmedAt: new Date("2026-09-05T10:00:00.000Z"),
          method: "TRANSFER",
          organizationId: value.organization.id,
          saleId: transferSale.id,
          transferReference: "BANK-REFERENCE-1",
        },
      }),
    ).resolves.toBeDefined();

    const wrongTotalSale = await createSale(value, "wrong-total-payment");
    await expect(
      createCashPayment(value, wrongTotalSale.id, {
        amount: "9.00",
        amountTendered: "10.00",
        changeAmount: "1.00",
      }),
    ).rejects.toThrow();

    for (const [key, data] of [
      ["cash-no-tender", { amountTendered: null }],
      ["cash-bad-change", { changeAmount: "9.87" }],
      ["cash-reference", { transferReference: "NOT-CASH" }],
      [
        "transfer-tender",
        {
          amountTendered: "10.12",
          changeAmount: "0.00",
          method: "TRANSFER" as const,
        },
      ],
      [
        "transfer-blank-reference",
        { method: "TRANSFER" as const, transferReference: " " },
      ],
    ] satisfies [string, Partial<Prisma.PaymentUncheckedCreateInput>][]) {
      const sale = await createSale(value, key);
      await expect(createCashPayment(value, sale.id, data)).rejects.toThrow();
    }
  });

  it("rejects cross-tenant Payment association", async () => {
    const first = await fixture("payment-tenant-a");
    const second = await fixture("payment-tenant-b");
    const sale = await createSale(first, "payment-tenant");

    await expect(
      createCashPayment(first, sale.id, {
        branchId: second.branch.id,
        organizationId: second.organization.id,
      }),
    ).rejects.toThrow();
  });

  it("accepts one negative SALE movement and rejects invalid or duplicate Sale provenance", async () => {
    const value = await fixture("sale-ledger");
    const sale = await createSale(value, "sale-ledger");
    const item = await createSaleItem(value, sale.id);

    const movement = await prisma.inventoryTransaction.create({
      data: {
        actorMembershipId: value.membership.id,
        actorUserId: value.user.id,
        branchId: value.branch.id,
        delta: "-1.0000",
        organizationId: value.organization.id,
        productId: value.product.id,
        saleItemId: item.id,
        source: "SALE",
      },
    });
    expect(movement.saleItemId).toBe(item.id);

    await expect(
      prisma.inventoryTransaction.create({
        data: {
          actorMembershipId: value.membership.id,
          actorUserId: value.user.id,
          branchId: value.branch.id,
          delta: "-1.0000",
          organizationId: value.organization.id,
          productId: value.product.id,
          saleItemId: item.id,
          source: "SALE",
        },
      }),
    ).rejects.toThrow();

    const invalidSale = await createSale(value, "invalid-sale-ledger");
    const invalidItem = await createSaleItem(value, invalidSale.id);
    await expect(
      prisma.inventoryTransaction.create({
        data: {
          actorMembershipId: value.membership.id,
          actorUserId: value.user.id,
          branchId: value.branch.id,
          delta: "1.0000",
          organizationId: value.organization.id,
          productId: value.product.id,
          saleItemId: invalidItem.id,
          source: "SALE",
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.inventoryTransaction.create({
        data: {
          actorMembershipId: value.membership.id,
          actorUserId: value.user.id,
          branchId: value.branch.id,
          delta: "-1.0000",
          idempotencyKeyHash: hash("invalid-sale-ledger-key"),
          organizationId: value.organization.id,
          productId: value.product.id,
          saleItemId: invalidItem.id,
          source: "SALE",
        },
      }),
    ).rejects.toThrow();

    await expect(
      prisma.inventoryTransaction.create({
        data: {
          actorMembershipId: value.membership.id,
          actorUserId: value.user.id,
          adjustmentReason: "STOCK_COUNT",
          branchId: value.branch.id,
          canonicalRequestHash: hash("manual-request"),
          delta: "1.0000",
          idempotencyKeyHash: hash("manual-key"),
          organizationId: value.organization.id,
          productId: value.product.id,
          source: "MANUAL_ADJUSTMENT",
        },
      }),
    ).resolves.toBeDefined();
  });

  it("preserves PURCHASE_RECEIVE ledger provenance alongside SALE", async () => {
    const value = await fixture("purchase-ledger");
    const supplier = await prisma.supplier.create({
      data: { name: "Supplier", organizationId: value.organization.id },
    });
    const order = await prisma.purchaseOrder.create({
      data: {
        branchId: value.branch.id,
        createdByMembershipId: value.membership.id,
        createdByUserId: value.user.id,
        expectedTotal: "10.1234",
        orderDate: new Date("2026-09-05T00:00:00.000Z"),
        organizationId: value.organization.id,
        reference: `PO-${randomUUID()}`,
        status: "ORDERED",
        supplierId: supplier.id,
      },
    });
    const orderItem = await prisma.purchaseOrderItem.create({
      data: {
        expectedUnitCost: "10.1234",
        organizationId: value.organization.id,
        productId: value.product.id,
        productNameSnapshot: value.product.name,
        productSkuSnapshot: value.product.sku,
        purchaseOrderId: order.id,
        quantity: "1.0000",
      },
    });
    const receipt = await prisma.purchaseReceipt.create({
      data: {
        branchId: value.branch.id,
        canonicalRequestHash: hash("purchase-request"),
        idempotencyKeyHash: hash("purchase-key"),
        organizationId: value.organization.id,
        organizationVatRegisteredSnapshot: false,
        purchaseOrderId: order.id,
        receivedAt: new Date("2026-09-05T10:00:00.000Z"),
        receivedByMembershipId: value.membership.id,
        receivedByUserId: value.user.id,
        reference: `RCPT-${randomUUID()}`,
        supplierId: supplier.id,
      },
    });
    const receiptItem = await prisma.purchaseReceiptItem.create({
      data: {
        actualUnitCost: "10.1234",
        branchId: value.branch.id,
        organizationId: value.organization.id,
        productId: value.product.id,
        productNameSnapshot: value.product.name,
        productSkuSnapshot: value.product.sku,
        purchaseOrderId: order.id,
        purchaseOrderItemId: orderItem.id,
        receiptId: receipt.id,
        receivedQuantity: "1.0000",
      },
    });

    await expect(
      prisma.inventoryTransaction.create({
        data: {
          actorMembershipId: value.membership.id,
          actorUserId: value.user.id,
          branchId: value.branch.id,
          delta: "1.0000",
          organizationId: value.organization.id,
          productId: value.product.id,
          purchaseReceiptItemId: receiptItem.id,
          source: "PURCHASE_RECEIVE",
        },
      }),
    ).resolves.toBeDefined();
  });

  it("restricts deletion of Sale master data and completed history", async () => {
    const value = await fixture("sale-history");
    const sale = await createSale(value, "sale-history");
    const item = await createSaleItem(value, sale.id);
    await createCashPayment(value, sale.id);
    await prisma.inventoryTransaction.create({
      data: {
        actorMembershipId: value.membership.id,
        actorUserId: value.user.id,
        branchId: value.branch.id,
        delta: "-1.0000",
        organizationId: value.organization.id,
        productId: value.product.id,
        saleItemId: item.id,
        source: "SALE",
      },
    });

    await expect(
      prisma.sale.delete({ where: { id: sale.id } }),
    ).rejects.toThrow();
    await expect(
      prisma.product.delete({ where: { id: value.product.id } }),
    ).rejects.toThrow();
    await expect(
      prisma.branch.delete({ where: { id: value.branch.id } }),
    ).rejects.toThrow();
    await expect(
      prisma.organizationMembership.delete({
        where: {
          organizationId_userId: {
            organizationId: value.organization.id,
            userId: value.user.id,
          },
        },
      }),
    ).rejects.toThrow();
  });
});
