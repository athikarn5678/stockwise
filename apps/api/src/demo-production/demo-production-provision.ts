import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";

import { Prisma, type PrismaClient } from "../generated/prisma/client.ts";
import { assertDemoHistory } from "../demo/demo-30d-provenance.ts";
import { buildDemo30dPlan, type Demo30dPlan } from "../demo/demo-30d-plan.ts";
import { demoId } from "../demo/demo-values.ts";
import { createAnalyticsDimensionCursorCodec } from "../modules/analytics/analytics-dimension-cursor.ts";
import { localDateToUtcBoundary } from "../modules/analytics/analytics-period.ts";
import { createPrismaPurchaseOrderRepository } from "../modules/purchasing/purchase-order-repository.ts";
import { expectedPurchaseOrderTotal } from "../modules/purchasing/purchase-order-values.ts";
import { createPrismaReceivingRepository } from "../modules/purchasing/receiving-repository.ts";
import { createPrismaCheckoutRepository } from "../modules/sales/checkout-repository.ts";
import { calculateCheckoutAmounts } from "../modules/sales/checkout-values.ts";
import { createPrismaRefundRepository } from "../modules/sales/refund-repository.ts";
import {
  baselineSchema,
  computeScopeMetrics,
  historyDigest,
  scopeKey,
  type Baseline,
} from "./demo-production-baseline.ts";
import {
  parseDemoProductionSpec,
  type DemoProductionSpec,
} from "./demo-production-spec.ts";

export type ProvisionMode = "verify" | "dry-run" | "apply" | "retire";

export class ProvisionRefusal extends Error {
  constructor(code: string) {
    super(`DEMOPROD_${code}`);
  }
}
const refuse = (code: string): never => {
  throw new ProvisionRefusal(code);
};

type Client = PrismaClient | Prisma.TransactionClient;
const mask = (value: string) => `${value.slice(0, 8)}…`;

/**
 * Organization-scoped tables whose existing rows must be byte-identical before
 * and after the import (evidence that no unrelated Production record changed).
 */
const censusTables = [
  "organization_memberships",
  "branch_assignments",
  "branches",
  "products",
  "suppliers",
  "categories",
  "purchase_orders",
  "purchase_order_items",
  "purchase_receipts",
  "purchase_receipt_items",
  "sales",
  "sale_items",
  "payments",
  "sale_refunds",
  "sale_refund_items",
  "refund_payments",
  "inventory_transactions",
  "inventory_balances",
  "inventory_cost_states",
] as const;

async function census(prisma: Client, targetOrganizationId: string) {
  const result: Record<string, string> = {};
  for (const table of censusTables) {
    const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint; h: string }>>(
      `SELECT count(*) AS n, md5(coalesce(string_agg(to_jsonb(t)::text, ',' ORDER BY to_jsonb(t)::text), '')) AS h FROM public.${table} t WHERE t.organization_id <> $1::uuid`,
      targetOrganizationId,
    );
    result[table] = `${rows[0]!.n}:${rows[0]!.h}`;
  }
  const orgs = await prisma.$queryRaw<Array<{ n: bigint; h: string }>>`
    SELECT count(*) AS n, md5(coalesce(string_agg(to_jsonb(o)::text, ',' ORDER BY o.id::text), '')) AS h
    FROM public.organizations o WHERE o.id <> ${targetOrganizationId}::uuid`;
  result.organizations = `${orgs[0]!.n}:${orgs[0]!.h}`;
  return result;
}

function changedTables(
  before: Record<string, string>,
  after: Record<string, string>,
) {
  return Object.keys(before).filter((key) => before[key] !== after[key]);
}

async function resolveMembers(prisma: Client, spec: DemoProductionSpec) {
  const rows = await prisma.$queryRaw<Array<{ id: string; hash: string }>>`
    SELECT u.id::text AS id, encode(sha256(convert_to(u.email, 'UTF8')), 'hex') AS hash FROM users u
    WHERE encode(sha256(convert_to(u.email, 'UTF8')), 'hex') = ANY(${spec.members.map((m) => m.emailSha256)}::text[])
      AND u.status = 'ACTIVE' AND u.email_verified_at IS NOT NULL
      AND EXISTS (SELECT 1 FROM better_auth_accounts a
                  WHERE a.user_id = u.id AND a.provider_id = 'credential' AND a.password IS NOT NULL)`;
  if (rows.length !== spec.members.length) refuse("MEMBER_ACCOUNT_NOT_USABLE");
  return spec.members.map((member) => {
    const row = rows.find((r) => r.hash === member.emailSha256);
    if (!row) return refuse("MEMBER_ACCOUNT_NOT_USABLE");
    return { ...member, userId: row!.id };
  });
}

