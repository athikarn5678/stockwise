import { describe, expect, it, vi } from "vitest";

import type {
  BillingAccess,
  BillingRepository,
  PublicSubscription,
  SaveConfirmedInput,
  SaveConfirmedResult,
} from "./billing-repository.ts";
import { createBillingService } from "./billing-service.ts";
import type { StripeCheckoutSession, StripeClient } from "./stripe-client.ts";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_ORGANIZATION_ID = "10000000-0000-4000-8000-000000000002";
const ACTOR_ID = "20000000-0000-4000-8000-000000000001";
const SESSION_ID = "cs_test_session123";
const PUBLIC_WEB_ORIGIN = "https://app.example.com";
const SUBSCRIPTION: PublicSubscription = { plan: "STARTER", status: "ACTIVE" };

function session(
  overrides: Partial<StripeCheckoutSession> = {},
): StripeCheckoutSession {
  return {
    amount_total: 19_900,
    client_reference_id: ORGANIZATION_ID,
    currency: "thb",
    customer: "cus_abc123",
    id: SESSION_ID,
    livemode: false,
    metadata: { organization_id: ORGANIZATION_ID, plan: "STARTER" },
    mode: "subscription",
    object: "checkout.session",
    payment_status: "paid",
    status: "complete",
    subscription: "sub_abc123",
    url: `https://checkout.stripe.com/c/pay/${SESSION_ID}`,
    ...overrides,
  };
}

function repository({
  access = "owner",
  existing = null,
  saved = { kind: "saved", subscription: SUBSCRIPTION },
}: {
  access?: BillingAccess;
  existing?: PublicSubscription | null;
  saved?: SaveConfirmedResult;
} = {}) {
  return {
    // Parameter names match the repository seam; the fakes ignore them.
    authorize: vi.fn(async () => access),
    find: vi.fn(async () => existing),
    saveConfirmed: vi.fn(
      async (input: SaveConfirmedInput): Promise<SaveConfirmedResult> =>
        saved.kind === "saved"
          ? {
              kind: "saved",
              subscription: { plan: input.plan, status: "ACTIVE" },
            }
          : saved,
    ),
  };
}

function stripe({
  created = { ok: true as const, value: session() },
  retrieved = { ok: true as const, value: session() },
}: {
  created?: { ok: true; value: StripeCheckoutSession } | { ok: false };
  retrieved?: { ok: true; value: StripeCheckoutSession } | { ok: false };
} = {}) {
  return {
    createCheckoutSession: vi.fn(async () => created),
    retrieveCheckoutSession: vi.fn(async () => retrieved),
  };
}

// Narrow cast: the service consumes exactly these three repository seams.
function service(input: {
  access?: BillingAccess;
  existing?: PublicSubscription | null;
  saved?: SaveConfirmedResult;
  stripe?: ReturnType<typeof stripe>;
}) {
  const repo = repository(input);
  const stripeClient = input.stripe;
  return {
    billing: createBillingService({
      publicWebOrigin: PUBLIC_WEB_ORIGIN,
      repository: repo as unknown as BillingRepository,
      ...(stripeClient === undefined
        ? {}
        : { stripe: stripeClient as unknown as StripeClient }),
    }),
    repo,
    stripeClient,
  };
}

