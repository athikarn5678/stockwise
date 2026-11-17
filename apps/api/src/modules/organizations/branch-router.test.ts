import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../../app.ts";
import type { ApiLogger } from "../../logger.ts";
import { startApiServer, type RunningApiServer } from "../../server.ts";
import { createSessionAuthenticationMiddleware } from "../identity/authentication-context.ts";
import type { SafeBranch } from "./branch-repository.ts";
import { createBranchRouter } from "./branch-router.ts";
import type { BranchService } from "./branch-service.ts";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const BRANCH_ID = "20000000-0000-4000-8000-000000000001";
const TOKEN = "A".repeat(43);
const TEST_COOKIE_NAME = "stockwise_test_session";
const branch: SafeBranch = {
  address: null,
  code: "MAIN",
  id: BRANCH_ID,
  name: "Main",
  organizationId: ORGANIZATION_ID,
  phone: null,
  status: "ACTIVE",
  updatedAt: "2026-08-24T12:00:00.000Z",
};
const logger: ApiLogger = { error() {}, info() {} };

describe("branch router", () => {
  let server: RunningApiServer | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  async function start(overrides: Partial<BranchService> = {}) {
    const authenticationMiddleware = createSessionAuthenticationMiddleware(
      async (request) =>
        request.headers.cookie === `${TEST_COOKIE_NAME}=${TOKEN}`
          ? {
              actor: {
                displayName: "Owner",
                email: "owner@example.com",
                id: "trusted-user-id",
              },
              sessionId: "session-id",
            }
          : null,
    );
    const service: BranchService = {
      accessContext: vi.fn().mockResolvedValue({
        firstOrganizationOnboarding: { eligible: true },
        organizations: [],
        user: {
          displayName: "Owner",
          email: "owner@example.com",
          id: "trusted-user-id",
        },
      }),
      create: vi.fn().mockResolvedValue({ kind: "success", branch }),
      list: vi.fn().mockResolvedValue({ kind: "success", branches: [branch] }),
      setLifecycle: vi.fn().mockResolvedValue({ kind: "success", branch }),
      update: vi.fn().mockResolvedValue({ kind: "success", branch }),
      ...overrides,
    };
    const router = createBranchRouter({
      authenticationMiddleware,
      branchService: service,
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
        cookie: `${TEST_COOKIE_NAME}=${TOKEN}`,
        ...(init.body === undefined
          ? {}
          : { "content-type": "application/json" }),
        ...init.headers,
      },
    });
  }

  it("returns the safe trusted access context", async () => {
    const { service, url } = await start();
    const response = await request(`${url}/me/access-context`);
    expect(response.status).toBe(200);
    expect(service.accessContext).toHaveBeenCalledWith("trusted-user-id");
    const body = await response.json();
    expect(body).toMatchObject({
      data: { firstOrganizationOnboarding: { eligible: true } },
    });
    expect(JSON.stringify(body)).not.toContain("session-id");
  });

  it("canonicalizes creation, ignores forged headers, and returns 201", async () => {
    const { service, url } = await start();
    const response = await request(
      `${url}/organizations/${ORGANIZATION_ID}/branches`,
      {
        body: JSON.stringify({
          address: " ",
          code: "  bkk-1 ",
          name: " Main  Store ",
          phone: " ",
        }),
        headers: { "x-role": "OWNER", "x-user-id": "forged" },
        method: "POST",
      },
    );
    expect(response.status).toBe(201);
    expect(service.create).toHaveBeenCalledWith(
      "trusted-user-id",
      ORGANIZATION_ID,
      {
        address: null,
        code: "BKK-1",
        name: "Main  Store",
        phone: null,
      },
    );
  });

  it("rejects cross-site writes before the service", async () => {
    const { service, url } = await start();
    const response = await request(
      `${url}/organizations/${ORGANIZATION_ID}/branches`,
      {
        body: JSON.stringify({ code: "B", name: "B" }),
        headers: {
          origin: "https://attacker.example",
          "sec-fetch-site": "cross-site",
        },
        method: "POST",
      },
    );
    expect(response.status).toBe(403);
    expect(service.create).not.toHaveBeenCalled();
  });

  it("rejects attempts to mutate immutable branch identity", async () => {
    const { service, url } = await start();
    const response = await request(
      `${url}/organizations/${ORGANIZATION_ID}/branches/${BRANCH_ID}`,
      {
        body: JSON.stringify({
          code: "NEW",
          expectedUpdatedAt: branch.updatedAt,
          name: "New",
        }),
        method: "PATCH",
      },
    );
    expect(response.status).toBe(400);
    expect(service.update).not.toHaveBeenCalled();
  });

  it.each([
    ["stale", "BRANCH_STALE"],
    ["code_conflict", "BRANCH_CODE_CONFLICT"],
    ["last_active_branch", "LAST_ACTIVE_BRANCH"],
  ] as const)(
    "maps %s conflict to the canonical envelope",
    async (kind, code) => {
      const { url } = await start({
        create: vi.fn().mockResolvedValue({ kind }),
      });
      const response = await request(
        `${url}/organizations/${ORGANIZATION_ID}/branches`,
        {
          body: JSON.stringify({ code: "B", name: "B" }),
          method: "POST",
        },
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: { code, requestId: expect.any(String) },
      });
    },
  );
});
