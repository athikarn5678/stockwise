import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { loadTestDatabaseEnvironment } from "../../test/database-environment.ts";
import {
  createTestPrismaClient,
  resetTestDatabase,
} from "../../test/database-harness.ts";
import { createPrismaInventoryRepository } from "./inventory-repository.ts";
import {
  inventoryHistoryQuerySchema,
  inventoryListQuerySchema,
} from "./inventory-schemas.ts";

const environment = loadTestDatabaseEnvironment();
const prisma = createTestPrismaClient(environment);
const repository = createPrismaInventoryRepository(prisma);
const NOW = new Date("2026-08-30T12:00:00.000Z");
async function actor(
  organizationId: string,
  email: string,
  role: "OWNER" | "BRANCH_MANAGER",
) {
  const user = await prisma.user.create({
    data: { email, emailVerifiedAt: NOW },
  });
  const membership = await prisma.organizationMembership.create({
    data: { organizationId, role, userId: user.id },
  });
  return { membership, user };
}

async function product(input: {
  categoryId?: string;
  organizationId: string;
  sku: string;
  status?: "ACTIVE" | "INACTIVE";
}) {
  return prisma.product.create({
    data: {
      basePrice: "1",
      ...(input.categoryId === undefined
        ? {}
        : { categoryId: input.categoryId }),
      name: input.sku,
      organizationId: input.organizationId,
      sku: input.sku,
      ...(input.status === undefined ? {} : { status: input.status }),
      unit: "KG",
    },
  });
}

