import { describe, expect, it } from "vitest";

import {
  resolveSubscriptionAccess,
  subscriptionKeepsAccess,
  TRIAL_DAYS,
  type StoredSubscription,
} from "./subscription-access.ts";

const DAY = 86_400_000;
const CREATED = new Date("2026-11-01T00:00:00.000Z");
const stored = (status: StoredSubscription["status"]): StoredSubscription => ({
  interval: "MONTH",
  plan: "STARTER",
  status,
});
const resolve = (
  elapsedMilliseconds: number,
  subscription: StoredSubscription | null,
) =>
  resolveSubscriptionAccess({
    now: new Date(CREATED.getTime() + elapsedMilliseconds),
    organizationCreatedAt: CREATED,
    subscription,
  });

describe("subscription access", () => {
  it("is TRIAL for the first 14 days and reports whole days left", () => {
    expect(resolve(0, null)).toEqual({
      state: "TRIAL",
      trialDaysLeft: 14,
      trialEndsAt: "2026-11-15T00:00:00.000Z",
    });
    expect(resolve(DAY / 2, null)).toMatchObject({ trialDaysLeft: 14 });
    expect(resolve(13 * DAY + 1, null)).toMatchObject({
      state: "TRIAL",
      trialDaysLeft: 1,
    });
  });

  it("is EXPIRED from the trial end onwards when no subscription row exists", () => {
    expect(TRIAL_DAYS).toBe(14);
    expect(resolve(14 * DAY, null)).toEqual({
      state: "EXPIRED",
      trialDaysLeft: null,
      trialEndsAt: "2026-11-15T00:00:00.000Z",
    });
    expect(resolve(90 * DAY, null).state).toBe("EXPIRED");
  });

  it("lets a stored row win over the trial clock", () => {
    // ACTIVE long after the trial; EXPIRED during it (operator rehearsal).
    expect(resolve(90 * DAY, stored("ACTIVE")).state).toBe("ACTIVE");
    expect(resolve(DAY, stored("EXPIRED"))).toEqual({
      state: "EXPIRED",
      trialDaysLeft: null,
      trialEndsAt: null,
    });
  });

  it("maps every stored status to access", () => {
    expect(subscriptionKeepsAccess("ACTIVE")).toBe(true);
    expect(subscriptionKeepsAccess("PAST_DUE")).toBe(true);
    expect(subscriptionKeepsAccess("CANCELED")).toBe(false);
    expect(subscriptionKeepsAccess("EXPIRED")).toBe(false);
    expect(resolve(DAY, stored("CANCELED")).state).toBe("EXPIRED");
  });
});
