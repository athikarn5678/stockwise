import { createHash } from "node:crypto";
import { z } from "zod";

import { Prisma, type PrismaClient } from "../generated/prisma/client.ts";

/**
 * One-time reconciliation of organizations that still have two active OWNERs
 * (owner-approved 2026-10-29, ADR-041). Operator-only: the API deliberately has
 * no route that changes an OWNER.
 *
 * The spec names every membership by full ID plus a SHA-256 of the account
 * email, so no personal data travels in the ECS override and no truncated ID or
 * name is ever matched. Each organization is processed in its own transaction
 * that locks the organization row and refuses on ANY difference from the
 * approved state. The only write is OWNER -> ADMIN on the demoted membership
 * plus one access event; users, credentials, sessions, invitations, branch
 * assignments and history are never touched. A completed organization is
 * recognized from its recorded event, so retries write nothing.
 */

const uuid = z.string().uuid();
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const millisecondUtc = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => !Number.isNaN(Date.parse(value)))
  .transform((value) => new Date(value));

const memberReferenceSchema = z
  .object({
    emailSha256: sha256Hex,
    expectedUpdatedAt: millisecondUtc,
    membershipId: uuid,
    userId: uuid,
  })
  .strict();

export const ownerReconciliationSpecSchema = z
  .object({
    organizations: z
      .array(
        z
          .object({
            demoted: memberReferenceSchema,
            organizationId: uuid,
            retained: memberReferenceSchema,
          })
          .strict()
          .refine(
            ({ demoted, retained }) =>
              demoted.membershipId !== retained.membershipId &&
              demoted.userId !== retained.userId,
          ),
      )
      .min(1)
      .max(10)
      .refine(
        (entries) =>
          new Set(entries.map(({ organizationId }) => organizationId)).size ===
          entries.length,
      ),
    version: z.literal(1),
  })
  .strict();

export type OwnerReconciliationSpec = z.infer<
  typeof ownerReconciliationSpecSchema
>;
type MemberReference = z.infer<typeof memberReferenceSchema>;

export type ReconciliationMode = "verify" | "dry-run" | "apply";

export type ReconciliationRefusalCode =
  | "ORGANIZATION_STATE"
  | "OWNER_SET_MISMATCH"
  | "RETAINED_MISMATCH"
  | "DEMOTED_MISMATCH"
  | "CONCURRENT_CHANGE"
  | "UNEXPECTED_ASSIGNMENTS"
  | "EVENT_STATE"
  | "POSTCONDITION"
  | "CONFIRMATION"
  | "CENSUS_VIOLATION";

/** Message carries only a fixed code and an 8-character organization prefix. */
export class ReconciliationRefusal extends Error {
  readonly code: ReconciliationRefusalCode;
  constructor(code: ReconciliationRefusalCode, organizationId?: string) {
    super(
      organizationId === undefined
        ? `RECONCILE_${code}`
        : `RECONCILE_${code}: ${prefix(organizationId)}`,
    );
    this.code = code;
  }
}

function prefix(id: string): string {
  return id.slice(0, 8);
}

export function specDigest(rawSpec: string): string {
  return createHash("sha256").update(rawSpec).digest("hex").slice(0, 16);
}

