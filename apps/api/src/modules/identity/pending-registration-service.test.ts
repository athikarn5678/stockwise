import { describe, expect, it, vi } from "vitest";

import type { PendingRegistrationRepository } from "./pending-registration-contract.ts";
import { createPendingRegistrationService } from "./pending-registration-service.ts";
import {
  createVerificationSecurity,
  type VerificationSecurity,
} from "./verification-security.ts";
import type { VerificationDelivery } from "./verification-delivery.ts";

const now = new Date("2026-10-12T00:00:00Z");
const email = "pending@example.test";
const password = "  exact password é🔒  ";
const security = createVerificationSecurity({
  publicWebOrigin: "https://web.example.test",
  otpKey: Buffer.alloc(32, 31),
  otpKeyId: 1,
  proofKey: Buffer.alloc(32, 32),
  proofKeyId: 1,
});

function setup({
  repository: overrides = {},
  verificationSecurity = security,
}: {
  repository?: Partial<PendingRegistrationRepository>;
  verificationSecurity?: VerificationSecurity;
} = {}) {
  const repository: PendingRegistrationRepository = {
    admit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
    reserveCredential: vi.fn(async () => ({
      allowed: true as const,
      attemptId: "attempt-id",
      retryAfterSeconds: 0 as const,
    })),
    register: vi.fn(async () => null),
    resend: vi.fn(async () => null),
    credentialSnapshot: vi.fn(async () => null),
    finishCredential: vi.fn(async () => null),
    completeCode: vi.fn(async () => "invalid" as const),
    completeLink: vi.fn(async () => "invalid" as const),
    canDeliver: vi.fn(async () => false),
    revokeDelivery: vi.fn(async () => undefined),
    sweepExpired: vi.fn(async () => 0),
    ...overrides,
  };
  const reservation = {
    release: vi.fn(),
    prepare: vi.fn(() => ({ finish: vi.fn(), abort: vi.fn() })),
  };
  const delivery: VerificationDelivery = {
    reserve: vi.fn(() => reservation),
    drain: vi.fn(async () => undefined),
  };
  const passwordHasher = { hash: vi.fn(async () => "test-hash") };
  const passwordVerifier = { verify: vi.fn(async () => false) };
  const service = createPendingRegistrationService({
    repository,
    delivery,
    passwordHasher,
    passwordVerifier,
    security: verificationSecurity,
    now: () => now,
  });
  return {
    service,
    repository,
    reservation,
    delivery,
    passwordHasher,
    passwordVerifier,
  };
}

describe("pending registration service admission and proof", () => {
  it("rejects exhausted registration admission before hashing or delivery", async () => {
    const input = setup({
      repository: {
        admit: vi.fn(async () => ({ allowed: false, retryAfterSeconds: 75 })),
      },
    });
    expect(await input.service.register({ email, password })).toEqual({
      outcome: "limited",
      retryAfterSeconds: 75,
    });
    expect(input.passwordHasher.hash).not.toHaveBeenCalled();
    expect(input.delivery.reserve).not.toHaveBeenCalled();
    expect(input.repository.register).not.toHaveBeenCalled();
  });

  it.each(["delivery quota", "delivery capacity"])(
    "stages through the repository with suppressed delivery after %s",
    async (reason) => {
      const prepared = security.prepare(
        "00000000-0000-4000-8000-000000000001",
        1n,
        now,
      );
      const register = vi.fn(async () => prepared);
      const input = setup({
        repository: {
          register,
          admit: vi.fn(async (_email, purpose) => ({
            allowed: reason !== "delivery quota" || purpose !== "delivery",
            retryAfterSeconds: 60,
          })),
        },
      });
      if (reason === "delivery capacity")
        vi.mocked(input.delivery.reserve).mockReturnValue(null);
      const result = await input.service.register({ email, password });
      expect(result).not.toHaveProperty("outcome");
      if ("outcome" in result) throw new Error("Expected real proof response.");
      expect(result).toMatchObject({
        challengeId: prepared.challenge.id,
        proof: prepared.proof,
        delivery: null,
      });
      expect(
        security.readProof(
          `__Host-stockwise_verification_proof=${result.proof}`,
          now,
        )?.usable,
      ).toBe(true);
      expect(result.expiresAt.getTime() - now.getTime()).toBe(600_000);
      expect(register).toHaveBeenCalledWith({
        email,
        passwordHash: "test-hash",
        security,
        suppressed: true,
      });
      expect(input.reservation.prepare).not.toHaveBeenCalled();
    },
  );

  it("releases reserved capacity for an existing-user phantom response", async () => {
    const input = setup();
    const result = await input.service.register({ email, password });
    expect(result).not.toHaveProperty("outcome");
    expect(input.reservation.release).toHaveBeenCalledTimes(1);
    expect(input.reservation.prepare).not.toHaveBeenCalled();
  });

  it.each(["register", "resend"] as const)(
    "releases reserved capacity and propagates %s persistence failure",
    async (operation) => {
      const fault = new Error("injected persistence fault");
      const input = setup({
        repository: {
          [operation]: vi.fn(async () => {
            throw fault;
          }),
        },
      });
      const result =
        operation === "register"
          ? input.service.register({ email, password })
          : input.service.resend(email);
      await expect(result).rejects.toBe(fault);
      expect(input.reservation.release).toHaveBeenCalledTimes(1);
    },
  );

  it("finalizes a failed missing-account comparison without granting proof", async () => {
    const input = setup();
    input.passwordVerifier.verify.mockResolvedValue(true);
    expect(await input.service.provePassword({ email, password })).toEqual({
      outcome: "invalid",
      credentialFailure: true,
    });
    expect(input.repository.reserveCredential).toHaveBeenCalledWith(email);
    expect(input.repository.finishCredential).toHaveBeenCalledWith(
      email,
      "attempt-id",
      null,
      security,
    );
  });

  it("does not charge a matching snapshot invalidated during verification", async () => {
    const snapshot = {
      kind: "pending" as const,
      id: "00000000-0000-4000-8000-000000000001",
      credentialVersion: 1n,
      passwordHash: "test-hash",
    };
    const input = setup({
      repository: {
        credentialSnapshot: vi.fn(async () => snapshot),
        finishCredential: vi.fn(async () => null),
      },
    });
    input.passwordVerifier.verify.mockResolvedValue(true);
    expect(await input.service.provePassword({ email, password })).toEqual({
      outcome: "invalid",
      credentialFailure: false,
    });
    expect(input.repository.finishCredential).toHaveBeenCalledWith(
      email,
      "attempt-id",
      snapshot,
      security,
    );
  });

  it("rejects exhausted credential admission before verifier work", async () => {
    const input = setup({
      repository: {
        reserveCredential: vi.fn(async () => ({
          allowed: false as const,
          retryAfterSeconds: 42,
        })),
      },
    });
    expect(await input.service.provePassword({ email, password })).toEqual({
      outcome: "limited",
      retryAfterSeconds: 42,
    });
    expect(input.passwordVerifier.verify).not.toHaveBeenCalled();
    expect(input.repository.credentialSnapshot).not.toHaveBeenCalled();
    expect(input.repository.finishCredential).not.toHaveBeenCalled();
  });
});
