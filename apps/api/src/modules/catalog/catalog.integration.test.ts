import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { loadTestDatabaseEnvironment } from "../../test/database-environment.ts";
import {
  createTestPrismaClient,
  resetTestDatabase,
} from "../../test/database-harness.ts";
import { createPrismaCatalogRepository } from "./catalog-repository.ts";
import {
  categoryCreateRequestSchema,
  categoryListQuerySchema,
  categoryUpdateRequestSchema,
  productCreateRequestSchema,
  productListQuerySchema,
  productUpdateRequestSchema,
} from "./catalog-schemas.ts";

const environment = loadTestDatabaseEnvironment();
const prisma = createTestPrismaClient(environment);
const NOW = new Date("2026-08-25T12:00:00.000Z");
const PASSWORD_HASH_FIXTURE =
  "$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$c2NoZW1hLXRlc3Q";
const repository = createPrismaCatalogRepository(prisma, () => NOW);

async function actor(
  organizationId: string,
  email: string,
  role: "OWNER" | "ADMIN" | "BRANCH_MANAGER" | "INVENTORY_STAFF" | "CASHIER",
) {
  const user = await prisma.user.create({
    data: {
      email,
      emailVerifiedAt: NOW,
      passwordHash: PASSWORD_HASH_FIXTURE,
    },
  });
  await prisma.organizationMembership.create({
    data: { organizationId, role, userId: user.id },
  });
  return user;
}

async function branch(organizationId: string, code: string) {
  return prisma.branch.create({
    data: { code, name: code, organizationId },
  });
}

async function assign(
  organizationId: string,
  branchId: string,
  userId: string,
) {
  return prisma.branchAssignment.create({
    data: { branchId, organizationId, userId },
  });
}

