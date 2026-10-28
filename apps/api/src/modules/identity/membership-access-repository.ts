import { Prisma, type PrismaClient } from "../../generated/prisma/client.ts";
import {
  can,
  createTrustedAuthorizationContext,
  createTrustedOrganizationScope,
  PERMISSIONS,
  type OrganizationRole,
  type ResolvedAuthorizationState,
  type TrustedAuthorizationContext,
} from "./authorization-policy.ts";
import { OneTimeTokenCollisionError } from "./credential-lifecycle-repository.ts";
import type {
  InvitationCreateInput,
  MembershipReplaceInput,
} from "./membership-access-schemas.ts";

const BRANCH_ROLES = new Set<OrganizationRole>([
  "BRANCH_MANAGER",
  "INVENTORY_STAFF",
  "CASHIER",
]);

type Transaction = Prisma.TransactionClient;

export interface SafeBranchAssignment {
  branch: {
    code: string;
    id: string;
    name: string;
    status: "ACTIVE" | "INACTIVE";
  };
  status: "ACTIVE" | "INACTIVE";
}

export interface SafeMembership {
  branchAssignments: SafeBranchAssignment[];
  createdAt: string;
  id: string;
  organization: { id: string; name: string };
  role: OrganizationRole;
  status: "ACTIVE" | "INACTIVE";
  updatedAt: string;
  user: {
    displayName: string | null;
    email: string;
    id: string;
  };
}

