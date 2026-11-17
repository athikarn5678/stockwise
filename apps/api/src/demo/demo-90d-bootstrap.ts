import { Prisma, type PrismaClient } from "../generated/prisma/client.ts";
import {
  canonicalizeCategoryName,
  canonicalizeProductName,
  canonicalizeSku,
  parseCatalogBasePrice,
} from "../modules/catalog/catalog-values.ts";
import type { OrganizationRole } from "../modules/identity/authorization-policy.ts";
import { hashFirstOrganizationOnboardingRequest } from "../modules/identity/first-organization-onboarding-schema.ts";
import { hashPassword } from "../modules/identity/password-hasher.ts";
import { DEMO_30D_ORGANIZATION, type Demo30dProduct } from "./demo-30d-plan.ts";
import { demoId } from "./demo-values.ts";

const REPORTING_TIMEZONE = "Asia/Bangkok";

interface Demo90dBranch {
  id: string;
  code: string;
  name: string;
}

interface Demo90dCategory {
  id: string;
  name: string;
  normalizedName: string;
}

interface Demo90dProduct extends Demo30dProduct {
  categoryId: string;
}

interface Demo90dSupplier {
  id: string;
  name: string;
}

interface Demo90dUser {
  id: string;
  membershipId: string;
  email: string;
  displayName: string;
  role: OrganizationRole;
  branchCodes: readonly string[];
}

export interface Demo90dCatalog {
  organization: {
    id: string;
    name: string;
    timezone: string;
    salesVatStatus: "NOT_REGISTERED";
    salesVatRate: null;
  };
  branches: readonly Demo90dBranch[];
  categories: readonly Demo90dCategory[];
  products: readonly Demo90dProduct[];
  suppliers: readonly Demo90dSupplier[];
  users: readonly Demo90dUser[];
}

/** Three branches; the plan uses them all. */
const BRANCHES = [
  { code: "MAIN", name: "Siam Mart Main" },
  { code: "NORTH", name: "Siam Mart North" },
  { code: "EAST", name: "Siam Mart East" },
] as const;

const CATEGORIES = [
  "Beverages",
  "Dry Goods",
  "Fresh Food",
  "Household",
] as const;

/**
 * Twelve Thai-market retail items in demand order: `DEMO-P01` sells most and
 * `DEMO-P12` least because the plan ranks products by SKU.
 */
const PRODUCTS = [
  {
    sku: "DEMO-P01",
    name: "Siam Drinking Water 600 ml",
    category: "Beverages",
    unit: "EA",
    price: "7.0000",
  },
  {
    sku: "DEMO-P02",
    name: "Thai Jasmine Rice 1 kg",
    category: "Dry Goods",
    unit: "PACK",
    price: "65.0000",
  },
  {
    sku: "DEMO-P03",
    name: "Instant Noodle Pack",
    category: "Dry Goods",
    unit: "PACK",
    price: "12.0000",
  },
  {
    sku: "DEMO-P04",
    name: "Fresh Chicken Breast",
    category: "Fresh Food",
    unit: "KG",
    price: "89.0000",
  },
  {
    sku: "DEMO-P05",
    name: "Fresh Pork Shoulder",
    category: "Fresh Food",
    unit: "KG",
    price: "129.0000",
  },
  {
    sku: "DEMO-P06",
    name: "Chiang Rai Green Tea 500 ml",
    category: "Beverages",
    unit: "EA",
    price: "20.0000",
  },
  {
    sku: "DEMO-P07",
    name: "Seasoning Soy Sauce 700 ml",
    category: "Dry Goods",
    unit: "EA",
    price: "35.0000",
  },
  {
    sku: "DEMO-P08",
    name: "Laundry Detergent 3 L",
    category: "Household",
    unit: "L",
    price: "149.0000",
  },
  {
    sku: "DEMO-P09",
    name: "Dishwashing Liquid 500 ml",
    category: "Household",
    unit: "EA",
    price: "45.0000",
  },
  {
    sku: "DEMO-P10",
    name: "Facial Tissue 4 Pack",
    category: "Household",
    unit: "PACK",
    price: "55.0000",
  },
  {
    sku: "DEMO-P11",
    name: "Palm Cooking Oil 1 L",
    category: "Dry Goods",
    unit: "L",
    price: "62.0000",
  },
  {
    sku: "DEMO-P12",
    name: "Fresh Eggs 10 Pack",
    category: "Fresh Food",
    unit: "PACK",
    price: "68.0000",
  },
] as const satisfies readonly {
  sku: string;
  name: string;
  category: (typeof CATEGORIES)[number];
  unit: "EA" | "PACK" | "KG" | "L";
  price: string;
}[];

