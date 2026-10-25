import type { PrismaClient } from "../../generated/prisma/client.ts";
import type { UpdateProfileInput } from "./profile-schema.ts";

export interface SelfProfile {
  displayName: string | null;
  email: string;
  id: string;
  phone: string | null;
  updatedAt: string;
}

export type UpdateProfileOutcome =
  | { kind: "updated"; profile: SelfProfile }
  | { kind: "stale" }
  | { kind: "missing" };

export interface SelfProfileRepository {
  get(actorUserId: string): Promise<SelfProfile | null>;
  update(
    actorUserId: string,
    input: UpdateProfileInput,
  ): Promise<UpdateProfileOutcome>;
}

type ProfilePrismaClient = Pick<PrismaClient, "user">;

const profileSelect = {
  displayName: true,
  email: true,
  id: true,
  phone: true,
  updatedAt: true,
} as const;

function toSelfProfile(user: {
  displayName: string | null;
  email: string;
  id: string;
  phone: string | null;
  updatedAt: Date;
}): SelfProfile {
  return { ...user, updatedAt: user.updatedAt.toISOString() };
}

export function createPrismaSelfProfileRepository(
  prisma: ProfilePrismaClient,
  now: () => Date = () => new Date(),
): SelfProfileRepository {
  return {
    async get(actorUserId) {
      const user = await prisma.user.findUnique({
        where: { id: actorUserId },
        select: profileSelect,
      });
      return user === null ? null : toSelfProfile(user);
    },
    async update(actorUserId, input) {
      const expectedUpdatedAt = new Date(input.expectedUpdatedAt);
      const updatedAt = new Date(
        Math.max(now().getTime(), expectedUpdatedAt.getTime() + 1),
      );
      const updated = await prisma.user.updateManyAndReturn({
        where: { id: actorUserId, updatedAt: expectedUpdatedAt },
        data: {
          displayName: input.displayName,
          ...(input.phone === undefined ? {} : { phone: input.phone }),
          updatedAt,
        },
        select: profileSelect,
      });
      if (updated.length === 0) {
        const exists = await prisma.user.findUnique({
          where: { id: actorUserId },
          select: { id: true },
        });
        return exists === null ? { kind: "missing" } : { kind: "stale" };
      }
      const updatedUser = updated[0];
      if (updatedUser === undefined) return { kind: "missing" };
      return { kind: "updated", profile: toSelfProfile(updatedUser) };
    },
  };
}
