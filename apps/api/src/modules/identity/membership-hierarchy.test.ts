import { describe, expect, it } from "vitest";

import {
  ORGANIZATION_ROLES,
  type OrganizationRole,
} from "./authorization-policy.ts";
import { mayManageMembership } from "./membership-hierarchy.ts";

// Strongest to weakest, independent of the implementation's rank numbers.
const BY_RANK: readonly OrganizationRole[] = [
  "OWNER",
  "ADMIN",
  "BRANCH_MANAGER",
  "INVENTORY_STAFF",
  "CASHIER",
];

describe("membership hierarchy", () => {
  it("covers exactly the five fixed roles", () => {
    expect([...BY_RANK].sort()).toEqual([...ORGANIZATION_ROLES].sort());
  });

  it("allows a change only when the actor outranks both the target and the assigned role", () => {
    for (const [actorIndex, actor] of BY_RANK.entries()) {
      for (const [desiredIndex, desired] of BY_RANK.entries()) {
        for (const [targetIndex, target] of [
          [-1, null] as const,
          ...BY_RANK.map((role, index) => [index, role] as const),
        ]) {
          // A lower index is a stronger role.
          const expected =
            actorIndex < desiredIndex &&
            (targetIndex === -1 || actorIndex < targetIndex);
          expect(
            mayManageMembership({ actor, desired, target }),
            `${actor} -> target ${target} -> ${desired}`,
          ).toBe(expected);
        }
      }
    }
  });

  it("never allows anyone to assign OWNER, and nobody to change an OWNER", () => {
    for (const actor of BY_RANK) {
      for (const target of [null, ...BY_RANK]) {
        expect(mayManageMembership({ actor, desired: "OWNER", target })).toBe(
          false,
        );
      }
      expect(
        mayManageMembership({ actor, desired: "CASHIER", target: "OWNER" }),
      ).toBe(false);
    }
  });

  it("lets ADMIN manage only the three roles below it", () => {
    for (const role of [
      "BRANCH_MANAGER",
      "INVENTORY_STAFF",
      "CASHIER",
    ] as const) {
      expect(
        mayManageMembership({ actor: "ADMIN", desired: role, target: role }),
      ).toBe(true);
    }
    expect(
      mayManageMembership({ actor: "ADMIN", desired: "ADMIN", target: null }),
    ).toBe(false);
  });
});
