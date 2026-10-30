/**
 * The exact public schema `stockwise-demo-v1` may seed: the tables produced by
 * the committed migrations in `apps/api/prisma/migrations`, classified by what
 * the fixture does with them. `demo-schema.test.ts` derives the table set from
 * the migration SQL and fails when a new migration adds, renames or drops a
 * table without this manifest being reviewed.
 */

/** Tables whose rows the fixture writes or must find empty, row-compared. */
export const DEMO_FIXTURE_TABLES = [
  "users",
  "organizations",
  "suppliers",
  "categories",
  "products",
  "purchase_orders",
  "purchase_order_items",
  "purchase_receipts",
  "purchase_receipt_items",
  "sales",
  "sale_items",
  "payments",
  "sale_refunds",
  "sale_refund_items",
  "refund_payments",
  "organization_memberships",
  "branches",
  "branch_status_events",
  "analytics_snapshots",
  "ai_insight_reports",
  "ai_insight_attempts",
  "inventory_balances",
  "inventory_cost_states",
  "inventory_transactions",
  "first_organization_onboardings",
  "branch_assignments",
  "sessions",
  "email_verification_challenges",
  "password_reset_tokens",
  "invitations",
  "invitation_branch_scopes",
  "membership_access_events",
  "membership_access_event_branch_scopes",
] as const;

/**
 * Better Auth / Native transition tables (migrations 20261012000000 through
 * 20261024000000). Seeding happens before the operator Native cutover
 * (ADR-039), so all of them must be empty before and after seeding; the
 * cutover itself enrolls the seeded users.
 */
export const DEMO_AUTHENTICATION_TABLES = [
  "better_auth_accounts",
  "better_auth_sessions",
  "better_auth_verifications",
  "native_auth_enrollments",
  "native_password_reset_quotas",
  "pending_registrations",
  "pending_registration_quotas",
  "pending_registration_credential_attempts",
  // ADR-043 Production demo provenance: operator-written, so this fixture must find it empty.
  "demo_dataset_runs",
] as const;

/** Singleton fence row; seeding is allowed only while it is `LEGACY`. */
export const DEMO_TRANSITION_TABLE = "native_auth_transition";
const MIGRATION_TABLE = "_prisma_migrations";

/** Every table counted for emptiness and row-compared against the fixture. */
export const DEMO_COUNTED_TABLES = [
  ...DEMO_FIXTURE_TABLES,
  ...DEMO_AUTHENTICATION_TABLES,
] as const;

export function expectedDemoSchemaTables(): string[] {
  return [
    ...DEMO_COUNTED_TABLES,
    DEMO_TRANSITION_TABLE,
    MIGRATION_TABLE,
  ].sort();
}

export type DemoSchemaState = Readonly<{
  tables: readonly string[];
  migrations: readonly Readonly<{
    name: string;
    finished: boolean;
    rolledBack: boolean;
  }>[];
  localMigrations: readonly string[];
  transitionStates: readonly string[];
}>;

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Fail-closed: the database must hold exactly the committed migrations, all
 * finished and none rolled back, exactly the manifest tables, and a LEGACY
 * fence. Unknown, missing or partially migrated schemas are refused.
 */
export function assertDemoSchema(state: DemoSchemaState): void {
  if (state.migrations.some((row) => !row.finished || row.rolledBack))
    throw new Error("Demo target has incomplete or rolled-back migrations.");
  if (
    !sameSet(
      state.localMigrations,
      state.migrations.map((row) => row.name),
    )
  )
    throw new Error(
      "Migration state differs from the committed stockwise migrations.",
    );
  if (!sameSet(expectedDemoSchemaTables(), state.tables))
    throw new Error(
      "Database schema differs from the complete stockwise-demo-v1 manifest.",
    );
  if (
    state.transitionStates.length !== 1 ||
    state.transitionStates[0] !== "LEGACY"
  )
    throw new Error(
      "Demo seeding requires the pre-cutover LEGACY authentication state; run it before native:cutover.",
    );
}

/** Columns added to `users` by the Better Auth migrations, with their pre-cutover values. */
export const DEMO_USER_NATIVE_DEFAULTS = Object.freeze({
  emailVerified: false,
  image: null,
  nativeRegistrationCompletedAt: null,
});
