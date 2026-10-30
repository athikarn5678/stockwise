import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { z } from "zod";

import { Prisma } from "../generated/prisma/client.ts";
import {
  calculateCheckoutAmounts,
  checkoutIdempotencyKeyHash,
} from "../modules/sales/checkout-values.ts";
import {
  calculateRefundLineAmounts,
  refundIdempotencyKeyHash,
} from "../modules/sales/refund-values.ts";
import { buildDemo30dPlan, type Demo30dPlan } from "./demo-30d-plan.ts";

// Local fixture metadata lives outside the canonical application's public schema.
export async function initializeDemoProvenance(
  prisma: Prisma.TransactionClient,
) {
  await prisma.$executeRawUnsafe("CREATE SCHEMA IF NOT EXISTS stockwise_demo");
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS stockwise_demo.seed_runs (
    organization_id uuid PRIMARY KEY, plan jsonb NOT NULL, signature text NOT NULL,
    state text NOT NULL CHECK (state IN ('IN_PROGRESS','COMPLETE')), fingerprint text)`);
}

const tables = [
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

export async function demoBusinessFingerprint(
  prisma: Prisma.TransactionClient,
  organizationId: string,
) {
  const digest = createHash("sha256");
  for (const table of [...tables, "products", "branches"]) {
    const rows = await prisma.$queryRawUnsafe<Array<{ rows: string }>>(
      `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id)::text, '[]') AS rows FROM public.${table} t WHERE organization_id=$1::uuid`,
      organizationId,
    );
    digest.update(table).update(rows[0]!.rows);
  }
  return digest.digest("hex");
}

export async function assertDemoOrganizationEmpty(
  prisma: Prisma.TransactionClient,
  organizationId: string,
) {
  for (const table of tables) {
    const rows = await prisma.$queryRawUnsafe<unknown[]>(
      `SELECT 1 FROM public.${table} WHERE organization_id=$1::uuid LIMIT 1`,
      organizationId,
    );
    assert(
      rows.length === 0,
      "Demo30d refuses unrelated business history anywhere in the organization; use a fresh disposable fixture.",
    );
  }
}

const productSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  sku: z.string(),
  unit: z.enum(["EA", "KG", "G", "L", "ML", "BOX", "PACK", "M", "CM"]),
  basePrice: z.string(),
});
const planInputSchema = z.object({
  referenceDate: z.string(),
  seed: z.number(),
  organizationId: z.uuid(),
  reportingTimezone: z.string(),
  branches: z.array(z.object({ id: z.uuid(), code: z.string() })),
  products: z.array(productSchema),
  settings: z.object({
    actorUserId: z.uuid(),
    supplierId: z.uuid(),
    salesVatStatus: z.enum(["NOT_REGISTERED", "REGISTERED"]),
    salesVatRate: z.string().nullable(),
  }),
});

export async function readDemoProvenance(
  prisma: Prisma.TransactionClient,
  organizationId: string,
) {
  const exists = await prisma.$queryRaw<
    Array<{ exists: string | null }>
  >`SELECT to_regclass('stockwise_demo.seed_runs')::text AS exists`;
  if (!exists[0]?.exists) return null;
  const rows = await prisma.$queryRaw<
    Array<{
      plan: unknown;
      signature: string;
      state: string;
      fingerprint: string | null;
    }>
  >`SELECT plan,signature,state,fingerprint FROM stockwise_demo.seed_runs WHERE organization_id=${organizationId}::uuid`;
  if (!rows[0]) return null;
  const row = rows[0];
  const parsed = planInputSchema.safeParse(row.plan);
  if (!parsed.success) throw new Error("Demo30d provenance is invalid.");
  const plan = buildDemo30dPlan(parsed.data);
  const same = await prisma.$queryRaw<
    Array<{ same: boolean }>
  >`SELECT ${JSON.stringify(plan)}::jsonb = ${JSON.stringify(row.plan)}::jsonb AS same`;
  assert(
    plan.signature === row.signature &&
      plan.organizationId === organizationId &&
      same[0]?.same,
    "Demo30d provenance conflicts with the deterministic plan.",
  );
  return { ...row, plan };
}

/** Validate every organization event, including branches/products outside the selected subset. */
export async function assertDemoHistory(
  prisma: Prisma.TransactionClient,
  plan: Demo30dPlan,
  complete = false,
) {
  const where = { organizationId: plan.organizationId };
  const orders = await prisma.purchaseOrder.findMany({
    where,
    include: { items: true, receipt: { include: { items: true } } },
  });
  const sales = await prisma.sale.findMany({
    where,
    include: {
      items: true,
      payment: true,
      refunds: { include: { items: true, payment: true } },
    },
  });
  const movements = await prisma.inventoryTransaction.findMany({ where });
  const allowedMovements = new Map<
    string,
    {
      source: string;
      branchId: string;
      productId: string;
      delta: Prisma.Decimal;
      at: Date;
    }
  >();
  for (const order of orders) {
    const expected = plan.orders.find((o) => o.reference === order.reference);
    assert(
      expected &&
        order.branchId === expected.branchId &&
        order.supplierId === plan.settings.supplierId &&
        ["DRAFT", "ORDERED", "RECEIVED"].includes(order.status),
      "Demo30d contains an unrecognized purchase order.",
    );
    assert(
      order.createdAt.getTime() === expected.at.getTime() &&
        order.items.length === expected.items.length,
      "Demo30d order differs from provenance.",
    );
    for (const item of order.items) {
      const line = expected.items.find((i) => i.productId === item.productId);
      assert(
        line &&
          item.quantity.eq(line.quantity) &&
          item.expectedUnitCost.eq(line.expectedUnitCost),
        "Demo30d order item differs from provenance.",
      );
    }
    assert(
      !order.receipt || order.status === "RECEIVED",
      "Demo30d duplicate receipt.",
    );
    for (const receipt of order.receipt ? [order.receipt] : []) {
      assert(
        order.status === "RECEIVED" &&
          receipt.branchId === expected.branchId &&
          receipt.receivedAt.getTime() === expected.at.getTime() + 60_000 &&
          receipt.items.length === expected.items.length,
        "Demo30d receipt differs from provenance.",
      );
      for (const item of receipt.items) {
        const line = expected.items.find((i) => i.productId === item.productId);
        assert(
          line &&
            item.receivedQuantity.eq(line.quantity) &&
            item.actualUnitCost.eq(line.expectedUnitCost),
          "Demo30d receipt item differs from provenance.",
        );
        allowedMovements.set(item.id, {
          source: "PURCHASE_RECEIVE",
          branchId: order.branchId,
          productId: item.productId,
          delta: item.receivedQuantity,
          at: receipt.receivedAt,
        });
      }
    }
  }
  for (const sale of sales) {
    const expected = plan.sales.find(
      (s) => checkoutIdempotencyKeyHash(s.key) === sale.idempotencyKeyHash,
    );
    assert(
      expected &&
        sale.branchId === expected.branchId &&
        sale.completedAt.getTime() === expected.at.getTime() &&
        sale.items.length === expected.items.length,
      "Demo30d contains an unrecognized sale.",
    );
    const amounts = calculateCheckoutAmounts({
      discount: null,
      lines: expected.items.map((i) => ({
        productId: i.productId,
        quantity: new Prisma.Decimal(i.quantity),
        unitPrice: new Prisma.Decimal(i.expectedUnitPrice),
      })),
      salesVatStatus: plan.settings.salesVatStatus,
      salesVatRate:
        plan.settings.salesVatRate === null
          ? null
          : new Prisma.Decimal(plan.settings.salesVatRate),
    });
    assert(
      amounts &&
        sale.totalAmount.eq(amounts.totalAmount) &&
        sale.subtotalAmount.eq(amounts.subtotalAmount) &&
        sale.discountAmount.eq(0) &&
        sale.outputVatAmount.eq(amounts.outputVatAmount),
      "Demo30d monetary totals differ from provenance.",
    );
    assert(
      sale.payment &&
        sale.payment.amount.eq(sale.totalAmount) &&
        sale.payment.method === expected.method,
      "Demo30d payment differs from provenance.",
    );
    for (const item of sale.items) {
      const line = expected.items.find((i) => i.productId === item.productId);
      assert(
        line &&
          item.quantity.eq(line.quantity) &&
          item.unitPrice.eq(line.expectedUnitPrice),
        "Demo30d sale item differs from provenance.",
      );
      const expectedAmounts = amounts.lines.find(
        (l) => l.productId === item.productId,
      )!;
      assert(
        item.lineNet.eq(expectedAmounts.lineNet) &&
          item.lineGross.eq(expectedAmounts.lineGross) &&
          item.lineDiscount.eq(0) &&
          item.lineOutputVat.eq(expectedAmounts.lineOutputVat) &&
          item.unitCost?.eq(
            new Prisma.Decimal(line.expectedUnitPrice).div(2),
          ) &&
          item.cogsAmount?.eq(item.quantity.times(item.unitCost)),
        "Demo30d sale amount/cost snapshot differs from provenance.",
      );
      allowedMovements.set(item.id, {
        source: "SALE",
        branchId: sale.branchId,
        productId: item.productId,
        delta: item.quantity.neg(),
        at: sale.completedAt,
      });
    }
    assert(
      sale.refunds.length <= (expected.refund ? 1 : 0),
      "Demo30d unrecognized refund.",
    );
    for (const refund of sale.refunds) {
      assert(
        refund.idempotencyKeyHash ===
          refundIdempotencyKeyHash(`${expected.key}-refund`) &&
          refund.completedAt.getTime() === expected.at.getTime() + 60_000 &&
          refund.items.length === 1 &&
          refund.payment?.amount.eq(refund.totalAmount),
        "Demo30d refund differs from provenance.",
      );
      const item = refund.items[0]!;
      assert(
        item.productId === plan.products[0]!.id &&
          item.refundQuantity.eq(1) &&
          item.restockQuantity.eq(1),
        "Demo30d refund item differs from provenance.",
      );
      const original = sale.items.find((i) => i.id === item.saleItemId);
      assert(original, "Demo30d refund source differs from provenance.");
      const zero = new Prisma.Decimal(0);
      const reversed = calculateRefundLineAmounts({
        cumulativeQuantity: item.refundQuantity,
        cumulativeRestockQuantity: item.restockQuantity,
        originalCogsAmount: original.cogsAmount,
        originalLineDiscount: original.lineDiscount,
        originalLineNet: original.lineNet,
        originalLineOutputVat: original.lineOutputVat,
        originalQuantity: original.quantity,
        priorCogsReversal: zero,
        priorLineDiscount: zero,
        priorLineNet: zero,
        priorLineOutputVat: zero,
        salesVatStatus: plan.settings.salesVatStatus,
      });
      assert(
        refund.totalAmount.eq(reversed.reversedLineNet) &&
          item.reversedLineNet.eq(reversed.reversedLineNet) &&
          item.reversedLineOutputVat.eq(reversed.reversedLineOutputVat) &&
          item.cogsReversalAmount?.eq(reversed.cogsReversalAmount!),
        "Demo30d refund amounts differ from provenance.",
      );
      allowedMovements.set(item.id, {
        source: "SALE_REFUND_RETURN",
        branchId: sale.branchId,
        productId: item.productId,
        delta: item.restockQuantity,
        at: refund.completedAt,
      });
    }
  }
  assert(
    movements.length === allowedMovements.size,
    "Demo30d inventory history differs from provenance.",
  );
  const balances = new Map<string, Prisma.Decimal>();
  const seen = new Set<string>();
  for (const movement of movements) {
    const id =
      movement.purchaseReceiptItemId ??
      movement.saleItemId ??
      movement.saleRefundItemId;
    const expected = id ? allowedMovements.get(id) : undefined;
    assert(
      id &&
        !seen.has(id) &&
        expected &&
        movement.source === expected.source &&
        movement.branchId === expected.branchId &&
        movement.productId === expected.productId &&
        movement.delta.eq(expected.delta) &&
        movement.occurredAt.getTime() === expected.at.getTime(),
      "Demo30d unrecognized inventory event.",
    );
    seen.add(id);
    const key = `${movement.branchId}:${movement.productId}`;
    balances.set(
      key,
      (balances.get(key) ?? new Prisma.Decimal(0)).plus(movement.delta),
    );
  }
  const actualBalances = await prisma.inventoryBalance.findMany({ where });
  const costs = await prisma.inventoryCostState.findMany({ where });
  assert(
    actualBalances.length === balances.size && costs.length === balances.size,
    "Demo30d projection count differs from provenance.",
  );
  for (const balance of actualBalances) {
    const expected = balances.get(`${balance.branchId}:${balance.productId}`);
    const cost = costs.find(
      (c) =>
        c.branchId === balance.branchId && c.productId === balance.productId,
    );
    const product = plan.products.find((p) => p.id === balance.productId);
    assert(
      expected &&
        product &&
        balance.quantity.eq(expected) &&
        balance.quantity.gte(0) &&
        cost?.averageUnitCost?.eq(
          new Prisma.Decimal(product.basePrice).div(2),
        ) &&
        cost.inventoryValue?.eq(balance.quantity.times(cost.averageUnitCost)),
      "Demo30d balance/cost differs from provenance.",
    );
  }
  if (complete) {
    assert(
      sales.length === plan.sales.length &&
        orders.length === plan.orders.length &&
        orders.every((o) => o.receipt !== null) &&
        sales.flatMap((s) => s.refunds).length ===
          plan.sales.filter((s) => s.refund).length,
      "Demo30d provenance is incomplete.",
    );
  }
}
