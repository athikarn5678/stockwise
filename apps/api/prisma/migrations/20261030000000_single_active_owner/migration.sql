-- ADR-041: each organization has at most one active OWNER.
--
-- Forward-only. Apply ONLY after the owner-approved reconciliation has left
-- every organization with exactly one active OWNER (ops action
-- `reconcile-owners --reconcile-mode verify` reports violations=0); on data
-- with two active OWNERs this statement fails and must not be forced. A unique
-- index can only cap the count: "at least one" is asserted by the same verify
-- action and by first-organization onboarding, which creates the single OWNER.
-- Inactive OWNER rows (history) are unaffected.
CREATE UNIQUE INDEX "organization_memberships_single_active_owner_key"
ON "organization_memberships"("organization_id")
WHERE "role" = 'OWNER' AND "status" = 'ACTIVE';
