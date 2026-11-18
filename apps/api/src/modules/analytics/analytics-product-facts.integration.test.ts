import { randomUUID } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { Prisma, type AiAnalysisRun } from "../../generated/prisma/client.ts";
import {
  createTestPrismaClient,
  resetTestDatabase,
} from "../../test/database-harness.ts";
import { loadTestDatabaseEnvironment } from "../../test/database-environment.ts";
import {
  AiAnalyzeOutputError,
  buildMockAiAnalyzeOutput,
  parseAiAnalyzeOutput,
} from "../ai-insights/ai-analyze-output.ts";
import {
  buildAiAnalyzeProductFacts,
  type AiAnalyzeProductFacts,
} from "../ai-insights/ai-analyze-product-facts.ts";
import { createAiAnalyzeSnapshotBuilder } from "../ai-insights/ai-analyze-snapshot.ts";
import { createAiAnalyzeService } from "../ai-insights/ai-analyze-service.ts";
import { createPrismaCheckoutRepository } from "../sales/checkout-repository.ts";
import { createPrismaRefundRepository } from "../sales/refund-repository.ts";
import { createPrismaAnalyticsCategoryRepository } from "./analytics-category-repository.ts";
import { createAnalyticsCategoryService } from "./analytics-category-service.ts";
import { createAnalyticsContextEngine } from "./analytics-context.ts";
import { createAnalyticsDimensionCursorCodec } from "./analytics-dimension-cursor.ts";
import { createPrismaAnalyticsProductFactsRepository } from "./analytics-product-facts-repository.ts";
import { createAnalyticsProductFactsService } from "./analytics-product-facts-service.ts";
import { createPrismaAnalyticsSalesRepository } from "./analytics-sales-repository.ts";
import { createAnalyticsSalesService } from "./analytics-sales-service.ts";
import { createPrismaAnalyticsScopeRepository } from "./analytics-scope-repository.ts";

const environment = loadTestDatabaseEnvironment();
const prisma = createTestPrismaClient(environment);
// No sale may be completed after its source cutoff.
const cutoff = new Date("2026-10-01T00:00:00.000Z");
const PERIOD = { from: "2026-09-20", to: "2026-09-23" } as const;
const PERIOD_DAYS = 3;
const EMPTY_PERIOD = { from: "2026-10-01", to: "2026-10-04" } as const;

function services() {
  const cursorCodec = createAnalyticsDimensionCursorCodec(Buffer.alloc(32, 1));
  const contextEngine = createAnalyticsContextEngine({
    now: () => cutoff,
    scopeRepository: createPrismaAnalyticsScopeRepository(prisma),
  });
  return {
    contextEngine,
    category: createAnalyticsCategoryService({
      contextEngine,
      cursorCodec,
      repository: createPrismaAnalyticsCategoryRepository(prisma, cursorCodec),
    }),
    productFacts: createAnalyticsProductFactsService({
      contextEngine,
      repository: createPrismaAnalyticsProductFactsRepository(prisma),
    }),
    sales: createAnalyticsSalesService({
      contextEngine,
      repository: createPrismaAnalyticsSalesRepository(prisma),
    }),
  };
}

async function actor(
  organizationId: string,
  role: "OWNER" | "BRANCH_MANAGER",
): Promise<string> {
  const user = await prisma.user.create({
    data: {
      displayName: "Product facts actor",
      email: `${randomUUID()}@example.test`,
      emailVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
    },
  });
  await prisma.organizationMembership.create({
    data: { organizationId, role, userId: user.id },
  });
  return user.id;
}

