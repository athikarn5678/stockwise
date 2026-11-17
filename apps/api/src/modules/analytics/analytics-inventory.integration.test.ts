import { randomBytes, randomUUID } from "node:crypto";

import { Temporal } from "@js-temporal/polyfill";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  createTestPrismaClient,
  resetTestDatabase,
} from "../../test/database-harness.ts";
import { loadTestDatabaseEnvironment } from "../../test/database-environment.ts";
import { createPrismaReceivingRepository } from "../purchasing/receiving-repository.ts";
import { createPrismaCheckoutRepository } from "../sales/checkout-repository.ts";
import { createPrismaRefundRepository } from "../sales/refund-repository.ts";
import { createAnalyticsContextEngine } from "./analytics-context.ts";
import { createAnalyticsDimensionCursorCodec } from "./analytics-dimension-cursor.ts";
import { createPrismaAnalyticsInventoryRepository } from "./analytics-inventory-repository.ts";
import { createAnalyticsInventoryService } from "./analytics-inventory-service.ts";
import { createPrismaAnalyticsScopeRepository } from "./analytics-scope-repository.ts";

const environment = loadTestDatabaseEnvironment();
const prisma = createTestPrismaClient(environment);
const cursorCodec = createAnalyticsDimensionCursorCodec(Buffer.alloc(32, 7));
const cutoff = new Date("2026-09-04T00:00:00.000Z");
const requestPeriod = {
  from: "2026-09-01",
  to: "2026-09-03",
  granularity: "day" as const,
};

async function actor(
  organizationId: string,
  role: "OWNER" | "BRANCH_MANAGER" | "INVENTORY_STAFF" | "CASHIER",
  branchId?: string,
) {
  const user = await prisma.user.create({
    data: {
      displayName: role,
      email: `${randomUUID()}@example.test`,
      emailVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
    },
  });
  const membership = await prisma.organizationMembership.create({
    data: {
      organizationId,
      role,
      userId: user.id,
    },
  });
  if (branchId !== undefined)
    await prisma.branchAssignment.create({
      data: {
        branchId,
        organizationId,
        userId: user.id,
      },
    });
  return { user, membership };
}

async function manual(input: {
  organizationId: string;
  branchId: string;
  productId: string;
  actorUserId: string;
  actorMembershipId: string;
  delta: string;
  occurredAt: Date;
}) {
  return prisma.inventoryTransaction.create({
    data: {
      organizationId: input.organizationId,
      branchId: input.branchId,
      productId: input.productId,
      actorUserId: input.actorUserId,
      actorMembershipId: input.actorMembershipId,
      delta: input.delta,
      occurredAt: input.occurredAt,
      source: "MANUAL_ADJUSTMENT",
      adjustmentReason: "FOUND",
      idempotencyKeyHash: randomBytes(32).toString("hex"),
      canonicalRequestHash: randomBytes(32).toString("hex"),
    },
  });
}

function service(
  options: {
    afterSnapshotCaptured?: () => Promise<void>;
    at?: Date;
    databaseClock?: boolean;
  } = {},
) {
  const at = options.at ?? cutoff;
  return createAnalyticsInventoryService({
    contextEngine: createAnalyticsContextEngine({
      now: () => at,
      scopeRepository: createPrismaAnalyticsScopeRepository(prisma),
    }),
    cursorCodec,
    repository: createPrismaAnalyticsInventoryRepository(prisma, cursorCodec, {
      ...(options.databaseClock ? {} : { now: () => at }),
      ...(options.afterSnapshotCaptured === undefined
        ? {}
        : {
            afterSnapshotCaptured: options.afterSnapshotCaptured,
          }),
    }),
  });
}

