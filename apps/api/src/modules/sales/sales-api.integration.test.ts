import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../../app.ts";
import type { ApiLogger } from "../../logger.ts";
import { startApiServer, type RunningApiServer } from "../../server.ts";
import {
  createTestPrismaClient,
  resetTestDatabase,
} from "../../test/database-harness.ts";
import { loadTestDatabaseEnvironment } from "../../test/database-environment.ts";
import { createPrismaAuthenticationSessionRepository } from "../identity/authentication-repository.ts";
import { createAuthenticationMiddleware } from "../identity/authentication-context.ts";
import type { SessionConfiguration } from "../identity/session-configuration.ts";
import { SESSION_COOKIE_NAME } from "../identity/session-cookie.ts";
import { generateSessionToken } from "../identity/session-token.ts";
import { createPrismaCheckoutRepository } from "./checkout-repository.ts";
import { createCheckoutService } from "./checkout-service.ts";
import { createPrismaRefundRepository } from "./refund-repository.ts";
import { createRefundService } from "./refund-service.ts";
import { createPrismaSalesApiRepository } from "./sales-api-repository.ts";
import { createSalesApiService } from "./sales-api-service.ts";
import { createSalesRouter } from "./sales-router.ts";

const environment = loadTestDatabaseEnvironment();
const prisma = createTestPrismaClient(environment);
const NOW = new Date("2026-09-18T10:00:00.000Z");
const DAY = 86_400_000;
const configuration: SessionConfiguration = {
  absoluteTimeoutMilliseconds: 7 * DAY,
  idleTimeoutMilliseconds: DAY,
  secureCookie: false,
  touchIntervalMilliseconds: 900_000,
};
const logger: ApiLogger = { error() {}, info() {} };

type Role =
  "OWNER" | "ADMIN" | "BRANCH_MANAGER" | "INVENTORY_STAFF" | "CASHIER";

