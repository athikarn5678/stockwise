import { withTriggersDisabled } from "../test/trigger-bypass.ts";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  createTestPrismaClient,
  resetTestDatabase,
} from "../test/database-harness.ts";
import { loadTestDatabaseEnvironment } from "../test/database-environment.ts";

const environment = loadTestDatabaseEnvironment();
const prisma = createTestPrismaClient(environment);

const PASSWORD_HASH_FIXTURE =
  "$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$c2NoZW1hLXRlc3Q";

function futureHours(hours: number): Date {
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}
async function createUser(email: string, displayName = "Schema Test User") {
  return prisma.user.create({
    data: {
      email,
      passwordHash: PASSWORD_HASH_FIXTURE,
      displayName,
    },
  });
}

async function createOrganization(name: string) {
  return prisma.organization.create({ data: { name } });
}

async function createBranch(organizationId: string, code: string) {
  return prisma.branch.create({
    data: {
      organizationId,
      code,
      name: `${code} Branch`,
    },
  });
}

async function createOwnerMembership(organizationId: string, label: string) {
  const user = await createUser(`${label}@example.com`);
  return prisma.organizationMembership.create({
    data: { organizationId, role: "OWNER", userId: user.id },
  });
}

describe("identity and tenancy database schema", () => {
  beforeEach(async () => {
    await resetTestDatabase(environment);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await resetTestDatabase(environment);
  });

  it("persists one required Organization reporting timezone and no Branch timezone", async () => {
    const organization = await createOrganization("Reporting Timezone");
    const organizationColumns = await prisma.$queryRaw<
      { columnName: string; columnDefault: string | null; nullable: string }[]
    >`
      SELECT
        column_name AS "columnName",
        column_default AS "columnDefault",
        is_nullable AS "nullable"
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'organizations'
        AND column_name = 'reporting_timezone'
    `;
    const branchColumns = await prisma.$queryRaw<{ columnName: string }[]>`
      SELECT column_name AS "columnName"
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'branches'
        AND column_name = 'reporting_timezone'
    `;

    expect(organization.reportingTimezone).toBe("Asia/Bangkok");
    expect(organizationColumns).toEqual([
      {
        columnDefault: "'Asia/Bangkok'::character varying",
        columnName: "reporting_timezone",
        nullable: "NO",
      },
    ]);
    expect(branchColumns).toEqual([]);
  });

  it("creates tenant-safe multi-organization and multi-branch relationships", async () => {
    const user = await createUser("multi-scope@example.com");
    const firstOrganization = await createOrganization("First Organization");
    const secondOrganization = await createOrganization("Second Organization");
    const firstBranch = await createBranch(firstOrganization.id, "FIRST");
    const secondBranch = await createBranch(firstOrganization.id, "SECOND");

    await prisma.organizationMembership.createMany({
      data: [
        {
          organizationId: firstOrganization.id,
          userId: user.id,
          role: "BRANCH_MANAGER",
        },
        {
          organizationId: secondOrganization.id,
          userId: user.id,
          role: "ADMIN",
        },
      ],
    });
    await prisma.branchAssignment.createMany({
      data: [
        {
          organizationId: firstOrganization.id,
          userId: user.id,
          branchId: firstBranch.id,
        },
        {
          organizationId: firstOrganization.id,
          userId: user.id,
          branchId: secondBranch.id,
        },
      ],
    });

    expect(
      await prisma.organizationMembership.count({ where: { userId: user.id } }),
    ).toBe(2);
    expect(
      await prisma.branchAssignment.count({ where: { userId: user.id } }),
    ).toBe(2);
  });

  it("enforces canonical globally unique user email storage", async () => {
    await createUser("unique@example.com");

    await expect(
      createUser("unique@example.com", "Duplicate User"),
    ).rejects.toThrow();
    await expect(
      createUser(" Unique@Example.com ", "Unnormalized User"),
    ).rejects.toThrow();
  });

  it("allows a registration-stage user without a display name and validates present values", async () => {
    const registrationStageUser = await prisma.user.create({
      data: {
        email: "registration-stage@example.com",
        passwordHash: PASSWORD_HASH_FIXTURE,
        displayName: null,
      },
    });
    const profiledUser = await createUser(
      "profiled-user@example.com",
      "Profiled User",
    );

    expect(registrationStageUser.displayName).toBeNull();
    expect(profiledUser.displayName).toBe("Profiled User");
    await expect(
      createUser("blank-display-name@example.com", "   "),
    ).rejects.toThrow();
  });

  it("rejects duplicate organization memberships", async () => {
    const user = await createUser("member@example.com");
    const organization = await createOrganization("Membership Organization");

    await prisma.organizationMembership.create({
      data: {
        organizationId: organization.id,
        userId: user.id,
        role: "CASHIER",
      },
    });

    await expect(
      prisma.organizationMembership.create({
        data: {
          organizationId: organization.id,
          userId: user.id,
          role: "ADMIN",
        },
      }),
    ).rejects.toThrow();
  });

  it("allows organization-wide roles without branch assignments", async () => {
    const owner = await createUser("owner@example.com", "Owner");
    const admin = await createUser("admin@example.com", "Admin");
    const organization = await createOrganization("Organization-wide Roles");
    await createBranch(organization.id, "MAIN");

    await prisma.organizationMembership.createMany({
      data: [
        { organizationId: organization.id, userId: owner.id, role: "OWNER" },
        { organizationId: organization.id, userId: admin.id, role: "ADMIN" },
      ],
    });

    expect(
      await prisma.organizationMembership.count({
        where: { organizationId: organization.id, status: "ACTIVE" },
      }),
    ).toBe(2);
    expect(
      await prisma.branchAssignment.count({
        where: { organizationId: organization.id },
      }),
    ).toBe(0);
  });

  it("enforces one tenant-safe first-onboarding provenance row per user", async () => {
    const firstUser = await createUser("first-onboarding@example.com");
    const secondUser = await createUser("second-onboarding@example.com");
    const firstOrganization = await createOrganization(
      "First Onboarding Organization",
    );
    const secondOrganization = await createOrganization(
      "Second Onboarding Organization",
    );
    const firstBranch = await createBranch(firstOrganization.id, "MAIN");
    const secondBranch = await createBranch(secondOrganization.id, "MAIN");
    await prisma.organizationMembership.createMany({
      data: [
        {
          organizationId: firstOrganization.id,
          role: "OWNER",
          userId: firstUser.id,
        },
        {
          organizationId: secondOrganization.id,
          role: "OWNER",
          userId: secondUser.id,
        },
        {
          organizationId: secondOrganization.id,
          role: "ADMIN",
          userId: firstUser.id,
        },
        {
          organizationId: firstOrganization.id,
          role: "ADMIN",
          userId: secondUser.id,
        },
      ],
    });

    await prisma.firstOrganizationOnboarding.create({
      data: {
        branchId: firstBranch.id,
        organizationId: firstOrganization.id,
        requestHash: "a".repeat(64),
        userId: firstUser.id,
      },
    });

    await expect(
      prisma.firstOrganizationOnboarding.create({
        data: {
          branchId: secondBranch.id,
          organizationId: secondOrganization.id,
          requestHash: "b".repeat(64),
          userId: firstUser.id,
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.firstOrganizationOnboarding.create({
        data: {
          branchId: firstBranch.id,
          organizationId: firstOrganization.id,
          requestHash: "b".repeat(64),
          userId: secondUser.id,
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.firstOrganizationOnboarding.create({
        data: {
          branchId: secondBranch.id,
          organizationId: firstOrganization.id,
          requestHash: "c".repeat(64),
          userId: secondUser.id,
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.firstOrganizationOnboarding.create({
        data: {
          branchId: secondBranch.id,
          organizationId: secondOrganization.id,
          requestHash: "not-a-sha-256-hash",
          userId: secondUser.id,
        },
      }),
    ).rejects.toThrow();
  });

  it("rejects duplicate and cross-organization branch assignments", async () => {
    const user = await createUser("branch-user@example.com");
    const firstOrganization = await createOrganization(
      "Assignment Organization A",
    );
    const secondOrganization = await createOrganization(
      "Assignment Organization B",
    );
    const firstBranch = await createBranch(firstOrganization.id, "A");
    const secondBranch = await createBranch(secondOrganization.id, "B");

    await prisma.organizationMembership.create({
      data: {
        organizationId: firstOrganization.id,
        userId: user.id,
        role: "INVENTORY_STAFF",
      },
    });
    await prisma.branchAssignment.create({
      data: {
        organizationId: firstOrganization.id,
        userId: user.id,
        branchId: firstBranch.id,
      },
    });

    await expect(
      prisma.branchAssignment.create({
        data: {
          organizationId: firstOrganization.id,
          userId: user.id,
          branchId: firstBranch.id,
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.branchAssignment.create({
        data: {
          organizationId: firstOrganization.id,
          userId: user.id,
          branchId: secondBranch.id,
        },
      }),
    ).rejects.toThrow();
  });

  it("rejects cross-organization invitation branch scope", async () => {
    const firstOrganization = await createOrganization(
      "Invitation Organization A",
    );
    const secondOrganization = await createOrganization(
      "Invitation Organization B",
    );
    const validBranch = await createBranch(firstOrganization.id, "A");
    const crossTenantBranch = await createBranch(secondOrganization.id, "B");
    const issuer = await createOwnerMembership(
      firstOrganization.id,
      "invitation-scope-issuer",
    );
    const invitation = await prisma.invitation.create({
      data: {
        issuedByMembershipId: issuer.id,
        organizationId: firstOrganization.id,
        invitedEmail: "invitee@example.com",
        intendedRole: "BRANCH_MANAGER",
        tokenHash: "invitation-hash-a",
        expiresAt: futureHours(7 * 24),
      },
    });

    await prisma.invitationBranchScope.create({
      data: {
        organizationId: firstOrganization.id,
        invitationId: invitation.id,
        branchId: validBranch.id,
      },
    });
    await expect(
      prisma.invitationBranchScope.create({
        data: {
          organizationId: firstOrganization.id,
          invitationId: invitation.id,
          branchId: crossTenantBranch.id,
        },
      }),
    ).rejects.toThrow();
  });

  it("binds invitation acceptance to the invited normalized email", async () => {
    const organization = await createOrganization("Email-bound Invitation");
    const wrongUser = await createUser("other-user@example.com");
    const invitedUser = await createUser("invited-user@example.com");
    const issuer = await createOwnerMembership(
      organization.id,
      "email-bound-issuer",
    );
    const invitation = await prisma.invitation.create({
      data: {
        issuedByMembershipId: issuer.id,
        organizationId: organization.id,
        invitedEmail: invitedUser.email,
        intendedRole: "CASHIER",
        tokenHash: "email-bound-invitation-hash",
        expiresAt: futureHours(7 * 24),
      },
    });

    await expect(
      prisma.invitation.update({
        where: { id: invitation.id },
        data: { acceptedByUserId: wrongUser.id, consumedAt: new Date() },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.invitation.update({
        where: { id: invitation.id },
        data: { acceptedByUserId: invitedUser.id, consumedAt: new Date() },
      }),
    ).resolves.toMatchObject({ acceptedByUserId: invitedUser.id });
  });

  it("rejects cross-organization membership-access provenance", async () => {
    const firstOrganization = await createOrganization("Provenance A");
    const secondOrganization = await createOrganization("Provenance B");
    const firstBranch = await createBranch(firstOrganization.id, "A");
    const secondBranch = await createBranch(secondOrganization.id, "B");
    const firstOwner = await createOwnerMembership(
      firstOrganization.id,
      "provenance-owner-a",
    );
    const secondOwner = await createOwnerMembership(
      secondOrganization.id,
      "provenance-owner-b",
    );

    await expect(
      prisma.invitation.create({
        data: {
          expiresAt: futureHours(7 * 24),
          intendedRole: "ADMIN",
          invitedEmail: "cross-issuer@example.com",
          issuedByMembershipId: secondOwner.id,
          organizationId: firstOrganization.id,
          tokenHash: "cross-issuer-hash",
        },
      }),
    ).rejects.toThrow();

    const invitation = await prisma.invitation.create({
      data: {
        expiresAt: futureHours(7 * 24),
        intendedRole: "CASHIER",
        invitedEmail: "provenance-invitee@example.com",
        issuedByMembershipId: firstOwner.id,
        organizationId: firstOrganization.id,
        tokenHash: "provenance-invitation-hash",
      },
    });
    await expect(
      prisma.invitation.update({
        data: {
          revocationReason: "CANCELLED",
          revokedAt: new Date(),
          revokedByMembershipId: secondOwner.id,
        },
        where: { id: invitation.id },
      }),
    ).rejects.toThrow();

    const invitedUser = await createUser("provenance-invitee@example.com");
    await expect(
      prisma.organizationMembership.create({
        data: {
          organizationId: secondOrganization.id,
          role: "CASHIER",
          sourceInvitationId: invitation.id,
          userId: invitedUser.id,
        },
      }),
    ).rejects.toThrow();

    const event = await prisma.membershipAccessEvent.create({
      data: {
        actorMembershipId: firstOwner.id,
        actorUserId: firstOwner.userId,
        afterRole: "OWNER",
        afterStatus: "ACTIVE",
        beforeRole: "OWNER",
        beforeStatus: "ACTIVE",
        eventType: "ROLE_SCOPE_REPLACED",
        organizationId: firstOrganization.id,
        targetMembershipId: firstOwner.id,
      },
    });
    await expect(
      prisma.membershipAccessEvent.create({
        data: {
          actorMembershipId: firstOwner.id,
          actorUserId: firstOwner.userId,
          afterRole: "OWNER",
          afterStatus: "ACTIVE",
          eventType: "ROLE_SCOPE_REPLACED",
          organizationId: firstOrganization.id,
          targetMembershipId: secondOwner.id,
        },
      }),
    ).rejects.toThrow();
    await prisma.membershipAccessEventBranchScope.create({
      data: {
        branchId: firstBranch.id,
        eventId: event.id,
        organizationId: firstOrganization.id,
      },
    });
    await expect(
      prisma.membershipAccessEvent.update({
        data: { afterStatus: "INACTIVE" },
        where: { id: event.id },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.membershipAccessEventBranchScope.delete({
        where: {
          organizationId_eventId_branchId: {
            branchId: firstBranch.id,
            eventId: event.id,
            organizationId: firstOrganization.id,
          },
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.membershipAccessEventBranchScope.create({
        data: {
          branchId: secondBranch.id,
          eventId: event.id,
          organizationId: firstOrganization.id,
        },
      }),
    ).rejects.toThrow();
  });

  it("enforces one-time reset token hash uniqueness", async () => {
    const user = await createUser("tokens@example.com");
    const secondUser = await createUser("tokens-two@example.com");

    // The Native trigger would refuse these inserts first; run them without
    // triggers so the unique index is what is under test.
    await withTriggersDisabled(prisma, (tx) =>
      tx.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: "reset-hash",
          expiresAt: futureHours(0.5),
        },
      }),
    );
    await expect(
      withTriggersDisabled(prisma, (tx) =>
        tx.passwordResetToken.create({
          data: {
            userId: secondUser.id,
            tokenHash: "reset-hash",
            expiresAt: futureHours(0.5),
          },
        }),
      ),
    ).rejects.toThrow(/Unique constraint|duplicate key/);
  });

  it("rejects invalid one-time-token time ordering", async () => {
    const user = await createUser("time-ordering@example.com");
    const issuedAt = new Date();

    await expect(
      withTriggersDisabled(prisma, (tx) =>
        tx.passwordResetToken.create({
          data: {
            userId: user.id,
            tokenHash: "invalid-reset-time-order",
            issuedAt,
            expiresAt: futureHours(0.5),
            consumedAt: futureHours(1),
          },
        }),
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it("represents verification and invitation replacement without deleting history", async () => {
    const user = await createUser("replacement@example.com");
    const organization = await createOrganization("Replacement Organization");
    const issuer = await createOwnerMembership(
      organization.id,
      "replacement-issuer",
    );
    const invitation = await prisma.invitation.create({
      data: {
        issuedByMembershipId: issuer.id,
        organizationId: organization.id,
        invitedEmail: user.email,
        intendedRole: "CASHIER",
        tokenHash: "invitation-original",
        expiresAt: futureHours(7 * 24),
      },
    });

    await expect(
      prisma.invitation.create({
        data: {
          issuedByMembershipId: issuer.id,
          organizationId: organization.id,
          invitedEmail: user.email,
          intendedRole: "BRANCH_MANAGER",
          tokenHash: "invitation-overlap",
          expiresAt: futureHours(7 * 24),
        },
      }),
    ).rejects.toThrow();

    const replacedAt = new Date();
    await prisma.invitation.update({
      where: { id: invitation.id },
      data: {
        replacedAt,
        revocationReason: "REPLACED",
        revokedByMembershipId: issuer.id,
      },
    });
    await expect(
      prisma.invitation.create({
        data: {
          issuedByMembershipId: issuer.id,
          organizationId: organization.id,
          invitedEmail: user.email,
          intendedRole: "BRANCH_MANAGER",
          tokenHash: "invitation-replacement",
          expiresAt: futureHours(7 * 24),
        },
      }),
    ).resolves.toBeDefined();
  });

  it("restricts hard deletion of referenced identity and tenancy records", async () => {
    const user = await createUser("history@example.com");
    const organization = await createOrganization("History Organization");
    const branch = await createBranch(organization.id, "HISTORY");
    await prisma.organizationMembership.create({
      data: {
        organizationId: organization.id,
        userId: user.id,
        role: "CASHIER",
      },
    });
    await prisma.branchAssignment.create({
      data: {
        organizationId: organization.id,
        userId: user.id,
        branchId: branch.id,
      },
    });

    await expect(
      prisma.user.delete({ where: { id: user.id } }),
    ).rejects.toThrow(/user deletion is not permitted/);
    await expect(
      prisma.organization.delete({ where: { id: organization.id } }),
    ).rejects.toThrow();
    await expect(
      prisma.branch.delete({ where: { id: branch.id } }),
    ).rejects.toThrow();
  });
});
