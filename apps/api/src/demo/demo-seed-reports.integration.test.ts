import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Prisma } from "../generated/prisma/client.ts";
import { loadTestDatabaseEnvironment } from "../test/database-environment.ts";
import {
  createTestPrismaClient,
  resetTestDatabase,
} from "../test/database-harness.ts";
import { createAnalyticsContextEngine } from "../modules/analytics/analytics-context.ts";
import { createPrismaAnalyticsSalesRepository } from "../modules/analytics/analytics-sales-repository.ts";
import { createPrismaAnalyticsScopeRepository } from "../modules/analytics/analytics-scope-repository.ts";
import { SEEDED_REPORT_HEADINGS } from "../modules/ai-insights/seeded-report-text.ts";
import { createPrismaCatalogRepository } from "../modules/catalog/catalog-repository.ts";
import { createPrismaCheckoutRepository } from "../modules/sales/checkout-repository.ts";
import { bootstrapDemo90d, demo90dCatalog } from "./demo-90d-bootstrap.ts";
import { demoWindowShape } from "./demo-30d-plan.ts";
import { runDemo30d } from "./demo-30d-runner.ts";
import { readDemoProvenance } from "./demo-30d-provenance.ts";
import { seedStoredReports } from "./demo-seed-reports.ts";

// Gated exactly like the demo seed suites: the guarded disposable target plus
// its ownership receipt, which the demo runner attests before any write.
const configured =
  !!process.env.TEST_DATABASE_URL && !!process.env.TEST_DISPOSABLE_RECEIPT;
const suite = describe.skipIf(!configured);
const environment = loadTestDatabaseEnvironment();
const prisma = createTestPrismaClient(environment);

const DEMO_PASSWORD = "M4-S3-Stored-Reports-2026!";
/** The exclusive local boundary of the seed window; the run day itself is empty. */
const REFERENCE_DATE = "2026-11-18";
const SEED = 90;
const BOOTSTRAP_CREATED_AT = new Date("2026-07-18T00:00:00.000Z");
const ANALYTICS_NOW = new Date("2026-11-18T06:00:00.000Z");

const catalog = demo90dCatalog();
const organizationId = catalog.organization.id;
const ownerUserId = catalog.users.find((user) => user.role === "OWNER")!.id;
const headings = [
  SEEDED_REPORT_HEADINGS.overview,
  SEEDED_REPORT_HEADINGS.sales,
  SEEDED_REPORT_HEADINGS.products,
  SEEDED_REPORT_HEADINGS.notes,
  SEEDED_REPORT_HEADINGS.actions,
];

/** The report text must never describe a stock level; only period sale facts. */
const STOCK_CLAIM = /ใกล้หมด|on hand|on-hand|สต็อกคงเหลือ|สินค้าคงเหลือ/iu;

const reportColumns = {
  attemptCount: true,
  branchId: true,
  cadence: true,
  completedAt: true,
  content: true,
  createdAt: true,
  generatedAt: true,
  id: true,
  organizationId: true,
  periodEndExclusive: true,
  periodStartInclusive: true,
  provider: true,
  scope: true,
  scopeKey: true,
  snapshotId: true,
  state: true,
} as const;

let seeded: Awaited<ReturnType<typeof seedStoredReports>> | undefined;
let beforeReports: string[] = [];
let beforeSnapshots: string[] = [];

function baseline() {
  if (seeded === undefined)
    throw new Error("The stored report fixture was not seeded.");
  return seeded;
}

async function storedReports() {
  return prisma.aiInsightReport.findMany({
    orderBy: { id: "asc" },
    select: reportColumns,
    where: { organizationId },
  });
}

async function storedSnapshots() {
  return prisma.analyticsSnapshot.findMany({
    orderBy: { id: "asc" },
    select: {
      id: true,
      cadence: true,
      payload: true,
      periodEndExclusive: true,
      periodStartInclusive: true,
      scopeKey: true,
    },
    where: { organizationId },
  });
}

function serialize(rows: readonly unknown[]): string[] {
  return rows.map((row) => JSON.stringify(row));
}

/** Independent sales aggregate for one scope and completed period. */
async function analyticsSales(input: {
  from: string;
  granularity: "week" | "month";
  scope: { kind: "organization" } | { branchId: string; kind: "branch" };
  to: string;
}) {
  const contextEngine = createAnalyticsContextEngine({
    now: () => ANALYTICS_NOW,
    scopeRepository: createPrismaAnalyticsScopeRepository(prisma),
  });
  const resolved = await contextEngine.resolve({
    actorUserId: ownerUserId,
    analyticsKind: "business",
    from: input.from,
    granularity: input.granularity,
    organizationId,
    scope: input.scope,
    to: input.to,
  });
  if (resolved.kind !== "success")
    throw new Error("The analytics read was not authorized.");
  const sales = await createPrismaAnalyticsSalesRepository(prisma).read(
    resolved.context,
  );
  return sales.buckets[0]!;
}

