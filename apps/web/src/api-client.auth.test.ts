import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AuthApiError,
  completeFirstOrganizationOnboarding,
  forgotPassword,
  login,
  register,
  resetPassword,
  resendVerification,
  verifyEmail,
  verificationPasswordProof,
  verifyEmailCode,
} from "./api-client";

afterEach(() => {
  vi.unstubAllGlobals();
});

function successfulResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), {
    headers: { "content-type": "application/json" },
    status,
  });
}

describe("authentication API client", () => {
  it("posts exact credentials through the same-origin API path", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      successfulResponse(
        {
          nextStep: "verify_email",
          status: "accepted",
          verification: {
            challengeId: "11111111-1111-4111-8111-111111111111",
          },
        },
        202,
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const password = "  password with Unicode Ω  ";
    await register({ email: " Person@Example.com ", password });

    expect(fetchMock).toHaveBeenCalledWith("/api/v1/auth/register", {
      body: JSON.stringify({ email: " Person@Example.com ", password }),
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      method: "POST",
    });
  });

  it("validates only safe successful response data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        successfulResponse({
          user: {
            displayName: null,
            email: "person@example.com",
            id: "user-id",
          },
        }),
      ),
    );

    await expect(
      login({ email: "person@example.com", password: "password long enough" }),
    ).resolves.toEqual({
      outcome: "authenticated",
      user: { displayName: null, email: "person@example.com", id: "user-id" },
    });
  });

  it("maps rate limiting defensively without exposing raw API text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { code: "RATE_LIMITED", message: "internal detail" },
          }),
          { headers: { "Retry-After": "30" }, status: 429 },
        ),
      ),
    );

    await expect(
      resendVerification({ email: "person@example.com" }),
    ).rejects.toMatchObject({ kind: "rate_limited", retryAfterSeconds: 30 });
  });

  it("rejects malformed and internal response bodies with a safe unavailable error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { code: "INTERNAL_ERROR", message: "Prisma secret" },
          }),
          {
            status: 500,
          },
        ),
      ),
    );

    await expect(
      forgotPassword({ email: "person@example.com" }),
    ).rejects.toEqual(new AuthApiError("unavailable"));
  });

  it("sends opaque tokens only in their required request body", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(successfulResponse({ status: "verified" }))
      .mockResolvedValueOnce(successfulResponse({ status: "password_reset" }));
    vi.stubGlobal("fetch", fetchMock);

    await verifyEmail({ token: "opaque-verification-token" });
    await resetPassword({
      newPassword: "  new password with Ω  ",
      token: "opaque-reset-token",
    });

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({ token: "opaque-verification-token" }),
    });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      body: JSON.stringify({
        newPassword: "  new password with Ω  ",
        token: "opaque-reset-token",
      }),
    });
  });

  it("rejects a malformed successful onboarding response instead of granting application entry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(successfulResponse({ nextStep: "app" })),
    );
    await expect(
      completeFirstOrganizationOnboarding({
        branchName: "Main",
        displayName: "Owner",
        organizationName: "Store",
      }),
    ).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("maps first-onboarding conflicts to safe client error kinds", async () => {
    for (const [code, kind] of [
      ["ALREADY_ONBOARDED", "already_onboarded"],
      ["ALREADY_HAS_ORGANIZATION_ACCESS", "already_has_organization_access"],
    ] as const) {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(
            new Response(JSON.stringify({ error: { code } }), { status: 409 }),
          ),
      );

      await expect(
        completeFirstOrganizationOnboarding({
          branchName: "Main",
          displayName: "Owner",
          organizationName: "Store",
        }),
      ).rejects.toMatchObject({ kind });
    }
  });
  it.each(["11111111-1111-4111-8111-111111111111", null])(
    "returns pending login without authenticated authority (%s)",
    async (challengeId) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          successfulResponse(
            {
              status: "verification_required",
              nextStep: "verify_email",
              verification: { challengeId },
            },
            202,
          ),
        ),
      );
      await expect(
        login({
          email: "person@example.com",
          password: "password long enough",
        }),
      ).resolves.toEqual({
        outcome: "verification_required",
        status: "verification_required",
        nextStep: "verify_email",
        verification: { challengeId },
      });
    },
  );

  it("rejects ambiguous login data rather than granting authority", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        successfulResponse({
          user: { id: "user", email: "person@example.com", displayName: null },
          status: "verification_required",
          nextStep: "verify_email",
          verification: { challengeId: null },
        }),
      ),
    );
    await expect(
      login({ email: "person@example.com", password: "password long enough" }),
    ).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("accepts OTP completion, dedicated proof and resend continuation contracts", async () => {
    const challengeId = "11111111-1111-4111-8111-111111111111";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(successfulResponse({ status: "verified" }))
      .mockResolvedValueOnce(successfulResponse({ status: "accepted" }, 202))
      .mockResolvedValueOnce(
        successfulResponse(
          { status: "accepted", verification: { challengeId } },
          202,
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      verifyEmailCode({
        email: "person@example.com",
        challengeId,
        code: "012345",
      }),
    ).resolves.toEqual({ data: { status: "verified" } });
    await expect(
      verificationPasswordProof({
        email: "person@example.com",
        password: "  unchanged password Ω  ",
      }),
    ).resolves.toEqual({ data: { status: "accepted" } });
    await expect(
      resendVerification({ email: "person@example.com" }),
    ).resolves.toEqual({
      data: { status: "accepted", verification: { challengeId } },
    });
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/v1/auth/verify-email-code",
      "/api/v1/auth/verification-password-proof",
      "/api/v1/auth/verification-resend",
    ]);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      credentials: "same-origin",
      body: JSON.stringify({
        email: "person@example.com",
        challengeId,
        code: "012345",
      }),
    });
  });

  it.each([
    ["INVALID_VERIFICATION_CODE", 400, "invalid_verification_code"],
    ["INVALID_TOKEN", 400, "invalid_token"],
    [
      "VERIFICATION_PASSWORD_PROOF_REQUIRED",
      401,
      "verification_password_proof_required",
    ],
    ["INVALID_CREDENTIALS", 401, "invalid_credentials"],
    ["VALIDATION_ERROR", 400, "validation"],
  ] as const)(
    "maps %s without returning server details",
    async (code, status, kind) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              error: { code, message: "private provider details" },
            }),
            { status },
          ),
        ),
      );
      await expect(verifyEmail({ token: "opaque-token" })).rejects.toEqual(
        new AuthApiError(kind),
      );
    },
  );

  it.each([200, 202])(
    "rejects a login result with a mismatched HTTP status (%s)",
    async (status) => {
      const user = {
        id: "user",
        email: "person@example.com",
        displayName: null,
      };
      const pending = {
        status: "verification_required",
        nextStep: "verify_email",
        verification: { challengeId: null },
      };
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(
            successfulResponse(status === 200 ? pending : { user }, status),
          ),
      );
      await expect(
        login({
          email: "person@example.com",
          password: "password long enough",
        }),
      ).rejects.toMatchObject({ kind: "unavailable" });
    },
  );

  it("does not reveal password fallback from an unrelated server failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { code: "VERIFICATION_PASSWORD_PROOF_REQUIRED" },
          }),
          { status: 500 },
        ),
      ),
    );
    await expect(verifyEmail({ token: "opaque-token" })).rejects.toMatchObject({
      kind: "unavailable",
    });
  });
});
