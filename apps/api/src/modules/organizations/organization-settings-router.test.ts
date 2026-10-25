import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../../app.ts";
import type { ApiLogger } from "../../logger.ts";
import { startApiServer, type RunningApiServer } from "../../server.ts";
import type { AuthenticationSessionRepository } from "../identity/authentication-repository.ts";
import { createAuthenticationMiddleware } from "../identity/authentication-context.ts";
import type { SessionConfiguration } from "../identity/session-configuration.ts";
import { SESSION_COOKIE_NAME } from "../identity/session-cookie.ts";
import { createOrganizationSettingsRouter } from "./organization-settings-router.ts";
import type { OrganizationSettingsService } from "./organization-settings-service.ts";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const TOKEN = "A".repeat(43);
const timestamp = "2026-10-25T12:00:00.000Z";
const organization = {
  id: ORGANIZATION_ID,
  name: "Store",
  updatedAt: timestamp,
};
const logger: ApiLogger = { error() {}, info() {} };
const configuration: SessionConfiguration = {
  absoluteTimeoutMilliseconds: 604_800_000,
  idleTimeoutMilliseconds: 86_400_000,
  secureCookie: false,
  touchIntervalMilliseconds: 900_000,
};

describe("organization settings router", () => {
  let server: RunningApiServer | undefined;
  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  async function start(overrides: Partial<OrganizationSettingsService> = {}) {
    const authentication: AuthenticationSessionRepository = {
      resolveSession: vi.fn().mockResolvedValue({
        actor: {
          displayName: "Owner",
          email: "owner@example.com",
          id: "trusted-user-id",
        },
        sessionId: "session-id",
      }),
    };
    const service: OrganizationSettingsService = {
      get: vi.fn().mockResolvedValue({ kind: "success", organization }),
      update: vi.fn().mockResolvedValue({
        kind: "success",
        organization: {
          ...organization,
          name: "Renamed",
          updatedAt: "2026-10-25T12:00:00.001Z",
        },
      }),
      ...overrides,
    };
    const router = createOrganizationSettingsRouter({
      authenticationMiddleware: createAuthenticationMiddleware({
        configuration,
        repository: authentication,
      }),
      organizationSettingsService: service,
      publicWebOrigin: "http://localhost:3000",
    });
    server = await startApiServer(createApp({ apiRouter: router, logger }), {
      host: "127.0.0.1",
      port: 0,
    });
    return {
      service,
      url: `http://${server.address.host}:${server.address.port}/api/v1`,
    };
  }

  function request(path: string, init: RequestInit = {}) {
    return fetch(path, {
      ...init,
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${TOKEN}`,
        ...(init.body === undefined
          ? {}
          : { "content-type": "application/json" }),
        ...init.headers,
      },
    });
  }

  it("returns only canonical organization fields and forwards trusted identity", async () => {
    const { service, url } = await start();
    const response = await request(`${url}/organizations/${ORGANIZATION_ID}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(service.get).toHaveBeenCalledWith(
      "trusted-user-id",
      ORGANIZATION_ID,
    );
  });

  it("trims the name, preserves inner whitespace and Unicode, and requires CSRF protection", async () => {
    const { service, url } = await start();
    const response = await request(`${url}/organizations/${ORGANIZATION_ID}`, {
      method: "PATCH",
      body: JSON.stringify({
        expectedUpdatedAt: timestamp,
        name: "  店  Café 🏪  ",
      }),
      headers: { "x-user-id": "forged", "x-role": "OWNER" },
    });
    expect(response.status).toBe(200);
    expect(service.update).toHaveBeenCalledWith(
      "trusted-user-id",
      ORGANIZATION_ID,
      { expectedUpdatedAt: new Date(timestamp), name: "店  Café 🏪" },
    );
    const csrf = await request(`${url}/organizations/${ORGANIZATION_ID}`, {
      method: "PATCH",
      body: JSON.stringify({ expectedUpdatedAt: timestamp, name: "Changed" }),
      headers: {
        origin: "https://attacker.example",
        "sec-fetch-site": "cross-site",
      },
    });
    expect(csrf.status).toBe(403);
    expect(service.update).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "unknown fields",
      {
        expectedUpdatedAt: timestamp,
        name: "Changed",
        salesVatStatus: "REGISTERED",
      },
    ],
    ["blank names", { expectedUpdatedAt: timestamp, name: "   " }],
    ["long names", { expectedUpdatedAt: timestamp, name: "x".repeat(201) }],
    [
      "invalid timestamps",
      { expectedUpdatedAt: "2026-02-30T12:00:00.000Z", name: "Changed" },
    ],
  ])("rejects %s without calling the service", async (_case, body) => {
    const { service, url } = await start();
    const response = await request(`${url}/organizations/${ORGANIZATION_ID}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(400);
    expect(service.update).not.toHaveBeenCalled();
  });

  it("counts organization name limits as PostgreSQL Unicode characters", async () => {
    const { service, url } = await start();
    const valid = await request(`${url}/organizations/${ORGANIZATION_ID}`, {
      method: "PATCH",
      body: JSON.stringify({
        expectedUpdatedAt: timestamp,
        name: "🏪".repeat(200),
      }),
    });
    expect(valid.status).toBe(200);
    const invalid = await request(`${url}/organizations/${ORGANIZATION_ID}`, {
      method: "PATCH",
      body: JSON.stringify({
        expectedUpdatedAt: timestamp,
        name: "🏪".repeat(201),
      }),
    });
    expect(invalid.status).toBe(400);
    expect(service.update).toHaveBeenCalledTimes(1);
  });

  it("rejects unknown query parameters and maps stale updates", async () => {
    const { service, url } = await start({
      update: vi.fn().mockResolvedValue({ kind: "stale" }),
    });
    expect(
      (
        await request(
          `${url}/organizations/${ORGANIZATION_ID}?includeInactive=true`,
        )
      ).status,
    ).toBe(400);
    const response = await request(`${url}/organizations/${ORGANIZATION_ID}`, {
      method: "PATCH",
      body: JSON.stringify({ expectedUpdatedAt: timestamp, name: "Changed" }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "ORGANIZATION_STALE" },
    });
    expect(service.update).toHaveBeenCalledTimes(1);
  });

  it("keeps private cache policy for Express-matched path variants", async () => {
    const paths = [
      `/organizations/${ORGANIZATION_ID}`,
      `/organizations/${ORGANIZATION_ID}/`,
      `/Organizations/${ORGANIZATION_ID}`,
      `/Organizations/${ORGANIZATION_ID}/`,
    ];
    const { service, url } = await start();
    for (const path of paths) {
      const response = await request(`${url}${path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({
        data: organization,
        meta: { requestId: response.headers.get("x-request-id") },
      });
    }
    for (const path of paths) {
      const response = await request(`${url}${path}`, {
        headers: { cookie: "" },
      });
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toMatchObject({
        error: {
          code: "AUTHENTICATION_REQUIRED",
          requestId: response.headers.get("x-request-id"),
        },
      });
    }
    const primaryServer = server;
    const forbidden = await start({
      get: vi.fn().mockResolvedValue({ kind: "forbidden" }),
    });
    const forbiddenServer = server;
    const forbiddenResponse = await request(
      `${forbidden.url}/Organizations/${ORGANIZATION_ID}/`,
    );
    expect(forbiddenResponse.status).toBe(403);
    expect(forbiddenResponse.headers.get("cache-control")).toBe("no-store");
    expect(await forbiddenResponse.json()).toEqual({
      error: {
        code: "FORBIDDEN",
        message: "The operation is not permitted.",
        requestId: forbiddenResponse.headers.get("x-request-id"),
      },
    });
    await forbiddenServer?.stop();
    server = primaryServer;

    const patchPaths = [
      `/organizations/${ORGANIZATION_ID}`,
      `/organizations/${ORGANIZATION_ID}/`,
      `/Organizations/${ORGANIZATION_ID}`,
      `/Organizations/${ORGANIZATION_ID}/`,
    ];
    const body = JSON.stringify({
      expectedUpdatedAt: timestamp,
      name: "Changed",
    });
    for (const path of patchPaths) {
      const response = await request(`${url}${path}`, {
        method: "PATCH",
        body,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({
        data: {
          ...organization,
          name: "Renamed",
          updatedAt: "2026-10-25T12:00:00.001Z",
        },
        meta: { requestId: response.headers.get("x-request-id") },
      });
    }
    for (const path of patchPaths) {
      for (const authenticated of [false, true]) {
        const response = await request(`${url}${path}`, {
          method: "PATCH",
          body,
          headers: authenticated
            ? {
                origin: "https://attacker.example",
                "sec-fetch-site": "cross-site",
              }
            : { cookie: "", origin: "http://localhost:3000" },
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
