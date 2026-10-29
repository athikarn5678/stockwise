import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createRecordingEmailProvider } from "../modules/identity/email-provider.ts";
import { createPrismaMembershipAccessRepository } from "../modules/identity/membership-access-repository.ts";
import { createMembershipAccessService } from "../modules/identity/membership-access-service.ts";
import { secureOneTimeTokenProvider } from "../modules/identity/one-time-token.ts";
import { loadTestDatabaseEnvironment } from "../test/database-environment.ts";
import {
  createTestPrismaClient,
  resetTestDatabase,
} from "../test/database-harness.ts";
import {
  emailDigest,
  ReconciliationRefusal,
  runOwnerReconciliation,
  specDigest,
  type ReconciliationMode,
} from "./owner-reconciliation.ts";

const environment = loadTestDatabaseEnvironment();
const prisma = createTestPrismaClient(environment);
const T0 = new Date("2026-10-28T10:00:00.000Z");
const NOW = new Date("2026-10-30T09:00:00.000Z");
const PASSWORD_HASH_FIXTURE =
  "$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$c2NoZW1hLXRlc3Q";

type Role =
  "OWNER" | "ADMIN" | "BRANCH_MANAGER" | "INVENTORY_STAFF" | "CASHIER";

async function member(
  organizationId: string,
  email: string,
  role: Role,
  branchId?: string,
) {
  const account = await prisma.user.create({
    data: {
      displayName: email.split("@")[0]!,
      email,
      emailVerifiedAt: T0,
      passwordHash: PASSWORD_HASH_FIXTURE,
    },
  });
  const row = await prisma.organizationMembership.create({
    data: { organizationId, role, userId: account.id },
  });
  if (branchId !== undefined) {
    await prisma.branchAssignment.create({
      data: { branchId, organizationId, userId: account.id },
    });
  }
  return { account, row };
}

/** Two-OWNER organization shaped like the audited production ones. */
async function twoOwnerOrganization(name: string) {
  const organization = await prisma.organization.create({ data: { name } });
  const branch = await prisma.branch.create({
    data: { code: "MAIN", name: "Main", organizationId: organization.id },
  });
  const retained = await member(
    organization.id,
    `retained@${name.toLowerCase()}.test`,
    "OWNER",
  );
  const demoted = await member(
    organization.id,
    `demoted@${name.toLowerCase()}.test`,
    "OWNER",
  );
  const cashier = await member(
    organization.id,
    `cashier@${name.toLowerCase()}.test`,
    "CASHIER",
    branch.id,
  );
  return { branch, cashier, demoted, organization, retained };
}

type Fixture = Awaited<ReturnType<typeof twoOwnerOrganization>>;

function entryFor(fixture: Fixture) {
  const reference = (value: Fixture["retained"]) => ({
    emailSha256: emailDigest(value.account.email),
    expectedUpdatedAt: value.row.updatedAt.toISOString(),
    membershipId: value.row.id,
    userId: value.account.id,
  });
  return {
    demoted: reference(fixture.demoted),
    organizationId: fixture.organization.id,
    retained: reference(fixture.retained),
  };
}

function specFor(...fixtures: Fixture[]): string {
  return JSON.stringify({
    organizations: fixtures.map(entryFor),
    version: 1,
  });
}

async function run(
  mode: ReconciliationMode,
  rawSpec?: string,
  confirmDigest?: string,
) {
  const lines: string[] = [];
  await runOwnerReconciliation(
    prisma,
    {
      ...(confirmDigest === undefined ? {} : { confirmDigest }),
      mode,
      now: () => NOW,
      ...(rawSpec === undefined ? {} : { rawSpec }),
    },
    (line) => lines.push(line),
  );
  return lines;
}

async function apply(rawSpec: string) {
  return run("apply", rawSpec, specDigest(rawSpec));
}

