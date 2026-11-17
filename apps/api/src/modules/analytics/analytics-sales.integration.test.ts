import { randomUUID } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { Prisma } from "../../generated/prisma/client.ts";
import {
  createTestPrismaClient,
  resetTestDatabase,
} from "../../test/database-harness.ts";
import { loadTestDatabaseEnvironment } from "../../test/database-environment.ts";
import { createPrismaCheckoutRepository } from "../sales/checkout-repository.ts";
import { createPrismaRefundRepository } from "../sales/refund-repository.ts";
import { createAnalyticsContextEngine } from "./analytics-context.ts";
import { createPrismaAnalyticsSalesRepository } from "./analytics-sales-repository.ts";
import { createAnalyticsSalesService } from "./analytics-sales-service.ts";
import { createPrismaAnalyticsScopeRepository } from "./analytics-scope-repository.ts";

const environment = loadTestDatabaseEnvironment();
const prisma = createTestPrismaClient(environment);

type Role =
  "OWNER" | "ADMIN" | "BRANCH_MANAGER" | "INVENTORY_STAFF" | "CASHIER";

async function createActor(input: {
  assignedBranchIds?: readonly string[];
  organizationId: string;
  role: Role;
}) {
  const user = await prisma.user.create({
    data: {
      displayName: `${input.role} Analytics Actor`,
      email: `${randomUUID()}@example.test`,
      emailVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
    },
  });
  await prisma.organizationMembership.create({
    data: {
      organizationId: input.organizationId,
      role: input.role,
      userId: user.id,
    },
  });
  if ((input.assignedBranchIds?.length ?? 0) > 0) {
    await prisma.branchAssignment.createMany({
      data: input.assignedBranchIds!.map((branchId) => ({
        branchId,
        organizationId: input.organizationId,
        userId: user.id,
      })),
    });
  }
  return user;
}

async function createStock(input: {
  basisState: "KNOWN" | "UNKNOWN";
  branchId: string;
  organizationId: string;
  productId: string;
  quantity: string;
  unitCost?: string;
}) {
  await prisma.inventoryBalance.create({
    data: {
      branchId: input.branchId,
      organizationId: input.organizationId,
      productId: input.productId,
      quantity: input.quantity,
    },
  });
  const unitCost =
    input.basisState === "KNOWN" ? (input.unitCost ?? "1") : null;
  await prisma.inventoryCostState.create({
    data: {
      averageUnitCost: unitCost,
      basisState: input.basisState,
      branchId: input.branchId,
      inventoryValue:
        unitCost === null
          ? null
          : new Prisma.Decimal(input.quantity).times(unitCost).toFixed(10),
      organizationId: input.organizationId,
      productId: input.productId,
    },
  });
}

async function checkout(input: {
  actorUserId: string;
  branchId: string;
  completedAt: Date;
  discountPercent?: string;
  organizationId: string;
  productId: string;
  quantity: string;
  unitPrice: string;
}) {
  const outcome = await createPrismaCheckoutRepository(prisma, {
    now: () => input.completedAt,
  }).checkout({
    actorUserId: input.actorUserId,
    branchId: input.branchId,
    discount:
      input.discountPercent === undefined
        ? null
        : {
            percent: input.discountPercent,
            reason: "Analytics fixture",
            type: "PERCENT",
          },
    idempotencyKey: randomUUID(),
    items: [
      {
        expectedUnitPrice: input.unitPrice,
        productId: input.productId,
        quantity: input.quantity,
      },
    ],
    organizationId: input.organizationId,
    payment: { amountTendered: "10000", method: "CASH" },
  });
  if (outcome.kind !== "success") {
    throw new Error(`Analytics checkout fixture failed: ${outcome.kind}`);
  }
  return outcome.sale;
}

function service(sourceCutoff: Date) {
  return createAnalyticsSalesService({
    contextEngine: createAnalyticsContextEngine({
      now: () => sourceCutoff,
      scopeRepository: createPrismaAnalyticsScopeRepository(prisma),
    }),
    repository: createPrismaAnalyticsSalesRepository(prisma),
  });
}

