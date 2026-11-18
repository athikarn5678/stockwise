import { randomUUID } from "node:crypto";

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

// Checkout sessions in these tests are started "now", after any expiry.
const sessionCreatedAt = () => new Date(Date.now() + 60_000);

function confirmed(organizationId: string, suffix = "abc123") {
  return repository.saveConfirmed({
    sessionCreatedAt: sessionCreatedAt(),
    customerId: "cus_abc123",
    interval: "MONTH",
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
      subscription: { interval: "MONTH", plan: "STARTER", status: "ACTIVE" },
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
      interval: "MONTH",
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

  it("marks one organization EXPIRED idempotently and renews it in place", async () => {
    const target = await organization();
    const other = await organization("Other tenant");
    await expect(repository.markExpired(target.id)).resolves.toBe("CREATED");
    await expect(repository.markExpired(target.id)).resolves.toBe("EXPIRED");
    await expect(repository.markExpired(randomUUID())).resolves.toBeNull();
    await expect(repository.find(target.id)).resolves.toEqual({
      interval: "MONTH",
      plan: "STARTER",
      status: "EXPIRED",
    });
    await expect(repository.find(other.id)).resolves.toBeNull();

    // Renewal replaces the Stripe-less row in place and is ACTIVE at once.
    const renewed = await repository.saveConfirmed({
      customerId: "cus_renew1",
      interval: "YEAR",
      organizationId: target.id,
      plan: "BUSINESS",
      sessionCreatedAt: sessionCreatedAt(),
      sessionId: sessionId("renew1"),
      subscriptionId: "sub_renew1",
    });
    expect(renewed).toEqual({
      kind: "saved",
      subscription: { interval: "YEAR", plan: "BUSINESS", status: "ACTIVE" },
    });
    expect(
      await prisma.organizationSubscription.count({
        where: { organizationId: target.id },
      }),
    ).toBe(1);
    // Replaying the same session is idempotent; a new one is refused again.
    await expect(
      repository.saveConfirmed({
        customerId: "cus_renew1",
        interval: "YEAR",
        organizationId: target.id,
        plan: "BUSINESS",
        sessionCreatedAt: sessionCreatedAt(),
        sessionId: sessionId("renew1"),
        subscriptionId: "sub_renew1",
      }),
    ).resolves.toEqual(renewed);
    await expect(confirmed(target.id, "later9")).resolves.toEqual({
      kind: "conflict",
    });
    // Re-running the operator command on a paid ACTIVE org expires it again.
    await expect(repository.markExpired(target.id)).resolves.toBe("ACTIVE");
    await expect(repository.find(target.id)).resolves.toMatchObject({
      status: "EXPIRED",
    });
  });

  it("refuses to replay an old paid session for a free renewal after a later expiry", async () => {
    const target = await organization();
    const renew = (suffix: string, createdAt: Date) =>
      repository.saveConfirmed({
        customerId: `cus_${suffix}`,
        interval: "MONTH",
        organizationId: target.id,
        plan: "STARTER",
        sessionCreatedAt: createdAt,
        sessionId: sessionId(suffix),
        subscriptionId: `sub_${suffix}`,
      });
    const started = new Date(Date.now() - 60_000);
    // Rehearsal: expire, pay A (started before ... after the expiry), expire, pay B.
    await repository.markExpired(target.id);
    await expect(renew("sessiona", sessionCreatedAt())).resolves.toMatchObject({
      kind: "saved",
    });
    await repository.markExpired(target.id);
    await expect(renew("sessionb", sessionCreatedAt())).resolves.toMatchObject({
      kind: "saved",
    });
    await repository.markExpired(target.id);
    // Session A is still paid at Stripe, but it was started before this expiry.
    await expect(renew("sessiona", started)).resolves.toEqual({
      kind: "conflict",
    });
    await expect(repository.find(target.id)).resolves.toMatchObject({
      status: "EXPIRED",
    });
  });

  it("exposes access facts only to active members of an active organization", async () => {
    const target = await organization();
    const owner = await user("facts-owner@example.com");
    const stranger = await user("facts-stranger@example.com");
    const inactive = await user("facts-inactive@example.com");
    await membership(target.id, owner.id, "OWNER");
    await membership(target.id, inactive.id, "ADMIN", false);
    await expect(
      repository.accessFactsForMember(owner.id, target.id),
    ).resolves.toEqual({
      organizationCreatedAt: target.createdAt,
      subscription: null,
    });
    await expect(
      repository.accessFactsForMember(stranger.id, target.id),
    ).resolves.toBeNull();
    await expect(
      repository.accessFactsForMember(inactive.id, target.id),
    ).resolves.toBeNull();
    await expect(repository.accessFacts(randomUUID())).resolves.toBeNull();
  });

  it("requires Stripe ids on every non-EXPIRED subscription", async () => {
    const target = await organization();
    await expect(
      prisma.organizationSubscription.create({
        data: { organizationId: target.id, plan: "STARTER", status: "ACTIVE" },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.organizationSubscription.create({
        data: { organizationId: target.id, plan: "STARTER", status: "EXPIRED" },
      }),
    ).resolves.toMatchObject({ stripeCustomerId: null });
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