export interface SafeInvitation {
  branchScopes: Array<{
    code: string;
    id: string;
    name: string;
    status: "ACTIVE" | "INACTIVE";
  }>;
  createdAt: string;
  expiresAt: string;
  id: string;
  invitedEmail: string;
  intendedRole: OrganizationRole;
  state: "PENDING" | "EXPIRED" | "ACCEPTED" | "REVOKED" | "REPLACED";
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export type InvitationIssueOutcome =
  | {
      kind: "success";
      invitation: SafeInvitation;
      invitationId: string;
      recipient: string;
    }
  | { kind: "forbidden" }
  | { kind: "invalid_branch_scope" }
  | { kind: "membership_exists"; status: "ACTIVE" | "INACTIVE" };

export type InvitationRevokeOutcome =
  | { kind: "success"; invitation: SafeInvitation }
  | { kind: "forbidden" }
  | { kind: "finalized" };

export type InvitationAcceptOutcome =
  | { kind: "success"; membership: SafeMembership; replayed: boolean }
  | { kind: "invalid_invitation" }
  | { kind: "invalid_scope" }
  | { kind: "membership_exists" };

export type MembershipMutationOutcome =
  | { kind: "success"; membership: SafeMembership }
  | { kind: "forbidden" }
  | { kind: "not_found" }
  | { kind: "inactive" }
  | { kind: "already_active" }
  | { kind: "invalid_branch_scope" }
  | { kind: "stale" }
  | { kind: "last_active_owner" }
  | { kind: "self_modification" };

export type MembershipListOutcome =
  | { kind: "success"; page: Page<SafeMembership> }
  | { kind: "forbidden" }
  | { kind: "invalid_cursor" };

export type InvitationListOutcome =
  | { kind: "success"; page: Page<SafeInvitation> }
  | { kind: "forbidden" }
  | { kind: "invalid_cursor" };

export interface MembershipAccessRepository {
  acceptInvitation(input: {
    actorEmail: string;
    actorUserId: string;
    acceptedAt: Date;
    tokenHash: string;
  }): Promise<InvitationAcceptOutcome>;
  deactivateMembership(input: {
    actorUserId: string;
    expectedUpdatedAt: Date;
    membershipId: string;
    organizationId: string;
    occurredAt: Date;
  }): Promise<MembershipMutationOutcome>;
  issueInvitation(input: {
    actorUserId: string;
    expiresAt: Date;
    invitation: InvitationCreateInput;
    issuedAt: Date;
    organizationId: string;
    tokenHash: string;
  }): Promise<InvitationIssueOutcome>;
  listInvitations(input: {
    actorUserId: string;
    cursor?: string;
    limit: number;
    now: Date;
    organizationId: string;
  }): Promise<InvitationListOutcome>;
  listMemberships(input: {
    actorUserId: string;
    cursor?: string;
    includeInactive: boolean;
    limit: number;
    organizationId: string;
  }): Promise<MembershipListOutcome>;
  reactivateMembership(input: {
    actorUserId: string;
    membershipId: string;
    organizationId: string;
    occurredAt: Date;
    replacement: MembershipReplaceInput;
  }): Promise<MembershipMutationOutcome>;
  replaceMembership(input: {
    actorUserId: string;
    membershipId: string;
    organizationId: string;
    occurredAt: Date;
    replacement: MembershipReplaceInput;
  }): Promise<MembershipMutationOutcome>;
  revokeInvitation(input: {
    actorUserId: string;
    invitationId: string;
    now: Date;
    organizationId: string;
  }): Promise<InvitationRevokeOutcome>;
  revokeInvitationAfterDeliveryFailure(input: {
    invitationId: string;
    revokedAt: Date;
  }): Promise<void>;
}

const membershipSelection = {
  branchAssignments: {
    orderBy: [
      { branch: { code: "asc" as const } },
      { branchId: "asc" as const },
    ],
    select: {
      branch: { select: { code: true, id: true, name: true, status: true } },
      status: true,
    },
  },
  createdAt: true,
  id: true,
  organization: { select: { id: true, name: true } },
  role: true,
  status: true,
  updatedAt: true,
  user: { select: { displayName: true, email: true, id: true } },
} satisfies Prisma.OrganizationMembershipSelect;

const invitationSelection = {
  branchScopes: {
    orderBy: [
      { branch: { code: "asc" as const } },
      { branchId: "asc" as const },
    ],
    select: {
      branch: { select: { code: true, id: true, name: true, status: true } },
    },
  },
  consumedAt: true,
  createdAt: true,
  expiresAt: true,
  id: true,
  intendedRole: true,
  invitedEmail: true,
  replacedAt: true,
  revokedAt: true,
} satisfies Prisma.InvitationSelect;

function safeMembership(record: {
  branchAssignments: SafeBranchAssignment[];
  createdAt: Date;
  id: string;
  organization: { id: string; name: string };
  role: OrganizationRole;
  status: "ACTIVE" | "INACTIVE";
  updatedAt: Date;
  user: { displayName: string | null; email: string; id: string };
}): SafeMembership {
  return {
    ...record,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function invitationState(
  record: {
    consumedAt: Date | null;
    expiresAt: Date;
    replacedAt: Date | null;
    revokedAt: Date | null;
  },
  now: Date,
): SafeInvitation["state"] {
  if (record.consumedAt !== null) return "ACCEPTED";
  if (record.replacedAt !== null) return "REPLACED";
  if (record.revokedAt !== null) return "REVOKED";
  return now >= record.expiresAt ? "EXPIRED" : "PENDING";
}

function safeInvitation(
  record: {
    branchScopes: Array<{ branch: SafeInvitation["branchScopes"][number] }>;
    consumedAt: Date | null;
    createdAt: Date;
    expiresAt: Date;
    id: string;
    intendedRole: OrganizationRole;
    invitedEmail: string;
    replacedAt: Date | null;
    revokedAt: Date | null;
  },
  now: Date,
): SafeInvitation {
  return {
    branchScopes: record.branchScopes.map(({ branch }) => branch),
    createdAt: record.createdAt.toISOString(),
    expiresAt: record.expiresAt.toISOString(),
    id: record.id,
    intendedRole: record.intendedRole,
    invitedEmail: record.invitedEmail,
    state: invitationState(record, now),
  };
}

type Cursor = { createdAt: Date; id: string };

function encodeCursor(record: { createdAt: Date; id: string }): string {
  return Buffer.from(
    JSON.stringify({
      createdAt: record.createdAt.toISOString(),
      id: record.id,
    }),
  ).toString("base64url");
}

function decodeCursor(value: string | undefined): Cursor | null | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("createdAt" in parsed) ||
      !("id" in parsed) ||
      typeof parsed.createdAt !== "string" ||
      typeof parsed.id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        parsed.id,
      )
    ) {
      return null;
    }
    const createdAt = new Date(parsed.createdAt);
    return Number.isNaN(createdAt.getTime()) ||
      createdAt.toISOString() !== parsed.createdAt
      ? null
      : { createdAt, id: parsed.id };
  } catch {
    return null;
  }
}

