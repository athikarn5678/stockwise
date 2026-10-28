import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { verifyPassword } from "../modules/identity/password-hasher.ts";
import { loadTestDatabaseEnvironment } from "../test/database-environment.ts";
import {
  createTestPrismaClient,
  resetTestDatabase,
} from "../test/database-harness.ts";
import {
  provisionAccounts,
  provisionMemberships,
  uatSpecSchema,
} from "./uat-provision.ts";

const environment = loadTestDatabaseEnvironment();
const prisma = createTestPrismaClient(environment);

// Argon2id PHC of a throwaway value (same parameters as production).
const HASH =
  "$argon2id$v=19$m=65536,t=3,p=4$MELWslgkJzw87Me69Wz1tw$l9XoBv1UBhpmS40M2xzT5cHzqoSubftPd1Md5u/ZmvQ";

function lines() {
  const out: string[] = [];
  return { out, report: (line: string) => out.push(line) };
}

describe("UAT provisioning", () => {
  beforeEach(async () => {
    await resetTestDatabase(environment);
  });
  afterAll(async () => {
    await resetTestDatabase(environment);
    await prisma.$disconnect();
  });

  it("rejects addresses outside the owner domain, non-uat names, and non-argon2 hashes", () => {
    const base = {
      memberships: [],
    };
    for (const accounts of [
      [{ displayName: "x", email: "uat-a@gmail.com", passwordHash: HASH }],
      [{ displayName: "x", email: "someone@hcn920.com", passwordHash: HASH }],
      [{ displayName: "x", email: "uat-a@hcn920.com", passwordHash: "plain" }],
    ]) {
      expect(uatSpecSchema.safeParse({ ...base, accounts }).success).toBe(
        false,
      );
    }
    // The production hasher emits m,p,t order; the canonical m,t,p order is accepted too.
    for (const hash of [HASH, HASH.replace("t=3,p=4", "p=4,t=3")]) {
      expect(
        uatSpecSchema.safeParse({
          accounts: [
            { displayName: "x", email: "uat-a@hcn920.com", passwordHash: hash },
          ],
          memberships: [],
        }).success,
      ).toBe(true);
    }
    expect(
      uatSpecSchema.safeParse({
        accounts: [],
        memberships: [
          {
            actorEmail: "uat-owner@hcn920.com",
            branchCodes: [],
            email: "uat-admin@hcn920.com",
            organizationName: "Real Customer Ltd",
            role: "ADMIN",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("creates verified native users once and grants memberships through the invitation repository without mail", async () => {
    const spec = uatSpecSchema.parse({
      accounts: ["owner", "admin", "cashier"].map((name) => ({
        displayName: `UAT ${name}`,
        email: `uat-${name}@hcn920.com`,
        passwordHash: HASH,
      })),
      memberships: [
        {
          actorEmail: "uat-owner@hcn920.com",
          branchCodes: [],
          email: "uat-admin@hcn920.com",
          organizationName: "UAT Test Store",
          role: "ADMIN",
        },
        {
          actorEmail: "uat-admin@hcn920.com",
          branchCodes: ["MAIN"],
          email: "uat-cashier@hcn920.com",
          organizationName: "UAT Test Store",
          role: "CASHIER",
        },
      ],
    });
    const first = lines();
    await provisionAccounts(prisma, spec, first.report);
    expect(first.out.filter((l) => l.includes(":created"))).toHaveLength(3);

    const owner = await prisma.user.findUniqueOrThrow({
      where: { email: "uat-owner@hcn920.com" },
    });
    const organization = await prisma.organization.create({
      data: { name: "UAT Test Store" },
    });
    await prisma.branch.create({
      data: { code: "MAIN", name: "Main", organizationId: organization.id },
    });
    await prisma.organizationMembership.create({
      data: {
        organizationId: organization.id,
        role: "OWNER",
        userId: owner.id,
      },
    });

    const granted = lines();
    await provisionMemberships(prisma, spec, granted.report);
    expect(granted.out.filter((l) => l.includes(":granted"))).toHaveLength(2);

    // Native readiness: verified, completed registration, credential account.
    const cashier = await prisma.user.findUniqueOrThrow({
      include: { betterAuthAccounts: true },
      where: { email: "uat-cashier@hcn920.com" },
    });
    expect(cashier).toMatchObject({ emailVerified: true, status: "ACTIVE" });
    expect(cashier.emailVerifiedAt).not.toBeNull();
    expect(cashier.nativeRegistrationCompletedAt).not.toBeNull();
    expect(cashier.betterAuthAccounts).toMatchObject([
      { accountId: cashier.id, providerId: "credential", password: HASH },
    ]);
    expect(await verifyPassword(HASH, "not-the-password")).toBe(false);

    const memberships = await prisma.organizationMembership.findMany({
      orderBy: { role: "asc" },
      select: { role: true, status: true },
      where: { organizationId: organization.id },
    });
    expect(memberships.map(({ role }) => role).sort()).toEqual([
      "ADMIN",
      "CASHIER",
      "OWNER",
    ]);
    const assignment = await prisma.branchAssignment.findMany({
      where: { userId: cashier.id },
    });
    expect(assignment).toMatchObject([{ status: "ACTIVE" }]);
    // Provenance rows come from the real acceptance path.
    expect(
      await prisma.invitation.count({
        where: { organizationId: organization.id },
      }),
    ).toBe(2);
    expect(
      await prisma.membershipAccessEvent.count({
        where: { organizationId: organization.id },
      }),
    ).toBeGreaterThanOrEqual(2);

    // Idempotent: a second run changes nothing.
    const again = lines();
    await provisionAccounts(prisma, spec, again.report);
    await provisionMemberships(prisma, spec, again.report);
    expect(again.out.every((l) => l.includes(":exists"))).toBe(true);
    expect(await prisma.user.count()).toBe(3);
    expect(await prisma.organizationMembership.count()).toBe(3);
  });
});
