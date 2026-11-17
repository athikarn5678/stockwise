import { randomUUID } from "node:crypto";
import { Router } from "express";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../../app.ts";
import { Prisma } from "../../generated/prisma/client.ts";
import type { ApiLogger } from "../../logger.ts";
import { startApiServer, type RunningApiServer } from "../../server.ts";
import {
  createTestPrismaClient,
  resetTestDatabase,
} from "../../test/database-harness.ts";
import { loadTestDatabaseEnvironment } from "../../test/database-environment.ts";
import {
  createNativeTestAuthenticationMiddleware,
  createNativeTestSession,
} from "../../test/native-session-fixture.ts";
import { createAnalyticsSnapshotService } from "../analytics/analytics-snapshot-service.ts";
import { createAiInsightRouter } from "./ai-insight-router.ts";
import { createPrismaAiInsightReader } from "./ai-insight-store.ts";

const environment = loadTestDatabaseEnvironment();
const prisma = createTestPrismaClient(environment);
const now = new Date("2026-10-10T12:00:00.000Z");
const logger: ApiLogger = { error() {}, info() {} };
type Role =
  "OWNER" | "ADMIN" | "BRANCH_MANAGER" | "INVENTORY_STAFF" | "CASHIER";
let server: RunningApiServer | undefined;
type HttpInsight = { id: string; content: string | null };
type HttpBody = {
  data: HttpInsight[] & {
    id: string;
    content: string | null;
    latest: HttpInsight | null;
    lastSuccess: HttpInsight | null;
    stale: boolean;
  };
  meta: { nextCursor: string | null };
};

async function actor(organizationId: string, role: Role, branchId?: string) {
  const user = await prisma.user.create({
    data: {
      email: `${randomUUID()}@example.test`,
      emailVerifiedAt: now,
      passwordHash: "insight-api-test",
    },
  });
  await prisma.organizationMembership.create({
    data: { organizationId, role, userId: user.id },
  });
  if (branchId !== undefined)
    await prisma.branchAssignment.create({
      data: { organizationId, branchId, userId: user.id },
    });
  const session = await createNativeTestSession(prisma, user.id, {
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date("2026-10-11T12:00:00.000Z"),
  });
  return session.cookie;
}

async function fixture() {
  const organization = await prisma.organization.create({
    data: { name: "Private organization", reportingTimezone: "Asia/Bangkok" },
  });
  const other = await prisma.organization.create({
    data: { name: "Other organization", reportingTimezone: "Asia/Bangkok" },
  });
  const branch = await prisma.branch.create({
    data: {
      organizationId: organization.id,
      code: "A",
      name: "Private branch",
    },
  });
  const unassigned = await prisma.branch.create({
    data: { organizationId: organization.id, code: "B", name: "Unassigned" },
  });
  const foreign = await prisma.branch.create({
    data: { organizationId: other.id, code: "C", name: "Foreign" },
  });
  return {
    organization,
    other,
    branch,
    unassigned,
    foreign,
    owner: await actor(organization.id, "OWNER"),
    admin: await actor(organization.id, "ADMIN"),
    manager: await actor(organization.id, "BRANCH_MANAGER", branch.id),
    inventory: await actor(organization.id, "INVENTORY_STAFF", branch.id),
    cashier: await actor(organization.id, "CASHIER", branch.id),
    outsider: await actor(other.id, "OWNER"),
  };
}

