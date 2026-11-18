import type { BillingRepository } from "../modules/billing/billing-repository.ts";

/**
 * The one organization the renewal rehearsal may expire (ADR-049, owner
 * decision 2026-11-18). Hard-coded on purpose: the command takes no input, so
 * it cannot be pointed at another tenant.
 */
export const REHEARSAL_ORGANIZATION_ID = "ce295c46-a4a1-5930-ba4f-75739461072d";

export class ExpireRefusal extends Error {}

/**
 * Idempotently sets ONLY the rehearsal organization's subscription to EXPIRED
 * so the owner can repeat the renewal through Stripe Checkout. Returns the
 * status the organization had before ("CREATED" when it had no row).
 */
export async function expireRehearsalSubscription(
  repository: Pick<BillingRepository, "markExpired">,
): Promise<string> {
  const previous = await repository.markExpired(REHEARSAL_ORGANIZATION_ID);
  if (previous === null) throw new ExpireRefusal("ORGANIZATION_NOT_FOUND");
  return previous;
}
