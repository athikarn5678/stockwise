import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../../app.ts";
import type { ApiLogger } from "../../logger.ts";
import { startApiServer, type RunningApiServer } from "../../server.ts";
import { createAuthenticationMiddleware } from "./authentication-context.ts";
import type { AuthenticationSessionRepository } from "./authentication-repository.ts";
import { createSelfProfileRouter } from "./profile-router.ts";
import type { SelfProfile } from "./profile-repository.ts";
import type { SelfProfileService } from "./profile-service.ts";
import type { SessionConfiguration } from "./session-configuration.ts";
import { SESSION_COOKIE_NAME } from "./session-cookie.ts";

const configuration: SessionConfiguration = {
  absoluteTimeoutMilliseconds: 7 * 24 * 60 * 60 * 1000,
  idleTimeoutMilliseconds: 24 * 60 * 60 * 1000,
  secureCookie: false,
  touchIntervalMilliseconds: 15 * 60 * 1000,
};
const logger: ApiLogger = { error() {}, info() {} };
const TOKEN = "A".repeat(43);
const profile: SelfProfile = {
  displayName: "Owner",
  email: "owner@example.com",
  id: "trusted-user-id",
  phone: null,
  updatedAt: "2026-10-25T12:00:00.000Z",
};

describe("self-profile router", () => {
  let server: RunningApiServer | undefined;
  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  async function start(serviceOverrides: Partial<SelfProfileService> = {}) {
    const repository: AuthenticationSessionRepository = {
      resolveSession: vi.fn().mockResolvedValue({
        actor: {
          displayName: null,
          email: "owner@example.com",
          id: "trusted-user-id",
        },
        sessionId: "session-id",
      }),
    };
    const service: SelfProfileService = {
      get: vi.fn().mockResolvedValue(profile),
      update: vi.fn().mockResolvedValue({ kind: "updated", profile }),
      ...serviceOverrides,
    };
    server = await startApiServer(
      createApp({
        apiRouter: createSelfProfileRouter({
          authenticationMiddleware: createAuthenticationMiddleware({
            configuration,
            repository,
          }),
          profileService: service,
          publicWebOrigin: "http://localhost:3000",
        }),
        logger,
      }),
      { host: "127.0.0.1", port: 0 },
    );
    const base = `http://${server.address.host}:${server.address.port}/api/v1`;
    return { base, service };
  }

  it("returns only the trusted actor profile, including membership-less actors", async () => {
    const { base, service } = await start();
    const response = await fetch(`${base}/me`, {
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${TOKEN}`,
        "x-user-id": "forged",
      },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const responseText = await response.text();
    expect(JSON.parse(responseText)).toEqual({
      data: profile,
      meta: { requestId: response.headers.get("x-request-id") },
    });
    expect(service.get).toHaveBeenCalledWith("trusted-user-id");
    expect(responseText).not.toContain("session-id");
  });

  it("rejects anonymous PATCH, unexpected queries, and invalid or forged fields", async () => {
    const { base, service } = await start();
    const url = `${base}/me/profile`;
    const valid = { displayName: "Name", expectedUpdatedAt: profile.updatedAt };
    expect(
      (
        await fetch(url, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(valid),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${url}?userId=someone`, {
          method: "PATCH",
          headers: {
            cookie: `${SESSION_COOKIE_NAME}=${TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(valid),
        })
      ).status,
    ).toBe(400);
    for (const body of [
      { ...valid, displayName: "   " },
      { ...valid, displayName: "x".repeat(201) },
      { ...valid, phone: "x".repeat(33) },
      { ...valid, expectedUpdatedAt: "2026-02-30T12:00:00.000Z" },
      { ...valid, expectedUpdatedAt: "2026-10-25T12:00:00Z" },
      ...[
        "email",
        "userId",
        "organizationId",
        "status",
        "passwordHash",
        "credentialVersion",
        "role",
      ].map((field) => ({ ...valid, [field]: "forged" })),
    ]) {
      expect(
        (
          await fetch(url, {
            method: "PATCH",
            headers: {
              cookie: `${SESSION_COOKIE_NAME}=${TOKEN}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(body),
          })
        ).status,
      ).toBe(400);
    }
    expect(service.update).not.toHaveBeenCalled();
  });

  it("returns a safe error when profile persistence fails", async () => {
    const { base } = await start({
      update: vi.fn().mockRejectedValue(new Error("database-secret-detail")),
    });
    const response = await fetch(`${base}/me/profile`, {
      method: "PATCH",
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        displayName: "Name",
        expectedUpdatedAt: profile.updatedAt,
      }),
    });
    const responseText = await response.text();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.status).toBe(500);
    expect(responseText).toContain("INTERNAL_ERROR");
    expect(responseText).not.toContain("database-secret-detail");
  });

  it("origin-protects mutation and maps stale profile versions to 409", async () => {
    const { base, service } = await start({
      update: vi.fn().mockResolvedValue({ kind: "stale" }),
    });
    const body = {
      displayName: "  New Name  ",
      expectedUpdatedAt: profile.updatedAt,
    };
    const crossSite = await fetch(`${base}/me/profile`, {
      method: "PATCH",
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${TOKEN}`,
        "content-type": "application/json",
        origin: "https://attacker.example",
      },
      body: JSON.stringify(body),
    });
    expect(crossSite.status).toBe(403);
    const response = await fetch(`${base}/me/profile`, {
      method: "PATCH",
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${TOKEN}`,
        "content-type": "application/json",
        origin: "http://localhost:3000",
      },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "PROFILE_STALE" },
    });
    expect(service.update).toHaveBeenCalledWith("trusted-user-id", {
      displayName: "New Name",
      expectedUpdatedAt: profile.updatedAt,
    });
  });

  it("keeps private cache policy for Express-matched path variants", async () => {
    const { base, service } = await start();
    const getPaths = ["/me", "/me/", "/Me", "/ME"];
    for (const path of getPaths) {
      const response = await fetch(`${base}${path}`, {
        headers: { cookie: `${SESSION_COOKIE_NAME}=${TOKEN}` },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({
        data: profile,
        meta: { requestId: response.headers.get("x-request-id") },
      });
    }
    for (const path of getPaths) {
      const response = await fetch(`${base}${path}`);
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({
        error: {
          code: "AUTHENTICATION_REQUIRED",
          message: "Authentication is required.",
          requestId: response.headers.get("x-request-id"),
        },
      });
    }

    const patchPaths = [
      "/me/profile",
      "/me/profile/",
      "/Me/Profile",
      "/ME/PROFILE",
    ];
    const body = JSON.stringify({
      displayName: "Updated",
      expectedUpdatedAt: profile.updatedAt,
    });
    for (const path of patchPaths) {
      const response = await fetch(`${base}${path}`, {
        method: "PATCH",
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=${TOKEN}`,
          "content-type": "application/json",
        },
        body,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({
        data: profile,
        meta: { requestId: response.headers.get("x-request-id") },
      });
    }
    for (const path of patchPaths) {
      for (const authenticated of [false, true]) {
        const headers: Record<string, string> = {
          "content-type": "application/json",
        };
        if (authenticated) {
          headers.cookie = `${SESSION_COOKIE_NAME}=${TOKEN}`;
          headers.origin = "https://attacker.example";
        }
        const response = await fetch(`${base}${path}`, {
          method: "PATCH",
          headers,
          body,
        });
        expect(response.status).toBe(authenticated ? 403 : 401);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(await response.json()).toMatchObject({
          error: {
            code: authenticated ? "FORBIDDEN" : "AUTHENTICATION_REQUIRED",
            requestId: response.headers.get("x-request-id"),
          },
        });
      }
    }
    expect(service.update).toHaveBeenCalledTimes(patchPaths.length);
    const publicResponse = await fetch(
      `http://${server!.address.host}:${server!.address.port}/health`,
    );
    expect(publicResponse.status).toBe(200);
    expect(publicResponse.headers.get("cache-control")).not.toBe("no-store");
  });
});
