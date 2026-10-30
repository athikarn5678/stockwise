import { describe, expect, it } from "vitest";

import {
  createTrustedAuthorizationContext,
  type OrganizationRole,
} from "../identity/authorization-policy.ts";
import {
  resolveAnalyticsBranchSet,
  type AnalyticsBranchRecord,
  type AnalyticsKind,
  type AnalyticsScopeCandidate,
} from "./analytics-scope.ts";

const ORGANIZATION_ID = "organization-a";
const branches = [
  { id: "active-a", organizationId: ORGANIZATION_ID, status: "ACTIVE" },
  { id: "active-b", organizationId: ORGANIZATION_ID, status: "ACTIVE" },
  { id: "inactive", organizationId: ORGANIZATION_ID, status: "INACTIVE" },
  { id: "other", organizationId: "organization-b", status: "ACTIVE" },
] as const satisfies readonly AnalyticsBranchRecord[];

function resolve(input: {
  analyticsKind: AnalyticsKind;
  assignedBranchIds?: readonly string[];
  candidate?: AnalyticsScopeCandidate;
  role: OrganizationRole;
}) {
  const context = createTrustedAuthorizationContext({
    actor: { id: "user-a", status: "ACTIVE" },
    branchAssignments: (input.assignedBranchIds ?? []).map((branchId) => ({
      branchId,
      organizationId: ORGANIZATION_ID,
      status: "ACTIVE" as const,
      userId: "user-a",
    })),
    membership: {
      organizationId: ORGANIZATION_ID,
      role: input.role,
      status: "ACTIVE",
      userId: "user-a",
    },
  });

  if (context === null) {
    throw new Error("Test authorization context is invalid.");
  }

  return resolveAnalyticsBranchSet({
    analyticsKind: input.analyticsKind,
    branches,
    candidate: input.candidate ?? { kind: "organization" },
    context,
  });
}

describe("analytics scope engine", () => {
  it.each(["OWNER", "ADMIN"] as const)(
    "%s receives Organization-wide active and inactive Branch history",
    (role) => {
      const outcome = resolve({ analyticsKind: "business", role });

      expect(outcome).toEqual({
        kind: "allowed",
        scope: {
          branchCount: 3,
          branchIds: ["active-a", "active-b", "inactive"],
          canViewCost: true,
          kind: "organization",
          organizationId: ORGANIZATION_ID,
        },
      });
    },
  );

  it("limits BRANCH_MANAGER business and inventory analytics to assigned active Branches", () => {
    const business = resolve({
      analyticsKind: "business",
      assignedBranchIds: ["inactive", "active-b", "active-a"],
      role: "BRANCH_MANAGER",
    });
    const inventory = resolve({
      analyticsKind: "inventory",
      assignedBranchIds: ["inactive", "active-b", "active-a"],
      role: "BRANCH_MANAGER",
    });

    expect(business).toMatchObject({
      kind: "allowed",
      scope: { branchIds: ["active-a", "active-b"], canViewCost: true },
    });
    expect(inventory).toMatchObject({
      kind: "allowed",
      scope: { branchIds: ["active-a", "active-b"], canViewCost: true },
    });
  });

  it("grants INVENTORY_STAFF assigned-active inventory analytics without cost", () => {
    expect(
      resolve({
        analyticsKind: "inventory",
        assignedBranchIds: ["active-a", "inactive"],
        role: "INVENTORY_STAFF",
      }),
    ).toMatchObject({
      kind: "allowed",
      scope: { branchIds: ["active-a"], canViewCost: false },
    });
  });

  it("denies forecast scope to assigned inventory staff and CASHIER", () => {
    expect(
      resolve({
        analyticsKind: "forecast",
        assignedBranchIds: ["active-a", "inactive"],
        role: "INVENTORY_STAFF",
      }),
    ).toEqual({ kind: "forbidden" });
    expect(
      resolve({
        analyticsKind: "forecast",
        assignedBranchIds: ["active-a"],
        role: "CASHIER",
      }),
    ).toEqual({ kind: "forbidden" });
  });

  it("denies INVENTORY_STAFF business analytics and CASHIER analytics", () => {
    expect(
      resolve({
        analyticsKind: "business",
        assignedBranchIds: ["active-a"],
        role: "INVENTORY_STAFF",
      }),
    ).toEqual({ kind: "forbidden" });
    expect(
      resolve({
        analyticsKind: "inventory",
        assignedBranchIds: ["active-a"],
        role: "CASHIER",
      }),
    ).toEqual({ kind: "forbidden" });
  });

  it("denies unassigned, inactive, empty, and cross-tenant branch candidates", () => {
    for (const branchId of ["active-b", "inactive", "other", "missing"]) {
      expect(
        resolve({
          analyticsKind: "business",
          assignedBranchIds: ["active-a", "inactive"],
          candidate: { branchId, kind: "branch" },
          role: "BRANCH_MANAGER",
        }),
      ).toEqual({ kind: "forbidden" });
    }
    expect(
      resolve({ analyticsKind: "business", role: "BRANCH_MANAGER" }),
    ).toEqual({ kind: "forbidden" });
  });

  it("allows an authorized single Branch without leaking other Branch identifiers", () => {
    expect(
      resolve({
        analyticsKind: "business",
        assignedBranchIds: ["active-a", "active-b"],
        candidate: { branchId: "active-b", kind: "branch" },
        role: "BRANCH_MANAGER",
      }),
    ).toEqual({
      kind: "allowed",
      scope: {
        branchCount: 1,
        branchIds: ["active-b"],
        canViewCost: true,
        kind: "branch",
        organizationId: ORGANIZATION_ID,
      },
    });
  });
});
