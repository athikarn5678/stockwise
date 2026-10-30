import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

import { Client } from "pg";

import { verifyDemoDatabase } from "./demo-local-database.ts";
import {
  initializeDemoProvenance,
  readDemoProvenance,
  assertDemoHistory,
  assertDemoOrganizationEmpty,
  demoBusinessFingerprint,
} from "./demo-30d-provenance.ts";

import { Prisma, type PrismaClient } from "../generated/prisma/client.ts";
import { createPrismaPurchaseOrderRepository } from "../modules/purchasing/purchase-order-repository.ts";
import { expectedPurchaseOrderTotal } from "../modules/purchasing/purchase-order-values.ts";
import { createPrismaReceivingRepository } from "../modules/purchasing/receiving-repository.ts";
import { createPrismaCheckoutRepository } from "../modules/sales/checkout-repository.ts";
import { calculateCheckoutAmounts } from "../modules/sales/checkout-values.ts";
import { createPrismaRefundRepository } from "../modules/sales/refund-repository.ts";
import {
  buildDemo30dPlan,
  DEMO_30D_ORGANIZATION,
  type Demo30dPlan,
} from "./demo-30d-plan.ts";
import { demoId } from "./demo-values.ts";

export async function prepareDemo30d(
  prisma: PrismaClient,
  options: {
    organizationId: string;
    referenceDate: string;
    seed: number;
  },
) {
  const organization = await prisma.organization.findUnique({
    where: { id: options.organizationId },
    include: {
      branches: { where: { status: "ACTIVE" }, orderBy: { code: "asc" } },
      products: {
        where: { status: "ACTIVE", basePrice: { gt: 0 } },
        orderBy: { sku: "asc" },
      },
      memberships: {
        where: {
          role: "OWNER",
          status: "ACTIVE",
          user: { status: "ACTIVE", emailVerifiedAt: { not: null } },
        },
      },
      suppliers: { where: { status: "ACTIVE" }, orderBy: { id: "asc" } },
    },
  });
  if (
    organization?.name !== DEMO_30D_ORGANIZATION ||
    organization.status !== "ACTIVE" ||
    organization.memberships.length !== 1 ||
    !organization.suppliers[0]
  )
    throw new Error(
      "Demo30d target must be the allowlisted synthetic organization with one verified OWNER and an active supplier.",
    );
  if (organization.salesVatStatus === "UNCONFIGURED")
    throw new Error(
      "Demo30d requires an existing configured sales VAT policy.",
    );
  const plan = buildDemo30dPlan({
    ...options,
    reportingTimezone: organization.reportingTimezone,
    branches: organization.branches,
    settings: {
      actorUserId: organization.memberships[0]!.userId,
      supplierId: organization.suppliers[0].id,
      salesVatStatus: organization.salesVatStatus,
      salesVatRate: organization.salesVatRate?.toFixed(6) ?? null,
    },
    products: organization.products.map((p) => ({
      id: p.id,
      name: p.name,
      sku: p.sku,
      unit: p.unit,
      basePrice: p.basePrice.toFixed(4),
    })),
  });
  const currentLocalDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: organization.reportingTimezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  if (plan.to > currentLocalDate)
    throw new Error(
      "Demo30d cannot generate incomplete or future calendar days.",
    );
  const provenance = await readDemoProvenance(prisma, options.organizationId);
  if (provenance) {
    assert(
      provenance.signature === plan.signature,
      "Demo30d parameters differ from recorded provenance; use a fresh disposable fixture.",
    );
    if (provenance.state === "COMPLETE") {
      assert(
        provenance.fingerprint ===
          (await demoBusinessFingerprint(prisma, plan.organizationId)),
        "Demo30d completed history conflicts with provenance.",
      );
    } else await assertDemoHistory(prisma, plan);
  } else await assertDemoOrganizationEmpty(prisma, plan.organizationId);
  return {
    plan,
    actorUserId: organization.memberships[0]!.userId,
    membershipId: organization.memberships[0]!.id,
    supplierId: organization.suppliers[0].id,
  };
}