function buildPlan(spec: DemoProductionSpec, ownerUserId: string): Demo30dPlan {
  return buildDemo30dPlan({
    referenceDate: spec.referenceDate,
    seed: spec.seed,
    reportingTimezone: spec.reportingTimezone,
    organizationId: spec.organization.id,
    branches: spec.branches.map((b) => ({ id: b.id, code: b.code })),
    products: spec.products.map((p) => ({
      id: p.id,
      name: p.name,
      sku: p.sku,
      unit: p.unit,
      basePrice: new Prisma.Decimal(p.basePrice).toFixed(4),
    })),
    settings: {
      actorUserId: ownerUserId,
      supplierId: spec.supplier.id,
      salesVatStatus: "NOT_REGISTERED",
      salesVatRate: null,
    },
  });
}

function expectedTotals(plan: Demo30dPlan) {
  let sales = new Prisma.Decimal(0);
  let refunds = new Prisma.Decimal(0);
  for (const sale of plan.sales) {
    const amounts = calculateCheckoutAmounts({
      discount: null,
      lines: sale.items.map((i) => ({
        productId: i.productId,
        quantity: new Prisma.Decimal(i.quantity),
        unitPrice: new Prisma.Decimal(i.expectedUnitPrice),
      })),
      salesVatStatus: "NOT_REGISTERED",
      salesVatRate: null,
    });
    assert(amounts, "Demo production sale amount is outside supported limits.");
    sales = sales.plus(amounts.totalAmount);
    if (sale.refund) refunds = refunds.plus(plan.products[0]!.basePrice);
  }
  return {
    saleCount: plan.sales.length,
    orderCount: plan.orders.length,
    refundCount: plan.sales.filter((s) => s.refund).length,
    salesAmount: sales.toFixed(2),
    refundAmount: refunds.toFixed(2),
    netRevenue: sales.minus(refunds).toFixed(2),
  };
}

/**
 * The stored plan must be exactly reproducible from its own inputs. jsonb does
 * not preserve key order and the plan signature hashes serialized inputs, so
 * the inputs are rebuilt in their canonical key order before regeneration.
 */
function planFromRun(stored: unknown): Demo30dPlan {
  assert(stored && typeof stored === "object", "Provenance plan invalid.");
  const r = stored as {
    referenceDate: string;
    seed: number;
    organizationId: string;
    reportingTimezone: string;
    branches: Array<{ id: string; code: string }>;
    products: Array<{
      id: string;
      name: string;
      sku: string;
      unit: "EA";
      basePrice: string;
    }>;
    settings: {
      actorUserId: string;
      supplierId: string;
      salesVatStatus: "NOT_REGISTERED" | "REGISTERED";
      salesVatRate: string | null;
    };
  };
  const rebuilt = buildDemo30dPlan({
    referenceDate: r.referenceDate,
    seed: r.seed,
    reportingTimezone: r.reportingTimezone,
    organizationId: r.organizationId,
    branches: r.branches.map((b) => ({ id: b.id, code: b.code })),
    products: r.products.map((p) => ({
      id: p.id,
      name: p.name,
      sku: p.sku,
      unit: p.unit,
      basePrice: p.basePrice,
    })),
    settings: {
      actorUserId: r.settings.actorUserId,
      supplierId: r.settings.supplierId,
      salesVatStatus: r.settings.salesVatStatus,
      salesVatRate: r.settings.salesVatRate,
    },
  });
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(rebuilt)),
    stored,
    "Provenance plan conflicts with deterministic regeneration.",
  );
  return rebuilt;
}

