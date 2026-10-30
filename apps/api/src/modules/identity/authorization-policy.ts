export const ORGANIZATION_ROLES = [
  "OWNER",
  "ADMIN",
  "BRANCH_MANAGER",
  "INVENTORY_STAFF",
  "CASHIER",
] as const;

export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

export const PERMISSIONS = {
  CATALOG_VIEW: "catalog.view",
  CATALOG_CREATE_EDIT: "catalog.create-edit",
  CATALOG_DEACTIVATE: "catalog.deactivate",
  SUPPLIER_VIEW: "supplier.view",
  SUPPLIER_CREATE_EDIT: "supplier.create-edit",
  SUPPLIER_DEACTIVATE: "supplier.deactivate",
  INVENTORY_VIEW: "inventory.view",
  INVENTORY_ADJUST: "inventory.adjust",
  PURCHASE_ORDER_VIEW: "purchase-order.view",
  PURCHASE_ORDER_CREATE_EDIT: "purchase-order.create-edit",
  RECEIVING_PERFORM: "receiving.perform",
  CHECKOUT_PERFORM: "checkout.perform",
  CHECKOUT_DISCOUNT_APPLY: "checkout.discount.apply",
  SALES_HISTORY_VIEW: "sales-history.view",
  SALES_COST_VIEW: "sales-cost.view",
  SALES_REFUND_CREATE: "sales-refund.create",
  SALES_REFUND_VIEW: "sales-refund.view",
  SALES_REFUND_COST_VIEW: "sales-refund-cost.view",
  BUSINESS_ANALYTICS_VIEW: "analytics.business.view",
  INVENTORY_ANALYTICS_VIEW: "analytics.inventory.view",
  FORECAST_REORDER_VIEW: "forecast-reorder.view",
  AI_BUSINESS_SUMMARY_VIEW: "ai-business-summary.view",
  ORGANIZATION_SETTINGS_MANAGE: "organization-settings.manage",
  BRANCH_MANAGE: "branch.manage",
  MEMBERSHIP_VIEW: "membership.view",
  NON_OWNER_MEMBERSHIP_MANAGE: "membership.non-owner.manage",
  OWNER_MEMBERSHIP_MANAGE: "membership.owner.manage",
  OWNERSHIP_TRANSFER: "ownership.transfer",
  OWNERSHIP_DESTRUCTIVE_ACTION: "ownership.destructive-action",
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

type PermissionScope = "organization" | "branch" | "organization-or-branch";

type PermissionRule = Readonly<{
  roles: readonly OrganizationRole[];
  scope: PermissionScope;
}>;

const ALL_ROLES = ORGANIZATION_ROLES;
const OPERATIONAL_MANAGEMENT_ROLES = [
  "OWNER",
  "ADMIN",
  "BRANCH_MANAGER",
  "INVENTORY_STAFF",
] as const satisfies readonly OrganizationRole[];
const CATALOG_DEACTIVATION_ROLES = [
  "OWNER",
  "ADMIN",
  "BRANCH_MANAGER",
] as const satisfies readonly OrganizationRole[];
const CHECKOUT_ROLES = [
  "OWNER",
  "ADMIN",
  "BRANCH_MANAGER",
  "CASHIER",
] as const satisfies readonly OrganizationRole[];
const CHECKOUT_DISCOUNT_ROLES = [
  "OWNER",
  "ADMIN",
  "BRANCH_MANAGER",
] as const satisfies readonly OrganizationRole[];
const SALES_HISTORY_ROLES = [
  "OWNER",
  "ADMIN",
  "BRANCH_MANAGER",
  "CASHIER",
] as const satisfies readonly OrganizationRole[];
const SALES_COST_ROLES = [
  "OWNER",
  "ADMIN",
  "BRANCH_MANAGER",
] as const satisfies readonly OrganizationRole[];
const BUSINESS_ANALYTICS_ROLES = [
  "OWNER",
  "ADMIN",
  "BRANCH_MANAGER",
] as const satisfies readonly OrganizationRole[];
const INVENTORY_ANALYTICS_ROLES = [
  "OWNER",
  "ADMIN",
  "BRANCH_MANAGER",
  "INVENTORY_STAFF",
] as const satisfies readonly OrganizationRole[];
const FORECAST_REORDER_ROLES = BUSINESS_ANALYTICS_ROLES;
const AI_BUSINESS_SUMMARY_ROLES = [
  "OWNER",
  "ADMIN",
  "BRANCH_MANAGER",
] as const satisfies readonly OrganizationRole[];
const ORGANIZATION_ADMINISTRATION_ROLES = [
  "OWNER",
  "ADMIN",
] as const satisfies readonly OrganizationRole[];
const OWNER_ONLY_ROLES = [
  "OWNER",
] as const satisfies readonly OrganizationRole[];

const PERMISSION_RULES = {
  [PERMISSIONS.CATALOG_VIEW]: {
    roles: CHECKOUT_ROLES,
    scope: "organization-or-branch",
  },
  [PERMISSIONS.CATALOG_CREATE_EDIT]: {
    roles: CATALOG_DEACTIVATION_ROLES,
    scope: "organization-or-branch",
  },
  [PERMISSIONS.CATALOG_DEACTIVATE]: {
    roles: CATALOG_DEACTIVATION_ROLES,
    scope: "organization-or-branch",
  },
  [PERMISSIONS.SUPPLIER_VIEW]: {
    roles: CATALOG_DEACTIVATION_ROLES,
    scope: "organization-or-branch",
  },
  [PERMISSIONS.SUPPLIER_CREATE_EDIT]: {
    roles: CATALOG_DEACTIVATION_ROLES,
    scope: "organization-or-branch",
  },
  [PERMISSIONS.SUPPLIER_DEACTIVATE]: {
    roles: ORGANIZATION_ADMINISTRATION_ROLES,
    scope: "organization",
  },
  [PERMISSIONS.INVENTORY_VIEW]: {
    roles: ALL_ROLES,
    scope: "branch",
  },
  [PERMISSIONS.INVENTORY_ADJUST]: {
    roles: OPERATIONAL_MANAGEMENT_ROLES,
    scope: "branch",
  },
  [PERMISSIONS.PURCHASE_ORDER_VIEW]: {
    roles: CATALOG_DEACTIVATION_ROLES,
    scope: "branch",
  },
  [PERMISSIONS.PURCHASE_ORDER_CREATE_EDIT]: {
    roles: CATALOG_DEACTIVATION_ROLES,
    scope: "branch",
  },
  [PERMISSIONS.RECEIVING_PERFORM]: {
    roles: CATALOG_DEACTIVATION_ROLES,
    scope: "branch",
  },
  [PERMISSIONS.CHECKOUT_PERFORM]: {
    roles: CHECKOUT_ROLES,
    scope: "branch",
  },
  [PERMISSIONS.CHECKOUT_DISCOUNT_APPLY]: {
    roles: CHECKOUT_DISCOUNT_ROLES,
    scope: "branch",
  },
  [PERMISSIONS.SALES_HISTORY_VIEW]: {
    roles: SALES_HISTORY_ROLES,
    scope: "organization-or-branch",
  },
  [PERMISSIONS.SALES_COST_VIEW]: {
    roles: SALES_COST_ROLES,
    scope: "organization-or-branch",
  },
  [PERMISSIONS.SALES_REFUND_CREATE]: {
    roles: SALES_COST_ROLES,
    scope: "organization-or-branch",
  },
  [PERMISSIONS.SALES_REFUND_VIEW]: {
    roles: SALES_HISTORY_ROLES,
    scope: "organization-or-branch",
  },
  [PERMISSIONS.SALES_REFUND_COST_VIEW]: {
    roles: SALES_COST_ROLES,
    scope: "organization-or-branch",
  },
  [PERMISSIONS.BUSINESS_ANALYTICS_VIEW]: {
    roles: BUSINESS_ANALYTICS_ROLES,
    scope: "organization-or-branch",
  },
  [PERMISSIONS.INVENTORY_ANALYTICS_VIEW]: {
    roles: INVENTORY_ANALYTICS_ROLES,
    scope: "organization-or-branch",
  },
  [PERMISSIONS.FORECAST_REORDER_VIEW]: {
    roles: FORECAST_REORDER_ROLES,
    scope: "organization-or-branch",
  },
  [PERMISSIONS.AI_BUSINESS_SUMMARY_VIEW]: {
    roles: AI_BUSINESS_SUMMARY_ROLES,
    scope: "organization-or-branch",
  },
  [PERMISSIONS.ORGANIZATION_SETTINGS_MANAGE]: {
    roles: ORGANIZATION_ADMINISTRATION_ROLES,
    scope: "organization",
  },
  [PERMISSIONS.BRANCH_MANAGE]: {
    roles: ORGANIZATION_ADMINISTRATION_ROLES,
    scope: "organization",
  },
  [PERMISSIONS.MEMBERSHIP_VIEW]: {
    roles: ORGANIZATION_ADMINISTRATION_ROLES,
    scope: "organization",
  },
  [PERMISSIONS.NON_OWNER_MEMBERSHIP_MANAGE]: {
    roles: ORGANIZATION_ADMINISTRATION_ROLES,
    scope: "organization",
  },
  [PERMISSIONS.OWNER_MEMBERSHIP_MANAGE]: {
    roles: OWNER_ONLY_ROLES,
    scope: "organization",
  },
  [PERMISSIONS.OWNERSHIP_TRANSFER]: {
    roles: OWNER_ONLY_ROLES,
    scope: "organization",
  },
  [PERMISSIONS.OWNERSHIP_DESTRUCTIVE_ACTION]: {
    roles: OWNER_ONLY_ROLES,
    scope: "organization",
  },
} as const satisfies Record<Permission, PermissionRule>;

const trustedAuthorizationContextBrand: unique symbol = Symbol(
  "trustedAuthorizationContext",
);
const trustedResourceScopeBrand: unique symbol = Symbol("trustedResourceScope");

export type ActorStatus = "ACTIVE" | "DISABLED";
export type MembershipStatus = "ACTIVE" | "INACTIVE";
export type BranchAssignmentStatus = "ACTIVE" | "INACTIVE";

export type ResolvedAuthorizationState = Readonly<{
  actor: Readonly<{
    id: string;
    status: ActorStatus;
  }>;
  membership: Readonly<{
    userId: string;
    organizationId: string;
    role: OrganizationRole;
    status: MembershipStatus;
  }>;
  branchAssignments: readonly Readonly<{
    userId: string;
    organizationId: string;
    branchId: string;
    status: BranchAssignmentStatus;
  }>[];
}>;

export type TrustedAuthorizationContext = Readonly<{
  actorId: string;
  actorStatus: ActorStatus;
  membershipUserId: string;
  organizationId: string;
  role: OrganizationRole;
  membershipStatus: MembershipStatus;
  activeAssignedBranchIds: readonly string[];
  [trustedAuthorizationContextBrand]: true;
}>;

type TrustedOrganizationScope = Readonly<{
  kind: "organization";
  organizationId: string;
  [trustedResourceScopeBrand]: true;
}>;

type TrustedBranchScope = Readonly<{
  kind: "branch";
  organizationId: string;
  branchId: string;
  branchOrganizationId: string;
  [trustedResourceScopeBrand]: true;
}>;

export type TrustedResourceScope =
  TrustedOrganizationScope | TrustedBranchScope;

function isNonBlankIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isOneOf<T extends string>(
  value: unknown,
  accepted: readonly T[],
): value is T {
  return typeof value === "string" && accepted.includes(value as T);
}

export function isPermission(value: unknown): value is Permission {
  return isOneOf(value, Object.values(PERMISSIONS));
}

function isOrganizationRole(value: unknown): value is OrganizationRole {
  return isOneOf(value, ORGANIZATION_ROLES);
}

function includesRole(
  roles: readonly OrganizationRole[],
  role: OrganizationRole,
): boolean {
  return roles.includes(role);
}

/**
 * Builds the policy input from records already resolved by server-side code.
 * Request body, query, path, or header values must never be passed as this state.
 */
export function createTrustedAuthorizationContext(
  state: ResolvedAuthorizationState,
): TrustedAuthorizationContext | null {
  const { actor, membership, branchAssignments } = state;

  if (
    !isNonBlankIdentifier(actor.id) ||
    !isOneOf(actor.status, ["ACTIVE", "DISABLED"] as const) ||
    !isNonBlankIdentifier(membership.userId) ||
    !isNonBlankIdentifier(membership.organizationId) ||
    !isOrganizationRole(membership.role) ||
    !isOneOf(membership.status, ["ACTIVE", "INACTIVE"] as const) ||
    actor.id !== membership.userId ||
    !Array.isArray(branchAssignments)
  ) {
    return null;
  }

  const activeAssignedBranchIds = new Set<string>();

  for (const assignment of branchAssignments) {
    if (
      !isNonBlankIdentifier(assignment.userId) ||
      !isNonBlankIdentifier(assignment.organizationId) ||
      !isNonBlankIdentifier(assignment.branchId) ||
      !isOneOf(assignment.status, ["ACTIVE", "INACTIVE"] as const) ||
      assignment.userId !== membership.userId ||
      assignment.organizationId !== membership.organizationId
    ) {
      return null;
    }

    if (assignment.status === "ACTIVE") {
      activeAssignedBranchIds.add(assignment.branchId);
    }
  }

  return Object.freeze({
    actorId: actor.id,
    actorStatus: actor.status,
    membershipUserId: membership.userId,
    organizationId: membership.organizationId,
    role: membership.role,
    membershipStatus: membership.status,
    activeAssignedBranchIds: Object.freeze([...activeAssignedBranchIds]),
    [trustedAuthorizationContextBrand]: true as const,
  });
}

/**
 * Organization ownership must already be resolved by server-side code.
 */
export function createTrustedOrganizationScope(
  organizationId: string,
): TrustedResourceScope | null {
  if (!isNonBlankIdentifier(organizationId)) {
    return null;
  }

  return Object.freeze({
    kind: "organization" as const,
    organizationId,
    [trustedResourceScopeBrand]: true as const,
  });
}

/**
 * The branch and its owning organization must already be loaded from trusted
 * persistence state. The duplicated organization values make mismatches fail closed.
 */
export function createTrustedBranchScope(input: {
  organizationId: string;
  branchId: string;
  branchOrganizationId: string;
}): TrustedResourceScope | null {
  if (
    !isNonBlankIdentifier(input.organizationId) ||
    !isNonBlankIdentifier(input.branchId) ||
    !isNonBlankIdentifier(input.branchOrganizationId) ||
    input.organizationId !== input.branchOrganizationId
  ) {
    return null;
  }

  return Object.freeze({
    kind: "branch" as const,
    organizationId: input.organizationId,
    branchId: input.branchId,
    branchOrganizationId: input.branchOrganizationId,
    [trustedResourceScopeBrand]: true as const,
  });
}

function isTrustedAuthorizationContext(
  context: TrustedAuthorizationContext | null | undefined,
): context is TrustedAuthorizationContext {
  return context?.[trustedAuthorizationContextBrand] === true;
}

function isTrustedResourceScope(
  scope: TrustedResourceScope | null | undefined,
): scope is TrustedResourceScope {
  return scope?.[trustedResourceScopeBrand] === true;
}

function ruleAllowsScope(rule: PermissionRule, scope: TrustedResourceScope) {
  return rule.scope === "organization-or-branch" || rule.scope === scope.kind;
}

export function can(
  context: TrustedAuthorizationContext | null | undefined,
  permission: Permission,
  resourceScope: TrustedResourceScope | null | undefined,
): boolean {
  if (
    !isTrustedAuthorizationContext(context) ||
    !isPermission(permission) ||
    !isTrustedResourceScope(resourceScope) ||
    context.actorStatus !== "ACTIVE" ||
    context.membershipStatus !== "ACTIVE" ||
    context.actorId !== context.membershipUserId ||
    context.organizationId !== resourceScope.organizationId
  ) {
    return false;
  }

  const rule = PERMISSION_RULES[permission];

  if (
    !includesRole(rule.roles, context.role) ||
    !ruleAllowsScope(rule, resourceScope)
  ) {
    return false;
  }

  if (resourceScope.kind === "organization") {
    return context.role === "OWNER" || context.role === "ADMIN";
  }

  if (resourceScope.organizationId !== resourceScope.branchOrganizationId) {
    return false;
  }

  if (context.role === "OWNER" || context.role === "ADMIN") {
    return true;
  }

  return context.activeAssignedBranchIds.includes(resourceScope.branchId);
}