describe("billing service", () => {
  it("hides billing when no Stripe client is configured", async () => {
    const { billing, repo } = service({});
    await expect(
      billing.checkout({
        actorUserId: ACTOR_ID,
        organizationId: ORGANIZATION_ID,
        plan: "GROWTH",
      }),
    ).resolves.toEqual({ kind: "disabled" });
    await expect(
      billing.confirm({
        actorUserId: ACTOR_ID,
        organizationId: ORGANIZATION_ID,
        sessionId: SESSION_ID,
      }),
    ).resolves.toEqual({ kind: "disabled" });
    // Disabled commands never resolve membership or touch persistence.
    expect(repo.authorize).not.toHaveBeenCalled();
    expect(repo.find).not.toHaveBeenCalled();
    expect(repo.saveConfirmed).not.toHaveBeenCalled();

    await expect(billing.read(ACTOR_ID, ORGANIZATION_ID)).resolves.toEqual({
      canManage: false,
      enabled: false,
      kind: "ok",
      subscription: null,
    });
  });

  it("lets an owner read the current subscription and hides management from members", async () => {
    const owner = service({ existing: SUBSCRIPTION, stripe: stripe() });
    await expect(
      owner.billing.read(ACTOR_ID, ORGANIZATION_ID),
    ).resolves.toEqual({
      canManage: true,
      enabled: true,
      kind: "ok",
      subscription: SUBSCRIPTION,
    });

    const member = service({
      access: "member",
      existing: SUBSCRIPTION,
      stripe: stripe(),
    });
    await expect(
      member.billing.read(ACTOR_ID, ORGANIZATION_ID),
    ).resolves.toEqual({
      canManage: false,
      enabled: true,
      kind: "ok",
      subscription: SUBSCRIPTION,
    });
  });

  it("refuses checkout and confirmation for non-owners without calling Stripe", async () => {
    for (const access of ["member", null] as const) {
      const nonOwner = service({ access, stripe: stripe() });
      await expect(
        nonOwner.billing.checkout({
          actorUserId: ACTOR_ID,
          organizationId: ORGANIZATION_ID,
          plan: "STARTER",
        }),
      ).resolves.toEqual({ kind: "forbidden" });
      await expect(
        nonOwner.billing.confirm({
          actorUserId: ACTOR_ID,
          organizationId: ORGANIZATION_ID,
          sessionId: SESSION_ID,
        }),
      ).resolves.toEqual({ kind: "forbidden" });
      expect(
        nonOwner.stripeClient?.createCheckoutSession,
      ).not.toHaveBeenCalled();
      expect(
        nonOwner.stripeClient?.retrieveCheckoutSession,
      ).not.toHaveBeenCalled();
      expect(nonOwner.repo.saveConfirmed).not.toHaveBeenCalled();
    }
  });

  it("builds the success and cancel URLs from the injected public origin", async () => {
    const { billing, stripeClient } = service({ stripe: stripe() });
    await expect(
      billing.checkout({
        actorUserId: ACTOR_ID,
        organizationId: ORGANIZATION_ID,
        plan: "GROWTH",
      }),
    ).resolves.toEqual({
      kind: "ok",
      url: `https://checkout.stripe.com/c/pay/${SESSION_ID}`,
    });
    expect(stripeClient?.createCheckoutSession).toHaveBeenCalledWith({
      cancelUrl: `${PUBLIC_WEB_ORIGIN}/app/billing?organizationId=${ORGANIZATION_ID}&canceled=1`,
      organizationId: ORGANIZATION_ID,
      plan: "GROWTH",
      successUrl: `${PUBLIC_WEB_ORIGIN}/app/billing?organizationId=${ORGANIZATION_ID}&session_id={CHECKOUT_SESSION_ID}`,
    });
  });

  it("refuses a second checkout when a subscription exists", async () => {
    const { billing, stripeClient } = service({
      existing: SUBSCRIPTION,
      stripe: stripe(),
    });
    await expect(
      billing.checkout({
        actorUserId: ACTOR_ID,
        organizationId: ORGANIZATION_ID,
        plan: "STARTER",
      }),
    ).resolves.toEqual({ kind: "conflict" });
    expect(stripeClient?.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("reports a provider failure when Stripe yields no session or no URL", async () => {
    const failed = service({ stripe: stripe({ created: { ok: false } }) });
    await expect(
      failed.billing.checkout({
        actorUserId: ACTOR_ID,
        organizationId: ORGANIZATION_ID,
        plan: "STARTER",
      }),
    ).resolves.toEqual({ kind: "provider_failed" });

    const withoutUrl = service({
      stripe: stripe({ created: { ok: true, value: session({ url: null }) } }),
    });
    await expect(
      withoutUrl.billing.checkout({
        actorUserId: ACTOR_ID,
        organizationId: ORGANIZATION_ID,
        plan: "STARTER",
      }),
    ).resolves.toEqual({ kind: "provider_failed" });

    const retrieveFailed = service({
      stripe: stripe({ retrieved: { ok: false } }),
    });
    await expect(
      retrieveFailed.billing.confirm({
        actorUserId: ACTOR_ID,
        organizationId: ORGANIZATION_ID,
        sessionId: SESSION_ID,
      }),
    ).resolves.toEqual({ kind: "provider_failed" });
  });

  it("refuses a session bound to another organization", async () => {
    const overridesList: Partial<StripeCheckoutSession>[] = [
      { client_reference_id: OTHER_ORGANIZATION_ID },
      { metadata: { organization_id: OTHER_ORGANIZATION_ID, plan: "STARTER" } },
      { metadata: null },
      { id: "cs_test_other123" },
    ];
    for (const overrides of overridesList) {
      const foreign = service({
        stripe: stripe({ retrieved: { ok: true, value: session(overrides) } }),
      });
      await expect(
        foreign.billing.confirm({
          actorUserId: ACTOR_ID,
          organizationId: ORGANIZATION_ID,
          sessionId: SESSION_ID,
        }),
      ).resolves.toEqual({ kind: "forbidden" });
      expect(foreign.repo.saveConfirmed).not.toHaveBeenCalled();
    }
  });

  it("refuses a session whose plan, amount, currency or mode was not issued by us", async () => {
    const overridesList: Partial<StripeCheckoutSession>[] = [
      { amount_total: 19_800 },
      { amount_total: 49_900 },
      { amount_total: null },
      { currency: "usd" },
      { currency: null },
      { mode: "payment" },
      { metadata: { organization_id: ORGANIZATION_ID, plan: "ENTERPRISE" } },
      { metadata: { organization_id: ORGANIZATION_ID } },
    ];
    for (const overrides of overridesList) {
      const tampered = service({
        stripe: stripe({ retrieved: { ok: true, value: session(overrides) } }),
      });
      await expect(
        tampered.billing.confirm({
          actorUserId: ACTOR_ID,
          organizationId: ORGANIZATION_ID,
          sessionId: SESSION_ID,
        }),
      ).resolves.toEqual({ kind: "forbidden" });
      expect(tampered.repo.saveConfirmed).not.toHaveBeenCalled();
    }
  });

  it("refuses to save an incomplete or unpaid checkout", async () => {
    const overridesList: Partial<StripeCheckoutSession>[] = [
      { status: "open" },
      { status: null },
      { payment_status: "unpaid" },
      { customer: null },
      { subscription: null },
      { customer: "not-a-customer" },
      { subscription: "not-a-subscription" },
    ];
    for (const overrides of overridesList) {
      const incomplete = service({
        stripe: stripe({ retrieved: { ok: true, value: session(overrides) } }),
      });
      await expect(
        incomplete.billing.confirm({
          actorUserId: ACTOR_ID,
          organizationId: ORGANIZATION_ID,
          sessionId: SESSION_ID,
        }),
      ).resolves.toEqual({ kind: "not_complete" });
      expect(incomplete.repo.saveConfirmed).not.toHaveBeenCalled();
    }
  });

  it("saves exactly the server-owned fields of a paid session", async () => {
    const { billing, repo } = service({
      stripe: stripe({
        retrieved: {
          ok: true,
          value: session({
            amount_total: 49_900,
            client_reference_id: ORGANIZATION_ID,
            metadata: { organization_id: ORGANIZATION_ID, plan: "GROWTH" },
          }),
        },
      }),
    });
    await expect(
      billing.confirm({
        actorUserId: ACTOR_ID,
        organizationId: ORGANIZATION_ID,
        sessionId: SESSION_ID,
      }),
    ).resolves.toEqual({
      kind: "ok",
      subscription: { plan: "GROWTH", status: "ACTIVE" },
    });
    expect(repo.saveConfirmed).toHaveBeenCalledWith({
      customerId: "cus_abc123",
      organizationId: ORGANIZATION_ID,
      plan: "GROWTH",
      sessionId: SESSION_ID,
      subscriptionId: "sub_abc123",
    });
  });

  it("maps a repository race to a conflict", async () => {
    const { billing } = service({
      saved: { kind: "conflict" },
      stripe: stripe(),
    });
    await expect(
      billing.confirm({
        actorUserId: ACTOR_ID,
        organizationId: ORGANIZATION_ID,
        sessionId: SESSION_ID,
      }),
    ).resolves.toEqual({ kind: "conflict" });
  });
});
