import type { BillingInterval, BillingPlan } from "./billing-plans.ts";

/** New organizations get a 14-day Business trial (docs/PLAN.md M6, ADR-049). */
export const TRIAL_DAYS = 14;
const DAY_MILLISECONDS = 86_400_000;

export type SubscriptionAccessState = "ACTIVE" | "TRIAL" | "EXPIRED";

export type StoredSubscription = Readonly<{
  interval: BillingInterval;
  plan: BillingPlan;
  status: "ACTIVE" | "PAST_DUE" | "CANCELED" | "EXPIRED";
}>;

export type SubscriptionAccess = Readonly<{
  state: SubscriptionAccessState;
  /** Whole days left in the trial (rounded up); null outside TRIAL. */
  trialDaysLeft: number | null;
  trialEndsAt: string | null;
}>;

/** ACTIVE and PAST_DUE (no grace policy yet; never written) keep access. */
export function subscriptionKeepsAccess(
  status: StoredSubscription["status"],
): boolean {
  return status === "ACTIVE" || status === "PAST_DUE";
}

/**
 * Pure access decision (ADR-049). A stored row wins over the trial: ACTIVE and
 * PAST_DUE (no grace policy yet; never written) keep access, CANCELED and
 * EXPIRED require renewal. With no row the organization is in TRIAL for its
 * first 14 days and EXPIRED afterwards.
 */
export function resolveSubscriptionAccess(input: {
  now: Date;
  organizationCreatedAt: Date;
  subscription: StoredSubscription | null;
}): SubscriptionAccess {
  const { subscription } = input;
  if (subscription !== null) {
    return {
      state: subscriptionKeepsAccess(subscription.status)
        ? "ACTIVE"
        : "EXPIRED",
      trialDaysLeft: null,
      trialEndsAt: null,
    };
  }
  const trialEnd = new Date(
    input.organizationCreatedAt.getTime() + TRIAL_DAYS * DAY_MILLISECONDS,
  );
  const remaining = trialEnd.getTime() - input.now.getTime();
  if (remaining <= 0)
    return {
      state: "EXPIRED",
      trialDaysLeft: null,
      trialEndsAt: trialEnd.toISOString(),
    };
  return {
    state: "TRIAL",
    trialDaysLeft: Math.ceil(remaining / DAY_MILLISECONDS),
    trialEndsAt: trialEnd.toISOString(),
  };
}