/**
 * Independent ledger sum of sale depletion for one scope and period, read
 * straight from `inventory_transactions` rather than through the analytics
 * inventory service. Rows are cut off at the period's own end.
 */
async function ledgerSaleDepletion(input: {
  branchIds: readonly string[];
  cutoff: Date;
  from: Date;
  to: Date;
}): Promise<
  Array<{
    productId: string;
    productName: string;
    productUnit: string;
    quantity: Prisma.Decimal;
  }>
> {
  const branches = input.branchIds.map((id) => Prisma.sql`${id}::uuid`);
  return prisma.$queryRaw(Prisma.sql`
    SELECT product.id::text AS "productId", product.name AS "productName",
      product.unit::text AS "productUnit",
      COALESCE(SUM(-movement.delta), 0)::numeric AS "quantity"
    FROM products AS product
    LEFT JOIN inventory_transactions AS movement
      ON movement.organization_id = product.organization_id
      AND movement.product_id = product.id
      AND movement.branch_id IN (${Prisma.join(branches)})
      AND movement.source = 'SALE' AND movement.delta < 0
      AND movement.occurred_at >= ${input.from}::timestamptz
      AND movement.occurred_at < ${input.to}::timestamptz
      AND movement.occurred_at <= ${input.cutoff}::timestamptz
    WHERE product.organization_id = ${organizationId}::uuid
      AND product.status = 'ACTIVE'
    GROUP BY product.id, product.name, product.unit
    ORDER BY product.id
  `);
}

/** The same deterministic per-unit ranking the report text renders. */
function rankedProducts(
  rows: Awaited<ReturnType<typeof ledgerSaleDepletion>>,
  direction: "best" | "slowest",
): string[] {
  const units = [...new Set(rows.map((row) => row.productUnit))].sort();
  return units
    .map(
      (unit) =>
        rows
          .filter((row) => row.productUnit === unit)
          .sort((a, b) =>
            direction === "best"
              ? b.quantity.cmp(a.quantity) ||
                a.productId.localeCompare(b.productId)
              : a.quantity.cmp(b.quantity) ||
                a.productId.localeCompare(b.productId),
          )[0]!,
    )
    .filter((row) => (direction === "best" ? row.quantity.gt(0) : true))
    .map(
      (row) =>
        `${row.productName}: ${row.quantity.toFixed(4)} ${row.productUnit}`,
    );
}

function lineAfter(content: string, prefix: string): string {
  const line = content
    .split("\n")
    .find((candidate) => candidate.startsWith(prefix));
  if (line === undefined) throw new Error(`The report has no ${prefix} line.`);
  return line.slice(prefix.length);
}

/** Display-only shortening mirrored from the text builder. */
function money2(value: string): string {
  const separator = value.indexOf(".");
  return separator === -1 ? value : value.slice(0, separator + 3);
}

async function clearDemoProvenance() {
  const relation = await prisma.$queryRaw<Array<{ exists: string | null }>>`
    SELECT to_regclass('stockwise_demo.seed_runs')::text AS exists`;
  if (!relation[0]?.exists) return;
  await prisma.$executeRaw`DELETE FROM stockwise_demo.seed_runs WHERE organization_id = ${organizationId}::uuid`;
}

