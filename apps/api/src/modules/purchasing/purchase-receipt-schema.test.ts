import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  createTestPrismaClient,
  resetTestDatabase,
} from "../../test/database-harness.ts";
import { loadTestDatabaseEnvironment } from "../../test/database-environment.ts";

const environment = loadTestDatabaseEnvironment();
const prisma = createTestPrismaClient(environment);

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function fixture(label: string) {
  const organization = await prisma.organization.create({
    data: { name: label },
  });
  const branch = await prisma.branch.create({
    data: { code: `${label}-BR`, name: label, organizationId: organization.id },
  });
  const user = await prisma.user.create({
    data: { email: `${randomUUID()}@example.com` },
  });
  const membership = await prisma.organizationMembership.create({
    data: { organizationId: organization.id, role: "OWNER", userId: user.id },
  });
  const supplier = await prisma.supplier.create({
    data: { name: label, organizationId: organization.id },
  });
  const product = await prisma.product.create({
    data: {
      basePrice: "10",
      name: label,
      organizationId: organization.id,
      sku: `${label}-SKU`.toUpperCase(),
      unit: "EA",
    },
  });
  const order = await prisma.purchaseOrder.create({
    data: {
      branchId: branch.id,
      createdByMembershipId: membership.id,
      createdByUserId: user.id,
      expectedTotal: "10",
      orderDate: new Date("2026-09-02T00:00:00.000Z"),
      organizationId: organization.id,
      reference: `PO-${randomUUID()}`,
      status: "ORDERED",
      supplierId: supplier.id,
    },
  });
  const orderItem = await prisma.purchaseOrderItem.create({
    data: {
      expectedUnitCost: "5",
      organizationId: organization.id,
      productId: product.id,
      productNameSnapshot: product.name,
      productSkuSnapshot: product.sku,
      purchaseOrderId: order.id,
      quantity: "2",
    },
  });
  return {
    branch,
    membership,
    order,
    orderItem,
    organization,
    product,
    supplier,
    user,
  };
}

async function createReceipt(
  value: Awaited<ReturnType<typeof fixture>>,
  key: string,
) {
  return prisma.purchaseReceipt.create({
    data: {
      branchId: value.branch.id,
      canonicalRequestHash: hash(`${key}-request`),
      idempotencyKeyHash: hash(`${key}-key`),
      organizationId: value.organization.id,
      organizationVatRegisteredSnapshot: false,
      purchaseOrderId: value.order.id,
      receivedAt: new Date("2026-09-02T10:00:00.000Z"),
      receivedByMembershipId: value.membership.id,
      receivedByUserId: value.user.id,
      reference: `RCPT-${key}`,
      supplierId: value.supplier.id,
    },
  });
}

