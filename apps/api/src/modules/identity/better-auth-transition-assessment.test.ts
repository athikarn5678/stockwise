import { describe, expect, it } from "vitest";

import {
  assessBetterAuthTransition,
  type BetterAuthTransitionIssue,
  type BetterAuthTransitionObservation,
} from "./better-auth-transition-assessment.ts";

const now = new Date("2026-10-24T12:00:00.000Z");
const earlier = new Date("2026-10-23T12:00:00.000Z");
const userId = "ad9c44ec-6341-4e73-8790-5bb05e13c383";
function observation(
  changes: Partial<BetterAuthTransitionObservation> = {},
): BetterAuthTransitionObservation {
  return {
    userId,
    status: "ACTIVE",
    disabledAt: null,
    emailVerifiedAt: earlier,
    emailVerified: true,
    nativeRegistrationCompletedAt: null,
    passwordChangedAt: earlier,
    credentialVersion: 1n,
    legacyPassword: "PRESENT",
    accounts: [],
    ...changes,
  };
}
const credential = {
  userId,
  accountId: userId,
  providerId: "credential",
  passwordPresent: true,
};

describe("existing-user transition assessment, never migration permission", () => {
  it("keeps a verified Legacy user unenrolled", () => {
    expect(assessBetterAuthTransition(observation(), now)).toEqual({
      state: "LEGACY_ONLY",
      destination: "ABSENT",
      issues: [],
    });
  });

  it.each([
    { emailVerifiedAt: null, emailVerified: true },
    { emailVerifiedAt: earlier, emailVerified: false },
  ])("does not choose a verification authority for %j", (changes) => {
    expect(
      assessBetterAuthTransition(observation(changes), now).issues,
    ).toEqual(["UNVERIFIED_USER", "VERIFICATION_MISMATCH"]);
  });

  it("retains an unverified identity without promoting either field", () => {
    const source = observation({ emailVerifiedAt: null, emailVerified: false });
    expect(assessBetterAuthTransition(source, now)).toEqual({
      state: "LEGACY_ONLY",
      destination: "ABSENT",
      issues: ["UNVERIFIED_USER"],
    });
    expect(source.emailVerifiedAt).toBeNull();
    expect(source.emailVerified).toBe(false);
  });

  it.each<Partial<BetterAuthTransitionObservation>>([
    { status: "DISABLED" },
    { disabledAt: earlier },
  ])("preserves disabled account restrictions for %j", (changes) => {
    expect(
      assessBetterAuthTransition(observation(changes), now).issues,
    ).toContain("DISABLED_USER");
  });

  it.each(["DUMMY", "ABSENT"] as const)(
    "does not mistake %s Legacy material for a credential",
    (legacyPassword) => {
      expect(
        assessBetterAuthTransition(observation({ legacyPassword }), now).issues,
      ).toContain("LEGACY_CREDENTIAL_UNAVAILABLE");
    },
  );

  it("preserves an existing Native credential after version advancement", () => {
    const source = observation({
      accounts: [credential],
      nativeRegistrationCompletedAt: earlier,
      credentialVersion: 7n,
      passwordChangedAt: now,
      legacyPassword: "DUMMY",
    });
    expect(assessBetterAuthTransition(source, now)).toEqual({
      state: "NATIVE_PRESENT",
      destination: "PRESERVE",
      issues: ["LEGACY_CREDENTIAL_UNAVAILABLE"],
    });
  });

  const conflicts: {
    name: string;
    changes: Partial<BetterAuthTransitionObservation>;
    issue: BetterAuthTransitionIssue;
  }[] = [
    {
      name: "marker without account",
      changes: { nativeRegistrationCompletedAt: earlier },
      issue: "INCOMPLETE_NATIVE_ENROLLMENT",
    },
    {
      name: "account without marker",
      changes: { accounts: [credential] },
      issue: "INCOMPLETE_NATIVE_ENROLLMENT",
    },
    {
      name: "foreign-owned credential",
      changes: { accounts: [{ ...credential, userId: "another-user" }] },
      issue: "ACCOUNT_OWNERSHIP_CONFLICT",
    },
    {
      name: "noncanonical account selector",
      changes: { accounts: [{ ...credential, accountId: "another-user" }] },
      issue: "NONCANONICAL_CREDENTIAL_ACCOUNT",
    },
    {
      name: "multiple credential rows despite different account selectors",
      changes: {
        accounts: [credential, { ...credential, accountId: "other" }],
      },
      issue: "DUPLICATE_CREDENTIAL_ACCOUNTS",
    },
    {
      name: "missing destination password",
      changes: { accounts: [{ ...credential, passwordPresent: false }] },
      issue: "NATIVE_PASSWORD_MISSING",
    },
    {
      name: "unexpected provider",
      changes: { accounts: [{ ...credential, providerId: "social" }] },
      issue: "UNSUPPORTED_PROVIDER",
    },
  ];
  it.each(conflicts)("refuses to repair $name", ({ changes, issue }) => {
    const result = assessBetterAuthTransition(observation(changes), now);
    expect(result.state).toBe("CONFLICT");
    expect(result.destination).toBe("PRESERVE");
    expect(result.issues).toContain(issue);
  });

  it.each([0n, -1n])(
    "rejects credential generation %s",
    (credentialVersion) => {
      expect(
        assessBetterAuthTransition(observation({ credentialVersion }), now),
      ).toEqual({
        state: "CONFLICT",
        destination: "ABSENT",
        issues: ["INVALID_CREDENTIAL_VERSION"],
      });
    },
  );

  it.each([
    { passwordChangedAt: new Date("invalid") },
    { nativeRegistrationCompletedAt: new Date(now.getTime() + 1) },
    { emailVerifiedAt: new Date(now.getTime() + 1) },
    { disabledAt: new Date("invalid") },
  ])("reports invalid or future snapshot time for %j", (changes) => {
    const result = assessBetterAuthTransition(observation(changes), now);
    expect(result.state).toBe("CONFLICT");
    expect(result.issues).toContain("INVALID_TIME");
  });

  it("cannot classify an observation without a valid snapshot time", () => {
    expect(
      assessBetterAuthTransition(observation(), new Date("invalid")).state,
    ).toBe("CONFLICT");
  });

  it("replays deterministically without mutating supplied account or user state", () => {
    const source = observation({
      accounts: [Object.freeze({ ...credential })],
      nativeRegistrationCompletedAt: earlier,
    });
    Object.freeze(source.accounts);
    Object.freeze(source);
    const before = structuredClone(source);
    const first = assessBetterAuthTransition(source, now);
    const second = assessBetterAuthTransition(source, now);
    expect(second).toEqual(first);
    expect(source).toEqual(before);
    first.issues.push("INVALID_TIME");
    expect(second.issues).toEqual([]);
  });
});
