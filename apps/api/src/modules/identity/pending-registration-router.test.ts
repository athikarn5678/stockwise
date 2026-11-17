import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../../app.ts";
import type { ApiLogger } from "../../logger.ts";
import { startApiServer, type RunningApiServer } from "../../server.ts";
import type { PendingRegistrationService } from "./pending-registration-service.ts";
import { createPendingRegistrationRouter } from "./pending-registration-router.ts";
import type { VerificationResponseDelivery } from "./verification-delivery.ts";

interface LogEntry {
  bindings: Record<string, unknown>;
  level: "error" | "info";
  message: string;
}

function capturingLogger(): { entries: LogEntry[]; logger: ApiLogger } {
  const entries: LogEntry[] = [];
  const logger: ApiLogger = {
    error: (bindings: Record<string, unknown>, message: string) => {
      entries.push({ bindings, level: "error", message });
    },
    info: (bindings: Record<string, unknown>, message: string) => {
      entries.push({ bindings, level: "info", message });
    },
  };
  return { entries, logger };
}

const proof = "P".repeat(100);
const cookie = `__Host-stockwise_verification_proof=${proof}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=600`;
const expiresAt = new Date(Date.now() + 600_000);

function acceptedRegistration(
  delivery: VerificationResponseDelivery | null = null,
) {
  return {
    challengeId: "00000000-0000-4000-8000-000000000001",
    proof,
    expiresAt,
    delivery,
  };
}

const acceptedResend = {
  outcome: "accepted" as const,
  challengeId: "00000000-0000-4000-8000-000000000002",
  delivery: null,
};

function stubService(
  overrides: Partial<PendingRegistrationService> = {},
): PendingRegistrationService {
  return {
    register: vi.fn(async () => acceptedRegistration()),
    resend: vi.fn(async () => acceptedResend),
    provePassword: vi.fn(async () => ({ outcome: "invalid" as const })),
    completeCode: vi.fn(async () => "invalid" as const),
    completeLink: vi.fn(async () => "already_verified" as const),
    ...overrides,
  };
}