async function draftOrder(
  prisma: PrismaClient,
  plan: Demo30dPlan,
  order: Demo30dPlan["orders"][number],
  actor: { userId: string; membershipId: string },
) {
  return prisma.$transaction(async (tx) => {
    const id = demoId("purchase-order", order.reference);
    const existing = await tx.purchaseOrder.findUnique({
      where: { id },
      include: { items: true },
    });
    if (existing) {
      assert.equal(existing.organizationId, plan.organizationId);
      assert.equal(existing.reference, order.reference);
      assert.equal(existing.branchId, order.branchId);
      assert.equal(existing.items.length, order.items.length);
      return existing;
    }
    const items = order.items.map((item) => {
      const product = plan.products.find((p) => p.id === item.productId)!;
      return {
        ...item,
        quantity: new Prisma.Decimal(item.quantity),
        expectedUnitCost: new Prisma.Decimal(item.expectedUnitCost),
        productNameSnapshot: product.name,
        productSkuSnapshot: product.sku,
        createdAt: order.at,
        updatedAt: order.at,
      };
    });
    return tx.purchaseOrder.create({
      data: {
        id,
        reference: order.reference,
        organizationId: plan.organizationId,
        branchId: order.branchId,
        supplierId: plan.settings.supplierId,
        createdByUserId: actor.userId,
        createdByMembershipId: actor.membershipId,
        orderDate: new Date(`${order.date}T00:00:00Z`),
        expectedTotal: expectedPurchaseOrderTotal(items),
        createdAt: order.at,
        updatedAt: order.at,
        items: { create: items },
      },
      include: { items: true },
    });
  });
}

/** Events use the production writers with injected clocks; nothing is rewritten. */
async function writeEvents(
  prisma: PrismaClient,
  plan: Demo30dPlan,
  actor: { userId: string; membershipId: string },
  deadline: number,
) {
  const check = () =>
    assert(Date.now() < deadline, "Demo production execution deadline.");
  for (let day = 0; day < 30; day++) {
    for (const order of plan.orders.filter((o) => o.day === day)) {
      check();
      let draft = await draftOrder(prisma, plan, order, actor);
      if (draft.status === "DRAFT") {
        const result = await createPrismaPurchaseOrderRepository(
          prisma,
          () => order.at,
        ).updatePurchaseOrder({
          actorUserId: actor.userId,
          branchId: order.branchId,
          organizationId: plan.organizationId,
          purchaseOrderId: draft.id,
          purchaseOrder: {
            expectedUpdatedAt: draft.updatedAt,
            status: "ORDERED",
          },
        });
        assert.equal(
          result.kind,
          "success",
          "Demo production ordering failed.",
        );
        draft = await prisma.purchaseOrder.findUniqueOrThrow({
          where: { id: draft.id },
          include: { items: true },
        });
      }
      const received = await createPrismaReceivingRepository(prisma, {
        now: () => new Date(order.at.getTime() + 60_000),
      }).receivePurchaseOrder({
        actorUserId: actor.userId,
        organizationId: plan.organizationId,
        purchaseOrderId: draft.id,
        idempotencyKey: `${order.reference}-receive`,
        actualCosts: draft.items.map((i) => ({
          purchaseOrderItemId: i.id,
          actualUnitCost: i.expectedUnitCost.toFixed(4),
        })),
        vat: {
          organizationVatRegistered: false,
          inputVatRate: null,
          inputVatAmount: null,
          supplierTaxDocumentNumber: null,
          supplierTaxDocumentDate: null,
        },
      });
      assert(
        received.kind === "success" || received.kind === "replay",
        "Demo production receiving failed.",
      );
    }
    for (const sale of plan.sales.filter((s) => s.day === day)) {
      check();
      const amounts = calculateCheckoutAmounts({
        discount: null,
        lines: sale.items.map((i) => ({
          productId: i.productId,
          quantity: new Prisma.Decimal(i.quantity),
          unitPrice: new Prisma.Decimal(i.expectedUnitPrice),
        })),
        salesVatStatus: "NOT_REGISTERED",
        salesVatRate: null,
      });
      assert(amounts, "Demo production sale amount is outside limits.");
      const completed = await createPrismaCheckoutRepository(prisma, {
        now: () => sale.at,
      }).checkout({
        actorUserId: actor.userId,
        organizationId: plan.organizationId,
        branchId: sale.branchId,
        idempotencyKey: sale.key,
        discount: null,
        items: sale.items,
        payment:
          sale.method === "CASH"
            ? {
                method: "CASH",
                amountTendered: amounts.totalAmount.toFixed(2),
              }
            : { method: "TRANSFER", reference: sale.key },
      });
      assert(
        completed.kind === "success" || completed.kind === "replay",
        `Demo production checkout failed: ${completed.kind}.`,
      );
      if (sale.refund) {
        const refunded = await createPrismaRefundRepository(prisma, {
          now: () => new Date(sale.at.getTime() + 60_000),
        }).createRefund({
          actorUserId: actor.userId,
          organizationId: plan.organizationId,
          branchId: sale.branchId,
          idempotencyKey: `${sale.key}-refund`,
          saleId: completed.sale.id,
          reason: "Synthetic demo return",
          transferReference:
            sale.method === "TRANSFER" ? `${sale.key}-return` : null,
          items: [
            {
              saleItemId: completed.sale.items.find(
                (i) => i.productId === plan.products[0]!.id,
              )!.id,
              quantity: "1",
              restockQuantity: "1",
            },
          ],
        });
        assert(
          refunded.kind === "success" || refunded.kind === "replay",
          "Demo production refund failed.",
        );
      }
    }
  }
}

