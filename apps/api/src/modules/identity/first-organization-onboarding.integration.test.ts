import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../../app.ts";
import type { ApiLogger } from "../../logger.ts";
import { startApiServer, type RunningApiServer } from "../../server.ts";
import { loadTestDatabaseEnvironment } from "../../test/database-environment.ts";
import {
  createTestPrismaClient,
  resetTestDatabase,
} from "../../test/database-harness.ts";
import {
  createNativeTestAuthenticationMiddleware,
  createNativeTestSession,
} from "../../test/native-session-fixture.ts";
import {
  createPrismaFirstOrganizationOnboardingRepository,
  type FirstOrganizationOnboardingTransactionStage,
} from "./first-organization-onboarding-repository.ts";
import { createFirstOrganizationOnboardingRouter } from "./first-organization-onboarding-router.ts";
import {
  firstOrganizationOnboardingRequestSchema,
  hashFirstOrganizationOnboardingRequest,
} from "./first-organization-onboarding-schema.ts";
import { createFirstOrganizationOnboardingService } from "./first-organization-onboarding-service.ts";
import type { SessionConfiguration } from "./session-configuration.ts";

const environment = loadTestDatabaseEnvironment();
const prisma = createTestPrismaClient(environment);
const NOW = new Date();
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;
const configuration: SessionConfiguration = {
  absoluteTimeoutMilliseconds: 7 * DAY_MILLISECONDS,
  idleTimeoutMilliseconds: DAY_MILLISECONDS,
  secureCookie: false,
  touchIntervalMilliseconds: 15 * 60 * 1000,
};
const canonicalInput = firstOrganizationOnboardingRequestSchema.parse({
  branchAddress: "  1 Main Road  ",
  branchName: "  Main  Branch  ",
  branchPhone: "  +66 2 000 0000  ",
  displayName: "  Owner  Name  ",
  organizationName: "  Example  Store  ",
  phone: "   ",
});

