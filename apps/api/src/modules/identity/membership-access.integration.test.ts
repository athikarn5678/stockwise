import {
  dropSingleOwnerIndex,
  restoreSingleOwnerIndex,
} from "../../test/single-owner-index.ts";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { Router } from "express";
import { createApp } from "../../app.ts";
import { createMembershipAccessRouter } from "./membership-access-router.ts";
import { createPrismaBranchRepository } from "../organizations/branch-repository.ts";
import {
  createRecordingEmailProvider,
  type IdentityEmailProvider,
} from "./email-provider.ts";
import type { RecordingIdentityEmailProvider } from "./email-provider.ts";
import { createPrismaMembershipAccessRepository } from "./membership-access-repository.ts";
import type { MembershipAccessService } from "./membership-access-service.ts";
import { createMembershipAccessService } from "./membership-access-service.ts";
import { secureOneTimeTokenProvider } from "./one-time-token.ts";
import { createSessionAuthenticationMiddleware } from "./authentication-context.ts";
import { loadTestDatabaseEnvironment } from "../../test/database-environment.ts";
import {
  createTestPrismaClient,
  resetTestDatabase,
} from "../../test/database-harness.ts";

const environment = loadTestDatabaseEnvironment();
const prisma = createTestPrismaClient(environment);
const NOW = new Date("2026-08-24T18:00:00.000Z");
const PASSWORD_HASH_FIXTURE =
  "$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$c2NoZW1hLXRlc3Q";

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

async function organization(name = "Membership Store") {
  return prisma.organization.create({ data: { name } });
}

async function branch(organizationId: string, code: string) {
  return prisma.branch.create({
    data: { code, name: `${code} Branch`, organizationId },
  });
}

async function membership(
  organizationId: string,
  actor: Awaited<ReturnType<typeof user>>,
  role: "OWNER" | "ADMIN" | "BRANCH_MANAGER" | "INVENTORY_STAFF" | "CASHIER",
  status: "ACTIVE" | "INACTIVE" = "ACTIVE",
) {
  return prisma.organizationMembership.create({
    data: {
      deactivatedAt: status === "INACTIVE" ? NOW : null,
      organizationId,
      role,
      status,
      userId: actor.id,
    },
  });
}

// OWNER invitations can no longer be issued; this inserts one the way it
// existed in data created before single-owner governance.
async function legacyOwnerInvitation(
  organizationId: string,
  issuedByMembershipId: string,
  invitedEmail: string,
  issuedAt = NOW,
) {
  const token = secureOneTimeTokenProvider.generate();
  const row = await prisma.invitation.create({
    data: {
      expiresAt: new Date(issuedAt.getTime() + 7 * 24 * 60 * 60 * 1000),
      intendedRole: "OWNER",
      invitedEmail,
      issuedAt,
      issuedByMembershipId,
      organizationId,
      tokenHash: token.tokenHash,
    },
  });
  return { id: row.id, rawToken: token.rawToken };
}

function service(
  emailProvider: IdentityEmailProvider = createRecordingEmailProvider(),
  now = () => NOW,
) {
  return {
    emailProvider,
    value: createMembershipAccessService({
      emailProvider,
      now,
      publicWebOrigin: "http://localhost:3000",
      repository: createPrismaMembershipAccessRepository(prisma),
      tokenProvider: secureOneTimeTokenProvider,
    }),
  };
}

function invitationToken(provider: RecordingIdentityEmailProvider): string {
  const message = provider.messages.at(-1);
  if (message === undefined) throw new Error("Invitation message missing.");
  const token = new URL(message.url).searchParams.get("token");
  if (token === null) throw new Error("Invitation token missing.");
  return token;
}