suite("seeded stored weekly/monthly AI insight reports", () => {
  beforeAll(async () => {
    await resetTestDatabase(environment);
    await clearDemoProvenance();
    const bootstrap = await bootstrapDemo90d(prisma, {
      password: DEMO_PASSWORD,
      createdAt: BOOTSTRAP_CREATED_AT,
    });
    expect(bootstrap.organizationId).toBe(organizationId);
    const applied = await runDemo30d(prisma, {
      organizationId,
      referenceDate: REFERENCE_DATE,
      seed: SEED,
      shape: demoWindowShape(REFERENCE_DATE),
      apply: true,
    });
    expect(applied.status).toBe("APPLIED");
    const plan = (await readDemoProvenance(prisma, organizationId))!.plan;
    seeded = await seedStoredReports(prisma, {
      from: plan.from,
      organizationId,
      reportingTimezone: plan.reportingTimezone,
      to: plan.to,
    });
    beforeReports = serialize(await storedReports());
    beforeSnapshots = serialize(await storedSnapshots());
  }, 900_000);

  afterAll(async () => {
    await resetTestDatabase(environment);
    await prisma.$disconnect();
  });

  it("stores 72 immutable weekly and monthly reports for four scopes", async () => {
    expect(baseline()).toEqual({
      monthly: 3,
      observed: 0,
      scopes: 4,
      succeeded: 72,
      weekly: 15,
    });

    const reports = await storedReports();
    expect(reports).toHaveLength(72);
    expect(reports.filter((row) => row.cadence === "WEEKLY")).toHaveLength(60);
    expect(reports.filter((row) => row.cadence === "MONTHLY")).toHaveLength(12);
    expect(reports.filter((row) => row.scope === "ORGANIZATION")).toHaveLength(
      18,
    );
    expect(reports.filter((row) => row.scope === "BRANCH")).toHaveLength(54);
    for (const row of reports) {
      expect(row).toMatchObject({
        attemptCount: 1,
        cadence: row.cadence,
        organizationId,
        provider: "seeded-template",
        state: "SUCCEEDED",
      });
      expect(row.branchId === null).toBe(row.scope === "ORGANIZATION");
      expect(row.content).not.toMatch(/demo|uat|ตัวอย่าง|sample/iu);
      // The stored text never states a stock level: only this period's sales,
      // refunds and sale depletion.
      expect(row.content).not.toMatch(STOCK_CLAIM);
      expect(row.content).not.toContain("onHand");
      expect(row.content).not.toContain("coverageDays");
    }

    const snapshots = await prisma.analyticsSnapshot.findMany({
      select: { id: true, payload: true },
      where: { organizationId },
    });
    expect(snapshots).toHaveLength(72);
    expect(new Set(reports.map((row) => row.snapshotId)).size).toBe(72);
    expect(new Set(reports.map((row) => row.branchId)).size).toBe(4);

    // Every stored row carries exactly the five bilingual headings in order.
    for (const row of reports) {
      const lines = row.content!.split("\n");
      expect(lines.filter((line) => headings.includes(line))).toEqual(headings);
    }
  }, 300_000);

  it("matches the analytics read for its own period and scope", async () => {
    const reports = await storedReports();
    const snapshots = new Map(
      (
        await prisma.analyticsSnapshot.findMany({
          select: { id: true, payload: true },
          where: { organizationId },
        })
      ).map((row) => [row.id, row.payload]),
    );
    const branchesByPeriod = new Set<string>();
    const checked: typeof reports = [];
    for (const row of reports) {
      if (row.scope === "ORGANIZATION") {
        checked.push(row);
        continue;
      }
      // One branch scope per period, deterministically the first by id.
      const key = row.periodStartInclusive.toISOString();
      if (branchesByPeriod.has(key)) continue;
      branchesByPeriod.add(key);
      checked.push(row);
    }
    expect(checked).toHaveLength(18 + 18);

    for (const row of checked) {
      const content = row.content!;
      const payload = snapshots.get(row.snapshotId!) as {
        sales: { netSalesAmount: string; saleCount: number };
      };
      const granularity = row.cadence === "WEEKLY" ? "week" : "month";
      const from = localDate(row.periodStartInclusive);
      const to = localDate(row.periodEndExclusive);
      const sales = await analyticsSales({
        from,
        granularity,
        scope:
          row.scope === "ORGANIZATION"
            ? { kind: "organization" }
            : { branchId: row.branchId!, kind: "branch" },
        to,
      });
      expect(payload.sales.netSalesAmount).toBe(sales.netSalesAmount);
      expect(payload.sales.saleCount).toBe(sales.saleCount);
      expect(content).toContain(
        `net sales): ${sales.netSalesAmount} THB จาก ${sales.saleCount} รายการขาย`,
      );
      expect(content).toContain(
        `การคืนเงิน: ${sales.refundCount} รายการ รวม ${money2(sales.refundAmount)} THB`,
      );
      const growth = sales.netSalesGrowthPercent.value;
      expect(content).toContain(
        growth === null
          ? "การเติบโตเทียบช่วงก่อนหน้า: ไม่มีข้อมูลเปรียบเทียบ"
          : `การเติบโตเทียบช่วงก่อนหน้า: ${growth}%`,
      );
      const reading =
        growth === null
          ? "ไม่มีข้อมูลเปรียบเทียบช่วงก่อนหน้า"
          : !/[1-9]/u.test(growth)
            ? "ยอดขายสุทธิใกล้เคียงช่วงก่อนหน้า"
            : growth.trimStart().startsWith("-")
              ? "ยอดขายสุทธิลดลงเมื่อเทียบช่วงก่อนหน้า"
              : "ยอดขายสุทธิเพิ่มขึ้นเมื่อเทียบช่วงก่อนหน้า";
      expect(content.split("\n\n")[3]!).toContain(reading);
    }
  }, 300_000);

  it("ranks an older week's best and slowest products from that week's own ledger", async () => {
    const reports = await storedReports();
    const weeks = reports
      .filter((row) => row.cadence === "WEEKLY" && row.scope === "ORGANIZATION")
      .sort(
        (a, b) =>
          a.periodStartInclusive.getTime() - b.periodStartInclusive.getTime(),
      );
    expect(weeks.length).toBeGreaterThan(1);
    // The oldest completed week, far from the run day, so today's stock cannot
    // explain any figure in it.
    const row = weeks[0]!;
    expect(row.periodEndExclusive.getTime()).toBeLessThan(
      weeks.at(-1)!.periodEndExclusive.getTime(),
    );
    const branches = await prisma.branch.findMany({
      select: { id: true },
      where: { organizationId },
    });
    const ledger = await ledgerSaleDepletion({
      branchIds: branches.map((branch) => branch.id),
      cutoff: row.periodEndExclusive,
      from: row.periodStartInclusive,
      to: row.periodEndExclusive,
    });
    const best = rankedProducts(ledger, "best");
    const slowest = rankedProducts(ledger, "slowest");
    expect(best.length).toBeGreaterThan(0);
    expect(lineAfter(row.content!, "สินค้าขายดีตามหน่วยฐาน: ")).toBe(
      best.join("; "),
    );
    expect(lineAfter(row.content!, "สินค้าขายช้าตามหน่วยฐาน: ")).toBe(
      slowest.join("; "),
    );
    // Depletion is a period flow, so the old week's quantities are its own.
    for (const entry of best) {
      const quantity = entry.slice(entry.indexOf(": ") + 2).split(" ")[0]!;
      expect(Number(quantity)).toBeGreaterThan(0);
    }
  }, 300_000);

  it("reuses every stored report and snapshot on a rerun", async () => {
    const rerun = await seedStoredReports(prisma, {
      from: (await readDemoProvenance(prisma, organizationId))!.plan.from,
      organizationId,
      reportingTimezone: catalog.organization.timezone,
      to: REFERENCE_DATE,
    });
    expect(rerun).toEqual({
      monthly: 3,
      observed: 72,
      scopes: 4,
      succeeded: 72,
      weekly: 15,
    });
    expect(
      await prisma.aiInsightReport.count({ where: { organizationId } }),
    ).toBe(72);
    expect(
      await prisma.analyticsSnapshot.count({ where: { organizationId } }),
    ).toBe(72);
    expect(serialize(await storedReports())).toEqual(beforeReports);
    expect(serialize(await storedSnapshots())).toEqual(beforeSnapshots);
  }, 600_000);

  it("keeps stored reports byte-identical after a later checkout and new product", async () => {
    const branch = await prisma.branch.findFirstOrThrow({
      select: { id: true },
      where: { organizationId, code: "MAIN" },
    });
    const product = await prisma.product.findFirstOrThrow({
      orderBy: { sku: "asc" },
      select: { basePrice: true, id: true, name: true, sku: true, unit: true },
      where: { organizationId, status: "ACTIVE" },
    });
    const checkout = await createPrismaCheckoutRepository(prisma, {
      now: () => new Date("2026-11-18T03:00:00.000Z"),
    }).checkout({
      actorUserId: ownerUserId,
      branchId: branch.id,
      discount: null,
      idempotencyKey: "m4-s3-post-seed-checkout",
      items: [
        {
          expectedUnitPrice: product.basePrice.toFixed(4),
          productId: product.id,
          quantity: "1",
        },
      ],
      organizationId,
      payment: { amountTendered: "1000.00", method: "CASH" },
    });
    expect(checkout.kind).toBe("success");

    const created = await createPrismaCatalogRepository(prisma).createProduct({
      actorUserId: ownerUserId,
      organizationId,
      product: {
        barcode: null,
        basePrice: "99.0000",
        categoryId: null,
        description: null,
        name: "Seeded Report Later Product",
        sku: "SM-P13",
        unit: "EA",
      },
    });
    expect(created.kind).toBe("success");

    expect(serialize(await storedReports())).toEqual(beforeReports);
    expect(serialize(await storedSnapshots())).toEqual(beforeSnapshots);
  }, 300_000);
});

/** The stored boundary rendered back to the local date that produced it. */
function localDate(value: Date): string {
  const local = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: catalog.organization.timezone,
    year: "numeric",
  }).format(value);
  // `en-CA` renders YYYY-MM-DD in the reporting timezone.
  return local;
}
