import { randomUUID } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { Prisma } from "../../generated/prisma/client.ts";
import {
  createTestPrismaClient,
  resetTestDatabase,
} from "../../test/database-harness.ts";
import { loadTestDatabaseEnvironment } from "../../test/database-environment.ts";
import { createPrismaInventoryRepository } from "../inventory/inventory-repository.ts";
import { createPrismaReceivingRepository } from "../purchasing/receiving-repository.ts";
import { createPrismaCheckoutRepository } from "./checkout-repository.ts";
import {
  createPrismaRefundRepository,
  type CreateRefundInput,
} from "./refund-repository.ts";

const environment = loadTestDatabaseEnvironment();
const prisma = createTestPrismaClient(environment);
const COMPLETED_AT = new Date("2026-09-19T08:00:00.000Z");

type Role =
  "OWNER" | "ADMIN" | "BRANCH_MANAGER" | "INVENTORY_STAFF" | "CASHIER";

function transactionGate() {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { enter, entered, release, released };
}

async function remainsPending<T>(promise: Promise<T>): Promise<boolean> {
  return Promise.race([
    promise.then(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 75)),
  ]);
}

describe("sale refunds with PostgreSQL", () => {
  beforeEach(async () => resetTestDatabase(environment));
  afterAll(async () => {
    await resetTestDatabase(environment);
    await prisma.$disconnect();
  });

  async function actor(input: {
    branchId: string;
    organizationId: string;
    role: Role;
    assigned?: boolean;
  }) {
    const user = await prisma.user.create({
      data: {
        displayName: `${input.role} Actor`,
        email: `${randomUUID()}@example.test`,
        emailVerifiedAt: COMPLETED_AT,
        passwordHash: "refund-test",
      },
    });
    await prisma.organizationMembership.create({
      data: {
        organizationId: input.organizationId,
        role: input.role,
        userId: user.id,
      },
    });
    if (
      input.assigned !== false &&
      input.role !== "OWNER" &&
      input.role !== "ADMIN"
    ) {
      await prisma.branchAssignment.create({
        data: {
          branchId: input.branchId,
          organizationId: input.organizationId,
          userId: user.id,
        },
      });
    }
    return user;
  }

  async function fixture(
    input: {
      basisState?: "KNOWN" | "UNKNOWN";
      paymentMethod?: "CASH" | "TRANSFER";
      quantity?: string;
      saleQuantity?: string;
      salesVatStatus?: "NOT_REGISTERED" | "REGISTERED";
      unit?: "EA" | "KG";
      unitCost?: string;
      unitPrice?: string;
    } = {},
  ) {
    const organization = await prisma.organization.create({
      data: {
        name: "Refund Organization",
        salesVatRate: input.salesVatStatus === "REGISTERED" ? "7" : null,
        salesVatStatus: input.salesVatStatus ?? "NOT_REGISTERED",
      },
    });
    const branch = await prisma.branch.create({
      data: {
        code: `B-${randomUUID().slice(0, 8)}`,
        name: "Refund Branch",
        organizationId: organization.id,
      },
    });
    const cashier = await actor({
      branchId: branch.id,
      organizationId: organization.id,
      role: "CASHIER",
    });
    const owner = await actor({
      branchId: branch.id,
      organizationId: organization.id,
      role: "OWNER",
    });
    const product = await prisma.product.create({
      data: {
        basePrice: input.unitPrice ?? "50",
        name: "Refund Product",
        organizationId: organization.id,
        sku: `SKU-${randomUUID().slice(0, 8)}`.toUpperCase(),
        unit: input.unit ?? "EA",
      },
    });
    const stockQuantity = input.quantity ?? "10";
    const basisState = input.basisState ?? "KNOWN";
    const unitCost = input.unitCost ?? "30";
    await prisma.inventoryBalance.create({
      data: {
        branchId: branch.id,
        organizationId: organization.id,
        productId: product.id,
        quantity: stockQuantity,
      },
    });
    await prisma.inventoryCostState.create({
      data: {
        averageUnitCost: basisState === "KNOWN" ? unitCost : null,
        basisState,
        branchId: branch.id,
        inventoryValue:
          basisState === "KNOWN"
            ? new Prisma.Decimal(stockQuantity).times(unitCost).toFixed(10)
            : null,
        organizationId: organization.id,
        productId: product.id,
      },
    });
    const checkout = createPrismaCheckoutRepository(prisma, {
      now: () => COMPLETED_AT,
    });
    const sale = await checkout.checkout({
      actorUserId: cashier.id,
      branchId: branch.id,
      discount: null,
      idempotencyKey: randomUUID(),
      items: [
        {
          expectedUnitPrice: input.unitPrice ?? "50",
          productId: product.id,
          quantity: input.saleQuantity ?? "2",
        },
      ],
      organizationId: organization.id,
      payment:
        input.paymentMethod === "TRANSFER"
          ? { method: "TRANSFER", reference: "SALE-TX" }
          : { amountTendered: "1000", method: "CASH" },
    });
    if (sale.kind !== "success") {
      throw new Error(`Fixture checkout failed: ${sale.kind}`);
    }
    return { branch, cashier, organization, owner, product, sale: sale.sale };
  }

  function request(
    value: Awaited<ReturnType<typeof fixture>>,
    overrides: Partial<CreateRefundInput> = {},
  ): CreateRefundInput {
    return {
      actorUserId: value.owner.id,
      branchId: value.branch.id,
      idempotencyKey: randomUUID(),
      items: [
        {
          quantity: "2",
          restockQuantity: "2",
          saleItemId: value.sale.items[0]!.id,
        },
      ],
      organizationId: value.organization.id,
      reason: "Customer return",
      saleId: value.sale.id,
      transferReference: null,
      ...overrides,
    };
  }

  it("creates one full CASH refund, payment, return movement, balance, and known cost update", async () => {
    const value = await fixture();
    const repository = createPrismaRefundRepository(prisma, {
      now: () => new Date("2026-09-19T09:00:00.000Z"),
    });

    const outcome = await repository.createRefund(request(value));

    expect(outcome.kind).toBe("success");
    if (outcome.kind !== "success") return;
    expect(outcome.refund).toMatchObject({
      payment: { amount: "100.00", method: "CASH", reference: null },
      totalAmount: "100.00",
    });
    expect(outcome.refund.items[0]).toMatchObject({
      cogsReversalAmount: "60.0000000000",
      originalUnitCost: "30.000000",
      refundQuantity: "2",
      restockQuantity: "2",
    });
    const [balance, cost, movements] = await Promise.all([
      prisma.inventoryBalance.findUniqueOrThrow({
        where: {
          branchId_productId: {
            branchId: value.branch.id,
            productId: value.product.id,
          },
        },
      }),
      prisma.inventoryCostState.findUniqueOrThrow({
        where: {
          branchId_productId: {
            branchId: value.branch.id,
            productId: value.product.id,
          },
        },
      }),
      prisma.inventoryTransaction.findMany({
        where: { source: "SALE_REFUND_RETURN" },
      }),
    ]);
    expect(balance.quantity.toFixed(4)).toBe("10.0000");
    expect(cost).toMatchObject({ basisState: "KNOWN" });
    expect(cost.averageUnitCost?.toFixed(6)).toBe("30.000000");
    expect(cost.inventoryValue?.toFixed(10)).toBe("300.0000000000");
    expect(movements).toHaveLength(1);
    expect(movements[0]?.delta.toFixed(4)).toBe("2.0000");
    expect(movements[0]?.saleRefundItemId).toBe(outcome.refund.items[0]?.id);
  });

  it("supports sequential no-restock refunds, exact final rounding, replay, and changed-intent conflict", async () => {
    const value = await fixture({ saleQuantity: "3", unitPrice: "33.3333" });
    const repository = createPrismaRefundRepository(prisma);
    const key = randomUUID();
    const firstInput = request(value, {
      idempotencyKey: key,
      items: [
        {
          quantity: "1",
          restockQuantity: "0",
          saleItemId: value.sale.items[0]!.id,
        },
      ],
    });
    const first = await repository.createRefund(firstInput);
    const replay = await repository.createRefund(firstInput);
    const conflict = await repository.createRefund({
      ...firstInput,
      reason: "Changed intent",
    });
    const second = await repository.createRefund(
      request(value, {
        items: [
          {
            quantity: "1",
            restockQuantity: "0",
            saleItemId: value.sale.items[0]!.id,
          },
        ],
      }),
    );
    const third = await repository.createRefund(
      request(value, {
        items: [
          {
            quantity: "1",
            restockQuantity: "0",
            saleItemId: value.sale.items[0]!.id,
          },
        ],
      }),
    );

    expect(first.kind).toBe("success");
    expect(replay.kind).toBe("replay");
    expect(conflict.kind).toBe("idempotency_conflict");
    expect(
      [first, second, third].map((result) =>
        result.kind === "success" ? result.refund.totalAmount : result.kind,
      ),
    ).toEqual(["33.33", "33.34", "33.33"]);
    expect(await prisma.saleRefund.count()).toBe(3);
    expect(await prisma.refundPayment.count()).toBe(3);
    expect(
      await prisma.inventoryTransaction.count({
        where: { source: "SALE_REFUND_RETURN" },
      }),
    ).toBe(0);
    expect(await repository.createRefund(request(value))).toEqual({
      kind: "sale_already_fully_refunded",
    });
  });

  it("requires a matching TRANSFER reference and persists exactly one confirmed payment", async () => {
    const value = await fixture({ paymentMethod: "TRANSFER" });
    const repository = createPrismaRefundRepository(prisma);

    expect(await repository.createRefund(request(value))).toEqual({
      kind: "invalid_transfer_reference",
    });
    const completed = await repository.createRefund(
      request(value, { transferReference: "  RF-TRANSFER-001  " }),
    );

    expect(completed.kind).toBe("success");
    if (completed.kind !== "success") return;
    expect(completed.refund.payment).toEqual({
      amount: "100.00",
      method: "TRANSFER",
      reference: "RF-TRANSFER-001",
    });
    expect(await prisma.refundPayment.count()).toBe(1);
  });

  it.each([
    ["OWNER", true],
    ["ADMIN", true],
    ["BRANCH_MANAGER", true],
    ["CASHIER", false],
    ["INVENTORY_STAFF", false],
  ] as const)(
    "enforces %s refund creation authority",
    async (role, allowed) => {
      const value = await fixture();
      // The fixture already holds the organization's single OWNER (ADR-041).
      const refundActor =
        role === "OWNER"
          ? value.owner
          : await actor({
              branchId: value.branch.id,
              organizationId: value.organization.id,
              role,
            });
      const result = await createPrismaRefundRepository(prisma).createRefund(
        request(value, { actorUserId: refundActor.id }),
      );
      expect(result.kind).toBe(allowed ? "success" : "forbidden");
    },
  );

  it("serializes concurrent attempts so only one can consume the remaining quantity", async () => {
    const value = await fixture({ saleQuantity: "1" });
    const repository = createPrismaRefundRepository(prisma);
    const intent = {
      items: [
        {
          quantity: "1",
          restockQuantity: "1",
          saleItemId: value.sale.items[0]!.id,
        },
      ],
    };
    const results = await Promise.all([
      repository.createRefund(request(value, intent)),
      repository.createRefund(request(value, intent)),
    ]);

    expect(results.map((result) => result.kind).sort()).toEqual([
      "sale_already_fully_refunded",
      "success",
    ]);
    expect(await prisma.saleRefund.count()).toBe(1);
    expect(await prisma.refundPayment.count()).toBe(1);
    expect(
      await prisma.inventoryTransaction.count({
        where: { source: "SALE_REFUND_RETURN" },
      }),
    ).toBe(1);
  });

  it("rolls back header, item, payment, balance, cost, movement, and idempotency after failure", async () => {
    const value = await fixture();
    const originalBalance = await prisma.inventoryBalance.findUniqueOrThrow({
      where: {
        branchId_productId: {
          branchId: value.branch.id,
          productId: value.product.id,
        },
      },
    });
    const failing = createPrismaRefundRepository(prisma, {
      afterLineCommitted: () => {
        throw new Error("injected refund failure");
      },
    });
    const input = request(value, { idempotencyKey: "rollback-key" });

    await expect(failing.createRefund(input)).rejects.toThrow(
      "injected refund failure",
    );
    const successful =
      await createPrismaRefundRepository(prisma).createRefund(input);
    expect(successful.kind).toBe("success");
    expect(await prisma.saleRefund.count()).toBe(1);
    expect(await prisma.saleRefundItem.count()).toBe(1);
    expect(await prisma.refundPayment.count()).toBe(1);
    const finalBalance = await prisma.inventoryBalance.findUniqueOrThrow({
      where: {
        branchId_productId: {
          branchId: value.branch.id,
          productId: value.product.id,
        },
      },
    });
    expect(
      finalBalance.quantity.minus(originalBalance.quantity).toFixed(4),
    ).toBe("2.0000");
  });

  it("preserves UNKNOWN historical cost and downgrades mixed current KNOWN stock", async () => {
    const value = await fixture({ basisState: "UNKNOWN" });
    await prisma.inventoryCostState.update({
      data: {
        averageUnitCost: "25",
        basisState: "KNOWN",
        inventoryValue: "200",
      },
      where: {
        branchId_productId: {
          branchId: value.branch.id,
          productId: value.product.id,
        },
      },
    });
    const result = await createPrismaRefundRepository(prisma).createRefund(
      request(value, {
        items: [
          {
            quantity: "1",
            restockQuantity: "1",
            saleItemId: value.sale.items[0]!.id,
          },
        ],
      }),
    );

    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;
    expect(result.refund.items[0]).toMatchObject({
      cogsReversalAmount: null,
      originalCostBasisState: "UNKNOWN",
      originalUnitCost: null,
    });
    const cost = await prisma.inventoryCostState.findUniqueOrThrow({
      where: {
        branchId_productId: {
          branchId: value.branch.id,
          productId: value.product.id,
        },
      },
    });
    expect(cost).toMatchObject({
      averageUnitCost: null,
      basisState: "UNKNOWN",
      inventoryValue: null,
    });
  });

  it("initializes KNOWN cost when a known historical return enters zero UNKNOWN quantity", async () => {
    const value = await fixture({
      quantity: "1",
      saleQuantity: "1",
      unitCost: "30",
    });
    const before = await prisma.inventoryBalance.findUniqueOrThrow({
      where: {
        branchId_productId: {
          branchId: value.branch.id,
          productId: value.product.id,
        },
      },
    });
    expect(before.quantity.isZero()).toBe(true);
    await prisma.inventoryCostState.update({
      data: {
        averageUnitCost: null,
        basisState: "UNKNOWN",
        inventoryValue: null,
      },
      where: {
        branchId_productId: {
          branchId: value.branch.id,
          productId: value.product.id,
        },
      },
    });
    const result = await createPrismaRefundRepository(prisma).createRefund(
      request(value, {
        items: [
          {
            quantity: "1",
            restockQuantity: "1",
            saleItemId: value.sale.items[0]!.id,
          },
        ],
      }),
    );
    expect(result.kind).toBe("success");
    const cost = await prisma.inventoryCostState.findUniqueOrThrow({
      where: {
        branchId_productId: {
          branchId: value.branch.id,
          productId: value.product.id,
        },
      },
    });
    expect(cost.basisState).toBe("KNOWN");
    expect(cost.averageUnitCost?.toFixed(6)).toBe("30.000000");
    expect(cost.inventoryValue?.toFixed(10)).toBe("30.0000000000");
  });

  it("supports partial multi-item and fractional KG refunds with independent restock quantities", async () => {
    const value = await fixture({ quantity: "20", saleQuantity: "2" });
    const weighed = await prisma.product.create({
      data: {
        basePrice: "12.3456",
        name: "Weighed Product",
        organizationId: value.organization.id,
        sku: `SKU-${randomUUID().slice(0, 8)}`.toUpperCase(),
        unit: "KG",
      },
    });
    await prisma.inventoryBalance.create({
      data: {
        branchId: value.branch.id,
        organizationId: value.organization.id,
        productId: weighed.id,
        quantity: "5",
      },
    });
    await prisma.inventoryCostState.create({
      data: {
        averageUnitCost: "8",
        basisState: "KNOWN",
        branchId: value.branch.id,
        inventoryValue: "40",
        organizationId: value.organization.id,
        productId: weighed.id,
      },
    });
    const sale = await createPrismaCheckoutRepository(prisma, {
      now: () => COMPLETED_AT,
    }).checkout({
      actorUserId: value.cashier.id,
      branchId: value.branch.id,
      discount: null,
      idempotencyKey: randomUUID(),
      items: [
        {
          expectedUnitPrice: "50",
          productId: value.product.id,
          quantity: "2",
        },
        {
          expectedUnitPrice: "12.3456",
          productId: weighed.id,
          quantity: "1.25",
        },
      ],
      organizationId: value.organization.id,
      payment: { amountTendered: "200", method: "CASH" },
    });
    if (sale.kind !== "success")
      throw new Error(`Checkout failed: ${sale.kind}`);
    const eachItem = sale.sale.items.find(
      (item) => item.productId === value.product.id,
    );
    const kgItem = sale.sale.items.find(
      (item) => item.productId === weighed.id,
    );
    if (eachItem === undefined || kgItem === undefined) {
      throw new Error("Mixed checkout did not return both sale items.");
    }

    const outcome = await createPrismaRefundRepository(prisma).createRefund({
      actorUserId: value.owner.id,
      branchId: value.branch.id,
      idempotencyKey: randomUUID(),
      items: [
        {
          quantity: "1",
          restockQuantity: "0",
          saleItemId: eachItem.id,
        },
        {
          quantity: "0.5",
          restockQuantity: "0.25",
          saleItemId: kgItem.id,
        },
      ],
      organizationId: value.organization.id,
      reason: "Partial mixed return",
      saleId: sale.sale.id,
      transferReference: null,
    });

    expect(outcome.kind).toBe("success");
    if (outcome.kind !== "success") return;
    expect(outcome.refund.items).toHaveLength(2);
    expect(outcome.refund.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          refundQuantity: "1",
          restockQuantity: "0",
          saleItemId: eachItem.id,
        }),
        expect.objectContaining({
          cogsReversalAmount: "2.0000000000",
          refundQuantity: "0.5",
          restockQuantity: "0.25",
          saleItemId: kgItem.id,
        }),
      ]),
    );
    const movements = await prisma.inventoryTransaction.findMany({
      where: { source: "SALE_REFUND_RETURN" },
    });
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({ productId: weighed.id });
    expect(movements[0]!.delta.toFixed(4)).toBe("0.2500");
  });

  it("rejects malformed, duplicate, excessive, and over-restock refund intents without writes", async () => {
    const value = await fixture();
    const repository = createPrismaRefundRepository(prisma);
    const lineId = value.sale.items[0]!.id;
    const cases: Array<[string, CreateRefundInput["items"], string]> = [
      [
        "zero",
        [{ quantity: "0", restockQuantity: "0", saleItemId: lineId }],
        "invalid_quantity",
      ],
      [
        "negative",
        [{ quantity: "-1", restockQuantity: "0", saleItemId: lineId }],
        "invalid_quantity",
      ],
      [
        "scale",
        [{ quantity: "1.00001", restockQuantity: "0", saleItemId: lineId }],
        "invalid_quantity",
      ],
      [
        "restock",
        [{ quantity: "1", restockQuantity: "1.0001", saleItemId: lineId }],
        "invalid_restock",
      ],
      [
        "over-restock",
        [{ quantity: "1", restockQuantity: "2", saleItemId: lineId }],
        "invalid_restock",
      ],
      [
        "duplicate",
        [
          { quantity: "1", restockQuantity: "0", saleItemId: lineId },
          { quantity: "1", restockQuantity: "0", saleItemId: lineId },
        ],
        "duplicate_item",
      ],
      ["empty", [], "invalid_quantity"],
    ];
    for (const [key, items, expected] of cases) {
      const result = await repository.createRefund(
        request(value, { idempotencyKey: `invalid-${key}`, items }),
      );
      expect(result.kind).toBe(expected);
    }
    expect(await prisma.saleRefund.count()).toBe(0);
    expect(await prisma.refundPayment.count()).toBe(0);
  });

  it("allows historical inactive products but rejects inactive branches", async () => {
    const productValue = await fixture();
    await prisma.product.update({
      data: { status: "INACTIVE" },
      where: { id: productValue.product.id },
    });
    expect(
      (
        await createPrismaRefundRepository(prisma).createRefund(
          request(productValue),
        )
      ).kind,
    ).toBe("success");

    const branchValue = await fixture();
    await prisma.branch.create({
      data: {
        code: `B-${randomUUID().slice(0, 8)}`,
        name: "Remaining Active Branch",
        organizationId: branchValue.organization.id,
      },
    });
    await prisma.branch.update({
      data: { deactivatedAt: COMPLETED_AT, status: "INACTIVE" },
      where: { id: branchValue.branch.id },
    });
    expect(
      (
        await createPrismaRefundRepository(prisma).createRefund(
          request(branchValue),
        )
      ).kind,
    ).toBe("branch_inactive");
  });

  it("denies unassigned managers and cross-organization or cross-branch refund scope", async () => {
    const value = await fixture();
    const unassigned = await actor({
      assigned: false,
      branchId: value.branch.id,
      organizationId: value.organization.id,
      role: "BRANCH_MANAGER",
    });
    const other = await fixture();
    const repository = createPrismaRefundRepository(prisma);

    expect(
      (
        await repository.createRefund(
          request(value, { actorUserId: unassigned.id }),
        )
      ).kind,
    ).toBe("forbidden");
    expect(
      (
        await repository.createRefund(
          request(value, {
            actorUserId: other.owner.id,
            branchId: other.branch.id,
            organizationId: other.organization.id,
          }),
        )
      ).kind,
    ).toBe("not_found");
    expect(
      (
        await repository.createRefund(
          request(value, {
            actorUserId: other.owner.id,
            branchId: value.branch.id,
            organizationId: other.organization.id,
          }),
        )
      ).kind,
    ).toBe("forbidden");
  });

  it("uses immutable sale price, VAT, and cost snapshots after current catalog and organization changes", async () => {
    const value = await fixture({ unitCost: "30", unitPrice: "50" });
    await prisma.product.update({
      data: { basePrice: "999.9999", name: "Renamed current product" },
      where: { id: value.product.id },
    });
    await prisma.organization.update({
      data: { salesVatRate: "7", salesVatStatus: "REGISTERED" },
      where: { id: value.organization.id },
    });

    const outcome = await createPrismaRefundRepository(prisma).createRefund(
      request(value, {
        items: [
          {
            quantity: "1",
            restockQuantity: "1",
            saleItemId: value.sale.items[0]!.id,
          },
        ],
      }),
    );
    expect(outcome.kind).toBe("success");
    if (outcome.kind !== "success") return;
    expect(outcome.refund).toMatchObject({
      outputVatAmount: "0.00",
      salesVatRate: null,
      salesVatStatus: "NOT_REGISTERED",
      totalAmount: "50.00",
    });
    expect(outcome.refund.items[0]).toMatchObject({
      cogsReversalAmount: "30.0000000000",
      originalUnitCost: "30.000000",
    });
  });

  it("weights a known historical return into a different current KNOWN average", async () => {
    const value = await fixture({
      quantity: "10",
      saleQuantity: "2",
      unitCost: "30",
    });
    await prisma.inventoryCostState.update({
      data: {
        averageUnitCost: "10",
        basisState: "KNOWN",
        inventoryValue: "80",
      },
      where: {
        branchId_productId: {
          branchId: value.branch.id,
          productId: value.product.id,
        },
      },
    });

    const result = await createPrismaRefundRepository(prisma).createRefund(
      request(value),
    );
    expect(result.kind).toBe("success");
    const cost = await prisma.inventoryCostState.findUniqueOrThrow({
      where: {
        branchId_productId: {
          branchId: value.branch.id,
          productId: value.product.id,
        },
      },
    });
    expect(cost.basisState).toBe("KNOWN");
    expect(cost.averageUnitCost?.toFixed(6)).toBe("14.000000");
    expect(cost.inventoryValue?.toFixed(10)).toBe("140.0000000000");
  });

  it("keeps current UNKNOWN cost UNKNOWN when a known return mixes into positive stock", async () => {
    const value = await fixture({
      quantity: "10",
      saleQuantity: "2",
      unitCost: "30",
    });
    await prisma.inventoryCostState.update({
      data: {
        averageUnitCost: null,
        basisState: "UNKNOWN",
        inventoryValue: null,
      },
      where: {
        branchId_productId: {
          branchId: value.branch.id,
          productId: value.product.id,
        },
      },
    });
    expect(
      (await createPrismaRefundRepository(prisma).createRefund(request(value)))
        .kind,
    ).toBe("success");
    expect(
      await prisma.inventoryCostState.findUniqueOrThrow({
        where: {
          branchId_productId: {
            branchId: value.branch.id,
            productId: value.product.id,
          },
        },
      }),
    ).toMatchObject({
      averageUnitCost: null,
      basisState: "UNKNOWN",
      inventoryValue: null,
    });
  });

  it("serializes concurrent identical retries into one success and one replay", async () => {
    const value = await fixture({ saleQuantity: "1" });
    const input = request(value, {
      idempotencyKey: "concurrent-replay",
      items: [
        {
          quantity: "1",
          restockQuantity: "1",
          saleItemId: value.sale.items[0]!.id,
        },
      ],
    });
    const repository = createPrismaRefundRepository(prisma);
    const outcomes = await Promise.all([
      repository.createRefund(input),
      repository.createRefund(input),
    ]);
    expect(outcomes.map(({ kind }) => kind).sort()).toEqual([
      "replay",
      "success",
    ]);
    expect(await prisma.saleRefund.count()).toBe(1);
    expect(await prisma.saleRefundItem.count()).toBe(1);
    expect(await prisma.refundPayment.count()).toBe(1);
  });

  it.each([
    "refund_created",
    "refund_item_created",
    "inventory_balance_updated",
    "inventory_cost_updated",
    "inventory_ledger_created",
    "payment_created",
  ] as const)(
    "rolls back every persisted effect when failure is injected after %s",
    async (stage) => {
      const value = await fixture();
      const before = await prisma.inventoryBalance.findUniqueOrThrow({
        where: {
          branchId_productId: {
            branchId: value.branch.id,
            productId: value.product.id,
          },
        },
      });
      const input = request(value, { idempotencyKey: `failure-${stage}` });
      await expect(
        createPrismaRefundRepository(prisma, {
          afterStage: (current) => {
            if (current === stage) throw new Error(`failure-${stage}`);
          },
        }).createRefund(input),
      ).rejects.toThrow(`failure-${stage}`);
      expect(await prisma.saleRefund.count()).toBe(0);
      expect(await prisma.saleRefundItem.count()).toBe(0);
      expect(await prisma.refundPayment.count()).toBe(0);
      expect(
        await prisma.inventoryTransaction.count({
          where: { source: "SALE_REFUND_RETURN" },
        }),
      ).toBe(0);
      const after = await prisma.inventoryBalance.findUniqueOrThrow({
        where: {
          branchId_productId: {
            branchId: value.branch.id,
            productId: value.product.id,
          },
        },
      });
      expect(after.quantity.toFixed(4)).toBe(before.quantity.toFixed(4));
      expect(
        (await createPrismaRefundRepository(prisma).createRefund(input)).kind,
      ).toBe("success");
    },
  );

  it("serializes a refund return with a manual adjustment on the shared balance lock", async () => {
    const value = await fixture({ quantity: "10", saleQuantity: "2" });
    const gate = transactionGate();
    const refundPromise = createPrismaRefundRepository(prisma, {
      afterProductLocksAcquired: async () => {
        gate.enter();
        await gate.released;
      },
    }).createRefund(
      request(value, {
        items: [
          {
            quantity: "1",
            restockQuantity: "1",
            saleItemId: value.sale.items[0]!.id,
          },
        ],
      }),
    );
    await gate.entered;
    const adjustmentPromise = createPrismaInventoryRepository(prisma).adjust({
      actorUserId: value.owner.id,
      adjustment: {
        delta: "2",
        note: null,
        productId: value.product.id,
        reason: "FOUND",
      },
      branchId: value.branch.id,
      idempotencyKey: "refund-adjustment-race",
      organizationId: value.organization.id,
    });
    expect(await remainsPending(adjustmentPromise)).toBe(true);
    gate.release();
    const [refundResult, adjustmentResult] = await Promise.all([
      refundPromise,
      adjustmentPromise,
    ]);
    expect(refundResult.kind).toBe("success");
    expect(adjustmentResult.kind).toBe("success");
    const balance = await prisma.inventoryBalance.findUniqueOrThrow({
      where: {
        branchId_productId: {
          branchId: value.branch.id,
          productId: value.product.id,
        },
      },
    });
    expect(balance.quantity.toFixed(4)).toBe("11.0000");
  });

  it("serializes a refund return with checkout on the shared balance lock", async () => {
    const value = await fixture({ quantity: "10", saleQuantity: "2" });
    const gate = transactionGate();
    const refundPromise = createPrismaRefundRepository(prisma, {
      afterProductLocksAcquired: async () => {
        gate.enter();
        await gate.released;
      },
    }).createRefund(
      request(value, {
        items: [
          {
            quantity: "1",
            restockQuantity: "1",
            saleItemId: value.sale.items[0]!.id,
          },
        ],
      }),
    );
    await gate.entered;
    const checkoutPromise = createPrismaCheckoutRepository(prisma).checkout({
      actorUserId: value.cashier.id,
      branchId: value.branch.id,
      discount: null,
      idempotencyKey: "refund-checkout-race",
      items: [
        {
          expectedUnitPrice: "50",
          productId: value.product.id,
          quantity: "1",
        },
      ],
      organizationId: value.organization.id,
      payment: { amountTendered: "100", method: "CASH" },
    });
    expect(await remainsPending(checkoutPromise)).toBe(true);
    gate.release();
    const [refundResult, checkoutResult] = await Promise.all([
      refundPromise,
      checkoutPromise,
    ]);
    expect(refundResult.kind).toBe("success");
    expect(checkoutResult.kind).toBe("success");
    const balance = await prisma.inventoryBalance.findUniqueOrThrow({
      where: {
        branchId_productId: {
          branchId: value.branch.id,
          productId: value.product.id,
        },
      },
    });
    expect(balance.quantity.toFixed(4)).toBe("8.0000");
  });

  it("serializes a refund return with receiving on the shared balance lock", async () => {
    const value = await fixture({ quantity: "10", saleQuantity: "2" });
    const membership = await prisma.organizationMembership.findUniqueOrThrow({
      where: {
        organizationId_userId: {
          organizationId: value.organization.id,
          userId: value.owner.id,
        },
      },
    });
    const supplier = await prisma.supplier.create({
      data: {
        name: "Refund race supplier",
        organizationId: value.organization.id,
      },
    });
    const order = await prisma.purchaseOrder.create({
      data: {
        branchId: value.branch.id,
        createdByMembershipId: membership.id,
        createdByUserId: value.owner.id,
        expectedTotal: "40",
        items: {
          create: {
            expectedUnitCost: "20",
            productId: value.product.id,
            productNameSnapshot: value.product.name,
            productSkuSnapshot: value.product.sku,
            quantity: "2",
          },
        },
        orderDate: new Date("2026-09-19T00:00:00.000Z"),
        orderedAt: COMPLETED_AT,
        organizationId: value.organization.id,
        reference: `PO-${randomUUID()}`,
        status: "ORDERED",
        supplierId: supplier.id,
      },
      include: { items: true },
    });
    const gate = transactionGate();
    const refundPromise = createPrismaRefundRepository(prisma, {
      afterProductLocksAcquired: async () => {
        gate.enter();
        await gate.released;
      },
    }).createRefund(
      request(value, {
        items: [
          {
            quantity: "1",
            restockQuantity: "1",
            saleItemId: value.sale.items[0]!.id,
          },
        ],
      }),
    );
    await gate.entered;
    const receivingPromise = createPrismaReceivingRepository(
      prisma,
    ).receivePurchaseOrder({
      actorUserId: value.owner.id,
      actualCosts: [
        { actualUnitCost: "20", purchaseOrderItemId: order.items[0]!.id },
      ],
      idempotencyKey: "refund-receiving-race",
      organizationId: value.organization.id,
      purchaseOrderId: order.id,
      vat: {
        inputVatAmount: null,
        inputVatRate: null,
        organizationVatRegistered: false,
        supplierTaxDocumentDate: null,
        supplierTaxDocumentNumber: null,
      },
    });
    expect(await remainsPending(receivingPromise)).toBe(true);
    gate.release();
    const [refundResult, receivingResult] = await Promise.all([
      refundPromise,
      receivingPromise,
    ]);
    expect(refundResult.kind).toBe("success");
    expect(receivingResult.kind).toBe("success");
    const balance = await prisma.inventoryBalance.findUniqueOrThrow({
      where: {
        branchId_productId: {
          branchId: value.branch.id,
          productId: value.product.id,
        },
      },
    });
    expect(balance.quantity.toFixed(4)).toBe("11.0000");
  });

  it("avoids deadlocks for overlapping multi-product refunds submitted in opposing item order", async () => {
    const value = await fixture({ quantity: "20", saleQuantity: "1" });
    const secondProduct = await prisma.product.create({
      data: {
        basePrice: "40",
        name: "Second overlap product",
        organizationId: value.organization.id,
        sku: `SKU-${randomUUID().slice(0, 8)}`.toUpperCase(),
        unit: "EA",
      },
    });
    await prisma.inventoryBalance.create({
      data: {
        branchId: value.branch.id,
        organizationId: value.organization.id,
        productId: secondProduct.id,
        quantity: "20",
      },
    });
    await prisma.inventoryCostState.create({
      data: {
        averageUnitCost: "20",
        basisState: "KNOWN",
        branchId: value.branch.id,
        inventoryValue: "400",
        organizationId: value.organization.id,
        productId: secondProduct.id,
      },
    });
    const checkout = createPrismaCheckoutRepository(prisma);
    const sales = [];
    for (const key of ["overlap-sale-a", "overlap-sale-b"]) {
      const result = await checkout.checkout({
        actorUserId: value.cashier.id,
        branchId: value.branch.id,
        discount: null,
        idempotencyKey: key,
        items: [
          {
            expectedUnitPrice: "50",
            productId: value.product.id,
            quantity: "1",
          },
          {
            expectedUnitPrice: "40",
            productId: secondProduct.id,
            quantity: "1",
          },
        ],
        organizationId: value.organization.id,
        payment: { amountTendered: "100", method: "CASH" },
      });
      if (result.kind !== "success")
        throw new Error(`Checkout failed: ${result.kind}`);
      sales.push(result.sale);
    }
    const inputs = sales.map((sale, index) => ({
      actorUserId: value.owner.id,
      branchId: value.branch.id,
      idempotencyKey: `overlap-refund-${index}`,
      items: [...sale.items].reverse().map((item) => ({
        quantity: "1",
        restockQuantity: "1",
        saleItemId: item.id,
      })),
      organizationId: value.organization.id,
      reason: "Overlapping return",
      saleId: sale.id,
      transferReference: null,
    }));
    inputs[1]!.items.reverse();
    const repository = createPrismaRefundRepository(prisma);
    const results = await Promise.all(
      inputs.map((input) => repository.createRefund(input)),
    );
    expect(results.map(({ kind }) => kind)).toEqual(["success", "success"]);
    expect(await prisma.saleRefund.count()).toBe(2);
    expect(
      await prisma.inventoryTransaction.count({
        where: { source: "SALE_REFUND_RETURN" },
      }),
    ).toBe(4);
  });
});