describe("inventory query repository with PostgreSQL", () => {
  beforeEach(async () => resetTestDatabase(environment));
  afterAll(async () => {
    await resetTestDatabase(environment);
    await prisma.$disconnect();
  });

  it("returns lazy-zero balances without writes and enforces branch/tenant scope", async () => {
    const organization = await prisma.organization.create({
      data: { name: "Store" },
    });
    const otherOrganization = await prisma.organization.create({
      data: { name: "Other" },
    });
    const branch = await prisma.branch.create({
      data: { code: "MAIN", name: "Main", organizationId: organization.id },
    });
    const otherBranch = await prisma.branch.create({
      data: {
        code: "OTHER",
        name: "Other",
        organizationId: otherOrganization.id,
      },
    });
    const owner = await actor(
      organization.id,
      "owner-inventory@example.com",
      "OWNER",
    );
    const manager = await actor(
      organization.id,
      "manager-inventory@example.com",
      "BRANCH_MANAGER",
    );
    await prisma.branchAssignment.create({
      data: {
        branchId: branch.id,
        organizationId: organization.id,
        userId: manager.user.id,
      },
    });
    const category = await prisma.category.create({
      data: {
        name: "Food",
        normalizedName: "food",
        organizationId: organization.id,
      },
    });
    const balanced = await product({
      categoryId: category.id,
      organizationId: organization.id,
      sku: "BALANCED",
    });
    const missing = await product({
      organizationId: organization.id,
      sku: "MISSING",
    });
    const inactive = await product({
      organizationId: organization.id,
      sku: "INACTIVE",
      status: "INACTIVE",
    });
    const crossTenant = await product({
      organizationId: otherOrganization.id,
      sku: "OTHER",
    });
    await prisma.inventoryBalance.create({
      data: {
        branchId: branch.id,
        organizationId: organization.id,
        productId: balanced.id,
        quantity: "8.5000",
      },
    });
    await prisma.inventoryBalance.create({
      data: {
        branchId: branch.id,
        organizationId: organization.id,
        productId: inactive.id,
        quantity: "0",
      },
    });
    const inactiveHistory = await prisma.inventoryTransaction.create({
      data: {
        actorMembershipId: owner.membership.id,
        actorUserId: owner.user.id,
        adjustmentReason: "FOUND",
        branchId: branch.id,
        canonicalRequestHash: "a".repeat(64),
        delta: "1",
        idempotencyKeyHash: "b".repeat(64),
        organizationId: organization.id,
        productId: inactive.id,
        source: "MANUAL_ADJUSTMENT",
      },
    });
    const countsBefore = await Promise.all([
      prisma.inventoryBalance.count(),
      prisma.inventoryTransaction.count(),
    ]);

    const list = await repository.listBalances({
      actorUserId: owner.user.id,
      branchId: branch.id,
      organizationId: organization.id,
      query: inventoryListQuerySchema.parse({
        categoryId: category.id,
        limit: "1",
      }),
    });
    expect(list).toMatchObject({
      inventory: [
        {
          balance: { exists: true, quantity: "8.5" },
          product: { id: balanced.id },
        },
      ],
      kind: "success",
      nextCursor: null,
    });
    const lazyZero = await repository.getBalance({
      actorUserId: manager.user.id,
      branchId: branch.id,
      organizationId: organization.id,
      productId: missing.id,
    });
    expect(lazyZero).toMatchObject({
      inventory: {
        balance: { exists: false, quantity: "0", updatedAt: null },
        product: { id: missing.id },
      },
      kind: "success",
    });
    const allStatuses = await repository.listBalances({
      actorUserId: owner.user.id,
      branchId: branch.id,
      organizationId: organization.id,
      query: inventoryListQuerySchema.parse({ status: "ALL" }),
    });
    expect(allStatuses).toMatchObject({ kind: "success" });
    if (allStatuses.kind !== "success")
      throw new Error("Expected inventory page.");
    expect(allStatuses.inventory.map(({ product }) => product.id)).toEqual(
      expect.arrayContaining([balanced.id, missing.id, inactive.id]),
    );
    await prisma.branch.update({
      data: { deactivatedAt: NOW, status: "INACTIVE" },
      where: { id: branch.id },
    });
    await expect(
      repository.getBalance({
        actorUserId: manager.user.id,
        branchId: branch.id,
        organizationId: organization.id,
        productId: balanced.id,
      }),
    ).resolves.toMatchObject({
      inventory: { product: { id: balanced.id } },
      kind: "success",
    });
    await expect(
      repository.listHistory({
        actorUserId: manager.user.id,
        branchId: branch.id,
        organizationId: organization.id,
        productId: inactive.id,
        query: inventoryHistoryQuerySchema.parse({}),
      }),
    ).resolves.toMatchObject({
      kind: "success",
      transactions: [{ id: inactiveHistory.id }],
    });
    await expect(
      repository.getBalance({
        actorUserId: manager.user.id,
        branchId: otherBranch.id,
        organizationId: organization.id,
        productId: balanced.id,
      }),
    ).resolves.toEqual({ kind: "forbidden" });
    await expect(
      repository.getBalance({
        actorUserId: owner.user.id,
        branchId: branch.id,
        organizationId: organization.id,
        productId: crossTenant.id,
      }),
    ).resolves.toEqual({ kind: "not_found" });
    expect(
      await Promise.all([
        prisma.inventoryBalance.count(),
        prisma.inventoryTransaction.count(),
      ]),
    ).toEqual(countsBefore);
  });

  it("paginates immutable history by occurredAt/id without exposing idempotency hashes", async () => {
    const organization = await prisma.organization.create({
      data: { name: "Store" },
    });
    const branch = await prisma.branch.create({
      data: { code: "MAIN", name: "Main", organizationId: organization.id },
    });
    const owner = await actor(
      organization.id,
      "owner-history@example.com",
      "OWNER",
    );
    const item = await product({
      organizationId: organization.id,
      sku: "HISTORY",
    });
    const occurredAt = new Date("2026-08-30T09:00:00.000Z");
    const transactionIds = [
      "10000000-0000-4000-8000-000000000001",
      "10000000-0000-4000-8000-000000000002",
      "10000000-0000-4000-8000-000000000003",
    ];
    for (const [index, id] of transactionIds.entries()) {
      await prisma.inventoryTransaction.create({
        data: {
          actorMembershipId: owner.membership.id,
          actorUserId: owner.user.id,
          adjustmentReason: index === 2 ? "OTHER" : "FOUND",
          branchId: branch.id,
          canonicalRequestHash: `${index + 1}`.repeat(64),
          delta: index === 1 ? "-2.2500" : "0.1250",
          id,
          idempotencyKeyHash: `${index + 4}`.repeat(64),
          note: index === 2 ? "Counted later" : null,
          occurredAt,
          organizationId: organization.id,
          productId: item.id,
          source: "MANUAL_ADJUSTMENT",
        },
      });
    }
    const first = await repository.listHistory({
      actorUserId: owner.user.id,
      branchId: branch.id,
      organizationId: organization.id,
      productId: item.id,
      query: inventoryHistoryQuerySchema.parse({ limit: "1" }),
    });
    expect(first).toMatchObject({
      kind: "success",
      transactions: [{ delta: "0.125", id: transactionIds[0] }],
    });
    if (first.kind !== "success" || first.nextCursor === null)
      throw new Error("Expected cursor.");
    const second = await repository.listHistory({
      actorUserId: owner.user.id,
      branchId: branch.id,
      organizationId: organization.id,
      productId: item.id,
      query: inventoryHistoryQuerySchema.parse({
        cursor: first.nextCursor,
        limit: "2",
      }),
    });
    expect(second).toMatchObject({
      kind: "success",
      transactions: [
        { delta: "-2.25", id: transactionIds[1] },
        { id: transactionIds[2], note: "Counted later" },
      ],
    });
    expect(JSON.stringify(second)).not.toMatch(
      /idempotency|canonicalRequestHash/i,
    );
    await expect(
      repository.listHistory({
        actorUserId: owner.user.id,
        branchId: branch.id,
        organizationId: organization.id,
        productId: item.id,
        query: inventoryHistoryQuerySchema.parse({
          cursor: first.nextCursor,
          source: "MANUAL_ADJUSTMENT",
        }),
      }),
    ).resolves.toEqual({ kind: "invalid_cursor" });
    await expect(
      repository.listHistory({
        actorUserId: owner.user.id,
        branchId: branch.id,
        organizationId: organization.id,
        productId: item.id,
        query: inventoryHistoryQuerySchema.parse({
          occurredAfter: "2026-08-30T09:00:00.001Z",
        }),
      }),
    ).resolves.toEqual({ kind: "success", nextCursor: null, transactions: [] });
  });
});
