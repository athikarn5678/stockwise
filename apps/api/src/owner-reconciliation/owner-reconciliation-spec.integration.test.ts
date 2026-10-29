import {
  dropSingleOwnerIndex,
  restoreSingleOwnerIndex,
} from "../test/single-owner-index.ts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { loadTestDatabaseEnvironment } from "../test/database-environment.ts";
import {
  createTestPrismaClient,
  resetTestDatabase,
} from "../test/database-harness.ts";
import {
  buildOwnerReconciliationSpec,
  type OwnerApproval,
} from "./owner-reconciliation-spec.ts";
import {
  ownerReconciliationSpecSchema,
  runOwnerReconciliation,
  specDigest,
} from "./owner-reconciliation.ts";

const environment = loadTestDatabaseEnvironment();
const prisma = createTestPrismaClient(environment);
const T0 = new Date("2026-10-28T10:00:00.000Z");

async function owner(organizationId: string, email: string) {
  const user = await prisma.user.create({
    data: {
      displayName: "x",
      email,
      emailVerifiedAt: T0,
      passwordHash: "$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$c2NoZW1hLXRlc3Q",
    },
  });
  await prisma.organizationMembership.create({
    data: { organizationId, role: "OWNER", userId: user.id },
  });
  return user;
}

describe("owner reconciliation spec resolution", () => {
  // Legacy multi-owner fixtures need the pre-reconciliation schema.
  beforeAll(async () => {
    await dropSingleOwnerIndex(prisma);
  });

  beforeEach(async () => {
    await resetTestDatabase(environment);
  });
  afterAll(async () => {
    await resetTestDatabase(environment);
    await restoreSingleOwnerIndex(prisma);
    await prisma.$disconnect();
  });

  async function setup() {
    const organization = await prisma.organization.create({
      data: { name: "Mango" },
    });
    const retained = await owner(organization.id, "kanya@gmail.test");
    const demoted = await owner(organization.id, "somchai@kmitl.test");
    const approval: OwnerApproval = {
      demotedEmailHint: "so***@kmitl.test",
      demotedUserPrefix: demoted.id.slice(0, 8),
      organizationPrefix: organization.id.slice(0, 8),
      retainedEmailHint: "ka***@gmail.test",
      retainedUserPrefix: retained.id.slice(0, 8),
    };
    return { approval, demoted, organization, retained };
  }

  it("resolves prefixes and masks to full IDs and a spec the operator accepts", async () => {
    const { approval, demoted, organization, retained } = await setup();

    const raw = await buildOwnerReconciliationSpec(prisma, [approval]);
    const spec = ownerReconciliationSpecSchema.parse(JSON.parse(raw));

    expect(spec.organizations[0]).toMatchObject({
      demoted: { userId: demoted.id },
      organizationId: organization.id,
      retained: { userId: retained.id },
    });
    expect(raw).not.toContain("@");
    const lines: string[] = [];
    await runOwnerReconciliation(
      prisma,
      { mode: "dry-run", rawSpec: raw },
      (line) => lines.push(line),
    );
    expect(lines.join("\n")).toContain(`spec_digest=${specDigest(raw)}`);
  });

  it.each([
    ["a wrong email mask", { retainedEmailHint: "zz***@gmail.test" }],
    ["a wrong domain", { retainedEmailHint: "ka***@other.test" }],
    ["swapped identities", { retainedUserPrefix: "00000000" }],
    ["an unknown organization", { organizationPrefix: "ffffffff" }],
    ["a malformed prefix", { organizationPrefix: "3c4f" }],
  ])("refuses %s", async (_label, override) => {
    const { approval } = await setup();
    await expect(
      buildOwnerReconciliationSpec(prisma, [{ ...approval, ...override }]),
    ).rejects.toThrow(/^SPEC_/);
  });

  it("refuses an organization that does not have exactly two active OWNERs", async () => {
    const { approval, organization } = await setup();
    await owner(organization.id, "third@third.test");
    await expect(
      buildOwnerReconciliationSpec(prisma, [approval]),
    ).rejects.toThrow("SPEC_OWNER_SET_UNEXPECTED");
  });
});
