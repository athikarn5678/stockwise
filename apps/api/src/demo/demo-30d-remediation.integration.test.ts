import { setTimeout } from "node:timers/promises";

import { Client } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { loadTestDatabaseEnvironment } from "../test/database-environment.ts";
import {
  createTestPrismaClient,
  resetTestDatabase,
} from "../test/database-harness.ts";
import { createDemo30dTestFixture } from "../test/demo-30d-fixture.ts";
import { createAnalyticsDimensionCursorCodec } from "../modules/analytics/analytics-dimension-cursor.ts";
import { createDemoInsightReader } from "../modules/ai-insights/demo-insight.ts";
import { createPrismaInventoryRepository } from "../modules/inventory/inventory-repository.ts";
import { createPrismaCheckoutRepository } from "../modules/sales/checkout-repository.ts";
import { createPrismaPurchaseOrderRepository } from "../modules/purchasing/purchase-order-repository.ts";
import { purchaseOrderCreateRequestSchema } from "../modules/purchasing/purchase-order-schemas.ts";
import {
  assertDemoHistory,
  demoBusinessFingerprint,
  readDemoProvenance,
} from "./demo-30d-provenance.ts";
import { prepareDemo30d, runDemo30d } from "./demo-30d-runner.ts";

const configured =
  !!process.env.TEST_DATABASE_URL && !!process.env.TEST_DISPOSABLE_RECEIPT;
const suite = describe.skipIf(!configured);
const environment = loadTestDatabaseEnvironment();
const prisma = createTestPrismaClient(environment);
let fixture: Awaited<ReturnType<typeof createDemo30dTestFixture>>;
const options = () => ({
  organizationId: fixture.organization.id,
  referenceDate: "2026-10-30",
  seed: 30,
  apply: true,
});
const owner = () => fixture.actors.find((a) => a.role === "OWNER")!.user.id;
const reader = () =>
  createDemoInsightReader({
    prisma,
    runtimeEnvironment: "test",
    organizationId: fixture.organization.id,
    cursorCodec: createAnalyticsDimensionCursorCodec(Buffer.alloc(32, 9)),
  });
const request = () => ({
  organizationId: fixture.organization.id,
  actorUserId: owner(),
  scope: { kind: "organization" as const },
  language: "en" as const,
});
async function reconcile() {
  const target = await prepareDemo30d(prisma, options());
  await assertDemoHistory(prisma, target.plan, true);
  for (const [count, expected] of [
    [await prisma.sale.count(), 436],
    [await prisma.saleItem.count(), 872],
    [await prisma.payment.count(), 436],
    [await prisma.purchaseReceipt.count(), 4],
    [await prisma.saleRefund.count(), 3],
    [await prisma.refundPayment.count(), 3],
    [await prisma.inventoryTransaction.count(), 899],
    [await prisma.inventoryBalance.count(), 12],
    [await prisma.inventoryCostState.count(), 12],
  ])
    expect(count).toBe(expected);
  const sales = await prisma.sale.aggregate({ _sum: { totalAmount: true } });
  const refunds = await prisma.saleRefund.aggregate({
    _sum: { totalAmount: true },
  });
  expect(
    sales._sum.totalAmount!.minus(refunds._sum.totalAmount!).toFixed(2),
  ).toBe("38630.00");
}

