import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../../app.ts";
import type { ApiLogger } from "../../logger.ts";
import { startApiServer, type RunningApiServer } from "../../server.ts";
import { createLoginLimiter } from "./login-limiter.ts";
import { createLoginRouter, loginRequestSchema } from "./login-router.ts";
import type { LoginService } from "./login-service.ts";
import type { SessionConfiguration } from "./session-configuration.ts";
import { SESSION_COOKIE_NAME } from "./session-cookie.ts";

interface LogEntry {
  bindings: Record<string, unknown>;
  level: "error" | "info";
  message: string;
}

const LOCAL_CONFIGURATION: SessionConfiguration = {
  absoluteTimeoutMilliseconds: 7 * 24 * 60 * 60 * 1000,
  idleTimeoutMilliseconds: 24 * 60 * 60 * 1000,
  secureCookie: false,
  touchIntervalMilliseconds: 15 * 60 * 1000,
};
const RAW_TOKEN = "A".repeat(43);
const authenticatedResult = {
  outcome: "authenticated" as const,
  rawSessionToken: RAW_TOKEN,
  user: {
    displayName: null,
    email: "user@example.com",
    id: "00000000-0000-4000-8000-000000000001",
  },
};

describe("login request validation", () => {
  it("canonicalizes email and preserves the exact password", () => {
    const password = "  exact password é  ";

    expect(
      loginRequestSchema.parse({ email: "  User@Example.COM  ", password }),
    ).toEqual({ email: "user@example.com", password });
  });

  it.each([
    ["malformed email", { email: "not-an-email", password: "x".repeat(15) }],
    ["missing email", { password: "x".repeat(15) }],
    ["missing password", { email: "user@example.com" }],
    [
      "unknown field",
      {
        email: "user@example.com",
        password: "password-long-enough",
        role: "OWNER",
      },
    ],
  ])("rejects %s", (_name, body) => {
    expect(loginRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe("POST /api/v1/auth/login", () => {
  let runningServer: RunningApiServer | undefined;

  afterEach(async () => {
    await runningServer?.stop();
    runningServer = undefined;
  });

  async function startLoginApplication({
    configuration = LOCAL_CONFIGURATION,
    loginService,
    now = () => 0,
  }: {
    configuration?: SessionConfiguration;
    loginService: Pick<LoginService, "login">;
    now?: () => number;
  }) {
    const entries: LogEntry[] = [];
    const logger: ApiLogger = {
      error(bindings, message) {
        entries.push({ bindings, level: "error", message });
      },
      info(bindings, message) {
        entries.push({ bindings, level: "info", message });
      },
    };
    const apiRouter = createLoginRouter({
      configuration,
      limiter: createLoginLimiter(now),
      loginService: {
        ...loginService,
        async provePassword() {
          throw new Error("Fallback is not used by this login-route fixture.");
        },
      },
      continuationKey: Buffer.alloc(32).toString("base64url"),
      publicWebOrigin: "http://localhost:3000",
    });
    const app = createApp({ apiRouter, logger });
    runningServer = await startApiServer(app, {
      host: "127.0.0.1",
      port: 0,
    });

    return {
      entries,
      url: `http://${runningServer.address.host}:${runningServer.address.port}/api/v1/auth/login`,
    };
  }

  function login(
    url: string,
    body: unknown,
    cookie?: string,
  ): Promise<Response> {
    return fetch(url, {
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        Origin: "http://localhost:3000",
        ...(cookie === undefined ? {} : { cookie }),
      },
      method: "POST",
    });
  }

  it("returns only safe actor fields and the accepted local cookie", async () => {
    const loginMethod = vi.fn(async () => authenticatedResult);
    const password = "  exact password é  ";
    const { entries, url } = await startLoginApplication({
      loginService: { login: loginMethod },
    });

    const response = await login(
      url,
      { email: "  User@Example.COM  ", password },
      `${SESSION_COOKIE_NAME}=${"B".repeat(43)}`,
    );
    const responseText = await response.text();
    const responseBody = JSON.parse(responseText) as unknown;
    const setCookie = response.headers
      .getSetCookie()
      .find((value) => value.startsWith(`${SESSION_COOKIE_NAME}=`));

    expect(response.status).toBe(200);
    expect(responseBody).toEqual({
      data: { user: authenticatedResult.user },
      meta: { requestId: response.headers.get("x-request-id") },
    });
    expect(setCookie).toBe(
      `${SESSION_COOKIE_NAME}=${RAW_TOKEN}; Path=/; HttpOnly; SameSite=Lax`,
    );
    expect(responseText).not.toContain(password);
    expect(responseText).not.toContain("sessionId");
    expect(responseText).not.toContain("role");
    expect(responseText).not.toContain("organization");
    expect(responseText).not.toContain("branch");
    expect(responseText).not.toContain("permission");
    expect(JSON.stringify(entries)).not.toContain(password);
    expect(JSON.stringify(entries)).not.toContain(RAW_TOKEN);
  });

  it("sets Secure in production without adding a Domain attribute", async () => {
    const { url } = await startLoginApplication({
      configuration: { ...LOCAL_CONFIGURATION, secureCookie: true },
      loginService: { login: async () => authenticatedResult },
    });

    const response = await login(url, {
      email: "user@example.com",
      password: "password-long-enough",
    });
    const setCookie =
      response.headers
        .getSetCookie()
        .find((value) => value.startsWith(`${SESSION_COOKIE_NAME}=`)) ?? "";

    expect(setCookie).toContain("; Secure");
    expect(setCookie).not.toContain("Domain=");
  });

  it("maps wrong-password and nonexistent-account outcomes identically", async () => {
    const { url } = await startLoginApplication({
      loginService: { login: async () => ({ outcome: "credential_failure" }) },
    });

    const wrongPassword = await login(url, {
      email: "existing@example.com",
      password: "wrong-password-long-enough",
    });
    const nonexistent = await login(url, {
      email: "missing@example.com",
      password: "wrong-password-long-enough",
    });
    const wrongBody = await wrongPassword.json();
    const missingBody = await nonexistent.json();

    expect(wrongPassword.status).toBe(401);
    expect(nonexistent.status).toBe(401);
    expect(wrongBody).toMatchObject({
      error: {
        code: "INVALID_CREDENTIALS",
        message: "The email or password is incorrect.",
      },
    });
    expect(missingBody).toMatchObject({
      error: {
        code: "INVALID_CREDENTIALS",
        message: "The email or password is incorrect.",
      },
    });
  });

  it("processes five failures, then returns deterministic rate limiting", async () => {
    const loginMethod = vi.fn(async () => ({
      outcome: "credential_failure" as const,
    }));
    const { url } = await startLoginApplication({
      loginService: { login: loginMethod },
    });
    const variants = [
      "user@example.com",
      " User@example.com",
      "USER@EXAMPLE.COM ",
      " user@EXAMPLE.com ",
      "User@Example.Com",
    ];

    for (const email of variants) {
      const response = await login(url, {
        email,
        password: "wrong-password-long-enough",
      });
      expect(response.status).toBe(401);
    }

    const limited = await login(url, {
      email: " USER@EXAMPLE.COM ",
      password: "correct-password-long-enough",
    });

    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("900");
    expect(await limited.json()).toMatchObject({
      error: { code: "RATE_LIMITED" },
    });
    expect(loginMethod).toHaveBeenCalledTimes(5);
  });

  it("allows success before exhaustion without resetting failures", async () => {
    const loginMethod = vi.fn<LoginService["login"]>(async ({ password }) =>
      password === "correct-password-long-enough"
        ? authenticatedResult
        : { outcome: "credential_failure" },
    );
    const { url } = await startLoginApplication({
      loginService: { login: loginMethod },
    });

    for (let failure = 0; failure < 4; failure += 1) {
      expect(
        (
          await login(url, {
            email: "user@example.com",
            password: "wrong-password-long-enough",
          })
        ).status,
      ).toBe(401);
    }

    expect(
      (
        await login(url, {
          email: "user@example.com",
          password: "correct-password-long-enough",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await login(url, {
          email: "user@example.com",
          password: "wrong-password-long-enough",
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await login(url, {
          email: "user@example.com",
          password: "correct-password-long-enough",
        })
      ).status,
    ).toBe(429);
  });

  it("does not count correct credentials for an ineligible account", async () => {
    const loginMethod = vi.fn(async () => ({
      outcome: "account_ineligible" as const,
    }));
    const { url } = await startLoginApplication({
      loginService: { login: loginMethod },
    });

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await login(url, {
        email: "unverified@example.com",
        password: "correct-password-long-enough",
      });
      expect(response.status).toBe(401);
    }
    expect(loginMethod).toHaveBeenCalledTimes(6);
  });

  it("rejects invalid requests before limiter/service and hides failures", async () => {
    const loginMethod = vi.fn();
    const internalDetail = "Prisma DATABASE_URL and session-token-hash";
    const first = await startLoginApplication({
      loginService: { login: loginMethod },
    });

    const invalid = await login(first.url, {
      email: "not-an-email",
      password: "password-long-enough",
    });
    expect(invalid.status).toBe(400);
    expect(loginMethod).not.toHaveBeenCalled();

    await runningServer?.stop();
    runningServer = undefined;

    const second = await startLoginApplication({
      loginService: {
        login: async () => {
          throw new Error(internalDetail);
        },
      },
    });
    const failed = await login(second.url, {
      email: "user@example.com",
      password: "password-long-enough",
    });
    const failedText = await failed.text();

    expect(failed.status).toBe(500);
    expect(failedText).not.toContain(internalDetail);
    expect(JSON.stringify(second.entries)).not.toContain(internalDetail);
  });
});
