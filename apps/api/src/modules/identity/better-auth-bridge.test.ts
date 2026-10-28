import { Router } from "express";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../../app.ts";
import { startApiServer, type RunningApiServer } from "../../server.ts";
import {
  createSessionAuthenticationMiddleware,
  getTrustedAuthenticationContext,
} from "./authentication-context.ts";
import {
  createBetterAuthAuthenticationMiddleware,
  createBetterAuthSessionResolver,
} from "./better-auth-bridge.ts";
import {
  BETTER_AUTH_NATIVE_COOKIE_NAME,
  type BetterAuthNativeSessionReader,
} from "./better-auth-native.ts";
import type { NativeAuthoritySession } from "./better-auth-session-repository.ts";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const SESSION_ID = "00000000-0000-4000-8000-000000000002";
const NOW = new Date("2026-10-12T12:00:00Z");
const ORIGIN = "http://localhost:3000";
const COOKIE = `${BETTER_AUTH_NATIVE_COOKIE_NAME}=synthetic-signed-cookie`;
const configuration = {
  absoluteTimeoutMilliseconds: 604800000,
  idleTimeoutMilliseconds: 86400000,
  secureCookie: false,
  touchIntervalMilliseconds: 900000,
};

function fixture(): NativeAuthoritySession {
  return {
    id: SESSION_ID,
    userId: USER_ID,
    stockwisePurpose: "APPLICATION",
    stockwiseCredentialVersion: 1n,
    createdAt: new Date("2026-10-12T11:00:00Z"),
    updatedAt: new Date("2026-10-12T11:55:00Z"),
    expiresAt: new Date("2026-10-13T12:00:00Z"),
    user: {
      id: USER_ID,
      email: "fixture@example.test",
      displayName: null,
      status: "ACTIVE",
      disabledAt: null,
      emailVerifiedAt: new Date("2026-10-12T10:00:00Z"),
      emailVerified: true,
      passwordChangedAt: new Date("2026-10-12T09:00:00Z"),
      credentialVersion: 1n,
      nativeRegistrationCompletedAt: new Date("2026-10-12T10:01:00Z"),
      betterAuthAccounts: [{ id: "00000000-0000-4000-8000-000000000003" }],
    },
  };
}