suite("Demo30d R1 first apply, recovery and organization provenance", () => {
  beforeEach(async () => {
    await resetTestDatabase(environment);
    fixture = await createDemo30dTestFixture(prisma);
  });
  afterAll(async () => {
    await resetTestDatabase(environment);
    await prisma.$disconnect();
  });

  it("serializes two first-time applies and preserves an exact rerun with reconciled costs/totals", async () => {
    expect(await prisma.sale.count()).toBe(0);
    await Promise.all([
      runDemo30d(prisma, options()),
      runDemo30d(prisma, options()),
    ]);
    await reconcile();
    const before = await demoBusinessFingerprint(
      prisma,
      fixture.organization.id,
    );
    await runDemo30d(prisma, options());
    expect(await demoBusinessFingerprint(prisma, fixture.organization.id)).toBe(
      before,
    );
  }, 180_000);

  it("resumes after an interruption following committed sales, receipts and a refund", async () => {
    let commands = 0;
    await expect(
      runDemo30d(prisma, {
        ...options(),
        afterCommand: async () => {
          commands++;
          if (await prisma.saleRefund.count())
            throw new Error("deterministic interruption");
        },
      }),
    ).rejects.toThrow(/deterministic interruption/);
    expect(commands).toBeGreaterThan(60);
    expect(
      (await readDemoProvenance(prisma, fixture.organization.id))?.state,
    ).toBe("IN_PROGRESS");
    expect(await reader().read(request())).toEqual({ kind: "not_found" });
    await runDemo30d(prisma, options());
    await reconcile();
  }, 180_000);

  it("retains the seed lock after the execution deadline until the awaited command settles", async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const first = runDemo30d(prisma, {
      ...options(),
      maximumRunMilliseconds: 2000,
      afterCommand: async () => {
        entered();
        await gate;
      },
    });
    // Attach the rejection handler immediately; the first run must not escape while blocked.
    const stopped = expect(first).rejects.toThrow(/deadline/);
    await started;
    await setTimeout(2100);
    try {
      await expect(
        runDemo30d(prisma, { ...options(), lockWaitMilliseconds: 50 }),
      ).rejects.toThrow(/lock timeout/);
      expect(await prisma.sale.count()).toBe(0);
    } finally {
      release();
    }
    await stopped;
    await runDemo30d(prisma, options());
    await reconcile();
  }, 180_000);

  it("rejects unselected branch/product sales and stock history without changing any history", async () => {
    const branch = await prisma.branch.create({
      data: {
        organizationId: fixture.organization.id,
        name: "Unselected",
        code: "ZEXTRA",
      },
    });
    const product = await prisma.product.create({
      data: {
        organizationId: fixture.organization.id,
        name: "Unselected",
        sku: "ZEXTRA",
        unit: "EA",
        basePrice: "10",
      },
    });
    const adjusted = await createPrismaInventoryRepository(
      prisma,
      () => new Date("2026-10-02T00:00:00Z"),
    ).adjust({
      actorUserId: owner(),
      organizationId: fixture.organization.id,
      branchId: branch.id,
      idempotencyKey: "unrelated-stock",
      adjustment: {
        productId: product.id,
        delta: "10",
        reason: "FOUND",
        note: null,
      },
    });
    expect(adjusted.kind).toBe("success");
    expect(
      (
        await createPrismaCheckoutRepository(prisma, {
          now: () => new Date("2026-10-03T00:00:00Z"),
        }).checkout({
          actorUserId: owner(),
          organizationId: fixture.organization.id,
          branchId: branch.id,
          idempotencyKey: "unrelated-sale",
          discount: null,
          items: [
            { productId: product.id, quantity: "1", expectedUnitPrice: "10" },
          ],
          payment: { method: "CASH", amountTendered: "10" },
        })
      ).kind,
    ).toBe("success");
    const before = await demoBusinessFingerprint(
      prisma,
      fixture.organization.id,
    );
    await expect(runDemo30d(prisma, options())).rejects.toThrow(
      /unrelated business history/,
    );
    expect(await demoBusinessFingerprint(prisma, fixture.organization.id)).toBe(
      before,
    );
    expect(
      await readDemoProvenance(prisma, fixture.organization.id),
    ).toBeNull();
  });

  it("rejects changed partial provenance, completed history and missing provenance", async () => {
    expect(await reader().read(request())).toEqual({ kind: "not_found" });
    await expect(
      runDemo30d(prisma, {
        ...options(),
        afterCommand: async () => {
          throw new Error("stop after draft");
        },
      }),
    ).rejects.toThrow(/stop after draft/);
    const partial = await readDemoProvenance(prisma, fixture.organization.id);
    expect(partial).not.toBeNull();
    await prisma.$executeRaw`UPDATE stockwise_demo.seed_runs SET plan=jsonb_set(plan,'{from}','"2026-09-29"') WHERE organization_id=${fixture.organization.id}::uuid`;
    const before = await demoBusinessFingerprint(
      prisma,
      fixture.organization.id,
    );
    await expect(runDemo30d(prisma, options())).rejects.toThrow(/provenance/);
    expect(await demoBusinessFingerprint(prisma, fixture.organization.id)).toBe(
      before,
    );
    await prisma.$executeRaw`UPDATE stockwise_demo.seed_runs SET plan=${JSON.stringify(partial!.plan)}::jsonb WHERE organization_id=${fixture.organization.id}::uuid`;
    await runDemo30d(prisma, options());
    const sale = await prisma.sale.findFirstOrThrow();
    await prisma.sale.update({
      where: { id: sale.id },
      data: { branchNameSnapshot: "Conflicting history" },
    });
    const modified = await demoBusinessFingerprint(
      prisma,
      fixture.organization.id,
    );
    await expect(runDemo30d(prisma, options())).rejects.toThrow(
      /conflicts with provenance/,
    );
    expect(await reader().read(request())).toEqual({ kind: "not_found" });
    expect(await demoBusinessFingerprint(prisma, fixture.organization.id)).toBe(
      modified,
    );
  }, 180_000);

  it("refuses contamination committed between final validation and fingerprinting", async () => {
    const { plan } = await prepareDemo30d(prisma, options());
    const commandCount =
      plan.orders.length * 3 +
      plan.sales.length +
      plan.sales.filter((s) => s.refund).length;
    let count = 0;
    let release!: () => void;
    let signal!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      signal = resolve;
    });
    const applied = runDemo30d(prisma, {
      ...options(),
      afterCommand: async () => {
        if (++count === commandCount) {
          signal();
          await gate;
        }
      },
    }).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await ready;
    const blocker = new Client({
      connectionString: environment.TEST_DATABASE_URL,
      connectionTimeoutMillis: 5000,
      query_timeout: 5000,
    });
    await blocker.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "LOCK TABLE inventory_cost_states IN ACCESS EXCLUSIVE MODE",
      );
      release();
      let waiting = false;
      for (let attempt = 0; attempt < 250 && !waiting; attempt++) {
        const rows = await prisma.$queryRaw<
          Array<{ waiting: boolean }>
        >`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%inventory_cost_states%') AS waiting`;
        waiting = rows[0]!.waiting;
        if (!waiting) await setTimeout(20);
      }
      expect(waiting).toBe(true);
      const unrelated = await createPrismaPurchaseOrderRepository(
        prisma,
      ).createPurchaseOrder({
        actorUserId: owner(),
        organizationId: fixture.organization.id,
        branchId: fixture.branches[0]!.id,
        purchaseOrder: purchaseOrderCreateRequestSchema.parse({
          supplierId: fixture.supplier.id,
          orderDate: "2026-10-10",
          items: [
            {
              productId: fixture.products[0]!.id,
              quantity: "1",
              expectedUnitCost: "10",
            },
          ],
        }),
      });
      expect(unrelated.kind).toBe("success");
    } finally {
      release();
      await blocker.query("ROLLBACK");
      await blocker.end();
    }
    expect(await applied).toMatchObject({ value: { status: "APPLIED" } });
    const provenance = await readDemoProvenance(
      prisma,
      fixture.organization.id,
    );
    expect(provenance?.fingerprint).not.toBe(
      await demoBusinessFingerprint(prisma, fixture.organization.id),
    );
    expect(await reader().read(request())).toEqual({ kind: "not_found" });
    await expect(runDemo30d(prisma, options())).rejects.toThrow(
      /conflicts with provenance/,
    );
    expect(await prisma.purchaseOrder.count()).toBe(5);
  }, 180_000);
});
