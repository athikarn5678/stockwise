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
import { createPrismaAnalyticsBranchRepository } from "./analytics-branch-repository.ts";
import { createAnalyticsBranchService } from "./analytics-branch-service.ts";
import { createPrismaAnalyticsCategoryRepository } from "./analytics-category-repository.ts";
import { createAnalyticsCategoryService } from "./analytics-category-service.ts";
import { createAnalyticsContextEngine } from "./analytics-context.ts";
import { createAnalyticsDimensionCursorCodec } from "./analytics-dimension-cursor.ts";
import { createPrismaAnalyticsSalesRepository } from "./analytics-sales-repository.ts";
import { createAnalyticsSalesService } from "./analytics-sales-service.ts";
import { createPrismaAnalyticsScopeRepository } from "./analytics-scope-repository.ts";

const environment = loadTestDatabaseEnvironment();
const prisma = createTestPrismaClient(environment);
const cutoff = new Date("2026-09-23T00:00:00.000Z");
const cursorCodec = createAnalyticsDimensionCursorCodec(Buffer.alloc(32, 1));

function services(sourceCutoff = cutoff) {
  const contextEngine = createAnalyticsContextEngine({
    now: () => sourceCutoff,
    scopeRepository: createPrismaAnalyticsScopeRepository(prisma),
  });
  return {
    branch: createAnalyticsBranchService({
      contextEngine,
      cursorCodec,
      repository: createPrismaAnalyticsBranchRepository(prisma, cursorCodec),
    }),
    category: createAnalyticsCategoryService({
      contextEngine,
      cursorCodec,
      repository: createPrismaAnalyticsCategoryRepository(prisma, cursorCodec),
    }),
    sales: createAnalyticsSalesService({
      contextEngine,
      repository: createPrismaAnalyticsSalesRepository(prisma),
    }),
  };
}

async function actor(
  organizationId: string,
  role: "OWNER" | "ADMIN" | "BRANCH_MANAGER" | "CASHIER",
  branchId?: string,
) {
  const user = await prisma.user.create({
    data: {
      displayName: "Analytics actor",
      email: `${randomUUID()}@example.test`,
      emailVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
    },
  });
  await prisma.organizationMembership.create({
    data: { organizationId, role, userId: user.id },
  });
  if (branchId !== undefined)
    await prisma.branchAssignment.create({
      data: {
        branchId,
        organizationId,
        userId: user.id,
      },
    });
  return user;
}

async function stock(
  organizationId: string,
  branchId: string,
  productId: string,
  unitCost: string | null,
) {
  await prisma.inventoryBalance.create({
    data: {
      branchId,
      organizationId,
      productId,
      quantity: "10",
    },
  });
  await prisma.inventoryCostState.create({
    data: {
      averageUnitCost: unitCost,
      basisState: unitCost === null ? "UNKNOWN" : "KNOWN",
      branchId,
      inventoryValue:
        unitCost === null
          ? null
          : new Prisma.Decimal(unitCost).times(10).toFixed(10),
      organizationId,
      productId,
    },
  });
}

async function checkout(input: {
  actorUserId: string;
  branchId: string;
  completedAt: string;
  discountPercent?: string;
  organizationId: string;
  productId: string;
  unitPrice: string;
}) {
  const outcome = await createPrismaCheckoutRepository(prisma, {
    now: () => new Date(input.completedAt),
  }).checkout({
    actorUserId: input.actorUserId,
    branchId: input.branchId,
    discount:
      input.discountPercent === undefined
        ? null
        : {
            percent: input.discountPercent,
            reason: "Dimension fixture",
            type: "PERCENT",
          },
    idempotencyKey: randomUUID(),
    items: [
      {
        expectedUnitPrice: input.unitPrice,
        productId: input.productId,
        quantity: "1",
      },
    ],
    organizationId: input.organizationId,
    payment: { amountTendered: "1000", method: "CASH" },
  });
  if (outcome.kind !== "success")
    throw new Error(`Fixture checkout: ${outcome.kind}`);
  return outcome.sale;
}

const requestPeriod = {
  from: "2026-09-20",
  granularity: "day" as const,
  to: "2026-09-23",
};

