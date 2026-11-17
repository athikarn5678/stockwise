import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  createTestPrismaClient,
  resetTestDatabase,
} from "../../test/database-harness.ts";
import { loadTestDatabaseEnvironment } from "../../test/database-environment.ts";
import { createPrismaAnalyticsScopeRepository } from "./analytics-scope-repository.ts";

const environment = loadTestDatabaseEnvironment();
const prisma = createTestPrismaClient(environment);
const repository = createPrismaAnalyticsScopeRepository(prisma);
async function createActor(input: {
  assignedBranchIds?: readonly string[];
  organizationId: string;
  role: "OWNER" | "ADMIN" | "BRANCH_MANAGER" | "INVENTORY_STAFF" | "CASHIER";
}) {
  const user = await prisma.user.create({
    data: {
      displayName: `${input.role} Analytics Actor`,
      email: `${input.role.toLowerCase()}-${crypto.randomUUID()}@example.com`,
      emailVerifiedAt: new Date(),
    },
  });
  await prisma.organizationMembership.create({
    data: {
      organizationId: input.organizationId,
      role: input.role,
      userId: user.id,
    },
  });
  if ((input.assignedBranchIds?.length ?? 0) > 0) {
    await prisma.branchAssignment.createMany({
      data:
        input.assignedBranchIds?.map((branchId) => ({
          branchId,
          organizationId: input.organizationId,
          userId: user.id,
        })) ?? [],
    });
  }

  return user;
}

