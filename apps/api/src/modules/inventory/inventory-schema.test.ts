import { createHash } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  createTestPrismaClient,
  resetTestDatabase,
} from "../../test/database-harness.ts";
import { loadTestDatabaseEnvironment } from "../../test/database-environment.ts";

const environment = loadTestDatabaseEnvironment();
const prisma = createTestPrismaClient(environment);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function createInventoryFixture(label: string) {
  const organization = await prisma.organization.create({
    data: { name: `${label} Organization` },
  });
  const branch = await prisma.branch.create({
    data: {
      code: `${label.toUpperCase()}-BRANCH`,
      name: `${label} Branch`,
      organizationId: organization.id,
    },
  });
  const user = await prisma.user.create({
    data: {
      email: `${label.toLowerCase()}@example.com`,
    },
  });
  const membership = await prisma.organizationMembership.create({
    data: {
      organizationId: organization.id,
      role: "OWNER",
      userId: user.id,
    },
  });
  const product = await prisma.product.create({
    data: {
      basePrice: "10",
      name: `${label} Product`,
      organizationId: organization.id,
      sku: `${label.toUpperCase()}-PRODUCT`,
      unit: "KG",
    },
  });

  return { branch, membership, organization, product, user };
}

type InventoryFixture = Awaited<ReturnType<typeof createInventoryFixture>>;

interface TransactionOverrides {
  actorMembershipId?: string;
  actorUserId?: string;
  adjustmentReason?: string;
  branchId?: string;
  canonicalRequestHash?: string;
  delta?: string;
  idempotencyKeyHash?: string;
  note?: string | null;
  organizationId?: string;
  productId?: string;
  source?: string;
}

async function createInventoryTransaction(
  fixture: InventoryFixture,
  label: string,
  overrides: TransactionOverrides = {},
) {
  return prisma.inventoryTransaction.create({
    data: {
      actorMembershipId: overrides.actorMembershipId ?? fixture.membership.id,
      actorUserId: overrides.actorUserId ?? fixture.user.id,
      adjustmentReason: overrides.adjustmentReason ?? "STOCK_COUNT",
      branchId: overrides.branchId ?? fixture.branch.id,
      canonicalRequestHash:
        overrides.canonicalRequestHash ?? sha256(`${label}-request`),
      delta: overrides.delta ?? "1",
      idempotencyKeyHash:
        overrides.idempotencyKeyHash ?? sha256(`${label}-key`),
      note: overrides.note ?? null,
      organizationId: overrides.organizationId ?? fixture.organization.id,
      productId: overrides.productId ?? fixture.product.id,
      source: overrides.source ?? "MANUAL_ADJUSTMENT",
    },
  });
}

