import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../../app.ts";
import type { ApiLogger } from "../../logger.ts";
import { startApiServer, type RunningApiServer } from "../../server.ts";
import { createSessionAuthenticationMiddleware } from "../identity/authentication-context.ts";
import type { InventoryRepository } from "./inventory-repository.ts";
import { createInventoryRouter } from "./inventory-router.ts";
import { createInventoryService } from "./inventory-service.ts";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const BRANCH_ID = "20000000-0000-4000-8000-000000000001";
const PRODUCT_ID = "30000000-0000-4000-8000-000000000001";
const TOKEN = "A".repeat(43);
const TEST_COOKIE_NAME = "stockwise_test_session";
const logger: ApiLogger = { error() {}, info() {} };

describe("inventory router", () => {
  let server: RunningApiServer | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  async function start({
    authenticated = true,
    overrides = {},
  }: {
    authenticated?: boolean;
    overrides?: Partial<InventoryRepository>;
  } = {}) {
    const authenticationMiddleware = createSessionAuthenticationMiddleware(
      async (request) =>
        authenticated &&
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
    const repository: InventoryRepository = {
      adjust: vi.fn().mockResolvedValue({
        adjustment: {
          balance: { quantity: "2.5" },
          transaction: {
            delta: "2.5",
            id: "40000000-0000-4000-8000-000000000001",
            note: null,
            occurredAt: "2026-08-30T12:00:00.000Z",
            reason: "FOUND",
            source: "MANUAL_ADJUSTMENT",
          },
        },
        kind: "success",
      }),
      getBalance: vi.fn().mockResolvedValue({
        inventory: {
          balance: { exists: false, quantity: "0", updatedAt: null },
          product: {
            categoryId: null,
            id: PRODUCT_ID,
            name: "Coffee",
            sku: "COF",
            status: "ACTIVE",
            unit: "EA",
          },
        },
        kind: "success",
      }),
      listBalances: vi.fn().mockResolvedValue({
        inventory: [],
        kind: "success",
        nextCursor: null,
      }),
      listHistory: vi.fn().mockResolvedValue({
        kind: "success",
        nextCursor: null,
        transactions: [],
      }),
      ...overrides,
    };
    const router = createInventoryRouter({
      authenticationMiddleware,
      inventoryService: createInventoryService({ repository }),
      publicWebOrigin: "http://localhost:3000",
    });
    server = await startApiServer(createApp({ apiRouter: router, logger }), {
      host: "127.0.0.1",
      port: 0,
    });
    return {
      repository,
      url: `http://${server.address.host}:${server.address.port}/api/v1`,
    };
  }

  function request(url: string) {
    return fetch(url, {
      headers: { cookie: `${TEST_COOKIE_NAME}=${TOKEN}` },
    });
  }

  function adjustmentRequest(
    url: string,
    input: {
      body?: unknown;
      headers?: Record<string, string>;
    } = {},
  ) {
    return fetch(url, {
      body: JSON.stringify(
        input.body ?? {
          delta: "2.5000",
          note: "   ",
          productId: PRODUCT_ID,
          reason: "FOUND",
        },
      ),
      headers: {
        "content-type": "application/json",
        cookie: `${TEST_COOKIE_NAME}=${TOKEN}`,
        "idempotency-key": "adjustment-key",
        ...input.headers,
      },
      method: "POST",
    });
  }

  it("protects and validates the adjustment command before using trusted actor state", async () => {
    const { repository, url } = await start();
    const endpoint = `${url}/organizations/${ORGANIZATION_ID}/branches/${BRANCH_ID}/inventory/adjustments`;
    const response = await adjustmentRequest(endpoint);
    expect(response.status).toBe(201);
    expect(repository.adjust).toHaveBeenCalledWith({
      actorUserId: "trusted-user-id",
      adjustment: {
        delta: "2.5000",
        note: null,
        productId: PRODUCT_ID,
        reason: "FOUND",
      },
      branchId: BRANCH_ID,
      idempotencyKey: "adjustment-key",
      organizationId: ORGANIZATION_ID,
    });
    expect(await response.json()).toMatchObject({
      data: {
        balance: { quantity: "2.5" },
        transaction: { delta: "2.5", source: "MANUAL_ADJUSTMENT" },
      },
      meta: { requestId: expect.any(String) },
    });

    const crossSite = await adjustmentRequest(endpoint, {
      headers: { "Sec-Fetch-Site": "cross-site" },
    });
    expect(crossSite.status).toBe(403);
    expect(repository.adjust).toHaveBeenCalledTimes(1);
  });

  it("requires authentication and an idempotency key for adjustment", async () => {
    const unauthenticated = await start({ authenticated: false });
    const endpoint = `${unauthenticated.url}/organizations/${ORGANIZATION_ID}/branches/${BRANCH_ID}/inventory/adjustments`;
    const unauthorized = await adjustmentRequest(endpoint);
    expect(unauthorized.status).toBe(401);
    expect(unauthenticated.repository.adjust).not.toHaveBeenCalled();
    await server?.stop();
    server = undefined;

    const authenticated = await start();
    const missingKey = await fetch(
      `${authenticated.url}/organizations/${ORGANIZATION_ID}/branches/${BRANCH_ID}/inventory/adjustments`,
      {
        body: JSON.stringify({
          delta: "1",
          productId: PRODUCT_ID,
          reason: "FOUND",
        }),
        headers: {
          "content-type": "application/json",
          cookie: `${TEST_COOKIE_NAME}=${TOKEN}`,
        },
        method: "POST",
      },
    );
    expect(missingKey.status).toBe(400);
    expect(authenticated.repository.adjust).not.toHaveBeenCalled();
  });

  it.each([
    [{ delta: "0", productId: PRODUCT_ID, reason: "FOUND" }, {}],
    [{ delta: "1.00000", productId: PRODUCT_ID, reason: "FOUND" }, {}],
    [{ delta: "wat", productId: PRODUCT_ID, reason: "FOUND" }, {}],
    [{ delta: "1", productId: PRODUCT_ID, reason: "OTHER" }, {}],
    [
      { delta: "1", productId: PRODUCT_ID, reason: "FOUND" },
      { "idempotency-key": "contains space" },
    ],
  ])("rejects an invalid adjustment request", async (body, headers) => {
    const { repository, url } = await start();
    const response = await adjustmentRequest(
      `${url}/organizations/${ORGANIZATION_ID}/branches/${BRANCH_ID}/inventory/adjustments`,
      { body, headers },
    );
    expect(response.status).toBe(400);
    expect(repository.adjust).not.toHaveBeenCalled();
  });

  it.each([
    ["replay", 200, null],
    ["forbidden", 403, "FORBIDDEN"],
    ["not_found", 404, "PRODUCT_NOT_FOUND"],
    ["branch_inactive", 409, "BRANCH_INACTIVE"],
    ["product_inactive", 409, "PRODUCT_INACTIVE"],
    ["invalid_quantity", 400, "VALIDATION_ERROR"],
    ["insufficient_stock", 409, "INSUFFICIENT_STOCK"],
    ["idempotency_conflict", 409, "IDEMPOTENCY_CONFLICT"],
  ] as const)("maps adjustment %s safely", async (kind, status, code) => {
    const replay = {
      adjustment: {
        balance: { quantity: "2.5" },
        transaction: {
          delta: "2.5",
          id: "40000000-0000-4000-8000-000000000001",
          note: null,
          occurredAt: "2026-08-30T12:00:00.000Z",
          reason: "FOUND",
          source: "MANUAL_ADJUSTMENT",
        },
      },
      kind: "replay" as const,
    };
    const { url } = await start({
      overrides: {
        adjust: vi
          .fn()
          .mockResolvedValue(kind === "replay" ? replay : { kind }),
      },
    });
    const response = await adjustmentRequest(
      `${url}/organizations/${ORGANIZATION_ID}/branches/${BRANCH_ID}/inventory/adjustments`,
    );
    expect(response.status).toBe(status);
    const body = JSON.stringify(await response.json());
    if (code !== null) expect(body).toContain(code);
    expect(body).not.toMatch(/Prisma|SQL|constraint|idempotencyKeyHash/i);
  });

  it("uses only the trusted actor and validated branch scope", async () => {
    const { repository, url } = await start();
    const response = await request(
      `${url}/organizations/${ORGANIZATION_ID}/branches/${BRANCH_ID}/inventory?status=ALL`,
    );
    expect(response.status).toBe(200);
    expect(repository.listBalances).toHaveBeenCalledWith({
      actorUserId: "trusted-user-id",
      branchId: BRANCH_ID,
      organizationId: ORGANIZATION_ID,
      query: { limit: 25, status: "ALL" },
    });
    expect(await response.json()).toMatchObject({
      data: [],
      meta: { nextCursor: null, requestId: expect.any(String) },
    });
  });

  it("rejects unauthenticated and invalid history requests before the repository", async () => {
    const unauthenticated = await start({ authenticated: false });
    const unauthorized = await request(
      `${unauthenticated.url}/organizations/${ORGANIZATION_ID}/branches/${BRANCH_ID}/inventory/${PRODUCT_ID}`,
    );
    expect(unauthorized.status).toBe(401);
    expect(unauthenticated.repository.getBalance).not.toHaveBeenCalled();
    await server?.stop();
    server = undefined;

    const invalid = await start();
    const response = await request(
      `${invalid.url}/organizations/${ORGANIZATION_ID}/branches/${BRANCH_ID}/inventory/${PRODUCT_ID}/transactions?occurredAfter=invalid`,
    );
    expect(response.status).toBe(400);
    expect(invalid.repository.listHistory).not.toHaveBeenCalled();
  });

  it.each([
    ["forbidden", 403, "FORBIDDEN"],
    ["not_found", 404, "PRODUCT_NOT_FOUND"],
    ["invalid_cursor", 400, "INVALID_CURSOR"],
  ] as const)("maps history %s safely", async (kind, status, code) => {
    const { url } = await start({
      overrides: { listHistory: vi.fn().mockResolvedValue({ kind }) },
    });
    const response = await request(
      `${url}/organizations/${ORGANIZATION_ID}/branches/${BRANCH_ID}/inventory/${PRODUCT_ID}/transactions`,
    );
    expect(response.status).toBe(status);
    const body = JSON.stringify(await response.json());
    expect(body).toContain(code);
    expect(body).not.toMatch(/Prisma|SQL|constraint/i);
  });
});
