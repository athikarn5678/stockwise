import type { PrismaClient } from "../../generated/prisma/client.ts";
import { hashOneTimeToken } from "./one-time-token.ts";

export interface ContinuationInvitation {
  consumedAt: Date | null;
  expiresAt: Date;
  invitedEmail: string;
  replacedAt: Date | null;
  revokedAt: Date | null;
}

export interface InvitationContinuationRepository {
  findForToken(token: string): Promise<ContinuationInvitation | null>;
}

export function createPrismaInvitationContinuationRepository(
  prisma: PrismaClient,
): InvitationContinuationRepository {
  return {
    findForToken(token) {
      return prisma.invitation.findUnique({
        where: { tokenHash: hashOneTimeToken(token) },
        select: {
          consumedAt: true,
          expiresAt: true,
          invitedEmail: true,
          replacedAt: true,
          revokedAt: true,
        },
      });
    },
  };
}