async function fixture() {
  const org = await prisma.organization.create({
    data: {
      name: "Inventory analytics",
      reportingTimezone: "Asia/Bangkok",
    },
  });
  const branchA = await prisma.branch.create({
    data: { code: "A", name: "A", organizationId: org.id },
  });
  const branchB = await prisma.branch.create({
    data: { code: "B", name: "B", organizationId: org.id },
  });
  const owner = await actor(org.id, "OWNER");
  const manager = await actor(org.id, "BRANCH_MANAGER", branchA.id);
  const staff = await actor(org.id, "INVENTORY_STAFF", branchA.id);
  const cashier = await actor(org.id, "CASHIER", branchA.id);
  const productA = await prisma.product.create({
    data: {
      organizationId: org.id,
      sku: "A",
      name: "Fractional",
      unit: "KG",
      basePrice: "10",
    },
  });
  const productB = await prisma.product.create({
    data: {
      organizationId: org.id,
      sku: "B",
      name: "Each",
      unit: "EA",
      basePrice: "10",
    },
  });
  const productC = await prisma.product.create({
    data: {
      organizationId: org.id,
      sku: "C",
      name: "Historical",
      unit: "EA",
      basePrice: "10",
      status: "INACTIVE",
    },
  });
  return {
    org,
    branchA,
    branchB,
    owner,
    manager,
    staff,
    cashier,
    productA,
    productB,
    productC,
  };
}

function request(organizationId: string, actorUserId: string) {
  return {
    ...requestPeriod,
    organizationId,
    actorUserId,
    scope: { kind: "organization" as const },
  };
}

