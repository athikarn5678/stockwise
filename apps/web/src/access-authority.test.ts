import { describe, expect, it } from "vitest";

import { accessAuthoritySignature } from "./access-authority";
import type { AccessContext } from "./branch-api-client";

const ORG_A = "10000000-0000-4000-8000-000000000001";
const ORG_B = "10000000-0000-4000-8000-000000000002";
const BRANCH_A = "20000000-0000-4000-8000-000000000001";
const BRANCH_B = "20000000-0000-4000-8000-000000000002";
const ACTOR_A = "30000000-0000-4000-8000-000000000001";
const ACTOR_B = "30000000-0000-4000-8000-000000000002";

type Organization = AccessContext["organizations"][number];
type Branch = Organization["branches"][number];

const branch = (
  id: string = BRANCH_A,
  overrides: Partial<Branch> = {},
): Branch => ({ id, code: "MAIN", name: "Main", ...overrides });

const organization = (overrides: Partial<Organization> = {}): Organization => ({
  id: ORG_A,
  name: "Store A",
  role: "OWNER",
  branches: [branch()],
  ...overrides,
});

function context(
  overrides: {
    userId?: string;
    email?: string;
    displayName?: string | null;
    eligible?: boolean;
    organizations?: Organization[];
  } = {},
): AccessContext {
  return {
    firstOrganizationOnboarding: { eligible: overrides.eligible ?? false },
    organizations: overrides.organizations ?? [organization()],
    user: {
      id: overrides.userId ?? ACTOR_A,
      email: overrides.email ?? "actor@example.test",
      displayName: overrides.displayName ?? "Actor A",
    },
  };
}

const signature = (value: AccessContext) => accessAuthoritySignature(value);

describe("accessAuthoritySignature", () => {
  it("is equal when only presentation fields change", () => {
    const renamed = context({
      displayName: "Renamed Actor",
      email: "renamed@example.test",
      organizations: [
        organization({
          name: "Renamed Store",
          branches: [
            branch(BRANCH_A, { code: "RENAMED", name: "Renamed Branch" }),
          ],
        }),
      ],
    });
    expect(signature(context())).toBe(signature(renamed));
  });

  it("ignores the server response order of organizations and branches", () => {
    const reordered = context({
      organizations: [
        organization({
          id: ORG_B,
          name: "Store B",
          branches: [branch(BRANCH_B)],
        }),
        organization({ branches: [branch(BRANCH_A), branch(BRANCH_B)] }),
      ],
    });
    const original = context({
      organizations: [
        organization({ branches: [branch(BRANCH_B), branch(BRANCH_A)] }),
        organization({
          id: ORG_B,
          name: "Store B",
          branches: [branch(BRANCH_B)],
        }),
      ],
    });
    expect(signature(original)).toBe(signature(reordered));
  });

  it("treats an organization with no branches as authority-bearing", () => {
    const withoutBranches = context({
      organizations: [organization({ branches: [] })],
    });
    expect(signature(withoutBranches)).not.toBe(signature(context()));
    expect(signature(withoutBranches)).toBe(
      signature(
        context({
          organizations: [organization({ name: "Renamed", branches: [] })],
        }),
      ),
    );
  });

  it("differs when the actor changes", () => {
    expect(signature(context({ userId: ACTOR_B }))).not.toBe(
      signature(context()),
    );
  });

  it("differs when first-organization onboarding eligibility changes", () => {
    expect(signature(context({ eligible: true }))).not.toBe(
      signature(context()),
    );
  });

  it("differs when an organization id changes", () => {
    expect(
      signature(context({ organizations: [organization({ id: ORG_B })] })),
    ).not.toBe(signature(context()));
  });

  it("differs when the role changes", () => {
    for (const role of [
      "ADMIN",
      "BRANCH_MANAGER",
      "INVENTORY_STAFF",
      "CASHIER",
    ] as const)
      expect(
        signature(context({ organizations: [organization({ role })] })),
      ).not.toBe(signature(context()));
  });

  it("differs when a branch is added or removed", () => {
    const twoBranches = context({
      organizations: [
        organization({ branches: [branch(BRANCH_A), branch(BRANCH_B)] }),
      ],
    });
    const noBranches = context({
      organizations: [organization({ branches: [] })],
    });
    for (const changed of [twoBranches, noBranches])
      expect(signature(changed)).not.toBe(signature(context()));
  });

  it("differs when an organization is added or removed", () => {
    const twoOrganizations = context({
      organizations: [organization(), organization({ id: ORG_B })],
    });
    expect(signature(twoOrganizations)).not.toBe(signature(context()));
    expect(signature(context({ organizations: [] }))).not.toBe(
      signature(context()),
    );
  });
});
