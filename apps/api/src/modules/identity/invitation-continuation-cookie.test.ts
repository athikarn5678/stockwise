import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  clearPresentedInvitationContinuationCookies,
  clearSelectedInvitationContinuationCookie,
  continuationCookieHint,
  decryptInvitationContinuation,
  encryptInvitationContinuation,
  loginContinuationCookies,
  parseInvitationContinuationKey,
  readInvitationContinuationCookies,
  serializeInvitationContinuationCookie,
} from "./invitation-continuation-cookie.ts";

describe("fixed-slot invitation continuation cookie envelope", () => {
  const key = randomBytes(32);
  const flowId = randomBytes(32).toString("base64url");
  const continuation = {
    expiresAt: 1_800_000_000_000,
    flowId,
    issuedAt: 1_799_998_200_000,
    sessionDigest: null,
    token: randomBytes(32).toString("base64url"),
  };
  const origin = "https://stockwise.example";
  const encrypt = (slot = 1) =>
    encryptInvitationContinuation({ continuation, flowId, slot, key, origin });
  const decrypt = (value: string, slot = 1, overrides = {}) =>
    decryptInvitationContinuation({
      value,
      flowId,
      slot,
      key,
      origin,
      now: continuation.issuedAt,
      ...overrides,
    });

  it("round-trips with the exact origin, selector, and fixed slot binding", () => {
    const value = encrypt();
    expect(decrypt(value)).toEqual(continuation);
    expect(continuationCookieHint(value)).toEqual({ slot: 1, flowId });
    expect(decrypt(value, 1, { origin: "https://other.example" })).toBeNull();
    expect(decrypt(value, 2)).toBeNull();
    const rewrittenSlot = value.replace(/^2\.1\./, "2.2.");
    expect(continuationCookieHint(rewrittenSlot)).toEqual({ slot: 2, flowId });
    expect(decrypt(rewrittenSlot, 2)).toBeNull();
    expect(
      decrypt(value, 1, { flowId: randomBytes(32).toString("base64url") }),
    ).toBeNull();
    expect(Buffer.byteLength(value, "ascii")).toBeLessThanOrEqual(512);
    expect(
      Buffer.byteLength(
        serializeInvitationContinuationCookie(
          1,
          value,
          continuation.expiresAt,
        ).split(";", 1)[0]!,
        "ascii",
      ),
    ).toBeLessThanOrEqual(512 + 35);
    expect(() =>
      serializeInvitationContinuationCookie(2, value, continuation.expiresAt),
    ).toThrow();
    expect(() =>
      serializeInvitationContinuationCookie(
        1,
        "x".repeat(513),
        continuation.expiresAt,
      ),
    ).toThrow();
  });

  it("rejects ciphertext tampering, malformed values, future and expired records", () => {
    const value = encrypt();
    const altered = `${value.slice(0, -1)}${value.endsWith("A") ? "B" : "A"}`;
    expect(decrypt(altered)).toBeNull();
    expect(decrypt("not-a-v2-cookie")).toBeNull();
    expect(decrypt(value, 1, { now: continuation.expiresAt })).toBeNull();
    const futureIssuedAt = continuation.issuedAt + 1;
    const future = encryptInvitationContinuation({
      continuation: {
        ...continuation,
        issuedAt: futureIssuedAt,
        expiresAt: futureIssuedAt + 30 * 60_000,
      },
      flowId,
      slot: 1,
      key,
      origin,
    });
    expect(decrypt(future, 1, { now: continuation.issuedAt })).toBeNull();
  });

  it("parses only four fixed selectors and rejects duplicate fixed slots", () => {
    expect(
      readInvitationContinuationCookies(
        "__Host-stockwise_invitation_slot_2=value",
      ),
    ).toEqual(new Map([[2, "value"]]));
    expect(
      readInvitationContinuationCookies(
        "__Host-stockwise_invitation_slot_0=a; __Host-stockwise_invitation_slot_0=b",
      ),
    ).toBeNull();
    expect(
      readInvitationContinuationCookies(
        "__Host-stockwise_invitation_slot_4=ignored",
      ),
    ).toEqual(new Map());
  });

  it("cleans no more than sixteen legacy cookies while clearing the fixed namespace", () => {
    const flows = Array.from({ length: 20 }, () =>
      randomBytes(32).toString("base64url"),
    );
    const header = [
      "__Host-stockwise_invitation_slot_3=v",
      ...flows.map((flow) => `__Host-stockwise_invitation_${flow}=legacy`),
    ].join("; ");
    const cleared = clearPresentedInvitationContinuationCookies(header);
    expect(cleared).toHaveLength(17);
    expect(cleared[0]).toContain("__Host-stockwise_invitation_slot_3=");
    expect(cleared.filter((value) => !value.includes("slot_")).length).toBe(16);
    expect(
      cleared.some((value) =>
        value.includes("__Host-stockwise_invitation_slot_3=legacy"),
      ),
    ).toBe(false);
    const captureCleanup = clearPresentedInvitationContinuationCookies(
      header,
      true,
    );
    expect(captureCleanup).toHaveLength(16);
    expect(
      captureCleanup.every(
        (value) =>
          /^__Host-stockwise_invitation_[A-Za-z0-9_-]{43}=;/.test(value) &&
          value.includes("Max-Age=0"),
      ),
    ).toBe(true);
  });
  it("drains a canonical legacy selector starting with the fixed-slot marker without clearing a fixed occupant", () => {
    const legacyFlow = `slot_${"A".repeat(38)}`;
    expect(Buffer.from(legacyFlow, "base64url").toString("base64url")).toBe(
      legacyFlow,
    );
    const legacyName = `__Host-stockwise_invitation_${legacyFlow}`;
    const fixedName = "__Host-stockwise_invitation_slot_0";
    const cleared = clearPresentedInvitationContinuationCookies(
      `${fixedName}=opaque; ${legacyName}=legacy`,
      true,
    );
    expect(cleared).toHaveLength(1);
    expect(cleared[0]).toContain(`${legacyName}=;`);
    expect(cleared[0]).toContain("Max-Age=0");
    expect(cleared.some((cookie) => cookie.startsWith(`${fixedName}=`))).toBe(
      false,
    );
  });
  it("rebinds one authenticated selected slot and fails closed on duplicate selectors", () => {
    const currentContinuation = {
      ...continuation,
      issuedAt: Date.now() - 1_000,
      expiresAt: Date.now() + 100_000,
    };
    const first = encryptInvitationContinuation({
      continuation: currentContinuation,
      flowId,
      slot: 0,
      key,
      origin,
    });
    const rebound = loginContinuationCookies({
      cookieHeader: `__Host-stockwise_invitation_slot_0=${first}`,
      flowHeader: flowId,
      key,
      newSessionCredential: "new-session",
      origin,
    });
    const positive = rebound.find((cookie) =>
      cookie.startsWith("__Host-stockwise_invitation_slot_0="),
    );
    expect(positive).toBeDefined();
    const reboundValue = positive!.split(";", 1)[0]!.split("=", 2)[1]!;
    expect(
      decryptInvitationContinuation({
        value: reboundValue,
        flowId,
        slot: 0,
        key,
        origin,
        now: currentContinuation.issuedAt,
      }),
    ).toMatchObject({
      ...currentContinuation,
      sessionDigest: expect.any(String),
    });

    const second = encryptInvitationContinuation({
      continuation: currentContinuation,
      flowId,
      slot: 1,
      key,
      origin,
    });
    const ambiguous = loginContinuationCookies({
      cookieHeader: `__Host-stockwise_invitation_slot_0=${first}; __Host-stockwise_invitation_slot_1=${second}`,
      flowHeader: flowId,
      key,
      newSessionCredential: "new-session",
      origin,
    });
    expect(
      ambiguous.some(
        (cookie) =>
          cookie.startsWith("__Host-stockwise_invitation_slot_0=") &&
          !cookie.includes("Max-Age=0"),
      ),
    ).toBe(false);
    expect(
      ambiguous.some(
        (cookie) =>
          cookie.startsWith("__Host-stockwise_invitation_slot_1=") &&
          !cookie.includes("Max-Age=0"),
      ),
    ).toBe(false);
  });

  it("does not clear a different occupant based on rewritten unauthenticated flow metadata", () => {
    const currentContinuation = {
      ...continuation,
      issuedAt: Date.now() - 1_000,
      expiresAt: Date.now() + 100_000,
    };
    const value = encryptInvitationContinuation({
      continuation: currentContinuation,
      flowId,
      slot: 1,
      key,
      origin,
    });
    const otherFlow = randomBytes(32).toString("base64url");
    const rewritten = value.replace(flowId, otherFlow);
    expect(
      clearSelectedInvitationContinuationCookie(
        `__Host-stockwise_invitation_slot_1=${rewritten}`,
        otherFlow,
        key,
        origin,
      ),
    ).toBeNull();
    expect(
      clearSelectedInvitationContinuationCookie(
        `__Host-stockwise_invitation_slot_1=${value}`,
        flowId,
        key,
        origin,
      ),
    ).toContain("__Host-stockwise_invitation_slot_1=");
  });

  it("requires a dedicated canonical 32-byte key", () => {
    expect(parseInvitationContinuationKey(key.toString("base64url"))).toEqual(
      key,
    );
    expect(() => parseInvitationContinuationKey(undefined)).toThrow();
    expect(() =>
      parseInvitationContinuationKey(randomBytes(31).toString("base64url")),
    ).toThrow();
  });
});
