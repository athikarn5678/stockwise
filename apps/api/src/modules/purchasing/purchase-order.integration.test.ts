import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { OrganizationRole } from "../../generated/prisma/enums.ts";
import {
  createTestPrismaClient,
  resetTestDatabase,
} from "../../test/database-harness.ts";
import { loadTestDatabaseEnvironment } from "../../test/database-environment.ts";
import { createPrismaPurchaseOrderRepository } from "./purchase-order-repository.ts";
import {
  purchaseOrderCreateRequestSchema,
  purchaseOrderListQuerySchema,
  purchaseOrderUpdateRequestSchema,
} from "./purchase-order-schemas.ts";

const environment = loadTestDatabaseEnvironment();
const prisma = createTestPrismaClient(environment);
const NOW = new Date("2026-09-01T12:00:00.000Z");
const repository = createPrismaPurchaseOrderRepository(prisma, () => NOW);
const PASSWORD_HASH = "$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$cHVyY2hhc2U";

async function scope(name: string) {
  const organization = await prisma.organization.create({ data: { name } });
  const branch = await prisma.branch.create({
    data: { code: "MAIN", name: "Main", organizationId: organization.id },
  });
  const secondBranch = await prisma.branch.create({
    data: { code: "SECOND", name: "Second", organizationId: organization.id },
  });
  const supplier = await prisma.supplier.create({
    data: { name: "Primary Supplier", organizationId: organization.id },
  });
  const secondSupplier = await prisma.supplier.create({
    data: { name: "Second Supplier", organizationId: organization.id },
  });
  const product = await prisma.product.create({
    data: {
      basePrice: "1",
      name: "Rice",
      organizationId: organization.id,
      sku: "RICE",
      unit: "KG",
    },
  });
  const secondProduct = await prisma.product.create({
    data: {
      basePrice: "1",
      name: "Carton",
      organizationId: organization.id,
      sku: "CARTON",
      unit: "EA",
    },
  });
  return {
    branch,
    organization,
    product,
    secondBranch,
    secondProduct,
    secondSupplier,
    supplier,
  };
}

async function actor(input: {
  branchIds?: string[];
  organizationId: string;
  role: OrganizationRole;
}) {
  const user = await prisma.user.create({
    data: {
      email: `${input.role.toLowerCase()}-${crypto.randomUUID()}@example.com`,
      emailVerifiedAt: NOW,
      passwordHash: PASSWORD_HASH,
    },
  });
  const membership = await prisma.organizationMembership.create({
    data: {
      organizationId: input.organizationId,
      role: input.role,
      userId: user.id,
    },
  });
  for (const branchId of input.branchIds ?? []) {
    await prisma.branchAssignment.create({
      data: { branchId, organizationId: input.organizationId, userId: user.id },
    });
  }
  return { membership, user };
}

function createInput(input: {
  expectedDate?: string | null;
  items: Array<{
    expectedUnitCost: string;
    productId: string;
    quantity: string;
  }>;
  orderDate?: string;
  supplierId: string;
}) {
  return purchaseOrderCreateRequestSchema.parse({
    expectedDate: input.expectedDate ?? null,
    items: input.items,
    orderDate: input.orderDate ?? "2026-09-01",
    supplierId: input.supplierId,
  });
}

async function createOrder(input: {
  actorUserId: string;
  branchId: string;
  items: Array<{
    expectedUnitCost: string;
    productId: string;
    quantity: string;
  }>;
  organizationId: string;
  supplierId: string;
}) {
  return repository.createPurchaseOrder({
    actorUserId: input.actorUserId,
    branchId: input.branchId,
    organizationId: input.organizationId,
    purchaseOrder: createInput(input),
  });
}

async function draft(input: {
  actorUserId: string;
  branchId: string;
  organizationId: string;
  productId: string;
  supplierId: string;
}) {
  const result = await createOrder({
    actorUserId: input.actorUserId,
    branchId: input.branchId,
    items: [
      {
        expectedUnitCost: "2.5000",
        productId: input.productId,
        quantity: "1.2500",
      },
    ],
    organizationId: input.organizationId,
    supplierId: input.supplierId,
  });
  if (result.kind !== "success")
    throw new Error(`Expected draft, got ${result.kind}`);
  return result.purchaseOrder;
}