async function report(
  organizationId: string,
  day: number,
  options: {
    branchId?: string;
    state?: "SUCCEEDED" | "FAILED" | "INSUFFICIENT" | "IN_PROGRESS";
    cadence?: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
    schemaVersion?: string;
    generatedAt?: Date;
    failureCategory?: "TIMEOUT" | "AUTHENTICATION";
  } = {},
) {
  const period =
    options.cadence === "WEEKLY"
      ? { from: "2026-09-14", to: "2026-09-21", granularity: "week" as const }
      : options.cadence === "MONTHLY"
        ? {
            from: "2026-08-01",
            to: "2026-09-01",
            granularity: "month" as const,
          }
        : options.cadence === "YEARLY"
          ? {
              from: "2025-01-01",
              to: "2026-01-01",
              granularity: "year" as const,
            }
          : {
              from: `2026-09-${String(day).padStart(2, "0")}`,
              to: `2026-09-${String(day + 1).padStart(2, "0")}`,
              granularity: "day" as const,
            };
  const snapshot = await createAnalyticsSnapshotService(prisma).create({
    organizationId,
    scope:
      options.branchId === undefined
        ? { kind: "organization" }
        : { kind: "branch", branchId: options.branchId },
    ...period,
  });
  const state = options.state ?? "SUCCEEDED";
  return prisma.aiInsightReport.create({
    data: {
      organizationId,
      branchId: options.branchId ?? null,
      scope: options.branchId === undefined ? "ORGANIZATION" : "BRANCH",
      scopeKey: options.branchId ?? "organization",
      cadence: options.cadence ?? "DAILY",
      reportingTimezone: snapshot.reportingTimezone,
      periodStartInclusive: snapshot.periodStartInclusive,
      periodEndExclusive: snapshot.periodEndExclusive,
      snapshotId: snapshot.id,
      schemaVersion: options.schemaVersion ?? snapshot.schemaVersion,
      metricDefinitionVersion: snapshot.metricDefinitionVersion,
      sourceCutoff: snapshot.sourceCutoff,
      promptVersion: "ai-business-summary-prompt-v1",
      state,
      attemptCount:
        state === "INSUFFICIENT" ||
        state === "IN_PROGRESS" ||
        options.failureCategory === "AUTHENTICATION"
          ? 0
          : 1,
      ...(state === "SUCCEEDED"
        ? {
            content: `Period ${day} summary <script>alert(1)</script>`,
            provider: "openrouter",
            actualModel: "openai/gpt-4o-mini",
            generatedAt: options.generatedAt ?? now,
            completedAt: options.generatedAt ?? now,
          }
        : state === "FAILED"
          ? {
              failureCategory: options.failureCategory ?? "TIMEOUT",
              ...(options.failureCategory === "AUTHENTICATION"
                ? {}
                : { provider: "openrouter" }),
              completedAt: now,
            }
          : state === "INSUFFICIENT"
            ? { completedAt: now }
            : {
                claimToken: randomUUID(),
                claimExpiresAt: new Date("2026-10-10T13:00:00.000Z"),
              }),
    },
  });
}

async function start() {
  const router = Router();
  router.use(
    createAiInsightRouter({
      authenticationMiddleware: createNativeTestAuthenticationMiddleware(
        prisma,
        {
          configuration: {
            absoluteTimeoutMilliseconds: 86_400_000,
            idleTimeoutMilliseconds: 86_400_000,
            secureCookie: false,
            touchIntervalMilliseconds: 900_000,
          },
          now: () => now,
        },
      ),
      reader: createPrismaAiInsightReader(prisma),
    }),
  );
  server = await startApiServer(createApp({ apiRouter: router, logger }), {
    host: "127.0.0.1",
    port: 0,
  });
}

async function get(organizationId: string, path: string, cookie?: string) {
  const response = await fetch(
    `http://127.0.0.1:${server!.address.port}/api/v1/organizations/${organizationId}/ai-insights${path}`,
    {
      headers: cookie === undefined ? {} : { Cookie: cookie },
    },
  );
  return { status: response.status, body: (await response.json()) as HttpBody };
}

