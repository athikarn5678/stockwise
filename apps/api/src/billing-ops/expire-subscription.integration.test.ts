import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createPrismaBillingRepository } from "../modules/billing/billing-repository.ts";
import { loadTestDatabaseEnvironment } from "../test/database-environment.ts";
import {
  createTestPrismaClient,
  resetTestDatabase,
} from "../test/database-harness.ts";
import {
  ExpireRefusal,
  expireRehearsalSubscription,
  REHEARSAL_ORGANIZATION_ID,
} from "./expire-subscription.ts";

const environment = loadTestDatabaseEnvironment();
const prisma = createTestPrismaClient(environment);
const repository = createPrismaBillingRepository(prisma);

describe("expire rehearsal subscription", () => {
  beforeEach(async () => resetTestDatabase(environment));
  afterAll(async () => {
    await resetTestDatabase(environment);
    await prisma.$disconnect();
  });

  it("expires only the rehearsal organization and is safe to repeat", async () => {
    await prisma.organization.create({
      data: { id: REHEARSAL_ORGANIZATION_ID, name: "Rehearsal shop" },
    });
    const other = await prisma.organization.create({
      data: { name: "Other shop" },
    });
    await prisma.organizationSubscription.create({
      data: {
        organizationId: other.id,
        plan: "GROWTH",
        status: "ACTIVE",
        stripeCheckoutSessionId: "cs_test_other1",
        stripeCustomerId: "cus_other1",
        stripeSubscriptionId: "sub_other1",
      },
    });

    await expect(expireRehearsalSubscription(repository)).resolves.toBe(
      "CREATED",
    );
    await expect(expireRehearsalSubscription(repository)).resolves.toBe(
      "EXPIRED",
    );
    await expect(
      prisma.organizationSubscription.count({
        where: { organizationId: REHEARSAL_ORGANIZATION_ID },
      }),
    ).resolves.toBe(1);
    // Another tenant's paid subscription is untouched.
    await expect(repository.find(other.id)).resolves.toMatchObject({
      status: "ACTIVE",
    });

    // After a paid renewal the next run expires it again, keeping its plan.
    await repository.saveConfirmed({
      customerId: "cus_renew2",
      interval: "YEAR",
      organizationId: REHEARSAL_ORGANIZATION_ID,
      plan: "GROWTH",
      sessionId: "cs_test_renew2",
      subscriptionId: "sub_renew2",
    });
    await expect(expireRehearsalSubscription(repository)).resolves.toBe(
      "ACTIVE",
    );
    await expect(repository.find(REHEARSAL_ORGANIZATION_ID)).resolves.toEqual({
      interval: "YEAR",
      plan: "GROWTH",
      status: "EXPIRED",
    });
  });

  it("refuses when the rehearsal organization does not exist", async () => {
    await expect(
      expireRehearsalSubscription(repository),
    ).rejects.toBeInstanceOf(ExpireRefusal);
    await expect(prisma.organizationSubscription.count()).resolves.toBe(0);
  });
});
