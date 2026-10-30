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
import { createPrismaReceivingRepository } from "./receiving-repository.ts";
import { createReceivingRouter } from "./receiving-router.ts";
import { createReceivingService } from "./receiving-service.ts";

const environment = loadTestDatabaseEnvironment();
const prisma = createTestPrismaClient(environment);
const NOW = new Date("2026-09-02T10:00:00.000Z");
const DAY = 86_400_000;
const configuration: SessionConfiguration = {
  absoluteTimeoutMilliseconds: 7 * DAY,
  idleTimeoutMilliseconds: DAY,
  secureCookie: false,
  touchIntervalMilliseconds: 900_000,
};
const logger: ApiLogger = { error() {}, info() {} };
const noVat = {
  inputVatAmount: null,
  inputVatRate: null,
  organizationVatRegistered: false,
  supplierTaxDocumentDate: null,
  supplierTaxDocumentNumber: null,
} as const;

type Role =
  "OWNER" | "ADMIN" | "BRANCH_MANAGER" | "INVENTORY_STAFF" | "CASHIER";

describe("receiving HTTP API with PostgreSQL", () => {
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

  async function actor(input: {
    assigned?: boolean;
    branchId: string;
    organizationId: string;
    role: Role;
  }) {
    const user = await prisma.user.create({
      data: {
        email: `${randomUUID()}@example.com`,
        emailVerifiedAt: NOW,
        passwordHash: "integration-test",
      },
    });
    const membership = await prisma.organizationMembership.create({
      data: {
        organizationId: input.organizationId,
        role: input.role,
        userId: user.id,
      },
    });
    if (
      input.assigned !== false &&
      ["BRANCH_MANAGER", "INVENTORY_STAFF", "CASHIER"].includes(input.role)
    ) {
      await prisma.branchAssignment.create({
        data: {
          branchId: input.branchId,
          organizationId: input.organizationId,
          userId: user.id,
        },
      });
    }
    return { membership, user };
  }

  async function scope(label: string) {
    const organization = await prisma.organization.create({
      data: { name: label },
    });
    const branch = await prisma.branch.create({
      data: {
        code: `BR-${randomUUID().slice(0, 8)}`,
        name: `${label} Branch`,
        organizationId: organization.id,
      },
    });
    const otherBranch = await prisma.branch.create({
      data: {
        code: `BR-${randomUUID().slice(0, 8)}`,
        name: `${label} Other Branch`,
        organizationId: organization.id,
      },
    });
    const supplier = await prisma.supplier.create({
      data: { name: `${label} Supplier`, organizationId: organization.id },
    });
    const products = await Promise.all(
      ["First", "Second"].map((name) =>
        prisma.product.create({
          data: {
            basePrice: "10",
            name: `${label} ${name}`,
            organizationId: organization.id,
            sku: `${randomUUID().slice(0, 8)}-${name}`.toUpperCase(),
            unit: "EA",
          },
        }),
      ),
    );
    return { branch, organization, otherBranch, products, supplier };
  }

  async function order(input: {
    branchId: string;
    creator: Awaited<ReturnType<typeof actor>>;
    organizationId: string;
    products: readonly { id: string; name: string; sku: string }[];
    status?: "DRAFT" | "ORDERED" | "CANCELLED";
    supplierId: string;
  }) {
    const status = input.status ?? "ORDERED";
    return prisma.purchaseOrder.create({
      data: {
        branchId: input.branchId,
        cancelledAt: status === "CANCELLED" ? NOW : null,
        createdByMembershipId: input.creator.membership.id,
        createdByUserId: input.creator.user.id,
        expectedTotal: "100",
        items: {
          create: input.products.map((product, index) => ({
            expectedUnitCost: `${index + 1}`,
            productId: product.id,
            productNameSnapshot: product.name,
            productSkuSnapshot: product.sku,
            quantity: `${index + 2}`,
          })),
        },
        orderDate: new Date("2026-09-02T00:00:00.000Z"),
        orderedAt: status === "ORDERED" ? NOW : null,
        organizationId: input.organizationId,
        reference: `PO-${randomUUID()}`,
        status,
        supplierId: input.supplierId,
      },
      include: { items: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] } },
    });
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

  async function start() {
    const authenticationMiddleware = createAuthenticationMiddleware({
      configuration,
      now: () => NOW,
      repository: createPrismaAuthenticationSessionRepository(prisma),
    });
    const receivingService = createReceivingService({
      repository: createPrismaReceivingRepository(prisma, { now: () => NOW }),
    });
    const apiRouter = createReceivingRouter({
      authenticationMiddleware,
      publicWebOrigin: "http://localhost:3000",
      receivingService,
    });
    runningServer = await startApiServer(createApp({ apiRouter, logger }), {
      host: "127.0.0.1",
      port: 0,
    });
    return `http://${runningServer.address.host}:${runningServer.address.port}/api/v1`;
  }

  function body(
    purchaseOrder: Awaited<ReturnType<typeof order>>,
    actualCosts = purchaseOrder.items.map((item, index) => ({
      actualUnitCost: `${index + 5}.2500`,
      purchaseOrderItemId: item.id,
    })),
    vat: typeof noVat | Record<string, unknown> = noVat,
  ) {
    return { actualCosts, vat };
  }

  function receive(input: {
    base: string;
    body: unknown;
    branchId: string;
    idempotencyKey?: string;
    organizationId: string;
    purchaseOrderId: string;
    token: string | undefined;
  }) {
    return fetch(
      `${input.base}/organizations/${input.organizationId}/branches/${input.branchId}/purchase-orders/${input.purchaseOrderId}/receipts`,
      {
        body: JSON.stringify(input.body),
        headers: {
          "content-type": "application/json",
          ...(input.token === undefined
            ? {}
            : { cookie: `${SESSION_COOKIE_NAME}=${input.token}` }),
          ...(input.idempotencyKey === undefined
            ? {}
            : { "idempotency-key": input.idempotencyKey }),
          origin: "http://localhost:3000",
        },
        method: "POST",
      },
    );
  }

  it("allows every receiving role and derives authority and quantities from each persisted PO", async () => {
    const value = await scope("HTTP receiving roles");
    const actors = await Promise.all(
      (["OWNER", "ADMIN", "BRANCH_MANAGER"] as const).map((role) =>
        actor({
          branchId: value.branch.id,
          organizationId: value.organization.id,
          role,
        }),
      ),
    );
    const orders = await Promise.all(
      actors.map((current) =>
        order({
          branchId: value.branch.id,
          creator: current,
          organizationId: value.organization.id,
          products: value.products,
          supplierId: value.supplier.id,
        }),
      ),
    );
    await prisma.supplier.update({
      data: { status: "INACTIVE" },
      where: { id: value.supplier.id },
    });
    const tokens = await Promise.all(
      actors.map((current) => session(current.user.id)),
    );
    const base = await start();

    for (const [index, purchaseOrder] of orders.entries()) {
      const response = await receive({
        base,
        body: body(purchaseOrder),
        branchId: index === 2 ? value.otherBranch.id : value.branch.id,
        idempotencyKey: `role-${index}`,
        organizationId: value.organization.id,
        purchaseOrderId: purchaseOrder.id,
        token: tokens[index],
      });
      expect(response.status).toBe(201);
      const responseBody = JSON.stringify(await response.json());
      expect(responseBody).toContain(value.branch.id);
      expect(responseBody).not.toContain("receivedByMembershipId");
    }

    expect(await prisma.purchaseReceipt.count()).toBe(actors.length);
    expect(await prisma.purchaseReceiptItem.count()).toBe(actors.length * 2);
    expect(await prisma.inventoryTransaction.count()).toBe(actors.length * 2);
    expect(
      await prisma.purchaseOrder.count({ where: { status: "RECEIVED" } }),
    ).toBe(actors.length);
  });

  it("denies unauthenticated, cashier, unassigned, and cross-tenant callers without mutation", async () => {
    const value = await scope("HTTP receiving denied");
    const owner = await actor({
      branchId: value.branch.id,
      organizationId: value.organization.id,
      role: "OWNER",
    });
    const cashier = await actor({
      branchId: value.branch.id,
      organizationId: value.organization.id,
      role: "CASHIER",
    });
    const unassigned = await actor({
      assigned: false,
      branchId: value.branch.id,
      organizationId: value.organization.id,
      role: "INVENTORY_STAFF",
    });
    const other = await scope("HTTP receiving other tenant");
    const otherOwner = await actor({
      branchId: other.branch.id,
      organizationId: other.organization.id,
      role: "OWNER",
    });
    const purchaseOrder = await order({
      branchId: value.branch.id,
      creator: owner,
      organizationId: value.organization.id,
      products: value.products,
      supplierId: value.supplier.id,
    });
    const [cashierToken, unassignedToken, otherToken] = await Promise.all([
      session(cashier.user.id),
      session(unassigned.user.id),
      session(otherOwner.user.id),
    ]);
    const base = await start();
    const request = (
      token: string | undefined,
      organizationId = value.organization.id,
    ) =>
      receive({
        base,
        body: body(purchaseOrder),
        branchId: value.branch.id,
        idempotencyKey: `denied-${token ?? "none"}`,
        organizationId,
        purchaseOrderId: purchaseOrder.id,
        token,
      });

    expect((await request(undefined)).status).toBe(401);
    expect((await request(cashierToken)).status).toBe(403);
    expect((await request(unassignedToken)).status).toBe(403);
    expect((await request(otherToken)).status).toBe(403);
    expect((await request(otherToken, other.organization.id)).status).toBe(404);
    expect(await prisma.purchaseReceipt.count()).toBe(0);
    expect(await prisma.inventoryTransaction.count()).toBe(0);
  });

  it("replays once and conflicts on changed actual-cost or VAT intent", async () => {
    const value = await scope("HTTP receiving idempotency");
    const owner = await actor({
      branchId: value.branch.id,
      organizationId: value.organization.id,
      role: "OWNER",
    });
    const purchaseOrder = await order({
      branchId: value.branch.id,
      creator: owner,
      organizationId: value.organization.id,
      products: value.products,
      supplierId: value.supplier.id,
    });
    const token = await session(owner.user.id);
    const base = await start();
    const send = (requestBody: unknown) =>
      receive({
        base,
        body: requestBody,
        branchId: value.branch.id,
        idempotencyKey: "stable-http-receipt-key",
        organizationId: value.organization.id,
        purchaseOrderId: purchaseOrder.id,
        token,
      });

    const first = await send(body(purchaseOrder));
    const replay = await send(
      body(purchaseOrder, [...body(purchaseOrder).actualCosts].reverse()),
    );
    const changedCost = body(purchaseOrder);
    changedCost.actualCosts[0]!.actualUnitCost = "99";
    const conflict = await send(changedCost);
    const changedVat = await send(
      body(purchaseOrder, body(purchaseOrder).actualCosts, {
        ...noVat,
        organizationVatRegistered: true,
      }),
    );
    const differentKey = await receive({
      base,
      body: body(purchaseOrder),
      branchId: value.branch.id,
      idempotencyKey: "different-key-after-receive",
      organizationId: value.organization.id,
      purchaseOrderId: purchaseOrder.id,
      token,
    });

    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    expect(conflict.status).toBe(409);
    expect(changedVat.status).toBe(409);
    expect(differentKey.status).toBe(409);
    expect(JSON.stringify(await conflict.json())).toContain(
      "IDEMPOTENCY_CONFLICT",
    );
    const firstBody = (await first.json()) as { data: { receipt: unknown } };
    const replayBody = (await replay.json()) as { data: { receipt: unknown } };
    expect(replayBody.data.receipt).toEqual(firstBody.data.receipt);
    expect(await prisma.purchaseReceipt.count()).toBe(1);
    expect(await prisma.purchaseReceiptItem.count()).toBe(2);
    expect(await prisma.inventoryTransaction.count()).toBe(2);
  });

  it("maps real cost, VAT, lifecycle, inactive-state, and safe-not-found failures", async () => {
    const value = await scope("HTTP receiving failures");
    const owner = await actor({
      branchId: value.branch.id,
      organizationId: value.organization.id,
      role: "OWNER",
    });
    const token = await session(owner.user.id);
    const orders = await Promise.all(
      ["ORDERED", "DRAFT", "CANCELLED"].map((status) =>
        order({
          branchId: value.branch.id,
          creator: owner,
          organizationId: value.organization.id,
          products: value.products,
          status: status as "ORDERED" | "DRAFT" | "CANCELLED",
          supplierId: value.supplier.id,
        }),
      ),
    );
    const [ordered, draft, cancelled] = orders;
    const base = await start();
    const send = (
      purchaseOrder: NonNullable<typeof ordered>,
      requestBody: unknown,
      key: string,
    ) =>
      receive({
        base,
        body: requestBody,
        branchId: value.branch.id,
        idempotencyKey: key,
        organizationId: value.organization.id,
        purchaseOrderId: purchaseOrder.id,
        token,
      });

    expect(
      (
        await send(
          ordered!,
          body(
            ordered!,
            ordered!.items.slice(0, 1).map((item) => ({
              actualUnitCost: "1",
              purchaseOrderItemId: item.id,
            })),
          ),
          "missing-cost",
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await send(
          ordered!,
          body(ordered!, [
            {
              actualUnitCost: "1",
              purchaseOrderItemId: ordered!.items[0]!.id,
            },
            {
              actualUnitCost: "1",
              purchaseOrderItemId: ordered!.items[0]!.id,
            },
          ]),
          "duplicate-cost",
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await send(
          ordered!,
          body(ordered!, [
            ...body(ordered!).actualCosts,
            { actualUnitCost: "1", purchaseOrderItemId: randomUUID() },
          ]),
          "extra-cost",
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await send(
          ordered!,
          body(ordered!, [
            {
              actualUnitCost: "1.23456",
              purchaseOrderItemId: ordered!.items[0]!.id,
            },
            {
              actualUnitCost: "-1",
              purchaseOrderItemId: ordered!.items[1]!.id,
            },
          ]),
          "invalid-cost",
        )
      ).status,
    ).toBe(400);
    for (const [index, vat] of [
      { ...noVat, organizationVatRegistered: "true" },
      {
        ...noVat,
        inputVatAmount: "7",
        inputVatRate: "7",
        organizationVatRegistered: false,
      },
      { ...noVat, supplierTaxDocumentDate: "2026-02-30" },
      { ...noVat, supplierTaxDocumentNumber: "   " },
    ].entries()) {
      expect(
        (
          await send(
            ordered!,
            body(ordered!, body(ordered!).actualCosts, vat),
            `invalid-vat-${index}`,
          )
        ).status,
      ).toBe(400);
    }
    expect(
      (
        await send(
          ordered!,
          body(ordered!, body(ordered!).actualCosts, {
            ...noVat,
            inputVatAmount: "7",
          }),
          "invalid-vat",
        )
      ).status,
    ).toBe(400);
    expect((await send(draft!, body(draft!), "draft")).status).toBe(409);
    expect((await send(cancelled!, body(cancelled!), "cancelled")).status).toBe(
      409,
    );

    await prisma.product.update({
      data: { status: "INACTIVE" },
      where: { id: value.products[0]!.id },
    });
    expect(
      (await send(ordered!, body(ordered!), "inactive-product")).status,
    ).toBe(409);
    await prisma.product.update({
      data: { status: "ACTIVE" },
      where: { id: value.products[0]!.id },
    });
    await prisma.branch.update({
      data: { deactivatedAt: NOW, status: "INACTIVE" },
      where: { id: value.branch.id },
    });
    expect(
      (await send(ordered!, body(ordered!), "inactive-branch")).status,
    ).toBe(409);
    expect(
      (
        await receive({
          base,
          body: body(ordered!),
          branchId: value.branch.id,
          idempotencyKey: "missing-order",
          organizationId: value.organization.id,
          purchaseOrderId: randomUUID(),
          token,
        })
      ).status,
    ).toBe(404);
    expect(await prisma.purchaseReceipt.count()).toBe(0);
    expect(await prisma.inventoryTransaction.count()).toBe(0);
  });
});
