import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as policy from "../identity/authorization-policy.ts";
import {
  createTestPrismaClient,
  resetTestDatabase,
} from "../../test/database-harness.ts";
import { loadTestDatabaseEnvironment } from "../../test/database-environment.ts";
import { createPrismaSupplierRepository } from "./supplier-repository.ts";
import {
  supplierCreateRequestSchema,
  supplierListQuerySchema,
  supplierUpdateRequestSchema,
} from "./supplier-schemas.ts";

const environment = loadTestDatabaseEnvironment();
const prisma = createTestPrismaClient(environment);
const repository = createPrismaSupplierRepository(prisma);
const PASSWORD_HASH = "$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$c2NoZW1hLXRlc3Q";
async function user(
  organizationId: string,
  role: "OWNER" | "BRANCH_MANAGER" | "INVENTORY_STAFF" | "CASHIER",
) {
  const value = await prisma.user.create({
    data: {
      email: `${role.toLowerCase()}-${crypto.randomUUID()}@example.com`,
      emailVerifiedAt: new Date(),
      passwordHash: PASSWORD_HASH,
    },
  });
  await prisma.organizationMembership.create({
    data: { organizationId, userId: value.id, role },
  });
  return value;
}
async function assigned(
  organizationId: string,
  role: "BRANCH_MANAGER" | "INVENTORY_STAFF",
) {
  const value = await user(organizationId, role);
  const branch = await prisma.branch.create({
    data: {
      organizationId,
      code: role.slice(0, 3) + crypto.randomUUID().slice(0, 5),
      name: role,
    },
  });
  await prisma.branchAssignment.create({
    data: { organizationId, userId: value.id, branchId: branch.id },
  });
  return value;
}
const supplier = () =>
  supplierCreateRequestSchema.parse({
    name: "  Example Supply  ",
    contactName: "  Jane  ",
    email: " SALES@EXAMPLE.COM ",
    phone: " 02-123 4567 ",
    address: "  Bangkok  ",
  });
