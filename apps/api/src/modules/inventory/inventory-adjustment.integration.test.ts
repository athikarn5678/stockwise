import { createHash } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { OrganizationRole } from "../../generated/prisma/enums.ts";
import { loadTestDatabaseEnvironment } from "../../test/database-environment.ts";
import {
  createTestPrismaClient,
  resetTestDatabase,
} from "../../test/database-harness.ts";
import {
  createPrismaInventoryRepository,
  inventoryBalanceAdvisoryLockKey,
  inventoryIdempotencyAdvisoryLockKey,
} from "./inventory-repository.ts";
import {
  inventoryAdjustmentBodySchema,
  type InventoryAdjustmentInput,
} from "./inventory-schemas.ts";

const environment = loadTestDatabaseEnvironment();
const prisma = createTestPrismaClient(environment);
const NOW = new Date("2026-08-30T12:00:00.000Z");
const repository = createPrismaInventoryRepository(prisma, () => NOW);
async function organization(name: string) {
  const organization = await prisma.organization.create({ data: { name } });
  const branch = await prisma.branch.create({
    data: { code: "MAIN", name: "Main", organizationId: organization.id },
  });
  return { branch, organization };
}

async function actor(input: {
  branchId?: string;
  email: string;
  organizationId: string;
  role: OrganizationRole;
}) {
  const user = await prisma.user.create({
    data: {
      email: input.email,
      emailVerifiedAt: NOW,
    },
  });
  const membership = await prisma.organizationMembership.create({
    data: {
      organizationId: input.organizationId,
      role: input.role,
      userId: user.id,
    },
  });
  if (input.branchId !== undefined) {
    await prisma.branchAssignment.create({
      data: {
        branchId: input.branchId,
        organizationId: input.organizationId,
        userId: user.id,
      },
    });
  }
  return { membership, user };
}

async function product(input: {
  organizationId: string;
  sku: string;
  status?: "ACTIVE" | "INACTIVE";
  unit?: "EA" | "PACK" | "BOX" | "KG" | "G" | "L" | "ML" | "M" | "CM";
}) {
  return prisma.product.create({
    data: {
      basePrice: "1",
      name: input.sku,
      organizationId: input.organizationId,
      sku: input.sku,
      ...(input.status === undefined ? {} : { status: input.status }),
      unit: input.unit ?? "KG",
    },
  });
}

function adjustment(input: {
  delta: string;
  note?: string | null;
  productId: string;
  reason?: "STOCK_COUNT" | "DAMAGE" | "LOSS" | "FOUND" | "CORRECTION" | "OTHER";
}): InventoryAdjustmentInput {
  return inventoryAdjustmentBodySchema.parse({
    delta: input.delta,
    note: input.note,
    productId: input.productId,
    reason: input.reason ?? "FOUND",
  });
}

async function adjust(input: {
  actorUserId: string;
  branchId: string;
  delta: string;
  idempotencyKey: string;
  note?: string | null;
  organizationId: string;
  productId: string;
  reason?: "STOCK_COUNT" | "DAMAGE" | "LOSS" | "FOUND" | "CORRECTION" | "OTHER";
}) {
  return repository.adjust({
    actorUserId: input.actorUserId,
    adjustment: adjustment(input),
    branchId: input.branchId,
    idempotencyKey: input.idempotencyKey,
    organizationId: input.organizationId,
  });
}

async function inventoryState(branchId: string, productId: string) {
  const [balance, transactions, aggregate] = await Promise.all([
    prisma.inventoryBalance.findUnique({
      where: { branchId_productId: { branchId, productId } },
    }),
    prisma.inventoryTransaction.findMany({
      orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
      where: { branchId, productId },
    }),
    prisma.inventoryTransaction.aggregate({
      _sum: { delta: true },
      where: { branchId, productId },
    }),
  ]);
  return { aggregate: aggregate._sum.delta, balance, transactions };
}

