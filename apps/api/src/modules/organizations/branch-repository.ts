import { Prisma, type PrismaClient } from "../../generated/prisma/client.ts";
import {
  can,
  createTrustedAuthorizationContext,
  createTrustedOrganizationScope,
  PERMISSIONS,
  type ResolvedAuthorizationState,
  type TrustedAuthorizationContext,
} from "../identity/authorization-policy.ts";
import { firstOrganizationOnboardingIsEligible } from "../identity/first-organization-onboarding-repository.ts";
import type { BranchCreateInput, BranchUpdateInput } from "./branch-schemas.ts";

export interface SafeBranch {
  address: string | null;
  code: string;
  id: string;
  name: string;
  organizationId: string;
  phone: string | null;
  status: "ACTIVE" | "INACTIVE";
  updatedAt: string;
}

export interface AccessContextResult {
  firstOrganizationOnboarding: { eligible: boolean };
  organizations: Array<{
    branches: Array<Pick<SafeBranch, "code" | "id" | "name">>;
    id: string;
    name: string;
    role: "OWNER" | "ADMIN" | "BRANCH_MANAGER" | "INVENTORY_STAFF" | "CASHIER";
  }>;
  user: {
    displayName: string | null;
    email: string;
    id: string;
  };
}

export type BranchMutationOutcome =
  | { kind: "success"; branch: SafeBranch }
  | { kind: "forbidden" }
  | { kind: "not_found" }
  | { kind: "stale" }
  | { kind: "code_conflict" }
  | { kind: "last_active_branch" };

export type BranchListOutcome =
  { kind: "success"; branches: SafeBranch[] } | { kind: "forbidden" };

export interface BranchRepository {
  accessContext(actorUserId: string): Promise<AccessContextResult | null>;
  create(
    actorUserId: string,
    organizationId: string,
    input: BranchCreateInput,
  ): Promise<BranchMutationOutcome>;
  list(
    actorUserId: string,
    organizationId: string,
    includeInactive: boolean,
  ): Promise<BranchListOutcome>;
  setLifecycle(input: {
    actorUserId: string;
    branchId: string;
    expectedUpdatedAt: Date;
    organizationId: string;
    status: "ACTIVE" | "INACTIVE";
  }): Promise<BranchMutationOutcome>;
  update(
    actorUserId: string,
    organizationId: string,
    branchId: string,
    input: BranchUpdateInput,
  ): Promise<BranchMutationOutcome>;
}

type BranchPrismaClient = Pick<
  PrismaClient,
  "$transaction" | "branch" | "organizationMembership" | "user"
>;
type Transaction = Prisma.TransactionClient;

type AuthorizationClient = {
  organizationMembership: Pick<
    Transaction["organizationMembership"],
    "findUnique"
  >;
};

const branchSelection = {
  address: true,
  code: true,
  id: true,
  name: true,
  organizationId: true,
  phone: true,
  status: true,
  updatedAt: true,
} as const;

function safeBranch(branch: {
  address: string | null;
  code: string;
  id: string;
  name: string;
  organizationId: string;
  phone: string | null;
  status: "ACTIVE" | "INACTIVE";
  updatedAt: Date;
}): SafeBranch {
  return { ...branch, updatedAt: branch.updatedAt.toISOString() };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isBranchCodeTarget(target: unknown): boolean {
  if (typeof target === "string") {
    return (
      target === "branches_organization_id_code_key" ||
      target === "organizationId_code" ||
      target === "organization_id_code"
    );
  }

  return (
    Array.isArray(target) &&
    target.includes("code") &&
    (target.includes("organizationId") || target.includes("organization_id"))
  );
}

function hasDriverBranchCodeConstraint(meta: unknown): boolean {
  if (!isRecord(meta) || !isRecord(meta.driverAdapterError)) {
    return false;
  }

  const cause = meta.driverAdapterError.cause;
  return (
    isRecord(cause) &&
    cause.kind === "UniqueConstraintViolation" &&
    isRecord(cause.constraint) &&
    isBranchCodeTarget(cause.constraint.fields)
  );
}

async function nextGeneratedBranchCode(
  transaction: Prisma.TransactionClient,
  organizationId: string,
): Promise<string> {
  const rows = await transaction.branch.findMany({
    select: { code: true },
    where: { code: { startsWith: "BR-" }, organizationId },
  });
  let highest = 0;
  for (const { code } of rows) {
    const match = /^BR-([0-9]{1,12})$/.exec(code);
    if (match?.[1] !== undefined) highest = Math.max(highest, Number(match[1]));
  }
  return `BR-${String(highest + 1).padStart(3, "0")}`;
}

export function isBranchCodeConflict(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002" &&
    (isBranchCodeTarget(error.meta?.target) ||
      hasDriverBranchCodeConstraint(error.meta))
  );
}

