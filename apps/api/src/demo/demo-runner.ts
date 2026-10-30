import { createHash } from "node:crypto";
import { verifyDemoDatabase } from "./demo-local-database.ts";
import { readdirSync } from "node:fs";

import { Prisma, type PrismaClient } from "../generated/prisma/client.ts";
import { verifyPassword } from "../modules/identity/password-hasher.ts";
import { buildDemoFixture } from "./demo-fixture.ts";
import {
  DEMO_COUNTED_TABLES,
  DEMO_TRANSITION_TABLE,
  DEMO_USER_NATIVE_DEFAULTS,
  assertDemoSchema,
} from "./demo-schema.ts";

type Transaction = Prisma.TransactionClient;
type Fixture = Awaited<ReturnType<typeof buildDemoFixture>>;
const frozenLogicalFingerprint =
  "13cee268f76494c22ab2dd36103d66f31f0d2d02ecbac7e7f645a9517d307bcd";

function demoLogicalFingerprint(fixture: Fixture): string {
  const rows = [
    fixture.organization,
    fixture.branchRows,
    fixture.userRows,
    fixture.memberships,
    fixture.assignments,
    fixture.onboarding,
    fixture.categories,
    fixture.productRows,
    fixture.suppliers,
    fixture.orders,
    fixture.orderItems,
    fixture.receipts,
    fixture.receiptItems,
    fixture.sales,
    fixture.saleItems,
    fixture.payments,
    fixture.refunds,
    fixture.refundItems,
    fixture.refundPayments,
    fixture.balances,
    fixture.costs,
    fixture.movements,
  ];
  return createHash("sha256")
    .update(
      JSON.stringify(
        rows.map((table) =>
          table.map((row) => JSON.stringify(canonical(row))).sort(),
        ),
      ),
    )
    .digest("hex");
}

const tables = DEMO_COUNTED_TABLES;

function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Prisma.Decimal.isDecimal(value)) return value.toString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "passwordHash")
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

function equalRows(
  name: string,
  expected: readonly unknown[],
  actual: readonly unknown[],
): void {
  const serialize = (rows: readonly unknown[]) =>
    rows.map((row) => JSON.stringify(canonical(row))).sort();
  const left = serialize(expected);
  const right = serialize(actual);
  if (
    left.length !== right.length ||
    left.some((row, index) => row !== right[index])
  ) {
    throw new Error(
      `${name} differs from the complete stockwise-demo-v1 manifest.`,
    );
  }
}

/** Refuses any target that is not exactly the committed, LEGACY-fenced schema. */
export async function assertDemoTargetSchema(tx: Transaction): Promise<void> {
  const publicTables = await tx.$queryRaw<
    Array<{ tablename: string }>
  >(Prisma.sql`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
  `);
  const migrations = await tx.$queryRaw<
    Array<{
      migration_name: string;
      finished_at: Date | null;
      rolled_back_at: Date | null;
    }>
  >(Prisma.sql`
    SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations
  `);
  const localMigrations = readdirSync(
    new URL("../../prisma/migrations/", import.meta.url),
    { withFileTypes: true },
  )
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const tableNames = publicTables.map((row) => row.tablename);
  // The fence row is read only when its table is part of the exact manifest.
  const transition = tableNames.includes(DEMO_TRANSITION_TABLE)
    ? await tx.$queryRaw<Array<{ state: string }>>(Prisma.sql`
        SELECT state FROM native_auth_transition
      `)
    : [];
  assertDemoSchema({
    tables: tableNames,
    migrations: migrations.map((row) => ({
      name: row.migration_name,
      finished: row.finished_at !== null,
      rolledBack: row.rolled_back_at !== null,
    })),
    localMigrations,
    transitionStates: transition.map((row) => row.state),
  });
}

async function tableCounts(tx: Transaction): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const table of tables) {
    const result = await tx.$queryRawUnsafe<Array<{ count: number }>>(
      `SELECT count(*)::integer AS count FROM "${table}"`,
    );
    counts.set(table, result[0]!.count);
  }
  return counts;
}