/** Historical draft adapter is confined to demo tooling; completed facts use production writers. */
async function draftOrder(
  prisma: PrismaClient,
  target: Awaited<ReturnType<typeof prepareDemo30d>>,
  order: Demo30dPlan["orders"][number],
) {
  return prisma.$transaction(async (tx) => {
    const id = demoId("purchase-order", order.reference);
    const existing = await tx.purchaseOrder.findUnique({
      where: { id },
      include: { items: true },
    });
    if (existing) {
      assert.equal(existing.organizationId, target.plan.organizationId);
      assert.equal(existing.reference, order.reference);
      assert.equal(existing.branchId, order.branchId);
      assert.equal(existing.supplierId, target.supplierId);
      assert.equal(existing.items.length, order.items.length);
      for (const expected of order.items) {
        const item = existing.items.find(
          (i) => i.productId === expected.productId,
        );
        assert(
          item &&
            item.quantity.eq(expected.quantity) &&
            item.expectedUnitCost.eq(expected.expectedUnitCost),
          "Demo30d draft manifest changed.",
        );
      }
      return existing;
    }
    const items = order.items.map((item) => {
      const product = target.plan.products.find(
        (p) => p.id === item.productId,
      )!;
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
        organizationId: target.plan.organizationId,
        branchId: order.branchId,
        supplierId: target.supplierId,
        createdByUserId: target.actorUserId,
        createdByMembershipId: target.membershipId,
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

export async function runDemo30d(
  prisma: PrismaClient,
  options: {
    organizationId: string;
    referenceDate: string;
    seed: number;
    apply: boolean;
    // Test coordination runs between atomic commands; no detached work is allowed.
    afterCommand?: () => Promise<void>;
    maximumRunMilliseconds?: number;
    lockWaitMilliseconds?: number;
  },
) {
  const databaseUrl = await verifyDemoDatabase(prisma);
  // Session ownership survives command deadlines; finally runs only after all awaited commands settle.
  const lock = new Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5000,
    query_timeout: 210_000,
  });
  let connectionLost = false;
  lock.on("error", () => {
    connectionLost = true;
  });
  lock.on("end", () => {
    connectionLost = true;
  });
  await lock.connect();
  try {
    const wait = options.lockWaitMilliseconds ?? 200_000;
    assert(
      Number.isInteger(wait) && wait > 0 && wait <= 200_000,
      "Demo30d invalid lock wait.",
    );
    await lock.query("SELECT set_config('lock_timeout', $1, false)", [
      String(wait),
    ]);
    await lock.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [
      `demo30d:${options.organizationId}`,
    ]);
    const started = performance.now();
    const maximum = options.maximumRunMilliseconds ?? 180_000;
    assert(
      Number.isFinite(maximum) && maximum > 0 && maximum <= 180_000,
      "Demo30d invalid execution deadline.",
    );
    const check = () =>
      assert(
        !connectionLost && performance.now() - started < maximum,
        "Demo30d execution deadline or lock connection failed; resume the same manifest.",
      );
    const afterCommand = async () => {
      await options.afterCommand?.();
      check();
    };
    const target = await prepareDemo30d(prisma, options);
    const { plan, actorUserId } = target;
    if (!options.apply)
      return {
        status: "PREVIEW" as const,
        signature: plan.signature,
        from: plan.from,
        to: plan.to,
        saleCount: plan.sales.length,
        orderCount: plan.orders.length,
        refundCount: plan.sales.filter((s) => s.refund).length,
      };
    await initializeDemoProvenance(prisma);
    await prisma.$executeRaw`INSERT INTO stockwise_demo.seed_runs(organization_id,plan,signature,state)
        VALUES (${plan.organizationId}::uuid,${JSON.stringify(plan)}::jsonb,${plan.signature},'IN_PROGRESS')
        ON CONFLICT (organization_id) DO NOTHING`;
    for (let day = 0; day < 30; day++) {
      for (const order of plan.orders.filter((o) => o.day === day)) {
        check();
        let draft = await draftOrder(prisma, target, order);
        await afterCommand();
        if (draft.status === "DRAFT") {
          const result = await createPrismaPurchaseOrderRepository(
            prisma,
            () => order.at,
          ).updatePurchaseOrder({
            actorUserId,
            branchId: order.branchId,
            organizationId: plan.organizationId,
            purchaseOrderId: draft.id,
            purchaseOrder: {
              expectedUpdatedAt: draft.updatedAt,
              status: "ORDERED",
            },
          });
          assert.equal(result.kind, "success", "Demo30d ordering failed.");
          await afterCommand();
          draft = await prisma.purchaseOrder.findUniqueOrThrow({
            where: { id: draft.id },
            include: { items: true },
          });
        }
        check();
        const received = await createPrismaReceivingRepository(prisma, {
          now: () => new Date(order.at.getTime() + 60_000),
        }).receivePurchaseOrder({
          actorUserId,
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
          "Demo30d receiving failed.",
        );
        await afterCommand();
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
          salesVatStatus: plan.settings.salesVatStatus,
          salesVatRate:
            plan.settings.salesVatRate === null
              ? null
              : new Prisma.Decimal(plan.settings.salesVatRate),
        });
        assert(amounts, "Demo30d sale amount is outside supported limits.");
        const completed = await createPrismaCheckoutRepository(prisma, {
          now: () => sale.at,
        }).checkout({
          actorUserId,
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
          `Demo30d checkout failed: ${completed.kind}.`,
        );
        await afterCommand();
        if (sale.refund) {
          const refunded = await createPrismaRefundRepository(prisma, {
            now: () => new Date(sale.at.getTime() + 60_000),
          }).createRefund({
            actorUserId,
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
            "Demo30d refund failed.",
          );
          await afterCommand();
        }
      }
    }
    // Validation and its fingerprint must describe one snapshot, even if a writer races completion.
    await prisma.$transaction(
      async (tx) => {
        await assertDemoHistory(tx, plan, true);
        const fingerprint = await demoBusinessFingerprint(
          tx,
          plan.organizationId,
        );
        await tx.$executeRaw`UPDATE stockwise_demo.seed_runs SET state='COMPLETE',fingerprint=${fingerprint} WHERE organization_id=${plan.organizationId}::uuid AND signature=${plan.signature}`;
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        timeout: 15_000,
      },
    );
    return {
      status: "APPLIED" as const,
      signature: plan.signature,
      from: plan.from,
      to: plan.to,
      saleCount: plan.sales.length,
      orderCount: plan.orders.length,
      refundCount: plan.sales.filter((s) => s.refund).length,
    };
  } finally {
    await lock.end();
  }
}