describe("pending registration HTTP router", () => {
  let server: RunningApiServer | undefined;
  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  async function serve(service: PendingRegistrationService) {
    const captured = capturingLogger();
    const router = createPendingRegistrationRouter({
      pendingRegistrationService: service,
      publicWebOrigin: "http://localhost:3000",
    });
    server = await startApiServer(
      createApp({ apiRouter: router, logger: captured.logger }),
      { host: "127.0.0.1", port: 0 },
    );
    return {
      entries: captured.entries,
      url: `http://${server.address.host}:${server.address.port}/api/v1`,
    };
  }

  function post(
    url: string,
    path: string,
    body: unknown,
    extraHeaders: Record<string, string> = {},
  ) {
    return fetch(`${url}${path}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        Origin: "http://localhost:3000",
        ...extraHeaders,
      },
    });
  }

  it("rejects cross-site/scanner requests, does not expose GET completion status, and requires strict JSON origin", async () => {
    const service = stubService();
    const { url } = await serve(service);
    const crossSite = await post(
      url,
      "/auth/register",
      { email: "user@example.com", password: "password-long-enough" },
      { "Sec-Fetch-Site": "cross-site" },
    );
    expect(crossSite.status).toBe(403);
    expect(crossSite.headers.get("cache-control")).toBe("no-store");
    expect(crossSite.headers.get("referrer-policy")).toBe("no-referrer");
    const scannerGet = await fetch(
      `${url}/auth/verify-email?token=${"A".repeat(43)}`,
    );
    expect(scannerGet.status).toBe(404);
    const wrongOrigin = await post(
      url,
      "/auth/verify-email",
      { token: "A".repeat(43) },
      { Origin: "https://attacker.example" },
    );
    const wrongMediaType = await post(
      url,
      "/auth/verify-email",
      { token: "A".repeat(43) },
      { "content-type": "text/plain" },
    );
    expect(wrongMediaType.status).toBe(403);
    expect(wrongOrigin.status).toBe(403);
    expect(service.register).not.toHaveBeenCalled();
    expect(service.completeLink).not.toHaveBeenCalled();
  });

  it("validates strict canonical schemas before service work", async () => {
    const service = stubService();
    const { url } = await serve(service);
    const response = await post(url, "/auth/register", {
      email: " USER@example.com ",
      password: "password-long-enough",
      extra: true,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "VALIDATION_ERROR" },
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(service.register).not.toHaveBeenCalled();
  });

  it("sets only the verification cookie for registration, with an accepted phantom-compatible envelope", async () => {
    const service = stubService();
    const { url } = await serve(service);
    const response = await post(url, "/auth/register", {
      email: "user@example.com",
      password: "password-long-enough",
    });
    expect(response.status).toBe(202);
    expect(response.headers.get("set-cookie")).toContain(
      "__Host-stockwise_verification_proof=",
    );
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("SameSite=Strict");
    expect(response.headers.get("set-cookie")).not.toMatch(
      /session|auth_token/i,
    );
    expect(await response.json()).toMatchObject({
      data: { status: "accepted", nextStep: "verify_email" },
    });
  });

  it("resend does not change proof cookie and maps durable delivery quota to Retry-After", async () => {
    const resend = vi.fn(async () => ({
      outcome: "limited" as const,
      retryAfterSeconds: 63,
    }));
    const service = stubService({ resend });
    const { url } = await serve(service);
    const response = await post(
      url,
      "/auth/verification-resend",
      { email: "user@example.com" },
      { Cookie: cookie },
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("63");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("does not issue a proof for accepted resend, preserves link replay, and clears only on verified completion", async () => {
    const completeLink = vi
      .fn()
      .mockResolvedValueOnce("already_verified" as const)
      .mockResolvedValueOnce("verified" as const);
    const service = stubService({ completeLink });
    const { url } = await serve(service);
    const resendResponse = await post(
      url,
      "/auth/verification-resend",
      { email: "user@example.com" },
      { Cookie: cookie },
    );
    expect(resendResponse.status).toBe(202);
    expect(resendResponse.headers.get("set-cookie")).toBeNull();

    const replay = await post(
      url,
      "/auth/verify-email",
      { token: "A".repeat(43) },
      { Cookie: cookie },
    );
    expect(replay.status).toBe(200);
    expect(replay.headers.get("set-cookie")).toBeNull();
    const verified = await post(url, "/auth/verify-email", {
      token: "A".repeat(43),
    });
    expect(verified.status).toBe(200);
    expect(verified.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("distinguishes missing proof from an invalid code without clearing proof", async () => {
    const completeCode = vi
      .fn()
      .mockResolvedValueOnce("proof_required" as const)
      .mockResolvedValueOnce("invalid" as const);
    const service = stubService({ completeCode });
    const { url } = await serve(service);
    const body = {
      email: "user@example.com",
      challengeId: "00000000-0000-4000-8000-000000000001",
      code: "001234",
    };
    const missingProof = await post(url, "/auth/verify-email-code", body);
    expect(missingProof.status).toBe(401);
    expect(await missingProof.json()).toMatchObject({
      error: { code: "VERIFICATION_PASSWORD_PROOF_REQUIRED" },
    });
    expect(missingProof.headers.get("set-cookie")).toBeNull();
    const invalidCode = await post(url, "/auth/verify-email-code", body, {
      Cookie: cookie,
    });
    expect(invalidCode.status).toBe(400);
    expect(await invalidCode.json()).toMatchObject({
      error: { code: "INVALID_VERIFICATION_CODE" },
    });
    expect(invalidCode.headers.get("set-cookie")).toBeNull();
  });

  it("sets fallback proof after valid password, hides invalid credentials, and enforces credential budget", async () => {
    const provePassword = vi
      .fn()
      .mockResolvedValueOnce({ outcome: "invalid" as const })
      .mockResolvedValueOnce({ outcome: "proved" as const, proof, expiresAt })
      .mockResolvedValueOnce({
        outcome: "limited" as const,
        retryAfterSeconds: 24,
      });
    const service = stubService({ provePassword });
    const { url } = await serve(service);
    const bad = await post(url, "/auth/verification-password-proof", {
      email: "user@example.com",
      password: "wrong-password12",
    });
    expect(bad.status).toBe(401);
    expect(await bad.json()).toMatchObject({
      error: { code: "INVALID_CREDENTIALS" },
    });
    expect(bad.headers.get("set-cookie")).toBeNull();
    const good = await post(url, "/auth/verification-password-proof", {
      email: "user@example.com",
      password: "correct-password",
    });
    expect(good.status).toBe(202);
    expect(good.headers.get("set-cookie")).toContain(
      "__Host-stockwise_verification_proof=",
    );

    const limitedResponse = await post(
      url,
      "/auth/verification-password-proof",
      { email: "user@example.com", password: "valid-long-password" },
    );
    expect(limitedResponse.status).toBe(429);
    expect(limitedResponse.headers.get("retry-after")).toBe("24");
  });

  it("canonicalizes the email and rejects malformed, missing, or unknown registration fields", async () => {
    const register = vi.fn<PendingRegistrationService["register"]>(async () =>
      acceptedRegistration(),
    );
    const service = stubService({ register });
    const { url } = await serve(service);
    const accepted = await post(url, "/auth/register", {
      email: "  User@Example.COM  ",
      password: "password-long-enough",
    });
    expect(accepted.status).toBe(202);
    expect(register).toHaveBeenCalledTimes(1);
    expect(register.mock.calls[0]?.[0]).toEqual({
      email: "user@example.com",
      password: "password-long-enough",
    });
    for (const body of [
      { email: "not-an-email", password: "x".repeat(15) },
      { password: "x".repeat(15) },
      { email: "user@example.com" },
      {
        displayName: "Not accepted during registration",
        email: "user@example.com",
        password: "x".repeat(15),
      },
    ]) {
      const rejected = await post(url, "/auth/register", body);
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toMatchObject({
        error: { code: "VALIDATION_ERROR" },
      });
    }
    expect(register).toHaveBeenCalledTimes(1);
  });

  it.each([
    [14, false],
    [15, true],
    [128, true],
    [129, false],
  ])(
    "validates a %i-code-point registration password without counting UTF-16 code units",
    async (length, accepted) => {
      const register = vi.fn<PendingRegistrationService["register"]>(async () =>
        acceptedRegistration(),
      );
      const service = stubService({ register });
      const { url } = await serve(service);
      const password = "🔒".repeat(length);
      const response = await post(url, "/auth/register", {
        email: "user@example.com",
        password,
      });

      expect(response.status).toBe(accepted ? 202 : 400);
      expect(register).toHaveBeenCalledTimes(accepted ? 1 : 0);
      if (accepted)
        expect(register.mock.calls[0]?.[0]?.password).toBe(password);
    },
  );

  it("allows whitespace and passes the exact code points, including decomposed Unicode, to the service", async () => {
    const register = vi.fn<PendingRegistrationService["register"]>(async () =>
      acceptedRegistration(),
    );
    const service = stubService({ register });
    const { url } = await serve(service);
    const password = `  ${"e\u0301".repeat(6)}  `;
    const response = await post(url, "/auth/register", {
      email: "user@example.com",
      password,
    });

    expect(response.status).toBe(202);
    const submitted = register.mock.calls[0]?.[0]?.password;
    expect(submitted).toBe(password);
    expect(submitted).not.toBe(password.normalize("NFC"));
    const whitespaceOnly = await post(url, "/auth/register", {
      email: "user@example.com",
      password: " ".repeat(15),
    });
    expect(whitespaceOnly.status).toBe(202);
    expect(register.mock.calls[1]?.[0]?.password).toBe(" ".repeat(15));
  });

  it("preserves safe error envelopes when provider/persistence work fails", async () => {
    const secret = "provider response with sensitive details";
    const service = stubService({
      register: vi.fn(async () => {
        throw new Error(secret);
      }),
    });
    const { entries, url } = await serve(service);
    const response = await post(url, "/auth/register", {
      email: "user@example.com",
      password: "password-long-enough",
    });
    const body = await response.text();
    expect(response.status).toBe(500);
    expect(body).not.toContain(secret);
    expect(JSON.stringify(entries)).not.toContain(secret);
  });
});
