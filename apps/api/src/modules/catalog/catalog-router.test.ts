import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../../app.ts";
import type { ApiLogger } from "../../logger.ts";
import { startApiServer, type RunningApiServer } from "../../server.ts";
import { createSessionAuthenticationMiddleware } from "../identity/authentication-context.ts";
import type {
  CatalogRepository,
  SafeCategory,
  SafeProduct,
} from "./catalog-repository.ts";
import { createCatalogRouter } from "./catalog-router.ts";
import { createCatalogService } from "./catalog-service.ts";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const CATEGORY_ID = "20000000-0000-4000-8000-000000000001";
const PRODUCT_ID = "30000000-0000-4000-8000-000000000001";
const BRANCH_ID = "40000000-0000-4000-8000-000000000001";
const TOKEN = "A".repeat(43);
const TEST_COOKIE_NAME = "stockwise_test_session";
const UPDATED_AT = "2026-08-25T12:00:00.000Z";
const category: SafeCategory = {
  createdAt: UPDATED_AT,
  description: null,
  id: CATEGORY_ID,
  name: "Food",
  organizationId: ORGANIZATION_ID,
  status: "ACTIVE",
  updatedAt: UPDATED_AT,
};
const product: SafeProduct = {
  barcode: null,
  basePrice: "60.0000",
  categoryId: null,
  createdAt: UPDATED_AT,
  description: null,
  id: PRODUCT_ID,
  name: "Coffee",
  organizationId: ORGANIZATION_ID,
  sku: "COF-01",
  status: "ACTIVE",
  unit: "EA",
  updatedAt: UPDATED_AT,
};
const logger: ApiLogger = { error() {}, info() {} };

describe("catalog router", () => {
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
    overrides?: Partial<CatalogRepository>;
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
    const repository: CatalogRepository = {
      createCategory: vi.fn().mockResolvedValue({ category, kind: "success" }),
      createProduct: vi.fn().mockResolvedValue({ kind: "success", product }),
      getCategory: vi.fn().mockResolvedValue({ category, kind: "success" }),
      getProduct: vi.fn().mockResolvedValue({ kind: "success", product }),
      listCategories: vi.fn().mockResolvedValue({
        categories: [category],
        kind: "success",
        nextCursor: null,
      }),
      listProducts: vi.fn().mockResolvedValue({
        kind: "success",
        nextCursor: null,
        products: [product],
      }),
      setCategoryLifecycle: vi
        .fn()
        .mockResolvedValue({ category, kind: "success" }),
      setProductLifecycle: vi
        .fn()
        .mockResolvedValue({ kind: "success", product }),
      updateCategory: vi.fn().mockResolvedValue({ category, kind: "success" }),
      updateProduct: vi.fn().mockResolvedValue({ kind: "success", product }),
      ...overrides,
    };
    const router = createCatalogRouter({
      authenticationMiddleware,
      catalogService: createCatalogService({ repository }),
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

  function request(url: string, init: RequestInit = {}) {
    return fetch(url, {
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

  it("denies unauthenticated catalog requests", async () => {
    const { repository, url } = await start({ authenticated: false });
    const response = await request(
      `${url}/organizations/${ORGANIZATION_ID}/categories`,
    );
    expect(response.status).toBe(401);
    expect(repository.listCategories).not.toHaveBeenCalled();
  });

  it("passes only the trusted actor and validated branch context", async () => {
    const { repository, url } = await start();
    const response = await request(
      `${url}/organizations/${ORGANIZATION_ID}/categories?branchId=${BRANCH_ID}`,
      {
        body: JSON.stringify({ description: " ", name: "  Food  " }),
        headers: {
          "x-membership-id": "forged",
          "x-role": "OWNER",
          "x-user-id": "forged",
        },
        method: "POST",
      },
    );
    expect(response.status).toBe(201);
    expect(repository.createCategory).toHaveBeenCalledWith({
      actorUserId: "trusted-user-id",
      branchId: BRANCH_ID,
      category: {
        description: null,
        name: { name: "Food", normalizedName: "food" },
      },
      organizationId: ORGANIZATION_ID,
    });
    expect(await response.json()).toMatchObject({
      data: { category: { id: CATEGORY_ID } },
      meta: { requestId: expect.any(String) },
    });
  });

  it("rejects immutable or client-owned catalog fields", async () => {
    const { repository, url } = await start();
    const categoryResponse = await request(
      `${url}/organizations/${ORGANIZATION_ID}/categories`,
      {
        body: JSON.stringify({ name: "Food", status: "INACTIVE" }),
        method: "POST",
      },
    );
    const productResponse = await request(
      `${url}/organizations/${ORGANIZATION_ID}/products/${PRODUCT_ID}`,
      {
        body: JSON.stringify({ expectedUpdatedAt: UPDATED_AT, unit: "KG" }),
        method: "PATCH",
      },
    );
    expect(categoryResponse.status).toBe(400);
    expect(productResponse.status).toBe(400);
    expect(repository.createCategory).not.toHaveBeenCalled();
    expect(repository.updateProduct).not.toHaveBeenCalled();
  });

  it("rejects cross-site mutations before persistence", async () => {
    const { repository, url } = await start();
    const response = await request(
      `${url}/organizations/${ORGANIZATION_ID}/products`,
      {
        body: JSON.stringify({
          basePrice: "1",
          name: "Coffee",
          sku: "COF",
          unit: "EA",
        }),
        headers: {
          origin: "https://attacker.example",
          "sec-fetch-site": "cross-site",
        },
        method: "POST",
      },
    );
    expect(response.status).toBe(403);
    expect(repository.createProduct).not.toHaveBeenCalled();
  });

  it.each([
    ["branch_context_required", 400, "BRANCH_CONTEXT_REQUIRED"],
    ["forbidden", 403, "FORBIDDEN"],
    ["category_not_found", 404, "CATEGORY_NOT_FOUND"],
    ["category_inactive", 409, "CATEGORY_INACTIVE"],
    ["sku_conflict", 409, "SKU_CONFLICT"],
    ["barcode_conflict", 409, "BARCODE_CONFLICT"],
    ["stale", 409, "PRODUCT_STALE"],
  ] as const)(
    "maps %s without leaking internals",
    async (kind, status, code) => {
      const { url } = await start({
        overrides: { createProduct: vi.fn().mockResolvedValue({ kind }) },
      });
      const response = await request(
        `${url}/organizations/${ORGANIZATION_ID}/products`,
        {
          body: JSON.stringify({
            basePrice: "60",
            name: "Coffee",
            sku: "COF",
            unit: "EA",
          }),
          method: "POST",
        },
      );
      expect(response.status).toBe(status);
      const serialized = JSON.stringify(await response.json());
      expect(serialized).toContain(code);
      expect(serialized).not.toMatch(/Prisma|P2002|SQL|constraint/i);
    },
  );

  it("returns bounded list envelopes and invalid cursor errors", async () => {
    const { url } = await start({
      overrides: {
        listCategories: vi.fn().mockResolvedValue({ kind: "invalid_cursor" }),
      },
    });
    const response = await request(
      `${url}/organizations/${ORGANIZATION_ID}/categories?cursor=opaque`,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "INVALID_CURSOR", requestId: expect.any(String) },
    });
  });
});
