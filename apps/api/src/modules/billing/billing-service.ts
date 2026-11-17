import {
  BILLING_PLANS,
  billingPlanSchema,
  type BillingPlan,
} from "./billing-plans.ts";
import type {
  BillingRepository,
  PublicSubscription,
} from "./billing-repository.ts";
import type { StripeClient } from "./stripe-client.ts";

export type BillingReadResult =
  | Readonly<{ kind: "forbidden" }>
  | Readonly<{
      canManage: boolean;
      enabled: boolean;
      kind: "ok";
      subscription: PublicSubscription | null;
    }>;

export type CheckoutResult =
  | Readonly<{
      kind: "disabled" | "forbidden" | "conflict" | "provider_failed";
    }>
  | Readonly<{ kind: "ok"; url: string }>;

export type ConfirmResult =
  | Readonly<{
      kind:
        | "disabled"
        | "forbidden"
        | "conflict"
        | "not_complete"
        | "provider_failed";
    }>
  | Readonly<{ kind: "ok"; subscription: PublicSubscription }>;

const CUSTOMER = /^cus_[A-Za-z0-9]+$/;
const SUBSCRIPTION = /^sub_[A-Za-z0-9]+$/;

/**
 * Hosted-Checkout subscription flow (ADR-047). The server decides plan prices,
 * the success URL origin and which Organization a Checkout Session belongs to;
 * nothing from the browser is trusted beyond the plan name and session id.
 */
export function createBillingService(input: {
  /** Absent when STRIPE_SECRET_KEY is not configured: the feature is hidden. */
  stripe?: StripeClient;
  publicWebOrigin: string;
  repository: BillingRepository;
}) {
  const { publicWebOrigin, repository, stripe } = input;

  return {
    async read(
      actorUserId: string,
      organizationId: string,
    ): Promise<BillingReadResult> {
      const access = await repository.authorize(actorUserId, organizationId);
      if (access === null) return { kind: "forbidden" };
      return {
        canManage: stripe !== undefined && access === "owner",
        enabled: stripe !== undefined,
        kind: "ok",
        // A hidden feature exposes nothing, not even an existing plan.
        subscription:
          stripe === undefined ? null : await repository.find(organizationId),
      };
    },

    async checkout(request: {
      actorUserId: string;
      organizationId: string;
      plan: BillingPlan;
    }): Promise<CheckoutResult> {
      if (stripe === undefined) return { kind: "disabled" };
      const access = await repository.authorize(
        request.actorUserId,
        request.organizationId,
      );
      if (access !== "owner") return { kind: "forbidden" };
      // No second stored row / plan swap; concurrent unconfirmed Checkouts can
      // still double-charge in test mode (ADR-047, deferred to the webhook slice).
      if ((await repository.find(request.organizationId)) !== null)
        return { kind: "conflict" };
      const base = `${publicWebOrigin}/app/billing?organizationId=${request.organizationId}`;
      const session = await stripe.createCheckoutSession({
        // Stripe requires the literal {CHECKOUT_SESSION_ID} placeholder.
        cancelUrl: `${base}&canceled=1`,
        organizationId: request.organizationId,
        plan: request.plan,
        successUrl: `${base}&session_id={CHECKOUT_SESSION_ID}`,
      });
      if (!session.ok || session.value.url == null)
        return { kind: "provider_failed" };
      return { kind: "ok", url: session.value.url };
    },

    async confirm(request: {
      actorUserId: string;
      organizationId: string;
      sessionId: string;
    }): Promise<ConfirmResult> {
      if (stripe === undefined) return { kind: "disabled" };
      const access = await repository.authorize(
        request.actorUserId,
        request.organizationId,
      );
      if (access !== "owner") return { kind: "forbidden" };
      const retrieved = await stripe.retrieveCheckoutSession(request.sessionId);
      if (!retrieved.ok) return { kind: "provider_failed" };
      const session = retrieved.value;

      // The session must be bound to the caller's Organization by us at
      // creation time; another Organization's session is refused.
      if (
        session.client_reference_id !== request.organizationId ||
        session.metadata?.organization_id !== request.organizationId ||
        session.id !== request.sessionId
      )
        return { kind: "forbidden" };

      const plan = billingPlanSchema.safeParse(session.metadata?.plan);
      if (
        session.mode !== "subscription" ||
        !plan.success ||
        session.currency !== "thb" ||
        session.amount_total !== BILLING_PLANS[plan.data].amountSatang
      )
        return { kind: "forbidden" };

      if (
        session.status !== "complete" ||
        session.payment_status !== "paid" ||
        session.customer === null ||
        session.subscription === null ||
        !CUSTOMER.test(session.customer) ||
        !SUBSCRIPTION.test(session.subscription)
      )
        return { kind: "not_complete" };

      const saved = await repository.saveConfirmed({
        customerId: session.customer,
        organizationId: request.organizationId,
        plan: plan.data,
        sessionId: session.id,
        subscriptionId: session.subscription,
      });
      return saved.kind === "saved"
        ? { kind: "ok", subscription: saved.subscription }
        : { kind: "conflict" };
    },
  };
}

export type BillingService = ReturnType<typeof createBillingService>;
