import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  createTestPrismaClient,
  resetTestDatabase,
} from "../../test/database-harness.ts";
import { loadTestDatabaseEnvironment } from "../../test/database-environment.ts";

const environment = loadTestDatabaseEnvironment();
const prisma = createTestPrismaClient(environment);
async function fixture() {
  const organization = await prisma.organization.create({
    data: { name: "Purchasing Organization" },
  });
  const otherOrganization = await prisma.organization.create({
    data: { name: "Other Organization" },
  });
  const user = await prisma.user.create({
    data: {
      email: `purchasing-${crypto.randomUUID()}@example.com`,
      emailVerifiedAt: new Date(),
    },
  });
  const membership = await prisma.organizationMembership.create({
    data: { organizationId: organization.id, role: "OWNER", userId: user.id },
  });
  const otherUser = await prisma.user.create({
    data: {
      email: `other-purchasing-${crypto.randomUUID()}@example.com`,
      emailVerifiedAt: new Date(),
    },
  });
  const otherMembership = await prisma.organizationMembership.create({
    data: {
      organizationId: otherOrganization.id,
      role: "OWNER",
      userId: otherUser.id,
    },
  });
  const branch = await prisma.branch.create({
    data: {
      code: "PURCHASE",
      name: "Purchase",
      organizationId: organization.id,
    },
  });
  const otherBranch = await prisma.branch.create({
    data: {
      code: "OTHER",
      name: "Other",
      organizationId: otherOrganization.id,
    },
  });
  const supplier = await prisma.supplier.create({
    data: { name: "Supplier", organizationId: organization.id },
  });
  const otherSupplier = await prisma.supplier.create({
    data: { name: "Other Supplier", organizationId: otherOrganization.id },
  });
  const product = await prisma.product.create({
    data: {
      basePrice: "10.0000",
      name: "Product",
      organizationId: organization.id,
      sku: "PURCHASE-1",
      unit: "EA",
    },
  });
  const otherProduct = await prisma.product.create({
    data: {
      basePrice: "10.0000",
      name: "Other Product",
      organizationId: otherOrganization.id,
      sku: "OTHER-1",
      unit: "EA",
    },
  });
  const secondProduct = await prisma.product.create({
    data: {
      basePrice: "10.0000",
      name: "Second Product",
      organizationId: organization.id,
      sku: "PURCHASE-2",
      unit: "EA",
    },
  });

  return {
    branch,
    membership,
    organization,
    otherBranch,
    otherOrganization,
    otherProduct,
    otherMembership,
    otherSupplier,
    product,
    secondProduct,
    supplier,
    user,
  };
}

async function purchaseOrder(data: {
  branchId: string;
  createdByMembershipId: string;
  createdByUserId: string;
  organizationId: string;
  reference?: string;
  supplierId: string;
}) {
  return prisma.purchaseOrder.create({
    data: {
      ...data,
      expectedTotal: "25.5000",
      orderDate: new Date("2026-09-01T00:00:00.000Z"),
      reference: data.reference ?? crypto.randomUUID(),
    },
  });
}

