import { describe, expect, it } from "vitest";
import { createLoginLimiter, type LoginLimiter } from "./login-limiter.ts";

describe("login limiter", () => {
  it("processes five failures and limits the next attempt for the fixed window", () => {
    let currentTime = 0;
    const limiter = createLoginLimiter(() => currentTime);

    for (let failure = 0; failure < 5; failure += 1) {
      expect(limiter.check("user@example.com")).toEqual({ allowed: true });
      limiter.recordCredentialFailure("user@example.com");
    }

    expect(limiter.check("user@example.com")).toEqual({
      allowed: false,
      retryAfterSeconds: 900,
    });

    currentTime = 60_001;
    expect(limiter.check("user@example.com")).toEqual({
      allowed: false,
      retryAfterSeconds: 840,
    });
  });

  it("restores attempts only after the fixed window expires", () => {
    let currentTime = 1_000;
    const limiter = createLoginLimiter(() => currentTime);

    for (let failure = 0; failure < 5; failure += 1) {
      limiter.recordCredentialFailure("user@example.com");
    }

    currentTime += 15 * 60 * 1000;

    expect(limiter.check("user@example.com")).toEqual({ allowed: true });
    limiter.recordCredentialFailure("user@example.com");
    expect(limiter.check("user@example.com")).toEqual({ allowed: true });
  });

  it("keeps independent canonical-email entries without storing caller-visible keys", () => {
    const limiter = createLoginLimiter(() => 0);

    for (let failure = 0; failure < 5; failure += 1) {
      limiter.recordCredentialFailure("first@example.com");
    }

    expect(limiter.check("first@example.com").allowed).toBe(false);
    expect(limiter.check("second@example.com")).toEqual({ allowed: true });
  });
});
describe("serialized Native credential admission", () => {
  async function credentialAttempt(
    limiter: LoginLimiter,
    email: string,
    hold?: Promise<void>,
    onEnter?: () => void,
  ): Promise<"invalid" | "limited"> {
    return limiter.serializeByEmail(email, async () => {
      const admission = limiter.check(email);
      if (!admission.allowed) return "limited";
      onEnter?.();
      if (hold !== undefined) await hold;
      limiter.recordCredentialFailure(email);
      return "invalid";
    });
  }

  it("serializes failures against the last available slot", async () => {
    const limiter = createLoginLimiter(() => 0);
    const email = "concurrent@example.com";
    for (let failure = 0; failure < 4; failure += 1)
      limiter.recordCredentialFailure(email);

    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const first = credentialAttempt(limiter, email, release.promise, () =>
      entered.resolve(),
    );
    await entered.promise;
    const second = credentialAttempt(limiter, email);
    release.resolve();

    expect(await first).toBe("invalid");
    expect(await second).toBe("limited");
    expect(limiter.check(email)).toEqual({
      allowed: false,
      retryAfterSeconds: 900,
    });
  });

  it("releases serialization after an error and keeps other emails independent", async () => {
    const limiter = createLoginLimiter(() => 0);
    const failed = Promise.withResolvers<void>();
    const firstEmailEntered = Promise.withResolvers<void>();
    const secondEmailEntered = Promise.withResolvers<void>();
    const first = limiter.serializeByEmail("first@example.com", async () => {
      firstEmailEntered.resolve();
      await failed.promise;
      throw new Error("verification failed");
    });
    const second = limiter.serializeByEmail("second@example.com", async () => {
      secondEmailEntered.resolve();
      return "second";
    });

    await Promise.all([firstEmailEntered.promise, secondEmailEntered.promise]);
    await expect(second).resolves.toBe("second");
    failed.resolve();
    await expect(first).rejects.toThrow("verification failed");

    await expect(
      limiter.serializeByEmail("first@example.com", async () => "released"),
    ).resolves.toBe("released");
  });
});