interface Preflight {
  spec: DemoProductionSpec;
  digest: string;
  plan: Demo30dPlan;
  members: Awaited<ReturnType<typeof resolveMembers>>;
  totals: ReturnType<typeof expectedTotals>;
  existing: "ABSENT" | "IN_PROGRESS" | "COMPLETE";
}

async function preflight(
  prisma: PrismaClient,
  rawSpec: string,
): Promise<Preflight> {
  const { spec, digest: specDigest } = parseDemoProductionSpec(rawSpec);
  const database = (
    await prisma.$queryRaw<Array<{ name: string }>>`
      SELECT current_database() AS name`
  )[0]?.name;
  if (database !== spec.database) refuse("DATABASE_MISMATCH");
  const members = await resolveMembers(prisma, spec);
  const owner = members.find((m) => m.role === "OWNER")!;
  // The approval also binds the resolved accounts: a recreated presenter account changes it.
  const digest = createHash("sha256")
    .update(
      `${specDigest}:${members
        .map((m) => `${m.role}=${m.userId}`)
        .sort()
        .join(",")}`,
    )
    .digest("hex")
    .slice(0, 16);
  const plan = buildPlan(spec, owner.userId);
  const currentLocalDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: spec.reportingTimezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  if (plan.to > currentLocalDate) refuse("INCOMPLETE_OR_FUTURE_DAY");
  const sameName = await prisma.organization.findMany({
    where: {
      name: { equals: spec.organization.name, mode: "insensitive" },
      id: { not: spec.organization.id },
    },
    select: { id: true },
  });
  if (sameName.length) refuse("ORGANIZATION_NAME_IN_USE");
  const organization = await prisma.organization.findUnique({
    where: { id: spec.organization.id },
    select: { name: true, status: true },
  });
  const run = await prisma.demoDatasetRun.findUnique({
    where: { organizationId: spec.organization.id },
  });
  if (organization && !run) refuse("ORGANIZATION_EXISTS_WITHOUT_PROVENANCE");
  if (!organization && run) refuse("PROVENANCE_WITHOUT_ORGANIZATION");
  if (run) {
    if (
      run.signature !== plan.signature ||
      run.name !== spec.organization.name ||
      organization?.name !== spec.organization.name
    )
      refuse("PROVENANCE_CONFLICT");
    planFromRun(run.plan);
    // A retired organization is never resumed or re-activated by an apply.
    if (organization?.status !== "ACTIVE" && run.state === "IN_PROGRESS")
      refuse("ORGANIZATION_RETIRED");
  }
  return {
    spec,
    digest,
    plan,
    members,
    totals: expectedTotals(plan),
    existing: run ? (run.state as "IN_PROGRESS" | "COMPLETE") : "ABSENT",
  };
}