export function emailDigest(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

type Transaction = Prisma.TransactionClient;
type OrganizationOutcome = "PENDING" | "ALREADY_RECONCILED";

async function loadMember(
  tx: Transaction,
  organizationId: string,
  reference: MemberReference,
) {
  const row = await tx.organizationMembership.findUnique({
    where: {
      organizationId_id: { id: reference.membershipId, organizationId },
    },
    select: {
      branchAssignments: { select: { status: true } },
      id: true,
      role: true,
      status: true,
      updatedAt: true,
      user: { select: { email: true, id: true, status: true } },
      userId: true,
    },
  });
  if (
    row === null ||
    row.userId !== reference.userId ||
    row.user.id !== reference.userId ||
    emailDigest(row.user.email) !== reference.emailSha256
  ) {
    return null;
  }
  return row;
}

/**
 * Validates one organization against its approved entry and returns whether a
 * change is still needed. Throws ReconciliationRefusal on any other state.
 */
async function inspectOrganization(
  tx: Transaction,
  entry: OwnerReconciliationSpec["organizations"][number],
): Promise<OrganizationOutcome> {
  const { demoted, organizationId, retained } = entry;
  const organization = await tx.organization.findUnique({
    where: { id: organizationId },
    select: { status: true },
  });
  if (organization === null || organization.status !== "ACTIVE") {
    throw new ReconciliationRefusal("ORGANIZATION_STATE", organizationId);
  }

  const activeOwners = await tx.organizationMembership.findMany({
    where: { organizationId, role: "OWNER", status: "ACTIVE" },
    select: { id: true },
  });
  const activeOwnerIds = new Set(activeOwners.map(({ id }) => id));

  const retainedRow = await loadMember(tx, organizationId, retained);
  if (
    retainedRow === null ||
    retainedRow.role !== "OWNER" ||
    retainedRow.status !== "ACTIVE" ||
    retainedRow.user.status !== "ACTIVE"
  ) {
    throw new ReconciliationRefusal("RETAINED_MISMATCH", organizationId);
  }
  const demotedRow = await loadMember(tx, organizationId, demoted);
  if (demotedRow === null || demotedRow.status !== "ACTIVE") {
    throw new ReconciliationRefusal("DEMOTED_MISMATCH", organizationId);
  }

  if (demotedRow.role === "ADMIN") {
    // Already reconciled: exactly the retained OWNER remains and our own
    // recorded OWNER -> ADMIN event proves the change was made by this tool.
    if (activeOwnerIds.size !== 1 || !activeOwnerIds.has(retained.membershipId))
      throw new ReconciliationRefusal("OWNER_SET_MISMATCH", organizationId);
    const events = await tx.membershipAccessEvent.count({
      where: {
        actorMembershipId: retained.membershipId,
        actorUserId: retained.userId,
        afterRole: "ADMIN",
        afterStatus: "ACTIVE",
        beforeRole: "OWNER",
        beforeStatus: "ACTIVE",
        eventType: "ROLE_SCOPE_REPLACED",
        organizationId,
        targetMembershipId: demoted.membershipId,
      },
    });
    if (events !== 1)
      throw new ReconciliationRefusal("EVENT_STATE", organizationId);
    return "ALREADY_RECONCILED";
  }

  if (
    demotedRow.role !== "OWNER" ||
    activeOwnerIds.size !== 2 ||
    !activeOwnerIds.has(retained.membershipId) ||
    !activeOwnerIds.has(demoted.membershipId)
  ) {
    throw new ReconciliationRefusal("OWNER_SET_MISMATCH", organizationId);
  }
  if (
    retainedRow.updatedAt.getTime() !== retained.expectedUpdatedAt.getTime() ||
    demotedRow.updatedAt.getTime() !== demoted.expectedUpdatedAt.getTime()
  ) {
    throw new ReconciliationRefusal("CONCURRENT_CHANGE", organizationId);
  }
  // OWNER and ADMIN are organization-wide: a branch assignment here would mean
  // the audited state is not what was approved.
  if (demotedRow.branchAssignments.some(({ status }) => status === "ACTIVE")) {
    throw new ReconciliationRefusal("UNEXPECTED_ASSIGNMENTS", organizationId);
  }
  return "PENDING";
}

async function reconcileOrganization(
  prisma: PrismaClient,
  entry: OwnerReconciliationSpec["organizations"][number],
  mode: "dry-run" | "apply",
  now: Date,
): Promise<OrganizationOutcome> {
  const { demoted, organizationId, retained } = entry;
  if (mode === "dry-run") {
    // One snapshot for every read: with the default READ COMMITTED a concurrent
    // apply could commit between two of the inspection queries and make a
    // consistent state look like a mismatch.
    return prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        return inspectOrganization(tx, entry);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
  return prisma.$transaction(async (tx) => {
    // Serializes with every API membership mutation, which takes the same lock.
    const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "organizations"
      WHERE "id" = ${organizationId}::uuid
      FOR UPDATE
    `);
    if (locked.length !== 1)
      throw new ReconciliationRefusal("ORGANIZATION_STATE", organizationId);
    const outcome = await inspectOrganization(tx, entry);
    if (outcome === "ALREADY_RECONCILED") return outcome;

    const updatedAt = new Date(
      Math.max(demoted.expectedUpdatedAt.getTime() + 1, now.getTime()),
    );
    await tx.organizationMembership.update({
      where: {
        organizationId_id: { id: demoted.membershipId, organizationId },
      },
      data: { role: "ADMIN", updatedAt },
    });
    // The event table requires an actor: the retained OWNER is recorded as the
    // owner on whose approved decision the change is made.
    await tx.membershipAccessEvent.create({
      data: {
        actorMembershipId: retained.membershipId,
        actorUserId: retained.userId,
        afterRole: "ADMIN",
        afterStatus: "ACTIVE",
        beforeRole: "OWNER",
        beforeStatus: "ACTIVE",
        eventType: "ROLE_SCOPE_REPLACED",
        occurredAt: now,
        organizationId,
        targetMembershipId: demoted.membershipId,
      },
    });
    const remaining = await tx.organizationMembership.findMany({
      where: { organizationId, role: "OWNER", status: "ACTIVE" },
      select: { id: true },
    });
    if (remaining.length !== 1 || remaining[0]?.id !== retained.membershipId)
      throw new ReconciliationRefusal("POSTCONDITION", organizationId);
    return "PENDING";
  });
}

/** Read-only: every organization must have exactly one active OWNER. */
export async function ownerCensus(
  prisma: PrismaClient,
  report: (line: string) => void,
): Promise<void> {
  const rows = await prisma.$queryRaw<
    Array<{ id: string; owners: bigint }>
  >(Prisma.sql`
    SELECT o."id"::text AS "id", count(m."id") AS "owners"
    FROM "organizations" o
    LEFT JOIN "organization_memberships" m
      ON m."organization_id" = o."id"
     AND m."role" = 'OWNER' AND m."status" = 'ACTIVE'
    GROUP BY o."id"
    ORDER BY o."id"
  `);
  const violations = rows.filter(({ owners }) => owners !== 1n);
  for (const { id, owners } of violations) {
    report(
      `STOCKWISE_OWNER_CENSUS:violation ${prefix(id)} active_owners=${owners}`,
    );
  }
  report(
    `STOCKWISE_OWNER_CENSUS:organizations=${rows.length} exactly_one=${rows.length - violations.length} violations=${violations.length}`,
  );
  if (violations.length > 0)
    throw new ReconciliationRefusal("CENSUS_VIOLATION");
}

export async function runOwnerReconciliation(
  prisma: PrismaClient,
  input: {
    confirmDigest?: string;
    mode: ReconciliationMode;
    now?: () => Date;
    rawSpec?: string;
  },
  report: (line: string) => void,
): Promise<void> {
  if (input.mode === "verify") {
    await ownerCensus(prisma, report);
    return;
  }
  if (input.rawSpec === undefined) throw new Error("RECONCILE_SPEC_MISSING");
  const spec = ownerReconciliationSpecSchema.parse(JSON.parse(input.rawSpec));
  const digest = specDigest(input.rawSpec);
  report(`STOCKWISE_RECONCILE:spec_digest=${digest} mode=${input.mode}`);
  if (input.mode === "apply" && input.confirmDigest !== digest)
    throw new ReconciliationRefusal("CONFIRMATION");

  // Apply never starts changing anything unless every organization passes a
  // read-only preflight first; each one is then re-validated under its lock.
  if (input.mode === "apply") {
    for (const entry of spec.organizations) {
      await reconcileOrganization(prisma, entry, "dry-run", new Date());
    }
  }

  let pending = 0;
  for (const entry of spec.organizations) {
    const outcome = await reconcileOrganization(
      prisma,
      entry,
      input.mode,
      (input.now ?? (() => new Date()))(),
    );
    const label = prefix(entry.organizationId);
    if (outcome === "ALREADY_RECONCILED") {
      report(`STOCKWISE_RECONCILE:org ${label} ALREADY_RECONCILED`);
    } else if (input.mode === "dry-run") {
      pending += 1;
      report(
        `STOCKWISE_RECONCILE:org ${label} WOULD_DEMOTE ${prefix(entry.demoted.userId)} OWNER->ADMIN, RETAIN ${prefix(entry.retained.userId)}`,
      );
    } else {
      report(
        `STOCKWISE_RECONCILE:org ${label} DEMOTED ${prefix(entry.demoted.userId)} OWNER->ADMIN, RETAINED ${prefix(entry.retained.userId)}`,
      );
    }
  }
  report(
    `STOCKWISE_RECONCILE:${input.mode === "dry-run" ? `DRY_RUN_OK pending=${pending}` : "APPLY_COMPLETE"}`,
  );
  if (input.mode === "apply") await ownerCensus(prisma, report);
}
