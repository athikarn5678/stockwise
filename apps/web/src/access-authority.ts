import type { AccessContext } from "@/branch-api-client";

/**
 * Authority-bearing projection of an access context (ADR-044).
 *
 * Only values that can grant or remove authority are included: the actor id,
 * first-onboarding eligibility, and per organization the id, role and the set
 * of branch ids. Display names, emails, organization/branch names and branch
 * codes are presentation data, not authority, so a rename never resets the
 * mounted screen. Organizations and branch ids are sorted to keep the result
 * independent of server response order.
 */
export function accessAuthoritySignature(context: AccessContext): string {
  const organizations = [...context.organizations]
    .sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    )
    .map((organization) => [
      organization.id,
      organization.role,
      organization.branches
        .map((branch) => branch.id)
        .sort()
        .join(","),
    ]);
  return JSON.stringify([
    context.user.id,
    context.firstOrganizationOnboarding.eligible,
    organizations,
  ]);
}
