import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../../app.ts";
import type { ApiLogger } from "../../logger.ts";
import { startApiServer, type RunningApiServer } from "../../server.ts";
import { createSessionAuthenticationMiddleware } from "../identity/authentication-context.ts";
import type {
  ReceivingRepository,
  SafePurchaseReceipt,
} from "./receiving-repository.ts";
import { createReceivingRouter } from "./receiving-router.ts";
import { createReceivingService } from "./receiving-service.ts";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const ROUTE_BRANCH_ID = "20000000-0000-4000-8000-000000000001";
const RECEIPT_BRANCH_ID = "20000000-0000-4000-8000-000000000002";
const PURCHASE_ORDER_ID = "30000000-0000-4000-8000-000000000001";
const PURCHASE_ORDER_ITEM_ID = "40000000-0000-4000-8000-000000000001";
const TOKEN = "A".repeat(43);
const TEST_COOKIE_NAME = "stockwise_test_session";
const logger: ApiLogger = { error() {}, info() {} };
const receipt: SafePurchaseReceipt = {
  branchId: RECEIPT_BRANCH_ID,
  createdAt: "2026-09-02T10:00:00.000Z",
  id: "50000000-0000-4000-8000-000000000001",
  inputVatAmount: "3.5000",
  inputVatRate: "7.000000",
  items: [
    {
      actualUnitCost: "5.2500",
      id: "60000000-0000-4000-8000-000000000001",
      productId: "70000000-0000-4000-8000-000000000001",
      productNameSnapshot: "Coffee",
      productSkuSnapshot: "COFFEE",
      purchaseOrderItemId: PURCHASE_ORDER_ITEM_ID,
      receivedQuantity: "2",
    },
  ],
  organizationId: ORGANIZATION_ID,
  organizationVatRegisteredSnapshot: true,
  purchaseOrderId: PURCHASE_ORDER_ID,
  receivedAt: "2026-09-02T10:00:00.000Z",
  receivedByMembershipId: "80000000-0000-4000-8000-000000000001",
  receivedByUserId: "trusted-user-id",
  reference: "REC-test",
  supplierId: "90000000-0000-4000-8000-000000000001",
  supplierTaxDocumentDate: "2026-09-02",
  supplierTaxDocumentNumber: "TAX-100",
};

