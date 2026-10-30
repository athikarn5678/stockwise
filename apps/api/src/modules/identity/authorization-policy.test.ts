import { describe, expect, it } from "vitest";

import {
  ORGANIZATION_ROLES,
  PERMISSIONS,
  can,
  createTrustedAuthorizationContext,
  createTrustedBranchScope,
  createTrustedOrganizationScope,
  isPermission,
} from "./authorization-policy.ts";
import type {
  ActorStatus,
  BranchAssignmentStatus,
  MembershipStatus,
  OrganizationRole,
  Permission,
  ResolvedAuthorizationState,
  TrustedAuthorizationContext,
  TrustedResourceScope,
} from "./authorization-policy.ts";

const ORGANIZATION_A = "organization-a";
const ORGANIZATION_B = "organization-b";
const BRANCH_A = "branch-a";
const BRANCH_B = "branch-b";
const BRANCH_C = "branch-c";
const ACTOR_ID = "actor-a";

type MatrixCase = Readonly<{
  permission: Permission;
  allowedRoles: readonly OrganizationRole[];
  scope: "organization" | "branch" | "organization-or-branch";
}>;

const ALL_ROLES = ORGANIZATION_ROLES;
const OPERATIONAL_MANAGEMENT_ROLES = [
  "OWNER",
  "ADMIN",
  "BRANCH_MANAGER",
  "INVENTORY_STAFF",
] as const satisfies readonly OrganizationRole[];
const MANAGER_ROLES = [
  "OWNER",
  "ADMIN",
  "BRANCH_MANAGER",
] as const satisfies readonly OrganizationRole[];
const CHECKOUT_AND_SALES_ROLES = [
  "OWNER",
  "ADMIN",
  "BRANCH_MANAGER",
  "CASHIER",
] as const satisfies readonly OrganizationRole[];
const ORGANIZATION_ADMINISTRATION_ROLES = [
  "OWNER",
  "ADMIN",
] as const satisfies readonly OrganizationRole[];
const OWNER_ONLY = ["OWNER"] as const satisfies readonly OrganizationRole[];