async function stock(input: {
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
  await prisma.inventoryCostState.create({
    data: {
      averageUnitCost: "1",
      basisState: "KNOWN",
      branchId: input.branchId,
      inventoryValue: new Prisma.Decimal(input.quantity).toFixed(10),
      organizationId: input.organizationId,
      productId: input.productId,
    },
  });
}

async function checkout(input: {
  actorUserId: string;
  branchId: string;
  completedAt: string;
  organizationId: string;
  productId: string;
  quantity: string;
  unitPrice: string;
}) {
  const outcome = await createPrismaCheckoutRepository(prisma, {
    now: () => new Date(input.completedAt),
  }).checkout({
    actorUserId: input.actorUserId,
    branchId: input.branchId,
    discount: null,
    idempotencyKey: randomUUID(),
    items: [
      {
        expectedUnitPrice: input.unitPrice,
        productId: input.productId,
        quantity: input.quantity,
      },
    ],
    organizationId: input.organizationId,
    payment: { amountTendered: "1000", method: "CASH" },
  });
  if (outcome.kind !== "success")
    throw new Error(`Fixture checkout failed: ${outcome.kind}`);
  return {
    itemId: outcome.sale.items[0]!.id,
    saleId: outcome.sale.id,
  };
}

type Seeded = Readonly<{
  branchAId: string;
  branchBId: string;
  organizationId: string;
  ownerUserId: string;
  productIds: Readonly<Record<string, string>>;
}>;

/**
 * Organization A: two branches, ten products (six of them sold), one refund.
 * Organization B holds a product that must never surface in A's facts.
 */
async function seed(): Promise<Seeded> {
  const organization = await prisma.organization.create({
    data: {
      name: "Product facts",
      reportingTimezone: "Asia/Bangkok",
      salesVatStatus: "NOT_REGISTERED",
    },
  });
  const branchA = await prisma.branch.create({
    data: { code: "A", name: "A", organizationId: organization.id },
  });
  const branchB = await prisma.branch.create({
    data: { code: "B", name: "B", organizationId: organization.id },
  });
  const ownerUserId = await actor(organization.id, "OWNER");

  const catalog = [
    ["Alpha Cola", "30", "ACTIVE"],
    ["Beta Chips", "50", "ACTIVE"],
    ["Gamma Tea", "40", "ACTIVE"],
    ["Delta Water", "1", "ACTIVE"],
    ["Eta Nuts", "20", "ACTIVE"],
    ["Zeta Snacks", "10", "ACTIVE"],
    ["Theta Milk", "15", "ACTIVE"],
    ["Iota Soda", "12", "ACTIVE"],
    ["Epsilon Juice", "25", "ACTIVE"],
    ["Kappa Old", "5", "INACTIVE"],
  ] as const;
  const productIds: Record<string, string> = {};
  for (const [index, [name, basePrice, status]] of catalog.entries()) {
    const product = await prisma.product.create({
      data: {
        basePrice,
        name,
        organizationId: organization.id,
        sku: `SKU-${index}`,
        status,
        unit: "EA",
      },
    });
    productIds[name] = product.id;
  }

  // Seeded quantities are written back to the intended closing balance by the
  // sale and refund below, so the facts assertions stay readable.
  const seeds: readonly (readonly [string, string, string])[] = [
    ["Alpha Cola", branchA.id, "12"],
    ["Alpha Cola", branchB.id, "6"],
    ["Beta Chips", branchA.id, "1"],
    ["Gamma Tea", branchB.id, "2"],
    ["Delta Water", branchA.id, "26"],
    ["Eta Nuts", branchA.id, "4"],
    ["Zeta Snacks", branchB.id, "6"],
    ["Theta Milk", branchA.id, "8"],
    ["Iota Soda", branchA.id, "0"],
    ["Kappa Old", branchA.id, "5"],
  ];
  for (const [name, branchId, quantity] of seeds)
    await stock({
      branchId,
      organizationId: organization.id,
      productId: productIds[name]!,
      quantity,
    });

  const sale = async (
    branchId: string,
    name: string,
    quantity: string,
    completedAt: string,
  ) =>
    checkout({
      actorUserId: ownerUserId,
      branchId,
      completedAt,
      organizationId: organization.id,
      productId: productIds[name]!,
      quantity,
      unitPrice: catalog.find(([product]) => product === name)![1],
    });
  const colaSaleA = await sale(
    branchA.id,
    "Alpha Cola",
    "3",
    "2026-09-20T03:00:00.000Z",
  );
  await sale(branchB.id, "Alpha Cola", "2", "2026-09-20T04:00:00.000Z");
  await sale(branchA.id, "Beta Chips", "1", "2026-09-20T05:00:00.000Z");
  await sale(branchA.id, "Delta Water", "6", "2026-09-21T03:00:00.000Z");
  await sale(branchA.id, "Eta Nuts", "1", "2026-09-21T04:00:00.000Z");
  await sale(branchB.id, "Gamma Tea", "1", "2026-09-21T05:00:00.000Z");
  await sale(branchB.id, "Zeta Snacks", "1", "2026-09-21T06:00:00.000Z");

  // One restored unit nets Alpha Cola down to 4 units sold and 120.00 net.
  const refund = await createPrismaRefundRepository(prisma, {
    now: () => new Date("2026-09-21T07:00:00.000Z"),
  }).createRefund({
    actorUserId: ownerUserId,
    branchId: branchA.id,
    idempotencyKey: randomUUID(),
    items: [
      { quantity: "1", restockQuantity: "1", saleItemId: colaSaleA.itemId },
    ],
    organizationId: organization.id,
    reason: "Product facts fixture",
    saleId: colaSaleA.saleId,
    transferReference: null,
  });
  if (refund.kind !== "success")
    throw new Error(`Fixture refund failed: ${refund.kind}`);

  const foreign = await prisma.organization.create({
    data: {
      name: "Other tenant",
      reportingTimezone: "Asia/Bangkok",
      salesVatStatus: "NOT_REGISTERED",
    },
  });
  const foreignBranch = await prisma.branch.create({
    data: { code: "X", name: "X", organizationId: foreign.id },
  });
  const foreignOwner = await actor(foreign.id, "OWNER");
  const secret = await prisma.product.create({
    data: {
      basePrice: "99",
      name: "Omega Secret",
      organizationId: foreign.id,
      sku: "SECRET",
      unit: "EA",
    },
  });
  await stock({
    branchId: foreignBranch.id,
    organizationId: foreign.id,
    productId: secret.id,
    quantity: "7",
  });
  await checkout({
    actorUserId: foreignOwner,
    branchId: foreignBranch.id,
    completedAt: "2026-09-20T03:00:00.000Z",
    organizationId: foreign.id,
    productId: secret.id,
    quantity: "2",
    unitPrice: "99",
  });

  return {
    branchAId: branchA.id,
    branchBId: branchB.id,
    organizationId: organization.id,
    ownerUserId,
    productIds,
  };
}

async function readRows(
  seeded: Seeded,
  scope: { kind: "organization" } | { branchId: string; kind: "branch" },
  period: { from: string; to: string } = PERIOD,
) {
  const outcome = await services().productFacts.read({
    actorUserId: seeded.ownerUserId,
    from: period.from,
    organizationId: seeded.organizationId,
    scope,
    to: period.to,
  });
  if (outcome.kind !== "success")
    throw new Error(`Product facts read failed: ${outcome.kind}`);
  expect(outcome.facts.truncated).toBe(false);
  return outcome.facts.rows;
}

async function factsFor(
  seeded: Seeded,
  scope: { kind: "organization" } | { branchId: string; kind: "branch" },
  period: { from: string; to: string } = PERIOD,
): Promise<AiAnalyzeProductFacts> {
  return buildAiAnalyzeProductFacts({
    days: PERIOD_DAYS,
    rows: await readRows(seeded, scope, period),
  });
}

describe("Product facts analytics with PostgreSQL", () => {
  beforeEach(async () => resetTestDatabase(environment));
  afterAll(async () => {
    await resetTestDatabase(environment);
    await prisma.$disconnect();
  });

  it("returns real top and slowest products and never another tenant's data", async () => {
    const seeded = await seed();
    const facts = await factsFor(seeded, { kind: "organization" });

    expect(facts.soldProductCount).toBe(6);
    expect(facts.topByQuantity.map((item) => item.name)).toEqual([
      "Delta Water",
      "Alpha Cola",
      "Beta Chips",
      "Eta Nuts",
      "Gamma Tea",
    ]);
    // The refund nets Alpha Cola down to four units and 120.00.
    expect(facts.topByQuantity[1]).toEqual({
      name: "Alpha Cola",
      netSalesAmount: "120.00",
      quantity: "4",
    });
    expect(facts.topByNetSales.map((item) => item.name)).toEqual([
      "Alpha Cola",
      "Beta Chips",
      "Gamma Tea",
      "Eta Nuts",
      "Zeta Snacks",
    ]);
    // The quantity leader is the net-sales laggard and vice versa.
    expect(facts.slowestByQuantity.map((item) => item.name)).toEqual([
      "Zeta Snacks",
    ]);
    expect(facts.slowestByNetSales.map((item) => item.name)).toEqual([
      "Delta Water",
    ]);
    expect(
      facts.topByQuantity.some((item) => item.name === "Omega Secret"),
    ).toBe(false);
  });

  it("requires a real balance to report a stocked product with no sales", async () => {
    const seeded = await seed();
    const facts = await factsFor(seeded, { kind: "organization" });

    // Theta Milk and Iota Soda have balances; Epsilon Juice has neither a sale
    // nor a balance, so it is not stocked and never appears. Kappa Old is
    // INACTIVE, so its balance does not make it a no-sales candidate.
    expect(facts.noSales).toEqual({
      count: 2,
      names: ["Iota Soda", "Theta Milk"],
    });
    expect(facts.outOfStock.count).toBe(2);
    expect(facts.outOfStock.items.map((item) => item.name)).toEqual([
      "Beta Chips",
      "Iota Soda",
    ]);
    expect(facts.outOfStock.items[0]).toMatchObject({
      daysOfCover: null,
      onHandQuantity: "0",
      quantitySoldInPeriod: "1",
    });
    expect(facts.lowStock.count).toBe(1);
    expect(facts.lowStock.items[0]).toMatchObject({
      daysOfCover: "3.00",
      name: "Gamma Tea",
      onHandQuantity: "1",
      quantitySoldInPeriod: "1",
    });
    expect(facts.lowStock.coverDaysThreshold).toBe(7);
  });

  it("scopes sales and stock to one branch and sums both for the organization", async () => {
    const seeded = await seed();
    const branchA = await factsFor(seeded, {
      branchId: seeded.branchAId,
      kind: "branch",
    });

    expect(branchA.soldProductCount).toBe(4);
    expect(branchA.topByQuantity.map((item) => item.name)).toEqual([
      "Delta Water",
      "Alpha Cola",
      "Beta Chips",
      "Eta Nuts",
    ]);
    // Branch B's two Cola units and four on-hand units stay out of branch A.
    expect(branchA.topByQuantity[1]).toEqual({
      name: "Alpha Cola",
      netSalesAmount: "60.00",
      quantity: "2",
    });
    expect(branchA.noSales).toEqual({
      count: 2,
      names: ["Iota Soda", "Theta Milk"],
    });
    // Gamma Tea only stocks and sells in branch B, so branch A has no low stock.
    expect(branchA.lowStock.count).toBe(0);

    const branchB = await factsFor(seeded, {
      branchId: seeded.branchBId,
      kind: "branch",
    });
    expect(branchB.soldProductCount).toBe(3);
    // At the 3-day pace Gamma Tea covers 3.00 days and Alpha Cola (4 on hand,
    // 2 sold) covers 6.00 days: both are within the 7-day threshold.
    expect(branchB.lowStock.items.map((item) => item.name)).toEqual([
      "Gamma Tea",
      "Alpha Cola",
    ]);
    expect(branchB.lowStock.items.map((item) => item.daysOfCover)).toEqual([
      "3.00",
      "6.00",
    ]);
    // Branch B has stock only for its own three products, never Alpha's 10.
    expect(branchB.outOfStock.count).toBe(0);
    expect(branchB.noSales.count).toBe(0);

    // On hand is summed per scope: 10 in branch A plus 4 in branch B.
    const alphaOf = (
      rows: readonly { name: string; onHandQuantity: string | null }[],
    ) => rows.find((row) => row.name === "Alpha Cola")?.onHandQuantity;
    expect(alphaOf(await readRows(seeded, { kind: "organization" }))).toBe(
      "14.0000",
    );
    expect(
      alphaOf(
        await readRows(seeded, { branchId: seeded.branchAId, kind: "branch" }),
      ),
    ).toBe("10.0000");
    expect(
      alphaOf(
        await readRows(seeded, { branchId: seeded.branchBId, kind: "branch" }),
      ),
    ).toBe("4.0000");
  });

  it("reports only stock-only rows for a period without sales", async () => {
    const seeded = await seed();
    const facts = await factsFor(
      seeded,
      { kind: "organization" },
      EMPTY_PERIOD,
    );

    expect(facts.soldProductCount).toBe(0);
    expect(facts.topByQuantity).toEqual([]);
    expect(facts.topByNetSales).toEqual([]);
    expect(facts.slowestByQuantity).toEqual([]);
    expect(facts.slowestByNetSales).toEqual([]);
    expect(facts.lowStock.count).toBe(0);
    // Every stocked active product is unsold in this period.
    expect(facts.noSales).toEqual({
      count: 8,
      names: [
        "Alpha Cola",
        "Beta Chips",
        "Delta Water",
        "Eta Nuts",
        "Gamma Tea",
        "Iota Soda",
        "Theta Milk",
        "Zeta Snacks",
      ],
    });
    expect(facts.outOfStock.items.map((item) => item.name)).toEqual([
      "Beta Chips",
      "Iota Soda",
    ]);
    expect(facts.noSales.names).not.toContain("Kappa Old");
    expect(facts.noSales.names).not.toContain("Epsilon Juice");
  });

  it("builds a validated snapshot that names the seeded products end to end", async () => {
    const seeded = await seed();
    const readSnapshot = createAiAnalyzeSnapshotBuilder({
      categoryService: services().category,
      now: () => cutoff.getTime(),
      organizationReader: prisma,
      productFactsService: services().productFacts,
      salesService: services().sales,
    });
    const outcome = await readSnapshot({
      actorUserId: seeded.ownerUserId,
      days: PERIOD_DAYS,
      fixedPeriod: PERIOD,
      organizationId: seeded.organizationId,
      scope: { kind: "organization" },
    });
    if (outcome.kind !== "ok")
      throw new Error(`Snapshot failed: ${outcome.kind}`);
    const { snapshot } = outcome;

    expect(snapshot.totals.saleCount).toBe(7);
    expect(snapshot.products.topByQuantity[0]?.name).toBe("Delta Water");
    expect(snapshot.products.slowestByNetSales[0]?.name).toBe("Delta Water");
    expect(snapshot.products.lowStock.items[0]?.name).toBe("Gamma Tea");
    expect(snapshot.products.noSales.names).toContain("Theta Milk");
    expect(
      snapshot.products.topByQuantity.map((item) => item.name),
    ).not.toContain("Omega Secret");

    // The deterministic sample text satisfies the same contract as a model.
    const mockText = buildMockAiAnalyzeOutput({
      language: "en",
      snapshot,
    });
    expect(
      parseAiAnalyzeOutput({ language: "en", snapshot, text: mockText }),
    ).toHaveLength(5);
    expect(mockText).toContain("Delta Water");

    // A number that is absent from the snapshot is rejected.
    const hallucinated = mockText.replace(
      "Delta Water: 6 units",
      "Delta Water: 61 units",
    );
    expect(hallucinated).toContain("61 units");
    expect(() =>
      parseAiAnalyzeOutput({ language: "en", snapshot, text: hallucinated }),
    ).toThrow(AiAnalyzeOutputError);
  });

  it("answers insufficient_data for an empty period instead of calling a provider", async () => {
    const seeded = await seed();
    const readSnapshot = createAiAnalyzeSnapshotBuilder({
      categoryService: services().category,
      now: () => cutoff.getTime(),
      organizationReader: prisma,
      productFactsService: services().productFacts,
      salesService: services().sales,
    });
    const outcome = await readSnapshot({
      actorUserId: seeded.ownerUserId,
      days: PERIOD_DAYS,
      fixedPeriod: EMPTY_PERIOD,
      organizationId: seeded.organizationId,
      scope: { kind: "organization" },
    });
    if (outcome.kind !== "ok")
      throw new Error(`Snapshot failed: ${outcome.kind}`);
    expect(outcome.snapshot.totals.saleCount).toBe(0);

    const create = vi.fn(async (): Promise<AiAnalysisRun> => {
      throw new Error("Nothing may be stored for an empty period.");
    });
    const service = createAiAnalyzeService({
      buildSnapshot: async () => ({ kind: "ok", snapshot: outcome.snapshot }),
      store: {
        create,
        fillLanguage: async () => null,
        find: async () => null,
      },
    });
    await expect(
      service.analyze({
        actorUserId: seeded.ownerUserId,
        days: PERIOD_DAYS,
        organizationId: seeded.organizationId,
        scope: { kind: "organization" },
      }),
    ).resolves.toEqual({ kind: "insufficient_data" });
    expect(create).not.toHaveBeenCalled();
  });
});