describe("persisted AI insight reads", () => {
  beforeEach(async () => resetTestDatabase(environment));
  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });
  afterAll(async () => {
    await resetTestDatabase(environment);
    await prisma.$disconnect();
  });

  it("enforces all three permissions and current branch scope, including inactive history", async () => {
    const f = await fixture();
    const org = await report(f.organization.id, 20);
    const branch = await report(f.organization.id, 21, {
      branchId: f.branch.id,
    });
    await start();
    const organizationQuery = "/latest?scope=organization&cadence=DAILY";
    const branchQuery = `/latest?scope=branch&branchId=${f.branch.id}&cadence=DAILY`;
    expect((await get(f.organization.id, organizationQuery)).status).toBe(401);
    for (const cookie of [f.owner, f.admin]) {
      expect(
        (await get(f.organization.id, organizationQuery, cookie)).body.data
          .lastSuccess?.id,
      ).toBe(org.id);
      expect(
        (await get(f.organization.id, branchQuery, cookie)).body.data
          .lastSuccess?.id,
      ).toBe(branch.id);
    }
    expect((await get(f.organization.id, branchQuery, f.manager)).status).toBe(
      200,
    );
    expect(
      (await get(f.organization.id, organizationQuery, f.manager)).status,
    ).toBe(403);
    expect(
      (
        await get(
          f.organization.id,
          `/latest?scope=branch&branchId=${f.unassigned.id}&cadence=DAILY`,
          f.manager,
        )
      ).status,
    ).toBe(403);
    for (const cookie of [f.inventory, f.cashier, f.outsider])
      expect((await get(f.organization.id, branchQuery, cookie)).status).toBe(
        403,
      );
    expect(
      (
        await get(
          f.organization.id,
          `/latest?scope=branch&branchId=${f.foreign.id}&cadence=DAILY`,
          f.owner,
        )
      ).status,
    ).toBe(403);
    await prisma.branch.update({
      where: { id: f.branch.id },
      data: { status: "INACTIVE", deactivatedAt: now },
    });
    for (const cookie of [f.owner, f.admin]) {
      expect(
        (await get(f.organization.id, branchQuery, cookie)).body.data
          .lastSuccess?.id,
      ).toBe(branch.id);
      expect(
        (await get(f.organization.id, `/${branch.id}`, cookie)).status,
      ).toBe(200);
    }
    expect((await get(f.organization.id, branchQuery, f.manager)).status).toBe(
      403,
    );
    expect(
      (await get(f.organization.id, `/${branch.id}`, f.manager)).status,
    ).toBe(404);
    expect(await prisma.aiInsightReport.count()).toBe(2);
  });

  it("returns last success with newer failure or insufficient state, and explicit empty states", async () => {
    const f = await fixture();
    await start();
    const path = "/latest?scope=organization&cadence=DAILY";
    expect((await get(f.organization.id, path, f.owner)).body.data).toEqual({
      latest: null,
      lastSuccess: null,
      stale: false,
    });
    const emptyList = await get(
      f.organization.id,
      "?scope=organization&cadence=DAILY",
      f.owner,
    );
    expect(emptyList).toMatchObject({
      status: 200,
      body: { data: [], meta: { nextCursor: null } },
    });
    const success = await report(f.organization.id, 20);
    let result = await get(f.organization.id, path, f.owner);
    expect(result.body.data).toMatchObject({
      stale: false,
      latest: { id: success.id },
      lastSuccess: { id: success.id },
    });
    const failed = await report(f.organization.id, 21, { state: "FAILED" });
    result = await get(f.organization.id, path, f.owner);
    expect(result.body.data).toMatchObject({
      stale: true,
      latest: {
        id: failed.id,
        state: "FAILED",
        failureCategory: "TIMEOUT",
        content: null,
      },
      lastSuccess: { id: success.id },
    });
    const insufficient = await report(f.organization.id, 22, {
      state: "INSUFFICIENT",
    });
    result = await get(f.organization.id, path, f.owner);
    expect(result.body.data).toMatchObject({
      stale: true,
      latest: { id: insufficient.id, state: "INSUFFICIENT", content: null },
      lastSuccess: { id: success.id },
    });
    const yearly = await get(
      f.organization.id,
      "/latest?scope=organization&cadence=YEARLY",
      f.owner,
    );
    expect(yearly.body.data.lastSuccess).toBeNull();
    expect(yearly.body.data.latest).toBeNull();
    const inProgress = await report(f.organization.id, 23, {
      state: "IN_PROGRESS",
    });
    result = await get(f.organization.id, path, f.owner);
    expect(result.body.data).toMatchObject({
      stale: true,
      latest: {
        id: inProgress.id,
        state: "IN_PROGRESS",
        content: null,
        attemptCount: null,
        provider: null,
      },
      lastSuccess: { id: success.id },
    });
    const branchFailure = await report(f.organization.id, 24, {
      branchId: f.branch.id,
      state: "FAILED",
    });
    result = await get(
      f.organization.id,
      `/latest?scope=branch&branchId=${f.branch.id}&cadence=DAILY`,
      f.owner,
    );
    expect(result.body.data).toMatchObject({
      latest: { id: branchFailure.id, state: "FAILED" },
      lastSuccess: null,
      stale: true,
    });
  });

  it("lists newest business periods with bounded scoped cursors and safe detail", async () => {
    const f = await fixture();
    const first = await report(f.organization.id, 20);
    const second = await report(f.organization.id, 21, { state: "FAILED" });
    const third = await report(f.organization.id, 22, {
      state: "INSUFFICIENT",
    });
    const branch = await report(f.organization.id, 23, {
      branchId: f.branch.id,
    });
    const foreign = await report(f.other.id, 20);
    expect(first.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    await start();
    const query = "?scope=organization&cadence=DAILY&limit=2";
    const page = await get(f.organization.id, query, f.owner);
    expect(page.body.data.map((row: { id: string }) => row.id)).toEqual([
      third.id,
      second.id,
    ]);
    expect(page.body.meta.nextCursor).toBe(second.id);
    const next = await get(
      f.organization.id,
      `${query}&cursor=${second.id}`,
      f.owner,
    );
    expect(next.body.data.map((row: { id: string }) => row.id)).toEqual([
      first.id,
    ]);
    expect(next.body.meta.nextCursor).toBeNull();
    expect(
      (await get(f.organization.id, `${query}&cursor=${branch.id}`, f.owner))
        .status,
    ).toBe(400);
    expect(
      (await get(f.organization.id, `${query}&cursor=${foreign.id}`, f.owner))
        .status,
    ).toBe(400);
    expect(
      (await get(f.organization.id, `/${branch.id}`, f.manager)).status,
    ).toBe(200);
    expect(
      (await get(f.organization.id, `/${first.id}`, f.manager)).status,
    ).toBe(404);
    expect((await get(f.other.id, `/${first.id}`, f.outsider)).status).toBe(
      404,
    );
    expect(
      (await get(f.organization.id, `/${foreign.id}`, f.owner)).status,
    ).toBe(404);
    expect(
      (await get(f.organization.id, `/${randomUUID()}`, f.owner)).status,
    ).toBe(404);
    const detail = await get(f.organization.id, `/${first.id}`, f.owner);
    expect(detail.body.data.content).toContain("<script>");
    expect(JSON.stringify(detail.body)).not.toMatch(
      /claimToken|snapshotId|promptBody|apiKey|Private organization|Private branch/,
    );
  });

  it("keeps all four cadences separate within the same scope", async () => {
    const f = await fixture();
    const rows = await Promise.all([
      report(f.organization.id, 20, { cadence: "DAILY" }),
      report(f.organization.id, 20, { cadence: "WEEKLY" }),
      report(f.organization.id, 20, { cadence: "MONTHLY" }),
      report(f.organization.id, 20, { cadence: "YEARLY" }),
    ]);
    await start();
    for (const [index, cadence] of [
      "DAILY",
      "WEEKLY",
      "MONTHLY",
      "YEARLY",
    ].entries()) {
      const result = await get(
        f.organization.id,
        `/latest?scope=organization&cadence=${cadence}`,
        f.owner,
      );
      expect(result.body.data.lastSuccess?.id).toBe(rows[index]!.id);
    }
  });

  it("validates selectors and leaves jobs, snapshots and attempts unchanged", async () => {
    const f = await fixture();
    const success = await report(f.organization.id, 20);
    await start();
    for (const path of [
      "/latest?scope=organization&cadence=HOURLY",
      "/latest?scope=branch&cadence=DAILY",
      "/latest?scope=organization&branchId=" + f.branch.id + "&cadence=DAILY",
      "?scope=organization&cadence=DAILY&limit=101",
      "?scope=organization&cadence=DAILY&limit=1e2",
      "/latest?scope=organization&cadence=DAILY&unexpected=1",
    ])
      expect((await get(f.organization.id, path, f.owner)).status).toBe(400);
    const before = await prisma.aiInsightReport.findUniqueOrThrow({
      where: { id: success.id },
    });
    const snapshotCount = await prisma.analyticsSnapshot.count();
    const attemptCount = await prisma.aiInsightAttempt.count();
    await get(
      f.organization.id,
      "/latest?scope=organization&cadence=DAILY",
      f.owner,
    );
    await get(f.organization.id, "?scope=organization&cadence=DAILY", f.owner);
    await get(f.organization.id, `/${success.id}`, f.owner);
    expect(
      await prisma.aiInsightReport.findUniqueOrThrow({
        where: { id: success.id },
      }),
    ).toEqual(before);
    expect(await prisma.aiInsightReport.count()).toBe(1);
    expect(await prisma.analyticsSnapshot.count()).toBe(snapshotCount);
    expect(await prisma.aiInsightAttempt.count()).toBe(attemptCount);
  });

  it("fails closed on mismatched persisted snapshot provenance", async () => {
    const f = await fixture();
    const inconsistent = await report(f.organization.id, 20, {
      schemaVersion: "unsupported-v0",
    });
    await start();
    const result = await get(f.organization.id, `/${inconsistent.id}`, f.owner);
    expect(result.status).toBe(500);
    expect(JSON.stringify(result.body)).not.toMatch(
      /unsupported-v0|snapshotId|Private organization/,
    );
  });

  it("does not disclose provider credential state in a failed read", async () => {
    const f = await fixture();
    const failed = await report(f.organization.id, 20, {
      state: "FAILED",
      failureCategory: "AUTHENTICATION",
    });
    await start();
    const detail = await get(f.organization.id, `/${failed.id}`, f.owner);
    expect(detail.status).toBe(200);
    expect(detail.body.data).toMatchObject({
      state: "FAILED",
      failureCategory: "PROVIDER_ERROR",
      attemptCount: null,
      provider: null,
      actualModel: null,
      content: null,
    });
    expect(JSON.stringify(detail.body)).not.toMatch(
      /AUTHENTICATION|api.key|credential/i,
    );
  });

  it("reads a consistent older snapshot, metric and prompt version", async () => {
    const f = await fixture();
    const snapshot = await createAnalyticsSnapshotService(prisma).create({
      organizationId: f.organization.id,
      scope: { kind: "organization" },
      from: "2026-09-20",
      to: "2026-09-21",
      granularity: "day",
    });
    const historical = await prisma.analyticsSnapshot.create({
      data: {
        organizationId: snapshot.organizationId,
        branchId: snapshot.branchId,
        scope: snapshot.scope,
        scopeKey: snapshot.scopeKey,
        cadence: snapshot.cadence,
        reportingTimezone: snapshot.reportingTimezone,
        localFromInclusive: snapshot.localFromInclusive,
        localToExclusive: snapshot.localToExclusive,
        periodStartInclusive: snapshot.periodStartInclusive,
        periodEndExclusive: snapshot.periodEndExclusive,
        schemaVersion: "analytics-snapshot-v0",
        metricDefinitionVersion: "analytics-v0",
        sourceCutoff: snapshot.sourceCutoff,
        dataStatus: snapshot.dataStatus,
        payload: snapshot.payload as Prisma.InputJsonValue,
      },
    });
    const insight = await prisma.aiInsightReport.create({
      data: {
        organizationId: f.organization.id,
        branchId: null,
        scope: "ORGANIZATION",
        scopeKey: "organization",
        cadence: historical.cadence,
        reportingTimezone: historical.reportingTimezone,
        periodStartInclusive: historical.periodStartInclusive,
        periodEndExclusive: historical.periodEndExclusive,
        snapshotId: historical.id,
        schemaVersion: historical.schemaVersion,
        metricDefinitionVersion: historical.metricDefinitionVersion,
        sourceCutoff: historical.sourceCutoff,
        promptVersion: "ai-business-summary-prompt-v0",
        state: "SUCCEEDED",
        attemptCount: 1,
        provider: "openrouter",
        actualModel: "openai/gpt-4o-mini",
        content: "A retained historical summary.",
        generatedAt: now,
        completedAt: now,
      },
    });
    await start();
    const detail = await get(f.organization.id, `/${insight.id}`, f.owner);
    expect(detail.status).toBe(200);
    expect(detail.body.data).toMatchObject({
      schemaVersion: "analytics-snapshot-v0",
      metricDefinitionVersion: "analytics-v0",
      promptVersion: "ai-business-summary-prompt-v0",
      content: "A retained historical summary.",
    });
    const latest = await get(
      f.organization.id,
      "/latest?scope=organization&cadence=DAILY",
      f.owner,
    );
    expect(latest.body.data.lastSuccess?.id).toBe(insight.id);
  });

  it("orders business periods ahead of later completion times", async () => {
    const f = await fixture();
    const older = await report(f.organization.id, 20, {
      generatedAt: new Date("2026-10-10T12:00:00.000Z"),
    });
    const newer = await report(f.organization.id, 21, {
      generatedAt: new Date("2026-10-09T12:00:00.000Z"),
    });
    await start();
    const latest = await get(
      f.organization.id,
      "/latest?scope=organization&cadence=DAILY",
      f.owner,
    );
    expect(latest.body.data.latest?.id).toBe(newer.id);
    expect(latest.body.data.lastSuccess?.id).toBe(newer.id);
    expect(older.generatedAt!.getTime()).toBeGreaterThan(
      newer.generatedAt!.getTime(),
    );
  });
});