const PERMISSION_MATRIX = [
  {
    permission: PERMISSIONS.CATALOG_VIEW,
    allowedRoles: CHECKOUT_AND_SALES_ROLES,
    scope: "organization-or-branch",
  },
  {
    permission: PERMISSIONS.CATALOG_CREATE_EDIT,
    allowedRoles: MANAGER_ROLES,
    scope: "organization-or-branch",
  },
  {
    permission: PERMISSIONS.CATALOG_DEACTIVATE,
    allowedRoles: MANAGER_ROLES,
    scope: "organization-or-branch",
  },
  {
    permission: PERMISSIONS.SUPPLIER_VIEW,
    allowedRoles: MANAGER_ROLES,
    scope: "organization-or-branch",
  },
  {
    permission: PERMISSIONS.SUPPLIER_CREATE_EDIT,
    allowedRoles: MANAGER_ROLES,
    scope: "organization-or-branch",
  },
  {
    permission: PERMISSIONS.SUPPLIER_DEACTIVATE,
    allowedRoles: ORGANIZATION_ADMINISTRATION_ROLES,
    scope: "organization",
  },
  {
    permission: PERMISSIONS.INVENTORY_VIEW,
    allowedRoles: ALL_ROLES,
    scope: "branch",
  },
  {
    permission: PERMISSIONS.INVENTORY_ADJUST,
    allowedRoles: OPERATIONAL_MANAGEMENT_ROLES,
    scope: "branch",
  },
  {
    permission: PERMISSIONS.PURCHASE_ORDER_VIEW,
    allowedRoles: MANAGER_ROLES,
    scope: "branch",
  },
  {
    permission: PERMISSIONS.PURCHASE_ORDER_CREATE_EDIT,
    allowedRoles: MANAGER_ROLES,
    scope: "branch",
  },
  {
    permission: PERMISSIONS.RECEIVING_PERFORM,
    allowedRoles: MANAGER_ROLES,
    scope: "branch",
  },
  {
    permission: PERMISSIONS.CHECKOUT_PERFORM,
    allowedRoles: CHECKOUT_AND_SALES_ROLES,
    scope: "branch",
  },
  {
    permission: PERMISSIONS.CHECKOUT_DISCOUNT_APPLY,
    allowedRoles: MANAGER_ROLES,
    scope: "branch",
  },
  {
    permission: PERMISSIONS.SALES_HISTORY_VIEW,
    allowedRoles: CHECKOUT_AND_SALES_ROLES,
    scope: "organization-or-branch",
  },
  {
    permission: PERMISSIONS.SALES_COST_VIEW,
    allowedRoles: MANAGER_ROLES,
    scope: "organization-or-branch",
  },
  {
    permission: PERMISSIONS.SALES_REFUND_CREATE,
    allowedRoles: MANAGER_ROLES,
    scope: "organization-or-branch",
  },
  {
    permission: PERMISSIONS.SALES_REFUND_VIEW,
    allowedRoles: CHECKOUT_AND_SALES_ROLES,
    scope: "organization-or-branch",
  },
  {
    permission: PERMISSIONS.SALES_REFUND_COST_VIEW,
    allowedRoles: MANAGER_ROLES,
    scope: "organization-or-branch",
  },
  {
    permission: PERMISSIONS.BUSINESS_ANALYTICS_VIEW,
    allowedRoles: MANAGER_ROLES,
    scope: "organization-or-branch",
  },
  {
    permission: PERMISSIONS.INVENTORY_ANALYTICS_VIEW,
    allowedRoles: OPERATIONAL_MANAGEMENT_ROLES,
    scope: "organization-or-branch",
  },
  {
    permission: PERMISSIONS.FORECAST_REORDER_VIEW,
    allowedRoles: MANAGER_ROLES,
    scope: "organization-or-branch",
  },
  {
    permission: PERMISSIONS.AI_BUSINESS_SUMMARY_VIEW,
    allowedRoles: MANAGER_ROLES,
    scope: "organization-or-branch",
  },
  {
    permission: PERMISSIONS.ORGANIZATION_SETTINGS_MANAGE,
    allowedRoles: ORGANIZATION_ADMINISTRATION_ROLES,
    scope: "organization",
  },
  {
    permission: PERMISSIONS.BRANCH_MANAGE,
    allowedRoles: ORGANIZATION_ADMINISTRATION_ROLES,
    scope: "organization",
  },
  {
    permission: PERMISSIONS.MEMBERSHIP_VIEW,
    allowedRoles: ORGANIZATION_ADMINISTRATION_ROLES,
    scope: "organization",
  },
  {
    permission: PERMISSIONS.NON_OWNER_MEMBERSHIP_MANAGE,
    allowedRoles: ORGANIZATION_ADMINISTRATION_ROLES,
    scope: "organization",
  },
  {
    permission: PERMISSIONS.OWNER_MEMBERSHIP_MANAGE,
    allowedRoles: OWNER_ONLY,
    scope: "organization",
  },
  {
    permission: PERMISSIONS.OWNERSHIP_TRANSFER,
    allowedRoles: OWNER_ONLY,
    scope: "organization",
  },
  {
    permission: PERMISSIONS.OWNERSHIP_DESTRUCTIVE_ACTION,
    allowedRoles: OWNER_ONLY,
    scope: "organization",
  },
] as const satisfies readonly MatrixCase[];

function resolvedState(
  role: OrganizationRole,
  options: {
    actorId?: string;
    actorStatus?: ActorStatus;
    membershipUserId?: string;
    membershipOrganizationId?: string;
    membershipStatus?: MembershipStatus;
    assignedBranchIds?: readonly string[];
    assignmentOrganizationId?: string;
    assignmentStatus?: BranchAssignmentStatus;
  } = {},
): ResolvedAuthorizationState {
  const actorId = options.actorId ?? ACTOR_ID;
  const membershipUserId = options.membershipUserId ?? actorId;
  const membershipOrganizationId =
    options.membershipOrganizationId ?? ORGANIZATION_A;

  return {
    actor: {
      id: actorId,
      status: options.actorStatus ?? "ACTIVE",
    },
    membership: {
      userId: membershipUserId,
      organizationId: membershipOrganizationId,
      role,
      status: options.membershipStatus ?? "ACTIVE",
    },
    branchAssignments: (options.assignedBranchIds ?? [BRANCH_A]).map(
      (branchId) => ({
        userId: membershipUserId,
        organizationId:
          options.assignmentOrganizationId ?? membershipOrganizationId,
        branchId,
        status: options.assignmentStatus ?? "ACTIVE",
      }),
    ),
  };
}