describe("first organization onboarding with PostgreSQL", () => {
  let runningServer: RunningApiServer | undefined;

  beforeEach(async () => {
    await resetTestDatabase(environment);
  });

  afterEach(async () => {
    await runningServer?.stop();
    runningServer = undefined;
  });

  afterAll(async () => {
    await resetTestDatabase(environment);
    await prisma.$disconnect();
  });

  async function seedUser({
    displayName = null,
    email,
    phone = null,
    verified = true,
  }: {
    displayName?: string | null;
    email: string;
    phone?: string | null;
    verified?: boolean;
  }) {
    return prisma.user.create({
      data: {
        displayName,
        email,
        emailVerifiedAt: verified ? new Date(NOW.getTime() - 1_000) : null,
        phone,
      },
    });
  }

  async function seedSession(userId: string) {
    const session = await createNativeTestSession(prisma, userId, {
      createdAt: NOW,
      updatedAt: NOW,
      expiresAt: new Date(NOW.getTime() + 7 * DAY_MILLISECONDS),
    });
    return session.cookie;
  }

  async function startApplication(
    afterStage?: (
      stage: FirstOrganizationOnboardingTransactionStage,
    ) => Promise<void> | void,
  ) {
    const logger: ApiLogger = { error() {}, info() {} };
    const authenticationMiddleware = createNativeTestAuthenticationMiddleware(
      prisma,
      { configuration, now: () => NOW },
    );
    const onboardingService = createFirstOrganizationOnboardingService({
      repository: createPrismaFirstOrganizationOnboardingRepository(
        prisma,
        afterStage === undefined ? {} : { afterStage },
      ),
    });
    const apiRouter = createFirstOrganizationOnboardingRouter({
      authenticationMiddleware,
      onboardingService,
      publicWebOrigin: "http://localhost:3000",
    });
    runningServer = await startApiServer(createApp({ apiRouter, logger }), {
      host: "127.0.0.1",
      port: 0,
    });

    return `http://${runningServer.address.host}:${runningServer.address.port}/api/v1/organizations`;
  }

  function post(url: string, body: unknown, rawToken?: string) {
    return fetch(url, {
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        ...(rawToken === undefined ? {} : { cookie: rawToken }),
      },
      method: "POST",
    });
  }

  it("atomically creates the profile, organization, OWNER, MAIN branch, and private provenance", async () => {
    const user = await seedUser({
      displayName: "Old Name",
      email: "success@example.com",
      phone: "old-phone",
    });
    const rawToken = await seedSession(user.id);
    const url = await startApplication();

    const response = await post(
      url,
      {
        branchAddress: "  1 Main Road  ",
        branchName: "  Main  Branch  ",
        branchPhone: "  +66 2 000 0000  ",
        displayName: "  Owner  Name  ",
        organizationName: "  Example  Store  ",
        phone: "   ",
      },
      rawToken,
    );
    const responseText = await response.text();
    const body = JSON.parse(responseText) as {
      data: {
        branch: { id: string };
        organization: { id: string };
        user: { id: string };
      };
    };
    const persistedUser = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    const onboarding =
      await prisma.firstOrganizationOnboarding.findUniqueOrThrow({
        where: { userId: user.id },
      });
    const persistedOrganization = await prisma.organization.findUniqueOrThrow({
      where: { id: onboarding.organizationId },
    });

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      data: {
        branch: {
          address: "1 Main Road",
          code: "MAIN",
          id: onboarding.branchId,
          name: "Main  Branch",
          phone: "+66 2 000 0000",
        },
        nextStep: "app",
        organization: {
          id: onboarding.organizationId,
          name: "Example  Store",
        },
        role: "OWNER",
        user: { displayName: "Owner  Name", id: user.id, phone: null },
      },
    });
    expect(responseText).not.toContain("requestHash");
    expect(responseText).not.toContain(onboarding.requestHash);
    expect(persistedUser).toMatchObject({
      displayName: "Owner  Name",
      phone: null,
    });
    expect(persistedOrganization.reportingTimezone).toBe("Asia/Bangkok");
    expect(onboarding.requestHash).toBe(
      hashFirstOrganizationOnboardingRequest(canonicalInput),
    );
    expect(await prisma.organization.count()).toBe(1);
    expect(
      await prisma.organizationMembership.findUniqueOrThrow({
        where: {
          organizationId_userId: {
            organizationId: body.data.organization.id,
            userId: body.data.user.id,
          },
        },
      }),
    ).toMatchObject({ role: "OWNER", status: "ACTIVE" });
    expect(
      await prisma.branch.findUniqueOrThrow({
        where: { id: body.data.branch.id },
      }),
    ).toMatchObject({
      code: "MAIN",
      organizationId: body.data.organization.id,
    });
    expect(await prisma.branchAssignment.count()).toBe(0);
    expect(await prisma.firstOrganizationOnboarding.count()).toBe(1);
  });

  it("replays an identical request without reapplying profile values or creating rows", async () => {
    const user = await seedUser({ email: "replay@example.com" });
    const rawToken = await seedSession(user.id);
    const url = await startApplication();
    const request = {
      branchName: "Main",
      displayName: "Initial Owner",
      organizationName: "Replay Store",
      phone: "initial-phone",
    };

    const firstResponse = await post(url, request, rawToken);
    const firstBody = (await firstResponse.json()) as { data: unknown };
    await prisma.user.update({
      where: { id: user.id },
      data: { displayName: "Later Profile", phone: "later-phone" },
    });
    const replayResponse = await post(url, request, rawToken);
    const replayBody = (await replayResponse.json()) as {
      data: {
        branch: { id: string };
        organization: { id: string };
        user: { displayName: string; id: string; phone: string | null };
      };
    };

    expect(firstResponse.status).toBe(200);
    expect(replayResponse.status).toBe(200);
    expect(replayBody.data.organization.id).toBe(
      (firstBody.data as { organization: { id: string } }).organization.id,
    );
    expect(replayBody.data.branch.id).toBe(
      (firstBody.data as { branch: { id: string } }).branch.id,
    );
    expect(replayBody.data.user).toEqual({
      displayName: "Later Profile",
      id: user.id,
      phone: "later-phone",
    });
    expect(await prisma.organization.count()).toBe(1);
    expect(await prisma.organizationMembership.count()).toBe(1);
    expect(await prisma.branch.count()).toBe(1);
    expect(await prisma.firstOrganizationOnboarding.count()).toBe(1);
  });

  it("returns ALREADY_ONBOARDED for a different payload without mutation", async () => {
    const user = await seedUser({ email: "different-replay@example.com" });
    const rawToken = await seedSession(user.id);
    const url = await startApplication();
    await post(
      url,
      {
        branchName: "Main",
        displayName: "Owner",
        organizationName: "First Store",
      },
      rawToken,
    );

    const response = await post(
      url,
      {
        branchName: "Different",
        displayName: "Changed Owner",
        organizationName: "Second Store",
      },
      rawToken,
    );
    const persistedUser = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "ALREADY_ONBOARDED" },
    });
    expect(persistedUser.displayName).toBe("Owner");
    expect(await prisma.organization.count()).toBe(1);
    expect(await prisma.branch.count()).toBe(1);
  });

  it("allows a pending invitation but blocks any active or inactive membership without changing profile", async () => {
    const invitationOrganization = await prisma.organization.create({
      data: { name: "Invitation Organization" },
    });
    const pendingUser = await seedUser({
      displayName: "Pending Profile",
      email: "pending@example.com",
    });
    const invitationIssuer = await seedUser({
      displayName: "Invitation Owner",
      email: "invitation-owner@example.com",
    });
    const issuerMembership = await prisma.organizationMembership.create({
      data: {
        organizationId: invitationOrganization.id,
        role: "OWNER",
        userId: invitationIssuer.id,
      },
    });
    await prisma.invitation.create({
      data: {
        expiresAt: new Date(NOW.getTime() + 7 * DAY_MILLISECONDS),
        intendedRole: "CASHIER",
        invitedEmail: pendingUser.email,
        issuedByMembershipId: issuerMembership.id,
        organizationId: invitationOrganization.id,
        tokenHash: "pending-invitation-hash",
      },
    });
    const service = createFirstOrganizationOnboardingService({
      repository: createPrismaFirstOrganizationOnboardingRepository(prisma),
    });

    await expect(
      service.complete(pendingUser.id, canonicalInput),
    ).resolves.toMatchObject({ kind: "success" });

    for (const membershipStatus of ["ACTIVE", "INACTIVE"] as const) {
      const user = await seedUser({
        displayName: `${membershipStatus} Profile`,
        email: `${membershipStatus.toLowerCase()}@example.com`,
        phone: "unchanged",
      });
      const organization = await prisma.organization.create({
        data: { name: `${membershipStatus} Organization` },
      });
      await prisma.organizationMembership.create({
        data: {
          ...(membershipStatus === "INACTIVE"
            ? { deactivatedAt: NOW, status: "INACTIVE" as const }
            : {}),
          organizationId: organization.id,
          role: "CASHIER",
          userId: user.id,
        },
      });

      await expect(service.complete(user.id, canonicalInput)).resolves.toEqual({
        kind: "already_has_organization_access",
      });
      await expect(
        prisma.user.findUniqueOrThrow({ where: { id: user.id } }),
      ).resolves.toMatchObject({
        displayName: `${membershipStatus} Profile`,
        phone: "unchanged",
      });
      expect(
        await prisma.firstOrganizationOnboarding.count({
          where: { userId: user.id },
        }),
      ).toBe(0);
    }
  });

  it("denies missing and unverified sessions", async () => {
    const unverified = await seedUser({
      email: "unverified-onboarding@example.com",
      verified: false,
    });
    const rawToken = await seedSession(unverified.id);
    const url = await startApplication();
    const body = {
      branchName: "Main",
      displayName: "Owner",
      organizationName: "Store",
    };

    expect((await post(url, body)).status).toBe(401);
    expect((await post(url, body, rawToken)).status).toBe(401);
    expect(await prisma.organization.count()).toBe(0);
    expect(await prisma.firstOrganizationOnboarding.count()).toBe(0);
  });

  it("serializes identical and different simultaneous requests per user", async () => {
    const sameUser = await seedUser({ email: "same-concurrent@example.com" });
    const differentUser = await seedUser({
      email: "different-concurrent@example.com",
    });
    const sameToken = await seedSession(sameUser.id);
    const differentToken = await seedSession(differentUser.id);
    const url = await startApplication();
    const sameRequest = {
      branchName: "Main",
      displayName: "Same Owner",
      organizationName: "Same Store",
    };

    const sameResponses = await Promise.all([
      post(url, sameRequest, sameToken),
      post(url, sameRequest, sameToken),
    ]);
    const differentResponses = await Promise.all([
      post(
        url,
        {
          branchName: "First",
          displayName: "First Owner",
          organizationName: "First Store",
        },
        differentToken,
      ),
      post(
        url,
        {
          branchName: "Second",
          displayName: "Second Owner",
          organizationName: "Second Store",
        },
        differentToken,
      ),
    ]);
    const sameBodies = await Promise.all(
      sameResponses.map((response) => response.json()),
    );
    const sameOrganizationIds = sameBodies.map(
      (body) =>
        (body as { data: { organization: { id: string } } }).data.organization
          .id,
    );

    expect(sameResponses.map(({ status }) => status)).toEqual([200, 200]);
    expect(new Set(sameOrganizationIds).size).toBe(1);
    expect(differentResponses.map(({ status }) => status).sort()).toEqual([
      200, 409,
    ]);
    const differentBodies = await Promise.all(
      differentResponses.map((response) => response.json()),
    );
    expect(
      differentBodies.some(
        (body) =>
          (body as { error?: { code?: string } }).error?.code ===
          "ALREADY_ONBOARDED",
      ),
    ).toBe(true);
    expect(await prisma.firstOrganizationOnboarding.count()).toBe(2);
    expect(await prisma.organization.count()).toBe(2);
    expect(await prisma.organizationMembership.count()).toBe(2);
    expect(await prisma.branch.count()).toBe(2);
  });

  it("rolls back every meaningful transaction stage and returns a safe dependency failure", async () => {
    const stages: FirstOrganizationOnboardingTransactionStage[] = [
      "profile_updated",
      "organization_created",
      "owner_membership_created",
      "branch_created",
      "provenance_created",
    ];

    for (const stageToFail of stages) {
      await resetTestDatabase(environment);
      const user = await seedUser({
        displayName: "Before Failure",
        email: `${stageToFail}@example.com`,
        phone: "before-phone",
      });
      const rawToken = await seedSession(user.id);
      const url = await startApplication((stage) => {
        if (stage === stageToFail) {
          throw new Error(`induced-${stage}`);
        }
      });

      const response = await post(
        url,
        {
          branchName: "Main",
          displayName: "After Failure",
          organizationName: "Failed Store",
          phone: "after-phone",
        },
        rawToken,
      );
      const responseText = await response.text();

      expect(response.status).toBe(500);
      expect(responseText).toContain("INTERNAL_ERROR");
      expect(responseText).not.toContain(`induced-${stageToFail}`);
      await expect(
        prisma.user.findUniqueOrThrow({ where: { id: user.id } }),
      ).resolves.toMatchObject({
        displayName: "Before Failure",
        phone: "before-phone",
      });
      expect(await prisma.organization.count()).toBe(0);
      expect(await prisma.organizationMembership.count()).toBe(0);
      expect(await prisma.branch.count()).toBe(0);
      expect(await prisma.firstOrganizationOnboarding.count()).toBe(0);

      await runningServer?.stop();
      runningServer = undefined;
    }
  }, 15_000);
});
