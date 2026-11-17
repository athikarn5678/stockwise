import { describe, expect, it, vi } from "vitest";

import type { PasswordResetRepository } from "./credential-lifecycle-repository.ts";
import { createPasswordResetService } from "./credential-lifecycle-service.ts";
import type { IdentityEmailProvider } from "./email-provider.ts";
import type { PasswordHasher } from "./password-hasher.ts";

const NOW = new Date("2026-08-24T12:00:00.000Z");
const rawToken = "A".repeat(43);
const tokenHash = "a".repeat(64);

function createRepository(): PasswordResetRepository {
  return {
    completePasswordReset: vi.fn().mockResolvedValue(true),
    findValidPasswordResetToken: vi.fn().mockResolvedValue({
      tokenId: "reset-token-id",
      userId: "user-id",
    }),
    issuePasswordResetToken: vi.fn().mockResolvedValue({
      id: "reset-token-id",
      recipient: "user@example.com",
    }),
    revokePasswordResetToken: vi.fn().mockResolvedValue(undefined),
  };
}

function createService({
  emailProvider = { send: vi.fn().mockResolvedValue(undefined) },
  passwordHasher = { hash: vi.fn().mockResolvedValue("argon2-phc-hash") },
  repository = createRepository(),
}: {
  emailProvider?: IdentityEmailProvider;
  passwordHasher?: PasswordHasher;
  repository?: PasswordResetRepository;
} = {}) {
  return {
    emailProvider,
    passwordHasher,
    repository,
    service: createPasswordResetService({
      emailProvider,
      now: () => NOW,
      passwordHasher,
      publicWebOrigin: "https://stockwise.example.com",
      repository,
      tokenProvider: { generate: () => ({ rawToken, tokenHash }) },
    }),
  };
}

describe("credential lifecycle service", () => {
  it("issues a 30-minute reset token and compensates provider failure", async () => {
    const repository = createRepository();
    const emailProvider = {
      send: vi.fn().mockRejectedValue(new Error("raw provider detail")),
    };
    const { service } = createService({ emailProvider, repository });

    await service.requestPasswordReset("user@example.com");

    expect(repository.issuePasswordResetToken).toHaveBeenCalledWith({
      email: "user@example.com",
      expiresAt: new Date("2026-08-24T12:30:00.000Z"),
      issuedAt: NOW,
      tokenHash,
    });
    expect(repository.revokePasswordResetToken).toHaveBeenCalledWith({
      revokedAt: NOW,
      tokenId: "reset-token-id",
    });
  });

  it("rejects an invalid reset token before Argon2 hashing", async () => {
    const repository = createRepository();
    vi.mocked(repository.findValidPasswordResetToken).mockResolvedValue(null);
    const passwordHasher = { hash: vi.fn().mockResolvedValue("unused") };
    const { service } = createService({ passwordHasher, repository });

    await expect(
      service.resetPassword({
        newPassword: "new-password-long-enough",
        rawToken,
      }),
    ).resolves.toBe(false);
    expect(passwordHasher.hash).not.toHaveBeenCalled();
    expect(repository.completePasswordReset).not.toHaveBeenCalled();
  });

  it("hashes only after token validation and delegates atomic completion", async () => {
    const calls: string[] = [];
    const repository = createRepository();
    vi.mocked(repository.findValidPasswordResetToken).mockImplementation(
      async () => {
        calls.push("validate-token");
        return { tokenId: "reset-token-id", userId: "user-id" };
      },
    );
    vi.mocked(repository.completePasswordReset).mockImplementation(async () => {
      calls.push("complete-transaction");
      return true;
    });
    const passwordHasher = {
      hash: vi.fn().mockImplementation(async () => {
        calls.push("argon2");
        return "argon2-phc-hash";
      }),
    };
    const { service } = createService({ passwordHasher, repository });

    await expect(
      service.resetPassword({
        newPassword: "new-password-long-enough",
        rawToken,
      }),
    ).resolves.toBe(true);
    expect(calls).toEqual(["validate-token", "argon2", "complete-transaction"]);
  });
});