describe("StockWise native session eligibility", () => {
  let server: RunningApiServer | undefined;
  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  async function start({
    state = fixture(),
    nativeMissing = false,
    databaseMissing = false,
    failure = false,
    databaseFailure = false,
    gated = false,
    secureCookie = false,
  }: {
    state?: NativeAuthoritySession;
    nativeMissing?: boolean;
    databaseMissing?: boolean;
    failure?: boolean;
    databaseFailure?: boolean;
    gated?: boolean;
    secureCookie?: boolean;
  } = {}) {
    const native: BetterAuthNativeSessionReader = {
      api: {
        async getSession() {
          if (failure) throw new Error("synthetic secret database detail");
          return nativeMissing
            ? null
            : {
                session: {
                  id: SESSION_ID,
                  userId: USER_ID,
                  token: "synthetic-token",
                },
                user: { id: USER_ID },
              };
        },
      },
    };
    const dependencies = {
      native,
      repository: {
        async findSession() {
          if (databaseFailure)
            throw new Error("synthetic secret database detail");
          return databaseMissing ? null : state;
        },
      },
      configuration: { ...configuration, secureCookie },
      publicWebOrigin: ORIGIN,
      now: () => NOW,
    };
    const router = Router();
    router.all(
      "/protected",
      gated
        ? createBetterAuthAuthenticationMiddleware(dependencies, false)
        : createSessionAuthenticationMiddleware(
            createBetterAuthSessionResolver(dependencies),
          ),
      (_request, response) => {
        const context = getTrustedAuthenticationContext(response);
        response.json({ actor: context?.actor });
      },
    );
    const entries: unknown[] = [];
    server = await startApiServer(
      createApp({
        apiRouter: router,
        logger: {
          info(bindings) {
            entries.push(bindings);
          },
          error(bindings) {
            entries.push(bindings);
          },
        },
      }),
      { host: "127.0.0.1", port: 0 },
    );
    return {
      url: `http://127.0.0.1:${server.address.port}/api/v1/protected`,
      entries,
    };
  }

  it("uses fresh StockWise actor data and never grants forged tenant or role authority", async () => {
    const { url } = await start();
    const response = await fetch(url, {
      headers: {
        cookie: COOKIE,
        "x-role": "OWNER",
        "x-user-id": "attacker",
        "x-organization-id": "forged",
      },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      actor: {
        id: USER_ID,
        email: "fixture@example.test",
        displayName: null,
        status: "ACTIVE",
        verified: true,
      },
    });
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  const rejections: [string, (state: NativeAuthoritySession) => void][] = [
    [
      "registration-only session after password commit",
      (s) => {
        s.stockwisePurpose = "REGISTRATION";
      },
    ],
    [
      "unmarked native session",
      (s) => {
        s.stockwisePurpose = null;
      },
    ],
    [
      "incomplete registration after password commit",
      (s) => {
        s.user.nativeRegistrationCompletedAt = null;
      },
    ],
    [
      "session issued before durable completion",
      (s) => {
        s.user.nativeRegistrationCompletedAt = NOW;
      },
    ],
    [
      "fresh disabled user",
      (s) => {
        s.user.status = "DISABLED";
      },
    ],
    [
      "legacy verification missing",
      (s) => {
        s.user.emailVerifiedAt = null;
      },
    ],
    [
      "native verification missing",
      (s) => {
        s.user.emailVerified = false;
      },
    ],
    [
      "missing credential account",
      (s) => {
        s.user.betterAuthAccounts = [];
      },
    ],
    [
      "password reset after issue",
      (s) => {
        s.user.passwordChangedAt = NOW;
      },
    ],
    [
      "same-millisecond password reset advances credential version",
      (s) => {
        s.user.passwordChangedAt = s.createdAt;
        s.user.credentialVersion = 2n;
      },
    ],
    [
      "unbound native credential version",
      (s) => {
        s.stockwiseCredentialVersion = null;
      },
    ],
    [
      "expired session at boundary",
      (s) => {
        s.expiresAt = NOW;
      },
    ],
    [
      "absolute expiry despite extended native expiry",
      (s) => {
        s.createdAt = new Date(
          NOW.getTime() - configuration.absoluteTimeoutMilliseconds,
        );
        s.user.nativeRegistrationCompletedAt = s.createdAt;
        s.user.passwordChangedAt = s.createdAt;
      },
    ],
    [
      "idle expiry despite extended native expiry",
      (s) => {
        s.createdAt = new Date("2026-10-10T12:00:00Z");
        s.updatedAt = new Date(
          NOW.getTime() - configuration.idleTimeoutMilliseconds,
        );
        s.user.nativeRegistrationCompletedAt = s.createdAt;
        s.user.passwordChangedAt = s.createdAt;
      },
    ],
    [
      "future session issue",
      (s) => {
        s.createdAt = new Date(NOW.getTime() + 1);
      },
    ],
    [
      "future activity",
      (s) => {
        s.updatedAt = new Date(NOW.getTime() + 1);
      },
    ],
    [
      "native user does not own database session",
      (s) => {
        s.userId = SESSION_ID;
      },
    ],
  ];
  it.each(rejections)(
    "rejects %s without browser credentials",
    async (_name, mutate) => {
      const state = fixture();
      mutate(state);
      const { url } = await start({ state });
      const response = await fetch(url, { headers: { cookie: COOKIE } });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({
        error: { code: "AUTHENTICATION_REQUIRED" },
      });
      expect(response.headers.getSetCookie()).toEqual([]);
    },
  );

  it.each([
    undefined,
    "stockwise_session=legacy-token",
    `${COOKIE}; ${COOKIE}`,
    `${BETTER_AUTH_NATIVE_COOKIE_NAME}=`,
  ])(
    "rejects missing, legacy, duplicate or empty cookie %s",
    async (cookie) => {
      const { url } = await start();
      const response = await fetch(url, {
        headers: cookie === undefined ? {} : { cookie },
      });
      expect(response.status).toBe(401);
    },
  );

  it.each([
    {},
    { origin: "https://attacker.example" },
    { origin: ORIGIN, "sec-fetch-site": "cross-site" },
  ])("rejects cross-site mutation %j", async (headers) => {
    const { url } = await start();
    const response = await fetch(url, {
      method: "POST",
      headers: { cookie: COOKIE, ...headers },
    });
    expect(response.status).toBe(401);
  });

  it("accepts isolated same-origin mutation only after the same fresh eligibility check", async () => {
    const state = fixture();
    const { url } = await start({ state });
    expect(
      (
        await fetch(url, {
          method: "POST",
          headers: { cookie: COOKIE, origin: ORIGIN },
        })
      ).status,
    ).toBe(200);
    state.user.status = "DISABLED";
    expect(
      (
        await fetch(url, {
          method: "POST",
          headers: { cookie: COOKIE, origin: ORIGIN },
        })
      ).status,
    ).toBe(401);
  });

  it.each([{ nativeMissing: true }, { databaseMissing: true }])(
    "rejects a revoked or unrecognized session %j",
    async (options) => {
      const { url } = await start(options);
      expect((await fetch(url, { headers: { cookie: COOKIE } })).status).toBe(
        401,
      );
    },
  );

  it("recognizes the production secure cookie without accepting the insecure name", async () => {
    const { url } = await start({ secureCookie: true });
    expect((await fetch(url, { headers: { cookie: COOKIE } })).status).toBe(
      401,
    );
    expect(
      (await fetch(url, { headers: { cookie: `__Secure-${COOKIE}` } })).status,
    ).toBe(200);
  });

  it.each([{ failure: true }, { databaseFailure: true }])(
    "fails closed without leaking dependency details into response or logs: %j",
    async (options) => {
      const { url, entries } = await start(options);
      const response = await fetch(url, { headers: { cookie: COOKIE } });
      expect(response.status).toBe(500);
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(await response.text()).not.toContain(
        "synthetic secret database detail",
      );
      expect(JSON.stringify(entries)).not.toContain(
        "synthetic secret database detail",
      );
    },
  );

  it("the disabled gate rejects even an otherwise eligible native application session", async () => {
    const { url } = await start({ gated: true });
    const response = await fetch(url, { headers: { cookie: COOKIE } });
    expect(response.status).toBe(401);
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});