function contextFor(
  role: OrganizationRole,
  options?: Parameters<typeof resolvedState>[1],
): TrustedAuthorizationContext {
  const context = createTrustedAuthorizationContext(
    resolvedState(role, options),
  );
  expect(context).not.toBeNull();
  return context as TrustedAuthorizationContext;
}

function organizationScope(
  organizationId = ORGANIZATION_A,
): TrustedResourceScope {
  const scope = createTrustedOrganizationScope(organizationId);
  expect(scope).not.toBeNull();
  return scope as TrustedResourceScope;
}

function branchScope(
  branchId: string,
  organizationId = ORGANIZATION_A,
): TrustedResourceScope {
  const scope = createTrustedBranchScope({
    organizationId,
    branchId,
    branchOrganizationId: organizationId,
  });
  expect(scope).not.toBeNull();
  return scope as TrustedResourceScope;
}

function matrixScope(
  role: OrganizationRole,
  scope: MatrixCase["scope"],
): TrustedResourceScope {
  if (
    scope === "organization" ||
    (scope === "organization-or-branch" &&
      (role === "OWNER" || role === "ADMIN"))
  ) {
    return organizationScope();
  }

  return branchScope(BRANCH_A);
}

function includesRole(
  roles: readonly OrganizationRole[],
  role: OrganizationRole,
): boolean {
  return roles.includes(role);
}

describe("authorization permission matrix", () => {
  it("covers every accepted permission exactly once", () => {
    const testedPermissions = PERMISSION_MATRIX.map(
      ({ permission }) => permission,
    );

    expect(new Set(testedPermissions).size).toBe(testedPermissions.length);
    expect(new Set(testedPermissions)).toEqual(
      new Set(Object.values(PERMISSIONS)),
    );
  });

  for (const { permission, allowedRoles, scope } of PERMISSION_MATRIX) {
    for (const role of ORGANIZATION_ROLES) {
      const expected = includesRole(allowedRoles, role);

      it(`${role} ${expected ? "may" : "may not"} ${permission}`, () => {
        expect(
          can(contextFor(role), permission, matrixScope(role, scope)),
        ).toBe(expected);
      });
    }
  }
});