describe("inventory analytics with PostgreSQL", () => {
  beforeEach(async () => resetTestDatabase(environment));
  afterAll(async () => {
    await resetTestDatabase(environment);
    await prisma.$disconnect();
  });

  it("separates linked receipt, sale, and restocked refund facts from financial-only refunds", async () => {
    const f = await fixture();
    const firstDimensionProductId = "00000000-0000-4000-8000-000000000001";
    await prisma.organization.update({
      where: { id: f.org.id },
      data: { salesVatStatus: "NOT_REGISTERED" },
    });
    const supplier = await prisma.supplier.create({
      data: { organizationId: f.org.id, name: "Supplier" },
    });
    const order = await prisma.purchaseOrder.create({
      data: {
        organizationId: f.org.id,
        branchId: f.branchA.id,
        supplierId: supplier.id,
        createdByMembershipId: f.owner.membership.id,
        createdByUserId: f.owner.user.id,
        expectedTotal: "50",
        orderDate: new Date("2026-07-31T00:00:00.000Z"),
        orderedAt: new Date("2026-07-31T09:00:00.000Z"),
        status: "ORDERED",
        reference: `PO-${randomUUID()}`,
        items: {
          create: [
            {
              productId: f.productB.id,
              productNameSnapshot: f.productB.name,
              productSkuSnapshot: f.productB.sku,
              quantity: "10",
              expectedUnitCost: "5",
            },
          ],
        },
      },
      include: { items: true },
    });
    const receipt = await createPrismaReceivingRepository(prisma, {
      now: () => new Date("2026-08-01T00:00:00.000Z"),
    }).receivePurchaseOrder({
      actorUserId: f.owner.user.id,
      organizationId: f.org.id,
      purchaseOrderId: order.id,
      idempotencyKey: randomUUID(),
      actualCosts: [
        { purchaseOrderItemId: order.items[0]!.id, actualUnitCost: "5" },
      ],
      vat: {
        inputVatAmount: null,
        inputVatRate: null,
        organizationVatRegistered: false,
        supplierTaxDocumentDate: null,
        supplierTaxDocumentNumber: null,
      },
    });
    expect(receipt.kind).toBe("success");
    const sale = await createPrismaCheckoutRepository(prisma, {
      now: () => new Date("2026-09-01T02:00:00.000Z"),
    }).checkout({
      actorUserId: f.owner.user.id,
      branchId: f.branchA.id,
      organizationId: f.org.id,
      idempotencyKey: randomUUID(),
      discount: null,
      items: [
        { productId: f.productB.id, quantity: "3", expectedUnitPrice: "10" },
      ],
      payment: { method: "CASH", amountTendered: "100" },
    });
    expect(sale.kind).toBe("success");
    if (sale.kind !== "success") return;
    const refundRepo = createPrismaRefundRepository(prisma, {
      now: () => new Date("2026-09-02T02:00:00.000Z"),
    });
    for (const restockQuantity of ["1", "0"]) {
      const refund = await refundRepo.createRefund({
        actorUserId: f.owner.user.id,
        branchId: f.branchA.id,
        organizationId: f.org.id,
        saleId: sale.sale.id,
        idempotencyKey: randomUUID(),
        reason: "Return",
        transferReference: null,
        items: [
          {
            saleItemId: sale.sale.items[0]!.id,
            quantity: "1",
            restockQuantity,
          },
        ],
      });
      expect(refund.kind).toBe("success");
    }
    await prisma.product.create({
      data: {
        id: firstDimensionProductId,
        organizationId: f.org.id,
        sku: "FIRST",
        name: "First dimension",
        unit: "EA",
        basePrice: "10",
      },
    });
    const outcome = await service().read(request(f.org.id, f.owner.user.id));
    expect(outcome.kind).toBe("success");
    if (outcome.kind !== "success") return;
    const row = outcome.page.series.find(
      (r) => r.branchId === f.branchA.id && r.productId === f.productB.id,
    )!;
    expect(row.buckets[0]?.saleDepletionQuantity).toBe("3.0000");
    expect(row.buckets[1]?.refundReturnQuantity).toBe("1.0000");
    expect(row.requestedPeriodAds.value).toBe("1.5000");
    expect(row.coverageSalesVelocity.value).toBe("0.1071");
    expect(row.onHandQuantity).toBe("8.0000");
    expect(row.coverageDays.value).toBe("74.67");
    expect(row.stockClassification).toEqual({
      classification: "OVERSTOCK",
      reason: null,
      thresholdVersion: "stock-risk-v1",
    });
    expect(row.cost?.inventoryValue.value).toBe("40.0000000000");
    expect(
      await prisma.inventoryTransaction.count({
        where: { source: "SALE_REFUND_RETURN" },
      }),
    ).toBe(1);
    const firstPage = await service().read({
      ...request(f.org.id, f.owner.user.id),
      limit: 1,
    });
    expect(firstPage.kind).toBe("success");
    if (firstPage.kind !== "success") return;
    expect(firstPage.page.series[0]?.productId).toBe(firstDimensionProductId);
    expect(firstPage.page.nextCursor).not.toBeNull();
    for (const [delta, quantity, inventoryValue, classification, at] of [
      ["-2", "6", "30", "NORMAL", "2026-09-05T00:00:00.000Z"],
      ["-6", "0", "0", "LOW_STOCK", "2026-09-06T00:00:00.000Z"],
    ] as const) {
      await manual({
        organizationId: f.org.id,
        branchId: f.branchA.id,
        productId: f.productB.id,
        actorUserId: f.owner.user.id,
        actorMembershipId: f.owner.membership.id,
        delta,
        occurredAt: new Date(at),
      });
      await prisma.inventoryBalance.update({
        where: {
          branchId_productId: {
            branchId: f.branchA.id,
            productId: f.productB.id,
          },
        },
        data: { quantity },
      });
      await prisma.inventoryCostState.update({
        where: {
          branchId_productId: {
            branchId: f.branchA.id,
            productId: f.productB.id,
          },
        },
        data: { inventoryValue },
      });
      const current = await service({ at: new Date(at) }).read({
        ...request(f.org.id, f.owner.user.id),
        ...(quantity === "6"
          ? { cursor: firstPage.page.nextCursor!, limit: 100 }
          : {}),
      });
      expect(current.kind).toBe("success");
      if (current.kind !== "success") return;
      if (quantity === "6") {
        expect(current.page.context.period.sourceCutoff).toEqual(
          firstPage.page.context.period.sourceCutoff,
        );
        expect(
          current.page.currentSnapshotCapturedAt.getTime(),
        ).toBeGreaterThan(firstPage.page.currentSnapshotCapturedAt.getTime());
      }
      const currentRow = current.page.series.find(
        (r) => r.branchId === f.branchA.id && r.productId === f.productB.id,
      )!;
      expect(currentRow.stockClassification.classification).toBe(
        classification,
      );
      expect(currentRow.stockClassification.reason).toBeNull();
      if (quantity === "0") {
        expect(currentRow.coverageDays.value).toBe("0.00");
        expect(currentRow.onHandQuantity).toBe("0.0000");
      }
    }
    if (receipt.kind === "success") {
      await prisma.purchaseReceiptItem.update({
        where: { id: receipt.receipt.items[0]!.id },
        data: { receivedQuantity: "9" },
      });
      const corrupted = await service().read(
        request(f.org.id, f.owner.user.id),
      );
      expect(corrupted.kind).toBe("success");
      if (corrupted.kind === "success") {
        expect(
          corrupted.page.series.find(
            (r) => r.productId === f.productB.id && r.branchId === f.branchA.id,
          )?.coverageDays.reason,
        ).toBe("INVENTORY_INTEGRITY_ERROR");
        expect(
          corrupted.page.series.find(
            (r) => r.productId === f.productB.id && r.branchId === f.branchA.id,
          )?.stockClassification,
        ).toEqual({
          classification: null,
          reason: "INVENTORY_INTEGRITY_ERROR",
          thresholdVersion: "stock-risk-v1",
        });
      }
    }
  });

  it("pages full buckets, includes lazy zero stock, reports Branch availability, and gates cost", async () => {
    const f = await fixture();
    await manual({
      organizationId: f.org.id,
      branchId: f.branchA.id,
      productId: f.productA.id,
      actorUserId: f.owner.user.id,
      actorMembershipId: f.owner.membership.id,
      delta: "5.2500",
      occurredAt: new Date("2026-08-01T00:00:00.000Z"),
    });
    await manual({
      organizationId: f.org.id,
      branchId: f.branchA.id,
      productId: f.productA.id,
      actorUserId: f.owner.user.id,
      actorMembershipId: f.owner.membership.id,
      delta: "-2.1250",
      occurredAt: new Date("2026-09-01T00:00:00.000Z"),
    });
    await prisma.inventoryBalance.create({
      data: {
        organizationId: f.org.id,
        branchId: f.branchA.id,
        productId: f.productA.id,
        quantity: "3.1250",
      },
    });
    await prisma.inventoryCostState.create({
      data: {
        organizationId: f.org.id,
        branchId: f.branchA.id,
        productId: f.productA.id,
        basisState: "KNOWN",
        averageUnitCost: "5.479360",
        inventoryValue: "17.1234567890",
      },
    });
    await manual({
      organizationId: f.org.id,
      branchId: f.branchA.id,
      productId: f.productC.id,
      actorUserId: f.owner.user.id,
      actorMembershipId: f.owner.membership.id,
      delta: "1",
      occurredAt: new Date("2026-09-01T00:00:00.000Z"),
    });
    await prisma.inventoryBalance.create({
      data: {
        organizationId: f.org.id,
        branchId: f.branchA.id,
        productId: f.productC.id,
        quantity: "1",
      },
    });
    const first = await service().read({
      ...request(f.org.id, f.owner.user.id),
      limit: 1,
    });
    expect(first.kind).toBe("success");
    if (first.kind !== "success") return;
    expect(first.page.series).toHaveLength(1);
    expect(first.page.series[0]?.buckets).toHaveLength(2);
    expect(first.page.branches).toHaveLength(2);
    const summaryA = first.page.branches.find(
      (b) => b.branchId === f.branchA.id,
    )!;
    expect(summaryA.activeProductCount).toBe(2);
    expect(summaryA.inStockProductCount).toBe(1);
    expect(summaryA.outOfStockProductCount).toBe(1);
    expect(summaryA.cost?.inventoryValue.reason).toBe(
      "INCOMPLETE_COST_COVERAGE",
    );
    expect(summaryA.cost?.knownInventoryValue).toBe("17.1234567890");
    expect(summaryA.cost?.unknownQuantityByUnit).toEqual({ EA: "1.0000" });
    const seen = [...first.page.series];
    let cursor = first.page.nextCursor;
    while (cursor !== null) {
      const next = await service({
        at: new Date("2026-09-05T00:00:00.000Z"),
      }).read({
        ...request(f.org.id, f.owner.user.id),
        limit: 1,
        cursor,
      });
      expect(next.kind).toBe("success");
      if (next.kind !== "success") break;
      expect(next.page.context.period.sourceCutoff).toEqual(
        first.page.context.period.sourceCutoff,
      );
      expect(next.page.currentSnapshotCapturedAt.getTime()).toBeGreaterThan(
        first.page.currentSnapshotCapturedAt.getTime(),
      );
      seen.push(...next.page.series);
      cursor = next.page.nextCursor;
    }
    expect(seen).toHaveLength(5);
    expect(
      seen.find(
        (row) =>
          row.productId === f.productC.id && row.branchId === f.branchA.id,
      )?.stockClassification,
    ).toEqual({
      classification: null,
      reason: "INACTIVE_PRODUCT",
      thresholdVersion: "stock-risk-v1",
    });
    expect(
      new Set(seen.map((row) => `${row.branchId}/${row.productId}`)).size,
    ).toBe(5);
    expect(
      seen.find(
        (row) =>
          row.productId === f.productA.id && row.branchId === f.branchA.id,
      )?.buckets[0]?.negativeAdjustmentQuantity,
    ).toBe("2.1250");
    expect(
      seen.find(
        (row) =>
          row.productId === f.productB.id && row.branchId === f.branchA.id,
      )?.onHandQuantity,
    ).toBe("0.0000");
    const staff = await service().read(request(f.org.id, f.staff.user.id));
    expect(staff.kind).toBe("success");
    if (staff.kind === "success") {
      expect(staff.page.branches).toHaveLength(1);
      expect(staff.page.branches[0]).not.toHaveProperty("cost");
      expect(
        staff.page.series.every((row) => !Object.hasOwn(row, "cost")),
      ).toBe(true);
      expect(
        staff.page.series.every((row) => row.stockClassification !== undefined),
      ).toBe(true);
    }
    expect(
      (await service().read(request(f.org.id, f.cashier.user.id))).kind,
    ).toBe("forbidden");
    expect(
      (await service().read(request(f.org.id, f.manager.user.id))).kind,
    ).toBe("success");
  });

  it("detects ledger divergence without inventing coverage", async () => {
    const f = await fixture();
    await manual({
      organizationId: f.org.id,
      branchId: f.branchA.id,
      productId: f.productA.id,
      actorUserId: f.owner.user.id,
      actorMembershipId: f.owner.membership.id,
      delta: "2",
      occurredAt: new Date("2026-08-01T00:00:00.000Z"),
    });
    await prisma.inventoryBalance.create({
      data: {
        organizationId: f.org.id,
        branchId: f.branchA.id,
        productId: f.productA.id,
        quantity: "3",
      },
    });
    const result = await service().read(request(f.org.id, f.owner.user.id));
    expect(result.kind).toBe("success");
    if (result.kind === "success")
      expect(
        result.page.series.find(
          (r) => r.productId === f.productA.id && r.branchId === f.branchA.id,
        )?.coverageDays.reason,
      ).toBe("INVENTORY_INTEGRITY_ERROR");
  });

  it("includes the exact event cutoff but excludes a later event while reconciling current stock", async () => {
    const f = await fixture();
    const at = new Date("2026-09-02T00:00:00.000Z");
    for (const occurredAt of [at, new Date(at.getTime() + 1)]) {
      await manual({
        organizationId: f.org.id,
        branchId: f.branchA.id,
        productId: f.productB.id,
        actorUserId: f.owner.user.id,
        actorMembershipId: f.owner.membership.id,
        delta: "1",
        occurredAt,
      });
    }
    await prisma.inventoryBalance.create({
      data: {
        organizationId: f.org.id,
        branchId: f.branchA.id,
        productId: f.productB.id,
        quantity: "2",
      },
    });
    const result = await service({ at }).read(
      request(f.org.id, f.owner.user.id),
    );
    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;
    const row = result.page.series.find(
      (r) => r.branchId === f.branchA.id && r.productId === f.productB.id,
    )!;
    expect(row.buckets[1]?.positiveAdjustmentQuantity).toBe("1.0000");
    expect(row.onHandQuantity).toBe("2.0000");
    expect(row.coverageDays.reason).toBe("INSUFFICIENT_DATA");
    expect(row.requestedPeriodAds.reason).toBe("INCOMPLETE_PERIOD");
  });

  it("reauthorizes a continuation after its Branch assignment becomes inactive", async () => {
    const f = await fixture();
    const first = await service().read({
      ...request(f.org.id, f.staff.user.id),
      limit: 1,
    });
    expect(first.kind).toBe("success");
    if (first.kind !== "success") return;
    expect(first.page.nextCursor).not.toBeNull();
    const staleContext = first.page.context;
    await prisma.branch.update({
      where: { id: f.branchA.id },
      data: { status: "INACTIVE", deactivatedAt: cutoff },
    });
    const denied = await service().read({
      ...request(f.org.id, f.staff.user.id),
      limit: 1,
      cursor: first.page.nextCursor!,
    });
    expect(denied.kind).toBe("forbidden");
    await expect(
      createPrismaAnalyticsInventoryRepository(prisma, cursorCodec, {
        now: () => cutoff,
      }).read(staleContext, 1, null, false, f.staff.user.id, {
        kind: "organization",
      }),
    ).rejects.toThrowError(/cursor/i);
    const owner = await service().read(request(f.org.id, f.owner.user.id));
    expect(owner.kind).toBe("success");
    if (owner.kind === "success")
      expect(
        owner.page.branches.find((b) => b.branchId === f.branchA.id)
          ?.branchStatus,
      ).toBe("INACTIVE");
  });

  it("holds movement and mutable projections in one repeatable-read page snapshot", async () => {
    const f = await fixture();
    await manual({
      organizationId: f.org.id,
      branchId: f.branchA.id,
      productId: f.productA.id,
      actorUserId: f.owner.user.id,
      actorMembershipId: f.owner.membership.id,
      delta: "2",
      occurredAt: new Date("2026-08-01T00:00:00.000Z"),
    });
    const balance = await prisma.inventoryBalance.create({
      data: {
        organizationId: f.org.id,
        branchId: f.branchA.id,
        productId: f.productA.id,
        quantity: "2",
      },
    });
    const captured = service({
      databaseClock: true,
      afterSnapshotCaptured: async () => {
        await prisma.$transaction(async (tx) => {
          await tx.inventoryTransaction.create({
            data: {
              organizationId: f.org.id,
              branchId: f.branchA.id,
              productId: f.productA.id,
              actorUserId: f.owner.user.id,
              actorMembershipId: f.owner.membership.id,
              delta: "1",
              occurredAt: new Date("2026-09-01T00:00:00.000Z"),
              source: "MANUAL_ADJUSTMENT",
              adjustmentReason: "FOUND",
              idempotencyKeyHash: randomBytes(32).toString("hex"),
              canonicalRequestHash: randomBytes(32).toString("hex"),
            },
          });
          await tx.inventoryBalance.update({
            where: { id: balance.id },
            data: { quantity: "3" },
          });
        });
      },
    });
    const before = new Date();
    const first = await captured.read(request(f.org.id, f.owner.user.id));
    const after = new Date();
    expect(first.kind).toBe("success");
    if (first.kind !== "success") return;
    expect(
      first.page.currentSnapshotCapturedAt.getTime(),
    ).toBeGreaterThanOrEqual(before.getTime());
    expect(first.page.currentSnapshotCapturedAt.getTime()).toBeLessThanOrEqual(
      after.getTime(),
    );
    expect(first.page.context.period.sourceCutoff).toEqual(
      first.page.currentSnapshotCapturedAt,
    );
    const firstRow = first.page.series.find(
      (r) => r.branchId === f.branchA.id && r.productId === f.productA.id,
    )!;
    expect(firstRow.onHandQuantity).toBe("2.0000");
    expect(firstRow.buckets[0]?.positiveAdjustmentQuantity).toBe("0.0000");
    expect(firstRow.coverageDays.reason).not.toBe("INVENTORY_INTEGRITY_ERROR");
    const next = await service().read(request(f.org.id, f.owner.user.id));
    expect(next.kind).toBe("success");
    if (next.kind === "success") {
      const row = next.page.series.find(
        (r) => r.branchId === f.branchA.id && r.productId === f.productA.id,
      )!;
      expect(row.onHandQuantity).toBe("3.0000");
      expect(row.buckets[0]?.positiveAdjustmentQuantity).toBe("1.0000");
    }
  });

  it("allows a fact committed after page one to enter a later page at the original event cutoff", async () => {
    const f = await fixture();
    const targetBranchId = [f.branchA.id, f.branchB.id].sort().at(-1)!;
    const targetProductId = [f.productA.id, f.productB.id].sort().at(-1)!;
    const ready = Promise.withResolvers<Date>();
    const release = Promise.withResolvers<void>();
    const writer = prisma.$transaction(
      async (tx) => {
        const captured = await tx.$queryRaw<
          Array<{ occurredAt: Date }>
        >`SELECT clock_timestamp() AS "occurredAt"`;
        const occurredAt = captured[0]!.occurredAt;
        await tx.inventoryTransaction.create({
          data: {
            organizationId: f.org.id,
            branchId: targetBranchId,
            productId: targetProductId,
            actorUserId: f.owner.user.id,
            actorMembershipId: f.owner.membership.id,
            delta: "1",
            occurredAt,
            source: "MANUAL_ADJUSTMENT",
            adjustmentReason: "FOUND",
            idempotencyKeyHash: randomBytes(32).toString("hex"),
            canonicalRequestHash: randomBytes(32).toString("hex"),
          },
        });
        await tx.inventoryBalance.create({
          data: {
            organizationId: f.org.id,
            branchId: targetBranchId,
            productId: targetProductId,
            quantity: "1",
          },
        });
        ready.resolve(occurredAt);
        await release.promise;
      },
      { timeout: 20_000 },
    );
    void writer.catch(ready.reject);
    try {
      const occurredAt = await ready.promise;
      const localDate = Temporal.Instant.fromEpochMilliseconds(
        occurredAt.getTime(),
      )
        .toZonedDateTimeISO("Asia/Bangkok")
        .toPlainDate();
      const pageRequest = {
        ...request(f.org.id, f.owner.user.id),
        from: localDate.toString(),
        to: localDate.add({ days: 1 }).toString(),
        limit: 1,
      };
      const first = await service({
        at: occurredAt,
        databaseClock: true,
        afterSnapshotCaptured: async () => {
          release.resolve();
          await writer;
        },
      }).read(pageRequest);
      expect(first.kind).toBe("success");
      if (first.kind !== "success") return;
      expect(occurredAt.getTime()).toBeLessThanOrEqual(
        first.page.context.period.sourceCutoff.getTime(),
      );
      expect(first.page.nextCursor).not.toBeNull();
      expect(
        first.page.branches.find((branch) => branch.branchId === targetBranchId)
          ?.inStockProductCount,
      ).toBe(0);
      let cursor = first.page.nextCursor;
      let found = false;
      while (cursor !== null) {
        const next = await service({ databaseClock: true }).read({
          ...pageRequest,
          cursor,
        });
        expect(next.kind).toBe("success");
        if (next.kind !== "success") return;
        expect(next.page.context.period.sourceCutoff).toEqual(
          first.page.context.period.sourceCutoff,
        );
        const row = next.page.series.find(
          (dimension) =>
            dimension.branchId === targetBranchId &&
            dimension.productId === targetProductId,
        );
        if (row !== undefined) {
          expect(row.buckets[0]?.positiveAdjustmentQuantity).toBe("1.0000");
          expect(row.onHandQuantity).toBe("1.0000");
          expect(
            next.page.branches.find(
              (branch) => branch.branchId === targetBranchId,
            )?.inStockProductCount,
          ).toBe(1);
          found = true;
        }
        cursor = next.page.nextCursor;
      }
      expect(found).toBe(true);
    } finally {
      release.resolve();
      await writer;
    }
  });
});