describe("purchase-order database schema", () => {
  beforeEach(async () => resetTestDatabase(environment));

  afterAll(async () => {
    await resetTestDatabase(environment);
    await prisma.$disconnect();
  });

  it("persists a same-tenant order, required historical snapshots, and every accepted status", async () => {
    const value = await fixture();
    const order = await purchaseOrder({
      branchId: value.branch.id,
      createdByMembershipId: value.membership.id,
      createdByUserId: value.user.id,
      organizationId: value.organization.id,
      reference: "PO-0001",
      supplierId: value.supplier.id,
    });
    const item = await prisma.purchaseOrderItem.create({
      data: {
        expectedUnitCost: "5.1000",
        organizationId: value.organization.id,
        productId: value.product.id,
        productNameSnapshot: "Product at order time",
        productSkuSnapshot: "PURCHASE-1",
        purchaseOrderId: order.id,
        quantity: "5.0000",
      },
    });

    expect(order).toMatchObject({
      currency: "THB",
      expectedTotal: expect.anything(),
      status: "DRAFT",
    });
    expect(order.expectedTotal.toFixed(4)).toBe("25.5000");
    expect(item).toMatchObject({
      productNameSnapshot: "Product at order time",
      productSkuSnapshot: "PURCHASE-1",
    });
    const snapshotColumns = await prisma.$queryRaw<
      { columnName: string; isNullable: string }[]
    >`
      SELECT column_name AS "columnName", is_nullable AS "isNullable"
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'purchase_order_items'
        AND column_name IN ('product_name_snapshot', 'product_sku_snapshot')
      ORDER BY column_name
    `;
    expect(snapshotColumns).toEqual([
      { columnName: "product_name_snapshot", isNullable: "NO" },
      { columnName: "product_sku_snapshot", isNullable: "NO" },
    ]);

    for (const status of [
      "DRAFT",
      "ORDERED",
      "RECEIVED",
      "CANCELLED",
    ] as const) {
      await prisma.purchaseOrder.update({
        data: { status },
        where: { id: order.id },
      });
    }
    await expect(
      prisma.$executeRaw`
        UPDATE "purchase_orders"
        SET "status" = CAST(${"INVALID"} AS "purchase_order_status")
        WHERE "id" = ${order.id}::uuid
      `,
    ).rejects.toThrow();
  });

  it("rejects cross-organization supplier, branch, product, and creator references", async () => {
    const value = await fixture();
    const base = {
      createdByMembershipId: value.membership.id,
      createdByUserId: value.user.id,
      organizationId: value.organization.id,
    };
    await expect(
      purchaseOrder({
        ...base,
        branchId: value.branch.id,
        supplierId: value.otherSupplier.id,
      }),
    ).rejects.toThrow();
    await expect(
      purchaseOrder({
        ...base,
        branchId: value.otherBranch.id,
        supplierId: value.supplier.id,
      }),
    ).rejects.toThrow();
    await expect(
      purchaseOrder({
        branchId: value.branch.id,
        createdByMembershipId: value.otherMembership.id,
        createdByUserId: value.otherMembership.userId,
        organizationId: value.organization.id,
        supplierId: value.supplier.id,
      }),
    ).rejects.toThrow();

    const order = await purchaseOrder({
      ...base,
      branchId: value.branch.id,
      supplierId: value.supplier.id,
    });
    await expect(
      prisma.purchaseOrderItem.create({
        data: {
          expectedUnitCost: "1",
          organizationId: value.organization.id,
          productId: value.otherProduct.id,
          productNameSnapshot: "Other",
          productSkuSnapshot: "OTHER-1",
          purchaseOrderId: order.id,
          quantity: "1",
        },
      }),
    ).rejects.toThrow();
  });

  it("enforces PO references, line uniqueness, and restrictive history relationships", async () => {
    const value = await fixture();
    const input = {
      branchId: value.branch.id,
      createdByMembershipId: value.membership.id,
      createdByUserId: value.user.id,
      organizationId: value.organization.id,
      reference: "PO-DUPLICATE",
      supplierId: value.supplier.id,
    };
    const first = await purchaseOrder(input);
    await expect(purchaseOrder(input)).rejects.toThrow();
    await expect(
      purchaseOrder({
        ...input,
        branchId: value.otherBranch.id,
        createdByMembershipId: value.otherMembership.id,
        createdByUserId: value.otherMembership.userId,
        organizationId: value.otherOrganization.id,
        supplierId: value.otherSupplier.id,
      }),
    ).resolves.toBeDefined();

    const item = {
      expectedUnitCost: "1",
      organizationId: value.organization.id,
      productId: value.product.id,
      productNameSnapshot: "Product",
      productSkuSnapshot: "PURCHASE-1",
      purchaseOrderId: first.id,
      quantity: "1",
    };
    await prisma.purchaseOrderItem.create({ data: item });
    await expect(
      prisma.purchaseOrderItem.create({ data: item }),
    ).rejects.toThrow();
    const second = await purchaseOrder({ ...input, reference: "PO-SECOND" });
    await expect(
      prisma.purchaseOrderItem.create({
        data: { ...item, purchaseOrderId: second.id },
      }),
    ).resolves.toBeDefined();
    await expect(
      prisma.product.delete({ where: { id: value.product.id } }),
    ).rejects.toThrow();
    await expect(
      prisma.supplier.delete({ where: { id: value.supplier.id } }),
    ).rejects.toThrow();
    await expect(
      prisma.branch.delete({ where: { id: value.branch.id } }),
    ).rejects.toThrow();
  });

  it("enforces THB, nonnegative expected money, positive quantities, and fixed Decimal storage", async () => {
    const value = await fixture();
    const order = await purchaseOrder({
      branchId: value.branch.id,
      createdByMembershipId: value.membership.id,
      createdByUserId: value.user.id,
      organizationId: value.organization.id,
      supplierId: value.supplier.id,
    });
    await expect(
      prisma.purchaseOrder.update({
        data: { currency: "USD" },
        where: { id: order.id },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.purchaseOrder.update({
        data: { expectedTotal: "-0.0001" },
        where: { id: order.id },
      }),
    ).rejects.toThrow();
    const item = await prisma.purchaseOrderItem.create({
      data: {
        expectedUnitCost: "1.23456",
        organizationId: value.organization.id,
        productId: value.product.id,
        productNameSnapshot: "Product",
        productSkuSnapshot: "PURCHASE-1",
        purchaseOrderId: order.id,
        quantity: "1.23456",
      },
    });
    expect(item.quantity.toFixed(4)).toBe("1.2346");
    expect(item.expectedUnitCost.toFixed(4)).toBe("1.2346");
    await expect(
      prisma.purchaseOrderItem.create({
        data: {
          expectedUnitCost: "1",
          organizationId: value.organization.id,
          productId: value.secondProduct.id,
          productNameSnapshot: "Second Product",
          productSkuSnapshot: "PURCHASE-2",
          purchaseOrderId: order.id,
          quantity: "0",
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.purchaseOrderItem.create({
        data: {
          expectedUnitCost: "-0.0001",
          organizationId: value.organization.id,
          productId: value.secondProduct.id,
          productNameSnapshot: "Second Product",
          productSkuSnapshot: "PURCHASE-2",
          purchaseOrderId: order.id,
          quantity: "1",
        },
      }),
    ).rejects.toThrow();
  });
});