async function postInvitationViaHttp(
  access: MembershipAccessService,
  actors: ReadonlyMap<
    string,
    { displayName: string | null; email: string; id: string }
  >,
  input: Parameters<MembershipAccessService["createInvitation"]>[0],
): Promise<number> {
  const router = Router();
  router.use(
    createMembershipAccessRouter({
      authenticationMiddleware: createSessionAuthenticationMiddleware(
        async (request) => {
          const actorId = request.header("x-test-actor");
          const actor = actorId === undefined ? undefined : actors.get(actorId);
          return actor === undefined
            ? null
            : {
                actor: {
                  displayName: actor.displayName,
                  email: actor.email,
                  id: actor.id,
                },
                sessionId: `synthetic-${actor.id}`,
              };
        },
      ),
      membershipAccessService: access,
      publicWebOrigin: "http://localhost:3000",
    }),
  );
  const app = createApp({
    apiRouter: router,
    logger: { error() {}, info() {} },
  });
  const server = app.listen(0, "127.0.0.1");
  try {
    const listening = Promise.withResolvers<void>();
    server.once("listening", listening.resolve);
    server.once("error", listening.reject);
    await listening.promise;
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Expected a TCP listener.");
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/organizations/${input.organizationId}/invitations`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-test-actor": input.actorUserId,
        },
        body: JSON.stringify(input.invitation),
      },
    );
    return response.status;
  } finally {
    const closed = Promise.withResolvers<void>();
    server.close((error) => {
      if (error === undefined) closed.resolve();
      else closed.reject(error);
    });
    await closed.promise;
  }
}

describe("membership invitation and access management with PostgreSQL", () => {
  // Legacy multi-owner fixtures need the pre-reconciliation schema.
  beforeAll(async () => {
    await dropSingleOwnerIndex(prisma);
  });

  beforeEach(async () => {
    await resetTestDatabase(environment);
  });

  afterAll(async () => {
    await resetTestDatabase(environment);
    await restoreSingleOwnerIndex(prisma);
    await prisma.$disconnect();
  });

  it("enforces invitation delegation, branch cardinality, tenant scope, and existing-member rejection", async () => {
    const store = await organization();
    const otherStore = await organization("Other Store");
    const main = await branch(store.id, "MAIN");
    const inactive = await branch(store.id, "OLD");
    await prisma.branch.update({
      where: { id: inactive.id },
      data: { deactivatedAt: NOW, status: "INACTIVE" },
    });
    const foreign = await branch(otherStore.id, "FOREIGN");
    const ownerUser = await user("owner@example.com");
    const adminUser = await user("admin@example.com");
    const managerUser = await user("manager@example.com");
    await membership(store.id, ownerUser, "OWNER");
    await membership(store.id, adminUser, "ADMIN");
    await membership(store.id, managerUser, "BRANCH_MANAGER");
    const { value } = service();

    await expect(
      value.createInvitation({
        actorUserId: ownerUser.id,
        invitation: {
          branchIds: [],
          email: "new-owner@example.com",
          role: "OWNER",
        },
        organizationId: store.id,
      }),
    ).resolves.toEqual({ kind: "forbidden" });
    expect(
      await prisma.invitation.count({
        where: { invitedEmail: "new-owner@example.com" },
      }),
    ).toBe(0);
    await expect(
      value.createInvitation({
        actorUserId: adminUser.id,
        invitation: {
          branchIds: [],
          email: "blocked-owner@example.com",
          role: "OWNER",
        },
        organizationId: store.id,
      }),
    ).resolves.toEqual({ kind: "forbidden" });
    await expect(
      value.createInvitation({
        actorUserId: managerUser.id,
        invitation: {
          branchIds: [main.id],
          email: "blocked@example.com",
          role: "CASHIER",
        },
        organizationId: store.id,
      }),
    ).resolves.toEqual({ kind: "forbidden" });

    for (const branchIds of [[], [inactive.id], [foreign.id]]) {
      await expect(
        value.createInvitation({
          actorUserId: ownerUser.id,
          invitation: {
            branchIds,
            email: `${branchIds.length}-${branchIds[0] ?? "none"}@example.com`,
            role: "CASHIER",
          },
          organizationId: store.id,
        }),
      ).resolves.toEqual({ kind: "invalid_branch_scope" });
    }
    await expect(
      value.createInvitation({
        actorUserId: ownerUser.id,
        invitation: {
          branchIds: [main.id],
          email: "admin-scope@example.com",
          role: "ADMIN",
        },
        organizationId: store.id,
      }),
    ).resolves.toEqual({ kind: "invalid_branch_scope" });

    const existing = await user("existing@example.com");
    await membership(store.id, existing, "CASHIER", "INACTIVE");
    await expect(
      value.createInvitation({
        actorUserId: ownerUser.id,
        invitation: {
          branchIds: [main.id],
          email: existing.email,
          role: "CASHIER",
        },
        organizationId: store.id,
      }),
    ).resolves.toEqual({ kind: "membership_exists", status: "INACTIVE" });
  });

  it("reissues with a fresh token, preserves replacement history, compensates delivery failure, and revokes safely", async () => {
    const store = await organization();
    const ownerUser = await user("owner@example.com");
    const adminUser = await user("admin@example.com");
    const ownerMembership = await membership(store.id, ownerUser, "OWNER");
    await membership(store.id, adminUser, "ADMIN");
    const recording = createRecordingEmailProvider();
    const working = service(recording).value;

    await working.createInvitation({
      actorUserId: ownerUser.id,
      invitation: {
        branchIds: [],
        email: "invitee@example.com",
        role: "ADMIN",
      },
      organizationId: store.id,
    });
    const firstToken = invitationToken(recording);
    await working.createInvitation({
      actorUserId: ownerUser.id,
      invitation: {
        branchIds: [],
        email: "invitee@example.com",
        role: "ADMIN",
      },
      organizationId: store.id,
    });
    const secondToken = invitationToken(recording);
    expect(secondToken).not.toBe(firstToken);
    const invitations = await prisma.invitation.findMany({
      orderBy: { createdAt: "asc" },
    });
    expect(invitations).toHaveLength(2);
    expect(invitations[0]).toMatchObject({
      replacedAt: NOW,
      revocationReason: "REPLACED",
    });
    expect(invitations[0]?.tokenHash).not.toBe(firstToken);

    const failed = service({
      async send() {
        throw new Error("provider");
      },
    }).value;
    await expect(
      failed.createInvitation({
        actorUserId: ownerUser.id,
        invitation: {
          branchIds: [],
          email: "failed@example.com",
          role: "ADMIN",
        },
        organizationId: store.id,
      }),
    ).resolves.toEqual({ kind: "delivery_failed" });
    expect(
      await prisma.invitation.findFirst({
        where: { invitedEmail: "failed@example.com" },
      }),
    ).toMatchObject({ revocationReason: "DELIVERY_FAILED", revokedAt: NOW });

    // A pre-governance OWNER invitation is protected: nobody, OWNER included,
    // can revoke it through the API (it can never be accepted either).
    const ownerInvite = await legacyOwnerInvitation(
      store.id,
      ownerMembership.id,
      "owner-two@example.com",
    );
    for (const actor of [adminUser, ownerUser]) {
      await expect(
        working.revokeInvitation({
          actorUserId: actor.id,
          invitationId: ownerInvite.id,
          organizationId: store.id,
        }),
      ).resolves.toEqual({ kind: "forbidden" });
    }

    // An ADMIN invitation is revocable by the OWNER, not by a peer ADMIN.
    const adminInvite = await working.createInvitation({
      actorUserId: ownerUser.id,
      invitation: {
        branchIds: [],
        email: "admin-two@example.com",
        role: "ADMIN",
      },
      organizationId: store.id,
    });
    if (adminInvite.kind !== "success") throw new Error("Expected invitation.");
    await expect(
      working.revokeInvitation({
        actorUserId: adminUser.id,
        invitationId: adminInvite.invitationId,
        organizationId: store.id,
      }),
    ).resolves.toEqual({ kind: "forbidden" });
    await expect(
      working.revokeInvitation({
        actorUserId: ownerUser.id,
        invitationId: adminInvite.invitationId,
        organizationId: store.id,
      }),
    ).resolves.toMatchObject({
      kind: "success",
      invitation: { state: "REVOKED" },
    });
  });

  it("serializes concurrent reissue and invitation lifecycle races", async () => {
    const store = await organization();
    const ownerUser = await user("owner@example.com");
    await membership(store.id, ownerUser, "OWNER");
    const invitedUser = await user("race-invitee@example.com");
    const recording = createRecordingEmailProvider();
    const access = service(recording).value;
    const invitationInput = {
      actorUserId: ownerUser.id,
      invitation: {
        branchIds: [],
        email: invitedUser.email,
        role: "ADMIN" as const,
      },
      organizationId: store.id,
    };

    const issued = await Promise.all(
      Array.from({ length: 4 }, () => access.createInvitation(invitationInput)),
    );
    expect(issued.every(({ kind }) => kind === "success")).toBe(true);
    expect(
      await prisma.invitation.count({
        where: {
          consumedAt: null,
          invitedEmail: invitedUser.email,
          organizationId: store.id,
          replacedAt: null,
          revokedAt: null,
        },
      }),
    ).toBe(1);
    expect(
      new Set(
        recording.messages.map(({ url }) =>
          new URL(url).searchParams.get("token"),
        ),
      ).size,
    ).toBe(4);

    const activeToken = invitationToken(recording);
    const [acceptOutcome, reissueOutcome] = await Promise.all([
      access.acceptInvitation({
        actorEmail: invitedUser.email,
        actorUserId: invitedUser.id,
        rawToken: activeToken,
      }),
      access.createInvitation(invitationInput),
    ]);
    expect(
      (acceptOutcome.kind === "success" &&
        reissueOutcome.kind === "membership_exists") ||
        (acceptOutcome.kind === "invalid_invitation" &&
          reissueOutcome.kind === "success"),
    ).toBe(true);

    if (reissueOutcome.kind === "success") {
      const newestToken = invitationToken(recording);
      const [revokeOutcome, newestAcceptOutcome] = await Promise.all([
        access.revokeInvitation({
          actorUserId: ownerUser.id,
          invitationId: reissueOutcome.invitationId,
          organizationId: store.id,
        }),
        access.acceptInvitation({
          actorEmail: invitedUser.email,
          actorUserId: invitedUser.id,
          rawToken: newestToken,
        }),
      ]);
      expect(
        (revokeOutcome.kind === "success" &&
          newestAcceptOutcome.kind === "invalid_invitation") ||
          (revokeOutcome.kind === "finalized" &&
            newestAcceptOutcome.kind === "success"),
      ).toBe(true);
    }
  });

  it("accepts once, persists tenant-safe provenance and assignment scope, and reconciles same-user replay", async () => {
    const store = await organization();
    const main = await branch(store.id, "MAIN");
    const ownerUser = await user("owner@example.com");
    await membership(store.id, ownerUser, "OWNER");
    const invitedUser = await user("cashier@example.com");
    const recording = createRecordingEmailProvider();
    const access = service(recording).value;
    await access.createInvitation({
      actorUserId: ownerUser.id,
      invitation: {
        branchIds: [main.id],
        email: invitedUser.email,
        role: "CASHIER",
      },
      organizationId: store.id,
    });
    const token = invitationToken(recording);

    await expect(
      access.acceptInvitation({
        actorEmail: "wrong@example.com",
        actorUserId: invitedUser.id,
        rawToken: token,
      }),
    ).resolves.toEqual({ kind: "invalid_invitation" });
    const accepted = await access.acceptInvitation({
      actorEmail: invitedUser.email,
      actorUserId: invitedUser.id,
      rawToken: token,
    });
    expect(accepted).toMatchObject({ kind: "success", replayed: false });
    if (accepted.kind !== "success") throw new Error("Expected acceptance.");
    const persisted = await prisma.organizationMembership.findUniqueOrThrow({
      where: {
        organizationId_userId: {
          organizationId: store.id,
          userId: invitedUser.id,
        },
      },
      include: {
        branchAssignments: true,
        sourceInvitation: true,
        targetAccessEvents: { include: { branchScopes: true } },
      },
    });
    expect(persisted.sourceInvitationId).not.toBeNull();
    expect(persisted.branchAssignments).toMatchObject([
      { branchId: main.id, status: "ACTIVE" },
    ]);
    expect(persisted.targetAccessEvents).toMatchObject([
      {
        eventType: "INVITATION_ACCEPTED",
        branchScopes: [{ branchId: main.id, organizationId: store.id }],
      },
    ]);
    await expect(
      access.acceptInvitation({
        actorEmail: invitedUser.email,
        actorUserId: invitedUser.id,
        rawToken: token,
      }),
    ).resolves.toMatchObject({ kind: "success", replayed: true });
    expect(await prisma.organizationMembership.count()).toBe(2);
    expect(await prisma.membershipAccessEvent.count()).toBe(1);
  });

  it("does not consume an invitation with stale branch scope and serializes concurrent acceptance", async () => {
    const store = await organization();
    const main = await branch(store.id, "MAIN");
    const ownerUser = await user("owner@example.com");
    await membership(store.id, ownerUser, "OWNER");
    const invitedUser = await user("staff@example.com");
    const recording = createRecordingEmailProvider();
    const access = service(recording).value;
    await access.createInvitation({
      actorUserId: ownerUser.id,
      invitation: {
        branchIds: [main.id],
        email: invitedUser.email,
        role: "INVENTORY_STAFF",
      },
      organizationId: store.id,
    });
    const token = invitationToken(recording);
    await prisma.branch.update({
      where: { id: main.id },
      data: { deactivatedAt: NOW, status: "INACTIVE" },
    });
    await expect(
      access.acceptInvitation({
        actorEmail: invitedUser.email,
        actorUserId: invitedUser.id,
        rawToken: token,
      }),
    ).resolves.toEqual({ kind: "invalid_scope" });
    expect(await prisma.invitation.findFirstOrThrow()).toMatchObject({
      consumedAt: null,
    });
    await prisma.branch.update({
      where: { id: main.id },
      data: { deactivatedAt: null, status: "ACTIVE" },
    });
    const outcomes = await Promise.all([
      access.acceptInvitation({
        actorEmail: invitedUser.email,
        actorUserId: invitedUser.id,
        rawToken: token,
      }),
      access.acceptInvitation({
        actorEmail: invitedUser.email,
        actorUserId: invitedUser.id,
        rawToken: token,
      }),
    ]);
    expect(outcomes).toEqual([
      expect.objectContaining({ kind: "success" }),
      expect.objectContaining({ kind: "success" }),
    ]);
    expect(await prisma.organizationMembership.count()).toBe(2);
    expect(await prisma.membershipAccessEvent.count()).toBe(1);
  });

  it("uses one generic invalid result for unknown, expired, revoked, and wrong-user invitation tokens", async () => {
    const store = await organization();
    const ownerUser = await user("owner@example.com");
    await membership(store.id, ownerUser, "OWNER");
    const invitedUser = await user("invalid-invitee@example.com");
    const otherUser = await user("other-invitee@example.com");
    const recording = createRecordingEmailProvider();
    const access = service(recording).value;

    await expect(
      access.acceptInvitation({
        actorEmail: invitedUser.email,
        actorUserId: invitedUser.id,
        rawToken: "unknown-token",
      }),
    ).resolves.toEqual({ kind: "invalid_invitation" });

    const created = await access.createInvitation({
      actorUserId: ownerUser.id,
      invitation: {
        branchIds: [],
        email: invitedUser.email,
        role: "ADMIN",
      },
      organizationId: store.id,
    });
    if (created.kind !== "success") throw new Error("Expected invitation.");
    const token = invitationToken(recording);
    await expect(
      access.acceptInvitation({
        actorEmail: otherUser.email,
        actorUserId: otherUser.id,
        rawToken: token,
      }),
    ).resolves.toEqual({ kind: "invalid_invitation" });
    await access.revokeInvitation({
      actorUserId: ownerUser.id,
      invitationId: created.invitationId,
      organizationId: store.id,
    });
    await expect(
      access.acceptInvitation({
        actorEmail: invitedUser.email,
        actorUserId: invitedUser.id,
        rawToken: token,
      }),
    ).resolves.toEqual({ kind: "invalid_invitation" });

    const expiredRecording = createRecordingEmailProvider();
    const issuedAt = new Date("2026-08-01T00:00:00.000Z");
    const expiredIssuer = service(expiredRecording, () => issuedAt).value;
    await expiredIssuer.createInvitation({
      actorUserId: ownerUser.id,
      invitation: {
        branchIds: [],
        email: "expired-invitee@example.com",
        role: "ADMIN",
      },
      organizationId: store.id,
    });
    const expiredToken = invitationToken(expiredRecording);
    await expect(
      service(
        expiredRecording,
        () => new Date("2026-08-09T00:00:00.000Z"),
      ).value.acceptInvitation({
        actorEmail: "expired-invitee@example.com",
        actorUserId: invitedUser.id,
        rawToken: expiredToken,
      }),
    ).resolves.toEqual({ kind: "invalid_invitation" });
  });

  it("fully replaces scope, enforces optimistic state and delegation, and removes/reactivates effective access", async () => {
    const store = await organization();
    const first = await branch(store.id, "A");
    const second = await branch(store.id, "B");
    const ownerUser = await user("owner@example.com");
    const adminUser = await user("admin@example.com");
    const cashierUser = await user("cashier@example.com");
    const ownerMembership = await membership(store.id, ownerUser, "OWNER");
    await membership(store.id, adminUser, "ADMIN");
    const cashierMembership = await membership(
      store.id,
      cashierUser,
      "CASHIER",
    );
    await prisma.session.create({
      data: {
        absoluteExpiresAt: new Date(NOW.getTime() + 86_400_000),
        idleExpiresAt: new Date(NOW.getTime() + 3_600_000),
        issuedAt: NOW,
        lastUsedAt: NOW,
        tokenHash: "cashier-session-hash",
        userId: cashierUser.id,
      },
    });
    await prisma.branchAssignment.create({
      data: {
        branchId: first.id,
        organizationId: store.id,
        userId: cashierUser.id,
      },
    });
    const access = service().value;

    await expect(
      access.replaceMembership({
        actorUserId: adminUser.id,
        membershipId: ownerMembership.id,
        organizationId: store.id,
        replacement: {
          branchIds: [],
          expectedUpdatedAt: ownerMembership.updatedAt,
          role: "ADMIN",
        },
      }),
    ).resolves.toEqual({ kind: "forbidden" });
    const replaced = await access.replaceMembership({
      actorUserId: ownerUser.id,
      membershipId: cashierMembership.id,
      organizationId: store.id,
      replacement: {
        branchIds: [second.id],
        expectedUpdatedAt: cashierMembership.updatedAt,
        role: "BRANCH_MANAGER",
      },
    });
    expect(replaced).toMatchObject({
      kind: "success",
      membership: { role: "BRANCH_MANAGER" },
    });
    if (replaced.kind !== "success") throw new Error("Expected replacement.");
    expect(replaced.membership.branchAssignments).toMatchObject([
      { branch: { id: first.id }, status: "INACTIVE" },
      { branch: { id: second.id }, status: "ACTIVE" },
    ]);
    await expect(
      access.replaceMembership({
        actorUserId: ownerUser.id,
        membershipId: cashierMembership.id,
        organizationId: store.id,
        replacement: {
          branchIds: [first.id],
          expectedUpdatedAt: cashierMembership.updatedAt,
          role: "CASHIER",
        },
      }),
    ).resolves.toEqual({ kind: "stale" });

    const deactivated = await access.deactivateMembership({
      actorUserId: ownerUser.id,
      expectedUpdatedAt: new Date(replaced.membership.updatedAt),
      membershipId: cashierMembership.id,
      organizationId: store.id,
    });
    expect(deactivated).toMatchObject({
      kind: "success",
      membership: { status: "INACTIVE" },
    });
    expect(
      (await createPrismaBranchRepository(prisma).accessContext(cashierUser.id))
        ?.organizations,
    ).toEqual([]);
    expect(
      await prisma.session.findFirstOrThrow({
        where: { userId: cashierUser.id },
      }),
    ).toMatchObject({ revokedAt: null });
    if (deactivated.kind !== "success")
      throw new Error("Expected deactivation.");
    const reactivated = await access.reactivateMembership({
      actorUserId: ownerUser.id,
      membershipId: cashierMembership.id,
      organizationId: store.id,
      replacement: {
        branchIds: [first.id],
        expectedUpdatedAt: new Date(deactivated.membership.updatedAt),
        role: "CASHIER",
      },
    });
    expect(reactivated).toMatchObject({
      kind: "success",
      membership: { role: "CASHIER", status: "ACTIVE" },
    });
  });

  it("serializes concurrent full replacements with an exact optimistic version", async () => {
    const store = await organization();
    const first = await branch(store.id, "A");
    const second = await branch(store.id, "B");
    const ownerUser = await user("owner@example.com");
    const cashierUser = await user("cashier@example.com");
    await membership(store.id, ownerUser, "OWNER");
    const target = await membership(store.id, cashierUser, "CASHIER");
    await prisma.branchAssignment.create({
      data: {
        branchId: first.id,
        organizationId: store.id,
        userId: cashierUser.id,
      },
    });
    const access = service().value;
    const outcomes = await Promise.all([
      access.replaceMembership({
        actorUserId: ownerUser.id,
        membershipId: target.id,
        organizationId: store.id,
        replacement: {
          branchIds: [second.id],
          expectedUpdatedAt: target.updatedAt,
          role: "CASHIER",
        },
      }),
      access.replaceMembership({
        actorUserId: ownerUser.id,
        membershipId: target.id,
        organizationId: store.id,
        replacement: {
          branchIds: [],
          expectedUpdatedAt: target.updatedAt,
          role: "ADMIN",
        },
      }),
    ]);
    expect(outcomes.map(({ kind }) => kind).sort()).toEqual([
      "stale",
      "success",
    ]);
    expect(await prisma.membershipAccessEvent.count()).toBe(1);
  });

  it("keeps legacy multi-owner organizations intact under concurrent owner reductions and paginates management views without token data", async () => {
    const store = await organization();
    const firstOwner = await user("owner-one@example.com");
    const secondOwner = await user("owner-two@example.com");
    const firstMembership = await membership(store.id, firstOwner, "OWNER");
    const secondMembership = await membership(store.id, secondOwner, "OWNER");
    const access = service().value;
    const outcomes = await Promise.all([
      access.deactivateMembership({
        actorUserId: firstOwner.id,
        expectedUpdatedAt: firstMembership.updatedAt,
        membershipId: firstMembership.id,
        organizationId: store.id,
      }),
      access.deactivateMembership({
        actorUserId: secondOwner.id,
        expectedUpdatedAt: secondMembership.updatedAt,
        membershipId: secondMembership.id,
        organizationId: store.id,
      }),
      access.deactivateMembership({
        actorUserId: firstOwner.id,
        expectedUpdatedAt: secondMembership.updatedAt,
        membershipId: secondMembership.id,
        organizationId: store.id,
      }),
    ]);
    expect(outcomes.map(({ kind }) => kind).sort()).toEqual([
      "forbidden",
      "self_modification",
      "self_modification",
    ]);
    expect(
      await prisma.organizationMembership.count({
        where: { organizationId: store.id, role: "OWNER", status: "ACTIVE" },
      }),
    ).toBe(2);
    const activeOwner = await prisma.organizationMembership.findFirstOrThrow({
      where: { organizationId: store.id, role: "OWNER", status: "ACTIVE" },
    });
    const page = await access.listMemberships({
      actorUserId: activeOwner.userId,
      includeInactive: true,
      limit: 1,
      organizationId: store.id,
    });
    expect(page).toMatchObject({
      kind: "success",
      page: { items: [expect.any(Object)], nextCursor: expect.any(String) },
    });
    if (page.kind !== "success" || page.page.nextCursor === null)
      throw new Error("Expected cursor.");
    await expect(
      access.listMemberships({
        actorUserId: activeOwner.userId,
        cursor: page.page.nextCursor,
        includeInactive: true,
        limit: 1,
        organizationId: store.id,
      }),
    ).resolves.toMatchObject({
      kind: "success",
      page: { items: [expect.any(Object)] },
    });
  });

  it("denies an ADMIN replacing a legacy OWNER invitation over the real HTTP stack and never lets that invitation create an OWNER", async () => {
    const store = await organization();
    const ownerUser = await user("owner-http@example.com");
    const adminUser = await user("admin-http@example.com");
    const invitedUser = await user("protected-invitee@example.com");
    const ownerMembership = await membership(store.id, ownerUser, "OWNER");
    await membership(store.id, adminUser, "ADMIN");
    const recording = createRecordingEmailProvider();
    const send = vi.spyOn(recording, "send");
    const access = service(recording).value;
    const issued = await legacyOwnerInvitation(
      store.id,
      ownerMembership.id,
      invitedUser.email,
    );
    const originalToken = issued.rawToken;
    const before = await prisma.invitation.findUniqueOrThrow({
      where: { id: issued.id },
      include: { branchScopes: true },
    });
    const sentBefore = recording.messages.length;
    const actors = new Map([
      [ownerUser.id, ownerUser],
      [adminUser.id, adminUser],
    ]);
    const status = await postInvitationViaHttp(access, actors, {
      actorUserId: adminUser.id,
      invitation: { branchIds: [], email: invitedUser.email, role: "ADMIN" },
      organizationId: store.id,
    });
    expect(status).toBe(403);
    const after = await prisma.invitation.findUniqueOrThrow({
      where: { id: issued.id },
      include: { branchScopes: true },
    });
    expect(after).toEqual(before);
    expect(
      await prisma.invitation.count({
        where: {
          invitedEmail: invitedUser.email,
          organizationId: store.id,
        },
      }),
    ).toBe(1);
    expect(recording.messages).toHaveLength(sentBefore);
    expect(send).toHaveBeenCalledTimes(sentBefore);
    await expect(
      access.acceptInvitation({
        actorEmail: invitedUser.email,
        actorUserId: invitedUser.id,
        rawToken: originalToken,
      }),
    ).resolves.toEqual({ kind: "invalid_invitation" });
    expect(
      await prisma.organizationMembership.count({
        where: { organizationId: store.id, userId: invitedUser.id },
      }),
    ).toBe(0);
  });
  it("authorizes every replaceable role, preserves exact replacement semantics, and serializes protected successors", async () => {
    const store = await organization();
    const otherStore = await organization("Other Membership Store");
    const main = await branch(store.id, "MAIN");
    const ownerUser = await user("owner-role-reissue@example.com");
    const adminUser = await user("admin-role-reissue@example.com");
    const foreignAdmin = await user("foreign-role-reissue@example.com");
    const ownerMembership = await membership(store.id, ownerUser, "OWNER");
    await membership(store.id, adminUser, "ADMIN");
    await membership(otherStore.id, foreignAdmin, "ADMIN");
    const recording = createRecordingEmailProvider();
    const access = service(recording).value;
    const actors = new Map([
      [ownerUser.id, ownerUser],
      [adminUser.id, adminUser],
      [foreignAdmin.id, foreignAdmin],
    ]);
    const issue = async (
      actorUserId: string,
      email: string,
      role:
        "OWNER" | "ADMIN" | "BRANCH_MANAGER" | "INVENTORY_STAFF" | "CASHIER",
      branchIds: string[] = [],
    ) =>
      access.createInvitation({
        actorUserId,
        invitation: { branchIds, email, role },
        organizationId: store.id,
      });
    const post = (
      actorUserId: string,
      email: string,
      role:
        "OWNER" | "ADMIN" | "BRANCH_MANAGER" | "INVENTORY_STAFF" | "CASHIER",
      branchIds: string[] = [],
    ) =>
      postInvitationViaHttp(access, actors, {
        actorUserId,
        invitation: { branchIds, email, role },
        organizationId: store.id,
      });
    // Legacy OWNER invitations are protected from replacement by everyone.
    const ownerTarget = "owner-role-target@example.com";
    const firstOwner = await legacyOwnerInvitation(
      store.id,
      ownerMembership.id,
      ownerTarget,
    );
    const originalOwnerRow = await prisma.invitation.findUniqueOrThrow({
      where: { id: firstOwner.id },
      include: { branchScopes: true },
    });
    expect(await post(adminUser.id, ownerTarget, "ADMIN")).toBe(403);
    expect(
      await post(adminUser.id, ownerTarget, "BRANCH_MANAGER", [main.id]),
    ).toBe(403);
    expect(await post(ownerUser.id, ownerTarget, "ADMIN")).toBe(403);
    expect(
      await prisma.invitation.findUniqueOrThrow({
        where: { id: firstOwner.id },
        include: { branchScopes: true },
      }),
    ).toEqual(originalOwnerRow);

    // An ADMIN invitation is replaceable by the OWNER only; a peer ADMIN and
    // anyone targeting OWNER are refused.
    const adminTarget = "admin-non-owner-target@example.com";
    const adminBase = await issue(ownerUser.id, adminTarget, "ADMIN");
    if (adminBase.kind !== "success") throw new Error("Expected invitation.");
    expect(await post(adminUser.id, adminTarget, "OWNER")).toBe(403);
    expect(await post(ownerUser.id, adminTarget, "OWNER")).toBe(403);
    expect(await post(adminUser.id, adminTarget, "CASHIER", [main.id])).toBe(
      403,
    );
    expect(await post(ownerUser.id, adminTarget, "CASHIER", [main.id])).toBe(
      201,
    );
    expect(
      await prisma.invitation.findMany({
        where: { invitedEmail: adminTarget, organizationId: store.id },
        include: { branchScopes: true },
        orderBy: { intendedRole: "asc" },
      }),
    ).toMatchObject([
      { intendedRole: "ADMIN", replacedAt: NOW },
      { branchScopes: [{ branchId: main.id }], intendedRole: "CASHIER" },
    ]);

    // An expired legacy OWNER invitation is still not replaceable by an ADMIN.
    const expiredTarget = "expired-owner-target@example.com";
    const expired = await legacyOwnerInvitation(
      store.id,
      ownerMembership.id,
      expiredTarget,
      new Date(NOW.getTime() - 8 * 24 * 60 * 60 * 1000),
    );
    expect(await post(adminUser.id, expiredTarget, "ADMIN")).toBe(403);
    expect(
      await prisma.invitation.findUniqueOrThrow({ where: { id: expired.id } }),
    ).toMatchObject({ replacedAt: null, revokedAt: null });

    // Cross-organization actors are refused.
    const foreignTarget = "cross-org-owner-target@example.com";
    const foreignProtected = await legacyOwnerInvitation(
      store.id,
      ownerMembership.id,
      foreignTarget,
    );
    expect(await post(foreignAdmin.id, foreignTarget, "ADMIN")).toBe(403);
    expect(
      await prisma.invitation.findUniqueOrThrow({
        where: { id: foreignProtected.id },
      }),
    ).toMatchObject({ replacedAt: null, revokedAt: null });

    // Concurrent authorized and unauthorized reissues serialize: whatever the
    // order, the open ADMIN invitation is only ever replaced by the OWNER.
    const raceTarget = "race-protected-admin@example.com";
    const initial = await issue(ownerUser.id, raceTarget, "ADMIN");
    if (initial.kind !== "success") throw new Error("Expected invitation.");
    const [ownerSuccessor, unauthorizedReissue] = await Promise.all([
      post(ownerUser.id, raceTarget, "ADMIN"),
      post(adminUser.id, raceTarget, "ADMIN"),
    ]);
    expect(ownerSuccessor).toBe(201);
    expect(unauthorizedReissue).toBe(403);
    expect(
      await prisma.invitation.count({
        where: {
          consumedAt: null,
          invitedEmail: raceTarget,
          organizationId: store.id,
          replacedAt: null,
          revokedAt: null,
        },
      }),
    ).toBe(1);
    expect(
      await prisma.invitation.count({
        where: { invitedEmail: raceTarget, organizationId: store.id },
      }),
    ).toBe(2);
  });
});