describe("Category and Branch analytics with PostgreSQL", () => {
  beforeEach(async () => resetTestDatabase(environment));
  afterAll(async () => {
    await resetTestDatabase(environment);
    await prisma.$disconnect();
  });

  it("reclassifies history, reconciles additive buckets, pages complete series and applies authorization", async () => {
    const organization = await prisma.organization.create({
      data: {
        name: "Dimension analytics",
        reportingTimezone: "Asia/Bangkok",
        salesVatStatus: "NOT_REGISTERED",
      },
    });
    const [branchA, branchB, branchC] = await Promise.all(
      ["A", "B", "C"].map((code) =>
        prisma.branch.create({
          data: { code, name: code, organizationId: organization.id },
        }),
      ),
    );
    const owner = await actor(organization.id, "OWNER");
    const admin = await actor(organization.id, "ADMIN");
    const manager = await actor(organization.id, "BRANCH_MANAGER", branchA!.id);
    const cashier = await actor(organization.id, "CASHIER", branchA!.id);
    const [categoryA, categoryB] = await Promise.all(
      ["Alpha", "Beta"].map((name) =>
        prisma.category.create({
          data: {
            name,
            normalizedName: name.toLowerCase(),
            organizationId: organization.id,
          },
        }),
      ),
    );
    const [productA, productB, productUncategorized] = await Promise.all([
      prisma.product.create({
        data: {
          basePrice: "10",
          categoryId: categoryA!.id,
          name: "A product",
          organizationId: organization.id,
          sku: "A",
          unit: "EA",
        },
      }),
      prisma.product.create({
        data: {
          basePrice: "20",
          categoryId: categoryB!.id,
          name: "B product",
          organizationId: organization.id,
          sku: "B",
          unit: "EA",
        },
      }),
      prisma.product.create({
        data: {
          basePrice: "30",
          name: "Other product",
          organizationId: organization.id,
          sku: "OTHER",
          unit: "EA",
        },
      }),
    ]);
    for (const branch of [branchA!, branchB!]) {
      for (const product of [productA!, productB!, productUncategorized!]) {
        await stock(
          organization.id,
          branch.id,
          product.id,
          product.id === productB!.id ? null : "2",
        );
      }
    }
    const saleA = await checkout({
      actorUserId: owner.id,
      branchId: branchA!.id,
      completedAt: "2026-09-19T17:00:00.000Z",
      discountPercent: "10",
      organizationId: organization.id,
      productId: productA!.id,
      unitPrice: "10",
    });
    await checkout({
      actorUserId: owner.id,
      branchId: branchB!.id,
      completedAt: "2026-09-20T17:00:00.000Z",
      organizationId: organization.id,
      productId: productB!.id,
      unitPrice: "20",
    });
    await checkout({
      actorUserId: owner.id,
      branchId: branchA!.id,
      completedAt: "2026-09-20T18:00:00.000Z",
      organizationId: organization.id,
      productId: productUncategorized!.id,
      unitPrice: "30",
    });
    const refund = await createPrismaRefundRepository(prisma, {
      now: () => new Date("2026-09-21T17:00:00.000Z"),
    }).createRefund({
      actorUserId: owner.id,
      branchId: branchA!.id,
      idempotencyKey: randomUUID(),
      items: [
        { quantity: "1", restockQuantity: "0", saleItemId: saleA.items[0]!.id },
      ],
      organizationId: organization.id,
      reason: "Dimension fixture",
      saleId: saleA.id,
      transferReference: null,
    });
    expect(refund.kind).toBe("success");
    await prisma.product.update({
      where: { id: productA!.id },
      data: { categoryId: categoryB!.id },
    });
    await prisma.category.update({
      where: { id: categoryB!.id },
      data: { name: "Renamed Beta", status: "INACTIVE" },
    });
    await prisma.branch.update({
      where: { id: branchB!.id },
      data: {
        status: "INACTIVE",
        deactivatedAt: new Date("2026-09-22T00:00:00.000Z"),
      },
    });

    const input = {
      actorUserId: owner.id,
      organizationId: organization.id,
      scope: { kind: "organization" as const },
      ...requestPeriod,
    };
    const querySpy = vi.spyOn(prisma, "$queryRaw");
    const category = await services().category.read(input);
    const branch = await services().branch.read(input);
    const sales = await services().sales.read(input);
    expect(querySpy).toHaveBeenCalledTimes(3);
    querySpy.mockRestore();
    expect(category.kind).toBe("success");
    expect(branch.kind).toBe("success");
    expect(sales.kind).toBe("success");
    if (
      category.kind !== "success" ||
      branch.kind !== "success" ||
      sales.kind !== "success"
    )
      return;
    const requestWithCutoff = {
      ...input,
      sourceCutoff: new Date("2030-01-01T00:00:00.000Z"),
    };
    const extraCategory = await services().category.read(requestWithCutoff);
    const extraBranch = await services().branch.read(requestWithCutoff);
    expect(extraCategory.kind).toBe("success");
    expect(extraBranch.kind).toBe("success");
    if (extraCategory.kind === "success" && extraBranch.kind === "success") {
      expect(extraCategory.page.context.period.sourceCutoff).toEqual(cutoff);
      expect(extraBranch.page.context.period.sourceCutoff).toEqual(cutoff);
    }
    expect(category.page.series.map((series) => series.categoryId)).toEqual([
      categoryB!.id,
      null,
    ]);
    expect(category.page.series[0]).toMatchObject({
      categoryName: "Renamed Beta",
      categoryStatus: "INACTIVE",
      buckets: [
        {
          grossSalesAmount: "10.00",
          discountAmount: "1.00",
          salesAfterDiscountAmount: "9.00",
        },
        { salesAfterDiscountAmount: "20.00" },
        { refundAmount: "9.00", netSalesAmount: "-9.00" },
      ],
    });
    expect(category.page.series[1]?.buckets[1]).toMatchObject({
      categorySharePercent: { reason: null, value: "60.00" },
      salesAfterDiscountAmount: "30.00",
    });
    expect(branch.page.series.map((series) => series.branchId)).toEqual(
      [branchA!.id, branchB!.id, branchC!.id].sort(),
    );
    expect(
      branch.page.series.find((series) => series.branchId === branchC!.id)
        ?.buckets,
    ).toHaveLength(3);
    expect(
      branch.page.series.find((series) => series.branchId === branchB!.id)
        ?.branchStatus,
    ).toBe("INACTIVE");
    expect(
      branch.page.series.find((series) => series.branchId === branchB!.id)
        ?.buckets[1]?.cost?.costCoverage,
    ).toBe("none");

    for (let index = 0; index < 3; index += 1) {
      for (const field of [
        "grossSalesAmount",
        "discountAmount",
        "salesAfterDiscountAmount",
        "refundAmount",
        "netSalesAmount",
      ] as const) {
        const categoryTotal = category.page.series.reduce(
          (sum, series) => sum.plus(series.buckets[index]![field]),
          new Prisma.Decimal(0),
        );
        const branchTotal = branch.page.series.reduce(
          (sum, series) => sum.plus(series.buckets[index]![field]),
          new Prisma.Decimal(0),
        );
        expect(categoryTotal.toFixed(2)).toBe(
          sales.metrics.buckets[index]![field],
        );
        expect(branchTotal.toFixed(2)).toBe(
          sales.metrics.buckets[index]![field],
        );
      }
      for (const field of [
        "outputVatAmount",
        "refundedDiscountAmount",
        "refundedOutputVatAmount",
        "netOutputVatAmount",
      ] as const) {
        const total = branch.page.series.reduce(
          (sum, series) => sum.plus(series.buckets[index]![field]),
          new Prisma.Decimal(0),
        );
        expect(total.toFixed(2)).toBe(sales.metrics.buckets[index]![field]);
      }
      for (const field of [
        "saleCount",
        "refundCount",
        "refundedSaleCount",
      ] as const) {
        const total = branch.page.series.reduce(
          (sum, series) => sum + series.buckets[index]![field],
          0,
        );
        expect(total).toBe(sales.metrics.buckets[index]![field]);
      }
      for (const field of [
        "knownCostLineCount",
        "unknownCostLineCount",
      ] as const) {
        const total = branch.page.series.reduce(
          (sum, series) => sum + series.buckets[index]!.cost![field],
          0,
        );
        expect(total).toBe(sales.metrics.buckets[index]!.cost![field]);
      }
    }

    const firstCategory = await services().category.read({
      ...input,
      limit: 1,
    });
    expect(firstCategory.kind).toBe("success");
    if (firstCategory.kind !== "success") return;
    expect(firstCategory.page.series[0]?.buckets).toHaveLength(3);
    expect(firstCategory.page.nextCursor).not.toBeNull();
    const nextCategory = await services(
      new Date("2026-09-24T00:00:00.000Z"),
    ).category.read({
      ...input,
      limit: 1,
      cursor: firstCategory.page.nextCursor!,
    });
    expect(nextCategory.kind).toBe("success");
    if (nextCategory.kind === "success") {
      expect(nextCategory.page.series[0]?.categoryKind).toBe("UNCATEGORIZED");
      expect(nextCategory.page.context.period.sourceCutoff).toEqual(cutoff);
      expect(nextCategory.page.nextCursor).toBeNull();
    }
    const firstBranch = await services().branch.read({ ...input, limit: 1 });
    expect(firstBranch.kind).toBe("success");
    if (firstBranch.kind !== "success") return;
    const secondBranch = await services().branch.read({
      ...input,
      limit: 1,
      cursor: firstBranch.page.nextCursor!,
    });
    expect(secondBranch.kind).toBe("success");
    if (secondBranch.kind === "success")
      expect(secondBranch.page.series[0]?.branchId).not.toBe(
        firstBranch.page.series[0]?.branchId,
      );
    expect(
      await services().branch.read({
        ...input,
        actorUserId: manager.id,
        limit: 1,
        cursor: firstBranch.page.nextCursor!,
      }),
    ).toMatchObject({ kind: "invalid_cursor" });
    expect(
      await services().branch.read({
        ...input,
        cursor: firstCategory.page.nextCursor!,
      }),
    ).toMatchObject({ kind: "invalid_cursor" });
    expect(
      await services().category.read({ ...input, cursor: "broken?" }),
    ).toMatchObject({ kind: "invalid_cursor" });
    expect(
      await services().branch.read({ ...input, actorUserId: cashier.id }),
    ).toMatchObject({ kind: "forbidden" });
    const managerBranch = await services().branch.read({
      ...input,
      actorUserId: manager.id,
    });
    expect(managerBranch.kind).toBe("success");
    if (managerBranch.kind === "success")
      expect(
        managerBranch.page.series.map((series) => series.branchId),
      ).toEqual([branchA!.id]);
    const adminBranch = await services().branch.read({
      ...input,
      actorUserId: admin.id,
    });
    expect(adminBranch.kind).toBe("success");
    if (adminBranch.kind === "success") {
      expect(
        adminBranch.page.series.find(
          (series) => series.branchId === branchB!.id,
        )?.branchStatus,
      ).toBe("INACTIVE");
    }
    expect(
      await services().branch.read({
        ...input,
        actorUserId: manager.id,
        scope: { kind: "branch", branchId: branchB!.id },
      }),
    ).toMatchObject({ kind: "forbidden" });

    const realScope = createPrismaAnalyticsScopeRepository(prisma);
    const noCost = createAnalyticsBranchService({
      contextEngine: createAnalyticsContextEngine({
        now: () => cutoff,
        scopeRepository: {
          async resolve(request) {
            const outcome = await realScope.resolve(request);
            return outcome.kind === "success"
              ? { ...outcome, scope: { ...outcome.scope, canViewCost: false } }
              : outcome;
          },
        },
      }),
      cursorCodec,
      repository: createPrismaAnalyticsBranchRepository(prisma, cursorCodec),
    });
    const hidden = await noCost.read(input);
    expect(hidden.kind).toBe("success");
    if (hidden.kind === "success") {
      expect(hidden.page.series[0]?.buckets[0]).not.toHaveProperty("cost");
      expect(hidden.page.nextCursor).toBeNull();
    }

    const refundOnly = await services().category.read({
      ...input,
      from: "2026-09-22",
      to: "2026-09-23",
    });
    expect(refundOnly.kind).toBe("success");
    if (refundOnly.kind === "success") {
      expect(refundOnly.page.series.map((series) => series.categoryId)).toEqual(
        [categoryB!.id],
      );
      expect(refundOnly.page.series[0]?.buckets[0]).toMatchObject({
        refundAmount: "9.00",
        categorySharePercent: { reason: "NO_SALES", value: null },
      });
    }
  });

  it("paginates 26 empty authorized Branches with the default and maximum limits", async () => {
    const organization = await prisma.organization.create({
      data: {
        name: "Branch pagination",
        reportingTimezone: "Asia/Bangkok",
        salesVatStatus: "NOT_REGISTERED",
      },
    });
    const owner = await actor(organization.id, "OWNER");
    const ids = Array.from({ length: 26 }, () => randomUUID()).sort();
    await prisma.branch.createMany({
      data: ids.map((id, index) => ({
        id,
        organizationId: organization.id,
        code: `B${index}`,
        name: `Branch ${index}`,
      })),
    });
    const input = {
      actorUserId: owner.id,
      organizationId: organization.id,
      scope: { kind: "organization" as const },
      ...requestPeriod,
    };
    const first = await services().branch.read(input);
    expect(first.kind).toBe("success");
    if (first.kind !== "success") return;
    expect(first.page.series.map((series) => series.branchId)).toEqual(
      ids.slice(0, 25),
    );
    expect(
      first.page.series.every((series) => series.buckets.length === 3),
    ).toBe(true);
    const final = await services().branch.read({
      ...input,
      cursor: first.page.nextCursor!,
    });
    expect(final.kind).toBe("success");
    if (final.kind === "success") {
      expect(final.page.series.map((series) => series.branchId)).toEqual(
        ids.slice(25),
      );
      expect(final.page.nextCursor).toBeNull();
    }
    const maximum = await services().branch.read({ ...input, limit: 100 });
    expect(maximum.kind).toBe("success");
    if (maximum.kind === "success")
      expect(maximum.page.series).toHaveLength(26);
  });

  it("uses DST boundaries and includes facts at the exact cutoff but excludes later facts", async () => {
    const organization = await prisma.organization.create({
      data: {
        name: "DST dimensions",
        reportingTimezone: "America/New_York",
        salesVatStatus: "NOT_REGISTERED",
      },
    });
    const branch = await prisma.branch.create({
      data: {
        code: "DST",
        name: "DST branch",
        organizationId: organization.id,
      },
    });
    const category = await prisma.category.create({
      data: {
        name: "DST category",
        normalizedName: "dst category",
        organizationId: organization.id,
      },
    });
    const product = await prisma.product.create({
      data: {
        basePrice: "12",
        categoryId: category.id,
        name: "DST product",
        organizationId: organization.id,
        sku: "DST",
        unit: "EA",
      },
    });
    const owner = await actor(organization.id, "OWNER");
    await stock(organization.id, branch.id, product.id, "2");
    await checkout({
      actorUserId: owner.id,
      branchId: branch.id,
      completedAt: "2026-03-08T05:00:00.000Z",
      organizationId: organization.id,
      productId: product.id,
      unitPrice: "12",
    });
    await checkout({
      actorUserId: owner.id,
      branchId: branch.id,
      completedAt: "2026-03-09T04:00:00.000Z",
      organizationId: organization.id,
      productId: product.id,
      unitPrice: "12",
    });
    const input = {
      actorUserId: owner.id,
      from: "2026-03-08",
      granularity: "day" as const,
      organizationId: organization.id,
      scope: { kind: "organization" as const },
      to: "2026-03-10",
    };
    const atCutoff = services(new Date("2026-03-08T05:00:00.000Z"));
    const categoryResult = await atCutoff.category.read(input);
    const branchResult = await atCutoff.branch.read(input);
    expect(categoryResult.kind).toBe("success");
    expect(branchResult.kind).toBe("success");
    if (categoryResult.kind !== "success" || branchResult.kind !== "success")
      return;
    expect(categoryResult.page.series[0]?.buckets).toMatchObject([
      {
        bucketStartInclusive: new Date("2026-03-08T05:00:00.000Z"),
        bucketEndExclusive: new Date("2026-03-09T04:00:00.000Z"),
        grossSalesAmount: "12.00",
      },
      { grossSalesAmount: "0.00" },
    ]);
    expect(
      branchResult.page.series[0]?.buckets.map((bucket) => bucket.saleCount),
    ).toEqual([1, 0]);
    const afterCutoff = await services(
      new Date("2026-03-09T04:00:00.000Z"),
    ).category.read(input);
    expect(afterCutoff.kind).toBe("success");
    if (afterCutoff.kind === "success") {
      expect(
        afterCutoff.page.series[0]?.buckets.map(
          (bucket) => bucket.grossSalesAmount,
        ),
      ).toEqual(["12.00", "12.00"]);
    }
  });
});
