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
  branchId?: string,
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
  if (branchId !== undefined) {
    await prisma.branchAssignment.create({
      data: { branchId, organizationId, userId: account.id },
    });
  }
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

async function fixture() {
  const store = await prisma.organization.create({ data: { name: "Store" } });
  const main = await prisma.branch.create({
    data: { code: "MAIN", name: "Main", organizationId: store.id },
  });
  return { main, store };
}

function replacement(
  row: { updatedAt: Date },
  role: Role,
  branchIds: string[] = [],
) {
  return { branchIds, expectedUpdatedAt: row.updatedAt, role };
}

async function ownerCount(organizationId: string) {
  return prisma.organizationMembership.count({
    where: { organizationId, role: "OWNER", status: "ACTIVE" },
  });
}

describe("membership governance invariants with PostgreSQL", () => {
  beforeEach(async () => {
    await resetTestDatabase(environment);
  });

  afterAll(async () => {
    await resetTestDatabase(environment);
    await prisma.$disconnect();
  });

  it("rejects ADMIN and OWNER self-demotion, self-deactivation and self-scope change without mutating", async () => {
    const { store } = await fixture();
    const owner = await member(store.id, "owner@example.test", "OWNER");
    const admin = await member(store.id, "admin@example.test", "ADMIN");
    const { value } = access();

    for (const self of [admin, owner]) {
      for (const role of ["ADMIN", "CASHIER"] as const) {
        await expect(
          value.replaceMembership({
            actorUserId: self.account.id,
            membershipId: self.row.id,
            organizationId: store.id,
            replacement: replacement(self.row, role),
          }),
        ).resolves.toEqual({ kind: "self_modification" });
      }
      await expect(
        value.deactivateMembership({
          actorUserId: self.account.id,
          expectedUpdatedAt: self.row.updatedAt,
          membershipId: self.row.id,
          organizationId: store.id,
        }),
      ).resolves.toEqual({ kind: "self_modification" });
      const unchanged = await prisma.organizationMembership.findFirstOrThrow({
        where: { id: self.row.id },
      });
      expect(unchanged).toMatchObject({
        role: self.row.role,
        status: "ACTIVE",
      });
      expect(unchanged.updatedAt.getTime()).toBe(self.row.updatedAt.getTime());
    }
    expect(await prisma.membershipAccessEvent.count()).toBe(0);
  });

  it("never lets any actor create, promote to, or reactivate an OWNER, and never touches the OWNER", async () => {
    const { main, store } = await fixture();
    const owner = await member(store.id, "owner@example.test", "OWNER");
    const admin = await member(store.id, "admin@example.test", "ADMIN");
    const staff = await member(
      store.id,
      "staff@example.test",
      "CASHIER",
      "ACTIVE",
      main.id,
    );
    const former = await member(
      store.id,
      "former@example.test",
      "CASHIER",
      "INACTIVE",
    );
    const { emailProvider, value } = access();

    for (const actor of [admin, owner]) {
      // Promotion to OWNER.
      await expect(
        value.replaceMembership({
          actorUserId: actor.account.id,
          membershipId: staff.row.id,
          organizationId: store.id,
          replacement: replacement(staff.row, "OWNER"),
        }),
      ).resolves.toEqual({ kind: "forbidden" });
      // Reactivation as OWNER.
      await expect(
        value.reactivateMembership({
          actorUserId: actor.account.id,
          membershipId: former.row.id,
          organizationId: store.id,
          replacement: replacement(former.row, "OWNER"),
        }),
      ).resolves.toEqual({ kind: "forbidden" });
      // Invitation as OWNER.
      await expect(
        value.createInvitation({
          actorUserId: actor.account.id,
          invitation: {
            branchIds: [],
            email: "new-owner@example.test",
            role: "OWNER",
          },
          organizationId: store.id,
        }),
      ).resolves.toEqual({ kind: "forbidden" });
    }
    // Nobody can modify the OWNER: ADMIN is lower, and the OWNER is not self.
    await expect(
      value.deactivateMembership({
        actorUserId: admin.account.id,
        expectedUpdatedAt: owner.row.updatedAt,
        membershipId: owner.row.id,
        organizationId: store.id,
      }),
    ).resolves.toEqual({ kind: "forbidden" });
    await expect(
      value.replaceMembership({
        actorUserId: admin.account.id,
        membershipId: owner.row.id,
        organizationId: store.id,
        replacement: replacement(owner.row, "ADMIN"),
      }),
    ).resolves.toEqual({ kind: "forbidden" });

    expect(await ownerCount(store.id)).toBe(1);
    expect(emailProvider.messages).toHaveLength(0);
    expect(await prisma.invitation.count()).toBe(0);
    expect(await prisma.membershipAccessEvent.count()).toBe(0);
  });

  it("enforces ADMIN-over-lower-roles only: no equal-role changes and no assignment of ADMIN", async () => {
    const { main, store } = await fixture();
    await member(store.id, "owner@example.test", "OWNER");
    const admin = await member(store.id, "admin@example.test", "ADMIN");
    const peer = await member(store.id, "peer@example.test", "ADMIN");
    const manager = await member(
      store.id,
      "manager@example.test",
      "BRANCH_MANAGER",
      "ACTIVE",
      main.id,
    );
    const cashier = await member(
      store.id,
      "cashier@example.test",
      "CASHIER",
      "ACTIVE",
      main.id,
    );
    const { value } = access();

    // Equal role: neither edit, demotion nor removal.
    await expect(
      value.replaceMembership({
        actorUserId: admin.account.id,
        membershipId: peer.row.id,
        organizationId: store.id,
        replacement: replacement(peer.row, "CASHIER", [main.id]),
      }),
    ).resolves.toEqual({ kind: "forbidden" });
    await expect(
      value.deactivateMembership({
        actorUserId: admin.account.id,
        expectedUpdatedAt: peer.row.updatedAt,
        membershipId: peer.row.id,
        organizationId: store.id,
      }),
    ).resolves.toEqual({ kind: "forbidden" });
    // Upward escalation to ADMIN, by promotion and by invitation.
    await expect(
      value.replaceMembership({
        actorUserId: admin.account.id,
        membershipId: cashier.row.id,
        organizationId: store.id,
        replacement: replacement(cashier.row, "ADMIN"),
      }),
    ).resolves.toEqual({ kind: "forbidden" });
    await expect(
      value.createInvitation({
        actorUserId: admin.account.id,
        invitation: { branchIds: [], email: "x@example.test", role: "ADMIN" },
        organizationId: store.id,
      }),
    ).resolves.toEqual({ kind: "forbidden" });

    // Permitted lower-role operations still work.
    await expect(
      value.replaceMembership({
        actorUserId: admin.account.id,
        membershipId: cashier.row.id,
        organizationId: store.id,
        replacement: replacement(cashier.row, "BRANCH_MANAGER", [main.id]),
      }),
    ).resolves.toMatchObject({
      kind: "success",
      membership: { role: "BRANCH_MANAGER" },
    });
    await expect(
      value.createInvitation({
        actorUserId: admin.account.id,
        invitation: {
          branchIds: [main.id],
          email: "newhire@example.test",
          role: "INVENTORY_STAFF",
        },
        organizationId: store.id,
      }),
    ).resolves.toMatchObject({ kind: "success" });
    await expect(
      value.deactivateMembership({
        actorUserId: admin.account.id,
        expectedUpdatedAt: manager.row.updatedAt,
        membershipId: manager.row.id,
        organizationId: store.id,
      }),
    ).resolves.toMatchObject({
      kind: "success",
      membership: { status: "INACTIVE" },
    });
    await expect(
      value.reactivateMembership({
        actorUserId: admin.account.id,
        membershipId: manager.row.id,
        organizationId: store.id,
        replacement: replacement(
          await prisma.organizationMembership.findFirstOrThrow({
            where: { id: manager.row.id },
          }),
          "INVENTORY_STAFF",
          [main.id],
        ),
      }),
    ).resolves.toMatchObject({
      kind: "success",
      membership: { role: "INVENTORY_STAFF", status: "ACTIVE" },
    });
  });

  it("lets the OWNER manage every lower role, including ADMIN, and nothing above", async () => {
    const { main, store } = await fixture();
    const owner = await member(store.id, "owner@example.test", "OWNER");
    const admin = await member(store.id, "admin@example.test", "ADMIN");
    const { value } = access();

    await expect(
      value.replaceMembership({
        actorUserId: owner.account.id,
        membershipId: admin.row.id,
        organizationId: store.id,
        replacement: replacement(admin.row, "BRANCH_MANAGER", [main.id]),
      }),
    ).resolves.toMatchObject({
      kind: "success",
      membership: { role: "BRANCH_MANAGER" },
    });
    const demoted = await prisma.organizationMembership.findFirstOrThrow({
      where: { id: admin.row.id },
    });
    await expect(
      value.replaceMembership({
        actorUserId: owner.account.id,
        membershipId: admin.row.id,
        organizationId: store.id,
        replacement: replacement(demoted, "ADMIN"),
      }),
    ).resolves.toMatchObject({
      kind: "success",
      membership: { role: "ADMIN" },
    });
    await expect(
      value.createInvitation({
        actorUserId: owner.account.id,
        invitation: { branchIds: [], email: "a2@example.test", role: "ADMIN" },
        organizationId: store.id,
      }),
    ).resolves.toMatchObject({ kind: "success" });
  });

  it("denies member management to BRANCH_MANAGER, INVENTORY_STAFF and CASHIER", async () => {
    const { main, store } = await fixture();
    await member(store.id, "owner@example.test", "OWNER");
    const target = await member(
      store.id,
      "target@example.test",
      "CASHIER",
      "ACTIVE",
      main.id,
    );
    const { value } = access();

    for (const role of [
      "BRANCH_MANAGER",
      "INVENTORY_STAFF",
      "CASHIER",
    ] as const) {
      const actor = await member(
        store.id,
        `${role.toLowerCase()}@example.test`,
        role,
        "ACTIVE",
        main.id,
      );
      await expect(
        value.createInvitation({
          actorUserId: actor.account.id,
          invitation: {
            branchIds: [main.id],
            email: `${role}-invitee@example.test`,
            role: "CASHIER",
          },
          organizationId: store.id,
        }),
      ).resolves.toEqual({ kind: "forbidden" });
      await expect(
        value.replaceMembership({
          actorUserId: actor.account.id,
          membershipId: target.row.id,
          organizationId: store.id,
          replacement: replacement(target.row, "CASHIER", [main.id]),
        }),
      ).resolves.toEqual({ kind: "forbidden" });
      await expect(
        value.deactivateMembership({
          actorUserId: actor.account.id,
          expectedUpdatedAt: target.row.updatedAt,
          membershipId: target.row.id,
          organizationId: store.id,
        }),
      ).resolves.toEqual({ kind: "forbidden" });
      await expect(
        value.listMemberships({
          actorUserId: actor.account.id,
          includeInactive: false,
          limit: 10,
          organizationId: store.id,
        }),
      ).resolves.toEqual({ kind: "forbidden" });
    }
    expect(await prisma.invitation.count()).toBe(0);
  });

  it("keeps a legacy multi-owner organization usable and unchanged: owners cannot touch each other, lower roles stay manageable", async () => {
    const { main, store } = await fixture();
    const first = await member(store.id, "owner1@example.test", "OWNER");
    const second = await member(store.id, "owner2@example.test", "OWNER");
    const staff = await member(
      store.id,
      "staff@example.test",
      "CASHIER",
      "ACTIVE",
      main.id,
    );
    const { value } = access();

    for (const [actor, other] of [
      [first, second],
      [second, first],
    ] as const) {
      await expect(
        value.replaceMembership({
          actorUserId: actor.account.id,
          membershipId: other.row.id,
          organizationId: store.id,
          replacement: replacement(other.row, "ADMIN"),
        }),
      ).resolves.toEqual({ kind: "forbidden" });
      await expect(
        value.deactivateMembership({
          actorUserId: actor.account.id,
          expectedUpdatedAt: other.row.updatedAt,
          membershipId: other.row.id,
          organizationId: store.id,
        }),
      ).resolves.toEqual({ kind: "forbidden" });
    }
    await expect(
      value.replaceMembership({
        actorUserId: first.account.id,
        membershipId: staff.row.id,
        organizationId: store.id,
        replacement: replacement(staff.row, "BRANCH_MANAGER", [main.id]),
      }),
    ).resolves.toMatchObject({ kind: "success" });
    await expect(
      value.listMemberships({
        actorUserId: second.account.id,
        includeInactive: true,
        limit: 10,
        organizationId: store.id,
      }),
    ).resolves.toMatchObject({ kind: "success" });
    expect(await ownerCount(store.id)).toBe(2);
  });

  it("refuses to accept an OWNER invitation left over from before single-owner governance", async () => {
    const { store } = await fixture();
    const owner = await member(store.id, "owner@example.test", "OWNER");
    const invitee = await user("invitee@example.test");
    const token = secureOneTimeTokenProvider.generate();
    await prisma.invitation.create({
      data: {
        expiresAt: new Date(NOW.getTime() + 86_400_000),
        intendedRole: "OWNER",
        invitedEmail: invitee.email,
        issuedAt: NOW,
        issuedByMembershipId: owner.row.id,
        organizationId: store.id,
        tokenHash: token.tokenHash,
      },
    });
    const { value } = access();

    await expect(
      value.acceptInvitation({
        actorEmail: invitee.email,
        actorUserId: invitee.id,
        rawToken: token.rawToken,
      }),
    ).resolves.toEqual({ kind: "invalid_invitation" });
    expect(
      await prisma.organizationMembership.count({
        where: { organizationId: store.id, userId: invitee.id },
      }),
    ).toBe(0);
    expect(await ownerCount(store.id)).toBe(1);
  });

  it("keeps exactly one OWNER under concurrent promotion, invitation, acceptance and demotion races", async () => {
    const { main, store } = await fixture();
    const owner = await member(store.id, "owner@example.test", "OWNER");
    const admin = await member(store.id, "admin@example.test", "ADMIN");
    const staff = await member(
      store.id,
      "staff@example.test",
      "CASHIER",
      "ACTIVE",
      main.id,
    );
    const invitee = await user("legacy-invitee@example.test");
    const token = secureOneTimeTokenProvider.generate();
    await prisma.invitation.create({
      data: {
        expiresAt: new Date(NOW.getTime() + 86_400_000),
        intendedRole: "OWNER",
        invitedEmail: invitee.email,
        issuedAt: NOW,
        issuedByMembershipId: owner.row.id,
        organizationId: store.id,
        tokenHash: token.tokenHash,
      },
    });
    const { value } = access();

    const outcomes = await Promise.all([
      value.replaceMembership({
        actorUserId: owner.account.id,
        membershipId: staff.row.id,
        organizationId: store.id,
        replacement: replacement(staff.row, "OWNER"),
      }),
      value.replaceMembership({
        actorUserId: admin.account.id,
        membershipId: staff.row.id,
        organizationId: store.id,
        replacement: replacement(staff.row, "OWNER"),
      }),
      value.createInvitation({
        actorUserId: owner.account.id,
        invitation: { branchIds: [], email: "o@example.test", role: "OWNER" },
        organizationId: store.id,
      }),
      value.acceptInvitation({
        actorEmail: invitee.email,
        actorUserId: invitee.id,
        rawToken: token.rawToken,
      }),
      value.replaceMembership({
        actorUserId: owner.account.id,
        membershipId: admin.row.id,
        organizationId: store.id,
        replacement: replacement(admin.row, "CASHIER", [main.id]),
      }),
    ]);

    expect(outcomes.map(({ kind }) => kind)).toEqual([
      "forbidden",
      "forbidden",
      "forbidden",
      "invalid_invitation",
      "success",
    ]);
    expect(await ownerCount(store.id)).toBe(1);
    expect(
      await prisma.organizationMembership.count({
        where: { organizationId: store.id, userId: invitee.id },
      }),
    ).toBe(0);
  });

  it("reports a removed member distinctly, sends no mail, and never restores access from an old invitation", async () => {
    const { main, store } = await fixture();
    const owner = await member(store.id, "owner@example.test", "OWNER");
    const removed = await member(
      store.id,
      "removed@example.test",
      "CASHIER",
      "ACTIVE",
      main.id,
    );
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
        replacement: replacement(inactive, "CASHIER", [main.id]),
      }),
    ).resolves.toMatchObject({ kind: "success" });
    expect(
      await prisma.organizationMembership.count({
        where: { organizationId: store.id, userId: removed.account.id },
      }),
    ).toBe(1);
  });
});
