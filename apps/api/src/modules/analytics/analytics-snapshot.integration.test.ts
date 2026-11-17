import { randomUUID } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  createTestPrismaClient,
  resetTestDatabase,
} from "../../test/database-harness.ts";
import { loadTestDatabaseEnvironment } from "../../test/database-environment.ts";
import { createAnalyticsSnapshotService } from "./analytics-snapshot-service.ts";
import {
  AnalyticsSnapshotConflictError,
  analyticsSnapshotPayloadSchema,
  createPrismaAnalyticsSnapshotStore,
} from "./analytics-snapshot-store.ts";

const environment = loadTestDatabaseEnvironment();
const prisma = createTestPrismaClient(environment);
const service = createAnalyticsSnapshotService(prisma);
const request = (organizationId: string, branchId: string) => ({
  organizationId,
  scope: { kind: "branch" as const, branchId },
  from: "2026-09-20",
  to: "2026-09-21",
  granularity: "day" as const,
});

async function setup() {
  const organization = await prisma.organization.create({
    data: { name: "Private name", reportingTimezone: "Asia/Bangkok" },
  });
  const branch = await prisma.branch.create({
    data: {
      organizationId: organization.id,
      code: "B",
      name: "Private branch",
    },
  });
  return { organization, branch };
}

async function addSale(organizationId: string, branchId: string) {
  const user = await prisma.user.create({
    data: {
      email: `${randomUUID()}@example.test`,
    },
  });
  const membership = await prisma.organizationMembership.create({
    data: { organizationId, userId: user.id, role: "OWNER" },
  });
  const product = await prisma.product.create({
    data: {
      organizationId,
      name: "Private product",
      sku: `SKU-${randomUUID().replaceAll("-", "").toUpperCase()}`,
      unit: "EA",
      basePrice: "100",
    },
  });
  const sale = await prisma.sale.create({
    data: {
      organizationId,
      branchId,
      actorUserId: user.id,
      actorMembershipId: membership.id,
      reference: `SALE-${randomUUID()}`,
      organizationNameSnapshot: "Private name",
      branchNameSnapshot: "Private branch",
      branchCodeSnapshot: "B",
      actorDisplayNameSnapshot: "Private actor",
      subtotalAmount: "100",
      salesVatStatusSnapshot: "NOT_REGISTERED",
      outputVatAmount: "0",
      totalAmount: "100",
      idempotencyKeyHash: randomUUID().replaceAll("-", "").padEnd(64, "0"),
      canonicalRequestHash: randomUUID().replaceAll("-", "").padEnd(64, "0"),
      completedAt: new Date("2026-09-20T05:00:00.000Z"),
    },
  });
  await prisma.saleItem.create({
    data: {
      saleId: sale.id,
      organizationId,
      branchId,
      productId: product.id,
      productSkuSnapshot: product.sku,
      productNameSnapshot: product.name,
      productUnitSnapshot: "EA",
      quantity: "1",
      unitPrice: "100",
      lineGross: "100",
      lineDiscount: "0",
      lineNet: "100",
      lineOutputVat: "0",
      costBasisState: "UNKNOWN",
    },
  });
}