const SUPPLIERS = ["Demo Supplier A", "Demo Supplier B"] as const;

/** One user per accepted role; exactly one OWNER. */
const USERS = [
  {
    email: "demo-owner@example.invalid",
    displayName: "Demo Owner",
    role: "OWNER",
    branchCodes: [],
  },
  {
    email: "demo-admin@example.invalid",
    displayName: "Demo Admin",
    role: "ADMIN",
    branchCodes: [],
  },
  {
    email: "demo-manager@example.invalid",
    displayName: "Demo Manager",
    role: "BRANCH_MANAGER",
    branchCodes: ["MAIN", "NORTH"],
  },
  {
    email: "demo-inventory@example.invalid",
    displayName: "Demo Inventory",
    role: "INVENTORY_STAFF",
    branchCodes: ["NORTH"],
  },
  {
    email: "demo-cashier@example.invalid",
    displayName: "Demo Cashier",
    role: "CASHIER",
    branchCodes: ["MAIN"],
  },
] as const satisfies readonly {
  email: string;
  displayName: string;
  role: OrganizationRole;
  branchCodes: readonly string[];
}[];

const ORGANIZATION_ID = demoId("organization", DEMO_30D_ORGANIZATION);

/** The deterministic organization every bootstrap rerun must find. */
export const DEMO_90D_ORGANIZATION_ID = ORGANIZATION_ID;

/**
 * PURE and clock-free: the whole identity + catalog of the synthetic demo.
 * Ids are reproducible so a rerun addresses exactly the rows it created before.
 */
export function demo90dCatalog(): Demo90dCatalog {
  const categories = CATEGORIES.map((rawName) => {
    const canonical = canonicalizeCategoryName(rawName);
    return {
      id: demoId("category", canonical.name),
      name: canonical.name,
      normalizedName: canonical.normalizedName,
      rawName,
    };
  });
  const categoryIdByName = new Map(
    categories.map((category) => [category.rawName, category.id]),
  );
  return {
    organization: {
      id: ORGANIZATION_ID,
      name: DEMO_30D_ORGANIZATION,
      timezone: REPORTING_TIMEZONE,
      salesVatStatus: "NOT_REGISTERED",
      salesVatRate: null,
    },
    branches: BRANCHES.map((branch) => ({
      id: demoId("branch", branch.code),
      code: branch.code,
      name: branch.name,
    })),
    categories: categories.map(({ id, name, normalizedName }) => ({
      id,
      name,
      normalizedName,
    })),
    products: PRODUCTS.map((item) => {
      const sku = canonicalizeSku(item.sku);
      const categoryId = categoryIdByName.get(item.category);
      if (categoryId === undefined)
        throw new Error(`Demo90d product ${sku} names an unknown category.`);
      return {
        id: demoId("product", sku),
        name: canonicalizeProductName(item.name),
        sku,
        unit: item.unit,
        basePrice: parseCatalogBasePrice(item.price),
        categoryId,
      };
    }),
    suppliers: SUPPLIERS.map((name) => ({
      id: demoId("supplier", name),
      name,
    })),
    users: USERS.map((user) => ({
      id: demoId("user", user.email),
      membershipId: demoId(
        "membership",
        `${DEMO_30D_ORGANIZATION}|${user.email}`,
      ),
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      branchCodes: [...user.branchCodes],
    })),
  };
}

export type DemoPasswordSource =
  "DEMO_USER_PASSWORD" | "documented-local-default";

/** Local disposable-database default; the Learner Lab target must supply one. */
export const DEMO_LOCAL_DEFAULT_PASSWORD = "StockWise-Demo-2026!";

