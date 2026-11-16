import { hashPassword } from "../../apps/api/src/modules/identity/password-hasher.ts";
import { loadTestDatabaseEnvironment } from "../../apps/api/src/test/database-environment.ts";
import {
  applyTestDatabaseMigrations,
  createTestPrismaClient,
  provisionTestDatabase,
  resetTestDatabase,
} from "../../apps/api/src/test/database-harness.ts";
import { createNativeFixtureUser } from "../../apps/api/src/test/native-user-fixture.ts";
import {
  E2E_BRANCH_ID,
  E2E_CASHIER_EMAIL,
  E2E_CASHIER_ID,
  E2E_MANAGER_EMAIL,
  E2E_MANAGER_ID,
  E2E_INVENTORY_PRODUCT_ID,
  E2E_OTHER_ORGANIZATION_ID,
  E2E_ORGANIZATION_ID,
  E2E_OWNER_EMAIL,
  E2E_OWNER_ID,
  E2E_PASSWORD,
  E2E_POS_PRODUCT_ID,
  E2E_PURCHASE_PRODUCT_ID,
  E2E_SUPPLIER_ID,
} from "./catalog-fixtures.ts";

export default async function globalSetup(): Promise<void> {
  const environment = loadTestDatabaseEnvironment();
  await provisionTestDatabase(environment);
  await applyTestDatabaseMigrations(environment);
  const prisma = createTestPrismaClient(environment);

  try {
    await resetTestDatabase(environment);
    const passwordHash = await hashPassword(E2E_PASSWORD);
    await prisma.organization.create({
      data: { id: E2E_ORGANIZATION_ID, name: "Catalog E2E Store" },
    });
    await prisma.organization.create({
      data: { id: E2E_OTHER_ORGANIZATION_ID, name: "Other E2E Store" },
    });
    await prisma.branch.create({
      data: {
        code: "MAIN",
        id: E2E_BRANCH_ID,
        name: "Main branch",
        organizationId: E2E_ORGANIZATION_ID,
      },
    });
    await createNativeFixtureUser(prisma, {
      displayName: "Catalog Owner",
      email: E2E_OWNER_EMAIL,
      id: E2E_OWNER_ID,
      password: E2E_PASSWORD,
      passwordHash,
    });
    await createNativeFixtureUser(prisma, {
      displayName: "Catalog Manager",
      email: E2E_MANAGER_EMAIL,
      id: E2E_MANAGER_ID,
      password: E2E_PASSWORD,
      passwordHash,
    });
    await createNativeFixtureUser(prisma, {
      displayName: "Catalog Cashier",
      email: E2E_CASHIER_EMAIL,
      id: E2E_CASHIER_ID,
      password: E2E_PASSWORD,
      passwordHash,
    });
    await prisma.organizationMembership.createMany({
      data: [
        {
          organizationId: E2E_ORGANIZATION_ID,
          role: "OWNER",
          userId: E2E_OWNER_ID,
        },
        {
          organizationId: E2E_OTHER_ORGANIZATION_ID,
          role: "OWNER",
          userId: E2E_OWNER_ID,
        },
        {
          organizationId: E2E_ORGANIZATION_ID,
          role: "CASHIER",
          userId: E2E_CASHIER_ID,
        },
        {
          organizationId: E2E_ORGANIZATION_ID,
          role: "BRANCH_MANAGER",
          userId: E2E_MANAGER_ID,
        },
      ],
    });
    await prisma.branchAssignment.create({
      data: {
        branchId: E2E_BRANCH_ID,
        organizationId: E2E_ORGANIZATION_ID,
        userId: E2E_CASHIER_ID,
      },
    });
    await prisma.branchAssignment.create({
      data: {
        branchId: E2E_BRANCH_ID,
        organizationId: E2E_ORGANIZATION_ID,
        userId: E2E_MANAGER_ID,
      },
    });
    await prisma.product.create({
      data: {
        basePrice: "10.0000",
        id: E2E_INVENTORY_PRODUCT_ID,
        name: "Inventory test tea",
        organizationId: E2E_ORGANIZATION_ID,
        sku: "INVENTORY-E2E-01",
        unit: "EA",
      },
    });
    await prisma.product.create({
      data: {
        barcode: "8850000000012",
        basePrice: "35.0000",
        id: E2E_POS_PRODUCT_ID,
        name: "POS E2E coffee",
        organizationId: E2E_ORGANIZATION_ID,
        sku: "POS-E2E-03",
        unit: "EA",
      },
    });
    await prisma.inventoryBalance.create({
      data: {
        branchId: E2E_BRANCH_ID,
        organizationId: E2E_ORGANIZATION_ID,
        productId: E2E_POS_PRODUCT_ID,
        quantity: "5",
      },
    });
    await prisma.inventoryCostState.create({
      data: {
        basisState: "UNKNOWN",
        branchId: E2E_BRANCH_ID,
        organizationId: E2E_ORGANIZATION_ID,
        productId: E2E_POS_PRODUCT_ID,
      },
    });
    await prisma.supplier.create({
      data: {
        id: E2E_SUPPLIER_ID,
        name: "Purchase order E2E supplier",
        organizationId: E2E_ORGANIZATION_ID,
      },
    });
    await prisma.product.create({
      data: {
        basePrice: "20.0000",
        id: E2E_PURCHASE_PRODUCT_ID,
        name: "Purchase order E2E coffee",
        organizationId: E2E_ORGANIZATION_ID,
        sku: "PURCHASE-E2E-02",
        unit: "KG",
      },
    });
  } finally {
    await prisma.$disconnect();
  }
}