async function verifyManifest(
  tx: Transaction,
  fixture: Fixture,
  password: string,
): Promise<void> {
  const expectedCounts = new Map<string, number>([
    ["organizations", fixture.organization.length],
    ["branches", fixture.branchRows.length],
    ["branch_status_events", fixture.branchRows.length],
    ["users", fixture.userRows.length],
    ["organization_memberships", fixture.memberships.length],
    ["branch_assignments", fixture.assignments.length],
    ["first_organization_onboardings", fixture.onboarding.length],
    ["categories", fixture.categories.length],
    ["products", fixture.productRows.length],
    ["suppliers", fixture.suppliers.length],
    ["purchase_orders", fixture.orders.length],
    ["purchase_order_items", fixture.orderItems.length],
    ["purchase_receipts", fixture.receipts.length],
    ["purchase_receipt_items", fixture.receiptItems.length],
    ["sales", fixture.sales.length],
    ["sale_items", fixture.saleItems.length],
    ["payments", fixture.payments.length],
    ["sale_refunds", fixture.refunds.length],
    ["sale_refund_items", fixture.refundItems.length],
    ["refund_payments", fixture.refundPayments.length],
    ["inventory_balances", fixture.balances.length],
    ["inventory_cost_states", fixture.costs.length],
    ["inventory_transactions", fixture.movements.length],
  ]);
  const counts = await tableCounts(tx);
  for (const [table, count] of counts) {
    if (count !== (expectedCounts.get(table) ?? 0))
      throw new Error(`${table} row count differs from the fixture.`);
  }
  equalRows(
    "organizations",
    fixture.organization,
    await tx.organization.findMany(),
  );
  equalRows("branches", fixture.branchRows, await tx.branch.findMany());
  equalRows(
    "branch_status_events",
    fixture.branchRows.map((branch) => ({
      branchId: branch.id,
      organizationId: branch.organizationId,
      status: branch.status ?? "ACTIVE",
      effectiveAt: branch.createdAt,
    })),
    await tx.branchStatusEvent.findMany({
      select: {
        branchId: true,
        organizationId: true,
        status: true,
        effectiveAt: true,
      },
    }),
  );
  const userRows = await tx.user.findMany();
  equalRows(
    "users",
    fixture.userRows,
    userRows.map(
      ({
        credentialVersion,
        emailVerified,
        image,
        nativeRegistrationCompletedAt,
        ...user
      }) => {
        if (credentialVersion !== 1n)
          throw new Error(
            "A demo user credential version differs from the initial generation.",
          );
        // Native columns stay at their pre-cutover values until native:cutover.
        if (
          emailVerified !== DEMO_USER_NATIVE_DEFAULTS.emailVerified ||
          image !== DEMO_USER_NATIVE_DEFAULTS.image ||
          nativeRegistrationCompletedAt !==
            DEMO_USER_NATIVE_DEFAULTS.nativeRegistrationCompletedAt
        )
          throw new Error(
            "A demo user Native authentication field differs from its pre-cutover value.",
          );
        return user;
      },
    ),
  );
  for (const user of userRows) {
    if (
      !/^\$argon2id\$v=19\$m=65536,p=4,t=3\$/.test(user.passwordHash) ||
      !(await verifyPassword(user.passwordHash, password))
    ) {
      throw new Error(
        "A demo user credential differs from the supplied password.",
      );
    }
  }
  equalRows(
    "organization_memberships",
    fixture.memberships,
    await tx.organizationMembership.findMany(),
  );
  equalRows(
    "branch_assignments",
    fixture.assignments,
    await tx.branchAssignment.findMany(),
  );
  equalRows(
    "first_organization_onboardings",
    fixture.onboarding,
    await tx.firstOrganizationOnboarding.findMany(),
  );
  equalRows("categories", fixture.categories, await tx.category.findMany());
  equalRows("products", fixture.productRows, await tx.product.findMany());
  equalRows("suppliers", fixture.suppliers, await tx.supplier.findMany());
  equalRows(
    "purchase_orders",
    fixture.orders,
    await tx.purchaseOrder.findMany(),
  );
  equalRows(
    "purchase_order_items",
    fixture.orderItems,
    await tx.purchaseOrderItem.findMany(),
  );
  equalRows(
    "purchase_receipts",
    fixture.receipts,
    await tx.purchaseReceipt.findMany(),
  );
  equalRows(
    "purchase_receipt_items",
    fixture.receiptItems,
    await tx.purchaseReceiptItem.findMany(),
  );
  equalRows("sales", fixture.sales, await tx.sale.findMany());
  equalRows("sale_items", fixture.saleItems, await tx.saleItem.findMany());
  equalRows("payments", fixture.payments, await tx.payment.findMany());
  equalRows("sale_refunds", fixture.refunds, await tx.saleRefund.findMany());
  equalRows(
    "sale_refund_items",
    fixture.refundItems,
    await tx.saleRefundItem.findMany(),
  );
  equalRows(
    "refund_payments",
    fixture.refundPayments,
    await tx.refundPayment.findMany(),
  );
  equalRows(
    "inventory_balances",
    fixture.balances,
    await tx.inventoryBalance.findMany(),
  );
  equalRows(
    "inventory_cost_states",
    fixture.costs,
    await tx.inventoryCostState.findMany(),
  );
  equalRows(
    "inventory_transactions",
    fixture.movements,
    await tx.inventoryTransaction.findMany(),
  );
}