describe("Prisma analytics scope repository", () => {
  beforeEach(async () => {
    await resetTestDatabase(environment);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await resetTestDatabase(environment);
  });

  it("loads persisted timezone and includes inactive history for an Organization-wide actor", async () => {
    const organization = await prisma.organization.create({
      data: { name: "Owner Analytics", reportingTimezone: "America/New_York" },
    });
    const [active, inactive] = await Promise.all([
      prisma.branch.create({
        data: {
          code: "ACTIVE",
          name: "Active",
          organizationId: organization.id,
        },
      }),
      prisma.branch.create({
        data: {
          code: "INACTIVE",
          deactivatedAt: new Date(),
          name: "Inactive",
          organizationId: organization.id,
          status: "INACTIVE",
        },
      }),
    ]);
    const owner = await createActor({
      organizationId: organization.id,
      role: "OWNER",
    });

    const outcome = await repository.resolve({
      actorUserId: owner.id,
      analyticsKind: "business",
      candidate: { kind: "organization" },
      organizationId: organization.id,
    });

    expect(outcome).toEqual({
      kind: "success",
      reportingTimezone: "America/New_York",
      scope: {
        branchCount: 2,
        branchIds: [active.id, inactive.id].sort(),
        canViewCost: true,
        kind: "organization",
        organizationId: organization.id,
      },
    });
  });

  it("intersects a Branch Manager with current active assignments", async () => {
    const organization = await prisma.organization.create({
      data: { name: "Manager Analytics" },
    });
    const active = await prisma.branch.create({
      data: { code: "ACTIVE", name: "Active", organizationId: organization.id },
    });
    const unassigned = await prisma.branch.create({
      data: { code: "OTHER", name: "Other", organizationId: organization.id },
    });
    const inactive = await prisma.branch.create({
      data: {
        code: "INACTIVE",
        deactivatedAt: new Date(),
        name: "Inactive",
        organizationId: organization.id,
        status: "INACTIVE",
      },
    });
    const manager = await createActor({
      assignedBranchIds: [active.id, inactive.id],
      organizationId: organization.id,
      role: "BRANCH_MANAGER",
    });

    await expect(
      repository.resolve({
        actorUserId: manager.id,
        analyticsKind: "business",
        candidate: { kind: "organization" },
        organizationId: organization.id,
      }),
    ).resolves.toMatchObject({
      kind: "success",
      scope: { branchIds: [active.id], canViewCost: true },
    });
    await expect(
      repository.resolve({
        actorUserId: manager.id,
        analyticsKind: "business",
        candidate: { branchId: unassigned.id, kind: "branch" },
        organizationId: organization.id,
      }),
    ).resolves.toEqual({ kind: "forbidden" });
  });

  it("keeps inventory staff non-cost and denies Cashier analytics", async () => {
    const organization = await prisma.organization.create({
      data: { name: "Role Analytics" },
    });
    const branch = await prisma.branch.create({
      data: { code: "MAIN", name: "Main", organizationId: organization.id },
    });
    const staff = await createActor({
      assignedBranchIds: [branch.id],
      organizationId: organization.id,
      role: "INVENTORY_STAFF",
    });
    const cashier = await createActor({
      assignedBranchIds: [branch.id],
      organizationId: organization.id,
      role: "CASHIER",
    });

    await expect(
      repository.resolve({
        actorUserId: staff.id,
        analyticsKind: "inventory",
        candidate: { kind: "organization" },
        organizationId: organization.id,
      }),
    ).resolves.toMatchObject({
      kind: "success",
      scope: { branchIds: [branch.id], canViewCost: false },
    });
    await expect(
      repository.resolve({
        actorUserId: staff.id,
        analyticsKind: "business",
        candidate: { kind: "organization" },
        organizationId: organization.id,
      }),
    ).resolves.toEqual({ kind: "forbidden" });
    await expect(
      repository.resolve({
        actorUserId: cashier.id,
        analyticsKind: "inventory",
        candidate: { kind: "organization" },
        organizationId: organization.id,
      }),
    ).resolves.toEqual({ kind: "forbidden" });
  });

  it("rejects cross-tenant Branch candidates and missing assignments without disclosure", async () => {
    const organization = await prisma.organization.create({
      data: { name: "Scoped Analytics" },
    });
    const otherOrganization = await prisma.organization.create({
      data: { name: "Other Analytics" },
    });
    const localBranch = await prisma.branch.create({
      data: { code: "LOCAL", name: "Local", organizationId: organization.id },
    });
    const crossTenantBranch = await prisma.branch.create({
      data: {
        code: "OTHER",
        name: "Other",
        organizationId: otherOrganization.id,
      },
    });
    const manager = await createActor({
      assignedBranchIds: [localBranch.id],
      organizationId: organization.id,
      role: "BRANCH_MANAGER",
    });
    const noScopeManager = await createActor({
      organizationId: organization.id,
      role: "BRANCH_MANAGER",
    });

    await expect(
      repository.resolve({
        actorUserId: manager.id,
        analyticsKind: "business",
        candidate: { branchId: crossTenantBranch.id, kind: "branch" },
        organizationId: organization.id,
      }),
    ).resolves.toEqual({ kind: "forbidden" });
    await expect(
      repository.resolve({
        actorUserId: noScopeManager.id,
        analyticsKind: "business",
        candidate: { kind: "organization" },
        organizationId: organization.id,
      }),
    ).resolves.toEqual({ kind: "forbidden" });
  });

  it("surfaces an invalid persisted timezone instead of falling back", async () => {
    const organization = await prisma.organization.create({
      data: { name: "Invalid Timezone" },
    });
    const branch = await prisma.branch.create({
      data: { code: "MAIN", name: "Main", organizationId: organization.id },
    });
    const owner = await createActor({
      organizationId: organization.id,
      role: "OWNER",
    });
    await prisma.$executeRaw`
      UPDATE "organizations"
      SET "reporting_timezone" = 'Mars/Olympus'
      WHERE "id" = ${organization.id}::uuid
    `;

    await expect(
      repository.resolve({
        actorUserId: owner.id,
        analyticsKind: "business",
        candidate: { branchId: branch.id, kind: "branch" },
        organizationId: organization.id,
      }),
    ).resolves.toEqual({ kind: "invalid_reporting_timezone" });
  });
});
