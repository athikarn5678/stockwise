import { randomBytes } from "node:crypto";
import { Router } from "express";
import { describe, expect, it } from "vitest";
import { createApp } from "../../app.ts";
import { loadApiEnvironment } from "../../environment.ts";
import { createPrismaClient } from "../../prisma/client.ts";
import { startApiServer } from "../../server.ts";
import { createAuthenticationRuntime } from "./authentication-runtime.ts";
import { createBetterAuthApplicationRuntime } from "./better-auth-application-runtime.ts";
import { requireBetterAuthSecret } from "./better-auth-secret.ts";

function environment(
  secret: string | undefined = randomBytes(32).toString("base64url"),
) {
  return loadApiEnvironment({
    DATABASE_URL:
      "postgresql://synthetic:synthetic@127.0.0.1:1/native_runtime_test",
    STOCKWISE_RUNTIME_ENV: "test",
    STOCKWISE_API_PORT: "3103",
    STOCKWISE_PUBLIC_WEB_ORIGIN: "http://localhost:3102",
    STOCKWISE_BETTER_AUTH_SECRET: secret,
    STOCKWISE_INVITATION_CONTINUATION_KEY:
      randomBytes(32).toString("base64url"),
    STOCKWISE_ANALYTICS_CURSOR_HMAC_KEY: randomBytes(32).toString("base64url"),
    STOCKWISE_VERIFICATION_OTP_KEY: randomBytes(32).toString("base64url"),
    STOCKWISE_VERIFICATION_OTP_KEY_ID: "1",
    STOCKWISE_VERIFICATION_PROOF_KEY: randomBytes(32).toString("base64url"),
    STOCKWISE_VERIFICATION_PROOF_KEY_ID: "1",
  });
}

const invalidSecrets = [
  "",
  "short",
  " ".repeat(64),
  "a".repeat(32),
  `${Buffer.alloc(32, 1).toString("base64url")}=`,
  "+".repeat(43),
];

describe("Native startup configuration", () => {
  it.each([undefined, ...invalidSecrets])(
    "refuses missing or invalid Native configuration before startup (%s)",
    (secret) => {
      const configured = {
        ...environment(),
        STOCKWISE_BETTER_AUTH_SECRET: secret,
      };
      const prisma = createPrismaClient(configured);
      expect(() =>
        createBetterAuthApplicationRuntime({
          environment: configured,
          prisma,
          emailProvider: {
            async send() {
              throw new Error("Mail forbidden");
            },
          },
          onDeliveryFailure() {},
        }),
      ).toThrow(
        "Native authentication requires a dedicated canonical base64url secret",
      );
    },
  );

  it("refuses production HTTP before constructing Native", () => {
    const configured = {
      ...environment(),
      STOCKWISE_RUNTIME_ENV: "production" as const,
    };
    const prisma = createPrismaClient(configured);
    expect(() =>
      createBetterAuthApplicationRuntime({
        environment: configured,
        prisma,
        emailProvider: { async send() {} },
        onDeliveryFailure() {},
      }),
    ).toThrow("Native production authentication requires HTTPS.");
  });

  it.each([
    "STOCKWISE_ANALYTICS_CURSOR_HMAC_KEY",
    "STOCKWISE_VERIFICATION_OTP_KEY",
    "STOCKWISE_VERIFICATION_PROOF_KEY",
    "STOCKWISE_VERIFICATION_PREVIOUS_PROOF_KEY",
    "OPENROUTER_API_KEY",
    "RESEND_API_KEY",
  ] as const)("rejects key reuse with %s without leaking it", (key) => {
    const configured = environment();
    const secret = configured.STOCKWISE_BETTER_AUTH_SECRET!;
    const reused = { ...configured, [key]: secret };
    expect(() => requireBetterAuthSecret(reused)).toThrow(
      /^Native authentication requires a dedicated canonical base64url secret of at least 32 bytes\.$/,
    );
  });
});

describe("actual authentication runtime HTTP boundary without database access", () => {
  it.each(["legacy", "native"] as const)(
    "%s rejects the other authority's cookie and unauthenticated access",
    async (authority) => {
      // Deliberately unusable Native configuration must not affect Legacy construction.
      const configured = environment(
        authority === "legacy" ? "invalid-unused" : undefined,
      );
      const prisma = createPrismaClient(configured);
      const input = {
        environment: configured,
        prisma,
        emailProvider: { async send() {} },
        onDeliveryFailure() {},
      };
      const runtime =
        authority === "legacy"
          ? createAuthenticationRuntime(input)
          : createBetterAuthApplicationRuntime(input);
      const router = Router();
      router.use(runtime.router);
      router.get(
        "/protected",
        runtime.authenticationMiddleware,
        (_request, response) => response.json({ allowed: true }),
      );
      const server = await startApiServer(
        createApp({ apiRouter: router, logger: { info() {}, error() {} } }),
        { host: "127.0.0.1", port: 0 },
      );
      const base = `http://127.0.0.1:${server.address.port}/api/v1`;
      try {
        const cookie =
          authority === "legacy"
            ? "stockwise_native.session_token=synthetic.signature"
            : `stockwise_session=${randomBytes(32).toString("base64url")}`;
        for (const headers of [{}, { cookie }]) {
          const response = await fetch(`${base}/protected`, { headers });
          expect(response.status).toBe(401);
          expect(await response.json()).toMatchObject({
            error: { code: "AUTHENTICATION_REQUIRED" },
          });
          expect(response.headers.has("set-cookie")).toBe(false);
        }
        if (authority === "native") {
          for (const route of [
            "register",
            "login",
            "logout",
            "logout-all",
            "verification-password-proof",
            "verification-resend",
            "verify-email",
            "verify-email-code",
            "forgot-password",
            "reset-password",
          ]) {
            const response = await fetch(`${base}/auth/${route}`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Origin: "http://wrong.invalid",
              },
              body: "{}",
            });
            expect(response.status, route).toBe(403);
            expect(response.headers.has("set-cookie"), route).toBe(false);
          }
          const bypass = await fetch(`${base}/auth/sign-in/email`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: configured.STOCKWISE_PUBLIC_WEB_ORIGIN,
            },
            body: "{}",
          });
          expect(bypass.status).toBe(404);
        }
      } finally {
        await server.stop();
        await runtime.drain();
        await prisma.$disconnect();
      }
    },
  );
});