async function patch(input: {
  actorUserId: string;
  branchId: string;
  organizationId: string;
  purchaseOrderId: string;
  value: Record<string, unknown>;
}) {
  return repository.updatePurchaseOrder({
    actorUserId: input.actorUserId,
    branchId: input.branchId,
    organizationId: input.organizationId,
    purchaseOrder: purchaseOrderUpdateRequestSchema.parse(input.value),
    purchaseOrderId: input.purchaseOrderId,
  });
}

describe("purchase order repository with PostgreSQL", () => {
  beforeEach(async () => resetTestDatabase(environment));

  afterAll(async () => {
    await resetTestDatabase(environment);
    await prisma.$disconnect();
  });

  it("creates server-referenced DRAFT aggregates with exact decimal snapshots and read/list isolation", async () => {
    const value = await scope("Create Purchase Orders");
    const owner = await actor({
      organizationId: value.organization.id,
      role: "OWNER",
    });
    const created = await createOrder({
      actorUserId: owner.user.id,
      branchId: value.branch.id,
      items: [
        {
          expectedUnitCost: "1.2345",
          productId: value.product.id,
          quantity: "2.5000",
        },
        {
          expectedUnitCost: "4",
          productId: value.secondProduct.id,
          quantity: "3",
        },
      ],
      organizationId: value.organization.id,
      supplierId: value.supplier.id,
    });
    expect(created).toMatchObject({
      kind: "success",
      purchaseOrder: {
        currency: "THB",
        expectedTotal: "15.0863",
        reference: expect.stringMatching(/^PO-[0-9a-f-]{36}$/),
        status: "DRAFT",
      },
    });
    if (created.kind !== "success") throw new Error("Expected create success.");
    expect(created.purchaseOrder.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          expectedUnitCost: "1.2345",
          productNameSnapshot: "Rice",
          productSkuSnapshot: "RICE",
          quantity: "2.5",
        }),
      ]),
    );
    const detail = await repository.getPurchaseOrder({
      actorUserId: owner.user.id,
      branchId: value.branch.id,
      organizationId: value.organization.id,
      purchaseOrderId: created.purchaseOrder.id,
    });
    expect(detail).toMatchObject({
      kind: "success",
      purchaseOrder: created.purchaseOrder,
    });
    const list = await repository.listPurchaseOrders({
      actorUserId: owner.user.id,
      branchId: value.branch.id,
      organizationId: value.organization.id,
      query: purchaseOrderListQuerySchema.parse({ status: "DRAFT" }),
    });
    expect(list).toMatchObject({
      kind: "success",
      purchaseOrders: [
        expect.objectContaining({ id: created.purchaseOrder.id }),
      ],
    });
    expect(JSON.stringify(list)).not.toContain("productNameSnapshot");
    expect(await prisma.inventoryBalance.count()).toBe(0);
    expect(await prisma.inventoryTransaction.count()).toBe(0);
    expect(() =>
      createInput({
        items: [
          { expectedUnitCost: "1", productId: value.product.id, quantity: "1" },
          { expectedUnitCost: "1", productId: value.product.id, quantity: "2" },
        ],
        supplierId: value.supplier.id,
      }),
    ).toThrow();
  });

  it("enforces concrete branch authorization, tenant references, active lifecycle resources, and exact unit decimals", async () => {
    const value = await scope("Authorize Purchase Orders");
    const other = await scope("Other Purchase Orders");
    const roles = await Promise.all(
      (["OWNER", "ADMIN", "BRANCH_MANAGER"] as const).map((role) =>
        actor({
          branchIds: role === "BRANCH_MANAGER" ? [value.branch.id] : [],
          organizationId: value.organization.id,
          role,
        }),
      ),
    );
    for (const allowed of roles) {
      await expect(
        createOrder({
          actorUserId: allowed.user.id,
          branchId: value.branch.id,
          items: [
            {
              expectedUnitCost: "0",
              productId: value.product.id,
              quantity: "1.25",
            },
          ],
          organizationId: value.organization.id,
          supplierId: value.supplier.id,
        }),
      ).resolves.toMatchObject({ kind: "success" });
    }
    const cashier = await actor({
      branchIds: [value.branch.id],
      organizationId: value.organization.id,
      role: "CASHIER",
    });
    const unassigned = await actor({
      organizationId: value.organization.id,
      role: "BRANCH_MANAGER",
    });
    await expect(
      createOrder({
        actorUserId: cashier.user.id,
        branchId: value.branch.id,
        items: [
          { expectedUnitCost: "1", productId: value.product.id, quantity: "1" },
        ],
        organizationId: value.organization.id,
        supplierId: value.supplier.id,
      }),
    ).resolves.toEqual({ kind: "forbidden" });
    await expect(
      createOrder({
        actorUserId: unassigned.user.id,
        branchId: value.branch.id,
        items: [
          { expectedUnitCost: "1", productId: value.product.id, quantity: "1" },
        ],
        organizationId: value.organization.id,
        supplierId: value.supplier.id,
      }),
    ).resolves.toEqual({ kind: "forbidden" });
    await expect(
      createOrder({
        actorUserId: roles[0]!.user.id,
        branchId: value.branch.id,
        items: [
          { expectedUnitCost: "1", productId: other.product.id, quantity: "1" },
        ],
        organizationId: value.organization.id,
        supplierId: value.supplier.id,
      }),
    ).resolves.toEqual({ kind: "product_not_found" });
    await expect(
      createOrder({
        actorUserId: roles[0]!.user.id,
        branchId: value.branch.id,
        items: [
          { expectedUnitCost: "1", productId: value.product.id, quantity: "1" },
        ],
        organizationId: value.organization.id,
        supplierId: other.supplier.id,
      }),
    ).resolves.toEqual({ kind: "supplier_not_found" });
    await expect(
      createOrder({
        actorUserId: roles[0]!.user.id,
        branchId: value.branch.id,
        items: [
          {
            expectedUnitCost: "1",
            productId: value.secondProduct.id,
            quantity: "1.5",
          },
        ],
        organizationId: value.organization.id,
        supplierId: value.supplier.id,
      }),
    ).resolves.toEqual({ kind: "invalid_quantity" });
    await prisma.supplier.update({
      data: { status: "INACTIVE" },
      where: { id: value.secondSupplier.id },
    });
    await expect(
      createOrder({
        actorUserId: roles[0]!.user.id,
        branchId: value.branch.id,
        items: [
          { expectedUnitCost: "1", productId: value.product.id, quantity: "1" },
        ],
        organizationId: value.organization.id,
        supplierId: value.secondSupplier.id,
      }),
    ).resolves.toEqual({ kind: "supplier_inactive" });
    const branchLimitedDraft = await draft({
      actorUserId: roles[2]!.user.id,
      branchId: value.branch.id,
      organizationId: value.organization.id,
      productId: value.product.id,
      supplierId: value.supplier.id,
    });
    await expect(
      patch({
        actorUserId: roles[2]!.user.id,
        branchId: value.branch.id,
        organizationId: value.organization.id,
        purchaseOrderId: branchLimitedDraft.id,
        value: {
          branchId: value.secondBranch.id,
          expectedUpdatedAt: branchLimitedDraft.updatedAt,
        },
      }),
    ).resolves.toEqual({ kind: "forbidden" });
  });

  it("replaces DRAFT aggregates atomically, rejects stale writes, and freezes ORDERED/terminal orders", async () => {
    const value = await scope("Update Purchase Orders");
    const owner = await actor({
      organizationId: value.organization.id,
      role: "OWNER",
    });
    const first = await draft({
      actorUserId: owner.user.id,
      branchId: value.branch.id,
      organizationId: value.organization.id,
      productId: value.product.id,
      supplierId: value.supplier.id,
    });
    const updated = await patch({
      actorUserId: owner.user.id,
      branchId: value.branch.id,
      organizationId: value.organization.id,
      purchaseOrderId: first.id,
      value: {
        expectedDate: "2026-09-10",
        expectedUpdatedAt: first.updatedAt,
        items: [
          {
            expectedUnitCost: "3.3333",
            productId: value.secondProduct.id,
            quantity: "2",
          },
        ],
        supplierId: value.secondSupplier.id,
      },
    });
    expect(updated).toMatchObject({
      kind: "success",
      purchaseOrder: {
        expectedDate: "2026-09-10",
        expectedTotal: "6.6666",
        supplierId: value.secondSupplier.id,
      },
    });
    if (updated.kind !== "success") throw new Error("Expected update success.");
    expect(updated.purchaseOrder.items).toHaveLength(1);
    expect(updated.purchaseOrder.items[0]).toMatchObject({
      productId: value.secondProduct.id,
    });
    await expect(
      patch({
        actorUserId: owner.user.id,
        branchId: value.branch.id,
        organizationId: value.organization.id,
        purchaseOrderId: first.id,
        value: { expectedUpdatedAt: first.updatedAt, orderDate: "2026-09-02" },
      }),
    ).resolves.toEqual({ kind: "stale" });
    const ordered = await patch({
      actorUserId: owner.user.id,
      branchId: value.branch.id,
      organizationId: value.organization.id,
      purchaseOrderId: first.id,
      value: {
        expectedUpdatedAt: updated.purchaseOrder.updatedAt,
        status: "ORDERED",
      },
    });
    expect(ordered).toMatchObject({
      kind: "success",
      purchaseOrder: { status: "ORDERED", orderedAt: expect.any(String) },
    });
    if (ordered.kind !== "success") throw new Error("Expected ordered result.");
    await expect(
      patch({
        actorUserId: owner.user.id,
        branchId: value.branch.id,
        organizationId: value.organization.id,
        purchaseOrderId: first.id,
        value: {
          expectedUpdatedAt: ordered.purchaseOrder.updatedAt,
          orderDate: "2026-09-03",
        },
      }),
    ).resolves.toEqual({ kind: "invalid_transition" });
    const cancelled = await patch({
      actorUserId: owner.user.id,
      branchId: value.branch.id,
      organizationId: value.organization.id,
      purchaseOrderId: first.id,
      value: {
        expectedUpdatedAt: ordered.purchaseOrder.updatedAt,
        status: "CANCELLED",
      },
    });
    expect(cancelled).toMatchObject({
      kind: "success",
      purchaseOrder: { status: "CANCELLED" },
    });
    if (cancelled.kind !== "success") throw new Error("Expected cancellation.");
    await expect(
      patch({
        actorUserId: owner.user.id,
        branchId: value.branch.id,
        organizationId: value.organization.id,
        purchaseOrderId: first.id,
        value: {
          expectedUpdatedAt: cancelled.purchaseOrder.updatedAt,
          status: "ORDERED",
        },
      }),
    ).resolves.toEqual({ kind: "invalid_transition" });
    const received = await draft({
      actorUserId: owner.user.id,
      branchId: value.branch.id,
      organizationId: value.organization.id,
      productId: value.product.id,
      supplierId: value.supplier.id,
    });
    const receivedAt = new Date(NOW.getTime() + 1000);
    await prisma.purchaseOrder.update({
      data: { receivedAt, status: "RECEIVED", updatedAt: receivedAt },
      where: { id: received.id },
    });
    await expect(
      patch({
        actorUserId: owner.user.id,
        branchId: value.branch.id,
        organizationId: value.organization.id,
        purchaseOrderId: received.id,
        value: {
          expectedUpdatedAt: receivedAt.toISOString(),
          status: "CANCELLED",
        },
      }),
    ).resolves.toEqual({ kind: "invalid_transition" });
    const inactiveProductResult = await createOrder({
      actorUserId: owner.user.id,
      branchId: value.branch.id,
      items: [
        {
          expectedUnitCost: "2.5000",
          productId: value.secondProduct.id,
          quantity: "1",
        },
      ],
      organizationId: value.organization.id,
      supplierId: value.supplier.id,
    });
    if (inactiveProductResult.kind !== "success") {
      throw new Error(`Expected draft, got ${inactiveProductResult.kind}`);
    }
    const inactiveProductOrder = inactiveProductResult.purchaseOrder;
    await prisma.product.update({
      data: { status: "INACTIVE" },
      where: { id: value.secondProduct.id },
    });
    await expect(
      patch({
        actorUserId: owner.user.id,
        branchId: value.branch.id,
        organizationId: value.organization.id,
        purchaseOrderId: inactiveProductOrder.id,
        value: {
          expectedUpdatedAt: inactiveProductOrder.updatedAt,
          status: "ORDERED",
        },
      }),
    ).resolves.toEqual({ kind: "product_inactive" });
  });

  it("uses filter-bound cursors and serializes real PostgreSQL lifecycle/edit races", async () => {
    const value = await scope("Concurrent Purchase Orders");
    const owner = await actor({
      organizationId: value.organization.id,
      role: "OWNER",
    });
    const first = await draft({
      actorUserId: owner.user.id,
      branchId: value.branch.id,
      organizationId: value.organization.id,
      productId: value.product.id,
      supplierId: value.supplier.id,
    });
    const second = await draft({
      actorUserId: owner.user.id,
      branchId: value.branch.id,
      organizationId: value.organization.id,
      productId: value.product.id,
      supplierId: value.supplier.id,
    });
    const page = await repository.listPurchaseOrders({
      actorUserId: owner.user.id,
      branchId: value.branch.id,
      organizationId: value.organization.id,
      query: purchaseOrderListQuerySchema.parse({
        limit: "1",
        status: "DRAFT",
      }),
    });
    if (page.kind !== "success" || page.nextCursor === null)
      throw new Error("Expected a cursor.");
    await expect(
      repository.listPurchaseOrders({
        actorUserId: owner.user.id,
        branchId: value.branch.id,
        organizationId: value.organization.id,
        query: purchaseOrderListQuerySchema.parse({
          cursor: page.nextCursor,
          limit: "1",
          status: "ORDERED",
        }),
      }),
    ).resolves.toEqual({ kind: "invalid_cursor" });
    const orderRace = await Promise.all([
      patch({
        actorUserId: owner.user.id,
        branchId: value.branch.id,
        organizationId: value.organization.id,
        purchaseOrderId: first.id,
        value: { expectedUpdatedAt: first.updatedAt, status: "ORDERED" },
      }),
      patch({
        actorUserId: owner.user.id,
        branchId: value.branch.id,
        organizationId: value.organization.id,
        purchaseOrderId: first.id,
        value: { expectedUpdatedAt: first.updatedAt, status: "ORDERED" },
      }),
    ]);
    expect(orderRace.map((result) => result.kind).sort()).toEqual([
      "stale",
      "success",
    ]);
    const cancelRace = await Promise.all([
      patch({
        actorUserId: owner.user.id,
        branchId: value.branch.id,
        organizationId: value.organization.id,
        purchaseOrderId: second.id,
        value: { expectedUpdatedAt: second.updatedAt, status: "ORDERED" },
      }),
      patch({
        actorUserId: owner.user.id,
        branchId: value.branch.id,
        organizationId: value.organization.id,
        purchaseOrderId: second.id,
        value: { expectedUpdatedAt: second.updatedAt, status: "CANCELLED" },
      }),
    ]);
    expect(cancelRace.map((result) => result.kind).sort()).toEqual([
      "stale",
      "success",
    ]);
    const third = await draft({
      actorUserId: owner.user.id,
      branchId: value.branch.id,
      organizationId: value.organization.id,
      productId: value.product.id,
      supplierId: value.supplier.id,
    });
    const editOrderRace = await Promise.all([
      patch({
        actorUserId: owner.user.id,
        branchId: value.branch.id,
        organizationId: value.organization.id,
        purchaseOrderId: third.id,
        value: { expectedUpdatedAt: third.updatedAt, orderDate: "2026-09-02" },
      }),
      patch({
        actorUserId: owner.user.id,
        branchId: value.branch.id,
        organizationId: value.organization.id,
        purchaseOrderId: third.id,
        value: { expectedUpdatedAt: third.updatedAt, status: "ORDERED" },
      }),
    ]);
    expect(editOrderRace.map((result) => result.kind).sort()).toEqual([
      "stale",
      "success",
    ]);
    const fourth = await draft({
      actorUserId: owner.user.id,
      branchId: value.branch.id,
      organizationId: value.organization.id,
      productId: value.product.id,
      supplierId: value.supplier.id,
    });
    const editCancelRace = await Promise.all([
      patch({
        actorUserId: owner.user.id,
        branchId: value.branch.id,
        organizationId: value.organization.id,
        purchaseOrderId: fourth.id,
        value: { expectedUpdatedAt: fourth.updatedAt, orderDate: "2026-09-02" },
      }),
      patch({
        actorUserId: owner.user.id,
        branchId: value.branch.id,
        organizationId: value.organization.id,
        purchaseOrderId: fourth.id,
        value: { expectedUpdatedAt: fourth.updatedAt, status: "CANCELLED" },
      }),
    ]);
    expect(editCancelRace.map((result) => result.kind).sort()).toEqual([
      "stale",
      "success",
    ]);
    const rows = await prisma.purchaseOrder.findMany({
      include: { items: true },
      where: { id: { in: [first.id, second.id, third.id, fourth.id] } },
    });
    expect(rows).toHaveLength(4);
    expect(rows.every((order) => order.items.length === 1)).toBe(true);
    expect(
      rows.every((order) => order.expectedTotal.toFixed(4) === "3.1250"),
    ).toBe(true);
  }, 20_000);
});