describe("receiving router", () => {
  let server: RunningApiServer | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  async function start({
    authenticated = true,
    receivePurchaseOrder = vi
      .fn<ReceivingRepository["receivePurchaseOrder"]>()
      .mockResolvedValue({ kind: "success", receipt }),
  }: {
    authenticated?: boolean;
    receivePurchaseOrder?: ReceivingRepository["receivePurchaseOrder"];
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
    const repository: ReceivingRepository = { receivePurchaseOrder };
    const router = createReceivingRouter({
      authenticationMiddleware,
      publicWebOrigin: "http://localhost:3000",
      receivingService: createReceivingService({ repository }),
    });
    server = await startApiServer(createApp({ apiRouter: router, logger }), {
      host: "127.0.0.1",
      port: 0,
    });
    return {
      endpoint: `http://${server.address.host}:${server.address.port}/api/v1/organizations/${ORGANIZATION_ID}/branches/${ROUTE_BRANCH_ID}/purchase-orders/${PURCHASE_ORDER_ID}/receipts`,
      receivePurchaseOrder,
    };
  }

  function receive(
    endpoint: string,
    input: { body?: unknown; headers?: Record<string, string> } = {},
  ) {
    return fetch(endpoint, {
      body: JSON.stringify(
        input.body ?? {
          actualCosts: [
            {
              actualUnitCost: "5.2500",
              purchaseOrderItemId: PURCHASE_ORDER_ITEM_ID,
            },
          ],
          vat: {
            inputVatAmount: "3.5000",
            inputVatRate: "7.000000",
            organizationVatRegistered: true,
            supplierTaxDocumentDate: "2026-09-02",
            supplierTaxDocumentNumber: " TAX-100 ",
          },
        },
      ),
      headers: {
        "content-type": "application/json",
        cookie: `${TEST_COOKIE_NAME}=${TOKEN}`,
        "idempotency-key": "receive-key",
        ...input.headers,
      },
      method: "POST",
    });
  }

  it("passes the strict command and supplied idempotency key from the trusted actor", async () => {
    const { endpoint, receivePurchaseOrder } = await start();
    const response = await receive(endpoint);

    expect(response.status).toBe(201);
    expect(receivePurchaseOrder).toHaveBeenCalledWith({
      actorUserId: "trusted-user-id",
      actualCosts: [
        {
          actualUnitCost: "5.2500",
          purchaseOrderItemId: PURCHASE_ORDER_ITEM_ID,
        },
      ],
      idempotencyKey: "receive-key",
      organizationId: ORGANIZATION_ID,
      purchaseOrderId: PURCHASE_ORDER_ID,
      vat: {
        inputVatAmount: "3.5000",
        inputVatRate: "7.000000",
        organizationVatRegistered: true,
        supplierTaxDocumentDate: "2026-09-02",
        supplierTaxDocumentNumber: " TAX-100 ",
      },
    });
    const body = await response.json();
    expect(body).toMatchObject({
      data: {
        receipt: {
          branchId: RECEIPT_BRANCH_ID,
          items: [{ actualUnitCost: "5.2500", receivedQuantity: "2" }],
          purchaseOrderId: PURCHASE_ORDER_ID,
          receivedByUserId: "trusted-user-id",
        },
      },
      meta: { requestId: expect.any(String) },
    });
    expect(JSON.stringify(body)).not.toMatch(
      /receivedByMembershipId|idempotencyKey|canonicalRequestHash/i,
    );
  });

  it("returns an identical service replay as 200", async () => {
    const receivePurchaseOrder = vi
      .fn<ReceivingRepository["receivePurchaseOrder"]>()
      .mockResolvedValue({ kind: "replay", receipt });
    const { endpoint } = await start({ receivePurchaseOrder });
    const response = await receive(endpoint);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { receipt: { id: receipt.id } },
    });
  });

  it("rejects unauthenticated, cross-site, missing-key, and non-contract requests before receiving", async () => {
    const unauthenticated = await start({ authenticated: false });
    expect((await receive(unauthenticated.endpoint)).status).toBe(401);
    expect(unauthenticated.receivePurchaseOrder).not.toHaveBeenCalled();
    await server?.stop();
    server = undefined;

    const authenticated = await start();
    expect(
      (
        await receive(authenticated.endpoint, {
          headers: { "Sec-Fetch-Site": "cross-site" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await receive(authenticated.endpoint, {
          headers: { origin: "https://evil.example" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await receive(authenticated.endpoint, {
          headers: { "idempotency-key": "contains space" },
        })
      ).status,
    ).toBe(400);
    const missingKey = await fetch(authenticated.endpoint, {
      body: JSON.stringify({ actualCosts: [], vat: {} }),
      headers: {
        "content-type": "application/json",
        cookie: `${TEST_COOKIE_NAME}=${TOKEN}`,
      },
      method: "POST",
    });
    expect(missingKey.status).toBe(400);
    expect(
      (
        await receive(authenticated.endpoint, {
          body: {
            actualCosts: [
              {
                actualUnitCost: "5",
                purchaseOrderItemId: PURCHASE_ORDER_ITEM_ID,
                receivedQuantity: "999",
              },
            ],
            branchId: RECEIPT_BRANCH_ID,
            vat: {
              inputVatAmount: null,
              inputVatRate: null,
              organizationVatRegistered: false,
              supplierTaxDocumentDate: null,
              supplierTaxDocumentNumber: null,
            },
          },
        })
      ).status,
    ).toBe(400);
    expect(authenticated.receivePurchaseOrder).not.toHaveBeenCalled();
  });

  it.each([
    ["forbidden", 403, "FORBIDDEN"],
    ["not_found", 404, "PURCHASE_ORDER_NOT_FOUND"],
    ["branch_inactive", 409, "BRANCH_INACTIVE"],
    ["product_inactive", 409, "PRODUCT_INACTIVE"],
    ["invalid_transition", 409, "PURCHASE_ORDER_STATE_CONFLICT"],
    ["invalid_costs", 400, "VALIDATION_ERROR"],
    ["invalid_vat", 400, "VALIDATION_ERROR"],
    ["invalid_quantity", 409, "PURCHASE_ORDER_RECEIPT_INVALID"],
    ["idempotency_conflict", 409, "IDEMPOTENCY_CONFLICT"],
    ["reference_conflict", 409, "RECEIPT_REFERENCE_CONFLICT"],
  ] as const)(
    "maps %s without leaking internals",
    async (kind, status, code) => {
      const receivePurchaseOrder = vi
        .fn<ReceivingRepository["receivePurchaseOrder"]>()
        .mockResolvedValue({ kind });
      const { endpoint } = await start({ receivePurchaseOrder });
      const response = await receive(endpoint);
      expect(response.status).toBe(status);
      const text = JSON.stringify(await response.json());
      expect(text).toContain(code);
      expect(text).not.toMatch(/Prisma|SQL|constraint|advisory|hash/i);
    },
  );

  it("sanitizes an unexpected repository failure", async () => {
    const receivePurchaseOrder = vi
      .fn<ReceivingRepository["receivePurchaseOrder"]>()
      .mockRejectedValue(new Error("Prisma SQL advisory lock failure"));
    const { endpoint } = await start({ receivePurchaseOrder });
    const response = await receive(endpoint);
    expect(response.status).toBe(500);
    const text = JSON.stringify(await response.json());
    expect(text).toContain("INTERNAL_ERROR");
    expect(text).not.toMatch(/Prisma|SQL|advisory|lock/i);
  });
});
