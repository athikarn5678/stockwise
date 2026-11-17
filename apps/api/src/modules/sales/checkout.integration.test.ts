import { randomUUID } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { Prisma } from "../../generated/prisma/client.ts";
import {
  createTestPrismaClient,
  resetTestDatabase,
} from "../../test/database-harness.ts";
import { loadTestDatabaseEnvironment } from "../../test/database-environment.ts";
import { createPrismaInventoryRepository } from "../inventory/inventory-repository.ts";
import {
  createPrismaCheckoutRepository,
  type CheckoutInput,
} from "./checkout-repository.ts";

const environment = loadTestDatabaseEnvironment();
const prisma = createTestPrismaClient(environment);
const completedAt = new Date("2026-09-18T10:00:00.000Z");
const checkout = createPrismaCheckoutRepository(prisma, {
  now: () => completedAt,
});

type TestRole =
  "OWNER" | "ADMIN" | "BRANCH_MANAGER" | "INVENTORY_STAFF" | "CASHIER";

async function createActor(input: {
  assigned?: boolean;
  branchId: string;
  organizationId: string;
  role?: TestRole;
}) {
  const user = await prisma.user.create({
    data: {
      displayName: `${input.role ?? "OWNER"} Employee`,
      email: `${randomUUID()}@example.com`,
    },
  });
  const membership = await prisma.organizationMembership.create({
    data: {
      organizationId: input.organizationId,
      role: input.role ?? "OWNER",
      userId: user.id,
    },
  });
  if (
    input.assigned !== false &&
    input.role !== undefined &&
    !["OWNER", "ADMIN"].includes(input.role)
  ) {
    await prisma.branchAssignment.create({
      data: {
        branchId: input.branchId,
        organizationId: input.organizationId,
        userId: user.id,
      },
    });
  }
  return { membership, user };
}

async function createScope(input: {
  label: string;
  prices?: readonly string[];
  salesVatRate?: string | null;
  salesVatStatus?: "UNCONFIGURED" | "NOT_REGISTERED" | "REGISTERED";
  units?: readonly ("EA" | "KG")[];
}) {
  const salesVatStatus = input.salesVatStatus ?? "NOT_REGISTERED";
  const organization = await prisma.organization.create({
    data: {
      name: `${input.label} Organization`,
      salesVatRate:
        salesVatStatus === "REGISTERED" ? (input.salesVatRate ?? "7") : null,
      salesVatStatus,
    },
  });
  const branch = await prisma.branch.create({
    data: {
      code: `BR-${randomUUID().slice(0, 8)}`,
      name: `${input.label} Branch`,
      organizationId: organization.id,
    },
  });
  const prices = input.prices ?? ["10", "20"];
  const products = [];
  for (const [index, price] of prices.entries()) {
    products.push(
      await prisma.product.create({
        data: {
          basePrice: price,
          name: `${input.label} Product ${index + 1}`,
          organizationId: organization.id,
          sku: `${randomUUID().slice(0, 8)}-P${index + 1}`.toUpperCase(),
          unit: input.units?.[index] ?? "EA",
        },
      }),
    );
  }
  const owner = await createActor({
    branchId: branch.id,
    organizationId: organization.id,
  });
  return { branch, organization, owner, products };
}

async function createStock(input: {
  averageUnitCost?: string;
  basisState?: "KNOWN" | "UNKNOWN";
  branchId: string;
  organizationId: string;
  productId: string;
  quantity: string;
}) {
  await prisma.inventoryBalance.create({
    data: {
      branchId: input.branchId,
      organizationId: input.organizationId,
      productId: input.productId,
      quantity: input.quantity,
    },
  });
  if (input.basisState !== undefined) {
    if (input.basisState === "KNOWN" && input.averageUnitCost === undefined) {
      throw new Error("Known test stock requires an average unit cost.");
    }
    const averageUnitCost =
      input.basisState === "KNOWN" ? input.averageUnitCost! : null;
    await prisma.inventoryCostState.create({
      data: {
        averageUnitCost,
        basisState: input.basisState,
        branchId: input.branchId,
        inventoryValue:
          averageUnitCost === null
            ? null
            : new Prisma.Decimal(input.quantity).times(averageUnitCost),
        organizationId: input.organizationId,
        productId: input.productId,
      },
    });
  }
}

