import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../../app.ts";
import type { ApiLogger } from "../../logger.ts";
import { startApiServer, type RunningApiServer } from "../../server.ts";
import { createSessionAuthenticationMiddleware } from "../identity/authentication-context.ts";
import type {
  PurchaseOrderRepository,
  SafePurchaseOrder,
} from "./purchase-order-repository.ts";
import { createPurchaseOrderRouter } from "./purchase-order-router.ts";
import { createPurchaseOrderService } from "./purchase-order-service.ts";

const BRANCH_ID = "20000000-0000-4000-8000-000000000001";
const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const PRODUCT_ID = "30000000-0000-4000-8000-000000000001";
const PURCHASE_ORDER_ID = "40000000-0000-4000-8000-000000000001";
const SUPPLIER_ID = "50000000-0000-4000-8000-000000000001";
const TOKEN = "A".repeat(43);
const TEST_COOKIE_NAME = "stockwise_test_session";
const logger: ApiLogger = { error() {}, info() {} };
const purchaseOrder: SafePurchaseOrder = {
  branchId: BRANCH_ID,
  cancelledAt: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  currency: "THB",
  expectedDate: null,
  expectedTotal: "5.0000",
  id: PURCHASE_ORDER_ID,
  items: [
    {
      expectedUnitCost: "2.5000",
      id: "60000000-0000-4000-8000-000000000001",
      productId: PRODUCT_ID,
      productNameSnapshot: "Coffee",
      productSkuSnapshot: "COFFEE",
      quantity: "2",
    },
  ],
  orderDate: "2026-09-01",
  orderedAt: null,
  organizationId: ORGANIZATION_ID,
  receivedAt: null,
  reference: "PO-test",
  status: "DRAFT",
  supplierId: SUPPLIER_ID,
  updatedAt: "2026-09-01T00:00:00.000Z",
};

describe("purchase-order router", () => {
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
    overrides?: Partial<PurchaseOrderRepository>;
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
    const repository: PurchaseOrderRepository = {
      createPurchaseOrder: vi
        .fn()
        .mockResolvedValue({ kind: "success", purchaseOrder }),
      getPurchaseOrder: vi
        .fn()
        .mockResolvedValue({ kind: "success", purchaseOrder }),
      listPurchaseOrders: vi.fn().mockResolvedValue({
        kind: "success",
        nextCursor: null,
        purchaseOrders: [],
      }),
      updatePurchaseOrder: vi
        .fn()
        .mockResolvedValue({ kind: "success", purchaseOrder }),
      ...overrides,
    };
    const router = createPurchaseOrderRouter({
      authenticationMiddleware,
      publicWebOrigin: "http://localhost:3000",
      purchaseOrderService: createPurchaseOrderService({ repository }),
    });
    server = await startApiServer(createApp({ apiRouter: router, logger }), {
      host: "127.0.0.1",
      port: 0,
    });
    return {
      repository,
      url: `http://${server.address.host}:${server.address.port}/api/v1/organizations/${ORGANIZATION_ID}/branches/${BRANCH_ID}/purchase-orders`,
    };
  }

  function mutation(
    url: string,
    body: unknown,
    method: "PATCH" | "POST" = "POST",
    headers: Record<string, string> = {},
  ) {
    return fetch(url, {
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        cookie: `${TEST_COOKIE_NAME}=${TOKEN}`,
        ...headers,
      },
      method,
    });
  }

  it("passes strict, validated purchase-order creation from the trusted actor only", async () => {
    const { repository, url } = await start();
    const response = await mutation(url, {
      items: [
        { expectedUnitCost: "2.5000", productId: PRODUCT_ID, quantity: "2" },
      ],
      orderDate: "2026-09-01",
      supplierId: SUPPLIER_ID,
    });

    expect(response.status).toBe(201);
    expect(repository.createPurchaseOrder).toHaveBeenCalledWith({
      actorUserId: "trusted-user-id",
      branchId: BRANCH_ID,
      organizationId: ORGANIZATION_ID,
      purchaseOrder: {
        expectedDate: null,
        items: [
          { expectedUnitCost: "2.5000", productId: PRODUCT_ID, quantity: "2" },
        ],
        orderDate: new Date("2026-09-01T00:00:00.000Z"),
        supplierId: SUPPLIER_ID,
      },
    });
    expect(await response.json()).toMatchObject({
      data: { purchaseOrder },
      meta: { requestId: expect.any(String) },
    });
  });

  it("rejects unauthenticated, cross-site, and non-contract mutations before the service", async () => {
    const unauthenticated = await start({ authenticated: false });
    const unauthenticatedResponse = await mutation(unauthenticated.url, {});
    expect(unauthenticatedResponse.status).toBe(401);
    expect(
      unauthenticated.repository.createPurchaseOrder,
    ).not.toHaveBeenCalled();
    await server?.stop();
    server = undefined;

    const authenticated = await start();
    const crossSite = await mutation(authenticated.url, {}, "POST", {
      "Sec-Fetch-Site": "cross-site",
    });
    expect(crossSite.status).toBe(403);
    const invalid = await mutation(authenticated.url, {
      expectedTotal: "0.0000",
      items: [],
      orderDate: "invalid",
      supplierId: SUPPLIER_ID,
    });
    expect(invalid.status).toBe(400);
    expect(authenticated.repository.createPurchaseOrder).not.toHaveBeenCalled();
  });

  it("validates filter-bound list input and maps lifecycle failures without leaking internals", async () => {
    const { repository, url } = await start({
      overrides: {
        updatePurchaseOrder: vi
          .fn()
          .mockResolvedValue({ kind: "invalid_transition" }),
      },
    });
    const list = await fetch(
      `${url}?status=DRAFT&orderDateFrom=2026-09-01&supplierId=${SUPPLIER_ID}`,
      {
        headers: { cookie: `${TEST_COOKIE_NAME}=${TOKEN}` },
      },
    );
    expect(list.status).toBe(200);
    expect(repository.listPurchaseOrders).toHaveBeenCalledWith({
      actorUserId: "trusted-user-id",
      branchId: BRANCH_ID,
      organizationId: ORGANIZATION_ID,
      query: {
        limit: 25,
        orderDateFrom: new Date("2026-09-01T00:00:00.000Z"),
        status: "DRAFT",
        supplierId: SUPPLIER_ID,
      },
    });

    const lifecycle = await mutation(
      `${url}/${PURCHASE_ORDER_ID}`,
      {
        expectedUpdatedAt: purchaseOrder.updatedAt,
        status: "ORDERED",
      },
      "PATCH",
    );
    expect(lifecycle.status).toBe(409);
    const body = JSON.stringify(await lifecycle.json());
    expect(body).toContain("PURCHASE_ORDER_STATE_CONFLICT");
    expect(body).not.toMatch(/Prisma|SQL|constraint/i);

    const receipt = await mutation(`${url}/${PURCHASE_ORDER_ID}/receipts`, {});
    expect(receipt.status).toBe(404);
  });
});