describe("organization and branch scope", () => {
  it("gives OWNER organization-wide operational access in its organization", () => {
    const owner = contextFor("OWNER", { assignedBranchIds: [] });

    expect(
      can(owner, PERMISSIONS.CATALOG_CREATE_EDIT, organizationScope()),
    ).toBe(true);
    expect(
      can(owner, PERMISSIONS.INVENTORY_ADJUST, branchScope(BRANCH_A)),
    ).toBe(true);
    expect(
      can(owner, PERMISSIONS.CHECKOUT_PERFORM, branchScope(BRANCH_B)),
    ).toBe(true);
  });

  it("gives ADMIN organization-wide operations but denies OWNER-only governance", () => {
    const admin = contextFor("ADMIN", { assignedBranchIds: [] });

    expect(can(admin, PERMISSIONS.BRANCH_MANAGE, organizationScope())).toBe(
      true,
    );
    expect(
      can(admin, PERMISSIONS.NON_OWNER_MEMBERSHIP_MANAGE, organizationScope()),
    ).toBe(true);
    expect(
      can(admin, PERMISSIONS.OWNER_MEMBERSHIP_MANAGE, organizationScope()),
    ).toBe(false);
    expect(
      can(admin, PERMISSIONS.OWNERSHIP_TRANSFER, organizationScope()),
    ).toBe(false);
    expect(
      can(admin, PERMISSIONS.OWNERSHIP_DESTRUCTIVE_ACTION, organizationScope()),
    ).toBe(false);
  });

  it("allows BRANCH_MANAGER in assigned branches A and C but not B", () => {
    const manager = contextFor("BRANCH_MANAGER", {
      assignedBranchIds: [BRANCH_A, BRANCH_C],
    });

    expect(
      can(manager, PERMISSIONS.INVENTORY_ADJUST, branchScope(BRANCH_A)),
    ).toBe(true);
    expect(
      can(manager, PERMISSIONS.AI_BUSINESS_SUMMARY_VIEW, branchScope(BRANCH_C)),
    ).toBe(true);
    expect(
      can(manager, PERMISSIONS.INVENTORY_ADJUST, branchScope(BRANCH_B)),
    ).toBe(false);
    expect(
      can(manager, PERMISSIONS.CATALOG_CREATE_EDIT, organizationScope()),
    ).toBe(false);
  });

  it("allows INVENTORY_STAFF inventory work but denies POS and unassigned branches", () => {
    const inventoryStaff = contextFor("INVENTORY_STAFF", {
      assignedBranchIds: [BRANCH_A],
    });

    expect(
      can(inventoryStaff, PERMISSIONS.INVENTORY_ADJUST, branchScope(BRANCH_A)),
    ).toBe(true);
    expect(
      can(
        inventoryStaff,
        PERMISSIONS.INVENTORY_ANALYTICS_VIEW,
        branchScope(BRANCH_A),
      ),
    ).toBe(true);
    expect(
      can(inventoryStaff, PERMISSIONS.CHECKOUT_PERFORM, branchScope(BRANCH_A)),
    ).toBe(false);
    expect(
      can(inventoryStaff, PERMISSIONS.INVENTORY_ADJUST, branchScope(BRANCH_B)),
    ).toBe(false);
  });

  it("allows CASHIER checkout/history only in assigned branch scope", () => {
    const cashier = contextFor("CASHIER", {
      assignedBranchIds: [BRANCH_A],
    });

    expect(
      can(cashier, PERMISSIONS.CHECKOUT_PERFORM, branchScope(BRANCH_A)),
    ).toBe(true);
    expect(
      can(cashier, PERMISSIONS.SALES_HISTORY_VIEW, branchScope(BRANCH_A)),
    ).toBe(true);
    expect(
      can(cashier, PERMISSIONS.CHECKOUT_PERFORM, branchScope(BRANCH_B)),
    ).toBe(false);
    expect(
      can(cashier, PERMISSIONS.INVENTORY_ADJUST, branchScope(BRANCH_A)),
    ).toBe(false);
  });

  it("denies branch-scoped roles that have no active branch assignment", () => {
    for (const role of [
      "BRANCH_MANAGER",
      "INVENTORY_STAFF",
      "CASHIER",
    ] as const) {
      const context = contextFor(role, { assignedBranchIds: [] });

      expect(
        can(context, PERMISSIONS.CATALOG_VIEW, branchScope(BRANCH_A)),
      ).toBe(false);
      expect(can(context, PERMISSIONS.CATALOG_VIEW, organizationScope())).toBe(
        false,
      );
    }
  });

  it("does not count inactive branch assignments as access", () => {
    const cashier = contextFor("CASHIER", {
      assignedBranchIds: [BRANCH_A],
      assignmentStatus: "INACTIVE",
    });

    expect(
      can(cashier, PERMISSIONS.CHECKOUT_PERFORM, branchScope(BRANCH_A)),
    ).toBe(false);
  });
});