/** A resumed or completed import must still hold exactly the approved master data and members. */
async function assertStagedMatchesSpec(prisma: PrismaClient, pre: Preflight) {
  const { spec } = pre;
  const organization = await prisma.organization.findUniqueOrThrow({
    where: { id: spec.organization.id },
    include: {
      branches: true,
      suppliers: true,
      memberships: { include: { branchAssignments: true } },
    },
  });
  const sameBranches =
    organization.branches.length === spec.branches.length &&
    spec.branches.every((b) =>
      organization.branches.some(
        (row) => row.id === b.id && row.code === b.code && row.name === b.name,
      ),
    );
  const sameSupplier =
    organization.suppliers.length === 1 &&
    organization.suppliers[0]!.id === spec.supplier.id &&
    organization.suppliers[0]!.name === spec.supplier.name;
  const sameMembers =
    organization.memberships.length === pre.members.length &&
    pre.members.every((member) => {
      const row = organization.memberships.find(
        (m) => m.userId === member.userId,
      );
      const wanted = member.branchCodes
        .map((code) => spec.branches.find((b) => b.code === code)!.id)
        .sort();
      const actual = row?.branchAssignments.map((a) => a.branchId).sort();
      return (
        row !== undefined &&
        row.role === member.role &&
        JSON.stringify(actual) === JSON.stringify(wanted)
      );
    });
  if (!sameBranches || !sameSupplier || !sameMembers)
    refuse("STAGED_DATA_DIFFERS_FROM_SPEC");
}

async function stageOne(prisma: PrismaClient, pre: Preflight) {
  const { spec, plan } = pre;
  // Master data predates the historical window so no row is newer than its events.
  const base = new Date(
    localDateToUtcBoundary(plan.from, spec.reportingTimezone).getTime() -
      30 * 86_400_000,
  );
  await prisma.$transaction(
    async (tx) => {
      await tx.organization.create({
        data: {
          id: spec.organization.id,
          name: spec.organization.name,
          status: "ACTIVE",
          salesVatStatus: "NOT_REGISTERED",
          reportingTimezone: spec.reportingTimezone,
          createdAt: base,
          updatedAt: base,
        },
      });
      for (const branch of spec.branches)
        await tx.branch.create({
          data: {
            id: branch.id,
            organizationId: spec.organization.id,
            code: branch.code,
            name: branch.name,
            createdAt: base,
            updatedAt: base,
          },
        });
      await tx.supplier.create({
        data: {
          id: spec.supplier.id,
          organizationId: spec.organization.id,
          name: spec.supplier.name,
          createdAt: base,
          updatedAt: base,
        },
      });
      for (const product of spec.products)
        await tx.product.create({
          data: {
            id: product.id,
            organizationId: spec.organization.id,
            sku: product.sku,
            name: product.name,
            unit: product.unit,
            basePrice: product.basePrice,
            createdAt: base,
            updatedAt: base,
          },
        });
      for (const member of pre.members) {
        const active = member.role === "OWNER";
        await tx.organizationMembership.create({
          data: {
            organizationId: spec.organization.id,
            userId: member.userId,
            role: member.role,
            // Only the OWNER (the import actor) is live until completion.
            status: active ? "ACTIVE" : "INACTIVE",
            deactivatedAt: active ? null : base,
            createdAt: base,
            updatedAt: base,
          },
        });
        for (const code of member.branchCodes)
          await tx.branchAssignment.create({
            data: {
              organizationId: spec.organization.id,
              userId: member.userId,
              branchId: spec.branches.find((b) => b.code === code)!.id,
              createdAt: base,
              updatedAt: base,
            },
          });
      }
      await tx.demoDatasetRun.create({
        data: {
          organizationId: spec.organization.id,
          name: spec.organization.name,
          signature: plan.signature,
          plan: JSON.parse(JSON.stringify(plan)) as Prisma.InputJsonValue,
          state: "IN_PROGRESS",
        },
      });
    },
    { timeout: 60_000 },
  );
}

