import { afterEach, describe, expect, it, vi } from "vitest";

import { EmailDeliveryError } from "./email-provider.ts";
import { createVerificationDelivery } from "./verification-delivery.ts";
import { createVerificationSecurity } from "./verification-security.ts";

const publicWebOrigin = "http://localhost:3000";
const prepared = createVerificationSecurity({
  publicWebOrigin,
  otpKey: Buffer.alloc(32, 11),
  otpKeyId: 1,
  proofKey: Buffer.alloc(32, 22),
  proofKeyId: 2,
}).prepare("00000000-0000-4000-8000-000000000001", 1n, new Date());

afterEach(() => vi.useRealTimers());

describe("verification dispatch admission and response lifecycle", () => {
  it("bounds outstanding reservations to 32 and releases exactly once", () => {
    const delivery = createVerificationDelivery({
      publicWebOrigin,
      emailProvider: { async send() {} },
      repository: { canDeliver: async () => true, async revokeDelivery() {} },
    });
    const reservations = Array.from({ length: 32 }, () => delivery.reserve());
    expect(reservations.every((item) => item !== null)).toBe(true);
    expect(delivery.reserve()).toBeNull();
    reservations[0]!.release();
    reservations[0]!.release();
    const replacement = delivery.reserve();
    expect(replacement).not.toBeNull();
    expect(delivery.reserve()).toBeNull();
    for (const reservation of reservations) reservation?.release();
    replacement?.release();
  });

  it("does not send before response completion and skips known stale jobs", async () => {
    let sent = 0;
    const delivery = createVerificationDelivery({
      publicWebOrigin,
      emailProvider: {
        async send() {
          sent += 1;
        },
      },
      repository: {
        canDeliver: async () => false,
        async revokeDelivery() {
          throw new Error("Stale dispatch does not compensate a successor");
        },
      },
    });
    const response = delivery
      .reserve()!
      .prepare({ prepared, recipient: "user@example.com" });
    expect(sent).toBe(0);
    response.finish();
    response.finish();
    await delivery.drain();
    expect(sent).toBe(0);
  });

  it("aborts unsent response-bound delivery and revokes only the exact challenge", async () => {
    let sent = 0;
    const revocations: { challengeId: string; reason: string }[] = [];
    const delivery = createVerificationDelivery({
      publicWebOrigin,
      emailProvider: {
        async send() {
          sent += 1;
        },
      },
      repository: {
        canDeliver: async () => true,
        async revokeDelivery(input) {
          revocations.push(input);
        },
      },
    });
    const response = delivery
      .reserve()!
      .prepare({ prepared, recipient: "user@example.com" });
    response.abort();
    response.abort();
    response.finish();
    await delivery.drain();
    expect(sent).toBe(0);
    expect(revocations).toEqual([
      { challengeId: prepared.challenge.id, reason: "RESPONSE_ABORTED" },
    ]);
  });

  it("times out after ten seconds without retry and releases capacity after exact compensation", async () => {
    vi.useFakeTimers();
    const onFailure = vi.fn();
    let sent = 0;
    let aborted = false;
    const revocations: { challengeId: string; reason: string }[] = [];
    const delivery = createVerificationDelivery({
      publicWebOrigin,
      onFailure,
      emailProvider: {
        send(_message, signal) {
          sent += 1;
          return new Promise<void>((_resolve, reject) => {
            signal?.addEventListener(
              "abort",
              () => {
                aborted = true;
                reject(new Error("Synthetic aborted provider"));
              },
              { once: true },
            );
          });
        },
      },
      repository: {
        canDeliver: async () => true,
        async revokeDelivery(input) {
          revocations.push(input);
        },
      },
    });
    const response = delivery
      .reserve()!
      .prepare({ prepared, recipient: "user@example.com" });
    response.finish();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(sent).toBe(1);
    expect(aborted).toBe(false);
    expect(revocations).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(aborted).toBe(true);
    expect(sent).toBe(1);
    expect(revocations).toEqual([
      { challengeId: prepared.challenge.id, reason: "DELIVERY_FAILED" },
    ]);
    expect(onFailure).toHaveBeenCalledWith("verification", {
      stage: "timeout",
    });
    const reservations = Array.from({ length: 32 }, () => delivery.reserve());
    expect(reservations.every((item) => item !== null)).toBe(true);
    for (const reservation of reservations) reservation?.release();
    await delivery.drain();
    expect(delivery.reserve()).toBeNull();
  });

  it("bounds shutdown drain and never starts provider I/O after its deadline", async () => {
    vi.useFakeTimers();
    let resolveEligibility!: (value: boolean) => void;
    const eligibility = new Promise<boolean>((resolve) => {
      resolveEligibility = resolve;
    });
    let sent = 0;
    const revocations: { challengeId: string; reason: string }[] = [];
    const delivery = createVerificationDelivery({
      publicWebOrigin,
      emailProvider: {
        async send() {
          sent += 1;
        },
      },
      repository: {
        canDeliver: () => eligibility,
        async revokeDelivery(input) {
          revocations.push(input);
        },
      },
    });
    delivery
      .reserve()!
      .prepare({ prepared, recipient: "user@example.com" })
      .finish();
    const drained = delivery.drain();
    await vi.advanceTimersByTimeAsync(10_000);
    await drained;
    resolveEligibility(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toBe(0);
    expect(revocations).toEqual([
      { challengeId: prepared.challenge.id, reason: "DELIVERY_FAILED" },
    ]);
    expect(delivery.reserve()).toBeNull();
  });

  it("drains reservations awaiting response completion and refuses late provider starts", async () => {
    vi.useFakeTimers();
    let sent = 0;
    const revocations: { challengeId: string; reason: string }[] = [];
    const delivery = createVerificationDelivery({
      publicWebOrigin,
      emailProvider: {
        async send() {
          sent += 1;
        },
      },
      repository: {
        canDeliver: async () => true,
        async revokeDelivery(input) {
          revocations.push(input);
        },
      },
    });
    const response = delivery
      .reserve()!
      .prepare({ prepared, recipient: "user@example.com" });
    let completed = false;
    const drained = delivery.drain().then(() => {
      completed = true;
    });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await drained;
    response.finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toBe(0);
    expect(revocations).toEqual([
      { challengeId: prepared.challenge.id, reason: "DELIVERY_FAILED" },
    ]);
  });

  it.each([
    [
      "provider_http",
      new EmailDeliveryError("provider_http", 403),
      { stage: "provider_http", providerHttpStatus: 403 },
    ],
    ["network", new EmailDeliveryError("network"), { stage: "network" }],
    ["timeout", new EmailDeliveryError("timeout"), { stage: "timeout" }],
    [
      "provider_unknown",
      new Error("do not expose provider secrets"),
      { stage: "provider_unknown" },
    ],
  ] as const)(
    "classifies %s without logging private error details",
    async (_name, error, expected) => {
      const onFailure = vi.fn();
      const revocations: string[] = [];
      const delivery = createVerificationDelivery({
        publicWebOrigin,
        emailProvider: {
          async send() {
            throw error;
          },
        },
        repository: {
          canDeliver: async () => true,
          async revokeDelivery(input) {
            revocations.push(input.reason);
          },
        },
        onFailure,
      });
      delivery
        .reserve()!
        .prepare({ prepared, recipient: "user@example.com" })
        .finish();
      await delivery.drain();
      expect(onFailure).toHaveBeenCalledExactlyOnceWith(
        "verification",
        expected,
      );
      expect(JSON.stringify(onFailure.mock.calls)).not.toContain("secrets");
      expect(revocations).toEqual(["DELIVERY_FAILED"]);
    },
  );

  it("identifies pre-send query failures separately from provider failures", async () => {
    const onFailure = vi.fn();
    const send = vi.fn();
    const delivery = createVerificationDelivery({
      publicWebOrigin,
      emailProvider: { send },
      repository: {
        async canDeliver() {
          throw new Error("private database detail");
        },
        async revokeDelivery() {},
      },
      onFailure,
    });
    delivery
      .reserve()!
      .prepare({ prepared, recipient: "user@example.com" })
      .finish();
    await delivery.drain();
    expect(send).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledExactlyOnceWith("verification", {
      stage: "pre_send",
    });
    expect(JSON.stringify(onFailure.mock.calls)).not.toContain("private");
  });

  it("separately classifies compensation failures without exposing errors", async () => {
    const onFailure = vi.fn();
    const delivery = createVerificationDelivery({
      publicWebOrigin,
      emailProvider: {
        async send() {
          throw new EmailDeliveryError("network");
        },
      },
      repository: {
        canDeliver: async () => true,
        async revokeDelivery() {
          throw new Error("private compensation detail");
        },
      },
      onFailure,
    });
    delivery
      .reserve()!
      .prepare({ prepared, recipient: "user@example.com" })
      .finish();
    await delivery.drain();
    expect(onFailure.mock.calls).toEqual([
      ["verification", { stage: "network" }],
      ["verification_compensation", { stage: "compensation_failure" }],
    ]);
    expect(JSON.stringify(onFailure.mock.calls)).not.toContain("private");
  });
});