async function snapshot() {
  return {
    assignments: await prisma.branchAssignment.findMany({
      orderBy: { createdAt: "asc" },
    }),
    events: await prisma.membershipAccessEvent.count(),
    invitations: await prisma.invitation.findMany({ orderBy: { id: "asc" } }),
    memberships: await prisma.organizationMembership.findMany({
      orderBy: { id: "asc" },
    }),
    sessions: await prisma.session.findMany({ orderBy: { id: "asc" } }),
    users: await prisma.user.findMany({ orderBy: { id: "asc" } }),
  };
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof ReconciliationRefusal) return error.code;
    throw error;
  }
  throw new Error("Expected a reconciliation refusal.");
}

function ownerCount(organizationId: string) {
  return prisma.organizationMembership.count({
    where: { organizationId, role: "OWNER", status: "ACTIVE" },
  });
}

describe("one-time OWNER reconciliation with PostgreSQL", () => {
  beforeEach(async () => {
    await resetTestDatabase(environment);
  });

  afterAll(async () => {
    await resetTestDatabase(environment);
    await prisma.$disconnect();
  });

  it("dry-run validates the approved state and writes nothing", async () => {
    const fixture = await twoOwnerOrganization("Mango");
    const before = await snapshot();

    const lines = await run("dry-run", specFor(fixture));

    expect(lines.join("\n")).toContain("WOULD_DEMOTE");
    expect(lines.join("\n")).toContain("DRY_RUN_OK pending=1");
    expect(await snapshot()).toEqual(before);
    expect(await ownerCount(fixture.organization.id)).toBe(2);
  });

  it("never prints an address or a full identifier", async () => {
    const fixture = await twoOwnerOrganization("Mango");
    const spec = specFor(fixture);
    const output = [
      ...(await run("dry-run", spec)),
      ...(await apply(spec)),
      ...(await run("verify")),
    ].join("\n");

    expect(output).not.toContain("@");
    expect(output).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );
  });

  it("refuses apply without the exact digest of the reviewed spec", async () => {
    const fixture = await twoOwnerOrganization("Mango");
    const spec = specFor(fixture);
    const before = await snapshot();

    expect(await refusal(run("apply", spec))).toBe("CONFIRMATION");
    expect(await refusal(run("apply", spec, "0123456789abcdef"))).toBe(
      "CONFIRMATION",
    );
    expect(await snapshot()).toEqual(before);
  });

  it("demotes only the approved membership, records one event, and preserves everything else", async () => {
    const fixture = await twoOwnerOrganization("Mango");
    await prisma.session.create({
      data: {
        absoluteExpiresAt: new Date(NOW.getTime() + 86_400_000),
        idleExpiresAt: new Date(NOW.getTime() + 3_600_000),
        issuedAt: NOW,
        lastUsedAt: NOW,
        tokenHash: "demoted-session-hash",
        userId: fixture.demoted.account.id,
      },
    });
    await prisma.invitation.create({
      data: {
        expiresAt: new Date(NOW.getTime() + 86_400_000),
        intendedRole: "CASHIER",
        invitedEmail: "pending@mango.test",
        issuedAt: NOW,
        issuedByMembershipId: fixture.retained.row.id,
        organizationId: fixture.organization.id,
        tokenHash: "pending-invitation-hash",
      },
    });
    const before = await snapshot();
    const spec = specFor(fixture);

    const lines = await apply(spec);

    expect(lines.join("\n")).toContain("DEMOTED");
    expect(lines.join("\n")).toContain("violations=0");
    const after = await snapshot();
    // Users, sessions, invitations and assignments are byte-identical.
    expect(after.users).toEqual(before.users);
    expect(after.sessions).toEqual(before.sessions);
    expect(after.invitations).toEqual(before.invitations);
    expect(after.assignments).toEqual(before.assignments);
    // Only the demoted membership changed, and its version moved forward.
    const changed = after.memberships.filter(
      (row, index) =>
        JSON.stringify(row) !== JSON.stringify(before.memberships[index]),
    );
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({
      id: fixture.demoted.row.id,
      role: "ADMIN",
      status: "ACTIVE",
    });
    expect(changed[0]!.updatedAt.getTime()).toBeGreaterThan(
      fixture.demoted.row.updatedAt.getTime(),
    );
    // One new auditable event; historical events are not rewritten.
    expect(after.events).toBe(before.events + 1);
    expect(
      await prisma.membershipAccessEvent.findFirstOrThrow({
        where: { targetMembershipId: fixture.demoted.row.id },
      }),
    ).toMatchObject({
      actorMembershipId: fixture.retained.row.id,
      actorUserId: fixture.retained.account.id,
      afterRole: "ADMIN",
      afterStatus: "ACTIVE",
      beforeRole: "OWNER",
      beforeStatus: "ACTIVE",
      eventType: "ROLE_SCOPE_REPLACED",
      occurredAt: NOW,
    });
    expect(await ownerCount(fixture.organization.id)).toBe(1);
  });

  it("is idempotent: a retry and concurrent applies write exactly one event", async () => {
    const fixture = await twoOwnerOrganization("Mango");
    const spec = specFor(fixture);

    const outcomes = await Promise.all([apply(spec), apply(spec), apply(spec)]);
    expect(outcomes).toHaveLength(3);
    const retry = await apply(spec);

    expect(retry.join("\n")).toContain("ALREADY_RECONCILED");
    expect(
      await prisma.membershipAccessEvent.count({
        where: { targetMembershipId: fixture.demoted.row.id },
      }),
    ).toBe(1);
    expect(await ownerCount(fixture.organization.id)).toBe(1);
    // A dry-run after completion also reports done, not pending.
    expect((await run("dry-run", spec)).join("\n")).toContain(
      "ALREADY_RECONCILED",
    );
  });

  it("leaves the retained OWNER fully able to administer and the demoted account an ADMIN with lower-role authority only", async () => {
    const fixture = await twoOwnerOrganization("Mango");
    await apply(specFor(fixture));
    const service = createMembershipAccessService({
      emailProvider: createRecordingEmailProvider(),
      now: () => NOW,
      publicWebOrigin: "https://stockwise.example.test",
      repository: createPrismaMembershipAccessRepository(prisma),
      tokenProvider: secureOneTimeTokenProvider,
    });
    const organizationId = fixture.organization.id;
    const cashier = await prisma.organizationMembership.findFirstOrThrow({
      where: { id: fixture.cashier.row.id },
    });
    const demoted = await prisma.organizationMembership.findFirstOrThrow({
      where: { id: fixture.demoted.row.id },
    });

    // Retained OWNER: lists, invites an ADMIN, manages the demoted ADMIN.
    await expect(
      service.listMemberships({
        actorUserId: fixture.retained.account.id,
        includeInactive: true,
        limit: 10,
        organizationId,
      }),
    ).resolves.toMatchObject({ kind: "success" });
    await expect(
      service.createInvitation({
        actorUserId: fixture.retained.account.id,
        invitation: { branchIds: [], email: "a2@mango.test", role: "ADMIN" },
        organizationId,
      }),
    ).resolves.toMatchObject({ kind: "success" });

    // Demoted ADMIN: manages lower roles, never the OWNER, an ADMIN, itself.
    await expect(
      service.replaceMembership({
        actorUserId: fixture.demoted.account.id,
        membershipId: cashier.id,
        organizationId,
        replacement: {
          branchIds: [fixture.branch.id],
          expectedUpdatedAt: cashier.updatedAt,
          role: "BRANCH_MANAGER",
        },
      }),
    ).resolves.toMatchObject({ kind: "success" });
    await expect(
      service.deactivateMembership({
        actorUserId: fixture.demoted.account.id,
        expectedUpdatedAt: fixture.retained.row.updatedAt,
        membershipId: fixture.retained.row.id,
        organizationId,
      }),
    ).resolves.toEqual({ kind: "forbidden" });
    await expect(
      service.deactivateMembership({
        actorUserId: fixture.demoted.account.id,
        expectedUpdatedAt: demoted.updatedAt,
        membershipId: demoted.id,
        organizationId,
      }),
    ).resolves.toEqual({ kind: "self_modification" });
    await expect(
      service.createInvitation({
        actorUserId: fixture.demoted.account.id,
        invitation: { branchIds: [], email: "a3@mango.test", role: "ADMIN" },
        organizationId,
      }),
    ).resolves.toEqual({ kind: "forbidden" });
    // The retained OWNER can still demote that ADMIN further, proving the
    // optimistic version it holds is the one the operator wrote.
    await expect(
      service.replaceMembership({
        actorUserId: fixture.retained.account.id,
        membershipId: demoted.id,
        organizationId,
        replacement: {
          branchIds: [fixture.branch.id],
          expectedUpdatedAt: demoted.updatedAt,
          role: "CASHIER",
        },
      }),
    ).resolves.toMatchObject({ kind: "success" });
  });

  describe("aborts without any write on unexpected state", () => {
    const entryMutations: Array<
      [
        string,
        string,
        (fixture: Fixture, entry: ReturnType<typeof entryFor>) => Promise<void>,
      ]
    > = [
      [
        "a wrong membership ID",
        "DEMOTED_MISMATCH",
        async (fixture, entry) => {
          entry.demoted.membershipId = fixture.cashier.row.id;
        },
      ],
      [
        "an email that does not match the ID",
        "DEMOTED_MISMATCH",
        async (_fixture, entry) => {
          entry.demoted.emailSha256 = emailDigest("someone-else@example.test");
        },
      ],
      [
        "a user ID that does not match the membership",
        "RETAINED_MISMATCH",
        async (fixture, entry) => {
          entry.retained.userId = fixture.cashier.account.id;
        },
      ],
      [
        "a stale demoted version (concurrent change)",
        "CONCURRENT_CHANGE",
        async (fixture) => {
          await prisma.organizationMembership.updateMany({
            data: { updatedAt: new Date(NOW.getTime() - 1_000) },
            where: { id: fixture.demoted.row.id },
          });
        },
      ],
      [
        "a stale retained version (concurrent change)",
        "CONCURRENT_CHANGE",
        async (fixture) => {
          await prisma.organizationMembership.updateMany({
            data: { updatedAt: new Date(NOW.getTime() - 1_000) },
            where: { id: fixture.retained.row.id },
          });
        },
      ],
      [
        "an unexpected third OWNER",
        "OWNER_SET_MISMATCH",
        async (fixture) => {
          await member(fixture.organization.id, "third@mango.test", "OWNER");
        },
      ],
      [
        "an already deactivated demoted account",
        "DEMOTED_MISMATCH",
        async (fixture) => {
          await prisma.organizationMembership.updateMany({
            data: { deactivatedAt: NOW, status: "INACTIVE" },
            where: { id: fixture.demoted.row.id },
          });
        },
      ],
      [
        "a retained OWNER that is no longer an OWNER",
        "RETAINED_MISMATCH",
        async (fixture) => {
          await prisma.organizationMembership.updateMany({
            data: { role: "ADMIN" },
            where: { id: fixture.retained.row.id },
          });
        },
      ],
      [
        "an active branch assignment on the demoted OWNER",
        "UNEXPECTED_ASSIGNMENTS",
        async (fixture) => {
          await prisma.branchAssignment.create({
            data: {
              branchId: fixture.branch.id,
              organizationId: fixture.organization.id,
              userId: fixture.demoted.account.id,
            },
          });
        },
      ],
      [
        "an inactive organization",
        "ORGANIZATION_STATE",
        async (fixture) => {
          await prisma.organization.update({
            data: { deactivatedAt: NOW, status: "INACTIVE" },
            where: { id: fixture.organization.id },
          });
        },
      ],
      [
        "an ADMIN demoted without a recorded reconciliation event",
        "EVENT_STATE",
        async (fixture) => {
          await prisma.organizationMembership.updateMany({
            data: { role: "ADMIN" },
            where: { id: fixture.demoted.row.id },
          });
        },
      ],
    ];

    it.each(entryMutations)("refuses %s", async (_label, code, mutate) => {
      const fixture = await twoOwnerOrganization("Mango");
      const entry = entryFor(fixture);
      await mutate(fixture, entry);
      const spec = JSON.stringify({ organizations: [entry], version: 1 });
      const before = await snapshot();

      expect(await refusal(run("dry-run", spec))).toBe(code);
      expect(await refusal(apply(spec))).toBe(code);
      expect(await snapshot()).toEqual(before);
    });

    it("refuses a malformed spec before touching the database", async () => {
      const fixture = await twoOwnerOrganization("Mango");
      const truncated = JSON.stringify({
        organizations: [
          {
            ...entryFor(fixture),
            organizationId: fixture.organization.id.slice(0, 8),
          },
        ],
        version: 1,
      });
      await expect(run("dry-run", truncated)).rejects.toThrow();
      await expect(
        run(
          "dry-run",
          JSON.stringify({
            organizations: [{ ...entryFor(fixture), extra: true }],
            version: 1,
          }),
        ),
      ).rejects.toThrow();
      expect(await ownerCount(fixture.organization.id)).toBe(2);
    });

    it("does not change the first organization when a later one fails its preflight", async () => {
      const good = await twoOwnerOrganization("Mango");
      const bad = await twoOwnerOrganization("Siam");
      const badEntry = entryFor(bad);
      badEntry.demoted.expectedUpdatedAt = "2026-01-01T00:00:00.000Z";
      const spec = JSON.stringify({
        organizations: [entryFor(good), badEntry],
        version: 1,
      });
      const before = await snapshot();

      expect(await refusal(apply(spec))).toBe("CONCURRENT_CHANGE");
      expect(await snapshot()).toEqual(before);
    });
  });

  it("rolls the whole organization back when the event cannot be written", async () => {
    const fixture = await twoOwnerOrganization("Mango");
    const before = await snapshot();
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION reconcile_test_reject() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'forced failure'; END $$ LANGUAGE plpgsql
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER reconcile_test_reject BEFORE INSERT ON membership_access_events
      FOR EACH ROW EXECUTE FUNCTION reconcile_test_reject()
    `);
    try {
      await expect(apply(specFor(fixture))).rejects.toThrow();
    } finally {
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER reconcile_test_reject ON membership_access_events`,
      );
      await prisma.$executeRawUnsafe(`DROP FUNCTION reconcile_test_reject()`);
    }

    expect(await snapshot()).toEqual(before);
    expect(await ownerCount(fixture.organization.id)).toBe(2);
    // The failure left no partial state, so a clean retry succeeds.
    await apply(specFor(fixture));
    expect(await ownerCount(fixture.organization.id)).toBe(1);
  });

  it("reconciles several organizations and the census asserts exactly one active OWNER in every organization", async () => {
    const mango = await twoOwnerOrganization("Mango");
    const siam = await twoOwnerOrganization("Siam");
    const single = await prisma.organization.create({
      data: { name: "Single" },
    });
    await member(single.id, "solo@single.test", "OWNER");

    // Before reconciliation the census names the violations and fails.
    const failing: string[] = [];
    await expect(
      runOwnerReconciliation(prisma, { mode: "verify" }, (line) =>
        failing.push(line),
      ),
    ).rejects.toMatchObject({ code: "CENSUS_VIOLATION" });
    expect(failing.join("\n")).toContain("violations=2");
    expect(failing.join("\n")).toContain("active_owners=2");

    await apply(specFor(mango, siam));

    expect((await run("verify")).join("\n")).toContain(
      "organizations=3 exactly_one=3 violations=0",
    );
  });

  it("census also fails for an organization with no active OWNER", async () => {
    await prisma.organization.create({ data: { name: "Ownerless" } });
    await expect(run("verify")).rejects.toMatchObject({
      code: "CENSUS_VIOLATION",
    });
  });
});