export async function runProvision(
  prisma: PrismaClient,
  input: {
    mode: ProvisionMode;
    rawSpec?: string;
    confirmDigest?: string;
    maximumRunMilliseconds?: number;
  },
  write: (line: string) => void,
) {
  if (input.mode === "verify") {
    const runs = await prisma.demoDatasetRun.findMany({
      select: { organizationId: true, state: true, name: true },
    });
    write(`STOCKWISE_DEMO:VERIFY runs=${runs.length}`);
    for (const run of runs)
      write(
        `STOCKWISE_DEMO:RUN org=${mask(run.organizationId)} state=${run.state}`,
      );
    return;
  }
  const rawSpec = input.rawSpec;
  if (rawSpec === undefined) return refuse("SPEC_MISSING");
  if (input.mode === "retire") {
    // Needs only the provenance, never the presenter accounts: it must work when they changed.
    const { spec, retireDigest } = parseDemoProductionSpec(rawSpec);
    const database = (
      await prisma.$queryRaw<Array<{ name: string }>>`
        SELECT current_database() AS name`
    )[0]?.name;
    if (database !== spec.database) refuse("DATABASE_MISMATCH");
    if (input.confirmDigest !== retireDigest) refuse("DIGEST_MISMATCH");
    const at = new Date();
    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`demo-production:${spec.organization.id}`}, 0))`;
        const run = await tx.demoDatasetRun.findUnique({
          where: { organizationId: spec.organization.id },
        });
        if (!run) return refuse("NOTHING_TO_RETIRE");
        if (run.name !== spec.organization.name)
          return refuse("PROVENANCE_CONFLICT");
        // The OWNER stays: an organization must always keep its one OWNER (ADR-041).
        // Inactive organization status already denies every authorized read.
        await tx.organizationMembership.updateMany({
          where: {
            organizationId: spec.organization.id,
            status: "ACTIVE",
            role: { not: "OWNER" },
          },
          data: { status: "INACTIVE", deactivatedAt: at },
        });
        await tx.organization.updateMany({
          where: { id: spec.organization.id, status: "ACTIVE" },
          data: { status: "INACTIVE", deactivatedAt: at },
        });
      },
      { timeout: 60_000 },
    );
    write(`STOCKWISE_DEMO:RETIRED org=${mask(spec.organization.id)}`);
    return;
  }
  const pre = await preflight(prisma, rawSpec);
  const { spec, plan } = pre;
  const tag = mask(spec.organization.id);
  write(
    `STOCKWISE_DEMO:SPEC digest=${pre.digest} org=${tag} database=${spec.database} existing=${pre.existing}`,
  );
  write(
    `STOCKWISE_DEMO:PLAN window=${plan.from}..${plan.to} tz=${plan.reportingTimezone} sales=${pre.totals.saleCount} orders=${pre.totals.orderCount} refunds=${pre.totals.refundCount} sales_amount=${pre.totals.salesAmount} refund_amount=${pre.totals.refundAmount} net_revenue=${pre.totals.netRevenue}`,
  );
  for (const member of pre.members)
    write(
      `STOCKWISE_DEMO:MEMBER role=${member.role} user=${mask(member.userId)} branches=${member.branchCodes.join("+") || "all"}`,
    );
  if (input.mode === "dry-run") {
    write(
      `STOCKWISE_DEMO:RETIRE_DIGEST ${parseDemoProductionSpec(rawSpec).retireDigest}`,
    );
    write("STOCKWISE_DEMO:DRY_RUN:COMPLETE");
    return;
  }
  if (input.confirmDigest !== pre.digest) refuse("DIGEST_MISMATCH");

  // apply. The advisory lock serializes operators; every awaited command is
  // atomic and idempotent, so an interrupted run resumes from the same spec.
  const deadline = Date.now() + (input.maximumRunMilliseconds ?? 40 * 60_000);
  await prisma.$transaction(
    async (lock) => {
      await lock.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`demo-production:${spec.organization.id}`}, 0))`;
      // Preflight ran before the lock: another operator may have progressed since.
      const current = await prisma.demoDatasetRun.findUnique({
        where: { organizationId: spec.organization.id },
      });
      if (current && current.signature !== plan.signature)
        refuse("PROVENANCE_CONFLICT");
      const existing = current
        ? (current.state as "IN_PROGRESS" | "COMPLETE")
        : "ABSENT";
      // After COMPLETE the presenter may legitimately add members or edit master data; the history digest protects the baseline.
      if (existing === "IN_PROGRESS")
        await assertStagedMatchesSpec(prisma, pre);
      if (existing === "COMPLETE") {
        // Live trading continues after completion, so verify the immutable window, not the whole organization.
        const boundary = localDateToUtcBoundary(
          plan.to,
          spec.reportingTimezone,
        );
        assert.equal(
          await historyDigest(prisma, spec.organization.id, boundary),
          current!.historyDigest,
          "Demo production historical window differs from its recorded digest.",
        );
        write(`STOCKWISE_DEMO:ALREADY_COMPLETE org=${tag}`);
        return;
      }
      const before = await census(prisma, spec.organization.id);
      if (existing === "ABSENT") await stageOne(prisma, pre);
      const owner = pre.members.find((m) => m.role === "OWNER")!;
      const membership = await prisma.organizationMembership.findUniqueOrThrow({
        where: {
          organizationId_userId: {
            organizationId: spec.organization.id,
            userId: owner.userId,
          },
        },
      });
      if (existing === "IN_PROGRESS") await assertDemoHistory(prisma, plan);
      await writeEvents(
        prisma,
        plan,
        { userId: owner.userId, membershipId: membership.id },
        deadline,
      );
      await assertDemoHistory(prisma, plan, true);

      const boundary = localDateToUtcBoundary(plan.to, spec.reportingTimezone);
      const codec = createAnalyticsDimensionCursorCodec(randomBytes(32));
      const range = { from: plan.from, to: plan.to };
      const scopes: Baseline["scopes"] = {};
      for (const scope of [
        { kind: "organization" as const },
        ...spec.branches.map((b) => ({
          kind: "branch" as const,
          branchId: b.id,
        })),
      ]) {
        const metrics = await computeScopeMetrics(
          prisma,
          codec,
          {
            actorUserId: owner.userId,
            organizationId: spec.organization.id,
            scope,
          },
          range,
          boundary,
        );
        if (!metrics) return refuse("BASELINE_UNAVAILABLE");
        scopes[scopeKey(scope)] = metrics;
      }
      const baseline = baselineSchema.parse({
        version: 1,
        from: plan.from,
        to: plan.to,
        reportingTimezone: spec.reportingTimezone,
        scopes,
      });
      const org = baseline.scopes.organization!;
      // Independent cross-check of the analytics engine against the ledger.
      const sql = await prisma.$queryRaw<
        Array<{ sales: string; refunds: string; n: bigint; r: bigint }>
      >`SELECT (SELECT coalesce(sum(total_amount),0)::text FROM sales WHERE organization_id=${spec.organization.id}::uuid) AS sales,
               (SELECT coalesce(sum(total_amount),0)::text FROM sale_refunds WHERE organization_id=${spec.organization.id}::uuid) AS refunds,
               (SELECT count(*) FROM sales WHERE organization_id=${spec.organization.id}::uuid) AS n,
               (SELECT count(*) FROM sale_refunds WHERE organization_id=${spec.organization.id}::uuid) AS r`;
      const ledgerNet = new Prisma.Decimal(sql[0]!.sales)
        .minus(sql[0]!.refunds)
        .toFixed(2);
      assert(
        ledgerNet === pre.totals.netRevenue &&
          org.netRevenue === pre.totals.netRevenue &&
          Number(sql[0]!.n) === pre.totals.saleCount &&
          org.saleCount === pre.totals.saleCount &&
          Number(sql[0]!.r) === pre.totals.refundCount,
        "Demo production totals do not reconcile with the plan.",
      );

      await prisma.$transaction(
        async (tx) => {
          await assertDemoHistory(tx, plan, true);
          const digest = await historyDigest(
            tx,
            spec.organization.id,
            boundary,
          );
          await tx.demoDatasetRun.update({
            where: { organizationId: spec.organization.id },
            data: {
              state: "COMPLETE",
              baseline: baseline as unknown as Prisma.InputJsonValue,
              historyDigest: digest,
              completedAt: new Date(),
            },
          });
          await tx.organizationMembership.updateMany({
            where: {
              organizationId: spec.organization.id,
              status: "INACTIVE",
            },
            data: { status: "ACTIVE", deactivatedAt: null },
          });
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
          timeout: 60_000,
        },
      );
      const owners = await prisma.organizationMembership.count({
        where: {
          organizationId: spec.organization.id,
          role: "OWNER",
          status: "ACTIVE",
        },
      });
      assert.equal(owners, 1, "Exactly one active OWNER is required.");
      const after = await census(prisma, spec.organization.id);
      const changed = changedTables(before, after);
      // Evidence only: other organizations are live, so a difference is reported, never fatal.
      write(
        `STOCKWISE_DEMO:CENSUS tables=${Object.keys(before).length} changed=${changed.length === 0 ? "none" : changed.join("+")} (informational)`,
      );
      write(
        `STOCKWISE_DEMO:RECONCILED sales=${org.saleCount} net_revenue=${org.netRevenue} refunds=${sql[0]!.r} ledger_net=${ledgerNet}`,
      );
    },
    { timeout: input.maximumRunMilliseconds ?? 45 * 60_000, maxWait: 30_000 },
  );
  write(`STOCKWISE_DEMO:APPLIED org=${tag} digest=${pre.digest}`);
}

export const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");
