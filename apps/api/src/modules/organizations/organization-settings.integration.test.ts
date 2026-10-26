import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../../app.ts";
import { startApiServer, type RunningApiServer } from "../../server.ts";
import { loadTestDatabaseEnvironment } from "../../test/database-environment.ts";
import {
  createTestPrismaClient,
  resetTestDatabase,
} from "../../test/database-harness.ts";
import { createPrismaOrganizationSettingsRepository } from "./organization-settings-repository.ts";
import { organizationNameUpdateSchema } from "./organization-settings-schema.ts";
import { hashSessionToken } from "../identity/session-token.ts";
import { createAuthenticationMiddleware } from "../identity/authentication-context.ts";
import { createPrismaAuthenticationSessionRepository } from "../identity/authentication-repository.ts";
import { SESSION_COOKIE_NAME } from "../identity/session-cookie.ts";
import { createOrganizationSettingsRouter } from "./organization-settings-router.ts";
import { createOrganizationSettingsService } from "./organization-settings-service.ts";

const environment = loadTestDatabaseEnvironment();
const prisma = createTestPrismaClient(environment);
const now = new Date("2026-10-25T12:00:00.000Z");
const token = "A".repeat(43);

async function user(email: string, verified = true) {
  return prisma.user.create({
    data: {
      email,
      emailVerifiedAt: verified ? now : null,
      passwordHash: "$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$c2NoZW1hLXRlc3Q",
    },
  });
}

async function organization(name = "Original") {
  return prisma.organization.create({ data: { name } });
}

async function membership(
  organizationId: string,
  userId: string,
  role: "OWNER" | "ADMIN" | "BRANCH_MANAGER" | "INVENTORY_STAFF" | "CASHIER",
) {
  return prisma.organizationMembership.create({
    data: { organizationId, userId, role },
  });
}

const repository = createPrismaOrganizationSettingsRepository(
  prisma,
  () => now,
);