function afterCursor(cursor: Cursor | undefined) {
  return cursor === undefined
    ? undefined
    : {
        OR: [
          { createdAt: { gt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { gt: cursor.id } },
        ],
      };
}

async function lockOrganization(
  transaction: Transaction,
  organizationId: string,
): Promise<boolean> {
  const rows = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "organizations"
    WHERE "id" = ${organizationId}::uuid AND "status" = 'ACTIVE'
    FOR UPDATE
  `);
  return rows.length === 1;
}

async function lockInvitation(
  transaction: Transaction,
  invitationId: string,
): Promise<void> {
  await transaction.$queryRaw(Prisma.sql`
    SELECT "id" FROM "invitations" WHERE "id" = ${invitationId}::uuid FOR UPDATE
  `);
}

async function authorization(
  transaction: Transaction,
  actorUserId: string,
  organizationId: string,
): Promise<{
  context: TrustedAuthorizationContext;
  membershipId: string;
  role: OrganizationRole;
} | null> {
  const membership = await transaction.organizationMembership.findUnique({
    where: { organizationId_userId: { organizationId, userId: actorUserId } },
    select: {
      branchAssignments: {
        select: {
          branchId: true,
          organizationId: true,
          status: true,
          userId: true,
        },
      },
      id: true,
      organization: { select: { status: true } },
      organizationId: true,
      role: true,
      status: true,
      user: { select: { id: true, status: true } },
      userId: true,
    },
  });
  if (membership === null || membership.organization.status !== "ACTIVE")
    return null;
  const state: ResolvedAuthorizationState = {
    actor: membership.user,
    branchAssignments: membership.branchAssignments,
    membership: {
      organizationId: membership.organizationId,
      role: membership.role,
      status: membership.status,
      userId: membership.userId,
    },
  };
  const context = createTrustedAuthorizationContext(state);
  return context === null
    ? null
    : { context, membershipId: membership.id, role: membership.role };
}

function canManageRole(
  context: TrustedAuthorizationContext,
  organizationId: string,
  currentRole: OrganizationRole | null,
  desiredRole: OrganizationRole,
): boolean {
  const permission =
    currentRole === "OWNER" || desiredRole === "OWNER"
      ? PERMISSIONS.OWNER_MEMBERSHIP_MANAGE
      : PERMISSIONS.NON_OWNER_MEMBERSHIP_MANAGE;
  return can(
    context,
    permission,
    createTrustedOrganizationScope(organizationId),
  );
}

function canViewManagement(
  context: TrustedAuthorizationContext,
  organizationId: string,
): boolean {
  return can(
    context,
    PERMISSIONS.MEMBERSHIP_VIEW,
    createTrustedOrganizationScope(organizationId),
  );
}

async function validBranchScope(
  transaction: Transaction,
  organizationId: string,
  role: OrganizationRole,
  branchIds: readonly string[],
): Promise<boolean> {
  if (!BRANCH_ROLES.has(role)) return branchIds.length === 0;
  if (branchIds.length === 0 || new Set(branchIds).size !== branchIds.length)
    return false;
  const count = await transaction.branch.count({
    where: { id: { in: [...branchIds] }, organizationId, status: "ACTIVE" },
  });
  return count === branchIds.length;
}

function nextUpdatedAt(expected: Date, occurredAt: Date): Date {
  return new Date(Math.max(expected.getTime() + 1, occurredAt.getTime()));
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((id) => rightSet.has(id));
}

async function applyAssignmentReplacement(
  transaction: Transaction,
  input: {
    branchIds: readonly string[];
    membershipId: string;
    now: Date;
    organizationId: string;
    role: OrganizationRole;
    userId: string;
  },
): Promise<void> {
  const desired = BRANCH_ROLES.has(input.role) ? [...input.branchIds] : [];
  await transaction.branchAssignment.updateMany({
    where: {
      organizationId: input.organizationId,
      status: "ACTIVE",
      userId: input.userId,
      ...(desired.length === 0 ? {} : { branchId: { notIn: desired } }),
    },
    data: { deactivatedAt: input.now, status: "INACTIVE" },
  });
  for (const branchId of desired) {
    await transaction.branchAssignment.upsert({
      where: {
        organizationId_userId_branchId: {
          branchId,
          organizationId: input.organizationId,
          userId: input.userId,
        },
      },
      create: {
        branchId,
        organizationId: input.organizationId,
        status: "ACTIVE",
        userId: input.userId,
      },
      update: { deactivatedAt: null, status: "ACTIVE" },
    });
  }
  void input.membershipId;
}

async function createAccessEvent(
  transaction: Transaction,
  input: {
    actorMembershipId: string | null;
    actorUserId: string;
    afterRole: OrganizationRole;
    afterStatus: "ACTIVE" | "INACTIVE";
    beforeRole: OrganizationRole | null;
    beforeStatus: "ACTIVE" | "INACTIVE" | null;
    branchIds: readonly string[];
    eventType:
      | "INVITATION_ACCEPTED"
      | "ROLE_SCOPE_REPLACED"
      | "DEACTIVATED"
      | "REACTIVATED";
    occurredAt: Date;
    organizationId: string;
    targetMembershipId: string;
  },
): Promise<void> {
  const event = await transaction.membershipAccessEvent.create({
    data: {
      actorMembershipId: input.actorMembershipId,
      actorUserId: input.actorUserId,
      afterRole: input.afterRole,
      afterStatus: input.afterStatus,
      beforeRole: input.beforeRole,
      beforeStatus: input.beforeStatus,
      eventType: input.eventType,
      occurredAt: input.occurredAt,
      organizationId: input.organizationId,
      targetMembershipId: input.targetMembershipId,
    },
    select: { id: true },
  });
  if (input.branchIds.length > 0) {
    await transaction.membershipAccessEventBranchScope.createMany({
      data: input.branchIds.map((branchId) => ({
        branchId,
        eventId: event.id,
        organizationId: input.organizationId,
      })),
    });
  }
}

async function readSafeMembership(
  transaction: Transaction,
  organizationId: string,
  membershipId: string,
): Promise<SafeMembership> {
  const record = await transaction.organizationMembership.findUniqueOrThrow({
    where: { organizationId_id: { id: membershipId, organizationId } },
    select: membershipSelection,
  });
  return safeMembership(record);
}

function isTokenHashConflict(error: unknown): boolean {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== "P2002"
  )
    return false;
  return (
    JSON.stringify(error.meta ?? {}).includes("token_hash") ||
    JSON.stringify(error.meta ?? {}).includes("tokenHash")
  );
}

export function createPrismaMembershipAccessRepository(
  prisma: PrismaClient,
): MembershipAccessRepository {
  return {
    async issueInvitation(input) {
      try {
        return await prisma.$transaction(async (transaction) => {
          if (!(await lockOrganization(transaction, input.organizationId))) {
            return { kind: "forbidden" } as const;
          }
          const actor = await authorization(
            transaction,
            input.actorUserId,
            input.organizationId,
          );
          if (
            actor === null ||
            !canManageRole(
              actor.context,
              input.organizationId,
              null,
              input.invitation.role,
            )
          ) {
            return { kind: "forbidden" } as const;
          }
          if (
            !(await validBranchScope(
              transaction,
              input.organizationId,
              input.invitation.role,
              input.invitation.branchIds,
            ))
          ) {
            return { kind: "invalid_branch_scope" } as const;
          }
          const existingMembership =
            await transaction.organizationMembership.findFirst({
              where: {
                organizationId: input.organizationId,
                user: { email: input.invitation.email },
              },
              select: { id: true, status: true },
            });
          if (existingMembership !== null) {
            return {
              kind: "membership_exists",
              status: existingMembership.status,
            } as const;
          }

          const replaceableInvitationWhere = {
            consumedAt: null,
            invitedEmail: input.invitation.email,
            organizationId: input.organizationId,
            replacedAt: null,
            revokedAt: null,
          };
          const replaceableInvitations = await transaction.invitation.findMany({
            where: replaceableInvitationWhere,
            select: { intendedRole: true },
          });
          if (
            replaceableInvitations.some(
              ({ intendedRole }) =>
                !canManageRole(
                  actor.context,
                  input.organizationId,
                  intendedRole,
                  input.invitation.role,
                ),
            )
          ) {
            return { kind: "forbidden" } as const;
          }

          await transaction.invitation.updateMany({
            where: replaceableInvitationWhere,
            data: {
              replacedAt: input.issuedAt,
              revocationReason: "REPLACED",
              revokedByMembershipId: actor.membershipId,
            },
          });
          const invitationRoot = await transaction.invitation.create({
            data: {
              expiresAt: input.expiresAt,
              intendedRole: input.invitation.role,
              invitedEmail: input.invitation.email,
              issuedAt: input.issuedAt,
              issuedByMembershipId: actor.membershipId,
              organizationId: input.organizationId,
              tokenHash: input.tokenHash,
            },
            select: { id: true },
          });
          if (input.invitation.branchIds.length > 0) {
            await transaction.invitationBranchScope.createMany({
              data: input.invitation.branchIds.map((branchId) => ({
                branchId,
                invitationId: invitationRoot.id,
                organizationId: input.organizationId,
              })),
            });
          }
          const created = await transaction.invitation.findUniqueOrThrow({
            where: { id: invitationRoot.id },
            select: invitationSelection,
          });
          return {
            invitation: safeInvitation(created, input.issuedAt),
            invitationId: created.id,
            kind: "success",
            recipient: input.invitation.email,
          } as const;
        });
      } catch (error: unknown) {
        if (isTokenHashConflict(error)) throw new OneTimeTokenCollisionError();
        throw error;
      }
    },

    async revokeInvitationAfterDeliveryFailure({ invitationId, revokedAt }) {
      await prisma.invitation.updateMany({
        where: {
          consumedAt: null,
          id: invitationId,
          replacedAt: null,
          revokedAt: null,
        },
        data: { revocationReason: "DELIVERY_FAILED", revokedAt },
      });
    },

    async acceptInvitation(input) {
      const candidate = await prisma.invitation.findUnique({
        where: { tokenHash: input.tokenHash },
        select: { id: true, organizationId: true },
      });
      if (candidate === null) return { kind: "invalid_invitation" };

      return prisma.$transaction(async (transaction) => {
        if (!(await lockOrganization(transaction, candidate.organizationId))) {
          return { kind: "invalid_invitation" } as const;
        }
        await lockInvitation(transaction, candidate.id);
        const invitation = await transaction.invitation.findUnique({
          where: { id: candidate.id },
          select: {
            acceptedByUserId: true,
            branchScopes: { select: { branchId: true } },
            consumedAt: true,
            expiresAt: true,
            id: true,
            intendedRole: true,
            invitedEmail: true,
            organizationId: true,
            replacedAt: true,
            revokedAt: true,
            tokenHash: true,
          },
        });
        if (invitation === null || invitation.tokenHash !== input.tokenHash) {
          return { kind: "invalid_invitation" } as const;
        }

        if (invitation.consumedAt !== null) {
          if (
            invitation.acceptedByUserId !== input.actorUserId ||
            invitation.invitedEmail !== input.actorEmail
          ) {
            return { kind: "invalid_invitation" } as const;
          }
          const replay = await transaction.organizationMembership.findFirst({
            where: {
              organizationId: invitation.organizationId,
              sourceInvitationId: invitation.id,
              userId: input.actorUserId,
            },
            select: membershipSelection,
          });
          return replay === null
            ? ({ kind: "invalid_invitation" } as const)
            : ({
                kind: "success",
                membership: safeMembership(replay),
                replayed: true,
              } as const);
        }

        if (
          invitation.revokedAt !== null ||
          invitation.replacedAt !== null ||
          input.acceptedAt >= invitation.expiresAt ||
          invitation.invitedEmail !== input.actorEmail
        ) {
          return { kind: "invalid_invitation" } as const;
        }

        const branchIds = invitation.branchScopes.map(
          ({ branchId }) => branchId,
        );
        if (
          !(await validBranchScope(
            transaction,
            invitation.organizationId,
            invitation.intendedRole,
            branchIds,
          ))
        ) {
          return { kind: "invalid_scope" } as const;
        }

        const existing = await transaction.organizationMembership.findUnique({
          where: {
            organizationId_userId: {
              organizationId: invitation.organizationId,
              userId: input.actorUserId,
            },
          },
          select: { id: true },
        });
        if (existing !== null) {
          await transaction.invitation.update({
            where: { id: invitation.id },
            data: {
              revocationReason: "MEMBERSHIP_EXISTS",
              revokedAt: input.acceptedAt,
            },
          });
          return { kind: "membership_exists" } as const;
        }

        const membership = await transaction.organizationMembership.create({
          data: {
            organizationId: invitation.organizationId,
            role: invitation.intendedRole,
            sourceInvitationId: invitation.id,
            userId: input.actorUserId,
          },
          select: { id: true },
        });
        if (branchIds.length > 0) {
          await transaction.branchAssignment.createMany({
            data: branchIds.map((branchId) => ({
              branchId,
              organizationId: invitation.organizationId,
              userId: input.actorUserId,
            })),
          });
        }
        const consumed = await transaction.invitation.updateMany({
          where: {
            consumedAt: null,
            id: invitation.id,
            replacedAt: null,
            revokedAt: null,
          },
          data: {
            acceptedByUserId: input.actorUserId,
            consumedAt: input.acceptedAt,
          },
        });
        if (consumed.count !== 1)
          throw new Error("Invitation state changed during acceptance.");
        await createAccessEvent(transaction, {
          actorMembershipId: membership.id,
          actorUserId: input.actorUserId,
          afterRole: invitation.intendedRole,
          afterStatus: "ACTIVE",
          beforeRole: null,
          beforeStatus: null,
          branchIds,
          eventType: "INVITATION_ACCEPTED",
          occurredAt: input.acceptedAt,
          organizationId: invitation.organizationId,
          targetMembershipId: membership.id,
        });
        return {
          kind: "success",
          membership: await readSafeMembership(
            transaction,
            invitation.organizationId,
            membership.id,
          ),
          replayed: false,
        } as const;
      });
    },

    async revokeInvitation(input) {
      return prisma.$transaction(async (transaction) => {
        if (!(await lockOrganization(transaction, input.organizationId)))
          return { kind: "forbidden" } as const;
        const actor = await authorization(
          transaction,
          input.actorUserId,
          input.organizationId,
        );
        if (actor === null) return { kind: "forbidden" } as const;
        await lockInvitation(transaction, input.invitationId);
        const invitation = await transaction.invitation.findFirst({
          where: {
            id: input.invitationId,
            organizationId: input.organizationId,
          },
          select: invitationSelection,
        });
        if (
          invitation === null ||
          !canManageRole(
            actor.context,
            input.organizationId,
            invitation.intendedRole,
            invitation.intendedRole,
          )
        ) {
          return { kind: "forbidden" } as const;
        }
        if (invitation.consumedAt !== null)
          return { kind: "finalized" } as const;
        if (
          invitation.revokedAt !== null ||
          invitation.replacedAt !== null ||
          input.now >= invitation.expiresAt
        ) {
          return {
            kind: "success",
            invitation: safeInvitation(invitation, input.now),
          } as const;
        }
        await transaction.invitation.update({
          where: { id: invitation.id },
          data: {
            revocationReason: "CANCELLED",
            revokedAt: input.now,
            revokedByMembershipId: actor.membershipId,
          },
        });
        const updated = await transaction.invitation.findUniqueOrThrow({
          where: { id: invitation.id },
          select: invitationSelection,
        });
        return {
          kind: "success",
          invitation: safeInvitation(updated, input.now),
        } as const;
      });
    },

    async listMemberships(input) {
      const cursor = decodeCursor(input.cursor);
      if (cursor === null) return { kind: "invalid_cursor" };
      return prisma.$transaction(async (transaction) => {
        const actor = await authorization(
          transaction,
          input.actorUserId,
          input.organizationId,
        );
        if (
          actor === null ||
          !canViewManagement(actor.context, input.organizationId)
        ) {
          return { kind: "forbidden" } as const;
        }
        const records = await transaction.organizationMembership.findMany({
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: input.limit + 1,
          where: {
            organizationId: input.organizationId,
            ...(input.includeInactive ? {} : { status: "ACTIVE" as const }),
            ...afterCursor(cursor),
          },
          select: membershipSelection,
        });
        const hasMore = records.length > input.limit;
        const selected = records.slice(0, input.limit);
        return {
          kind: "success",
          page: {
            items: selected.map(safeMembership),
            nextCursor: hasMore ? encodeCursor(selected.at(-1)!) : null,
          },
        } as const;
      });
    },

    async listInvitations(input) {
      const cursor = decodeCursor(input.cursor);
      if (cursor === null) return { kind: "invalid_cursor" };
      return prisma.$transaction(async (transaction) => {
        const actor = await authorization(
          transaction,
          input.actorUserId,
          input.organizationId,
        );
        if (
          actor === null ||
          !canViewManagement(actor.context, input.organizationId)
        ) {
          return { kind: "forbidden" } as const;
        }
        const records = await transaction.invitation.findMany({
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: input.limit + 1,
          where: {
            consumedAt: null,
            organizationId: input.organizationId,
            replacedAt: null,
            revokedAt: null,
            ...afterCursor(cursor),
          },
          select: invitationSelection,
        });
        const hasMore = records.length > input.limit;
        const selected = records.slice(0, input.limit);
        return {
          kind: "success",
          page: {
            items: selected.map((record) => safeInvitation(record, input.now)),
            nextCursor: hasMore ? encodeCursor(selected.at(-1)!) : null,
          },
        } as const;
      });
    },

    async replaceMembership(input) {
      return mutateMembership(prisma, { ...input, mode: "replace" });
    },

    async deactivateMembership(input) {
      return mutateMembership(prisma, { ...input, mode: "deactivate" });
    },

    async reactivateMembership(input) {
      return mutateMembership(prisma, { ...input, mode: "reactivate" });
    },
  };
}

type MutationInput =
  | {
      actorUserId: string;
      membershipId: string;
      mode: "replace" | "reactivate";
      organizationId: string;
      occurredAt: Date;
      replacement: MembershipReplaceInput;
    }
  | {
      actorUserId: string;
      expectedUpdatedAt: Date;
      membershipId: string;
      mode: "deactivate";
      organizationId: string;
      occurredAt: Date;
    };

async function mutateMembership(
  prisma: PrismaClient,
  input: MutationInput,
): Promise<MembershipMutationOutcome> {
  return prisma.$transaction(async (transaction) => {
    if (!(await lockOrganization(transaction, input.organizationId)))
      return { kind: "forbidden" };
    const actor = await authorization(
      transaction,
      input.actorUserId,
      input.organizationId,
    );
    if (actor === null) return { kind: "forbidden" };
    const target = await transaction.organizationMembership.findUnique({
      where: {
        organizationId_id: {
          id: input.membershipId,
          organizationId: input.organizationId,
        },
      },
      select: {
        branchAssignments: { select: { branchId: true, status: true } },
        id: true,
        role: true,
        status: true,
        updatedAt: true,
        userId: true,
      },
    });
    if (target === null) return { kind: "not_found" };
    // Only an OWNER may change or leave their own membership (still bound by
    // the last-owner rule); every other actor, ADMIN included, may not.
    if (target.userId === input.actorUserId && actor.role !== "OWNER") {
      return { kind: "self_modification" };
    }
    const desiredRole =
      input.mode === "deactivate" ? target.role : input.replacement.role;
    if (
      !canManageRole(
        actor.context,
        input.organizationId,
        target.role,
        desiredRole,
      )
    ) {
      return { kind: "forbidden" };
    }
    const expectedUpdatedAt =
      input.mode === "deactivate"
        ? input.expectedUpdatedAt
        : input.replacement.expectedUpdatedAt;
    if (target.updatedAt.getTime() !== expectedUpdatedAt.getTime())
      return { kind: "stale" };

    if (input.mode === "deactivate") {
      if (target.status === "INACTIVE") {
        return {
          kind: "success",
          membership: await readSafeMembership(
            transaction,
            input.organizationId,
            target.id,
          ),
        };
      }
      if (target.role === "OWNER") {
        const activeOwners = await transaction.organizationMembership.count({
          where: {
            organizationId: input.organizationId,
            role: "OWNER",
            status: "ACTIVE",
          },
        });
        if (activeOwners <= 1) return { kind: "last_active_owner" };
      }
      const updatedAt = nextUpdatedAt(target.updatedAt, input.occurredAt);
      await transaction.organizationMembership.update({
        where: {
          organizationId_id: {
            id: target.id,
            organizationId: input.organizationId,
          },
        },
        data: {
          deactivatedAt: input.occurredAt,
          status: "INACTIVE",
          updatedAt,
        },
      });
      await createAccessEvent(transaction, {
        actorMembershipId: actor.membershipId,
        actorUserId: input.actorUserId,
        afterRole: target.role,
        afterStatus: "INACTIVE",
        beforeRole: target.role,
        beforeStatus: "ACTIVE",
        branchIds: target.branchAssignments
          .filter(({ status }) => status === "ACTIVE")
          .map(({ branchId }) => branchId),
        eventType: "DEACTIVATED",
        occurredAt: input.occurredAt,
        organizationId: input.organizationId,
        targetMembershipId: target.id,
      });
      return {
        kind: "success",
        membership: await readSafeMembership(
          transaction,
          input.organizationId,
          target.id,
        ),
      };
    }

    if (input.mode === "replace" && target.status !== "ACTIVE")
      return { kind: "inactive" };
    if (
      input.mode === "reactivate" &&
      target.status === "ACTIVE" &&
      (target.role !== input.replacement.role ||
        !sameIds(
          target.branchAssignments
            .filter(({ status }) => status === "ACTIVE")
            .map(({ branchId }) => branchId),
          BRANCH_ROLES.has(input.replacement.role)
            ? input.replacement.branchIds
            : [],
        ))
    ) {
      return { kind: "already_active" };
    }
    if (
      !(await validBranchScope(
        transaction,
        input.organizationId,
        input.replacement.role,
        input.replacement.branchIds,
      ))
    ) {
      return { kind: "invalid_branch_scope" };
    }
    const currentActiveBranchIds = target.branchAssignments
      .filter(({ status }) => status === "ACTIVE")
      .map(({ branchId }) => branchId);
    const desiredBranchIds = BRANCH_ROLES.has(input.replacement.role)
      ? input.replacement.branchIds
      : [];
    const desiredStatus = "ACTIVE" as const;
    const noOp =
      target.status === desiredStatus &&
      target.role === input.replacement.role &&
      sameIds(currentActiveBranchIds, desiredBranchIds);
    if (noOp) {
      return {
        kind: "success",
        membership: await readSafeMembership(
          transaction,
          input.organizationId,
          target.id,
        ),
      };
    }
    if (
      target.status === "ACTIVE" &&
      target.role === "OWNER" &&
      input.replacement.role !== "OWNER"
    ) {
      const activeOwners = await transaction.organizationMembership.count({
        where: {
          organizationId: input.organizationId,
          role: "OWNER",
          status: "ACTIVE",
        },
      });
      if (activeOwners <= 1) return { kind: "last_active_owner" };
    }
    await applyAssignmentReplacement(transaction, {
      branchIds: desiredBranchIds,
      membershipId: target.id,
      now: input.occurredAt,
      organizationId: input.organizationId,
      role: input.replacement.role,
      userId: target.userId,
    });
    const updatedAt = nextUpdatedAt(target.updatedAt, input.occurredAt);
    await transaction.organizationMembership.update({
      where: {
        organizationId_id: {
          id: target.id,
          organizationId: input.organizationId,
        },
      },
      data: {
        deactivatedAt: null,
        role: input.replacement.role,
        status: "ACTIVE",
        updatedAt,
      },
    });
    await createAccessEvent(transaction, {
      actorMembershipId: actor.membershipId,
      actorUserId: input.actorUserId,
      afterRole: input.replacement.role,
      afterStatus: "ACTIVE",
      beforeRole: target.role,
      beforeStatus: target.status,
      branchIds: desiredBranchIds,
      eventType:
        input.mode === "reactivate" ? "REACTIVATED" : "ROLE_SCOPE_REPLACED",
      occurredAt: input.occurredAt,
      organizationId: input.organizationId,
      targetMembershipId: target.id,
    });
    return {
      kind: "success",
      membership: await readSafeMembership(
        transaction,
        input.organizationId,
        target.id,
      ),
    };
  });
}
