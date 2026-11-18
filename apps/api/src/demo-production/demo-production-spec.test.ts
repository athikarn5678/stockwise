import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { DEMO_ORGANIZATION_NAMES } from "../demo/demo-30d-plan.ts";
import { parseDemoProductionSpec } from "./demo-production-spec.ts";

const digest = (index: number) => index.toString(16).padStart(64, "0");

function specWithOrganizationName(name: string): string {
  const id = () => randomUUID();
  return JSON.stringify({
    version: 1,
    database: "stockwise_demo_production",
    organization: { id: id(), name },
    referenceDate: "2026-11-16",
    seed: 30,
    reportingTimezone: "Asia/Bangkok",
    branches: [
      { id: id(), code: "MAIN", name: "Siam Main" },
      { id: id(), code: "NORTH", name: "Siam North" },
    ],
    supplier: { id: id(), name: "Synthetic Demo Supplier" },
    products: ["Daily Rice", "Tea", "Milk", "Noodles", "Soap", "Gift"].map(
      (item, index) => ({
        id: id(),
        sku: `D30-${index}`,
        name: item,
        unit: "EA",
        basePrice: String(20 + index * 10),
      }),
    ),
    members: [
      "OWNER",
      "ADMIN",
      "BRANCH_MANAGER",
      "INVENTORY_STAFF",
      "CASHIER",
    ].map((role, index) => ({
      emailSha256: digest(index),
      role,
      branchCodes: role === "OWNER" || role === "ADMIN" ? [] : ["MAIN"],
    })),
  });
}

describe("Production demo organization name", () => {
  it("accepts an unrelated new organization name", () => {
    const parsed = parseDemoProductionSpec(
      specWithOrganizationName("Siam Mart Production 30D"),
    );
    expect(parsed.spec.organization.name).toBe("Siam Mart Production 30D");
    expect(parsed.digest).toMatch(/^[0-9a-f]{16}$/);
  });

  it.each([...DEMO_ORGANIZATION_NAMES])(
    "rejects the existing demo name %s",
    (name) => {
      expect(() =>
        parseDemoProductionSpec(specWithOrganizationName(name)),
      ).toThrow(/DEMOPROD_SPEC_INVALID/u);
    },
  );

  it.each(["Siam Mart", "siam mart", "SIAM MART", "uat demo siam mart"])(
    "rejects the demo name %s case-insensitively",
    (name) => {
      expect(() =>
        parseDemoProductionSpec(specWithOrganizationName(name)),
      ).toThrow(/DEMOPROD_SPEC_INVALID/u);
    },
  );
});
