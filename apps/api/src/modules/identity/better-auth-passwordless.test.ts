import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../../app.ts";
import { startApiServer } from "../../server.ts";
import type { CredentialUser } from "./authentication-repository.ts";
import { createLoginLimiter } from "./login-limiter.ts";
import { createLoginRouter } from "./login-router.ts";
import { createLoginService } from "./login-service.ts";
import { argon2PasswordVerifier, hashPassword } from "./password-hasher.ts";

const configuration = {
  absoluteTimeoutMilliseconds: 604800000,
  idleTimeoutMilliseconds: 86400000,
  secureCookie: false,
  touchIntervalMilliseconds: 900000,
};

function fixture(passwordHash: string, emailVerifiedAt: Date | null) {
  const user: CredentialUser = {
    id: "00000000-0000-4000-8000-000000000001",
    email: "passwordless@example.com",
    displayName: null,
    status: "ACTIVE",
    credentialVersion: 1n,
    emailVerifiedAt,
    passwordHash,
  };
  const establishSession = vi.fn(async () => false);
  const proveCredentialSnapshot = vi.fn(async () => null);
  const generate = vi.fn(() => ({ rawToken: "unused", tokenHash: "unused" }));
  const prove = vi.fn(() => ({ proof: "unused", expiresAt: new Date(0) }));
  const phantom = vi.fn(() => ({ proof: "unused", expiresAt: new Date(0) }));
  const service = createLoginService({
    configuration,
    passwordVerifier: argon2PasswordVerifier,
    repository: {
      findCredentialUser: async (email) => (email === user.email ? user : null),
      establishSession,
    },
    tokenProvider: { generate },
    verificationRepository: { proveCredentialSnapshot },
    security: { prove, phantom },
  });
  return {
    service,
    user,
    mutations: [
      establishSession,
      proveCredentialSnapshot,
      generate,
      prove,
      phantom,
    ],
  };
}

describe("Better Auth passwordless legacy rejection", () => {
  it.each([null, new Date("2026-10-12T00:00:00Z")])(
    "rejects credentials without session or proof authority (verifiedAt=%s)",
    async (verifiedAt) => {
      const hash = await hashPassword(randomBytes(32).toString("base64url"));
      const { service, user, mutations } = fixture(hash, verifiedAt);
      for (const password of [
        "!",
        "a".repeat(15),
        "  Unicode password ก é  ",
        "x".repeat(128),
      ]) {
        expect(await argon2PasswordVerifier.verify(hash, password)).toBe(false);
        expect(
          await service.login({
            email: user.email,
            password,
            existingTokenHash: "existing-session-hash",
          }),
        ).toEqual({ outcome: "credential_failure" });
        expect(
          await service.provePassword({ email: user.email, password }),
        ).toEqual({ outcome: "credential_failure" });
      }
      for (const mutation of mutations) expect(mutation).not.toHaveBeenCalled();
    },
  );

  it("returns the same generic HTTP 401 as a missing user without setting cookies", async () => {
    const { service, user, mutations } = fixture(
      await hashPassword(randomBytes(32).toString("base64url")),
      null,
    );
    const server = await startApiServer(
      createApp({
        apiRouter: createLoginRouter({
          configuration,
          limiter: createLoginLimiter(),
          loginService: service,
          continuationKey: Buffer.alloc(32).toString("base64url"),
          publicWebOrigin: "http://localhost:3000",
        }),
        logger: { info() {}, error() {} },
      }),
      { host: "127.0.0.1", port: 0 },
    );
    try {
      for (const route of ["login", "verification-password-proof"]) {
        for (const email of [user.email, "missing@example.com"]) {
          const response = await fetch(
            `http://127.0.0.1:${server.address.port}/api/v1/auth/${route}`,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                Origin: "http://localhost:3000",
              },
              body: JSON.stringify({ email, password: "incorrect password" }),
            },
          );
          expect(response.status).toBe(401);
          expect(response.headers.getSetCookie()).toEqual([]);
          expect(await response.json()).toEqual({
            error: {
              code: "INVALID_CREDENTIALS",
              message: "The email or password is incorrect.",
              requestId: response.headers.get("x-request-id"),
            },
          });
        }
      }
      for (const mutation of mutations) expect(mutation).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });
});
