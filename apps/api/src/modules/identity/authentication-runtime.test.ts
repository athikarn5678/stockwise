import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createApp } from "../../app.ts";
import { loadApiEnvironment } from "../../environment.ts";
import { createPrismaClient } from "../../prisma/client.ts";
import { startApiServer } from "../../server.ts";
import { createAuthenticationRuntime } from "./authentication-runtime.ts";

describe("shared authentication composition without database access", () => {
  it("all six proof-setting/using routes reject wrong Origin before persistence or mail", async () => {
    const environment = loadApiEnvironment({
      DATABASE_URL:
        "postgresql://synthetic:synthetic@127.0.0.1:1/runtime_unit_test",
      STOCKWISE_RUNTIME_ENV: "test",
      STOCKWISE_EMAIL_PROVIDER: "non_delivery",
      STOCKWISE_API_PORT: "3103",
      STOCKWISE_PUBLIC_WEB_ORIGIN: "http://localhost:3102",
      STOCKWISE_ANALYTICS_CURSOR_HMAC_KEY:
        randomBytes(32).toString("base64url"),
      STOCKWISE_INVITATION_CONTINUATION_KEY:
        randomBytes(32).toString("base64url"),
      STOCKWISE_VERIFICATION_OTP_KEY: randomBytes(32).toString("base64url"),
      STOCKWISE_VERIFICATION_OTP_KEY_ID: "1",
      STOCKWISE_VERIFICATION_PROOF_KEY: randomBytes(32).toString("base64url"),
      STOCKWISE_VERIFICATION_PROOF_KEY_ID: "1",
    });
    const prisma = createPrismaClient(environment);
    let sends = 0;
    const runtime = createAuthenticationRuntime({
      environment,
      prisma,
      emailProvider: {
        async send() {
          sends += 1;
        },
      },
      onDeliveryFailure() {},
    });
    const server = await startApiServer(
      createApp({
        apiRouter: runtime.router,
        logger: { info() {}, error() {} },
      }),
      { host: "127.0.0.1", port: 0 },
    );
    try {
      for (const route of [
        "register",
        "login",
        "verification-password-proof",
        "verification-resend",
        "verify-email",
        "verify-email-code",
      ]) {
        const response = await fetch(
          `http://127.0.0.1:${server.address.port}/api/v1/auth/${route}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: "http://wrong.invalid",
            },
            body: "{}",
          },
        );
        expect(response.status).toBe(403);
        expect(response.headers.has("set-cookie")).toBe(false);
      }
      expect(sends).toBe(0);
    } finally {
      await server.stop();
      await runtime.drain();
      await prisma.$disconnect();
    }
  });
});
