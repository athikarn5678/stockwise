import { Prisma, type PrismaClient } from "../../generated/prisma/client.ts";
import {
  can,
  createTrustedAuthorizationContext,
  createTrustedOrganizationScope,
  PERMISSIONS,
  type ResolvedAuthorizationState,
  type TrustedAuthorizationContext,
} from "../identity/authorization-policy.ts";
import type { OrganizationNameUpdate } from "./organization-settings-schema.ts";

export interface SafeOrganizationSettings {
  id: string;
  name: string;
  updatedAt: string;
}

export type OrganizationSettingsOutcome =
  | { kind: "success"; organization: SafeOrganizationSettings }
  | { kind: "forbidden" }
  | { kind: "stale" };

export interface OrganizationSettingsRepository {
  get(
    actorUserId: string,
    organizationId: string,
  ): Promise<OrganizationSettingsOutcome>;
  update(
    actorUserId: string,
    organizationId: string,
    input: OrganizationNameUpdate,
  ): Promise<OrganizationSettingsOutcome>;
}

type OrganizationSettingsPrismaClient = Pick<
  PrismaClient,
  "$transaction" | "organization" | "organizationMembership"
>;
type Transaction = Prisma.TransactionClient;

const settingsSelect = { id: true, name: true, updatedAt: true } as const;

function safeOrganization(organization: {
  id: string;
  name: string;
  updatedAt: Date;
}): SafeOrganizationSettings {
  return {
    id: organization.id,
    name: organization.name,
    updatedAt: organization.updatedAt.toISOString(),
  };
}

async function lockOrganization(
  transaction: Transaction,
  organizationId: string,
): Promise<boolean> {
  const rows = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "organizations"
    WHERE "id" = ${organizationId}::uuid AND "status" = 'ACTIVE'
    FOR UPDATE
  `);
  return rows.length === 1;
}
async function lockMembership(
  transaction: Transaction,
  actorUserId: string,
  organizationId: string,
): Promise<void> {
  await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "organization_memberships"
    WHERE "user_id" = ${actorUserId}::uuid AND "organization_id" = ${organizationId}::uuid
    FOR UPDATE
  `);
}
async function lockActor(
  transaction: Transaction,
  actorUserId: string,
): Promise<void> {
  await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "users"
    WHERE "id" = ${actorUserId}::uuid
    FOR SHARE
  `);
}

async function authorizationContext(
  transaction: Transaction,
  actorUserId: string,
  organizationId: string,
): Promise<TrustedAuthorizationContext | null> {
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
      organization: { select: { status: true } },
      role: true,
      status: true,
      user: { select: { emailVerifiedAt: true, id: true, status: true } },
      userId: true,
      organizationId: true,
    },
  });
  if (
    membership === null ||
    membership.organization.status !== "ACTIVE" ||
    membership.user.emailVerifiedAt === null
  )
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
  return createTrustedAuthorizationContext(state);
}

function canManage(
  context: TrustedAuthorizationContext | null,
  organizationId: string,
): boolean {
  return can(
    context,
    PERMISSIONS.ORGANIZATION_SETTINGS_MANAGE,
    createTrustedOrganizationScope(organizationId),
  );
}

export function createPrismaOrganizationSettingsRepository(
  prisma: OrganizationSettingsPrismaClient,
  now: () => Date = () => new Date(),
): OrganizationSettingsRepository {
  return {
    async get(actorUserId, organizationId) {
      return prisma.$transaction(async (transaction) => {
        await lockActor(transaction, actorUserId);
        if (!(await lockOrganization(transaction, organizationId)))
          return { kind: "forbidden" };
        await lockMembership(transaction, actorUserId, organizationId);
        const context = await authorizationContext(
          transaction,
          actorUserId,
          organizationId,
        );
        if (!canManage(context, organizationId)) return { kind: "forbidden" };
        const organization = await transaction.organization.findUnique({
          where: { id: organizationId },
          select: settingsSelect,
        });
        return organization === null
          ? { kind: "forbidden" }
          : { kind: "success", organization: safeOrganization(organization) };
      });
    },
    async update(actorUserId, organizationId, input) {
      return prisma.$transaction(async (transaction) => {
        await lockActor(transaction, actorUserId);
        if (!(await lockOrganization(transaction, organizationId)))
          return { kind: "forbidden" };
        await lockMembership(transaction, actorUserId, organizationId);
        const context = await authorizationContext(
          transaction,
          actorUserId,
          organizationId,
        );
        if (!canManage(context, organizationId)) return { kind: "forbidden" };
        const updatedAt = new Date(
          Math.max(input.expectedUpdatedAt.getTime() + 1, now().getTime()),
        );
        const changed = await transaction.organization.updateMany({
          where: {
            id: organizationId,
            status: "ACTIVE",
            updatedAt: input.expectedUpdatedAt,
          },
          data: { name: input.name, updatedAt },
        });
        if (changed.count === 0) return { kind: "stale" };
        const organization = await transaction.organization.findUniqueOrThrow({
          where: { id: organizationId },
          select: settingsSelect,
        });
        return {
          kind: "success",
          organization: safeOrganization(organization),
        };
      });
    },
  };
}