describe("atomic inventory adjustment repository with PostgreSQL", () => {
  beforeEach(async () => resetTestDatabase(environment));
  afterAll(async () => {
    await resetTestDatabase(environment);
    await prisma.$disconnect();
  });

  it("derives deterministic disjoint advisory lock namespaces", () => {
    const balanceKey = inventoryBalanceAdvisoryLockKey("branch", "product");
    const idempotencyKey = inventoryIdempotencyAdvisoryLockKey(
      "organization",
      "a".repeat(64),
    );
    expect(inventoryBalanceAdvisoryLockKey("branch", "product")).toBe(
      balanceKey,
    );
    expect(
      inventoryIdempotencyAdvisoryLockKey("organization", "a".repeat(64)),
    ).toBe(idempotencyKey);
    expect(balanceKey).toBeLessThan(0n);
    expect(idempotencyKey).toBeGreaterThanOrEqual(0n);
  });

  it("atomically creates and updates a balance with exact ledger provenance and rollback", async () => {
    const scope = await organization("Atomic Store");
    const owner = await actor({
      email: "atomic-owner@example.com",
      organizationId: scope.organization.id,
      role: "OWNER",
    });
    const item = await product({
      organizationId: scope.organization.id,
      sku: "ATOMIC-KG",
    });

    await expect(
      adjust({
        actorUserId: owner.user.id,
        branchId: scope.branch.id,
        delta: "+1.2500",
        idempotencyKey: "atomic-create",
        note: "  Found during count  ",
        organizationId: scope.organization.id,
        productId: item.id,
      }),
    ).resolves.toMatchObject({
      adjustment: {
        balance: { quantity: "1.25" },
        transaction: { delta: "1.25", note: "Found during count" },
      },
      kind: "success",
    });
    await expect(
      adjust({
        actorUserId: owner.user.id,
        branchId: scope.branch.id,
        delta: "0.7500",
        idempotencyKey: "atomic-increment",
        organizationId: scope.organization.id,
        productId: item.id,
      }),
    ).resolves.toMatchObject({
      adjustment: { balance: { quantity: "2" } },
      kind: "success",
    });
    await expect(
      adjust({
        actorUserId: owner.user.id,
        branchId: scope.branch.id,
        delta: "-0.5000",
        idempotencyKey: "atomic-decrement",
        organizationId: scope.organization.id,
        productId: item.id,
        reason: "CORRECTION",
      }),
    ).resolves.toMatchObject({
      adjustment: { balance: { quantity: "1.5" } },
      kind: "success",
    });

    let state = await inventoryState(scope.branch.id, item.id);
    expect(state.balance?.quantity.toString()).toBe("1.5");
    expect(state.aggregate?.toString()).toBe("1.5");
    expect(state.transactions).toHaveLength(3);
    expect(
      state.transactions.every(
        (row) =>
          row.actorUserId === owner.user.id &&
          row.actorMembershipId === owner.membership.id,
      ),
    ).toBe(true);
    expect(state.transactions[0]?.idempotencyKeyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(state.transactions[0]?.canonicalRequestHash).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(state.transactions[0]?.idempotencyKeyHash).not.toBe("atomic-create");

    await expect(
      repository.adjust({
        actorUserId: owner.user.id,
        adjustment: {
          delta: "1",
          note: " untrimmed internal note ",
          productId: item.id,
          reason: "FOUND",
        },
        branchId: scope.branch.id,
        idempotencyKey: "forced-ledger-failure",
        organizationId: scope.organization.id,
      }),
    ).rejects.toThrow();
    state = await inventoryState(scope.branch.id, item.id);
    expect(state.balance?.quantity.toString()).toBe("1.5");
    expect(state.transactions).toHaveLength(3);
    expect(state.aggregate?.toString()).toBe("1.5");

    await expect(
      adjust({
        actorUserId: owner.user.id,
        branchId: scope.branch.id,
        delta: "-2",
        idempotencyKey: "insufficient",
        organizationId: scope.organization.id,
        productId: item.id,
        reason: "LOSS",
      }),
    ).resolves.toEqual({ kind: "insufficient_stock" });
    state = await inventoryState(scope.branch.id, item.id);
    expect(state.balance?.quantity.toString()).toBe("1.5");
    expect(state.transactions).toHaveLength(3);

    const emptyItem = await product({
      organizationId: scope.organization.id,
      sku: "EMPTY-KG",
    });
    await expect(
      adjust({
        actorUserId: owner.user.id,
        branchId: scope.branch.id,
        delta: "-1",
        idempotencyKey: "empty-negative",
        organizationId: scope.organization.id,
        productId: emptyItem.id,
      }),
    ).resolves.toEqual({ kind: "insufficient_stock" });
    expect(await inventoryState(scope.branch.id, emptyItem.id)).toMatchObject({
      balance: null,
      transactions: [],
    });
  });

  it("enforces roles, branch assignment, tenant scope, and active resource lifecycle", async () => {
    const scope = await organization("Authorization Store");
    const other = await organization("Other Store");
    const roles = [
      ["OWNER", false],
      ["ADMIN", false],
      ["BRANCH_MANAGER", true],
      ["INVENTORY_STAFF", true],
    ] as const;
    const actors: Awaited<ReturnType<typeof actor>>[] = [];
    for (const [role, assigned] of roles) {
      actors.push(
        await actor({
          ...(assigned ? { branchId: scope.branch.id } : {}),
          email: `${role.toLowerCase()}@example.com`,
          organizationId: scope.organization.id,
          role,
        }),
      );
    }
    const cashier = await actor({
      branchId: scope.branch.id,
      email: "cashier-adjust@example.com",
      organizationId: scope.organization.id,
      role: "CASHIER",
    });
    const unassigned = await actor({
      email: "unassigned-manager@example.com",
      organizationId: scope.organization.id,
      role: "BRANCH_MANAGER",
    });
    const item = await product({
      organizationId: scope.organization.id,
      sku: "AUTHORIZED",
    });
    const otherItem = await product({
      organizationId: other.organization.id,
      sku: "OTHER-PRODUCT",
    });

    for (const [index, authorizedActor] of actors.entries()) {
      await expect(
        adjust({
          actorUserId: authorizedActor.user.id,
          branchId: scope.branch.id,
          delta: "1",
          idempotencyKey: `role-${index}`,
          organizationId: scope.organization.id,
          productId: item.id,
        }),
      ).resolves.toMatchObject({ kind: "success" });
    }
    await expect(
      adjust({
        actorUserId: cashier.user.id,
        branchId: scope.branch.id,
        delta: "1",
        idempotencyKey: "cashier-denied",
        organizationId: scope.organization.id,
        productId: item.id,
      }),
    ).resolves.toEqual({ kind: "forbidden" });
    await expect(
      adjust({
        actorUserId: unassigned.user.id,
        branchId: scope.branch.id,
        delta: "1",
        idempotencyKey: "unassigned-denied",
        organizationId: scope.organization.id,
        productId: item.id,
      }),
    ).resolves.toEqual({ kind: "forbidden" });
    await expect(
      adjust({
        actorUserId: actors[0]!.user.id,
        branchId: other.branch.id,
        delta: "1",
        idempotencyKey: "cross-branch",
        organizationId: scope.organization.id,
        productId: item.id,
      }),
    ).resolves.toEqual({ kind: "forbidden" });
    await expect(
      adjust({
        actorUserId: actors[0]!.user.id,
        branchId: scope.branch.id,
        delta: "1",
        idempotencyKey: "cross-product",
        organizationId: scope.organization.id,
        productId: otherItem.id,
      }),
    ).resolves.toEqual({ kind: "not_found" });

    const inactiveItem = await product({
      organizationId: scope.organization.id,
      sku: "INACTIVE-PRODUCT",
      status: "INACTIVE",
    });
    await expect(
      adjust({
        actorUserId: actors[0]!.user.id,
        branchId: scope.branch.id,
        delta: "1",
        idempotencyKey: "inactive-product",
        organizationId: scope.organization.id,
        productId: inactiveItem.id,
      }),
    ).resolves.toEqual({ kind: "product_inactive" });
    await prisma.branch.update({
      data: { deactivatedAt: NOW, status: "INACTIVE" },
      where: { id: scope.branch.id },
    });
    await expect(
      adjust({
        actorUserId: actors[0]!.user.id,
        branchId: scope.branch.id,
        delta: "1",
        idempotencyKey: "inactive-branch",
        organizationId: scope.organization.id,
        productId: item.id,
      }),
    ).resolves.toEqual({ kind: "branch_inactive" });

    const state = await inventoryState(scope.branch.id, item.id);
    expect(state.balance?.quantity.toString()).toBe("4");
    expect(state.transactions).toHaveLength(4);
    expect(state.aggregate?.toString()).toBe("4");
  });

  it("enforces exact decimal and unit-specific quantity rules without rounding", async () => {
    const scope = await organization("Quantity Store");
    const owner = await actor({
      email: "quantity-owner@example.com",
      organizationId: scope.organization.id,
      role: "OWNER",
    });

    for (const unit of ["EA", "PACK", "BOX"] as const) {
      const item = await product({
        organizationId: scope.organization.id,
        sku: `INTEGER-${unit}`,
        unit,
      });
      await expect(
        repository.adjust({
          actorUserId: owner.user.id,
          adjustment: {
            delta: "1.5",
            note: null,
            productId: item.id,
            reason: "FOUND",
          },
          branchId: scope.branch.id,
          idempotencyKey: `fractional-${unit}`,
          organizationId: scope.organization.id,
        }),
      ).resolves.toEqual({ kind: "invalid_quantity" });
      await expect(
        adjust({
          actorUserId: owner.user.id,
          branchId: scope.branch.id,
          delta: "+2.0000",
          idempotencyKey: `integer-${unit}`,
          organizationId: scope.organization.id,
          productId: item.id,
        }),
      ).resolves.toMatchObject({
        adjustment: { balance: { quantity: "2" } },
        kind: "success",
      });
    }

    for (const unit of ["KG", "G", "L", "ML", "M", "CM"] as const) {
      const item = await product({
        organizationId: scope.organization.id,
        sku: `FRACTIONAL-${unit}`,
        unit,
      });
      await expect(
        adjust({
          actorUserId: owner.user.id,
          branchId: scope.branch.id,
          delta: "0.1234",
          idempotencyKey: `exact-${unit}`,
          organizationId: scope.organization.id,
          productId: item.id,
        }),
      ).resolves.toMatchObject({
        adjustment: {
          balance: { quantity: "0.1234" },
          transaction: { delta: "0.1234" },
        },
        kind: "success",
      });
    }

    const exactItem = await product({
      organizationId: scope.organization.id,
      sku: "NO-ROUNDING",
    });
    for (const [index, delta] of ["0", "-0.0000", "0.12345", "1e2"].entries()) {
      await expect(
        repository.adjust({
          actorUserId: owner.user.id,
          adjustment: {
            delta,
            note: null,
            productId: exactItem.id,
            reason: "FOUND",
          },
          branchId: scope.branch.id,
          idempotencyKey: `invalid-exact-${index}`,
          organizationId: scope.organization.id,
        }),
      ).resolves.toEqual({ kind: "invalid_quantity" });
    }
    expect(await inventoryState(scope.branch.id, exactItem.id)).toMatchObject({
      balance: null,
      transactions: [],
    });

    const capacityItem = await product({
      organizationId: scope.organization.id,
      sku: "CAPACITY",
    });
    await adjust({
      actorUserId: owner.user.id,
      branchId: scope.branch.id,
      delta: "99999999999999.9999",
      idempotencyKey: "capacity-seed",
      organizationId: scope.organization.id,
      productId: capacityItem.id,
    });
    await expect(
      adjust({
        actorUserId: owner.user.id,
        branchId: scope.branch.id,
        delta: "0.0001",
        idempotencyKey: "capacity-overflow",
        organizationId: scope.organization.id,
        productId: capacityItem.id,
      }),
    ).resolves.toEqual({ kind: "invalid_quantity" });
    const capacityState = await inventoryState(
      scope.branch.id,
      capacityItem.id,
    );
    expect(capacityState.balance?.quantity.toString()).toBe(
      "99999999999999.9999",
    );
    expect(capacityState.transactions).toHaveLength(1);
    expect(capacityState.aggregate?.toString()).toBe("99999999999999.9999");
  });

  it("replays the original logical result, rejects conflicting reuse, and scopes keys by organization", async () => {
    const firstScope = await organization("First Idempotency Store");
    const secondScope = await organization("Second Idempotency Store");
    const firstOwner = await actor({
      email: "first-idempotency-owner@example.com",
      organizationId: firstScope.organization.id,
      role: "OWNER",
    });
    const secondOwner = await actor({
      email: "second-idempotency-owner@example.com",
      organizationId: secondScope.organization.id,
      role: "OWNER",
    });
    const firstItem = await product({
      organizationId: firstScope.organization.id,
      sku: "FIRST-IDEMPOTENT",
    });
    const secondItem = await product({
      organizationId: secondScope.organization.id,
      sku: "SECOND-IDEMPOTENT",
    });
    const rawKey = "shared-organization-scoped-key";

    const original = await adjust({
      actorUserId: firstOwner.user.id,
      branchId: firstScope.branch.id,
      delta: "2",
      idempotencyKey: rawKey,
      organizationId: firstScope.organization.id,
      productId: firstItem.id,
    });
    await adjust({
      actorUserId: firstOwner.user.id,
      branchId: firstScope.branch.id,
      delta: "3",
      idempotencyKey: "later-movement",
      organizationId: firstScope.organization.id,
      productId: firstItem.id,
    });
    const replay = await adjust({
      actorUserId: firstOwner.user.id,
      branchId: firstScope.branch.id,
      delta: "2.0000",
      idempotencyKey: rawKey,
      organizationId: firstScope.organization.id,
      productId: firstItem.id,
    });
    expect(original).toMatchObject({
      adjustment: { balance: { quantity: "2" } },
      kind: "success",
    });
    expect(replay).toMatchObject({
      adjustment: { balance: { quantity: "2" } },
      kind: "replay",
    });
    if (original.kind !== "success" || replay.kind !== "replay") {
      throw new Error("Expected success and replay outcomes.");
    }
    expect(replay.adjustment.transaction).toEqual(
      original.adjustment.transaction,
    );
    await expect(
      adjust({
        actorUserId: firstOwner.user.id,
        branchId: firstScope.branch.id,
        delta: "4",
        idempotencyKey: rawKey,
        organizationId: firstScope.organization.id,
        productId: firstItem.id,
      }),
    ).resolves.toEqual({ kind: "idempotency_conflict" });
    await expect(
      adjust({
        actorUserId: secondOwner.user.id,
        branchId: secondScope.branch.id,
        delta: "2",
        idempotencyKey: rawKey,
        organizationId: secondScope.organization.id,
        productId: secondItem.id,
      }),
    ).resolves.toMatchObject({ kind: "success" });

    const firstState = await inventoryState(firstScope.branch.id, firstItem.id);
    const secondState = await inventoryState(
      secondScope.branch.id,
      secondItem.id,
    );
    expect(firstState.balance?.quantity.toString()).toBe("5");
    expect(firstState.transactions).toHaveLength(2);
    expect(firstState.aggregate?.toString()).toBe("5");
    expect(secondState.balance?.quantity.toString()).toBe("2");
    expect(secondState.transactions).toHaveLength(1);
    expect(firstState.transactions[0]?.idempotencyKeyHash).toBe(
      secondState.transactions[0]?.idempotencyKeyHash,
    );
    expect(firstState.transactions[0]?.idempotencyKeyHash).toBe(
      createHash("sha256").update(rawKey).digest("hex"),
    );
    expect(JSON.stringify(original)).not.toContain(rawKey);
  });

  it("serializes concurrent first and existing-balance increments without lost updates", async () => {
    const scope = await organization("Concurrent Increment Store");
    const owner = await actor({
      email: "concurrent-increment-owner@example.com",
      organizationId: scope.organization.id,
      role: "OWNER",
    });
    const firstItem = await product({
      organizationId: scope.organization.id,
      sku: "CONCURRENT-FIRST",
    });
    const existingItem = await product({
      organizationId: scope.organization.id,
      sku: "CONCURRENT-EXISTING",
    });

    const firstResults = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        adjust({
          actorUserId: owner.user.id,
          branchId: scope.branch.id,
          delta: "1",
          idempotencyKey: `first-${index}`,
          organizationId: scope.organization.id,
          productId: firstItem.id,
        }),
      ),
    );
    expect(firstResults.every(({ kind }) => kind === "success")).toBe(true);
    let state = await inventoryState(scope.branch.id, firstItem.id);
    expect(state.balance?.quantity.toString()).toBe("8");
    expect(state.transactions).toHaveLength(8);
    expect(state.aggregate?.toString()).toBe("8");
    expect(
      await prisma.inventoryBalance.count({
        where: { productId: firstItem.id },
      }),
    ).toBe(1);

    await adjust({
      actorUserId: owner.user.id,
      branchId: scope.branch.id,
      delta: "2",
      idempotencyKey: "existing-seed",
      organizationId: scope.organization.id,
      productId: existingItem.id,
    });
    const existingResults = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        adjust({
          actorUserId: owner.user.id,
          branchId: scope.branch.id,
          delta: "0.5",
          idempotencyKey: `existing-${index}`,
          organizationId: scope.organization.id,
          productId: existingItem.id,
        }),
      ),
    );
    expect(existingResults.every(({ kind }) => kind === "success")).toBe(true);
    state = await inventoryState(scope.branch.id, existingItem.id);
    expect(state.balance?.quantity.toString()).toBe("6");
    expect(state.transactions).toHaveLength(9);
    expect(state.aggregate?.toString()).toBe("6");
  }, 20_000);

  it("serializes decrement, mixed-direction, and identical-idempotency races safely", async () => {
    const scope = await organization("Concurrent Race Store");
    const owner = await actor({
      email: "concurrent-race-owner@example.com",
      organizationId: scope.organization.id,
      role: "OWNER",
    });
    const decrementItem = await product({
      organizationId: scope.organization.id,
      sku: "DECREMENT-RACE",
    });
    await adjust({
      actorUserId: owner.user.id,
      branchId: scope.branch.id,
      delta: "5",
      idempotencyKey: "decrement-seed",
      organizationId: scope.organization.id,
      productId: decrementItem.id,
    });
    const decrementResults = await Promise.all([
      adjust({
        actorUserId: owner.user.id,
        branchId: scope.branch.id,
        delta: "-4",
        idempotencyKey: "decrement-a",
        organizationId: scope.organization.id,
        productId: decrementItem.id,
      }),
      adjust({
        actorUserId: owner.user.id,
        branchId: scope.branch.id,
        delta: "-4",
        idempotencyKey: "decrement-b",
        organizationId: scope.organization.id,
        productId: decrementItem.id,
      }),
    ]);
    expect(decrementResults.map(({ kind }) => kind).sort()).toEqual([
      "insufficient_stock",
      "success",
    ]);
    let state = await inventoryState(scope.branch.id, decrementItem.id);
    expect(state.balance?.quantity.toString()).toBe("1");
    expect(state.transactions).toHaveLength(2);
    expect(state.aggregate?.toString()).toBe("1");

    const mixedItem = await product({
      organizationId: scope.organization.id,
      sku: "MIXED-RACE",
    });
    await adjust({
      actorUserId: owner.user.id,
      branchId: scope.branch.id,
      delta: "1",
      idempotencyKey: "mixed-seed",
      organizationId: scope.organization.id,
      productId: mixedItem.id,
    });
    const mixedResults = await Promise.all([
      adjust({
        actorUserId: owner.user.id,
        branchId: scope.branch.id,
        delta: "+2",
        idempotencyKey: "mixed-increment",
        organizationId: scope.organization.id,
        productId: mixedItem.id,
      }),
      adjust({
        actorUserId: owner.user.id,
        branchId: scope.branch.id,
        delta: "-1",
        idempotencyKey: "mixed-decrement",
        organizationId: scope.organization.id,
        productId: mixedItem.id,
      }),
    ]);
    expect(mixedResults.every(({ kind }) => kind === "success")).toBe(true);
    state = await inventoryState(scope.branch.id, mixedItem.id);
    expect(state.balance?.quantity.toString()).toBe("2");
    expect(state.transactions).toHaveLength(3);
    expect(state.aggregate?.toString()).toBe("2");

    const identicalItem = await product({
      organizationId: scope.organization.id,
      sku: "IDENTICAL-RACE",
    });
    const identicalResults = await Promise.all(
      Array.from({ length: 8 }, () =>
        adjust({
          actorUserId: owner.user.id,
          branchId: scope.branch.id,
          delta: "1",
          idempotencyKey: "same-concurrent-key",
          organizationId: scope.organization.id,
          productId: identicalItem.id,
        }),
      ),
    );
    expect(
      identicalResults.filter(({ kind }) => kind === "success"),
    ).toHaveLength(1);
    expect(
      identicalResults.filter(({ kind }) => kind === "replay"),
    ).toHaveLength(7);
    state = await inventoryState(scope.branch.id, identicalItem.id);
    expect(state.balance?.quantity.toString()).toBe("1");
    expect(state.transactions).toHaveLength(1);
    expect(state.aggregate?.toString()).toBe("1");
  }, 20_000);

  it("serializes concurrent conflicting reuse across different products before mutation", async () => {
    const scope = await organization("Concurrent Conflict Store");
    const owner = await actor({
      email: "concurrent-conflict-owner@example.com",
      organizationId: scope.organization.id,
      role: "OWNER",
    });
    const firstItem = await product({
      organizationId: scope.organization.id,
      sku: "CONFLICT-FIRST",
    });
    const secondItem = await product({
      organizationId: scope.organization.id,
      sku: "CONFLICT-SECOND",
    });

    const results = await Promise.all([
      adjust({
        actorUserId: owner.user.id,
        branchId: scope.branch.id,
        delta: "1",
        idempotencyKey: "same-conflicting-key",
        organizationId: scope.organization.id,
        productId: firstItem.id,
      }),
      adjust({
        actorUserId: owner.user.id,
        branchId: scope.branch.id,
        delta: "2",
        idempotencyKey: "same-conflicting-key",
        organizationId: scope.organization.id,
        productId: secondItem.id,
      }),
    ]);
    expect(results.map(({ kind }) => kind).sort()).toEqual([
      "idempotency_conflict",
      "success",
    ]);
    const [firstState, secondState] = await Promise.all([
      inventoryState(scope.branch.id, firstItem.id),
      inventoryState(scope.branch.id, secondItem.id),
    ]);
    expect(
      firstState.transactions.length + secondState.transactions.length,
    ).toBe(1);
    const persistedBalances = [firstState.balance, secondState.balance].filter(
      (balance) => balance !== null,
    );
    expect(persistedBalances).toHaveLength(1);
    expect(["1", "2"]).toContain(persistedBalances[0]?.quantity.toString());
    expect(firstState.aggregate?.toString() ?? "0").toBe(
      firstState.balance?.quantity.toString() ?? "0",
    );
    expect(secondState.aggregate?.toString() ?? "0").toBe(
      secondState.balance?.quantity.toString() ?? "0",
    );
  }, 20_000);

  it("applies manual adjustments to known cost value and preserves unknown basis", async () => {
    const scope = await organization("Adjustment cost state");
    const owner = await actor({
      email: "adjustment-cost-owner@example.com",
      organizationId: scope.organization.id,
      role: "OWNER",
    });
    const knownItem = await product({
      organizationId: scope.organization.id,
      sku: "KNOWN-COST",
    });
    const unknownItem = await product({
      organizationId: scope.organization.id,
      sku: "UNKNOWN-COST",
    });
    await prisma.inventoryBalance.createMany({
      data: [knownItem, unknownItem].map((item) => ({
        branchId: scope.branch.id,
        organizationId: scope.organization.id,
        productId: item.id,
        quantity: "10",
      })),
    });
    await prisma.inventoryCostState.createMany({
      data: [
        {
          averageUnitCost: "2",
          basisState: "KNOWN",
          branchId: scope.branch.id,
          inventoryValue: "20",
          organizationId: scope.organization.id,
          productId: knownItem.id,
        },
        {
          basisState: "UNKNOWN",
          branchId: scope.branch.id,
          organizationId: scope.organization.id,
          productId: unknownItem.id,
        },
      ],
    });

    await adjust({
      actorUserId: owner.user.id,
      branchId: scope.branch.id,
      delta: "2",
      idempotencyKey: "known-cost-positive",
      organizationId: scope.organization.id,
      productId: knownItem.id,
    });
    await adjust({
      actorUserId: owner.user.id,
      branchId: scope.branch.id,
      delta: "1",
      idempotencyKey: "unknown-cost-positive",
      organizationId: scope.organization.id,
      productId: unknownItem.id,
    });
    await adjust({
      actorUserId: owner.user.id,
      branchId: scope.branch.id,
      delta: "-2",
      idempotencyKey: "unknown-cost-negative",
      organizationId: scope.organization.id,
      productId: unknownItem.id,
    });
    await adjust({
      actorUserId: owner.user.id,
      branchId: scope.branch.id,
      delta: "-12",
      idempotencyKey: "known-cost-to-zero",
      organizationId: scope.organization.id,
      productId: knownItem.id,
    });

    const known = await prisma.inventoryCostState.findUniqueOrThrow({
      where: {
        branchId_productId: {
          branchId: scope.branch.id,
          productId: knownItem.id,
        },
      },
    });
    const unknown = await prisma.inventoryCostState.findUniqueOrThrow({
      where: {
        branchId_productId: {
          branchId: scope.branch.id,
          productId: unknownItem.id,
        },
      },
    });
    expect(known.inventoryValue?.toFixed(10)).toBe("0.0000000000");
    expect(known.averageUnitCost?.toFixed(6)).toBe("2.000000");
    expect(unknown).toMatchObject({
      averageUnitCost: null,
      basisState: "UNKNOWN",
      inventoryValue: null,
    });
  });

  it("projects known value from resulting quantity and retained average without a negative rounding residual", async () => {
    const scope = await organization("Adjustment rounded cost residual");
    const owner = await actor({
      email: "adjustment-rounded-cost-owner@example.com",
      organizationId: scope.organization.id,
      role: "OWNER",
    });
    const item = await product({
      organizationId: scope.organization.id,
      sku: "ROUNDED-COST",
    });
    expect(
      await adjust({
        actorUserId: owner.user.id,
        branchId: scope.branch.id,
        delta: "199",
        idempotencyKey: "rounded-cost-seed",
        organizationId: scope.organization.id,
        productId: item.id,
      }),
    ).toMatchObject({ kind: "success" });
    await prisma.inventoryCostState.create({
      data: {
        averageUnitCost: "0.000001",
        basisState: "KNOWN",
        branchId: scope.branch.id,
        inventoryValue: "0.0001",
        organizationId: scope.organization.id,
        productId: item.id,
      },
    });

    expect(
      await adjust({
        actorUserId: owner.user.id,
        branchId: scope.branch.id,
        delta: "-198",
        idempotencyKey: "rounded-cost-decrement",
        organizationId: scope.organization.id,
        productId: item.id,
      }),
    ).toMatchObject({ kind: "success" });

    const [state, cost] = await Promise.all([
      inventoryState(scope.branch.id, item.id),
      prisma.inventoryCostState.findUniqueOrThrow({
        where: {
          branchId_productId: {
            branchId: scope.branch.id,
            productId: item.id,
          },
        },
      }),
    ]);
    expect(state.balance?.quantity.toFixed(4)).toBe("1.0000");
    expect(state.aggregate?.toFixed(4)).toBe("1.0000");
    expect(state.transactions.map((row) => row.delta.toFixed(4))).toEqual([
      "199.0000",
      "-198.0000",
    ]);
    expect(cost.averageUnitCost?.toFixed(6)).toBe("0.000001");
    expect(cost.inventoryValue?.toFixed(10)).toBe("0.0000010000");
    expect(cost.inventoryValue?.isNegative()).toBe(false);
  });
});