export function resolveDemoPassword(
  environment: Readonly<Record<string, string | undefined>>,
): { password: string; source: DemoPasswordSource } {
  const supplied = environment.DEMO_USER_PASSWORD;
  if (supplied !== undefined) {
    const length = [...supplied].length;
    if (length < 15 || length > 128)
      throw new Error(
        "Demo90d DEMO_USER_PASSWORD must contain 15 to 128 Unicode code points.",
      );
    return { password: supplied, source: "DEMO_USER_PASSWORD" };
  }
  if (environment.STOCKWISE_DEMO_SEED_TARGET === "learner-lab-ops")
    throw new Error(
      "Demo90d DEMO_USER_PASSWORD is required for the Learner Lab target.",
    );
  return {
    password: DEMO_LOCAL_DEFAULT_PASSWORD,
    source: "documented-local-default",
  };
}

const CONFLICT_MESSAGE = "Demo90d bootstrap found a conflicting organization.";

const CREDENTIAL_PROVIDER = "credential";

interface ExistingOrganization {
  name: string;
  status: string;
  branches: { id: string; code: string; name: string }[];
  products: { id: string; sku: string }[];
  suppliers: { id: string; name: string }[];
  memberships: {
    id: string;
    userId: string;
    role: string;
    status: string;
    user: {
      id: string;
      email: string;
      status: string;
      emailVerifiedAt: Date | null;
      betterAuthAccounts: {
        providerId: string;
        accountId: string;
        userId: string;
        password: string | null;
      }[];
    };
  }[];
}

function matchesCatalog(
  existing: ExistingOrganization,
  catalog: Demo90dCatalog,
): boolean {
  if (
    existing.name !== catalog.organization.name ||
    existing.status !== "ACTIVE"
  )
    return false;
  if (existing.branches.length !== catalog.branches.length) return false;
  for (const branch of catalog.branches) {
    const found = existing.branches.find((row) => row.id === branch.id);
    if (!found || found.code !== branch.code || found.name !== branch.name)
      return false;
  }
  if (existing.products.length !== catalog.products.length) return false;
  for (const product of catalog.products) {
    const found = existing.products.find((row) => row.id === product.id);
    if (!found || found.sku !== product.sku) return false;
  }
  if (existing.suppliers.length !== catalog.suppliers.length) return false;
  for (const supplier of catalog.suppliers) {
    const found = existing.suppliers.find((row) => row.id === supplier.id);
    if (!found || found.name !== supplier.name) return false;
  }
  if (existing.memberships.length !== catalog.users.length) return false;
  for (const user of catalog.users) {
    const membership = existing.memberships.find(
      (row) => row.userId === user.id,
    );
    if (!membership || membership.role !== user.role) return false;
    if (membership.status !== "ACTIVE") return false;
    const member = membership.user;
    if (
      member.id !== user.id ||
      member.email !== user.email ||
      member.status !== "ACTIVE" ||
      member.emailVerifiedAt === null
    )
      return false;
    const credentials = member.betterAuthAccounts.filter(
      (account) => account.providerId === CREDENTIAL_PROVIDER,
    );
    if (
      credentials.length !== 1 ||
      credentials[0]!.accountId !== user.id ||
      credentials[0]!.userId !== user.id ||
      credentials[0]!.password === null
    )
      return false;
  }
  return true;
}

/**
 * Creates the whole synthetic demo identity + catalog in one transaction, or
 * verifies an existing bootstrap and returns without writing anything.
 */
