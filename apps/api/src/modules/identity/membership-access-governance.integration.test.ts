import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createRecordingEmailProvider } from "./email-provider.ts";
import { createPrismaMembershipAccessRepository } from "./membership-access-repository.ts";
import { createMembershipAccessService } from "./membership-access-service.ts";
import { secureOneTimeTokenProvider } from "./one-time-token.ts";
import { loadTestDatabaseEnvironment } from "../../test/database-environment.ts";
import {
  createTestPrismaClient,
  resetTestDatabase,
} from "../../test/database-harness.ts";

const environment = loadTestDatabaseEnvironment();
const prisma = createTestPrismaClient(environment);
const NOW = new Date("2026-10-28T10:00:00.000Z");
const PASSWORD_HASH_FIXTURE =
  "$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$c2NoZW1hLXRlc3Q";

type Role =
  "OWNER" | "ADMIN" | "BRANCH_MANAGER" | "INVENTORY_STAFF" | "CASHIER";

async function user(email: string) {
  return prisma.user.create({
    data: {
      displayName: email.split("@")[0]!,
      email,
      emailVerifiedAt: new Date(NOW.getTime() - 1_000),
      passwordHash: PASSWORD_HASH_FIXTURE,
    },
  });
}

async function member(
  organizationId: string,
  email: string,
  role: Role,
  status: "ACTIVE" | "INACTIVE" = "ACTIVE",
) {
  const account = await user(email);
  const row = await prisma.organizationMembership.create({
    data: {
      deactivatedAt: status === "INACTIVE" ? NOW : null,
      organizationId,
      role,
      status,
      userId: account.id,
    },
  });
  return { account, row };
}

function access() {
  const emailProvider = createRecordingEmailProvider();
  return {
    emailProvider,
    value: createMembershipAccessService({
      emailProvider,
      now: () => NOW,
      publicWebOrigin: "https://stockwise.example.test",
      repository: createPrismaMembershipAccessRepository(prisma),
      tokenProvider: secureOneTimeTokenProvider,
    }),
  };
}