describe("analytics snapshot store", () => {
  beforeEach(async () => resetTestDatabase(environment));
  afterAll(async () => {
    await resetTestDatabase(environment);
    await prisma.$disconnect();
  });

  it("builds a completed cost-aware aggregate and preserves tenant, period, and source provenance", async () => {
    const { organization, branch } = await setup();
    await addSale(organization.id, branch.id);
    const snapshot = await service.create(request(organization.id, branch.id));
    expect(snapshot).toMatchObject({
      organizationId: organization.id,
      branchId: branch.id,
      scope: "BRANCH",
      cadence: "DAILY",
      reportingTimezone: "Asia/Bangkok",
      localFromInclusive: "2026-09-20",
      localToExclusive: "2026-09-21",
      schemaVersion: "analytics-snapshot-v1",
      metricDefinitionVersion: "analytics-v1",
      dataStatus: "complete",
      payload: {
        sales: {
          netSalesAmount: "100.00",
          saleCount: 1,
          refundAmount: "0.00",
          costCoverage: "none",
          grossProfitAmount: {
            value: null,
            reason: "INCOMPLETE_COST_COVERAGE",
          },
        },
      },
    });
    expect(snapshot.periodStartInclusive).toEqual(
      new Date("2026-09-19T17:00:00.000Z"),
    );
    expect(snapshot.periodEndExclusive).toEqual(
      new Date("2026-09-20T17:00:00.000Z"),
    );
    expect(snapshot.sourceCutoff.getTime()).toBeGreaterThan(
      snapshot.periodEndExclusive.getTime(),
    );
    expect(JSON.stringify(snapshot.payload)).not.toMatch(
      /Private|organizationId|branchId|productId|userId|email/,
    );
    expect((await service.findById(organization.id, snapshot.id))?.id).toBe(
      snapshot.id,
    );
    expect(await service.findById(randomUUID(), snapshot.id)).toBeNull();
    await expect(
      prisma.analyticsSnapshot.update({
        where: { id: snapshot.id },
        data: { dataStatus: "complete" },
      }),
    ).rejects.toThrow();
  });

  it("keeps one row for exact and concurrent reruns, and rejects changed facts", async () => {
    const { organization, branch } = await setup();
    const input = request(organization.id, branch.id);
    const [left, right] = await Promise.all([
      service.create(input),
      service.create(input),
    ]);
    expect(left.id).toBe(right.id);
    expect((await service.create(input)).id).toBe(left.id);
    expect(await prisma.analyticsSnapshot.count()).toBe(1);
    expect(left.payload.sales.netSalesAmount).toBe("0.00");
    await addSale(organization.id, branch.id);
    await expect(service.create(input)).rejects.toBeInstanceOf(
      AnalyticsSnapshotConflictError,
    );
    expect(await prisma.analyticsSnapshot.count()).toBe(1);
  });

  it("separates organization and branch scope, rejects foreign branches, and retains inactive Branch history", async () => {
    const first = await setup();
    const second = await setup();
    const org = await service.create({
      ...request(first.organization.id, first.branch.id),
      scope: { kind: "organization" },
    });
    const branch = await service.create(
      request(first.organization.id, first.branch.id),
    );
    expect(org.id).not.toBe(branch.id);
    expect(org.branchId).toBeNull();
    expect(org.scopeKey).toBe("organization");
    expect(await prisma.analyticsSnapshot.count()).toBe(2);
    await expect(
      service.create(request(first.organization.id, second.branch.id)),
    ).rejects.toThrow("scope is unavailable");
    await prisma.branch.update({
      where: { id: first.branch.id },
      data: { status: "INACTIVE", deactivatedAt: new Date() },
    });
    expect(
      (await service.create(request(first.organization.id, first.branch.id)))
        .id,
    ).toBe(branch.id);
  });

  it("validates the closed payload and canonical field order on read and rerun", async () => {
    const { organization, branch } = await setup();
    const snapshot = await service.create(request(organization.id, branch.id));
    expect(() =>
      analyticsSnapshotPayloadSchema.parse({
        ...snapshot.payload,
        email: "x@example.test",
      }),
    ).toThrow();
    expect(() =>
      analyticsSnapshotPayloadSchema.parse({
        sales: { ...snapshot.payload.sales, netSalesAmount: "0" },
      }),
    ).toThrow();
    const reversed = {
      sales: Object.fromEntries(
        Object.entries(snapshot.payload.sales).reverse(),
      ),
    };
    const parsed = analyticsSnapshotPayloadSchema.parse(reversed);
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(snapshot.payload));
    const store = createPrismaAnalyticsSnapshotStore(prisma);
    expect((await store.findByIdentity(snapshot))?.id).toBe(snapshot.id);
    expect(snapshot.payload.sales.saleCount).toBe(0); // A valid zero remains narratable.
  });

  it("distinguishes all cadences and a changed reporting timezone", async () => {
    const { organization, branch } = await setup();
    const base = request(organization.id, branch.id);
    const daily = await service.create(base);
    const weekly = await service.create({
      ...base,
      from: "2026-09-14",
      to: "2026-09-21",
      granularity: "week",
    });
    const monthly = await service.create({
      ...base,
      from: "2026-08-01",
      to: "2026-09-01",
      granularity: "month",
    });
    const yearly = await service.create({
      ...base,
      from: "2025-01-01",
      to: "2026-01-01",
      granularity: "year",
    });
    expect([
      daily.cadence,
      weekly.cadence,
      monthly.cadence,
      yearly.cadence,
    ]).toEqual(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]);
    await prisma.organization.update({
      where: { id: organization.id },
      data: { reportingTimezone: "UTC" },
    });
    const utcDaily = await service.create(base);
    expect(utcDaily.id).not.toBe(daily.id);
    expect(utcDaily.periodStartInclusive).toEqual(
      new Date("2026-09-20T00:00:00.000Z"),
    );
    expect(await prisma.analyticsSnapshot.count()).toBe(5);
  });
});