export async function bootstrapDemo90d(
  prisma: PrismaClient,
  input: { password: string; createdAt: Date },
): Promise<{ organizationId: string; created: boolean }> {
  const catalog = demo90dCatalog();
  const organizationId = catalog.organization.id;
  const at = input.createdAt;

  const existing = await prisma.organization.findUnique({
    where: { id: organizationId },
    include: {
      branches: true,
      products: true,
      suppliers: true,
      memberships: {
        include: {
          user: { include: { betterAuthAccounts: true } },
        },
      },
    },
  });
  if (existing) {
    if (!matchesCatalog(existing, catalog)) throw new Error(CONFLICT_MESSAGE);
    return { organizationId, created: false };
  }

  const [userCount, organizationCount] = await Promise.all([
    prisma.user.count(),
    prisma.organization.count(),
  ]);
  if (userCount !== 0 || organizationCount !== 0)
    throw new Error("Demo90d bootstrap requires an empty database.");

  // One Argon2id verifier per demo user, computed before the transaction opens.
  const passwordHashes = await Promise.all(
    catalog.users.map(() => hashPassword(input.password)),
  );

  const branchIdByCode = new Map(
    catalog.branches.map((branch) => [branch.code, branch.id]),
  );
  const owner = catalog.users.find((user) => user.role === "OWNER")!;
  const mainBranch = catalog.branches.find((branch) => branch.code === "MAIN")!;
  const onboarding: Prisma.FirstOrganizationOnboardingCreateManyInput = {
    userId: owner.id,
    organizationId,
    branchId: mainBranch.id,
    requestHash: hashFirstOrganizationOnboardingRequest({
      displayName: owner.displayName,
      phone: null,
      organizationName: catalog.organization.name,
      branchName: mainBranch.name,
      branchPhone: null,
      branchAddress: null,
    }),
    completedAt: at,
  };

  await prisma.$transaction(
    async (tx) => {
      await tx.organization.createMany({
        data: [
          {
            id: organizationId,
            name: catalog.organization.name,
            status: "ACTIVE",
            salesVatStatus: catalog.organization.salesVatStatus,
            salesVatRate: null,
            reportingTimezone: catalog.organization.timezone,
            deactivatedAt: null,
            createdAt: at,
            updatedAt: at,
          },
        ],
      });
      await tx.branch.createMany({
        data: catalog.branches.map((branch) => ({
          id: branch.id,
          organizationId,
          code: branch.code,
          name: branch.name,
          phone: null,
          address: null,
          status: "ACTIVE",
          deactivatedAt: null,
          createdAt: at,
          updatedAt: at,
        })),
      });
      // Native identity: verified and registered at the bootstrap instant. The
      // credential lives only in the Better Auth account (users has no hash column).
      await tx.user.createMany({
        data: catalog.users.map((user) => ({
          id: user.id,
          email: user.email,
          status: "ACTIVE",
          displayName: user.displayName,
          phone: null,
          emailVerified: true,
          emailVerifiedAt: at,
          nativeRegistrationCompletedAt: at,
          passwordChangedAt: at,
          disabledAt: null,
          createdAt: at,
          updatedAt: at,
        })),
      });
      await tx.betterAuthAccount.createMany({
        data: catalog.users.map((user, index) => ({
          providerId: CREDENTIAL_PROVIDER,
          accountId: user.id,
          userId: user.id,
          password: passwordHashes[index]!,
        })),
      });
      await tx.organizationMembership.createMany({
        data: catalog.users.map((user) => ({
          id: user.membershipId,
          organizationId,
          userId: user.id,
          role: user.role,
          status: "ACTIVE",
          deactivatedAt: null,
          sourceInvitationId: null,
          createdAt: at,
          updatedAt: at,
        })),
      });
      const assignments = catalog.users.flatMap((user) =>
        user.branchCodes.map((code) => {
          const branchId = branchIdByCode.get(code);
          if (branchId === undefined)
            throw new Error("Demo90d user names an unknown branch.");
          return {
            organizationId,
            userId: user.id,
            branchId,
            status: "ACTIVE" as const,
            deactivatedAt: null,
            createdAt: at,
            updatedAt: at,
          };
        }),
      );
      if (assignments.length > 0)
        await tx.branchAssignment.createMany({ data: assignments });
      await tx.firstOrganizationOnboarding.createMany({ data: [onboarding] });
      await tx.category.createMany({
        data: catalog.categories.map((category) => ({
          id: category.id,
          organizationId,
          name: category.name,
          normalizedName: category.normalizedName,
          description: null,
          status: "ACTIVE",
          createdAt: at,
          updatedAt: at,
        })),
      });
      await tx.product.createMany({
        data: catalog.products.map((product) => ({
          id: product.id,
          organizationId,
          categoryId: product.categoryId,
          name: product.name,
          description: null,
          sku: product.sku,
          barcode: null,
          basePrice: new Prisma.Decimal(product.basePrice),
          unit: product.unit,
          status: "ACTIVE",
          createdAt: at,
          updatedAt: at,
        })),
      });
      await tx.supplier.createMany({
        data: catalog.suppliers.map((supplier) => ({
          id: supplier.id,
          organizationId,
          name: supplier.name,
          contactName: null,
          email: null,
          phone: null,
          address: null,
          status: "ACTIVE",
          createdAt: at,
          updatedAt: at,
        })),
      });
    },
    { timeout: 60_000 },
  );

  return { organizationId, created: true };
}
