import type { PrismaClient } from "../generated/prisma/client.ts";
import { verifyDemoDatabase } from "../demo/demo-local-database.ts";
import { DEMO_30D_ORGANIZATION } from "../demo/demo-30d-plan.ts";
import { ORGANIZATION_ROLES } from "../modules/identity/authorization-policy.ts";
import { hashPassword } from "../modules/identity/password-hasher.ts";

/** Only called on an owned disposable database by the test/browser setup. */
export async function createDemo30dTestFixture(prisma: PrismaClient) {
  await verifyDemoDatabase(prisma);
  const createdAt = new Date("2026-08-01T00:00:00Z");
  const organization = await prisma.organization.create({
    data: {
      name: DEMO_30D_ORGANIZATION,
      reportingTimezone: "Asia/Bangkok",
      salesVatStatus: "NOT_REGISTERED",
      createdAt,
    },
  });
  const branches = await Promise.all(
    ["MAIN", "NORTH"].map((code) =>
      prisma.branch.create({
        data: {
          code,
          name: `Demo ${code}`,
          organizationId: organization.id,
          createdAt,
        },
      }),
    ),
  );
  const password = "synthetic-demo30d-password-only";
  const passwordHash = await hashPassword(password);
  const actors = await Promise.all(
    ORGANIZATION_ROLES.map(async (role) => {
      const user = await prisma.user.create({
        data: {
          displayName: `Demo ${role}`,
          email: `demo30d-${role.toLowerCase()}@example.invalid`,
          passwordHash,
          emailVerifiedAt: createdAt,
          createdAt,
        },
      });
      await prisma.organizationMembership.create({
        data: {
          organizationId: organization.id,
          userId: user.id,
          role,
          createdAt,
        },
      });
      if (role !== "OWNER" && role !== "ADMIN")
        await prisma.branchAssignment.create({
          data: {
            organizationId: organization.id,
            userId: user.id,
            branchId: branches[0]!.id,
            createdAt,
          },
        });
      return { role, user };
    }),
  );
  const products = await Promise.all(
    ["Daily Rice", "Tea", "Milk", "Noodles", "Soap", "Seasonal Gift"].map(
      (name, index) =>
        prisma.product.create({
          data: {
            organizationId: organization.id,
            sku: `DEMO30-${index}`,
            name,
            unit: "EA",
            basePrice: String(20 + index * 10),
            createdAt,
          },
        }),
    ),
  );
  const supplier = await prisma.supplier.create({
    data: {
      name: "Synthetic Demo Supplier",
      organizationId: organization.id,
      createdAt,
    },
  });
  const other = await prisma.organization.create({
    data: { name: "Unrelated Demo Tenant", reportingTimezone: "Asia/Bangkok" },
  });
  await prisma.organizationMembership.create({
    data: {
      organizationId: other.id,
      userId: actors.find((a) => a.role === "OWNER")!.user.id,
      role: "OWNER",
    },
  });
  return {
    organization,
    branches,
    actors,
    products,
    supplier,
    other,
    password,
  };
}
