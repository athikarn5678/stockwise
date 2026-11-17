import {
  Prisma,
  type OrganizationSubscription,
  type PrismaClient,
} from "../../generated/prisma/client.ts";
import {
  can,
  createTrustedAuthorizationContext,
  createTrustedOrganizationScope,
  PERMISSIONS,
} from "../identity/authorization-policy.ts";
import type { BillingPlan } from "./billing-plans.ts";

export type BillingAccess = "owner" | "member" | null;

export type PublicSubscription = Readonly<{
  plan: BillingPlan;
  status: OrganizationSubscription["status"];
}>;

export type SaveConfirmedInput = Readonly<{
  customerId: string;
  organizationId: string;
  plan: BillingPlan;
  sessionId: string;
  subscriptionId: string;
}>;

export type SaveConfirmedResult =
  | Readonly<{ kind: "saved"; subscription: PublicSubscription }>
  | Readonly<{ kind: "conflict" }>;

function publicSubscription(row: OrganizationSubscription): PublicSubscription {
  return { plan: row.plan, status: row.status };
}

export function createPrismaBillingRepository(prisma: PrismaClient) {
  return {
    /** `owner` may manage billing; any other active member may only read the plan. */
    async authorize(
      actorUserId: string,
      organizationId: string,
    ): Promise<BillingAccess> {
      const membership = await prisma.organizationMembership.findUnique({
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
          organizationId: true,
          role: true,
          status: true,
          user: { select: { emailVerifiedAt: true, id: true, status: true } },
          userId: true,
        },
      });
      if (
        membership === null ||
        membership.organization.status !== "ACTIVE" ||
        membership.status !== "ACTIVE" ||
        membership.user.status !== "ACTIVE" ||
        membership.user.emailVerifiedAt === null
      )
        return null;
      const context = createTrustedAuthorizationContext({
        actor: membership.user,
        branchAssignments: membership.branchAssignments,
        membership,
      });
      return can(
        context,
        PERMISSIONS.BILLING_MANAGE,
        createTrustedOrganizationScope(organizationId),
      )
        ? "owner"
        : "member";
    },

    async find(organizationId: string): Promise<PublicSubscription | null> {
      const row = await prisma.organizationSubscription.findUnique({
        where: { organizationId },
      });
      return row === null ? null : publicSubscription(row);
    },

    /**
     * One subscription per Organization. Re-confirming the same Checkout
     * session is idempotent; a different session never overwrites an existing
     * subscription (no silent plan swap without payment).
     */
    async saveConfirmed(
      input: SaveConfirmedInput,
    ): Promise<SaveConfirmedResult> {
      const existing = async (): Promise<SaveConfirmedResult | null> => {
        const row = await prisma.organizationSubscription.findUnique({
          where: { organizationId: input.organizationId },
        });
        if (row === null) return null;
        return row.stripeCheckoutSessionId === input.sessionId
          ? { kind: "saved", subscription: publicSubscription(row) }
          : { kind: "conflict" };
      };
      const found = await existing();
      if (found !== null) return found;
      try {
        const row = await prisma.organizationSubscription.create({
          data: {
            organizationId: input.organizationId,
            plan: input.plan,
            status: "ACTIVE",
            stripeCheckoutSessionId: input.sessionId,
            stripeCustomerId: input.customerId,
            stripeSubscriptionId: input.subscriptionId,
          },
        });
        return { kind: "saved", subscription: publicSubscription(row) };
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        )
          return (await existing()) ?? { kind: "conflict" };
        throw error;
      }
    },
  };
}

export type BillingRepository = ReturnType<
  typeof createPrismaBillingRepository
>;