describe("catalog API repository with PostgreSQL", () => {
  beforeEach(async () => resetTestDatabase(environment));
  afterAll(async () => {
    await resetTestDatabase(environment);
    await prisma.$disconnect();
  });

  it("enforces organization and branch-scoped role permissions", async () => {
    const organization = await prisma.organization.create({
      data: { name: "Store" },
    });
    const other = await prisma.organization.create({ data: { name: "Other" } });
    const activeBranch = await branch(organization.id, "MAIN");
    const otherBranch = await branch(other.id, "OTHER");
    const owner = await actor(
      organization.id,
      "owner-catalog@example.com",
      "OWNER",
    );
    const admin = await actor(
      organization.id,
      "admin-catalog@example.com",
      "ADMIN",
    );
    const manager = await actor(
      organization.id,
      "manager-catalog@example.com",
      "BRANCH_MANAGER",
    );
    const staff = await actor(
      organization.id,
      "staff-catalog@example.com",
      "INVENTORY_STAFF",
    );
    const cashier = await actor(
      organization.id,
      "cashier-catalog@example.com",
      "CASHIER",
    );
    await Promise.all([
      assign(organization.id, activeBranch.id, manager.id),
      assign(organization.id, activeBranch.id, staff.id),
      assign(organization.id, activeBranch.id, cashier.id),
    ]);
    const category = categoryCreateRequestSchema.parse({ name: "Food" });

    await expect(
      repository.createCategory({
        actorUserId: owner.id,
        category,
        organizationId: organization.id,
      }),
    ).resolves.toMatchObject({ kind: "success" });
    await expect(
      repository.createCategory({
        actorUserId: admin.id,
        category: categoryCreateRequestSchema.parse({ name: "Drinks" }),
        organizationId: organization.id,
      }),
    ).resolves.toMatchObject({ kind: "success" });
    await expect(
      repository.createCategory({
        actorUserId: manager.id,
        category: categoryCreateRequestSchema.parse({ name: "Missing branch" }),
        organizationId: organization.id,
      }),
    ).resolves.toEqual({ kind: "branch_context_required" });
    await expect(
      repository.createCategory({
        actorUserId: manager.id,
        branchId: otherBranch.id,
        category: categoryCreateRequestSchema.parse({ name: "Cross branch" }),
        organizationId: organization.id,
      }),
    ).resolves.toEqual({ kind: "forbidden" });
    await expect(
      repository.createCategory({
        actorUserId: staff.id,
        branchId: activeBranch.id,
        category: categoryCreateRequestSchema.parse({ name: "Staff category" }),
        organizationId: organization.id,
      }),
    ).resolves.toMatchObject({ kind: "forbidden" });
    await expect(
      repository.createCategory({
        actorUserId: cashier.id,
        branchId: activeBranch.id,
        category: categoryCreateRequestSchema.parse({ name: "Forged owner" }),
        organizationId: organization.id,
      }),
    ).resolves.toEqual({ kind: "forbidden" });

    const current = await prisma.category.findFirstOrThrow({
      where: { organizationId: organization.id, normalizedName: "food" },
    });
    await expect(
      repository.getCategory({
        actorUserId: cashier.id,
        branchId: activeBranch.id,
        categoryId: current.id,
        organizationId: organization.id,
      }),
    ).resolves.toMatchObject({ kind: "success" });
    await expect(
      repository.setCategoryLifecycle({
        actorUserId: staff.id,
        branchId: activeBranch.id,
        categoryId: current.id,
        expectedUpdatedAt: current.updatedAt,
        organizationId: organization.id,
        status: "INACTIVE",
      }),
    ).resolves.toEqual({ kind: "forbidden" });
    await expect(
      repository.setCategoryLifecycle({
        actorUserId: manager.id,
        branchId: activeBranch.id,
        categoryId: current.id,
        expectedUpdatedAt: current.updatedAt,
        organizationId: organization.id,
        status: "INACTIVE",
      }),
    ).resolves.toMatchObject({
      kind: "success",
      category: { status: "INACTIVE" },
    });

    await prisma.branchAssignment.update({
      data: { deactivatedAt: NOW, status: "INACTIVE" },
      where: {
        organizationId_userId_branchId: {
          branchId: activeBranch.id,
          organizationId: organization.id,
          userId: manager.id,
        },
      },
    });
    await expect(
      repository.getCategory({
        actorUserId: manager.id,
        branchId: activeBranch.id,
        categoryId: current.id,
        organizationId: organization.id,
      }),
    ).resolves.toEqual({ kind: "forbidden" });

    await prisma.organizationMembership.update({
      data: { deactivatedAt: NOW, status: "INACTIVE" },
      where: {
        organizationId_userId: {
          organizationId: organization.id,
          userId: cashier.id,
        },
      },
    });
    await expect(
      repository.getCategory({
        actorUserId: cashier.id,
        categoryId: current.id,
        organizationId: organization.id,
      }),
    ).resolves.toEqual({ kind: "forbidden" });
  });

  it("supports category CRUD, lifecycle, Unicode conflict races, and bound cursors", async () => {
    const organization = await prisma.organization.create({
      data: { name: "Store" },
    });
    const owner = await actor(
      organization.id,
      "owner-category@example.com",
      "OWNER",
    );
    const duplicateResults = await Promise.all([
      repository.createCategory({
        actorUserId: owner.id,
        category: categoryCreateRequestSchema.parse({ name: "Food" }),
        organizationId: organization.id,
      }),
      repository.createCategory({
        actorUserId: owner.id,
        category: categoryCreateRequestSchema.parse({ name: " ＦＯＯＤ " }),
        organizationId: organization.id,
      }),
    ]);
    expect(duplicateResults.map(({ kind }) => kind).sort()).toEqual([
      "name_conflict",
      "success",
    ]);
    const created = duplicateResults.find(
      (result): result is Extract<typeof result, { kind: "success" }> =>
        result.kind === "success",
    );
    expect(created).toBeDefined();
    if (created === undefined)
      throw new Error("Expected one created category.");

    const updated = await repository.updateCategory({
      actorUserId: owner.id,
      category: categoryUpdateRequestSchema.parse({
        description: "  Pantry  item  ",
        expectedUpdatedAt: created.category.updatedAt,
      }),
      categoryId: created.category.id,
      organizationId: organization.id,
    });
    expect(updated).toMatchObject({
      category: { description: "Pantry  item" },
      kind: "success",
    });
    await expect(
      repository.updateCategory({
        actorUserId: owner.id,
        category: categoryUpdateRequestSchema.parse({
          expectedUpdatedAt: created.category.updatedAt,
          name: "Stale",
        }),
        categoryId: created.category.id,
        organizationId: organization.id,
      }),
    ).resolves.toEqual({ kind: "stale" });

    if (updated.kind !== "success")
      throw new Error("Expected category update.");
    const inactive = await repository.setCategoryLifecycle({
      actorUserId: owner.id,
      categoryId: updated.category.id,
      expectedUpdatedAt: new Date(updated.category.updatedAt),
      organizationId: organization.id,
      status: "INACTIVE",
    });
    expect(inactive).toMatchObject({
      category: { status: "INACTIVE" },
      kind: "success",
    });
    if (inactive.kind !== "success") throw new Error("Expected deactivation.");
    await expect(
      repository.setCategoryLifecycle({
        actorUserId: owner.id,
        categoryId: inactive.category.id,
        expectedUpdatedAt: new Date(inactive.category.updatedAt),
        organizationId: organization.id,
        status: "INACTIVE",
      }),
    ).resolves.toEqual(inactive);

    for (const name of ["Beverages", "Bakery", "Household"]) {
      await repository.createCategory({
        actorUserId: owner.id,
        category: categoryCreateRequestSchema.parse({ name }),
        organizationId: organization.id,
      });
    }
    const firstPage = await repository.listCategories({
      actorUserId: owner.id,
      organizationId: organization.id,
      query: categoryListQuerySchema.parse({ limit: "2" }),
    });
    expect(firstPage).toMatchObject({
      kind: "success",
      categories: expect.any(Array),
    });
    if (firstPage.kind !== "success" || firstPage.nextCursor === null) {
      throw new Error("Expected a category cursor.");
    }
    const secondPage = await repository.listCategories({
      actorUserId: owner.id,
      organizationId: organization.id,
      query: categoryListQuerySchema.parse({
        cursor: firstPage.nextCursor,
        limit: "2",
      }),
    });
    expect(secondPage).toMatchObject({ kind: "success" });
    await expect(
      repository.listCategories({
        actorUserId: owner.id,
        organizationId: organization.id,
        query: categoryListQuerySchema.parse({
          cursor: firstPage.nextCursor,
          limit: "2",
          q: "bakery",
        }),
      }),
    ).resolves.toEqual({ kind: "invalid_cursor" });
    await expect(
      repository.listCategories({
        actorUserId: owner.id,
        organizationId: organization.id,
        query: categoryListQuerySchema.parse({ cursor: "not-a-cursor" }),
      }),
    ).resolves.toEqual({ kind: "invalid_cursor" });
  });

  it("enforces product category, decimal, lifecycle, search, and immutable relationship rules", async () => {
    const organization = await prisma.organization.create({
      data: { name: "Store" },
    });
    const other = await prisma.organization.create({ data: { name: "Other" } });
    const owner = await actor(
      organization.id,
      "owner-product@example.com",
      "OWNER",
    );
    const activeCategory = await prisma.category.create({
      data: {
        name: "Drinks",
        normalizedName: "drinks",
        organizationId: organization.id,
      },
    });
    const inactiveCategory = await prisma.category.create({
      data: {
        name: "Old",
        normalizedName: "old",
        organizationId: organization.id,
        status: "INACTIVE",
      },
    });
    const crossCategory = await prisma.category.create({
      data: {
        name: "Other",
        normalizedName: "other",
        organizationId: other.id,
      },
    });

    const created = await repository.createProduct({
      actorUserId: owner.id,
      organizationId: organization.id,
      product: productCreateRequestSchema.parse({
        barcode: " 8850001 ",
        basePrice: "60.5",
        categoryId: activeCategory.id,
        name: "  Cola  Drink ",
        sku: " cola-01 ",
        unit: "EA",
      }),
    });
    expect(created).toMatchObject({
      kind: "success",
      product: {
        barcode: "8850001",
        basePrice: "60.5000",
        sku: "COLA-01",
        unit: "EA",
      },
    });
    await expect(
      repository.createProduct({
        actorUserId: owner.id,
        organizationId: organization.id,
        product: productCreateRequestSchema.parse({
          basePrice: "1",
          categoryId: inactiveCategory.id,
          name: "Inactive",
          sku: "INACTIVE",
          unit: "EA",
        }),
      }),
    ).resolves.toEqual({ kind: "category_inactive" });
    await expect(
      repository.createProduct({
        actorUserId: owner.id,
        organizationId: organization.id,
        product: productCreateRequestSchema.parse({
          basePrice: "1",
          categoryId: crossCategory.id,
          name: "Cross",
          sku: "CROSS",
          unit: "EA",
        }),
      }),
    ).resolves.toEqual({ kind: "category_not_found" });

    if (created.kind !== "success")
      throw new Error("Expected product creation.");
    await prisma.category.update({
      data: { status: "INACTIVE" },
      where: { id: activeCategory.id },
    });
    const edited = await repository.updateProduct({
      actorUserId: owner.id,
      organizationId: organization.id,
      product: productUpdateRequestSchema.parse({
        description: "  Existing category retained  ",
        expectedUpdatedAt: created.product.updatedAt,
      }),
      productId: created.product.id,
    });
    expect(edited).toMatchObject({
      kind: "success",
      product: {
        categoryId: activeCategory.id,
        description: "Existing category retained",
      },
    });

    const search = await repository.listProducts({
      actorUserId: owner.id,
      organizationId: organization.id,
      query: productListQuerySchema.parse({ q: "cola" }),
    });
    expect(search).toMatchObject({
      kind: "success",
      products: [{ id: created.product.id }],
    });
    const emptyCrossFilter = await repository.listProducts({
      actorUserId: owner.id,
      organizationId: organization.id,
      query: productListQuerySchema.parse({ categoryId: crossCategory.id }),
    });
    expect(emptyCrossFilter).toEqual({
      kind: "success",
      nextCursor: null,
      products: [],
    });

    if (edited.kind !== "success") throw new Error("Expected product update.");
    const inactive = await repository.setProductLifecycle({
      actorUserId: owner.id,
      expectedUpdatedAt: new Date(edited.product.updatedAt),
      organizationId: organization.id,
      productId: edited.product.id,
      status: "INACTIVE",
    });
    expect(inactive).toMatchObject({
      kind: "success",
      product: { status: "INACTIVE" },
    });
    await expect(
      repository.listProducts({
        actorUserId: owner.id,
        organizationId: organization.id,
        query: productListQuerySchema.parse({}),
      }),
    ).resolves.toEqual({ kind: "success", nextCursor: null, products: [] });
    await expect(
      repository.getProduct({
        actorUserId: owner.id,
        organizationId: organization.id,
        productId: edited.product.id,
      }),
    ).resolves.toMatchObject({
      kind: "success",
      product: { status: "INACTIVE" },
    });
  });

  it("translates concurrent SKU/barcode races and exact stale product edits", async () => {
    const organization = await prisma.organization.create({
      data: { name: "Store" },
    });
    const owner = await actor(
      organization.id,
      "owner-race@example.com",
      "OWNER",
    );
    const skuResults = await Promise.all([
      repository.createProduct({
        actorUserId: owner.id,
        organizationId: organization.id,
        product: productCreateRequestSchema.parse({
          basePrice: "1",
          name: "A",
          sku: " race-sku ",
          unit: "EA",
        }),
      }),
      repository.createProduct({
        actorUserId: owner.id,
        organizationId: organization.id,
        product: productCreateRequestSchema.parse({
          basePrice: "2",
          name: "B",
          sku: "RACE-SKU",
          unit: "EA",
        }),
      }),
    ]);
    expect(skuResults.map(({ kind }) => kind).sort()).toEqual([
      "sku_conflict",
      "success",
    ]);

    const barcodeResults = await Promise.all([
      repository.createProduct({
        actorUserId: owner.id,
        organizationId: organization.id,
        product: productCreateRequestSchema.parse({
          barcode: "RACE-BARCODE",
          basePrice: "1",
          name: "C",
          sku: "BAR-1",
          unit: "EA",
        }),
      }),
      repository.createProduct({
        actorUserId: owner.id,
        organizationId: organization.id,
        product: productCreateRequestSchema.parse({
          barcode: " RACE-BARCODE ",
          basePrice: "1",
          name: "D",
          sku: "BAR-2",
          unit: "EA",
        }),
      }),
    ]);
    expect(barcodeResults.map(({ kind }) => kind).sort()).toEqual([
      "barcode_conflict",
      "success",
    ]);

    const product = skuResults.find(
      (result): result is Extract<typeof result, { kind: "success" }> =>
        result.kind === "success",
    );
    if (product === undefined) throw new Error("Expected one product.");
    const edits = await Promise.all([
      repository.updateProduct({
        actorUserId: owner.id,
        organizationId: organization.id,
        product: productUpdateRequestSchema.parse({
          expectedUpdatedAt: product.product.updatedAt,
          name: "Winner A",
        }),
        productId: product.product.id,
      }),
      repository.updateProduct({
        actorUserId: owner.id,
        organizationId: organization.id,
        product: productUpdateRequestSchema.parse({
          expectedUpdatedAt: product.product.updatedAt,
          name: "Winner B",
        }),
        productId: product.product.id,
      }),
    ]);
    expect(edits.map(({ kind }) => kind).sort()).toEqual(["stale", "success"]);
  });
});