describe("sales HTTP API with PostgreSQL", () => {
  let runningServer: RunningApiServer | undefined;

  beforeEach(async () => resetTestDatabase(environment));
  afterEach(async () => {
    await runningServer?.stop();
    runningServer = undefined;
  });
  afterAll(async () => {
    await resetTestDatabase(environment);
    await prisma.$disconnect();
  });

  async function scope(input: {
    label: string;
    salesVatRate?: string | null;
    salesVatStatus?: "UNCONFIGURED" | "NOT_REGISTERED" | "REGISTERED";
  }) {
    const salesVatStatus = input.salesVatStatus ?? "NOT_REGISTERED";
    const organization = await prisma.organization.create({
      data: {
        name: `${input.label} Organization`,
        salesVatRate:
          salesVatStatus === "REGISTERED" ? (input.salesVatRate ?? "7") : null,
        salesVatStatus,
      },
    });
    const branch = await prisma.branch.create({
      data: {
        code: `B-${randomUUID().slice(0, 8)}`,
        name: `${input.label} Branch`,
        organizationId: organization.id,
      },
    });
    return {
      branch,
      branchId: branch.id,
      organization,
      organizationId: organization.id,
    };
  }

  async function actor(input: {
    assigned?: boolean;
    branchId: string;
    organizationId: string;
    role: Role;
  }) {
    const user = await prisma.user.create({
      data: {
        displayName: `${input.role} Actor`,
        email: `${randomUUID()}@example.com`,
        emailVerifiedAt: NOW,
        passwordHash: "sales-api-test",
      },
    });
    await prisma.organizationMembership.create({
      data: {
        organizationId: input.organizationId,
        role: input.role,
        userId: user.id,
      },
    });
    if (input.assigned !== false && !["OWNER", "ADMIN"].includes(input.role)) {
      await prisma.branchAssignment.create({
        data: {
          branchId: input.branchId,
          organizationId: input.organizationId,
          userId: user.id,
        },
      });
    }
    return user;
  }

  async function session(userId: string) {
    const token = generateSessionToken();
    await prisma.session.create({
      data: {
        absoluteExpiresAt: new Date(NOW.getTime() + 7 * DAY),
        idleExpiresAt: new Date(NOW.getTime() + DAY),
        issuedAt: NOW,
        lastUsedAt: NOW,
        tokenHash: token.tokenHash,
        userId,
      },
    });
    return token.rawToken;
  }

  async function product(input: {
    barcode?: string;
    basePrice?: string;
    branchId: string;
    name: string;
    organizationId: string;
    quantity?: string;
    status?: "ACTIVE" | "INACTIVE";
  }) {
    const created = await prisma.product.create({
      data: {
        ...(input.barcode === undefined ? {} : { barcode: input.barcode }),
        basePrice: input.basePrice ?? "10",
        name: input.name,
        organizationId: input.organizationId,
        sku: `SKU-${randomUUID().slice(0, 8)}`.toUpperCase(),
        ...(input.status === undefined ? {} : { status: input.status }),
        unit: "EA",
      },
    });
    if (input.quantity !== undefined) {
      await prisma.inventoryBalance.create({
        data: {
          branchId: input.branchId,
          organizationId: input.organizationId,
          productId: created.id,
          quantity: input.quantity,
        },
      });
      await prisma.inventoryCostState.create({
        data: {
          averageUnitCost: null,
          basisState: "UNKNOWN",
          branchId: input.branchId,
          inventoryValue: null,
          organizationId: input.organizationId,
          productId: created.id,
        },
      });
    }
    return created;
  }

  async function start() {
    const authenticationMiddleware = createAuthenticationMiddleware({
      configuration,
      now: () => NOW,
      repository: createPrismaAuthenticationSessionRepository(prisma),
    });
    const router = createSalesRouter({
      authenticationMiddleware,
      checkoutService: createCheckoutService({
        repository: createPrismaCheckoutRepository(prisma, { now: () => NOW }),
      }),
      publicWebOrigin: "http://localhost:3000",
      refundService: createRefundService({
        repository: createPrismaRefundRepository(prisma, { now: () => NOW }),
      }),
      salesApiService: createSalesApiService({
        repository: createPrismaSalesApiRepository(prisma, { now: () => NOW }),
      }),
    });
    runningServer = await startApiServer(
      createApp({ apiRouter: router, logger }),
      {
        host: "127.0.0.1",
        port: 0,
      },
    );
    return `http://${runningServer.address.host}:${runningServer.address.port}/api/v1`;
  }

  function requestHeaders(
    token: string | undefined,
    extra: Record<string, string> = {},
  ) {
    return {
      "content-type": "application/json",
      ...(token === undefined
        ? {}
        : { cookie: `${SESSION_COOKIE_NAME}=${token}` }),
      origin: "http://localhost:3000",
      ...extra,
    };
  }

  function checkoutBody(
    currentProduct: { id: string },
    overrides: Record<string, unknown> = {},
  ) {
    return {
      items: [
        {
          expectedUnitPrice: "10.0000",
          productId: currentProduct.id,
          quantity: "1",
        },
      ],
      payment: { amountTendered: "20.00", method: "CASH" },
      ...overrides,
    };
  }

  async function postCheckout(input: {
    base: string;
    body: unknown;
    branchId: string;
    idempotencyKey?: string | undefined;
    organizationId: string;
    origin?: string | undefined;
    token?: string | undefined;
  }) {
    return fetch(
      `${input.base}/organizations/${input.organizationId}/branches/${input.branchId}/sales`,
      {
        body: JSON.stringify(input.body),
        headers: requestHeaders(input.token, {
          ...(input.idempotencyKey === undefined
            ? {}
            : { "idempotency-key": input.idempotencyKey }),
          ...(input.origin === undefined ? {} : { origin: input.origin }),
        }),
        method: "POST",
      },
    );
  }

  async function postRefund(input: {
    base: string;
    body: unknown;
    branchId: string;
    idempotencyKey?: string | undefined;
    organizationId: string;
    origin?: string | undefined;
    saleId: string;
    token?: string | undefined;
  }) {
    return fetch(
      `${input.base}/organizations/${input.organizationId}/branches/${input.branchId}/sales/${input.saleId}/refunds`,
      {
        body: JSON.stringify(input.body),
        headers: requestHeaders(input.token, {
          ...(input.idempotencyKey === undefined
            ? {}
            : { "idempotency-key": input.idempotencyKey }),
          ...(input.origin === undefined ? {} : { origin: input.origin }),
        }),
        method: "POST",
      },
    );
  }

  it("lets OWNER/ADMIN read and update the exact VAT profile while rejecting stale, invalid, and branch-role writes", async () => {
    const value = await scope({
      label: "VAT profile",
      salesVatStatus: "UNCONFIGURED",
    });
    const owner = await actor({ ...value, role: "OWNER" });
    const admin = await actor({ ...value, role: "ADMIN" });
    const manager = await actor({ ...value, role: "BRANCH_MANAGER" });
    const [ownerToken, adminToken, managerToken] = await Promise.all(
      [owner, admin, manager].map(({ id }) => session(id)),
    );
    const base = await start();
    const endpoint = `${base}/organizations/${value.organization.id}/sales-vat-profile`;

    const initial = await fetch(endpoint, {
      headers: requestHeaders(ownerToken),
    });
    expect(initial.status).toBe(200);
    const initialBody = (await initial.json()) as {
      data: { salesVatProfile: { updatedAt: string } };
    };
    const updated = await fetch(endpoint, {
      body: JSON.stringify({
        expectedUpdatedAt: initialBody.data.salesVatProfile.updatedAt,
        salesVatRate: "07.125000",
        salesVatStatus: "REGISTERED",
      }),
      headers: requestHeaders(adminToken),
      method: "PATCH",
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      data: {
        salesVatProfile: {
          salesVatRate: "7.125",
          salesVatStatus: "REGISTERED",
        },
      },
    });
    expect(
      (
        await fetch(endpoint, {
          body: JSON.stringify({
            expectedUpdatedAt: initialBody.data.salesVatProfile.updatedAt,
            salesVatRate: null,
            salesVatStatus: "NOT_REGISTERED",
          }),
          headers: requestHeaders(ownerToken),
          method: "PATCH",
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await fetch(endpoint, {
          body: JSON.stringify({
            expectedUpdatedAt: (
              await prisma.organization.findUniqueOrThrow({
                where: { id: value.organization.id },
              })
            ).updatedAt.toISOString(),
            salesVatRate: "100",
            salesVatStatus: "REGISTERED",
          }),
          headers: requestHeaders(ownerToken),
          method: "PATCH",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(endpoint, {
          body: JSON.stringify({
            expectedUpdatedAt: (
              await prisma.organization.findUniqueOrThrow({
                where: { id: value.organization.id },
              })
            ).updatedAt.toISOString(),
            salesVatRate: null,
            salesVatStatus: "NOT_REGISTERED",
          }),
          headers: requestHeaders(managerToken),
          method: "PATCH",
        })
      ).status,
    ).toBe(403);
  });

  it("returns tenant-safe deterministic POS search for checkout roles and denies inventory staff or unassigned branch roles", async () => {
    const value = await scope({ label: "POS search" });
    const other = await scope({ label: "Other tenant" });
    const products = await Promise.all([
      product({
        barcode: "8850000000002",
        basePrice: "2.5000",
        branchId: value.branch.id,
        name: "Beta",
        organizationId: value.organization.id,
        quantity: "0",
      }),
      product({
        barcode: "8850000000001",
        basePrice: "1.2345",
        branchId: value.branch.id,
        name: "Alpha",
        organizationId: value.organization.id,
        quantity: "2",
      }),
      product({
        branchId: value.branch.id,
        name: "Inactive",
        organizationId: value.organization.id,
        status: "INACTIVE",
      }),
      product({
        branchId: other.branch.id,
        name: "Other Secret",
        organizationId: other.organization.id,
        quantity: "5",
      }),
    ]);
    const roles = await Promise.all(
      (["OWNER", "ADMIN", "BRANCH_MANAGER", "CASHIER"] as const).map((role) =>
        actor({ ...value, role }),
      ),
    );
    const inventoryStaff = await actor({ ...value, role: "INVENTORY_STAFF" });
    const unassignedCashier = await actor({
      ...value,
      assigned: false,
      role: "CASHIER",
    });
    const tokens = await Promise.all(
      [...roles, inventoryStaff, unassignedCashier].map(({ id }) =>
        session(id),
      ),
    );
    const base = await start();
    const endpoint = `${base}/organizations/${value.organization.id}/branches/${value.branch.id}/pos/products`;

    for (const token of tokens.slice(0, 4)) {
      expect(
        (await fetch(`${endpoint}?limit=1`, { headers: requestHeaders(token) }))
          .status,
      ).toBe(200);
    }
    expect(
      (await fetch(endpoint, { headers: requestHeaders(tokens[4]) })).status,
    ).toBe(403);
    expect(
      (await fetch(endpoint, { headers: requestHeaders(tokens[5]) })).status,
    ).toBe(403);

    const first = await fetch(`${endpoint}?limit=1`, {
      headers: requestHeaders(tokens[3]),
    });
    const firstBody = (await first.json()) as {
      data: { products: Array<Record<string, unknown>> };
      meta: { nextCursor: string };
    };
    expect(firstBody.data.products).toEqual([
      expect.objectContaining({
        available: true,
        availableQuantity: expect.stringMatching(/^[1-9][0-9]*.[0-9]{4}$/),
        basePrice: "1.2345",
        id: products[1]!.id,
        name: "Alpha",
      }),
    ]);
    const second = await fetch(
      `${endpoint}?limit=1&cursor=${encodeURIComponent(firstBody.meta.nextCursor)}`,
      { headers: requestHeaders(tokens[3]) },
    );
    expect(await second.json()).toMatchObject({
      data: {
        products: [
          {
            available: false,
            availableQuantity: "0.0000",
            basePrice: "2.5000",
            id: products[0]!.id,
          },
        ],
      },
    });
    const barcode = await fetch(`${endpoint}?barcode=8850000000001`, {
      headers: requestHeaders(tokens[3]),
    });
    expect(await barcode.json()).toMatchObject({
      data: { products: [{ id: products[1]!.id }] },
    });
    expect(
      await (
        await fetch(`${endpoint}?q=no-match`, {
          headers: requestHeaders(tokens[3]),
        })
      ).json(),
    ).toMatchObject({ data: { products: [] } });
    const text = JSON.stringify(firstBody);
    expect(text).not.toContain(products[2]!.id);
    expect(text).not.toContain(products[3]!.id);
    // Inventory view is allowed for every role (BUILD_SPEC section 8), so the branch-scoped
    // availableQuantity is fine; cost, COGS and value stay out of the POS payload.
    expect(text.replaceAll("availableQuantity", "")).not.toMatch(
      /quantity|cost|cogs|inventoryValue/i,
    );
    expect(
      (
        await fetch(
          `${base}/organizations/${other.organization.id}/branches/${other.branch.id}/pos/products`,
          { headers: requestHeaders(tokens[3]) },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${endpoint}?cursor=not-a-valid-cursor`, {
          headers: requestHeaders(tokens[3]),
        })
      ).status,
    ).toBe(400);
  });

  it("requires authentication on VAT-profile and POS search reads and CSRF protection on VAT mutation", async () => {
    const value = await scope({ label: "HTTP boundaries" });
    const owner = await actor({ ...value, role: "OWNER" });
    const token = await session(owner.id);
    const base = await start();
    const profileEndpoint = `${base}/organizations/${value.organization.id}/sales-vat-profile`;
    const searchEndpoint = `${base}/organizations/${value.organization.id}/branches/${value.branch.id}/pos/products`;
    expect((await fetch(profileEndpoint)).status).toBe(401);
    expect((await fetch(searchEndpoint)).status).toBe(401);
    expect(
      (
        await fetch(profileEndpoint, {
          body: JSON.stringify({
            expectedUpdatedAt: value.organization.updatedAt.toISOString(),
            salesVatRate: "07.000000",
            salesVatStatus: "REGISTERED",
          }),
          headers: requestHeaders(token, { origin: "https://evil.example" }),
          method: "PATCH",
        })
      ).status,
    ).toBe(403);
  });

  it("completes CASH and TRANSFER checkout, replays without duplicates, and exposes exact safe receipt strings", async () => {
    const value = await scope({ label: "Checkout HTTP" });
    const owner = await actor({ ...value, role: "OWNER" });
    const token = await session(owner.id);
    const cashProduct = await product({
      basePrice: "60.1234",
      branchId: value.branch.id,
      name: "Cash Product",
      organizationId: value.organization.id,
      quantity: "5",
    });
    const transferProduct = await product({
      basePrice: "10.0000",
      branchId: value.branch.id,
      name: "Transfer Product",
      organizationId: value.organization.id,
      quantity: "5",
    });
    const base = await start();
    const cashBody = {
      items: [
        {
          expectedUnitPrice: "60.1234",
          productId: cashProduct.id,
          quantity: "1.0000",
        },
      ],
      payment: { amountTendered: "100.00", method: "CASH" },
    };
    const first = await postCheckout({
      base,
      body: cashBody,
      branchId: value.branch.id,
      idempotencyKey: "http-cash",
      organizationId: value.organization.id,
      token,
    });
    expect(first.status).toBe(201);
    const firstBody = await first.json();
    expect(firstBody).toMatchObject({
      data: {
        sale: {
          items: [{ quantity: "1", unitPrice: "60.1234" }],
          payment: { amount: "60.12", changeAmount: "39.88" },
          totalAmount: "60.12",
        },
      },
    });
    expect(JSON.stringify(firstBody)).not.toMatch(
      /unitCost|cogs|InventoryCost|canonicalRequestHash|idempotencyKeyHash/i,
    );
    expect(
      (
        await postCheckout({
          base,
          body: cashBody,
          branchId: value.branch.id,
          idempotencyKey: "http-cash",
          organizationId: value.organization.id,
          token,
        })
      ).status,
    ).toBe(200);
    expect(await prisma.sale.count()).toBe(1);
    expect(await prisma.payment.count()).toBe(1);
    expect(await prisma.inventoryTransaction.count()).toBe(1);

    const transfer = await postCheckout({
      base,
      body: {
        items: [
          {
            expectedUnitPrice: "10.0000",
            productId: transferProduct.id,
            quantity: "1",
          },
        ],
        payment: { method: "TRANSFER", reference: " BANK-1 " },
      },
      branchId: value.branch.id,
      idempotencyKey: "http-transfer",
      organizationId: value.organization.id,
      token,
    });
    expect(transfer.status).toBe(201);
    expect(await transfer.json()).toMatchObject({
      data: {
        sale: {
          payment: { method: "TRANSFER", reference: "BANK-1" },
        },
      },
    });
  });

  it("maps idempotency, price, stock, VAT, malformed decimal, auth, branch, tenant, and CSRF failures without mutation leakage", async () => {
    const value = await scope({ label: "Checkout errors" });
    const unconfigured = await scope({
      label: "VAT blocked",
      salesVatStatus: "UNCONFIGURED",
    });
    const other = await scope({ label: "Cross tenant" });
    const cashier = await actor({ ...value, role: "CASHIER" });
    const unassigned = await actor({
      ...value,
      assigned: false,
      role: "CASHIER",
    });
    const inventoryStaff = await actor({ ...value, role: "INVENTORY_STAFF" });
    const vatOwner = await actor({ ...unconfigured, role: "OWNER" });
    const [cashierToken, unassignedToken, staffToken, vatToken] =
      await Promise.all(
        [cashier, unassigned, inventoryStaff, vatOwner].map(({ id }) =>
          session(id),
        ),
      );
    const currentProduct = await product({
      branchId: value.branch.id,
      name: "Limited Product",
      organizationId: value.organization.id,
      quantity: "1",
    });
    const vatProduct = await product({
      branchId: unconfigured.branch.id,
      name: "VAT Product",
      organizationId: unconfigured.organization.id,
      quantity: "1",
    });
    const otherProduct = await product({
      branchId: other.branch.id,
      name: "Other Product",
      organizationId: other.organization.id,
      quantity: "1",
    });
    const base = await start();
    const successInput = {
      base,
      body: checkoutBody(currentProduct),
      branchId: value.branch.id,
      idempotencyKey: "changed-intent",
      organizationId: value.organization.id,
      token: cashierToken,
    };
    expect((await postCheckout(successInput)).status).toBe(201);
    expect(
      (
        await postCheckout({
          ...successInput,
          body: checkoutBody(currentProduct, {
            items: [
              {
                expectedUnitPrice: "10.0000",
                productId: currentProduct.id,
                quantity: "0.5",
              },
            ],
          }),
        })
      ).status,
    ).toBe(409);

    const cases = [
      {
        body: checkoutBody(currentProduct, {
          items: [
            {
              expectedUnitPrice: "9.0000",
              productId: currentProduct.id,
              quantity: "1",
            },
          ],
        }),
        code: "PRICE_CHANGED",
        key: "price-changed",
        status: 409,
      },
      {
        body: checkoutBody(currentProduct, {
          items: [
            {
              expectedUnitPrice: "10.0000",
              productId: currentProduct.id,
              quantity: "2",
            },
          ],
        }),
        code: "INSUFFICIENT_STOCK",
        key: "insufficient",
        status: 409,
      },
      {
        body: checkoutBody(currentProduct, {
          items: [
            {
              expectedUnitPrice: "10.00001",
              productId: currentProduct.id,
              quantity: "1",
            },
          ],
        }),
        code: "VALIDATION_ERROR",
        key: "scale",
        status: 400,
      },
    ];
    for (const current of cases) {
      const response = await postCheckout({
        ...successInput,
        body: current.body,
        idempotencyKey: current.key,
      });
      expect(response.status).toBe(current.status);
      expect(JSON.stringify(await response.json())).toContain(current.code);
    }
    expect(
      (
        await postCheckout({
          base,
          body: checkoutBody(vatProduct),
          branchId: unconfigured.branch.id,
          idempotencyKey: "vat-required",
          organizationId: unconfigured.organization.id,
          token: vatToken,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await postCheckout({
          ...successInput,
          body: checkoutBody(otherProduct),
          idempotencyKey: "cross-product",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await postCheckout({
          ...successInput,
          idempotencyKey: "staff",
          token: staffToken,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await postCheckout({
          ...successInput,
          idempotencyKey: "unassigned",
          token: unassignedToken,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await postCheckout({
          ...successInput,
          idempotencyKey: undefined,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await postCheckout({
          ...successInput,
          idempotencyKey: "csrf",
          origin: "https://evil.example",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await postCheckout({
          ...successInput,
          idempotencyKey: "anonymous",
          token: undefined,
        })
      ).status,
    ).toBe(401);
  });

  it("allows manager discount but rejects cashier discount and invalid tender through the real service", async () => {
    const value = await scope({ label: "Discount HTTP" });
    const manager = await actor({ ...value, role: "BRANCH_MANAGER" });
    const cashier = await actor({ ...value, role: "CASHIER" });
    const [managerToken, cashierToken] = await Promise.all([
      session(manager.id),
      session(cashier.id),
    ]);
    const products = await Promise.all(
      ["Manager Product", "Cashier Product"].map((name) =>
        product({
          branchId: value.branch.id,
          name,
          organizationId: value.organization.id,
          quantity: "2",
        }),
      ),
    );
    const base = await start();
    const discounted = (currentProduct: { id: string }) =>
      checkoutBody(currentProduct, {
        discount: {
          amount: "1.00",
          reason: "Manager approved",
          type: "AMOUNT",
        },
      });
    const managerResponse = await postCheckout({
      base,
      body: discounted(products[0]!),
      branchId: value.branch.id,
      idempotencyKey: "manager-discount",
      organizationId: value.organization.id,
      token: managerToken,
    });
    expect(managerResponse.status).toBe(201);
    expect(await managerResponse.json()).toMatchObject({
      data: { sale: { discountAmount: "1.00", totalAmount: "9.00" } },
    });
    expect(
      (
        await postCheckout({
          base,
          body: discounted(products[1]!),
          branchId: value.branch.id,
          idempotencyKey: "cashier-discount",
          organizationId: value.organization.id,
          token: cashierToken,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await postCheckout({
          base,
          body: checkoutBody(products[1]!, {
            payment: { amountTendered: "1.00", method: "CASH" },
          }),
          branchId: value.branch.id,
          idempotencyKey: "invalid-tender",
          organizationId: value.organization.id,
          token: cashierToken,
        })
      ).status,
    ).toBe(400);
  });

  it("lists and reads immutable, cursor-paginated Sales history with safe scoped fields", async () => {
    const value = await scope({ label: "Sales history" });
    const owner = await actor({ ...value, role: "OWNER" });
    const manager = await actor({ ...value, role: "BRANCH_MANAGER" });
    const cashier = await actor({ ...value, role: "CASHIER" });
    const [ownerToken, managerToken, cashierToken] = await Promise.all([
      session(owner.id),
      session(manager.id),
      session(cashier.id),
    ]);
    const productValue = await product({
      branchId: value.branch.id,
      name: "Historical coffee",
      organizationId: value.organization.id,
      quantity: "10",
    });
    const base = await start();
    for (const [index, payment] of [
      { amountTendered: "20.00", method: "CASH" },
      { method: "TRANSFER", reference: "TRANSFER-HISTORY" },
      { amountTendered: "20.00", method: "CASH" },
    ].entries()) {
      expect(
        (
          await postCheckout({
            base,
            body: checkoutBody(productValue, { payment }),
            branchId: value.branch.id,
            idempotencyKey: `history-${index}`,
            organizationId: value.organization.id,
            token: ownerToken,
          })
        ).status,
      ).toBe(201);
    }
    const sales = await prisma.sale.findMany({
      orderBy: { id: "asc" },
      where: { organizationId: value.organization.id },
    });
    await Promise.all(
      sales.map((sale, index) =>
        prisma.sale.update({
          data: {
            createdAt: new Date(`2026-09-18T10:0${index}:00.000Z`),
          },
          where: { id: sale.id },
        }),
      ),
    );
    const endpoint = `${base}/organizations/${value.organization.id}/branches/${value.branch.id}/sales`;
    const first = await fetch(`${endpoint}?limit=2`, {
      headers: requestHeaders(ownerToken),
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      data: { sales: Array<{ createdAt: string; id: string }> };
      meta: { nextCursor: string | null };
    };
    expect(firstBody.data.sales).toHaveLength(2);
    expect(firstBody.data.sales.map((sale) => sale.createdAt)).toEqual([
      "2026-09-18T10:02:00.000Z",
      "2026-09-18T10:01:00.000Z",
    ]);
    expect(firstBody.meta.nextCursor).not.toBeNull();
    const second = await fetch(
      `${endpoint}?limit=2&cursor=${encodeURIComponent(firstBody.meta.nextCursor!)}`,
      { headers: requestHeaders(ownerToken) },
    );
    const secondBody = (await second.json()) as {
      data: { sales: Array<{ id: string }> };
    };
    expect(second.status).toBe(200);
    expect(secondBody.data.sales).toHaveLength(1);
    expect(
      new Set(
        [...firstBody.data.sales, ...secondBody.data.sales].map(({ id }) => id),
      ).size,
    ).toBe(3);

    expect(
      (
        await fetch(
          `${endpoint}?cursor=${encodeURIComponent(firstBody.meta.nextCursor!)}&actorUserId=${owner.id}`,
          { headers: requestHeaders(ownerToken) },
        )
      ).status,
    ).toBe(400);
    for (const query of [
      "limit=0",
      "limit=101",
      "createdAtFrom=2026-09-18",
      "createdAtFrom=2026-09-18T10:01:00Z&createdAtTo=2026-09-18T10:01:00Z",
      "cursor=not-a-cursor",
    ]) {
      expect(
        (
          await fetch(`${endpoint}?${query}`, {
            headers: requestHeaders(ownerToken),
          })
        ).status,
      ).toBe(400);
    }
    const range = await fetch(
      `${endpoint}?createdAtFrom=2026-09-18T17:01:00%2B07:00&createdAtTo=2026-09-18T10:03:00Z&actorUserId=${owner.id}`,
      { headers: requestHeaders(ownerToken) },
    );
    expect(range.status).toBe(200);
    const rangeBody = (await range.json()) as { data: { sales: unknown[] } };
    expect(rangeBody.data.sales).toHaveLength(2);
    const noMatch = await fetch(`${endpoint}?actorUserId=${manager.id}`, {
      headers: requestHeaders(ownerToken),
    });
    expect(noMatch.status).toBe(200);
    const noMatchBody = (await noMatch.json()) as {
      data: { sales: unknown[] };
    };
    expect(noMatchBody.data.sales).toEqual([]);

    const detailId = firstBody.data.sales[0]!.id;
    await prisma.product.update({
      data: { name: "Current renamed coffee" },
      where: { id: productValue.id },
    });
    const ownerDetail = await fetch(`${endpoint}/${detailId}`, {
      headers: requestHeaders(ownerToken),
    });
    const ownerBody = (await ownerDetail.json()) as {
      data: { sale: { items: Array<Record<string, unknown>> } };
    };
    expect(ownerDetail.status).toBe(200);
    expect(ownerBody.data.sale.items[0]).toMatchObject({
      productName: "Historical coffee",
      quantity: "1.0000",
      unitPrice: "10.0000",
    });
    expect(ownerBody.data.sale.items[0]).toHaveProperty("unitCost", null);
    const cashierDetail = await fetch(`${endpoint}/${detailId}`, {
      headers: requestHeaders(cashierToken),
    });
    const cashierBody = await cashierDetail.json();
    expect(cashierDetail.status).toBe(200);
    expect(JSON.stringify(cashierBody)).not.toMatch(/unitCost|cogsAmount/i);
    expect(
      (
        await fetch(`${endpoint}/${detailId}`, {
          headers: requestHeaders(managerToken),
        })
      ).status,
    ).toBe(200);

    const other = await scope({ label: "Other history" });
    expect(
      (
        await fetch(
          `${base}/organizations/${other.organization.id}/branches/${other.branch.id}/sales`,
          { headers: requestHeaders(ownerToken) },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${endpoint}/${randomUUID()}`, {
          headers: requestHeaders(ownerToken),
        })
      ).status,
    ).toBe(404);
  });

  it("creates linked refunds and projects partial/full state with role-filtered historical costs", async () => {
    const value = await scope({ label: "Refund HTTP" });
    const manager = await actor({ ...value, role: "BRANCH_MANAGER" });
    const cashier = await actor({ ...value, role: "CASHIER" });
    const inventoryStaff = await actor({ ...value, role: "INVENTORY_STAFF" });
    const unassignedManager = await actor({
      ...value,
      assigned: false,
      role: "BRANCH_MANAGER",
    });
    const [managerToken, cashierToken, staffToken, unassignedToken] =
      await Promise.all(
        [manager, cashier, inventoryStaff, unassignedManager].map(({ id }) =>
          session(id),
        ),
      );
    const productValue = await product({
      basePrice: "25.0000",
      branchId: value.branch.id,
      name: "Refundable product",
      organizationId: value.organization.id,
      quantity: "10",
    });
    await prisma.inventoryCostState.update({
      data: {
        averageUnitCost: "10",
        basisState: "KNOWN",
        inventoryValue: "100",
      },
      where: {
        branchId_productId: {
          branchId: value.branch.id,
          productId: productValue.id,
        },
      },
    });
    const base = await start();
    const checkout = await postCheckout({
      base,
      body: {
        items: [
          {
            expectedUnitPrice: "25.0000",
            productId: productValue.id,
            quantity: "2",
          },
        ],
        payment: { amountTendered: "100", method: "CASH" },
      },
      branchId: value.branch.id,
      idempotencyKey: "refund-source-sale",
      organizationId: value.organization.id,
      token: cashierToken,
    });
    expect(checkout.status).toBe(201);
    const checkoutBody = (await checkout.json()) as {
      data: { sale: { id: string; items: Array<{ id: string }> } };
    };
    const saleId = checkoutBody.data.sale.id;
    const saleItemId = checkoutBody.data.sale.items[0]!.id;
    const partialBody = {
      items: [{ quantity: "1", restockQuantity: "1", saleItemId }],
      reason: "Partial customer return",
    };
    const refundInput = {
      base,
      body: partialBody,
      branchId: value.branch.id,
      idempotencyKey: "refund-http-partial",
      organizationId: value.organization.id,
      saleId,
      token: managerToken,
    };
    const created = await postRefund(refundInput);
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      data: {
        refund: {
          items: [
            {
              cogsReversalAmount: "10.0000000000",
              originalCostBasisState: "KNOWN",
              refundQuantity: "1",
              restockQuantity: "1",
            },
          ],
          payment: { amount: "25.00", method: "CASH", reference: null },
          totalAmount: "25.00",
        },
      },
    });
    expect((await postRefund(refundInput)).status).toBe(200);
    expect(
      (
        await postRefund({
          ...refundInput,
          body: { ...partialBody, reason: "Changed retry intent" },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await postRefund({
          ...refundInput,
          idempotencyKey: "refund-cashier-denied",
          token: cashierToken,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await postRefund({
          ...refundInput,
          idempotencyKey: "refund-unassigned-denied",
          token: unassignedToken,
        })
      ).status,
    ).toBe(403);

    const historyEndpoint = `${base}/organizations/${value.organization.id}/branches/${value.branch.id}/sales`;
    const summary = await fetch(historyEndpoint, {
      headers: requestHeaders(cashierToken),
    });
    expect(summary.status).toBe(200);
    expect(await summary.json()).toMatchObject({
      data: {
        sales: [
          {
            id: saleId,
            refundedAmount: "25.00",
            refundState: "PARTIALLY_REFUNDED",
            remainingAmount: "25.00",
          },
        ],
      },
    });
    const managerDetail = await fetch(`${historyEndpoint}/${saleId}`, {
      headers: requestHeaders(managerToken),
    });
    expect(managerDetail.status).toBe(200);
    const managerText = JSON.stringify(await managerDetail.json());
    expect(managerText).toContain('"remainingRefundableQuantity":"1.0000"');
    expect(managerText).toContain('"cogsReversalAmount":"10.0000000000"');
    const cashierDetail = await fetch(`${historyEndpoint}/${saleId}`, {
      headers: requestHeaders(cashierToken),
    });
    expect(cashierDetail.status).toBe(200);
    expect(JSON.stringify(await cashierDetail.json())).not.toMatch(
      /cogsReversalAmount|originalUnitCost|originalCostBasisState/,
    );
    expect(
      (
        await fetch(`${historyEndpoint}/${saleId}`, {
          headers: requestHeaders(staffToken),
        })
      ).status,
    ).toBe(403);

    expect(
      (
        await postRefund({
          ...refundInput,
          body: {
            items: [{ quantity: "1", restockQuantity: "1", saleItemId }],
            reason: "Final customer return",
          },
          idempotencyKey: "refund-http-full",
        })
      ).status,
    ).toBe(201);
    expect(
      await (
        await fetch(historyEndpoint, { headers: requestHeaders(cashierToken) })
      ).json(),
    ).toMatchObject({
      data: {
        sales: [
          {
            id: saleId,
            refundedAmount: "50.00",
            refundState: "FULLY_REFUNDED",
            remainingAmount: "0.00",
          },
        ],
      },
    });
  });
});
