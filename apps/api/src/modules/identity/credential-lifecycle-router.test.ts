import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../../app.ts";
import type { ApiLogger } from "../../logger.ts";
import { startApiServer, type RunningApiServer } from "../../server.ts";
import type { PasswordResetService } from "./credential-lifecycle-service.ts";
import { createBetterAuthPasswordResetRouter } from "./credential-lifecycle-router.ts";
import { createEmailRequestLimiter } from "./email-request-limiter.ts";

const logger: ApiLogger = {
  error() {},
  info() {},
};

function createLifecycleService(): PasswordResetService {
  return {
    requestPasswordReset: vi.fn().mockResolvedValue(undefined),
    resetPassword: vi.fn().mockResolvedValue(true),
  };
}

describe("credential lifecycle router", () => {
  let runningServer: RunningApiServer | undefined;

  afterEach(async () => {
    await runningServer?.stop();
    runningServer = undefined;
  });

  async function startRouter({
    lifecycleService = createLifecycleService(),
    now = () => 1_000,
  }: {
    lifecycleService?: PasswordResetService;
    now?: () => number;
  } = {}) {
    const passwordResetLimiter = createEmailRequestLimiter(now);
    const apiRouter = createBetterAuthPasswordResetRouter({
      lifecycleService,
      passwordResetLimiter: {
        consume: async (email) => passwordResetLimiter.consume(email),
      },
      publicWebOrigin: "http://localhost:3000",
    });
    runningServer = await startApiServer(createApp({ apiRouter, logger }), {
      host: "127.0.0.1",
      port: 0,
    });
    return {
      lifecycleService,
      url: `http://${runningServer.address.host}:${runningServer.address.port}/api/v1`,
    };
  }

  function post(url: string, path: string, body: unknown, headers = {}) {
    return fetch(`${url}${path}`, {
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        Origin: "http://localhost:3000",
        ...headers,
      },
      method: "POST",
    });
  }

  it("applies an independent reset-request fixed window and restores it", async () => {
    let now = 5_000;
    const { url } = await startRouter({ now: () => now });

    for (const email of [
      " RESET@EXAMPLE.COM ",
      "reset@example.com",
      "Reset@example.com",
    ]) {
      expect((await post(url, "/auth/forgot-password", { email })).status).toBe(
        202,
      );
    }
    const limited = await post(url, "/auth/forgot-password", {
      email: "reset@example.com",
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("900");

    now += 15 * 60 * 1000;
    expect(
      (
        await post(url, "/auth/forgot-password", {
          email: "reset@example.com",
        })
      ).status,
    ).toBe(202);
  });

  it("enforces the accepted reset-password boundaries before service work", async () => {
    const { lifecycleService, url } = await startRouter();
    const token = "T".repeat(43);

    for (const newPassword of ["x".repeat(14), "x".repeat(129)]) {
      expect(
        (await post(url, "/auth/reset-password", { newPassword, token }))
          .status,
      ).toBe(400);
    }
    expect(lifecycleService.resetPassword).not.toHaveBeenCalled();

    expect(
      (
        await post(url, "/auth/reset-password", {
          newPassword: "  Unicode pass 🔒  ",
          token,
        })
      ).status,
    ).toBe(200);
    expect(lifecycleService.resetPassword).toHaveBeenCalledWith({
      newPassword: "  Unicode pass 🔒  ",
      rawToken: token,
    });
  });
});