describe("base sales analytics with PostgreSQL", () => {
  beforeEach(async () => resetTestDatabase(environment));
  afterAll(async () => {
    await resetTestDatabase(environment);
    await prisma.$disconnect();
  });

  it("uses one statement snapshot, exact persisted allocations, authorized Branch scope, and one cutoff", async () => {
    const organization = await prisma.organization.create({
      data: {
        name: "Scoped Sales Analytics",
        reportingTimezone: "Asia/Bangkok",
        salesVatRate: "7",
        salesVatStatus: "REGISTERED",
      },
    });
    const [branchA, branchB] = await Promise.all([
      prisma.branch.create({
        data: {
          code: "A",
          name: "Branch A",
          organizationId: organization.id,
        },
      }),
      prisma.branch.create({
        data: {
          code: "B",
          name: "Branch B",
          organizationId: organization.id,
        },
      }),
    ]);
    const owner = await createActor({
      organizationId: organization.id,
      role: "OWNER",
    });
    const manager = await createActor({
      assignedBranchIds: [branchA.id],
      organizationId: organization.id,
      role: "BRANCH_MANAGER",
    });
    const product = await prisma.product.create({
      data: {
        basePrice: "107",
        name: "Registered Product",
        organizationId: organization.id,
        sku: "REGISTERED-107",
        unit: "EA",
      },
    });
    await Promise.all([
      createStock({
        basisState: "KNOWN",
        branchId: branchA.id,
        organizationId: organization.id,
        productId: product.id,
        quantity: "10",
        unitCost: "60",
      }),
      createStock({
        basisState: "KNOWN",
        branchId: branchB.id,
        organizationId: organization.id,
        productId: product.id,
        quantity: "10",
        unitCost: "50",
      }),
    ]);

    await checkout({
      actorUserId: owner.id,
      branchId: branchA.id,
      completedAt: new Date("2026-09-19T17:00:00.000Z"),
      discountPercent: "10",
      organizationId: organization.id,
      productId: product.id,
      quantity: "1",
      unitPrice: "107",
    });
    await checkout({
      actorUserId: owner.id,
      branchId: branchB.id,
      completedAt: new Date("2026-09-20T04:00:00.000Z"),
      organizationId: organization.id,
      productId: product.id,
      quantity: "2",
      unitPrice: "107",
    });
    await checkout({
      actorUserId: owner.id,
      branchId: branchA.id,
      completedAt: new Date("2026-09-21T09:00:00.000Z"),
      organizationId: organization.id,
      productId: product.id,
      quantity: "1",
      unitPrice: "107",
    });
    await checkout({
      actorUserId: owner.id,
      branchId: branchA.id,
      completedAt: new Date("2026-09-21T10:00:00.000Z"),
      organizationId: organization.id,
      productId: product.id,
      quantity: "1",
      unitPrice: "107",
    });
    await prisma.product.update({
      data: { basePrice: "999" },
      where: { id: product.id },
    });
    await prisma.organization.update({
      data: { salesVatRate: null, salesVatStatus: "NOT_REGISTERED" },
      where: { id: organization.id },
    });

    const querySpy = vi.spyOn(prisma, "$queryRaw");
    const analytics = service(new Date("2026-09-21T09:00:00.000Z"));
    const ownerOutcome = await analytics.read({
      actorUserId: owner.id,
      from: "2026-09-20",
      granularity: "day",
      organizationId: organization.id,
      scope: { kind: "organization" },
      to: "2026-09-22",
    });
    expect(querySpy).toHaveBeenCalledTimes(1);
    querySpy.mockRestore();
    expect(ownerOutcome.kind).toBe("success");
    if (ownerOutcome.kind !== "success") return;
    expect(ownerOutcome.metrics.metricDefinitionVersion).toBe("analytics-v1");
    expect(ownerOutcome.metrics.context.period.sourceCutoff.toISOString()).toBe(
      "2026-09-21T09:00:00.000Z",
    );
    expect(ownerOutcome.metrics.context.scope.branchIds).toEqual(
      [branchA.id, branchB.id].sort(),
    );
    expect(ownerOutcome.metrics.buckets[0]).toMatchObject({
      averageOrderValue: { reason: null, value: "155.15" },
      dataStatus: "complete",
      discountAmount: "10.70",
      grossSalesAmount: "321.00",
      netOutputVatAmount: "20.30",
      netSalesAmount: "310.30",
      outputVatAmount: "20.30",
      registeredTaxableSalesAmount: { reason: null, value: "290.00" },
      saleCount: 2,
      salesAfterDiscountAmount: "310.30",
    });
    expect(ownerOutcome.metrics.buckets[0]?.cost).toMatchObject({
      costCoverage: "complete",
      grossProfitAmount: { reason: null, value: "150.3000000000" },
      netCogsAmount: { reason: null, value: "160.0000000000" },
    });
    expect(ownerOutcome.metrics.buckets[1]).toMatchObject({
      dataStatus: "partial",
      grossSalesAmount: "107.00",
      netSalesGrowthPercent: {
        reason: "NON_COMPARABLE_PERIOD",
        value: null,
      },
      outputVatAmount: "7.00",
      registeredTaxableSalesAmount: { reason: null, value: "100.00" },
      saleCount: 1,
    });

    const managerOutcome = await analytics.read({
      actorUserId: manager.id,
      from: "2026-09-20",
      granularity: "day",
      organizationId: organization.id,
      scope: { kind: "organization" },
      to: "2026-09-21",
    });
    expect(managerOutcome.kind).toBe("success");
    if (managerOutcome.kind !== "success") return;
    expect(managerOutcome.metrics.context.scope.branchIds).toEqual([
      branchA.id,
    ]);
    expect(managerOutcome.metrics.buckets[0]).toMatchObject({
      discountAmount: "10.70",
      grossSalesAmount: "107.00",
      netSalesAmount: "96.30",
      saleCount: 1,
    });
  });

  it("attributes sequential refunds to refund time without removing the original Sale", async () => {
    const organization = await prisma.organization.create({
      data: {
        name: "Refund Analytics",
        reportingTimezone: "Asia/Bangkok",
        salesVatStatus: "NOT_REGISTERED",
      },
    });
    const branch = await prisma.branch.create({
      data: {
        code: "MAIN",
        name: "Main",
        organizationId: organization.id,
      },
    });
    const owner = await createActor({
      organizationId: organization.id,
      role: "OWNER",
    });
    const product = await prisma.product.create({
      data: {
        basePrice: "50",
        name: "Refund Product",
        organizationId: organization.id,
        sku: "REFUND-50",
        unit: "KG",
      },
    });
    await createStock({
      basisState: "KNOWN",
      branchId: branch.id,
      organizationId: organization.id,
      productId: product.id,
      quantity: "10",
      unitCost: "30",
    });
    const sale = await checkout({
      actorUserId: owner.id,
      branchId: branch.id,
      completedAt: new Date("2026-09-18T03:00:00.000Z"),
      organizationId: organization.id,
      productId: product.id,
      quantity: "2",
      unitPrice: "50",
    });
    const refundRepository = createPrismaRefundRepository(prisma, {
      now: () => new Date("2026-09-20T03:00:00.000Z"),
    });
    for (let index = 0; index < 2; index += 1) {
      const outcome = await refundRepository.createRefund({
        actorUserId: owner.id,
        branchId: branch.id,
        idempotencyKey: randomUUID(),
        items: [
          {
            quantity: "1",
            restockQuantity: "0.5",
            saleItemId: sale.items[0]!.id,
          },
        ],
        organizationId: organization.id,
        reason: "Sequential analytics refund",
        saleId: sale.id,
        transferReference: null,
      });
      expect(outcome.kind).toBe("success");
    }

    const outcome = await service(new Date("2026-09-22T00:00:00.000Z")).read({
      actorUserId: owner.id,
      from: "2026-09-18",
      granularity: "day",
      organizationId: organization.id,
      scope: { kind: "organization" },
      to: "2026-09-21",
    });
    expect(outcome.kind).toBe("success");
    if (outcome.kind !== "success") return;

    expect(outcome.metrics.buckets[0]).toMatchObject({
      refundCount: 0,
      saleCount: 1,
      salesAfterDiscountAmount: "100.00",
    });
    expect(outcome.metrics.buckets[2]).toMatchObject({
      grossSalesAmount: "0.00",
      netSalesAmount: "-100.00",
      outputVatAmount: "0.00",
      refundAmount: "100.00",
      refundCount: 2,
      refundedOutputVatAmount: "0.00",
      refundedRegisteredTaxableAmount: {
        reason: "NO_REGISTERED_REFUNDS",
        value: null,
      },
      refundedSaleCount: 1,
      registeredTaxableSalesAmount: {
        reason: "NO_REGISTERED_SALES",
        value: null,
      },
      saleCount: 0,
    });
    expect(outcome.metrics.buckets[2]?.cost).toMatchObject({
      grossProfitAmount: { reason: null, value: "-70.0000000000" },
      netCogsAmount: { reason: null, value: "-30.0000000000" },
      refundCogsReversalAmount: "30.0000000000",
    });
  });

  it("uses a negative-offset DST boundary and preserves UNKNOWN cost as unavailable", async () => {
    const organization = await prisma.organization.create({
      data: {
        name: "DST Analytics",
        reportingTimezone: "America/New_York",
        salesVatStatus: "NOT_REGISTERED",
      },
    });
    const branch = await prisma.branch.create({
      data: {
        code: "DST",
        name: "DST Branch",
        organizationId: organization.id,
      },
    });
    const owner = await createActor({
      organizationId: organization.id,
      role: "OWNER",
    });
    const product = await prisma.product.create({
      data: {
        basePrice: "120",
        name: "DST Product",
        organizationId: organization.id,
        sku: "DST-120",
        unit: "EA",
      },
    });
    await createStock({
      basisState: "UNKNOWN",
      branchId: branch.id,
      organizationId: organization.id,
      productId: product.id,
      quantity: "3",
    });
    await checkout({
      actorUserId: owner.id,
      branchId: branch.id,
      completedAt: new Date("2026-03-08T05:00:00.000Z"),
      organizationId: organization.id,
      productId: product.id,
      quantity: "1",
      unitPrice: "120",
    });
    await checkout({
      actorUserId: owner.id,
      branchId: branch.id,
      completedAt: new Date("2026-03-09T04:00:00.000Z"),
      organizationId: organization.id,
      productId: product.id,
      quantity: "1",
      unitPrice: "120",
    });

    const outcome = await service(new Date("2026-03-10T00:00:00.000Z")).read({
      actorUserId: owner.id,
      from: "2026-03-08",
      granularity: "day",
      organizationId: organization.id,
      scope: { kind: "organization" },
      to: "2026-03-09",
    });
    expect(outcome.kind).toBe("success");
    if (outcome.kind !== "success") return;

    expect(outcome.metrics.buckets[0]).toMatchObject({
      bucketEndExclusive: new Date("2026-03-09T04:00:00.000Z"),
      bucketStartInclusive: new Date("2026-03-08T05:00:00.000Z"),
      grossSalesAmount: "120.00",
      saleCount: 1,
    });
    expect(outcome.metrics.buckets[0]?.cost).toMatchObject({
      costCoverage: "none",
      grossProfitAmount: {
        reason: "INCOMPLETE_COST_COVERAGE",
        value: null,
      },
      unknownCostLineCount: 1,
    });
  });
});