describe("fail-closed and cross-tenant protections", () => {
  it("denies missing context or resource scope", () => {
    const owner = contextFor("OWNER");

    expect(can(null, PERMISSIONS.CATALOG_VIEW, organizationScope())).toBe(
      false,
    );
    expect(can(undefined, PERMISSIONS.CATALOG_VIEW, organizationScope())).toBe(
      false,
    );
    expect(can(owner, PERMISSIONS.CATALOG_VIEW, null)).toBe(false);
    expect(can(owner, PERMISSIONS.CATALOG_VIEW, undefined)).toBe(false);
  });

  it("denies unbranded client-shaped context and scope objects", () => {
    const clientShapedContext = {
      actorId: ACTOR_ID,
      actorStatus: "ACTIVE",
      membershipUserId: ACTOR_ID,
      organizationId: ORGANIZATION_A,
      role: "OWNER",
      membershipStatus: "ACTIVE",
      activeAssignedBranchIds: [BRANCH_A],
    } as unknown as TrustedAuthorizationContext;
    const clientShapedScope = {
      kind: "organization",
      organizationId: ORGANIZATION_A,
    } as unknown as TrustedResourceScope;

    expect(
      can(
        clientShapedContext,
        PERMISSIONS.OWNERSHIP_TRANSFER,
        organizationScope(),
      ),
    ).toBe(false);
    expect(
      can(contextFor("OWNER"), PERMISSIONS.CATALOG_VIEW, clientShapedScope),
    ).toBe(false);
  });

  it("denies disabled actors and inactive memberships", () => {
    const disabledOwner = contextFor("OWNER", { actorStatus: "DISABLED" });
    const inactiveOwner = contextFor("OWNER", {
      membershipStatus: "INACTIVE",
    });

    expect(
      can(disabledOwner, PERMISSIONS.CATALOG_VIEW, organizationScope()),
    ).toBe(false);
    expect(
      can(inactiveOwner, PERMISSIONS.CATALOG_VIEW, organizationScope()),
    ).toBe(false);
  });

  it("rejects actor-membership and assignment identity substitution", () => {
    expect(
      createTrustedAuthorizationContext(
        resolvedState("OWNER", { membershipUserId: "victim-user" }),
      ),
    ).toBeNull();
    expect(
      createTrustedAuthorizationContext(
        resolvedState("CASHIER", {
          assignmentOrganizationId: ORGANIZATION_B,
        }),
      ),
    ).toBeNull();
  });

  it("denies Organization A membership against Organization B resources", () => {
    const ownerInA = contextFor("OWNER");
    const cashierInA = contextFor("CASHIER", {
      assignedBranchIds: [BRANCH_A],
    });

    expect(
      can(
        ownerInA,
        PERMISSIONS.CATALOG_VIEW,
        organizationScope(ORGANIZATION_B),
      ),
    ).toBe(false);
    expect(
      can(
        cashierInA,
        PERMISSIONS.CHECKOUT_PERFORM,
        branchScope(BRANCH_A, ORGANIZATION_B),
      ),
    ).toBe(false);
  });

  it("rejects mismatched resource organization and branch ownership", () => {
    const mismatchedScope = createTrustedBranchScope({
      organizationId: ORGANIZATION_A,
      branchId: BRANCH_B,
      branchOrganizationId: ORGANIZATION_B,
    });

    expect(mismatchedScope).toBeNull();
    expect(
      can(contextFor("OWNER"), PERMISSIONS.CHECKOUT_PERFORM, mismatchedScope),
    ).toBe(false);
  });

  it("denies explicit privilege-escalation attempts", () => {
    const admin = contextFor("ADMIN");
    const manager = contextFor("BRANCH_MANAGER", {
      assignedBranchIds: [BRANCH_A],
    });
    const cashier = contextFor("CASHIER", {
      assignedBranchIds: [BRANCH_A],
    });

    expect(
      can(admin, PERMISSIONS.OWNER_MEMBERSHIP_MANAGE, organizationScope()),
    ).toBe(false);
    expect(
      can(manager, PERMISSIONS.CATALOG_DEACTIVATE, branchScope(BRANCH_B)),
    ).toBe(false);
    expect(
      can(cashier, PERMISSIONS.CHECKOUT_PERFORM, branchScope(BRANCH_B)),
    ).toBe(false);
    expect(can(cashier, PERMISSIONS.BRANCH_MANAGE, organizationScope())).toBe(
      false,
    );
  });

  it("makes unsupported permissions fail closed at runtime", () => {
    const unsupportedPermission = "sales.refund";

    expect(isPermission(unsupportedPermission)).toBe(false);
    expect(
      can(
        contextFor("OWNER"),
        unsupportedPermission as Permission,
        branchScope(BRANCH_A),
      ),
    ).toBe(false);
  });

  it("adds the accepted refund authority without adding void authority", () => {
    const permissions = Object.values(PERMISSIONS);

    expect(permissions).toContain("sales-refund.create");
    expect(permissions).toContain("sales-refund.view");
    expect(permissions).toContain("sales-refund-cost.view");
    expect(permissions.every((permission) => !/void/.test(permission))).toBe(
      true,
    );
  });
});
