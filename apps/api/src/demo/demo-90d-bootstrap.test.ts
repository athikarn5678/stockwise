import { describe, expect, it } from "vitest";

import { Prisma } from "../generated/prisma/client.ts";
import { ORGANIZATION_ROLES } from "../modules/identity/authorization-policy.ts";
import {
  DEMO_90D_ORGANIZATION_ID,
  DEMO_LOCAL_DEFAULT_PASSWORD,
  demo90dCatalog,
  resolveDemoPassword,
} from "./demo-90d-bootstrap.ts";
import {
  buildDemo30dPlan,
  DEMO_30D_ORGANIZATION,
  DEMO_90D_SHAPE,
} from "./demo-30d-plan.ts";

const REFERENCE_DATE = "2026-11-17";
const SEED = 90;

function catalogPlan() {
  const catalog = demo90dCatalog();
  const owner = catalog.users.find((user) => user.role === "OWNER");
  const supplier = [...catalog.suppliers].sort((a, b) =>
    a.id.localeCompare(b.id),
  )[0];
  if (!owner || !supplier) throw new Error("Demo90d catalog is incomplete.");
  return buildDemo30dPlan({
    referenceDate: REFERENCE_DATE,
    seed: SEED,
    shape: DEMO_90D_SHAPE,
    reportingTimezone: catalog.organization.timezone,
    organizationId: catalog.organization.id,
    branches: catalog.branches.map(({ id, code }) => ({ id, code })),
    products: catalog.products.map(({ id, name, sku, unit, basePrice }) => ({
      id,
      name,
      sku,
      unit,
      basePrice,
    })),
    settings: {
      actorUserId: owner.id,
      supplierId: supplier.id,
      salesVatStatus: catalog.organization.salesVatStatus,
      salesVatRate: catalog.organization.salesVatRate,
    },
  });
}

describe("demo90dCatalog", () => {
  it("is deterministic and uses the allowlisted organization name", () => {
    const first = demo90dCatalog();
    expect(demo90dCatalog()).toEqual(first);
    expect(first.organization.name).toBe(DEMO_30D_ORGANIZATION);
    expect(first.organization.id).toBe(DEMO_90D_ORGANIZATION_ID);
    expect(first.organization.timezone).toBe("Asia/Bangkok");
    expect(first.organization.salesVatStatus).toBe("NOT_REGISTERED");
    expect(first.organization.salesVatRate).toBeNull();
  });

  it("defines three uniquely identified branches", () => {
    const { branches } = demo90dCatalog();
    expect(branches.map((branch) => branch.code)).toEqual([
      "MAIN",
      "NORTH",
      "EAST",
    ]);
    expect(branches.map((branch) => branch.name)).toEqual([
      "Siam Mart Main",
      "Siam Mart North",
      "Siam Mart East",
    ]);
    expect(new Set(branches.map((branch) => branch.id)).size).toBe(3);
  });

  it("defines twelve ordered, positive-priced products in four existing categories", () => {
    const { products, categories } = demo90dCatalog();
    expect(products).toHaveLength(12);
    expect(products.map((product) => product.sku)).toEqual(
      Array.from(
        { length: 12 },
        (_, index) => `DEMO-P${String(index + 1).padStart(2, "0")}`,
      ),
    );
    expect(new Set(products.map((product) => product.id)).size).toBe(12);
    const categoryIds = new Set(categories.map((category) => category.id));
    expect(categories).toHaveLength(4);
    expect(new Set(categories.map((c) => c.normalizedName)).size).toBe(4);
    for (const product of products) {
      expect(categoryIds.has(product.categoryId)).toBe(true);
      const price = new Prisma.Decimal(product.basePrice);
      expect(price.gt(0)).toBe(true);
      expect(price.lte(500)).toBe(true);
      expect(product.basePrice).toMatch(/^\d+\.\d{4}$/);
    }
    const units = products.map((product) => product.unit);
    expect(units.filter((unit) => unit === "KG").length).toBeGreaterThanOrEqual(
      2,
    );
    expect(units.filter((unit) => unit === "L").length).toBeGreaterThanOrEqual(
      1,
    );
    expect(
      units.filter((unit) => unit === "PACK").length,
    ).toBeGreaterThanOrEqual(3);
  });

  it("defines exactly two suppliers with distinct ids", () => {
    const { suppliers } = demo90dCatalog();
    expect(suppliers.map((supplier) => supplier.name)).toEqual([
      "Demo Supplier A",
      "Demo Supplier B",
    ]);
    expect(new Set(suppliers.map((supplier) => supplier.id)).size).toBe(2);
  });

  it("defines one user per accepted role and branch assignments only for branch roles", () => {
    const { users } = demo90dCatalog();
    expect(users).toHaveLength(5);
    expect(users.map((user) => user.role).sort()).toEqual(
      [...ORGANIZATION_ROLES].sort(),
    );
    expect(users.filter((user) => user.role === "OWNER")).toHaveLength(1);
    expect(new Set(users.map((user) => user.id)).size).toBe(5);
    expect(new Set(users.map((user) => user.email)).size).toBe(5);
    expect(new Set(users.map((user) => user.membershipId)).size).toBe(5);
    const branchScoped = users.filter((user) =>
      ["BRANCH_MANAGER", "INVENTORY_STAFF", "CASHIER"].includes(user.role),
    );
    expect(branchScoped).toHaveLength(3);
    expect(branchScoped.every((user) => user.branchCodes.length > 0)).toBe(
      true,
    );
    expect(
      users
        .filter((user) => ["OWNER", "ADMIN"].includes(user.role))
        .every((user) => user.branchCodes.length === 0),
    ).toBe(true);
  });
});

describe("resolveDemoPassword", () => {
  it("uses DEMO_USER_PASSWORD when the environment supplies one", () => {
    const resolved = resolveDemoPassword({
      DEMO_USER_PASSWORD: "Local-Demo-Password-01",
    });
    expect(resolved).toEqual({
      password: "Local-Demo-Password-01",
      source: "DEMO_USER_PASSWORD",
    });
  });

  it("rejects a set DEMO_USER_PASSWORD outside 15 to 128 code points", () => {
    expect(() =>
      resolveDemoPassword({ DEMO_USER_PASSWORD: "too-short" }),
    ).toThrow(
      "Demo90d DEMO_USER_PASSWORD must contain 15 to 128 Unicode code points.",
    );
  });

  it("falls back to the documented local default when unset", () => {
    expect(resolveDemoPassword({})).toEqual({
      password: DEMO_LOCAL_DEFAULT_PASSWORD,
      source: "documented-local-default",
    });
    expect(
      resolveDemoPassword({ STOCKWISE_RUNTIME_ENV: "development" }).source,
    ).toBe("documented-local-default");
  });

  it("requires an explicit password for the Learner Lab target", () => {
    expect(() =>
      resolveDemoPassword({ STOCKWISE_DEMO_SEED_TARGET: "learner-lab-ops" }),
    ).toThrow(
      "Demo90d DEMO_USER_PASSWORD is required for the Learner Lab target.",
    );
  });
});

describe("demo90d catalog shape", () => {
  it("plans ninety days across three branches and twelve products", () => {
    const plan = catalogPlan();
    expect(plan.version).toBe("demo90d-v1");
    expect(plan.branches).toHaveLength(3);
    expect(plan.products).toHaveLength(12);
    expect(plan.sales.length).toBeGreaterThanOrEqual(700);
    expect(plan.adjustments?.length).toBeGreaterThanOrEqual(9);
    expect(plan.to > plan.from).toBe(true);
  });
});
