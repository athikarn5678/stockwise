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
import type { BillingInterval, BillingPlan } from "./billing-plans.ts";

export type BillingAccess = "owner" | "member" | null;

export type PublicSubscription = Readonly<{
  interval: BillingInterval;
  plan: BillingPlan;
  status: OrganizationSubscription["status"];
}>;

export type SaveConfirmedInput = Readonly<{
  customerId: string;
  interval: BillingInterval;
  organizationId: string;
  plan: BillingPlan;
  sessionId: string;
  subscriptionId: string;
}>;

export type SaveConfirmedResult =
  | Readonly<{ kind: "saved"; subscription: PublicSubscription }>
  | Readonly<{ kind: "conflict" }>;

/** What the central guard and the billing read need to decide access. */
export type AccessFacts = Readonly<{
  organizationCreatedAt: Date;
  subscription: PublicSubscription | null;
}>;

function publicSubscription(row: OrganizationSubscription): PublicSubscription {
  return { interval: row.interval, plan: row.plan, status: row.status };
}

/** Statuses a renewal Checkout may replace; a live subscription is never swapped. */
const RENEWABLE_STATUSES = ["EXPIRED", "CANCELED"] as const;

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

    /** Organization age and stored subscription for the access decision. */
    async accessFacts(organizationId: string): Promise<AccessFacts | null> {
      const organization = await prisma.organization.findUnique({
        select: { createdAt: true, subscription: true },
        where: { id: organizationId },
      });
      if (organization === null) return null;
      return {
        organizationCreatedAt: organization.createdAt,
        subscription:
          organization.subscription === null
            ? null
            : publicSubscription(organization.subscription),
      };
    },

    /**
     * Guard lookup: facts only for an ACTIVE member of an ACTIVE organization.
     * Anyone else gets null so the guard stays silent and the route answers
     * with its normal 403/404; subscription state never leaks across tenants.
     */
    async accessFactsForMember(
      actorUserId: string,
      organizationId: string,
    ): Promise<AccessFacts | null> {
      const membership = await prisma.organizationMembership.findUnique({
        select: {
          organization: {
            select: { createdAt: true, status: true, subscription: true },
          },
          status: true,
        },
        where: {
          organizationId_userId: { organizationId, userId: actorUserId },
        },
      });
      if (
        membership === null ||
        membership.status !== "ACTIVE" ||
        membership.organization.status !== "ACTIVE"
      )
        return null;
      const { subscription } = membership.organization;
      return {
        organizationCreatedAt: membership.organization.createdAt,
        subscription:
          subscription === null ? null : publicSubscription(subscription),
      };
    },

    /**
     * One subscription per Organization. Re-confirming the same Checkout
     * session is idempotent. A different session never overwrites a live
     * subscription (no silent plan swap), but it renews an EXPIRED/CANCELED
     * one in place and sets it ACTIVE immediately (ADR-049).
     */
    async saveConfirmed(
      input: SaveConfirmedInput,
    ): Promise<SaveConfirmedResult> {
      const existing = async (): Promise<SaveConfirmedResult | null> => {
        const row = await prisma.organizationSubscription.findUnique({
          where: { organizationId: input.organizationId },
        });
        if (row === null) return null;
        if (row.stripeCheckoutSessionId === input.sessionId)
          return { kind: "saved", subscription: publicSubscription(row) };
        if (!(RENEWABLE_STATUSES as readonly string[]).includes(row.status))
          return { kind: "conflict" };
        // Conditional on the status read above so a concurrent renewal wins once.
        const renewed = await prisma.organizationSubscription.updateMany({
          data: {
            interval: input.interval,
            plan: input.plan,
            status: "ACTIVE",
            stripeCheckoutSessionId: input.sessionId,
            stripeCustomerId: input.customerId,
            stripeSubscriptionId: input.subscriptionId,
          },
          where: {
            organizationId: input.organizationId,
            status: { in: [...RENEWABLE_STATUSES] },
          },
        });
        if (renewed.count === 0) return { kind: "conflict" };
        const updated = await prisma.organizationSubscription.findUnique({
          where: { organizationId: input.organizationId },
        });
        return updated !== null &&
          updated.stripeCheckoutSessionId === input.sessionId
          ? { kind: "saved", subscription: publicSubscription(updated) }
          : { kind: "conflict" };
      };
      const found = await existing();
      if (found !== null) return found;
      try {
        const row = await prisma.organizationSubscription.create({
          data: {
            interval: input.interval,
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

    /**
     * Idempotently marks one organization EXPIRED (operator command only). An
     * existing subscription keeps its plan and Stripe references; with none, a
     * Stripe-less EXPIRED row is created. Returns the previous status.
     */
    async markExpired(
      organizationId: string,
    ): Promise<"CREATED" | OrganizationSubscription["status"] | null> {
      return prisma.$transaction(async (tx) => {
        const organization = await tx.organization.findUnique({
          select: { id: true },
          where: { id: organizationId },
        });
        if (organization === null) return null;
        const row = await tx.organizationSubscription.findUnique({
          where: { organizationId },
        });
        if (row === null) {
          await tx.organizationSubscription.create({
            data: { organizationId, plan: "STARTER", status: "EXPIRED" },
          });
          return "CREATED";
        }
        if (row.status !== "EXPIRED")
          await tx.organizationSubscription.update({
            data: { status: "EXPIRED" },
            where: { organizationId },
          });
        return row.status;
      });
    },
  };
}

export type BillingRepository = ReturnType<
  typeof createPrismaBillingRepository
>;