describe("inventory database schema", () => {
  beforeEach(async () => {
    await resetTestDatabase(environment);
  });

  afterAll(async () => {
    await resetTestDatabase(environment);
    await prisma.$disconnect();
  });

  it("accepts a same-tenant balance and rejects negative or duplicate balances", async () => {
    const fixture = await createInventoryFixture("balance");
    const balance = await prisma.inventoryBalance.create({
      data: {
        branchId: fixture.branch.id,
        organizationId: fixture.organization.id,
        productId: fixture.product.id,
        quantity: "12.3456",
      },
    });

    expect(balance.quantity.toFixed(4)).toBe("12.3456");
    await expect(
      prisma.inventoryBalance.create({
        data: {
          branchId: fixture.branch.id,
          organizationId: fixture.organization.id,
          productId: fixture.product.id,
          quantity: "0",
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.inventoryBalance.create({
        data: {
          branchId: fixture.branch.id,
          organizationId: fixture.organization.id,
          productId: (
            await prisma.product.create({
              data: {
                basePrice: "1",
                name: "Negative Product",
                organizationId: fixture.organization.id,
                sku: "NEGATIVE-PRODUCT",
                unit: "EA",
              },
            })
          ).id,
          quantity: "-0.0001",
        },
      }),
    ).rejects.toThrow();
  });

  it("rejects cross-organization balance branch and product relations", async () => {
    const first = await createInventoryFixture("balance-first");
    const second = await createInventoryFixture("balance-second");

    await expect(
      prisma.inventoryBalance.create({
        data: {
          branchId: second.branch.id,
          organizationId: first.organization.id,
          productId: first.product.id,
          quantity: "1",
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.inventoryBalance.create({
        data: {
          branchId: first.branch.id,
          organizationId: first.organization.id,
          productId: second.product.id,
          quantity: "1",
        },
      }),
    ).rejects.toThrow();
  });

  it("accepts positive and negative four-place deltas but rejects zero", async () => {
    const fixture = await createInventoryFixture("delta");
    const positive = await createInventoryTransaction(
      fixture,
      "positive-delta",
      { delta: "1.2345" },
    );
    const negative = await createInventoryTransaction(
      fixture,
      "negative-delta",
      { delta: "-0.0001" },
    );

    expect(positive.delta.toFixed(4)).toBe("1.2345");
    expect(negative.delta.toFixed(4)).toBe("-0.0001");
    await expect(
      createInventoryTransaction(fixture, "zero-delta", { delta: "-0" }),
    ).rejects.toThrow();
  });

  it("enforces the current movement source, adjustment reasons, notes, and hash format", async () => {
    const fixture = await createInventoryFixture("constraints");

    await expect(
      createInventoryTransaction(fixture, "invalid-source", {
        source: "PURCHASE_RECEIVE",
      }),
    ).rejects.toThrow();
    await expect(
      createInventoryTransaction(fixture, "invalid-reason", {
        adjustmentReason: "SHRINKAGE",
      }),
    ).rejects.toThrow();
    await expect(
      createInventoryTransaction(fixture, "other-without-note", {
        adjustmentReason: "OTHER",
      }),
    ).rejects.toThrow();
    await expect(
      createInventoryTransaction(fixture, "blank-note", { note: " " }),
    ).rejects.toThrow();
    await expect(
      createInventoryTransaction(fixture, "invalid-key-hash", {
        idempotencyKeyHash: "raw-idempotency-key",
      }),
    ).rejects.toThrow();
    await expect(
      createInventoryTransaction(fixture, "invalid-request-hash", {
        canonicalRequestHash: "A".repeat(64),
      }),
    ).rejects.toThrow();
    await expect(
      createInventoryTransaction(fixture, "valid-other", {
        adjustmentReason: "OTHER",
        note: "Verified shelf discrepancy",
      }),
    ).resolves.toMatchObject({ note: "Verified shelf discrepancy" });
  });

  it("rejects cross-organization transaction branch and product relations", async () => {
    const first = await createInventoryFixture("transaction-first");
    const second = await createInventoryFixture("transaction-second");

    await expect(
      createInventoryTransaction(first, "cross-branch", {
        branchId: second.branch.id,
      }),
    ).rejects.toThrow();
    await expect(
      createInventoryTransaction(first, "cross-product", {
        productId: second.product.id,
      }),
    ).rejects.toThrow();
  });

  it("binds actor membership to both the transaction organization and actor user", async () => {
    const first = await createInventoryFixture("actor-first");
    const second = await createInventoryFixture("actor-second");
    const otherUser = await prisma.user.create({
      data: {
        email: "actor-mismatch@example.com",
      },
    });

    await expect(
      createInventoryTransaction(first, "cross-actor-membership", {
        actorMembershipId: second.membership.id,
      }),
    ).rejects.toThrow();
    await expect(
      createInventoryTransaction(first, "actor-user-mismatch", {
        actorUserId: otherUser.id,
      }),
    ).rejects.toThrow();
  });

  it("enforces idempotency-key uniqueness within but not across organizations", async () => {
    const first = await createInventoryFixture("idempotency-first");
    const second = await createInventoryFixture("idempotency-second");
    const sharedKeyHash = sha256("shared-idempotency-key");

    await createInventoryTransaction(first, "first-idempotency", {
      idempotencyKeyHash: sharedKeyHash,
    });
    await expect(
      createInventoryTransaction(first, "duplicate-idempotency", {
        idempotencyKeyHash: sharedKeyHash,
      }),
    ).rejects.toThrow();
    await expect(
      createInventoryTransaction(second, "other-tenant-idempotency", {
        idempotencyKeyHash: sharedKeyHash,
      }),
    ).resolves.toBeDefined();
  });

  it("preserves inventory history through branch and product deactivation and restricts deletion", async () => {
    const fixture = await createInventoryFixture("history");
    await prisma.inventoryBalance.create({
      data: {
        branchId: fixture.branch.id,
        organizationId: fixture.organization.id,
        productId: fixture.product.id,
        quantity: "2",
      },
    });
    await createInventoryTransaction(fixture, "history-movement", {
      delta: "2",
    });

    await prisma.branch.update({
      data: { deactivatedAt: new Date(), status: "INACTIVE" },
      where: { id: fixture.branch.id },
    });
    await prisma.product.update({
      data: { status: "INACTIVE" },
      where: { id: fixture.product.id },
    });

    expect(await prisma.inventoryBalance.count()).toBe(1);
    expect(await prisma.inventoryTransaction.count()).toBe(1);
    await expect(
      prisma.branch.delete({ where: { id: fixture.branch.id } }),
    ).rejects.toThrow();
    await expect(
      prisma.product.delete({ where: { id: fixture.product.id } }),
    ).rejects.toThrow();
    await expect(
      prisma.organizationMembership.delete({
        where: {
          organizationId_userId: {
            organizationId: fixture.organization.id,
            userId: fixture.user.id,
          },
        },
      }),
    ).rejects.toThrow();
  });

  it("supports exact database reconciliation between ledger deltas and balance", async () => {
    const fixture = await createInventoryFixture("reconciliation");

    await createInventoryTransaction(fixture, "reconcile-add", { delta: "10" });
    await createInventoryTransaction(fixture, "reconcile-remove", {
      delta: "-3",
    });
    await createInventoryTransaction(fixture, "reconcile-fraction", {
      delta: "1.5000",
    });
    const balance = await prisma.inventoryBalance.create({
      data: {
        branchId: fixture.branch.id,
        organizationId: fixture.organization.id,
        productId: fixture.product.id,
        quantity: "8.5000",
      },
    });
    const [ledger] = await prisma.$queryRaw<{ total: string }[]>`
      SELECT SUM("delta")::text AS "total"
      FROM "inventory_transactions"
      WHERE "branch_id" = ${fixture.branch.id}::uuid
        AND "product_id" = ${fixture.product.id}::uuid
    `;

    expect(ledger?.total).toBe("8.5000");
    expect(balance.quantity.toFixed(4)).toBe(ledger?.total);
  });

  it("shows PostgreSQL scale coercion remains a future service-validation boundary", async () => {
    const fixture = await createInventoryFixture("scale-coercion");
    const balance = await prisma.inventoryBalance.create({
      data: {
        branchId: fixture.branch.id,
        organizationId: fixture.organization.id,
        productId: fixture.product.id,
        quantity: "1.23456",
      },
    });

    expect(balance.quantity.toFixed(4)).toBe("1.2346");
  });
});
