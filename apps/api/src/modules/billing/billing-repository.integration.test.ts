import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { loadTestDatabaseEnvironment } from "../../test/database-environment.ts";
import {
  createTestPrismaClient,
  resetTestDatabase,
} from "../../test/database-harness.ts";
import { createPrismaBillingRepository } from "./billing-repository.ts";

const environment = loadTestDatabaseEnvironment();
const prisma = createTestPrismaClient(environment);
const repository = createPrismaBillingRepository(prisma);
const now = new Date("2026-11-17T12:00:00.000Z");

function sessionId(suffix = "abc123") {
  return `cs_test_${suffix}`;
}

async function user(email: string, verified = true) {
  return prisma.user.create({
    data: { email, emailVerifiedAt: verified ? now : null },
  });
}

async function organization(name = "Sample shop") {
  return prisma.organization.create({ data: { name } });
}

async function membership(
  organizationId: string,
  userId: string,
  role: "OWNER" | "ADMIN" | "CASHIER",
  active = true,
) {
  return prisma.organizationMembership.create({
    data: {
      organizationId,
      role,
      userId,
      ...(active ? {} : { deactivatedAt: now, status: "INACTIVE" }),
    },
  });
}

function confirmed(organizationId: string, suffix = "abc123") {
  return repository.saveConfirmed({
    customerId: "cus_abc123",
    organizationId,
    plan: "STARTER",
    sessionId: sessionId(suffix),
    subscriptionId: `sub_${suffix}`,
  });
}

describe("billing repository with PostgreSQL", () => {
  beforeEach(async () => resetTestDatabase(environment));
  afterAll(async () => {
    await resetTestDatabase(environment);
    await prisma.$disconnect();
  });

  it("reports the organization role and refuses cross-tenant or inactive access", async () => {
    const target = await organization();
    const other = await organization("Other tenant");
    const owner = await user("billing-owner@example.com");
    const cashier = await user("billing-cashier@example.com");
    const admin = await user("billing-admin@example.com");
    const inactive = await user("billing-inactive@example.com");
    const unverified = await user("billing-unverified@example.com", false);
    const foreignOwner = await user("billing-foreign-owner@example.com");
    await membership(target.id, owner.id, "OWNER");
    await membership(target.id, cashier.id, "CASHIER");
    await membership(target.id, admin.id, "ADMIN");
    await membership(target.id, inactive.id, "OWNER", false);
    await membership(target.id, unverified.id, "ADMIN");
    await membership(other.id, foreignOwner.id, "OWNER");

    await expect(repository.authorize(owner.id, target.id)).resolves.toBe(
      "owner",
    );
    await expect(repository.authorize(cashier.id, target.id)).resolves.toBe(
      "member",
    );
    // Billing is OWNER-only: an ADMIN is only a read-only member.
    await expect(repository.authorize(admin.id, target.id)).resolves.toBe(
      "member",
    );
    await expect(
      repository.authorize(inactive.id, target.id),
    ).resolves.toBeNull();
    await expect(
      repository.authorize(unverified.id, target.id),
    ).resolves.toBeNull();
    await expect(
      repository.authorize(foreignOwner.id, target.id),
    ).resolves.toBeNull();
  });

  it("creates one subscription and re-confirms the same session idempotently", async () => {
    const target = await organization();
    const first = await confirmed(target.id);
    expect(first).toEqual({
      kind: "saved",
      subscription: { plan: "STARTER", status: "ACTIVE" },
    });
    const stored = await prisma.organizationSubscription.findUniqueOrThrow({
      where: { organizationId: target.id },
    });
    expect(stored).toMatchObject({
      organizationId: target.id,
      plan: "STARTER",
      status: "ACTIVE",
      stripeCheckoutSessionId: sessionId(),
      stripeCustomerId: "cus_abc123",
      stripeSubscriptionId: "sub_abc123",
    });

    const again = await confirmed(target.id);
    expect(again).toEqual(first);
    expect(
      await prisma.organizationSubscription.count({
        where: { organizationId: target.id },
      }),
    ).toBe(1);
    const unchanged = await prisma.organizationSubscription.findUniqueOrThrow({
      where: { organizationId: target.id },
    });
    expect(unchanged.id).toBe(stored.id);
    expect(unchanged.updatedAt).toEqual(stored.updatedAt);
    await expect(repository.find(target.id)).resolves.toEqual({
      plan: "STARTER",
      status: "ACTIVE",
    });
  });

  it("refuses a different checkout session for an organization that is already subscribed", async () => {
    const target = await organization();
    await confirmed(target.id, "first1");
    const conflicted = await confirmed(target.id, "second2");
    expect(conflicted).toEqual({ kind: "conflict" });
    const stored = await prisma.organizationSubscription.findUniqueOrThrow({
      where: { organizationId: target.id },
    });
    expect(stored.stripeCheckoutSessionId).toBe(sessionId("first1"));
    expect(stored.stripeSubscriptionId).toBe("sub_first1");
    expect(
      await prisma.organizationSubscription.count({
        where: { organizationId: target.id },
      }),
    ).toBe(1);
  });

  it("rejects Stripe ids that do not carry the expected test-mode prefix", async () => {
    const target = await organization();
    const base = {
      organizationId: target.id,
      plan: "STARTER" as const,
      status: "ACTIVE" as const,
      stripeCheckoutSessionId: sessionId(),
      stripeCustomerId: "cus_abc123",
      stripeSubscriptionId: "sub_abc123",
    };
    for (const overrides of [
      { stripeCustomerId: "not-a-customer" },
      { stripeSubscriptionId: "cs_test_abc123" },
      { stripeCheckoutSessionId: "cs_live_abc123" },
    ]) {
      await expect(
        prisma.organizationSubscription.create({
          data: { ...base, ...overrides },
        }),
      ).rejects.toThrow();
      expect(
        await prisma.organizationSubscription.count({
          where: { organizationId: target.id },
        }),
      ).toBe(0);
    }
  });
});
