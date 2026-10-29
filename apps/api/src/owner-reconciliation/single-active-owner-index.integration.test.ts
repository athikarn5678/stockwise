import { readFileSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { loadTestDatabaseEnvironment } from "../test/database-environment.ts";
import {
  createTestPrismaClient,
  resetTestDatabase,
} from "../test/database-harness.ts";
import {
  dropSingleOwnerIndex,
  restoreSingleOwnerIndex,
} from "../test/single-owner-index.ts";
import {
  emailDigest,
  runOwnerReconciliation,
  specDigest,
} from "./owner-reconciliation.ts";

const environment = loadTestDatabaseEnvironment();
const prisma = createTestPrismaClient(environment);
const T0 = new Date("2026-10-28T10:00:00.000Z");
const MIGRATION = readFileSync(
  new URL(
    "../../prisma/migrations/20261030000000_single_active_owner/migration.sql",
    import.meta.url,
  ),
  "utf8",
);

async function member(
  organizationId: string,
  email: string,
  role: "OWNER" | "ADMIN",
  status: "ACTIVE" | "INACTIVE" = "ACTIVE",
) {
  const user = await prisma.user.create({
    data: {
      displayName: "x",
      email,
      emailVerifiedAt: T0,
      passwordHash: "$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$c2NoZW1hLXRlc3Q",
    },
  });
  const row = await prisma.organizationMembership.create({
    data: {
      deactivatedAt: status === "INACTIVE" ? T0 : null,
      organizationId,
      role,
      status,
      userId: user.id,
    },
  });
  return { row, user };
}

async function indexExists(): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`
    SELECT count(*) AS n FROM pg_indexes
    WHERE indexname = 'organization_memberships_single_active_owner_key'
      AND indexdef LIKE '%UNIQUE%' AND indexdef LIKE '%WHERE%'`;
  return rows[0]!.n === 1n;
}

describe("single active OWNER unique index (ADR-041 migration)", () => {
  beforeEach(async () => {
    await resetTestDatabase(environment);
    await restoreSingleOwnerIndex(prisma);
  });

  afterAll(async () => {
    await resetTestDatabase(environment);
    await restoreSingleOwnerIndex(prisma);
    await prisma.$disconnect();
  });

  it("exists as a partial unique index after the committed migration chain", async () => {
    expect(await indexExists()).toBe(true);
  });

  it("rejects a second active OWNER, but allows inactive owners, other roles and other organizations", async () => {
    const first = await prisma.organization.create({ data: { name: "One" } });
    const second = await prisma.organization.create({ data: { name: "Two" } });
    await member(first.id, "o1@one.test", "OWNER");

    await expect(member(first.id, "o2@one.test", "OWNER")).rejects.toThrow();
    await member(first.id, "former@one.test", "OWNER", "INACTIVE");
    await member(first.id, "a1@one.test", "ADMIN");
    await member(first.id, "a2@one.test", "ADMIN");
    await member(second.id, "o1@two.test", "OWNER");
    expect(
      await prisma.organizationMembership.count({
        where: { organizationId: first.id, role: "OWNER", status: "ACTIVE" },
      }),
    ).toBe(1);
  });

  it("rejects a second active OWNER created by promotion or reactivation", async () => {
    const organization = await prisma.organization.create({
      data: { name: "One" },
    });
    await member(organization.id, "o1@one.test", "OWNER");
    const admin = await member(organization.id, "a@one.test", "ADMIN");
    const former = await member(
      organization.id,
      "f@one.test",
      "OWNER",
      "INACTIVE",
    );

    await expect(
      prisma.organizationMembership.updateMany({
        data: { role: "OWNER" },
        where: { id: admin.row.id },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.organizationMembership.updateMany({
        data: { deactivatedAt: null, status: "ACTIVE" },
        where: { id: former.row.id },
      }),
    ).rejects.toThrow();
  });

  it("lets exactly one of several concurrent OWNER inserts win", async () => {
    const organization = await prisma.organization.create({
      data: { name: "Race" },
    });
    const outcomes = await Promise.allSettled(
      Array.from({ length: 4 }, (_, index) =>
        member(organization.id, `race${index}@race.test`, "OWNER"),
      ),
    );
    expect(
      outcomes.filter(({ status }) => status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      await prisma.organizationMembership.count({
        where: {
          organizationId: organization.id,
          role: "OWNER",
          status: "ACTIVE",
        },
      }),
    ).toBe(1);
  });

  it("the migration file fails on unreconciled data and succeeds once reconciliation has run", async () => {
    await dropSingleOwnerIndex(prisma);
    const organization = await prisma.organization.create({
      data: { name: "Mango" },
    });
    const retained = await member(organization.id, "r@mango.test", "OWNER");
    const demoted = await member(organization.id, "d@mango.test", "OWNER");

    await expect(prisma.$executeRawUnsafe(MIGRATION)).rejects.toThrow();
    expect(await indexExists()).toBe(false);

    const reference = (value: typeof retained) => ({
      emailSha256: emailDigest(value.user.email),
      expectedUpdatedAt: value.row.updatedAt.toISOString(),
      membershipId: value.row.id,
      userId: value.user.id,
    });
    const rawSpec = JSON.stringify({
      organizations: [
        {
          demoted: reference(demoted),
          organizationId: organization.id,
          retained: reference(retained),
        },
      ],
      version: 1,
    });
    await runOwnerReconciliation(
      prisma,
      { confirmDigest: specDigest(rawSpec), mode: "apply", rawSpec },
      () => undefined,
    );
    await runOwnerReconciliation(prisma, { mode: "verify" }, () => undefined);

    await prisma.$executeRawUnsafe(MIGRATION);
    expect(await indexExists()).toBe(true);
    // The retained OWNER keeps its row; a new second OWNER is now impossible.
    await expect(
      member(organization.id, "x@mango.test", "OWNER"),
    ).rejects.toThrow();
  });
});
