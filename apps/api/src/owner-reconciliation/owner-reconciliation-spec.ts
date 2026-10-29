import { Prisma, type PrismaClient } from "../generated/prisma/client.ts";
import {
  emailDigest,
  ownerReconciliationSpecSchema,
} from "./owner-reconciliation.ts";

/**
 * Builds the reconciliation spec from the owner's approval, which names things
 * by ID prefix and masked email (for example `ka***@gmail.com`), against the
 * latest database state. Every prefix and mask must resolve to exactly one row;
 * the spec then carries only full IDs, email digests and current versions.
 * Run against a restored copy of a fresh production export, never to write.
 */
export interface OwnerApproval {
  demotedEmailHint: string;
  demotedUserPrefix: string;
  organizationPrefix: string;
  retainedEmailHint: string;
  retainedUserPrefix: string;
}

const PREFIX = /^[0-9a-f]{8}$/;

function matchesHint(email: string, hint: string): boolean {
  const lower = email.toLowerCase();
  const at = hint.indexOf("@");
  if (at < 1) return false;
  const [localHint, domain] = [hint.slice(0, at), hint.slice(at + 1)];
  const star = localHint.indexOf("***");
  if (star < 0) return lower === hint.toLowerCase();
  return (
    lower.split("@")[0]!.startsWith(localHint.slice(0, star).toLowerCase()) &&
    lower.endsWith(`@${domain.toLowerCase()}`)
  );
}

export async function buildOwnerReconciliationSpec(
  prisma: PrismaClient,
  approvals: readonly OwnerApproval[],
): Promise<string> {
  const organizations = [];
  for (const approval of approvals) {
    for (const prefix of [
      approval.organizationPrefix,
      approval.retainedUserPrefix,
      approval.demotedUserPrefix,
    ]) {
      if (!PREFIX.test(prefix)) throw new Error("SPEC_PREFIX_INVALID");
    }
    const matches = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"::text AS "id" FROM "organizations"
      WHERE "id"::text LIKE ${`${approval.organizationPrefix}%`}
    `);
    if (matches.length !== 1) throw new Error("SPEC_ORGANIZATION_NOT_UNIQUE");
    const organizationId = matches[0]!.id;
    const owners = await prisma.organizationMembership.findMany({
      where: { organizationId, role: "OWNER", status: "ACTIVE" },
      select: {
        id: true,
        updatedAt: true,
        user: { select: { email: true, id: true } },
      },
    });
    if (owners.length !== 2) throw new Error("SPEC_OWNER_SET_UNEXPECTED");
    const pick = (userPrefix: string, hint: string) => {
      const found = owners.filter(
        ({ user }) =>
          user.id.startsWith(userPrefix) && matchesHint(user.email, hint),
      );
      if (found.length !== 1) throw new Error("SPEC_OWNER_NOT_UNIQUE");
      return found[0]!;
    };
    const retained = pick(
      approval.retainedUserPrefix,
      approval.retainedEmailHint,
    );
    const demoted = pick(approval.demotedUserPrefix, approval.demotedEmailHint);
    if (retained.id === demoted.id) throw new Error("SPEC_OWNER_NOT_UNIQUE");
    const reference = (value: typeof retained) => ({
      emailSha256: emailDigest(value.user.email),
      expectedUpdatedAt: value.updatedAt.toISOString(),
      membershipId: value.id,
      userId: value.user.id,
    });
    organizations.push({
      demoted: reference(demoted),
      organizationId,
      retained: reference(retained),
    });
  }
  const spec = { organizations, version: 1 };
  ownerReconciliationSpecSchema.parse(spec);
  return JSON.stringify(spec);
}
