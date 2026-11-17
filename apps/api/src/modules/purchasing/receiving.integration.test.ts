import { randomUUID } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  createTestPrismaClient,
  resetTestDatabase,
} from "../../test/database-harness.ts";
import { loadTestDatabaseEnvironment } from "../../test/database-environment.ts";
import { createPrismaInventoryRepository } from "../inventory/inventory-repository.ts";
import { createPrismaPurchaseOrderRepository } from "./purchase-order-repository.ts";
import { purchaseOrderUpdateRequestSchema } from "./purchase-order-schemas.ts";
import {
  createPrismaReceivingRepository,
  type ReceivePurchaseOrderInput,
} from "./receiving-repository.ts";

const environment = loadTestDatabaseEnvironment();
const prisma = createTestPrismaClient(environment);
const receiving = createPrismaReceivingRepository(prisma, {
  now: () => new Date("2026-09-02T10:00:00.000Z"),
});
const noVat = {
  inputVatAmount: null,
  inputVatRate: null,
  organizationVatRegistered: false,
  supplierTaxDocumentDate: null,
  supplierTaxDocumentNumber: null,
} as const;

async function actor(input: {
  assigned?: boolean;
  branchId: string;
  organizationId: string;
  role?: "OWNER" | "INVENTORY_STAFF" | "CASHIER";
}) {
  const user = await prisma.user.create({
    data: {
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
    (input.role === "INVENTORY_STAFF" || input.role === "CASHIER")
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

async function scope(label: string) {
  const organization = await prisma.organization.create({
    data: { name: label },
  });
  const branch = await prisma.branch.create({
    data: {
      code: `BR-${randomUUID().slice(0, 8)}`,
      name: `${label} Branch`,
      organizationId: organization.id,
    },
  });
  const supplier = await prisma.supplier.create({
    data: { name: `${label} Supplier`, organizationId: organization.id },
  });
  const products = await Promise.all(
    ["First", "Second"].map((name) =>
      prisma.product.create({
        data: {
          basePrice: "10",
          name: `${label} ${name}`,
          organizationId: organization.id,
          sku: `${randomUUID().slice(0, 8)}-${name}`.toUpperCase(),
          unit: "EA",
        },
      }),
    ),
  );
  const owner = await actor({
    branchId: branch.id,
    organizationId: organization.id,
  });
  return { branch, organization, owner, products, supplier };
}

async function orderedPurchaseOrder(input: {
  branchId: string;
  creator: Awaited<ReturnType<typeof actor>>;
  organizationId: string;
  products: readonly { id: string; name: string; sku: string }[];
  quantities?: readonly string[];
  supplierId: string;
}) {
  return prisma.purchaseOrder.create({
    data: {
      branchId: input.branchId,
      createdByMembershipId: input.creator.membership.id,
      createdByUserId: input.creator.user.id,
      expectedTotal: "100",
      items: {
        create: input.products.map((product, index) => ({
          expectedUnitCost: `${index + 1}`,
          productId: product.id,
          productNameSnapshot: product.name,
          productSkuSnapshot: product.sku,
          quantity: input.quantities?.[index] ?? `${index + 2}`,
        })),
      },
      orderDate: new Date("2026-09-02T00:00:00.000Z"),
      orderedAt: new Date("2026-09-02T09:00:00.000Z"),
      organizationId: input.organizationId,
      reference: `PO-${randomUUID()}`,
      status: "ORDERED",
      supplierId: input.supplierId,
    },
    include: { items: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] } },
  });
}

function request(input: {
  actorUserId: string;
  costs?: readonly string[];
  key?: string;
  order: Awaited<ReturnType<typeof orderedPurchaseOrder>>;
  organizationId: string;
}): ReceivePurchaseOrderInput {
  return {
    actorUserId: input.actorUserId,
    actualCosts: input.order.items.map((item, index) => ({
      actualUnitCost: input.costs?.[index] ?? `${index + 5}.2500`,
      purchaseOrderItemId: item.id,
    })),
    idempotencyKey: input.key ?? `receive-${randomUUID()}`,
    organizationId: input.organizationId,
    purchaseOrderId: input.order.id,
    vat: noVat,
  };
}

describe("receiving repository with PostgreSQL", () => {
  beforeEach(async () => resetTestDatabase(environment));
  afterAll(async () => {
    await resetTestDatabase(environment);
    await prisma.$disconnect();
  });

  it("atomically receives frozen PO lines, ledger, balances, cost state, VAT, and PO status", async () => {
    const value = await scope("Receive success");
    const order = await orderedPurchaseOrder({
      branchId: value.branch.id,
      creator: value.owner,
      organizationId: value.organization.id,
      products: value.products,
      quantities: ["2", "4"],
      supplierId: value.supplier.id,
    });
    await prisma.inventoryBalance.createMany({
      data: [
        {
          branchId: value.branch.id,
          organizationId: value.organization.id,
          productId: value.products[0]!.id,
          quantity: "10",
        },
        {
          branchId: value.branch.id,
          organizationId: value.organization.id,
          productId: value.products[1]!.id,
          quantity: "3",
        },
      ],
    });
    await prisma.inventoryCostState.createMany({
      data: [
        {
          averageUnitCost: "2",
          basisState: "KNOWN",
          branchId: value.branch.id,
          inventoryValue: "20",
          organizationId: value.organization.id,
          productId: value.products[0]!.id,
        },
        {
          basisState: "UNKNOWN",
          branchId: value.branch.id,
          organizationId: value.organization.id,
          productId: value.products[1]!.id,
        },
      ],
    });
    await prisma.supplier.update({
      data: { status: "INACTIVE" },
      where: { id: value.supplier.id },
    });

    const baseRequest = request({
      actorUserId: value.owner.user.id,
      order,
      organizationId: value.organization.id,
    });
    const result = await receiving.receivePurchaseOrder({
      ...baseRequest,
      actualCosts: order.items.map((item) => ({
        actualUnitCost: item.productId === value.products[0]!.id ? "5" : "7",
        purchaseOrderItemId: item.id,
      })),
      vat: {
        inputVatAmount: "3.5000",
        inputVatRate: "7.000000",
        organizationVatRegistered: true,
        supplierTaxDocumentDate: "2026-09-02",
        supplierTaxDocumentNumber: " TAX-100 ",
      },
    });

    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;
    expect(result.receipt).toMatchObject({
      branchId: value.branch.id,
      inputVatAmount: "3.5000",
      inputVatRate: "7.000000",
      organizationVatRegisteredSnapshot: true,
      purchaseOrderId: order.id,
      supplierTaxDocumentNumber: "TAX-100",
    });
    expect(
      result.receipt.items
        .map((item) => item.receivedQuantity)
        .sort((left, right) => left.localeCompare(right)),
    ).toEqual(["2", "4"]);
    expect(
      await prisma.purchaseOrder.findUnique({ where: { id: order.id } }),
    ).toMatchObject({
      receivedAt: new Date("2026-09-02T10:00:00.000Z"),
      status: "RECEIVED",
    });
    const balances = await prisma.inventoryBalance.findMany({
      orderBy: { productId: "asc" },
      where: { branchId: value.branch.id },
    });
    expect(
      new Map(balances.map((row) => [row.productId, row.quantity.toFixed(4)])),
    ).toEqual(
      new Map([
        [value.products[0]!.id, "12.0000"],
        [value.products[1]!.id, "7.0000"],
      ]),
    );
    const costs = await prisma.inventoryCostState.findMany({
      where: { branchId: value.branch.id },
    });
    const costByProduct = new Map(costs.map((row) => [row.productId, row]));
    expect(
      costByProduct.get(value.products[0]!.id)?.inventoryValue?.toFixed(10),
    ).toBe("30.0000000000");
    expect(
      costByProduct.get(value.products[0]!.id)?.averageUnitCost?.toFixed(6),
    ).toBe("2.500000");
    expect(
      costByProduct.get(value.products[1]!.id)?.inventoryValue?.toFixed(10),
    ).toBe("49.0000000000");
    expect(
      costByProduct.get(value.products[1]!.id)?.averageUnitCost?.toFixed(6),
    ).toBe("7.000000");
    const movements = await prisma.inventoryTransaction.findMany({
      where: { organizationId: value.organization.id },
    });
    expect(movements).toHaveLength(2);
    expect(
      movements.every(
        (row) => row.source === "PURCHASE_RECEIVE" && row.delta.isPositive(),
      ),
    ).toBe(true);
  });

  it("uses retained average rather than a drifted value accumulator for known-basis receiving", async () => {
    const value = await scope("Receive rounded cost residual");
    const order = await orderedPurchaseOrder({
      branchId: value.branch.id,
      creator: value.owner,
      organizationId: value.organization.id,
      products: value.products.slice(0, 1),
      quantities: ["1"],
      supplierId: value.supplier.id,
    });
    await prisma.inventoryBalance.create({
      data: {
        branchId: value.branch.id,
        organizationId: value.organization.id,
        productId: value.products[0]!.id,
        quantity: "199",
      },
    });
    await prisma.inventoryCostState.create({
      data: {
        averageUnitCost: "0.000001",
        basisState: "KNOWN",
        branchId: value.branch.id,
        inventoryValue: "0.0001",
        organizationId: value.organization.id,
        productId: value.products[0]!.id,
      },
    });

    expect(
      await receiving.receivePurchaseOrder({
        ...request({
          actorUserId: value.owner.user.id,
          costs: ["0"],
          order,
          organizationId: value.organization.id,
        }),
      }),
    ).toMatchObject({ kind: "success" });

    const [balance, cost] = await Promise.all([
      prisma.inventoryBalance.findUniqueOrThrow({
        where: {
          branchId_productId: {
            branchId: value.branch.id,
            productId: value.products[0]!.id,
          },
        },
      }),
      prisma.inventoryCostState.findUniqueOrThrow({
        where: {
          branchId_productId: {
            branchId: value.branch.id,
            productId: value.products[0]!.id,
          },
        },
      }),
    ]);
    expect(balance.quantity.toFixed(4)).toBe("200.0000");
    expect(cost.averageUnitCost?.toFixed(6)).toBe("0.000001");
    expect(cost.inventoryValue?.toFixed(10)).toBe("0.0001990000");
  });

  it("replays an identical receipt and rejects reuse with a different canonical payload", async () => {
    const value = await scope("Receive replay");
    const order = await orderedPurchaseOrder({
      branchId: value.branch.id,
      creator: value.owner,
      organizationId: value.organization.id,
      products: value.products,
      supplierId: value.supplier.id,
    });
    const input = request({
      actorUserId: value.owner.user.id,
      key: "stable-receipt-key",
      order,
      organizationId: value.organization.id,
    });
    const first = await receiving.receivePurchaseOrder(input);
    const replay = await receiving.receivePurchaseOrder({
      ...input,
      actualCosts: [...input.actualCosts].reverse(),
    });
    const conflict = await receiving.receivePurchaseOrder({
      ...input,
      actualCosts: input.actualCosts.map((line, index) =>
        index === 0 ? { ...line, actualUnitCost: "99" } : line,
      ),
    });

    expect(first.kind).toBe("success");
    expect(replay.kind).toBe("replay");
    expect(conflict).toEqual({ kind: "idempotency_conflict" });
    expect(await prisma.purchaseReceipt.count()).toBe(1);
    expect(await prisma.inventoryTransaction.count()).toBe(2);

    const other = await scope("Receive replay other tenant");
    const otherOrder = await orderedPurchaseOrder({
      branchId: other.branch.id,
      creator: other.owner,
      organizationId: other.organization.id,
      products: other.products,
      supplierId: other.supplier.id,
    });
    expect(
      await receiving.receivePurchaseOrder(
        request({
          actorUserId: other.owner.user.id,
          key: "stable-receipt-key",
          order: otherOrder,
          organizationId: other.organization.id,
        }),
      ),
    ).toMatchObject({ kind: "success" });
  });

  it("rejects missing, duplicate, or excess-scale actual costs before mutation", async () => {
    const value = await scope("Receive invalid costs");
    const order = await orderedPurchaseOrder({
      branchId: value.branch.id,
      creator: value.owner,
      organizationId: value.organization.id,
      products: value.products,
      supplierId: value.supplier.id,
    });
    const base = request({
      actorUserId: value.owner.user.id,
      order,
      organizationId: value.organization.id,
    });
    expect(
      await receiving.receivePurchaseOrder({
        ...base,
        actualCosts: base.actualCosts.slice(0, 1),
      }),
    ).toEqual({ kind: "invalid_costs" });
    expect(
      await receiving.receivePurchaseOrder({
        ...base,
        actualCosts: base.actualCosts.map((line, index) =>
          index === 0 ? { ...line, purchaseOrderItemId: randomUUID() } : line,
        ),
      }),
    ).toEqual({ kind: "invalid_costs" });
    expect(
      await receiving.receivePurchaseOrder({
        ...base,
        actualCosts: [base.actualCosts[0]!, base.actualCosts[0]!],
      }),
    ).toEqual({ kind: "invalid_costs" });
    expect(
      await receiving.receivePurchaseOrder({
        ...base,
        actualCosts: base.actualCosts.map((line, index) =>
          index === 0 ? { ...line, actualUnitCost: "1.23456" } : line,
        ),
      }),
    ).toEqual({ kind: "invalid_costs" });
    expect(await prisma.purchaseReceipt.count()).toBe(0);
    expect(await prisma.inventoryBalance.count()).toBe(0);
  });

  it("enforces trusted branch authorization and active Branch/Product state", async () => {
    const value = await scope("Receive authorization");
    const cashier = await actor({
      branchId: value.branch.id,
      organizationId: value.organization.id,
      role: "CASHIER",
    });
    const unassignedStaff = await actor({
      assigned: false,
      branchId: value.branch.id,
      organizationId: value.organization.id,
      role: "INVENTORY_STAFF",
    });
    const order = await orderedPurchaseOrder({
      branchId: value.branch.id,
      creator: value.owner,
      organizationId: value.organization.id,
      products: value.products,
      supplierId: value.supplier.id,
    });
    expect(
      await receiving.receivePurchaseOrder(
        request({
          actorUserId: cashier.user.id,
          order,
          organizationId: value.organization.id,
        }),
      ),
    ).toEqual({ kind: "forbidden" });
    expect(
      await receiving.receivePurchaseOrder(
        request({
          actorUserId: unassignedStaff.user.id,
          order,
          organizationId: value.organization.id,
        }),
      ),
    ).toEqual({ kind: "forbidden" });
    await prisma.product.update({
      data: { status: "INACTIVE" },
      where: { id: value.products[0]!.id },
    });
    expect(
      await receiving.receivePurchaseOrder(
        request({
          actorUserId: value.owner.user.id,
          order,
          organizationId: value.organization.id,
        }),
      ),
    ).toEqual({ kind: "product_inactive" });
    await prisma.product.update({
      data: { status: "ACTIVE" },
      where: { id: value.products[0]!.id },
    });
    await prisma.branch.update({
      data: { deactivatedAt: new Date(), status: "INACTIVE" },
      where: { id: value.branch.id },
    });
    expect(
      await receiving.receivePurchaseOrder(
        request({
          actorUserId: value.owner.user.id,
          order,
          organizationId: value.organization.id,
        }),
      ),
    ).toEqual({ kind: "branch_inactive" });
    expect(await prisma.purchaseReceipt.count()).toBe(0);
  });

  it("rejects DRAFT, CANCELLED, RECEIVED, fractional integral-unit, and cross-tenant intents", async () => {
    const value = await scope("Receive invalid lifecycle");
    const order = await orderedPurchaseOrder({
      branchId: value.branch.id,
      creator: value.owner,
      organizationId: value.organization.id,
      products: value.products.slice(0, 1),
      supplierId: value.supplier.id,
    });
    const base = request({
      actorUserId: value.owner.user.id,
      order,
      organizationId: value.organization.id,
    });
    await prisma.purchaseOrder.update({
      data: { status: "DRAFT" },
      where: { id: order.id },
    });
    expect(await receiving.receivePurchaseOrder(base)).toEqual({
      kind: "invalid_transition",
    });
    await prisma.purchaseOrder.update({
      data: { status: "CANCELLED" },
      where: { id: order.id },
    });
    expect(await receiving.receivePurchaseOrder(base)).toEqual({
      kind: "invalid_transition",
    });
    await prisma.purchaseOrder.update({
      data: { status: "ORDERED" },
      where: { id: order.id },
    });
    expect(await receiving.receivePurchaseOrder(base)).toMatchObject({
      kind: "success",
    });
    expect(
      await receiving.receivePurchaseOrder({
        ...base,
        idempotencyKey: "already-received-other-key",
      }),
    ).toEqual({ kind: "invalid_transition" });

    const fractionalOrder = await orderedPurchaseOrder({
      branchId: value.branch.id,
      creator: value.owner,
      organizationId: value.organization.id,
      products: value.products.slice(1),
      quantities: ["1.5"],
      supplierId: value.supplier.id,
    });
    expect(
      await receiving.receivePurchaseOrder(
        request({
          actorUserId: value.owner.user.id,
          order: fractionalOrder,
          organizationId: value.organization.id,
        }),
      ),
    ).toEqual({ kind: "invalid_quantity" });

    const other = await scope("Receive cross tenant");
    const otherOrder = await orderedPurchaseOrder({
      branchId: other.branch.id,
      creator: other.owner,
      organizationId: other.organization.id,
      products: other.products,
      supplierId: other.supplier.id,
    });
    expect(
      await receiving.receivePurchaseOrder(
        request({
          actorUserId: value.owner.user.id,
          order: otherOrder,
          organizationId: other.organization.id,
        }),
      ),
    ).toEqual({ kind: "forbidden" });
    expect(
      await receiving.receivePurchaseOrder({
        ...request({
          actorUserId: value.owner.user.id,
          order: otherOrder,
          organizationId: value.organization.id,
        }),
        organizationId: value.organization.id,
      }),
    ).toEqual({ kind: "not_found" });
  });

  it("rolls back every receipt effect when a later line fails", async () => {
    const value = await scope("Receive rollback");
    const order = await orderedPurchaseOrder({
      branchId: value.branch.id,
      creator: value.owner,
      organizationId: value.organization.id,
      products: value.products,
      supplierId: value.supplier.id,
    });
    const failing = createPrismaReceivingRepository(prisma, {
      afterLineCommitted: (index) => {
        if (index === 0) throw new Error("injected receiving failure");
      },
    });
    await expect(
      failing.receivePurchaseOrder(
        request({
          actorUserId: value.owner.user.id,
          order,
          organizationId: value.organization.id,
        }),
      ),
    ).rejects.toThrow("injected receiving failure");
    expect(await prisma.purchaseReceipt.count()).toBe(0);
    expect(await prisma.purchaseReceiptItem.count()).toBe(0);
    expect(await prisma.inventoryTransaction.count()).toBe(0);
    expect(await prisma.inventoryBalance.count()).toBe(0);
    expect(await prisma.inventoryCostState.count()).toBe(0);
    expect(
      await prisma.purchaseOrder.findUnique({ where: { id: order.id } }),
    ).toMatchObject({
      receivedAt: null,
      status: "ORDERED",
    });
  });

  it("rolls back a late service-level storage rejection instead of committing prior lines", async () => {
    const value = await scope("Receive domain rollback");
    const order = await orderedPurchaseOrder({
      branchId: value.branch.id,
      creator: value.owner,
      organizationId: value.organization.id,
      products: value.products,
      supplierId: value.supplier.id,
    });
    const input = request({
      actorUserId: value.owner.user.id,
      order,
      organizationId: value.organization.id,
    });
    const result = await receiving.receivePurchaseOrder({
      ...input,
      actualCosts: order.items.map((item, index) => ({
        actualUnitCost: index === 0 ? "1" : "99999999999999",
        purchaseOrderItemId: item.id,
      })),
    });

    expect(result).toEqual({ kind: "invalid_costs" });
    expect(await prisma.purchaseReceipt.count()).toBe(0);
    expect(await prisma.purchaseReceiptItem.count()).toBe(0);
    expect(await prisma.inventoryTransaction.count()).toBe(0);
    expect(await prisma.inventoryBalance.count()).toBe(0);
    expect(await prisma.inventoryCostState.count()).toBe(0);
    expect(
      await prisma.purchaseOrder.findUnique({ where: { id: order.id } }),
    ).toMatchObject({
      receivedAt: null,
      status: "ORDERED",
    });
  });

  it("serializes identical and competing concurrent receipt attempts to one logical receipt", async () => {
    const value = await scope("Receive concurrency");
    const firstOrder = await orderedPurchaseOrder({
      branchId: value.branch.id,
      creator: value.owner,
      organizationId: value.organization.id,
      products: value.products,
      supplierId: value.supplier.id,
    });
    const identical = request({
      actorUserId: value.owner.user.id,
      key: "concurrent-identical",
      order: firstOrder,
      organizationId: value.organization.id,
    });
    const identicalResults = await Promise.all([
      receiving.receivePurchaseOrder(identical),
      receiving.receivePurchaseOrder(identical),
    ]);
    expect(identicalResults.map((result) => result.kind).sort()).toEqual([
      "replay",
      "success",
    ]);

    const secondOrder = await orderedPurchaseOrder({
      branchId: value.branch.id,
      creator: value.owner,
      organizationId: value.organization.id,
      products: value.products,
      supplierId: value.supplier.id,
    });
    const competing = request({
      actorUserId: value.owner.user.id,
      order: secondOrder,
      organizationId: value.organization.id,
    });
    const competingResults = await Promise.all([
      receiving.receivePurchaseOrder({
        ...competing,
        idempotencyKey: "competing-a",
      }),
      receiving.receivePurchaseOrder({
        ...competing,
        idempotencyKey: "competing-b",
      }),
    ]);
    expect(competingResults.map((result) => result.kind).sort()).toEqual([
      "invalid_transition",
      "success",
    ]);
    expect(await prisma.purchaseReceipt.count()).toBe(2);
  });

  it("uses deterministic product locks for overlapping multi-line receipts and reconciles ledger to balance", async () => {
    const value = await scope("Receive overlap");
    const firstOrder = await orderedPurchaseOrder({
      branchId: value.branch.id,
      creator: value.owner,
      organizationId: value.organization.id,
      products: value.products,
      quantities: ["2", "3"],
      supplierId: value.supplier.id,
    });
    const secondOrder = await orderedPurchaseOrder({
      branchId: value.branch.id,
      creator: value.owner,
      organizationId: value.organization.id,
      products: [...value.products].reverse(),
      quantities: ["5", "7"],
      supplierId: value.supplier.id,
    });
    const results = await Promise.all([
      receiving.receivePurchaseOrder(
        request({
          actorUserId: value.owner.user.id,
          order: firstOrder,
          organizationId: value.organization.id,
        }),
      ),
      receiving.receivePurchaseOrder(
        request({
          actorUserId: value.owner.user.id,
          order: secondOrder,
          organizationId: value.organization.id,
        }),
      ),
    ]);
    expect(results.map((result) => result.kind)).toEqual([
      "success",
      "success",
    ]);
    const reconciliation = await prisma.$queryRaw<
      Array<{ difference: string; productId: string }>
    >`
      SELECT
        b."product_id" AS "productId",
        (b."quantity" - SUM(t."delta"))::text AS "difference"
      FROM "inventory_balances" b
      JOIN "inventory_transactions" t
        ON t."branch_id" = b."branch_id"
       AND t."product_id" = b."product_id"
      WHERE b."branch_id" = ${value.branch.id}::uuid
      GROUP BY b."product_id", b."quantity"
      ORDER BY b."product_id"
    `;
    expect(reconciliation).toHaveLength(2);
    expect(reconciliation.every((row) => Number(row.difference) === 0)).toBe(
      true,
    );
  });

  it("serializes receiving with manual adjustment on the shared Branch/Product balance lock", async () => {
    const value = await scope("Receive adjustment race");
    const order = await orderedPurchaseOrder({
      branchId: value.branch.id,
      creator: value.owner,
      organizationId: value.organization.id,
      products: value.products.slice(0, 1),
      quantities: ["2"],
      supplierId: value.supplier.id,
    });
    const inventory = createPrismaInventoryRepository(prisma);
    const [receiptResult, adjustmentResult] = await Promise.all([
      receiving.receivePurchaseOrder({
        ...request({
          actorUserId: value.owner.user.id,
          order,
          organizationId: value.organization.id,
        }),
        actualCosts: [
          { actualUnitCost: "5", purchaseOrderItemId: order.items[0]!.id },
        ],
      }),
      inventory.adjust({
        actorUserId: value.owner.user.id,
        adjustment: {
          delta: "3",
          note: null,
          productId: value.products[0]!.id,
          reason: "FOUND",
        },
        branchId: value.branch.id,
        idempotencyKey: "receive-adjustment-race",
        organizationId: value.organization.id,
      }),
    ]);
    expect(receiptResult.kind).toBe("success");
    expect(adjustmentResult.kind).toBe("success");
    const balance = await prisma.inventoryBalance.findUniqueOrThrow({
      where: {
        branchId_productId: {
          branchId: value.branch.id,
          productId: value.products[0]!.id,
        },
      },
    });
    const ledger = await prisma.inventoryTransaction.aggregate({
      _sum: { delta: true },
      where: { branchId: value.branch.id, productId: value.products[0]!.id },
    });
    const cost = await prisma.inventoryCostState.findUniqueOrThrow({
      where: {
        branchId_productId: {
          branchId: value.branch.id,
          productId: value.products[0]!.id,
        },
      },
    });
    expect(balance.quantity.toFixed(4)).toBe("5.0000");
    expect(ledger._sum.delta?.toFixed(4)).toBe("5.0000");
    expect(cost.inventoryValue?.toFixed(10)).toBe("25.0000000000");
    expect(cost.averageUnitCost?.toFixed(6)).toBe("5.000000");
  });

  it("serializes RECEIVE against CANCEL through the purchase-order row", async () => {
    const value = await scope("Receive cancel race");
    const order = await orderedPurchaseOrder({
      branchId: value.branch.id,
      creator: value.owner,
      organizationId: value.organization.id,
      products: value.products,
      supplierId: value.supplier.id,
    });
    const purchaseOrders = createPrismaPurchaseOrderRepository(prisma);
    const [receiptResult, cancelResult] = await Promise.all([
      receiving.receivePurchaseOrder(
        request({
          actorUserId: value.owner.user.id,
          order,
          organizationId: value.organization.id,
        }),
      ),
      purchaseOrders.updatePurchaseOrder({
        actorUserId: value.owner.user.id,
        branchId: value.branch.id,
        organizationId: value.organization.id,
        purchaseOrder: purchaseOrderUpdateRequestSchema.parse({
          expectedUpdatedAt: order.updatedAt.toISOString(),
          status: "CANCELLED",
        }),
        purchaseOrderId: order.id,
      }),
    ]);
    const finalOrder = await prisma.purchaseOrder.findUniqueOrThrow({
      where: { id: order.id },
    });
    if (receiptResult.kind === "success") {
      expect(finalOrder.status).toBe("RECEIVED");
      expect(cancelResult.kind).toBe("stale");
      expect(await prisma.purchaseReceipt.count()).toBe(1);
    } else {
      expect(receiptResult.kind).toBe("invalid_transition");
      expect(cancelResult.kind).toBe("success");
      expect(finalOrder.status).toBe("CANCELLED");
      expect(await prisma.purchaseReceipt.count()).toBe(0);
    }
  });

  it("preserves complete terminal state in both serialized RECEIVE and CANCEL orders", async () => {
    const receiveFirst = await scope("Receive first terminal state");
    const receiveFirstOrder = await orderedPurchaseOrder({
      branchId: receiveFirst.branch.id,
      creator: receiveFirst.owner,
      organizationId: receiveFirst.organization.id,
      products: receiveFirst.products,
      supplierId: receiveFirst.supplier.id,
    });
    expect(
      await receiving.receivePurchaseOrder(
        request({
          actorUserId: receiveFirst.owner.user.id,
          order: receiveFirstOrder,
          organizationId: receiveFirst.organization.id,
        }),
      ),
    ).toMatchObject({ kind: "success" });
    expect(
      await createPrismaPurchaseOrderRepository(prisma).updatePurchaseOrder({
        actorUserId: receiveFirst.owner.user.id,
        branchId: receiveFirst.branch.id,
        organizationId: receiveFirst.organization.id,
        purchaseOrder: purchaseOrderUpdateRequestSchema.parse({
          expectedUpdatedAt: receiveFirstOrder.updatedAt.toISOString(),
          status: "CANCELLED",
        }),
        purchaseOrderId: receiveFirstOrder.id,
      }),
    ).toEqual({ kind: "stale" });

    const cancelFirst = await scope("Cancel first terminal state");
    const cancelFirstOrder = await orderedPurchaseOrder({
      branchId: cancelFirst.branch.id,
      creator: cancelFirst.owner,
      organizationId: cancelFirst.organization.id,
      products: cancelFirst.products,
      supplierId: cancelFirst.supplier.id,
    });
    expect(
      await createPrismaPurchaseOrderRepository(prisma).updatePurchaseOrder({
        actorUserId: cancelFirst.owner.user.id,
        branchId: cancelFirst.branch.id,
        organizationId: cancelFirst.organization.id,
        purchaseOrder: purchaseOrderUpdateRequestSchema.parse({
          expectedUpdatedAt: cancelFirstOrder.updatedAt.toISOString(),
          status: "CANCELLED",
        }),
        purchaseOrderId: cancelFirstOrder.id,
      }),
    ).toMatchObject({ kind: "success" });
    expect(
      await receiving.receivePurchaseOrder(
        request({
          actorUserId: cancelFirst.owner.user.id,
          order: cancelFirstOrder,
          organizationId: cancelFirst.organization.id,
        }),
      ),
    ).toEqual({ kind: "invalid_transition" });

    const [receivedState, cancelledState] = await Promise.all([
      Promise.all([
        prisma.purchaseReceipt.count({
          where: { purchaseOrderId: receiveFirstOrder.id },
        }),
        prisma.purchaseReceiptItem.count({
          where: { purchaseOrderId: receiveFirstOrder.id },
        }),
        prisma.inventoryBalance.count({
          where: { organizationId: receiveFirst.organization.id },
        }),
        prisma.inventoryTransaction.count({
          where: { organizationId: receiveFirst.organization.id },
        }),
        prisma.inventoryCostState.count({
          where: { organizationId: receiveFirst.organization.id },
        }),
      ]),
      Promise.all([
        prisma.purchaseReceipt.count({
          where: { purchaseOrderId: cancelFirstOrder.id },
        }),
        prisma.purchaseReceiptItem.count({
          where: { purchaseOrderId: cancelFirstOrder.id },
        }),
        prisma.inventoryBalance.count({
          where: { organizationId: cancelFirst.organization.id },
        }),
        prisma.inventoryTransaction.count({
          where: { organizationId: cancelFirst.organization.id },
        }),
        prisma.inventoryCostState.count({
          where: { organizationId: cancelFirst.organization.id },
        }),
      ]),
    ]);
    expect(receivedState).toEqual([1, 2, 2, 2, 2]);
    expect(cancelledState).toEqual([0, 0, 0, 0, 0]);
  });
});