function request(input: {
  actorUserId: string;
  branchId: string;
  expectedPrices?: readonly string[];
  key?: string;
  organizationId: string;
  productIds: readonly string[];
  quantities?: readonly string[];
}): CheckoutInput {
  return {
    actorUserId: input.actorUserId,
    branchId: input.branchId,
    discount: null,
    idempotencyKey: input.key ?? `checkout-${randomUUID()}`,
    items: input.productIds.map((productId, index) => ({
      expectedUnitPrice: input.expectedPrices?.[index] ?? `${(index + 1) * 10}`,
      productId,
      quantity: input.quantities?.[index] ?? "1",
    })),
    organizationId: input.organizationId,
    payment: { amountTendered: "1000.00", method: "CASH" },
  };
}

describe("checkout repository with PostgreSQL", () => {
  beforeEach(async () => resetTestDatabase(environment));
  afterAll(async () => {
    await resetTestDatabase(environment);
    await prisma.$disconnect();
  });

  it("atomically completes CASH with exact payment, change, KNOWN COGS, and linked SALE ledger provenance", async () => {
    const value = await createScope({
      label: "Cash success",
      prices: ["60.1234"],
    });
    const product = value.products[0]!;
    await createStock({
      averageUnitCost: "35.123456",
      basisState: "KNOWN",
      branchId: value.branch.id,
      organizationId: value.organization.id,
      productId: product.id,
      quantity: "10",
    });
    const result = await checkout.checkout({
      ...request({
        actorUserId: value.owner.user.id,
        branchId: value.branch.id,
        expectedPrices: ["60.1234"],
        organizationId: value.organization.id,
        productIds: [product.id],
        quantities: ["2"],
      }),
      payment: { amountTendered: "200.00", method: "CASH" },
    });

    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;
    expect(result.sale).toMatchObject({
      currency: "THB",
      discountAmount: "0.00",
      occurredAt: completedAt.toISOString(),
      outputVatAmount: "0.00",
      subtotalAmount: "120.25",
      taxableAmount: null,
      totalAmount: "120.25",
      vatRateSnapshot: null,
    });
    expect(result.sale.payment).toEqual({
      amount: "120.25",
      amountTendered: "200.00",
      changeAmount: "79.75",
      method: "CASH",
      reference: null,
    });
    const saleItem = await prisma.saleItem.findFirstOrThrow();
    const balance = await prisma.inventoryBalance.findFirstOrThrow();
    const cost = await prisma.inventoryCostState.findFirstOrThrow();
    const movement = await prisma.inventoryTransaction.findFirstOrThrow();
    expect(saleItem).toMatchObject({ costBasisState: "KNOWN" });
    expect(saleItem.unitCost?.toFixed(6)).toBe("35.123456");
    expect(saleItem.cogsAmount?.toFixed(10)).toBe("70.2469120000");
    expect(balance.quantity.toFixed(4)).toBe("8.0000");
    expect(cost.averageUnitCost?.toFixed(6)).toBe("35.123456");
    expect(cost.inventoryValue?.toFixed(10)).toBe("280.9876480000");
    expect(movement).toMatchObject({
      saleItemId: saleItem.id,
      source: "SALE",
    });
    expect(movement.delta.toFixed(4)).toBe("-2.0000");
  });

  it("completes manually confirmed TRANSFER and preserves NOT_REGISTERED and UNKNOWN-cost semantics", async () => {
    const value = await createScope({ label: "Transfer success" });
    const product = value.products[0]!;
    await createStock({
      basisState: "UNKNOWN",
      branchId: value.branch.id,
      organizationId: value.organization.id,
      productId: product.id,
      quantity: "2",
    });
    const result = await checkout.checkout({
      ...request({
        actorUserId: value.owner.user.id,
        branchId: value.branch.id,
        organizationId: value.organization.id,
        productIds: [product.id],
      }),
      payment: { method: "TRANSFER", reference: " QR-100 " },
    });
    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;
    expect(result.sale.payment).toEqual({
      amount: "10.00",
      amountTendered: null,
      changeAmount: null,
      method: "TRANSFER",
      reference: "QR-100",
    });
    expect(result.sale.salesVatStatusSnapshot).toBe("NOT_REGISTERED");
    expect(result.sale.taxableAmount).toBeNull();
    expect(result.sale.items[0]).toMatchObject({
      lineOutputVat: "0.00",
      lineTaxable: null,
    });
    expect(await prisma.payment.count()).toBe(1);
    expect(await prisma.saleItem.findFirstOrThrow()).toMatchObject({
      cogsAmount: null,
      costBasisState: "UNKNOWN",
      unitCost: null,
    });
  });

  it("applies an authorized PERCENT discount before VAT-inclusive extraction and reconciles every line allocation", async () => {
    const value = await createScope({
      label: "Percent VAT",
      prices: ["428", "642"],
      salesVatRate: "7",
      salesVatStatus: "REGISTERED",
    });
    for (const product of value.products) {
      await createStock({
        branchId: value.branch.id,
        organizationId: value.organization.id,
        productId: product.id,
        quantity: "10",
      });
    }
    const result = await checkout.checkout({
      ...request({
        actorUserId: value.owner.user.id,
        branchId: value.branch.id,
        expectedPrices: ["428", "642"],
        organizationId: value.organization.id,
        productIds: value.products.map(({ id }) => id),
      }),
      discount: {
        percent: "10.0000",
        reason: " Manager approved ",
        type: "PERCENT",
      },
      payment: { method: "TRANSFER" },
    });
    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;
    expect(result.sale).toMatchObject({
      discount: {
        percent: "10",
        reason: "Manager approved",
        type: "PERCENT",
      },
      discountAmount: "107.00",
      outputVatAmount: "63.00",
      subtotalAmount: "1070.00",
      taxableAmount: "900.00",
      totalAmount: "963.00",
      vatRateSnapshot: "7",
    });
    const sums = result.sale.items.reduce(
      (totals, item) => ({
        discount: totals.discount.plus(item.lineDiscount),
        gross: totals.gross.plus(item.lineGross),
        net: totals.net.plus(item.lineNet),
        taxable: totals.taxable.plus(item.lineTaxable ?? 0),
        vat: totals.vat.plus(item.lineOutputVat),
      }),
      {
        discount: new Prisma.Decimal(0),
        gross: new Prisma.Decimal(0),
        net: new Prisma.Decimal(0),
        taxable: new Prisma.Decimal(0),
        vat: new Prisma.Decimal(0),
      },
    );
    expect({
      discount: sums.discount.toFixed(2),
      gross: sums.gross.toFixed(2),
      net: sums.net.toFixed(2),
      taxable: sums.taxable.toFixed(2),
      vat: sums.vat.toFixed(2),
    }).toEqual({
      discount: "107.00",
      gross: "1070.00",
      net: "963.00",
      taxable: "900.00",
      vat: "63.00",
    });
  });

  it("validates and calculates whole-Sale AMOUNT discounts", async () => {
    const value = await createScope({ label: "Amount discount" });
    const product = value.products[0]!;
    await createStock({
      branchId: value.branch.id,
      organizationId: value.organization.id,
      productId: product.id,
      quantity: "5",
    });
    const base = request({
      actorUserId: value.owner.user.id,
      branchId: value.branch.id,
      organizationId: value.organization.id,
      productIds: [product.id],
    });
    expect(
      await checkout.checkout({
        ...base,
        discount: { amount: "10.00", reason: "Too much", type: "AMOUNT" },
      }),
    ).toEqual({ kind: "invalid_amounts" });
    const result = await checkout.checkout({
      ...base,
      discount: { amount: "2.25", reason: "Approved", type: "AMOUNT" },
      idempotencyKey: "valid-amount-discount",
    });
    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;
    expect(result.sale).toMatchObject({
      discount: { amount: "2.25", reason: "Approved", type: "AMOUNT" },
      discountAmount: "2.25",
      totalAmount: "7.75",
    });
  });

  it("rejects insufficient stock without any Sale, Payment, balance, cost, or ledger mutation", async () => {
    const value = await createScope({ label: "Insufficient stock" });
    const product = value.products[0]!;
    await createStock({
      averageUnitCost: "2",
      basisState: "KNOWN",
      branchId: value.branch.id,
      organizationId: value.organization.id,
      productId: product.id,
      quantity: "1",
    });
    const result = await checkout.checkout(
      request({
        actorUserId: value.owner.user.id,
        branchId: value.branch.id,
        organizationId: value.organization.id,
        productIds: [product.id],
        quantities: ["2"],
      }),
    );
    expect(result).toEqual({ kind: "insufficient_stock" });
    expect(await prisma.sale.count()).toBe(0);
    expect(await prisma.saleItem.count()).toBe(0);
    expect(await prisma.payment.count()).toBe(0);
    expect(await prisma.inventoryTransaction.count()).toBe(0);
    expect(
      (await prisma.inventoryBalance.findFirstOrThrow()).quantity.toString(),
    ).toBe("1");
    expect(
      (
        await prisma.inventoryCostState.findFirstOrThrow()
      ).inventoryValue?.toString(),
    ).toBe("2");
  });

  it("prevents oversell under two real concurrent checkout transactions", async () => {
    const value = await createScope({ label: "Concurrent oversell" });
    const product = value.products[0]!;
    await createStock({
      branchId: value.branch.id,
      organizationId: value.organization.id,
      productId: product.id,
      quantity: "1",
    });
    const base = request({
      actorUserId: value.owner.user.id,
      branchId: value.branch.id,
      organizationId: value.organization.id,
      productIds: [product.id],
    });
    const results = await Promise.all([
      checkout.checkout({ ...base, idempotencyKey: "oversell-a" }),
      checkout.checkout({ ...base, idempotencyKey: "oversell-b" }),
    ]);
    expect(results.map(({ kind }) => kind).sort()).toEqual([
      "insufficient_stock",
      "success",
    ]);
    expect(await prisma.sale.count()).toBe(1);
    expect(await prisma.payment.count()).toBe(1);
    expect(await prisma.inventoryTransaction.count()).toBe(1);
    expect(
      (await prisma.inventoryBalance.findFirstOrThrow()).quantity.toString(),
    ).toBe("0");
  });

  it("sorts overlapping multi-line locks deterministically so reverse-order concurrent carts both finish and reconcile", async () => {
    const value = await createScope({ label: "Deterministic locks" });
    for (const product of value.products) {
      await createStock({
        branchId: value.branch.id,
        organizationId: value.organization.id,
        productId: product.id,
        quantity: "5",
      });
    }
    const forward = request({
      actorUserId: value.owner.user.id,
      branchId: value.branch.id,
      organizationId: value.organization.id,
      productIds: value.products.map(({ id }) => id),
    });
    const reverse = request({
      actorUserId: value.owner.user.id,
      branchId: value.branch.id,
      expectedPrices: ["20", "10"],
      organizationId: value.organization.id,
      productIds: [...value.products].reverse().map(({ id }) => id),
    });
    const results = await Promise.all([
      checkout.checkout({ ...forward, idempotencyKey: "locks-forward" }),
      checkout.checkout({ ...reverse, idempotencyKey: "locks-reverse" }),
    ]);
    expect(results.map(({ kind }) => kind)).toEqual(["success", "success"]);
    const balances = await prisma.inventoryBalance.findMany({
      orderBy: { productId: "asc" },
    });
    const ledger = await prisma.inventoryTransaction.groupBy({
      _sum: { delta: true },
      by: ["productId"],
      orderBy: { productId: "asc" },
    });
    expect(balances.map(({ quantity }) => quantity.toString())).toEqual([
      "3",
      "3",
    ]);
    expect(ledger.map(({ _sum }) => _sum.delta?.toString())).toEqual([
      "-2",
      "-2",
    ]);
  });

  it("serializes checkout with manual adjustment through the shared Branch/Product lock", async () => {
    const value = await createScope({ label: "Adjustment race" });
    const product = value.products[0]!;
    await createStock({
      branchId: value.branch.id,
      organizationId: value.organization.id,
      productId: product.id,
      quantity: "1",
    });
    const inventory = createPrismaInventoryRepository(prisma);
    const [saleResult, adjustmentResult] = await Promise.all([
      checkout.checkout(
        request({
          actorUserId: value.owner.user.id,
          branchId: value.branch.id,
          key: "checkout-adjustment-race",
          organizationId: value.organization.id,
          productIds: [product.id],
        }),
      ),
      inventory.adjust({
        actorUserId: value.owner.user.id,
        adjustment: {
          delta: "-1",
          note: null,
          productId: product.id,
          reason: "DAMAGE",
        },
        branchId: value.branch.id,
        idempotencyKey: "adjustment-checkout-race",
        organizationId: value.organization.id,
      }),
    ]);
    expect([saleResult.kind, adjustmentResult.kind].sort()).toEqual([
      "insufficient_stock",
      "success",
    ]);
    const balance = await prisma.inventoryBalance.findFirstOrThrow();
    const ledger = await prisma.inventoryTransaction.aggregate({
      _sum: { delta: true },
    });
    expect(balance.quantity.toString()).toBe("0");
    expect(ledger._sum.delta?.toString()).toBe("-1");
  });

  it("returns one logical Sale for concurrent and later identical retries and conflicts on changed intent", async () => {
    const value = await createScope({ label: "Idempotency" });
    for (const product of value.products) {
      await createStock({
        branchId: value.branch.id,
        organizationId: value.organization.id,
        productId: product.id,
        quantity: "10",
      });
    }
    const first = {
      ...request({
        actorUserId: value.owner.user.id,
        branchId: value.branch.id,
        key: "stable-checkout-key",
        organizationId: value.organization.id,
        productIds: value.products.map(({ id }) => id),
      }),
      payment: { method: "TRANSFER" as const, reference: " REF-1 " },
    };
    const identical = {
      ...first,
      items: [...first.items]
        .reverse()
        .map((item) => ({ ...item, quantity: "1.0000" })),
      payment: { method: "TRANSFER" as const, reference: "REF-1" },
    };
    const concurrent = await Promise.all([
      checkout.checkout(first),
      checkout.checkout(identical),
    ]);
    expect(concurrent.map(({ kind }) => kind).sort()).toEqual([
      "replay",
      "success",
    ]);
    if (!("sale" in concurrent[0]!) || !("sale" in concurrent[1]!)) return;
    expect(concurrent[0]!.sale.id).toBe(concurrent[1]!.sale.id);
    expect((await checkout.checkout(first)).kind).toBe("replay");
    expect(
      await checkout.checkout({
        ...first,
        items: [{ ...first.items[0]!, quantity: "2" }, first.items[1]!],
      }),
    ).toEqual({ kind: "idempotency_conflict" });
    expect(await prisma.sale.count()).toBe(1);
    expect(await prisma.payment.count()).toBe(1);
    expect(await prisma.inventoryTransaction.count()).toBe(2);
  });

  it("rolls back injected mid-checkout failure and does not poison a later retry", async () => {
    const value = await createScope({ label: "Rollback" });
    for (const product of value.products) {
      await createStock({
        branchId: value.branch.id,
        organizationId: value.organization.id,
        productId: product.id,
        quantity: "5",
      });
    }
    const input = request({
      actorUserId: value.owner.user.id,
      branchId: value.branch.id,
      key: "rollback-retry",
      organizationId: value.organization.id,
      productIds: value.products.map(({ id }) => id),
    });
    const failing = createPrismaCheckoutRepository(prisma, {
      afterLineCommitted: () => {
        throw new Error("injected checkout failure");
      },
      now: () => completedAt,
    });
    await expect(failing.checkout(input)).rejects.toThrow(
      "injected checkout failure",
    );
    expect(await prisma.sale.count()).toBe(0);
    expect(await prisma.saleItem.count()).toBe(0);
    expect(await prisma.payment.count()).toBe(0);
    expect(await prisma.inventoryTransaction.count()).toBe(0);
    expect(
      (await prisma.inventoryBalance.findMany()).map(({ quantity }) =>
        quantity.toString(),
      ),
    ).toEqual(["5", "5"]);
    expect((await checkout.checkout(input)).kind).toBe("success");
  });

  it("reloads authoritative Product price and rejects PRICE_CHANGED without mutation", async () => {
    const value = await createScope({ label: "Price change" });
    const product = value.products[0]!;
    await createStock({
      branchId: value.branch.id,
      organizationId: value.organization.id,
      productId: product.id,
      quantity: "5",
    });
    await prisma.product.update({
      data: { basePrice: "11.0000" },
      where: { id: product.id },
    });
    const result = await checkout.checkout(
      request({
        actorUserId: value.owner.user.id,
        branchId: value.branch.id,
        expectedPrices: ["10.0000"],
        organizationId: value.organization.id,
        productIds: [product.id],
      }),
    );
    expect(result).toEqual({ kind: "price_changed" });
    expect(await prisma.sale.count()).toBe(0);
    expect(
      (await prisma.inventoryBalance.findFirstOrThrow()).quantity.toString(),
    ).toBe("5");
  });

  it("denies INVENTORY_STAFF and an unassigned branch-scoped checkout actor", async () => {
    const value = await createScope({ label: "Authorization" });
    const product = value.products[0]!;
    await createStock({
      branchId: value.branch.id,
      organizationId: value.organization.id,
      productId: product.id,
      quantity: "5",
    });
    const inventoryStaff = await createActor({
      branchId: value.branch.id,
      organizationId: value.organization.id,
      role: "INVENTORY_STAFF",
    });
    const unassignedCashier = await createActor({
      assigned: false,
      branchId: value.branch.id,
      organizationId: value.organization.id,
      role: "CASHIER",
    });
    for (const actor of [inventoryStaff, unassignedCashier]) {
      expect(
        await checkout.checkout(
          request({
            actorUserId: actor.user.id,
            branchId: value.branch.id,
            organizationId: value.organization.id,
            productIds: [product.id],
          }),
        ),
      ).toEqual({ kind: "forbidden" });
    }
    expect(await prisma.sale.count()).toBe(0);
  });

  it("rejects CASHIER discount privilege escalation and allows an assigned BRANCH_MANAGER", async () => {
    const value = await createScope({ label: "Discount authority" });
    const product = value.products[0]!;
    await createStock({
      branchId: value.branch.id,
      organizationId: value.organization.id,
      productId: product.id,
      quantity: "5",
    });
    const cashier = await createActor({
      branchId: value.branch.id,
      organizationId: value.organization.id,
      role: "CASHIER",
    });
    const manager = await createActor({
      branchId: value.branch.id,
      organizationId: value.organization.id,
      role: "BRANCH_MANAGER",
    });
    const discounted = (actorUserId: string, key: string): CheckoutInput => ({
      ...request({
        actorUserId,
        branchId: value.branch.id,
        key,
        organizationId: value.organization.id,
        productIds: [product.id],
      }),
      discount: { amount: "1", reason: "Approved", type: "AMOUNT" },
    });
    expect(
      await checkout.checkout(discounted(cashier.user.id, "cashier-discount")),
    ).toEqual({ kind: "forbidden" });
    expect(
      (await checkout.checkout(discounted(manager.user.id, "manager-discount")))
        .kind,
    ).toBe("success");
  });

  it("blocks UNCONFIGURED VAT before creating any checkout records", async () => {
    const value = await createScope({
      label: "VAT unconfigured",
      salesVatStatus: "UNCONFIGURED",
    });
    const product = value.products[0]!;
    await createStock({
      branchId: value.branch.id,
      organizationId: value.organization.id,
      productId: product.id,
      quantity: "5",
    });
    expect(
      await checkout.checkout(
        request({
          actorUserId: value.owner.user.id,
          branchId: value.branch.id,
          organizationId: value.organization.id,
          productIds: [product.id],
        }),
      ),
    ).toEqual({ kind: "vat_configuration_required" });
    expect(await prisma.sale.count()).toBe(0);
  });

  it("rejects excess decimal scale and integer-unit fractional quantities at the service boundary", async () => {
    const value = await createScope({ label: "Decimal validation" });
    const product = value.products[0]!;
    await createStock({
      branchId: value.branch.id,
      organizationId: value.organization.id,
      productId: product.id,
      quantity: "5",
    });
    const base = request({
      actorUserId: value.owner.user.id,
      branchId: value.branch.id,
      organizationId: value.organization.id,
      productIds: [product.id],
    });
    expect(
      await checkout.checkout({
        ...base,
        items: [{ ...base.items[0]!, quantity: "1.00001" }],
      }),
    ).toEqual({ kind: "invalid_quantity" });
    expect(
      await checkout.checkout({
        ...base,
        idempotencyKey: "price-scale",
        items: [{ ...base.items[0]!, expectedUnitPrice: "10.00001" }],
      }),
    ).toEqual({ kind: "invalid_price" });
    expect(
      await checkout.checkout({
        ...base,
        idempotencyKey: "tender-scale",
        payment: { amountTendered: "10.001", method: "CASH" },
      }),
    ).toEqual({ kind: "invalid_payment" });
    expect(
      await checkout.checkout({
        ...base,
        idempotencyKey: "integer-unit",
        items: [{ ...base.items[0]!, quantity: "0.5" }],
      }),
    ).toEqual({ kind: "invalid_quantity" });
    expect(await prisma.sale.count()).toBe(0);
  });

  it("keeps UNKNOWN cost null when a sale reaches zero instead of fabricating or initializing cost", async () => {
    const value = await createScope({ label: "Unknown reaches zero" });
    const product = value.products[0]!;
    await createStock({
      basisState: "UNKNOWN",
      branchId: value.branch.id,
      organizationId: value.organization.id,
      productId: product.id,
      quantity: "1",
    });
    expect(
      (
        await checkout.checkout(
          request({
            actorUserId: value.owner.user.id,
            branchId: value.branch.id,
            organizationId: value.organization.id,
            productIds: [product.id],
          }),
        )
      ).kind,
    ).toBe("success");
    const item = await prisma.saleItem.findFirstOrThrow();
    const cost = await prisma.inventoryCostState.findFirstOrThrow();
    expect(item).toMatchObject({
      cogsAmount: null,
      costBasisState: "UNKNOWN",
      unitCost: null,
    });
    expect(cost).toMatchObject({
      averageUnitCost: null,
      basisState: "UNKNOWN",
      inventoryValue: null,
    });
    expect(
      (await prisma.inventoryBalance.findFirstOrThrow()).quantity.toString(),
    ).toBe("0");
  });

  it("rejects a cross-organization Product without leaking or mutating either tenant", async () => {
    const first = await createScope({ label: "Tenant A" });
    const second = await createScope({ label: "Tenant B" });
    const foreignProduct = second.products[0]!;
    await createStock({
      branchId: second.branch.id,
      organizationId: second.organization.id,
      productId: foreignProduct.id,
      quantity: "5",
    });
    const result = await checkout.checkout(
      request({
        actorUserId: first.owner.user.id,
        branchId: first.branch.id,
        organizationId: first.organization.id,
        productIds: [foreignProduct.id],
      }),
    );
    expect(result).toEqual({ kind: "not_found" });
    expect(await prisma.sale.count()).toBe(0);
    expect(
      (await prisma.inventoryBalance.findFirstOrThrow()).quantity.toString(),
    ).toBe("5");
  });
});