describe("supplier repository", () => {
  beforeEach(async () => resetTestDatabase(environment));
  afterAll(async () => {
    await resetTestDatabase(environment);
    await prisma.$disconnect();
  });
  it("uses Supplier VIEW for reads and CREATE_EDIT for writes with fresh branch assignment checks", async () => {
    const organization = await prisma.organization.create({
      data: { name: "Read semantics" },
    });
    const manager = await assigned(organization.id, "BRANCH_MANAGER");
    const staff = await assigned(organization.id, "INVENTORY_STAFF");
    const value = await repository.createSupplier({
      actorUserId: manager.id,
      organizationId: organization.id,
      supplier: supplier(),
    });
    if (value.kind !== "success") throw new Error("supplier fixture");
    const permission = vi.spyOn(policy, "can");
    try {
      expect(
        (
          await repository.getSupplier({
            actorUserId: manager.id,
            organizationId: organization.id,
            supplierId: value.supplier.id,
          })
        ).kind,
      ).toBe("success");
      expect(
        (
          await repository.listSuppliers({
            actorUserId: manager.id,
            organizationId: organization.id,
            query: supplierListQuerySchema.parse({}),
          })
        ).kind,
      ).toBe("success");
      expect(permission.mock.calls.map((call) => call[1])).toEqual([
        policy.PERMISSIONS.SUPPLIER_VIEW,
        policy.PERMISSIONS.SUPPLIER_VIEW,
      ]);
      permission.mockClear();
      await repository.updateSupplier({
        actorUserId: manager.id,
        organizationId: organization.id,
        supplierId: value.supplier.id,
        supplier: supplierUpdateRequestSchema.parse({ phone: "03-222" }),
      });
      expect(permission.mock.calls[0]?.[1]).toBe(
        policy.PERMISSIONS.SUPPLIER_CREATE_EDIT,
      );
      expect(
        (
          await repository.listSuppliers({
            actorUserId: staff.id,
            organizationId: organization.id,
            query: supplierListQuerySchema.parse({}),
          })
        ).kind,
      ).toBe("forbidden");
      await prisma.branchAssignment.updateMany({
        where: { userId: manager.id },
        data: { status: "INACTIVE", deactivatedAt: new Date() },
      });
      expect(
        (
          await repository.getSupplier({
            actorUserId: manager.id,
            organizationId: organization.id,
            supplierId: value.supplier.id,
          })
        ).kind,
      ).toBe("forbidden");
    } finally {
      permission.mockRestore();
    }
  });
  it("persists bounded master data, duplicate business fields, lifecycle, and tenant isolation", async () => {
    const organization = await prisma.organization.create({
      data: { name: "One" },
    });
    const other = await prisma.organization.create({ data: { name: "Other" } });
    const owner = await user(organization.id, "OWNER");
    const first = await repository.createSupplier({
      actorUserId: owner.id,
      organizationId: organization.id,
      supplier: supplier(),
    });
    const second = await repository.createSupplier({
      actorUserId: owner.id,
      organizationId: organization.id,
      supplier: supplier(),
    });
    expect(first).toMatchObject({
      kind: "success",
      supplier: {
        name: "Example Supply",
        email: "sales@example.com",
        status: "ACTIVE",
      },
    });
    expect(second).toMatchObject({ kind: "success" });
    if (first.kind !== "success") throw new Error("expected supplier");
    await expect(
      repository.getSupplier({
        actorUserId: owner.id,
        organizationId: other.id,
        supplierId: first.supplier.id,
      }),
    ).resolves.toEqual({ kind: "forbidden" });
    await expect(
      repository.setSupplierLifecycle({
        actorUserId: owner.id,
        organizationId: organization.id,
        supplierId: first.supplier.id,
        status: "INACTIVE",
      }),
    ).resolves.toMatchObject({
      kind: "success",
      supplier: { status: "INACTIVE" },
    });
    await expect(
      repository.setSupplierLifecycle({
        actorUserId: owner.id,
        organizationId: organization.id,
        supplierId: first.supplier.id,
        status: "INACTIVE",
      }),
    ).resolves.toMatchObject({
      kind: "success",
      supplier: { status: "INACTIVE" },
    });
  });
  it("gives managers Supplier access but denies inventory staff, cashiers and manager lifecycle", async () => {
    const organization = await prisma.organization.create({
      data: { name: "One" },
    });
    const manager = await assigned(organization.id, "BRANCH_MANAGER");
    const staff = await assigned(organization.id, "INVENTORY_STAFF");
    const cashier = await user(organization.id, "CASHIER");
    const created = await repository.createSupplier({
      actorUserId: manager.id,
      organizationId: organization.id,
      supplier: supplier(),
    });
    expect(created).toMatchObject({ kind: "success" });
    if (created.kind !== "success") throw new Error("expected supplier");
    await expect(
      repository.updateSupplier({
        actorUserId: staff.id,
        organizationId: organization.id,
        supplierId: created.supplier.id,
        supplier: supplierUpdateRequestSchema.parse({ phone: "03-222" }),
      }),
    ).resolves.toMatchObject({
      kind: "forbidden",
    });
    await expect(
      repository.setSupplierLifecycle({
        actorUserId: manager.id,
        organizationId: organization.id,
        supplierId: created.supplier.id,
        status: "INACTIVE",
      }),
    ).resolves.toEqual({ kind: "forbidden" });
    await expect(
      repository.listSuppliers({
        actorUserId: cashier.id,
        organizationId: organization.id,
        query: supplierListQuerySchema.parse({}),
      }),
    ).resolves.toEqual({ kind: "forbidden" });
  });
  it("uses descending, filter-bound cursors and does not search address", async () => {
    const organization = await prisma.organization.create({
      data: { name: "One" },
    });
    const owner = await user(organization.id, "OWNER");
    for (const name of ["Alpha", "Beta", "Gamma"])
      await repository.createSupplier({
        actorUserId: owner.id,
        organizationId: organization.id,
        supplier: supplierCreateRequestSchema.parse({
          name,
          address: "Needle",
        }),
      });
    const first = await repository.listSuppliers({
      actorUserId: owner.id,
      organizationId: organization.id,
      query: supplierListQuerySchema.parse({ limit: "2" }),
    });
    expect(first.kind).toBe("success");
    if (first.kind === "success")
      expect(first.suppliers[0]?.name).toBe("Gamma");
    if (first.kind !== "success" || first.nextCursor === null)
      throw new Error("cursor expected");
    await expect(
      repository.listSuppliers({
        actorUserId: owner.id,
        organizationId: organization.id,
        query: supplierListQuerySchema.parse({
          cursor: first.nextCursor,
          limit: "2",
          q: "alpha",
        }),
      }),
    ).resolves.toEqual({ kind: "invalid_cursor" });
    await expect(
      repository.listSuppliers({
        actorUserId: owner.id,
        organizationId: organization.id,
        query: supplierListQuerySchema.parse({ q: "needle" }),
      }),
    ).resolves.toMatchObject({ kind: "success", suppliers: [] });
  });
});