describe("membership governance invariants with PostgreSQL", () => {
  beforeEach(async () => {
    await resetTestDatabase(environment);
  });

  afterAll(async () => {
    await resetTestDatabase(environment);
    await prisma.$disconnect();
  });

  it("rejects ADMIN self-demotion, self-deactivation and self-scope change without mutating", async () => {
    const store = await prisma.organization.create({ data: { name: "Store" } });
    await member(store.id, "owner@example.test", "OWNER");
    const admin = await member(store.id, "admin@example.test", "ADMIN");
    const { value } = access();

    await expect(
      value.replaceMembership({
        actorUserId: admin.account.id,
        membershipId: admin.row.id,
        organizationId: store.id,
        replacement: {
          branchIds: [],
          expectedUpdatedAt: admin.row.updatedAt,
          role: "ADMIN",
        },
      }),
    ).resolves.toEqual({ kind: "self_modification" });
    await expect(
      value.deactivateMembership({
        actorUserId: admin.account.id,
        expectedUpdatedAt: admin.row.updatedAt,
        membershipId: admin.row.id,
        organizationId: store.id,
      }),
    ).resolves.toEqual({ kind: "self_modification" });

    const unchanged = await prisma.organizationMembership.findFirstOrThrow({
      where: { id: admin.row.id },
    });
    expect(unchanged).toMatchObject({ role: "ADMIN", status: "ACTIVE" });
    expect(unchanged.updatedAt.getTime()).toBe(admin.row.updatedAt.getTime());
  });

  it("lets a non-last OWNER step down but never the last OWNER, and ADMIN never grants OWNER", async () => {
    const store = await prisma.organization.create({ data: { name: "Store" } });
    const first = await member(store.id, "owner@example.test", "OWNER");
    const second = await member(store.id, "owner2@example.test", "OWNER");
    const admin = await member(store.id, "admin@example.test", "ADMIN");
    const staff = await member(store.id, "staff@example.test", "CASHIER");
    const { value } = access();

    // ADMIN cannot promote anyone to OWNER or touch an OWNER.
    await expect(
      value.replaceMembership({
        actorUserId: admin.account.id,
        membershipId: staff.row.id,
        organizationId: store.id,
        replacement: {
          branchIds: [],
          expectedUpdatedAt: staff.row.updatedAt,
          role: "OWNER",
        },
      }),
    ).resolves.toEqual({ kind: "forbidden" });
    await expect(
      value.deactivateMembership({
        actorUserId: admin.account.id,
        expectedUpdatedAt: first.row.updatedAt,
        membershipId: first.row.id,
        organizationId: store.id,
      }),
    ).resolves.toEqual({ kind: "forbidden" });

    // A non-last OWNER may step down; then the remaining OWNER is protected.
    await expect(
      value.replaceMembership({
        actorUserId: second.account.id,
        membershipId: second.row.id,
        organizationId: store.id,
        replacement: {
          branchIds: [],
          expectedUpdatedAt: second.row.updatedAt,
          role: "ADMIN",
        },
      }),
    ).resolves.toMatchObject({ kind: "success" });
    const reloaded = await prisma.organizationMembership.findFirstOrThrow({
      where: { id: first.row.id },
    });
    await expect(
      value.replaceMembership({
        actorUserId: first.account.id,
        membershipId: first.row.id,
        organizationId: store.id,
        replacement: {
          branchIds: [],
          expectedUpdatedAt: reloaded.updatedAt,
          role: "ADMIN",
        },
      }),
    ).resolves.toEqual({ kind: "last_active_owner" });
    await expect(
      value.deactivateMembership({
        actorUserId: first.account.id,
        expectedUpdatedAt: reloaded.updatedAt,
        membershipId: first.row.id,
        organizationId: store.id,
      }),
    ).resolves.toEqual({ kind: "last_active_owner" });
  });

  it("reports a removed member distinctly, sends no mail, and never restores access from an old invitation", async () => {
    const store = await prisma.organization.create({ data: { name: "Store" } });
    const main = await prisma.branch.create({
      data: { code: "MAIN", name: "Main", organizationId: store.id },
    });
    const owner = await member(store.id, "owner@example.test", "OWNER");
    const removed = await member(store.id, "removed@example.test", "CASHIER");
    await prisma.branchAssignment.create({
      data: {
        branchId: main.id,
        organizationId: store.id,
        userId: removed.account.id,
      },
    });
    const { emailProvider, value } = access();

    // Active member: generic exists outcome.
    await expect(
      value.createInvitation({
        actorUserId: owner.account.id,
        invitation: {
          branchIds: [main.id],
          email: "removed@example.test",
          role: "CASHIER",
        },
        organizationId: store.id,
      }),
    ).resolves.toEqual({ kind: "membership_exists", status: "ACTIVE" });

    await expect(
      value.deactivateMembership({
        actorUserId: owner.account.id,
        expectedUpdatedAt: removed.row.updatedAt,
        membershipId: removed.row.id,
        organizationId: store.id,
      }),
    ).resolves.toMatchObject({ kind: "success" });

    // Removed member: a distinct outcome pointing to Reactivate, and no email.
    await expect(
      value.createInvitation({
        actorUserId: owner.account.id,
        invitation: {
          branchIds: [main.id],
          email: "removed@example.test",
          role: "CASHIER",
        },
        organizationId: store.id,
      }),
    ).resolves.toEqual({ kind: "membership_exists", status: "INACTIVE" });
    expect(emailProvider.messages).toHaveLength(0);
    expect(
      await prisma.invitation.count({
        where: { invitedEmail: "removed@example.test" },
      }),
    ).toBe(0);

    // Reactivation restores exactly one membership with the replaced scope.
    const inactive = await prisma.organizationMembership.findFirstOrThrow({
      where: { id: removed.row.id },
    });
    await expect(
      value.reactivateMembership({
        actorUserId: owner.account.id,
        membershipId: removed.row.id,
        organizationId: store.id,
        replacement: {
          branchIds: [main.id],
          expectedUpdatedAt: inactive.updatedAt,
          role: "CASHIER",
        },
      }),
    ).resolves.toMatchObject({ kind: "success" });
    expect(
      await prisma.organizationMembership.count({
        where: { organizationId: store.id, userId: removed.account.id },
      }),
    ).toBe(1);
  });
});