async function insert(tx: Transaction, fixture: Fixture): Promise<void> {
  await tx.organization.createMany({ data: fixture.organization });
  await tx.branch.createMany({ data: fixture.branchRows });
  await tx.user.createMany({ data: fixture.userRows });
  await tx.organizationMembership.createMany({ data: fixture.memberships });
  await tx.branchAssignment.createMany({ data: fixture.assignments });
  await tx.firstOrganizationOnboarding.createMany({ data: fixture.onboarding });
  await tx.category.createMany({ data: fixture.categories });
  await tx.product.createMany({ data: fixture.productRows });
  await tx.supplier.createMany({ data: fixture.suppliers });
  await tx.purchaseOrder.createMany({ data: fixture.orders });
  await tx.purchaseOrderItem.createMany({ data: fixture.orderItems });
  await tx.purchaseReceipt.createMany({ data: fixture.receipts });
  await tx.purchaseReceiptItem.createMany({ data: fixture.receiptItems });
  await tx.sale.createMany({ data: fixture.sales });
  await tx.saleItem.createMany({ data: fixture.saleItems });
  await tx.payment.createMany({ data: fixture.payments });
  await tx.saleRefund.createMany({ data: fixture.refunds });
  await tx.saleRefundItem.createMany({ data: fixture.refundItems });
  await tx.refundPayment.createMany({ data: fixture.refundPayments });
  await tx.inventoryBalance.createMany({ data: fixture.balances });
  await tx.inventoryCostState.createMany({ data: fixture.costs });
  for (let offset = 0; offset < fixture.movements.length; offset += 1000) {
    await tx.inventoryTransaction.createMany({
      data: fixture.movements.slice(offset, offset + 1000),
    });
  }
}

export async function runDemoFixture(
  prisma: PrismaClient,
  password: string,
): Promise<"generated" | "no-op"> {
  await verifyDemoDatabase(prisma);
  const fixture = await buildDemoFixture(password);
  if (demoLogicalFingerprint(fixture) !== frozenLogicalFingerprint) {
    throw new Error(
      "The stockwise-demo-v1 logical fingerprint differs from the accepted fixture.",
    );
  }
  return prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw(Prisma.sql`
      SELECT 1::integer FROM (SELECT pg_advisory_xact_lock(76437281065431::bigint)) AS demo_lock
    `);
      await assertDemoTargetSchema(tx);
      const counts = await tableCounts(tx);
      if ([...counts.values()].every((count) => count === 0)) {
        await insert(tx, fixture);
        await verifyManifest(tx, fixture, password);
        return "generated";
      }
      await verifyManifest(tx, fixture, password);
      return "no-op";
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 60_000,
      timeout: 60_000,
    },
  );
}