describe("organization settings with PostgreSQL", () => {
  let server: RunningApiServer | undefined;
  async function start(clock = now) {
    const router = createOrganizationSettingsRouter({
      authenticationMiddleware: createAuthenticationMiddleware({
        configuration: {
          absoluteTimeoutMilliseconds: 86_400_000,
          idleTimeoutMilliseconds: 3_600_000,
          secureCookie: false,
          touchIntervalMilliseconds: 900_000,
        },
        now: () => clock,
        repository: createPrismaAuthenticationSessionRepository(prisma),
      }),
      organizationSettingsService: createOrganizationSettingsService({
        repository,
      }),
      publicWebOrigin: "http://localhost:3000",
    });
    server = await startApiServer(
      createApp({ apiRouter: router, logger: { error() {}, info() {} } }),
      { host: "127.0.0.1", port: 0 },
    );
    return `http://${server.address.host}:${server.address.port}/api/v1`;
  }

  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });
  beforeEach(async () => resetTestDatabase(environment));
  afterAll(async () => {
    await resetTestDatabase(environment);
    await prisma.$disconnect();
  });

  it.each(["OWNER", "ADMIN"] as const)(
    "allows %s to read and rename only their active organization",
    async (role) => {
      const target = await organization("連鎖店 🏪");
      const other = await organization("Other tenant");
      const actor = await user(`${role.toLowerCase()}-settings@example.com`);
      await membership(target.id, actor.id, role);
      const branch = await prisma.branch.create({
        data: { code: "MAIN", name: "Main", organizationId: target.id },
      });
      const session = await prisma.session.create({
        data: {
          // Own every session timestamp; database now() outlives this frozen clock.
          createdAt: now,
          updatedAt: now,
          issuedAt: now,
          lastUsedAt: now,
          absoluteExpiresAt: new Date(now.getTime() + 86_400_000),
          idleExpiresAt: new Date(now.getTime() + 3_600_000),
          tokenHash: hashSessionToken(token),
          userId: actor.id,
        },
      });
      const before = await prisma.organization.findUniqueOrThrow({
        where: { id: target.id },
      });
      const userBefore = await prisma.user.findUniqueOrThrow({
        where: { id: actor.id },
      });
      const sessionBefore = await prisma.session.findUniqueOrThrow({
        where: { id: session.id },
      });
      const branchBefore = await prisma.branch.findUniqueOrThrow({
        where: { id: branch.id },
      });
      const memberBefore =
        await prisma.organizationMembership.findUniqueOrThrow({
          where: {
            organizationId_userId: {
              organizationId: target.id,
              userId: actor.id,
            },
          },
        });
      const base = await start();
      const response = await fetch(`${base}/organizations/${target.id}`, {
        headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        data: { id: target.id, name: "連鎖店 🏪" },
      });
      const current = await repository.get(actor.id, target.id);
      expect(current).toMatchObject({
        kind: "success",
        organization: { id: target.id, name: "連鎖店 🏪" },
      });
      if (current.kind !== "success")
        throw new Error("expected authorized read");
      const renamed = await repository.update(
        actor.id,
        target.id,
        organizationNameUpdateSchema.parse({
          name: "  名称 Café  🛍️ ",
          expectedUpdatedAt: current.organization.updatedAt,
        }),
      );
      expect(renamed).toMatchObject({
        kind: "success",
        organization: { id: target.id, name: "名称 Café  🛍️" },
      });
      expect(await repository.get(actor.id, other.id)).toEqual({
        kind: "forbidden",
      });
      const after = await prisma.organization.findUniqueOrThrow({
        where: { id: target.id },
      });
      expect(after.updatedAt.getTime()).toBeGreaterThan(
        before.updatedAt.getTime(),
      );
      expect(after.salesVatStatus).toBe(before.salesVatStatus);
      expect(after.salesVatRate).toEqual(before.salesVatRate);
      expect(after.reportingTimezone).toBe(before.reportingTimezone);
      const userAfter = await prisma.user.findUniqueOrThrow({
        where: { id: actor.id },
      });
      const sessionAfter = await prisma.session.findUniqueOrThrow({
        where: { id: session.id },
      });
      const branchAfter = await prisma.branch.findUniqueOrThrow({
        where: { id: branch.id },
      });
      const memberAfter = await prisma.organizationMembership.findUniqueOrThrow(
        {
          where: {
            organizationId_userId: {
              organizationId: target.id,
              userId: actor.id,
            },
          },
        },
      );
      expect(userAfter.passwordHash).toBe(userBefore.passwordHash);
      expect(userAfter.credentialVersion).toBe(userBefore.credentialVersion);
      expect(sessionAfter).toEqual(sessionBefore);
      expect(branchAfter).toEqual(branchBefore);
      expect(memberAfter).toEqual(memberBefore);
    },
  );
  it.each(["idle", "absolute", "revoked", "unknown"] as const)(
    "rejects a %s session before organization settings access",
    async (state) => {
      const target = await organization();
      const actor = await user("expired-settings@example.com");
      await membership(target.id, actor.id, "OWNER");
      const expiresAt = new Date(now.getTime() + 3_600_000);
      await prisma.session.create({
        data: {
          createdAt: now,
          updatedAt: now,
          issuedAt: now,
          lastUsedAt: now,
          idleExpiresAt: expiresAt,
          absoluteExpiresAt:
            state === "absolute"
              ? expiresAt
              : new Date(now.getTime() + 86_400_000),
          revokedAt: state === "revoked" ? now : null,
          tokenHash: hashSessionToken(token),
          userId: actor.id,
        },
      });
      const base = await start(
        state === "idle" || state === "absolute" ? expiresAt : now,
      );
      const response = await fetch(`${base}/organizations/${target.id}`, {
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${state === "unknown" ? "B".repeat(43) : token}`,
        },
      });
      expect(response.status).toBe(401);
      expect(
        await prisma.organization.findUniqueOrThrow({
          where: { id: target.id },
        }),
      ).toMatchObject({ name: "Original" });
    },
  );

  it.each(["BRANCH_MANAGER", "INVENTORY_STAFF", "CASHIER"] as const)(
    "rejects %s reads and writes",
    async (role) => {
      const target = await organization();
      const actor = await user(`${role.toLowerCase()}-settings@example.com`);
      await membership(target.id, actor.id, role);
      expect(await repository.get(actor.id, target.id)).toEqual({
        kind: "forbidden",
      });
      expect(
        await repository.update(
          actor.id,
          target.id,
          organizationNameUpdateSchema.parse({
            name: "Not changed",
            expectedUpdatedAt: now.toISOString(),
          }),
        ),
      ).toEqual({ kind: "forbidden" });
    },
  );

  it("rejects unverified actors and inactive organizations", async () => {
    const target = await organization();

    const unverified = await user("unverified-settings@example.com", false);
    await membership(target.id, unverified.id, "OWNER");
    expect(await repository.get(unverified.id, target.id)).toEqual({
      kind: "forbidden",
    });

    const inactive = await organization("Inactive");
    const verifiedOwner = await user("inactive-org-owner-settings@example.com");
    await membership(inactive.id, verifiedOwner.id, "OWNER");
    await prisma.organization.update({
      where: { id: inactive.id },
      data: { status: "INACTIVE", deactivatedAt: new Date() },
    });
    expect(await repository.get(verifiedOwner.id, inactive.id)).toEqual({
      kind: "forbidden",
    });
    await expect(
      repository.update(
        verifiedOwner.id,
        inactive.id,
        organizationNameUpdateSchema.parse({
          name: "No change",
          expectedUpdatedAt: now.toISOString(),
        }),
      ),
    ).resolves.toEqual({ kind: "forbidden" });
  });

  it("serializes competing renames, returns stale, and accepts duplicate Unicode names", async () => {
    const target = await organization("Same");
    const actor = await user("concurrent-settings@example.com");
    await membership(target.id, actor.id, "OWNER");
    const snapshot = await repository.get(actor.id, target.id);
    if (snapshot.kind !== "success")
      throw new Error("expected authorized read");
    const input = (name: string) =>
      organizationNameUpdateSchema.parse({
        name,
        expectedUpdatedAt: snapshot.organization.updatedAt,
      });
    const outcomes = await Promise.all([
      repository.update(actor.id, target.id, input("同名 店")),
      repository.update(actor.id, target.id, input("同名 店")),
    ]);
    expect(outcomes.filter(({ kind }) => kind === "success")).toHaveLength(1);
    expect(outcomes.filter(({ kind }) => kind === "stale")).toHaveLength(1);
    const latest = await repository.get(actor.id, target.id);
    if (latest.kind !== "success") throw new Error("expected authorized read");
    await expect(
      repository.update(
        actor.id,
        target.id,
        organizationNameUpdateSchema.parse({
          name: "同名 店",
          expectedUpdatedAt: latest.organization.updatedAt,
        }),
      ),
    ).resolves.toMatchObject({
      kind: "success",
      organization: { name: "同名 店" },
    });
  });

  it("denies a revoked membership at the mutation boundary", async () => {
    const target = await organization();
    const actor = await user("revoked-settings@example.com");
    await membership(target.id, actor.id, "OWNER");
    await prisma.organizationMembership.update({
      where: {
        organizationId_userId: { organizationId: target.id, userId: actor.id },
      },
      data: { status: "INACTIVE", deactivatedAt: new Date() },
    });
    await expect(
      repository.update(
        actor.id,
        target.id,
        organizationNameUpdateSchema.parse({
          name: "No change",
          expectedUpdatedAt: now.toISOString(),
        }),
      ),
    ).resolves.toEqual({ kind: "forbidden" });
  });
});
