import type { OrganizationRole } from "./authorization-policy.ts";

// Strict hierarchy for membership governance. Each organization keeps exactly
// one OWNER, so the OWNER rank is never assignable: no actor outranks it.
const ROLE_RANK = {
  OWNER: 4,
  ADMIN: 3,
  BRANCH_MANAGER: 2,
  INVENTORY_STAFF: 1,
  CASHIER: 0,
} as const satisfies Record<OrganizationRole, number>;

/**
 * Whether an actor of `actor` role may create or change a membership (or a
 * pending invitation) whose current role is `target` (null when nothing exists
 * yet) so that it ends with the `desired` role. The actor must outrank both the
 * target's current role and the role being assigned. Self-modification is a
 * separate identity check made where user IDs are known.
 */
export function mayManageMembership(input: {
  actor: OrganizationRole;
  desired: OrganizationRole;
  target: OrganizationRole | null;
}): boolean {
  const actorRank = ROLE_RANK[input.actor];
  return (
    actorRank > ROLE_RANK[input.desired] &&
    (input.target === null || actorRank > ROLE_RANK[input.target])
  );
}
