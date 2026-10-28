import { z } from "zod";

import type { PrismaClient } from "../generated/prisma/client.ts";
import { createPrismaMembershipAccessRepository } from "../modules/identity/membership-access-repository.ts";
import {
  hashOneTimeToken,
  secureOneTimeTokenProvider,
} from "../modules/identity/one-time-token.ts";

/**
 * Learner Lab UAT provisioning (owner-authorized, 2026-10-28).
 *
 * Creates verified Better Auth Native users for owner-controlled test
 * addresses and grants memberships through the real invitation repository
 * (issue + accept), so provenance, access events and scope rules are the
 * ones production uses. It sends no email and receives only password HASHES:
 * the plaintext passwords never leave the operator machine.
 *
 * Hard guards: every address must be uat-*@<owner domain>, every organization
 * name must start with "UAT ", and existing rows are never modified.
 */
export const UAT_EMAIL_DOMAIN = "hcn920.com";
export const UAT_ORGANIZATION_PREFIX = "UAT ";

const ROLES = [
  "OWNER",
  "ADMIN",
  "BRANCH_MANAGER",
  "INVENTORY_STAFF",
  "CASHIER",
] as const;

const emailSchema = z
  .string()
  .regex(
    new RegExp(`^uat-[a-z0-9-]{1,40}@${UAT_EMAIL_DOMAIN.replace(".", "\\.")}$`),
  );
const organizationNameSchema = z
  .string()
  .min(5)
  .max(200)
  .refine((value) => value.startsWith(UAT_ORGANIZATION_PREFIX));
// Same Argon2id parameters as the production hasher (password-hasher.ts).
const argon2HashSchema = z
  .string()
  .regex(
    /^\$argon2id\$v=19\$m=65536,(?:t=3,p=4|p=4,t=3)\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/,
  );

export const uatSpecSchema = z
  .object({
    accounts: z
      .array(
        z
          .object({
            displayName: z.string().min(1).max(200),
            email: emailSchema,
            passwordHash: argon2HashSchema,
          })
          .strict(),
      )
      .max(60),
    memberships: z
      .array(
        z
          .object({
            actorEmail: emailSchema,
            branchCodes: z.array(z.string().min(1).max(16)).max(10),
            email: emailSchema,
            organizationName: organizationNameSchema,
            role: z.enum(ROLES),
          })
          .strict(),
      )
      .max(120),
  })
  .strict();

export type UatSpec = z.infer<typeof uatSpecSchema>;
export type UatPhase = "accounts" | "memberships";

export async function provisionAccounts(
  prisma: PrismaClient,
  spec: UatSpec,
  report: (line: string) => void,
): Promise<void> {
  for (const account of spec.accounts) {
    const existing = await prisma.user.findUnique({
      select: { id: true },
      where: { email: account.email },
    });
    if (existing !== null) {
      report(`STOCKWISE_UAT_ACCOUNT:exists ${account.email} ${existing.id}`);
      continue;
    }
    const now = new Date();
    // Mirrors the Native registration writer: a verified user plus the
    // credential account holding the Argon2id hash.
    const created = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          displayName: account.displayName,
          email: account.email,
          emailVerified: true,
          emailVerifiedAt: now,
          nativeRegistrationCompletedAt: now,
        },
        select: { id: true },
      });
      await tx.betterAuthAccount.create({
        data: {
          accountId: user.id,
          password: account.passwordHash,
          providerId: "credential",
          userId: user.id,
        },
      });
      return user;
    });
    report(`STOCKWISE_UAT_ACCOUNT:created ${account.email} ${created.id}`);
  }
}

export async function provisionMemberships(
  prisma: PrismaClient,
  spec: UatSpec,
  report: (line: string) => void,
): Promise<void> {
  const repository = createPrismaMembershipAccessRepository(prisma);
  for (const grant of spec.memberships) {
    const organizations = await prisma.organization.findMany({
      select: { id: true },
      where: { name: grant.organizationName },
    });
    if (organizations.length !== 1) {
      throw new Error(
        `UAT_ORGANIZATION_NOT_UNIQUE: ${grant.organizationName} (${organizations.length})`,
      );
    }
    const organizationId = organizations[0]!.id;
    const [actor, target] = await Promise.all([
      prisma.user.findUnique({ where: { email: grant.actorEmail } }),
      prisma.user.findUnique({ where: { email: grant.email } }),
    ]);
    if (actor === null || target === null) {
      throw new Error(
        `UAT_ACCOUNT_MISSING: ${grant.actorEmail} / ${grant.email}`,
      );
    }
    const existing = await prisma.organizationMembership.findFirst({
      select: { role: true, status: true },
      where: { organizationId, userId: target.id },
    });
    if (existing !== null) {
      report(
        `STOCKWISE_UAT_MEMBERSHIP:exists ${grant.email} ${existing.role} ${existing.status}`,
      );
      continue;
    }
    const branches = await prisma.branch.findMany({
      select: { id: true },
      where: { code: { in: grant.branchCodes }, organizationId },
    });
    if (branches.length !== grant.branchCodes.length) {
      throw new Error(`UAT_BRANCH_MISSING: ${grant.email}`);
    }
    const token = secureOneTimeTokenProvider.generate();
    const issuedAt = new Date();
    const issued = await repository.issueInvitation({
      actorUserId: actor.id,
      expiresAt: new Date(issuedAt.getTime() + 60 * 60 * 1000),
      invitation: {
        branchIds: branches.map(({ id }) => id),
        email: grant.email,
        role: grant.role,
      },
      issuedAt,
      organizationId,
      tokenHash: token.tokenHash,
    });
    if (issued.kind !== "success") {
      throw new Error(
        `UAT_INVITATION_${issued.kind.toUpperCase()}: ${grant.email}`,
      );
    }
    // The raw token exists only in this process; no email is ever sent.
    const accepted = await repository.acceptInvitation({
      acceptedAt: new Date(),
      actorEmail: grant.email,
      actorUserId: target.id,
      tokenHash: hashOneTimeToken(token.rawToken),
    });
    if (accepted.kind !== "success") {
      throw new Error(
        `UAT_ACCEPT_${accepted.kind.toUpperCase()}: ${grant.email}`,
      );
    }
    report(
      `STOCKWISE_UAT_MEMBERSHIP:granted ${grant.email} ${grant.role} ${grant.branchCodes.join(",") || "-"}`,
    );
  }
}