async function authorizationContext(
  client: AuthorizationClient,
  actorUserId: string,
  organizationId: string,
): Promise<TrustedAuthorizationContext | null> {
  const membership = await client.organizationMembership.findUnique({
    where: {
      organizationId_userId: { organizationId, userId: actorUserId },
    },
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
      user: { select: { id: true, status: true } },
      userId: true,
      organizationId: true,
    },
  });

  if (membership === null || membership.organization.status !== "ACTIVE") {
    return null;
  }

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

function nextUpdatedAt(expectedUpdatedAt: Date, currentTime: Date): Date {
  return new Date(
    Math.max(expectedUpdatedAt.getTime() + 1, currentTime.getTime()),
  );
}

function canManage(
  context: TrustedAuthorizationContext | null,
  organizationId: string,
): boolean {
  return can(
    context,
    PERMISSIONS.BRANCH_MANAGE,
    createTrustedOrganizationScope(organizationId),
  );
}

async function lockOrganization(
  transaction: Transaction,
  organizationId: string,
): Promise<boolean> {
  const rows = await transaction.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT "id"
    FROM "organizations"
    WHERE "id" = ${organizationId}::uuid
      AND "status" = 'ACTIVE'
    FOR UPDATE
  `);
  return rows.length === 1;
}

export function createPrismaBranchRepository(
  prisma: BranchPrismaClient,
  now: () => Date = () => new Date(),
): BranchRepository {
  async function createOnce(
    actorUserId: string,
    organizationId: string,
    input: BranchCreateInput,
  ): Promise<BranchMutationOutcome> {
    try {
      return await prisma.$transaction(async (transaction) => {
        if (!(await lockOrganization(transaction, organizationId))) {
          return { kind: "forbidden" } as const;
        }

        const context = await authorizationContext(
          transaction,
          actorUserId,
          organizationId,
        );
        if (!canManage(context, organizationId)) {
          return { kind: "forbidden" } as const;
        }

        // The organization-row lock above serializes generation, so two
        // concurrent requests cannot read the same maximum.
        const code =
          input.code ??
          (await nextGeneratedBranchCode(transaction, organizationId));
        const branch = await transaction.branch.create({
          data: {
            address: input.address,
            code,
            name: input.name,
            organizationId,
            phone: input.phone,
          },
          select: branchSelection,
        });
        return { kind: "success", branch: safeBranch(branch) } as const;
      });
    } catch (error: unknown) {
      if (isBranchCodeConflict(error)) {
        return { kind: "code_conflict" };
      }
      throw error;
    }
  }

  return {
    async accessContext(actorUserId) {
      const user = await prisma.user.findUnique({
        where: { id: actorUserId },
        select: {
          displayName: true,
          email: true,
          emailVerifiedAt: true,
          id: true,
          memberships: {
            select: {
              branchAssignments: {
                where: { branch: { status: "ACTIVE" }, status: "ACTIVE" },
                select: {
                  branch: { select: { code: true, id: true, name: true } },
                },
              },
              organization: {
                select: {
                  branches: {
                    where: { status: "ACTIVE" },
                    orderBy: [{ code: "asc" }, { id: "asc" }],
                    select: { code: true, id: true, name: true },
                  },
                  id: true,
                  name: true,
                  status: true,
                },
              },
              firstOrganizationOnboarding: { select: { userId: true } },
              role: true,
              status: true,
            },
          },
          status: true,
        },
      });

      if (
        user === null ||
        user.status !== "ACTIVE" ||
        user.emailVerifiedAt === null
      ) {
        return null;
      }

      const organizations = user.memberships
        .filter(
          (membership) =>
            membership.status === "ACTIVE" &&
            membership.organization.status === "ACTIVE",
        )
        .map((membership) => {
          const organizationWide =
            membership.role === "OWNER" || membership.role === "ADMIN";
          const branches = organizationWide
            ? membership.organization.branches
            : membership.branchAssignments.map(({ branch }) => branch);

          return {
            branches: [...branches].sort(
              (left, right) =>
                left.code.localeCompare(right.code) ||
                left.id.localeCompare(right.id),
            ),
            id: membership.organization.id,
            name: membership.organization.name,
            role: membership.role,
          };
        })
        .sort(
          (left, right) =>
            left.name.localeCompare(right.name) ||
            left.id.localeCompare(right.id),
        );

      return {
        firstOrganizationOnboarding: {
          eligible: firstOrganizationOnboardingIsEligible({
            membershipCount: user.memberships.length,
            onboardingProvenanceExists: user.memberships.some(
              ({ firstOrganizationOnboarding }) =>
                firstOrganizationOnboarding !== null,
            ),
          }),
        },
        organizations,
        user: {
          displayName: user.displayName,
          email: user.email,
          id: user.id,
        },
      };
    },

    async list(actorUserId, organizationId, includeInactive) {
      const context = await authorizationContext(
        prisma,
        actorUserId,
        organizationId,
      );
      if (context === null || context.membershipStatus !== "ACTIVE") {
        return { kind: "forbidden" };
      }

      const organizationWide =
        context.role === "OWNER" || context.role === "ADMIN";
      if (includeInactive && !canManage(context, organizationId)) {
        return { kind: "forbidden" };
      }

      const branches = await prisma.branch.findMany({
        where: {
          organizationId,
          ...(includeInactive ? {} : { status: "ACTIVE" as const }),
          ...(organizationWide
            ? {}
            : { id: { in: [...context.activeAssignedBranchIds] } }),
        },
        orderBy: [{ code: "asc" }, { id: "asc" }],
        select: branchSelection,
      });

      return { kind: "success", branches: branches.map(safeBranch) };
    },

    async create(actorUserId, organizationId, input) {
      // A generated code can lose a race: the snapshot that computed the next
      // number may predate a concurrent commit. The unique constraint stays
      // authoritative, so a generated code simply retries on conflict.
      const attempts = input.code === undefined ? 25 : 1;
      for (let attempt = 1; ; attempt += 1) {
        const outcome = await createOnce(actorUserId, organizationId, input);
        if (outcome.kind !== "code_conflict" || attempt >= attempts) {
          return outcome;
        }
      }
    },

    async update(actorUserId, organizationId, branchId, input) {
      return prisma.$transaction(async (transaction) => {
        if (!(await lockOrganization(transaction, organizationId))) {
          return { kind: "forbidden" };
        }
        const context = await authorizationContext(
          transaction,
          actorUserId,
          organizationId,
        );
        if (!canManage(context, organizationId)) {
          return { kind: "forbidden" };
        }

        const changedAt = nextUpdatedAt(input.expectedUpdatedAt, now());
        const update = await transaction.branch.updateMany({
          where: {
            id: branchId,
            organizationId,
            updatedAt: input.expectedUpdatedAt,
          },
          data: {
            ...(input.address === undefined ? {} : { address: input.address }),
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.phone === undefined ? {} : { phone: input.phone }),
            updatedAt: changedAt,
          },
        });
        if (update.count === 0) {
          const exists = await transaction.branch.findFirst({
            where: { id: branchId, organizationId },
            select: { id: true },
          });
          return exists === null ? { kind: "not_found" } : { kind: "stale" };
        }

        const branch = await transaction.branch.findFirstOrThrow({
          where: { id: branchId, organizationId },
          select: branchSelection,
        });
        return { kind: "success", branch: safeBranch(branch) };
      });
    },

    async setLifecycle({
      actorUserId,
      branchId,
      expectedUpdatedAt,
      organizationId,
      status,
    }) {
      return prisma.$transaction(async (transaction) => {
        if (!(await lockOrganization(transaction, organizationId))) {
          return { kind: "forbidden" };
        }
        const context = await authorizationContext(
          transaction,
          actorUserId,
          organizationId,
        );
        if (!canManage(context, organizationId)) {
          return { kind: "forbidden" };
        }

        const current = await transaction.branch.findFirst({
          where: { id: branchId, organizationId },
          select: branchSelection,
        });
        if (current === null) {
          return { kind: "not_found" };
        }
        if (current.updatedAt.getTime() !== expectedUpdatedAt.getTime()) {
          return { kind: "stale" };
        }
        if (current.status === status) {
          return { kind: "success", branch: safeBranch(current) };
        }

        if (status === "INACTIVE") {
          const activeCount = await transaction.branch.count({
            where: { organizationId, status: "ACTIVE" },
          });
          if (activeCount <= 1) {
            return { kind: "last_active_branch" };
          }
        }

        const changedAt = nextUpdatedAt(expectedUpdatedAt, now());
        const update = await transaction.branch.updateMany({
          where: { id: branchId, organizationId, updatedAt: expectedUpdatedAt },
          data: {
            deactivatedAt: status === "INACTIVE" ? changedAt : null,
            status,
            updatedAt: changedAt,
          },
        });
        if (update.count === 0) {
          return { kind: "stale" };
        }

        const branch = await transaction.branch.findFirstOrThrow({
          where: { id: branchId, organizationId },
          select: branchSelection,
        });
        return { kind: "success", branch: safeBranch(branch) };
      });
    },
  };
}