describe("purchase receipt database schema", () => {
  beforeEach(async () => resetTestDatabase(environment));
  afterAll(async () => {
    await resetTestDatabase(environment);
    await prisma.$disconnect();
  });

  it("persists exact immutable receipt snapshots and one purchasing ledger movement", async () => {
    const value = await fixture("receipt-shape");
    const receipt = await prisma.purchaseReceipt.create({
      data: {
        branchId: value.branch.id,
        canonicalRequestHash: hash("shape-request"),
        idempotencyKeyHash: hash("shape-key"),
        inputVatAmount: "7.0000",
        inputVatRate: "7.000000",
        organizationId: value.organization.id,
        organizationVatRegisteredSnapshot: true,
        purchaseOrderId: value.order.id,
        receivedAt: new Date("2026-09-02T10:00:00.000Z"),
        receivedByMembershipId: value.membership.id,
        receivedByUserId: value.user.id,
        reference: "RCPT-SHAPE",
        supplierId: value.supplier.id,
        supplierTaxDocumentDate: new Date("2026-09-02T00:00:00.000Z"),
        supplierTaxDocumentNumber: "TAX-001",
      },
    });
    const item = await prisma.purchaseReceiptItem.create({
      data: {
        actualUnitCost: "5.2500",
        branchId: value.branch.id,
        organizationId: value.organization.id,
        productId: value.product.id,
        productNameSnapshot: value.orderItem.productNameSnapshot,
        productSkuSnapshot: value.orderItem.productSkuSnapshot,
        purchaseOrderId: value.order.id,
        purchaseOrderItemId: value.orderItem.id,
        receiptId: receipt.id,
        receivedQuantity: value.orderItem.quantity,
      },
    });
    const movement = await prisma.inventoryTransaction.create({
      data: {
        actorMembershipId: value.membership.id,
        actorUserId: value.user.id,
        branchId: value.branch.id,
        delta: item.receivedQuantity,
        organizationId: value.organization.id,
        productId: value.product.id,
        purchaseReceiptItemId: item.id,
        source: "PURCHASE_RECEIVE",
      },
    });

    expect(item.actualUnitCost.toFixed(4)).toBe("5.2500");
    expect(movement).toMatchObject({ adjustmentReason: null, note: null });
    await expect(
      prisma.inventoryTransaction.create({
        data: {
          actorMembershipId: value.membership.id,
          actorUserId: value.user.id,
          branchId: value.branch.id,
          delta: item.receivedQuantity,
          organizationId: value.organization.id,
          productId: value.product.id,
          purchaseReceiptItemId: item.id,
          source: "PURCHASE_RECEIVE",
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.purchaseReceiptItem.delete({ where: { id: item.id } }),
    ).rejects.toThrow();
    await expect(
      prisma.purchaseReceipt.delete({ where: { id: receipt.id } }),
    ).rejects.toThrow();
    await expect(
      prisma.purchaseOrder.delete({ where: { id: value.order.id } }),
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

  it("enforces one receipt per PO and organization-scoped receipt identity", async () => {
    const value = await fixture("receipt-identity");
    await createReceipt(value, "one");
    await expect(createReceipt(value, "two")).rejects.toThrow();
    const other = await fixture("receipt-other");
    await expect(
      prisma.purchaseReceipt.create({
        data: {
          branchId: other.branch.id,
          canonicalRequestHash: hash("cross-request"),
          idempotencyKeyHash: hash("one-key"),
          organizationId: other.organization.id,
          organizationVatRegisteredSnapshot: false,
          purchaseOrderId: other.order.id,
          receivedAt: new Date(),
          receivedByMembershipId: other.membership.id,
          receivedByUserId: other.user.id,
          reference: "RCPT-one",
          supplierId: other.supplier.id,
        },
      }),
    ).resolves.toBeDefined();
  });

  it("rejects invalid VAT, receipt line, movement, and cost-state shapes", async () => {
    const value = await fixture("receipt-constraints");
    await expect(
      prisma.purchaseReceipt.create({
        data: {
          branchId: value.branch.id,
          canonicalRequestHash: hash("vat-request"),
          idempotencyKeyHash: hash("vat-key"),
          inputVatAmount: "1",
          inputVatRate: null,
          organizationId: value.organization.id,
          organizationVatRegisteredSnapshot: true,
          purchaseOrderId: value.order.id,
          receivedAt: new Date(),
          receivedByMembershipId: value.membership.id,
          receivedByUserId: value.user.id,
          reference: "RCPT-VAT",
          supplierId: value.supplier.id,
        },
      }),
    ).rejects.toThrow();

    const receipt = await createReceipt(value, "constraints");
    await expect(
      prisma.purchaseReceiptItem.create({
        data: {
          actualUnitCost: "-0.0001",
          branchId: value.branch.id,
          organizationId: value.organization.id,
          productId: value.product.id,
          productNameSnapshot: value.product.name,
          productSkuSnapshot: value.product.sku,
          purchaseOrderId: value.order.id,
          purchaseOrderItemId: value.orderItem.id,
          receiptId: receipt.id,
          receivedQuantity: "0",
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.inventoryCostState.create({
        data: {
          basisState: "UNKNOWN",
          branchId: value.branch.id,
          inventoryValue: "0",
          organizationId: value.organization.id,
          productId: value.product.id,
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.inventoryTransaction.create({
        data: {
          actorMembershipId: value.membership.id,
          actorUserId: value.user.id,
          branchId: value.branch.id,
          delta: "1",
          organizationId: value.organization.id,
          productId: value.product.id,
          source: "PURCHASE_RECEIVE",
        },
      }),
    ).rejects.toThrow();
  });

  it("rejects receipt and receipt-item tenant or frozen-source mismatches", async () => {
    const first = await fixture("receipt-first");
    const second = await fixture("receipt-second");
    await expect(
      prisma.purchaseReceipt.create({
        data: {
          branchId: second.branch.id,
          canonicalRequestHash: hash("cross-request"),
          idempotencyKeyHash: hash("cross-key"),
          organizationId: first.organization.id,
          organizationVatRegisteredSnapshot: false,
          purchaseOrderId: first.order.id,
          receivedAt: new Date(),
          receivedByMembershipId: first.membership.id,
          receivedByUserId: first.user.id,
          reference: "RCPT-CROSS",
          supplierId: first.supplier.id,
        },
      }),
    ).rejects.toThrow();
    const receipt = await createReceipt(first, "source");
    await expect(
      prisma.purchaseReceiptItem.create({
        data: {
          actualUnitCost: "1",
          branchId: first.branch.id,
          organizationId: first.organization.id,
          productId: second.product.id,
          productNameSnapshot: "mismatch",
          productSkuSnapshot: "mismatch",
          purchaseOrderId: first.order.id,
          purchaseOrderItemId: first.orderItem.id,
          receiptId: receipt.id,
          receivedQuantity: "2",
        },
      }),
    ).rejects.toThrow();
  });
});
