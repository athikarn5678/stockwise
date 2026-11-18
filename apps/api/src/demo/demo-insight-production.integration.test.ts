import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadTestDatabaseEnvironment } from "../test/database-environment.ts";
import {
  createTestPrismaClient,
  resetTestDatabase,
} from "../test/database-harness.ts";
import { createAnalyticsDimensionCursorCodec } from "../modules/analytics/analytics-dimension-cursor.ts";
import {
  createDemoInsightReader,
  DEMO_INSIGHT_PRODUCTION_ORGANIZATION_ID,
} from "../modules/ai-insights/demo-insight.ts";
import { bootstrapDemo90d, demo90dCatalog } from "./demo-90d-bootstrap.ts";
import { runDemo30d } from "./demo-30d-runner.ts";

// Same gating as the other demo suites: the runner attests the receipt itself.
const configured =
  !!process.env.TEST_DATABASE_URL && !!process.env.TEST_DISPOSABLE_RECEIPT;
const suite = describe.skipIf(!configured);
const environment = loadTestDatabaseEnvironment();
const prisma = createTestPrismaClient(environment);
const cursorCodec = createAnalyticsDimensionCursorCodec(Buffer.alloc(32, 7));
const catalog = demo90dCatalog();
const organizationId = catalog.organization.id;
const ownerId = catalog.users.find((u) => u.role === "OWNER")!.id;
const request = {
  actorUserId: ownerId,
  language: "th" as const,
  organizationId,
  scope: { kind: "organization" } as const,
};

suite("Demo Insight in the production runtime (ADR-048)", () => {
  beforeAll(async () => {
    await resetTestDatabase(environment);
    await prisma.$executeRaw`DROP SCHEMA IF EXISTS stockwise_demo CASCADE`;
    await bootstrapDemo90d(prisma, {
      password: "M4-S2-Integration-Demo-2026!",
      createdAt: new Date("2026-10-01T00:00:00.000Z"),
    });
    await runDemo30d(prisma, {
      organizationId,
      referenceDate: "2026-11-17",
      seed: 5,
      // Smallest shaped plan keeps the suite fast.
      shape: { adjustments: false, branchLimit: 1, days: 15, productLimit: 3 },
      apply: true,
    });
  }, 600_000);
  afterAll(async () => {
    await resetTestDatabase(environment);
    await prisma.$disconnect();
  });

  const reader = (configuredOrganizationId: string | undefined) =>
    createDemoInsightReader({
      prisma,
      cursorCodec,
      runtimeEnvironment: "production",
      organizationId: configuredOrganizationId,
    });

  it("targets exactly the deterministic demo organization", () => {
    expect(DEMO_INSIGHT_PRODUCTION_ORGANIZATION_ID).toBe(organizationId);
  });

  it("is on for the allowlisted demo organization, labelled and without provider calls", async () => {
    for (const [language, label] of [
      ["th", "ข้อมูลตัวอย่าง"],
      ["en", "Demo Insight"],
    ] as const) {
      const result = await reader(organizationId).read({
        ...request,
        language,
      });
      expect(result.kind).toBe("success");
      if (result.kind !== "success") return;
      expect(result.insight.label).toBe(label);
      expect(result.insight.providerCalls).toBe(0);
      expect(result.insight.provider).toBeNull();
    }
  });

  it("is off when the variable is unset", async () => {
    expect(await reader(undefined).read(request)).toEqual({
      kind: "not_found",
    });
  });

  it("is off for any other organization, even if the variable names it", async () => {
    const other = "11111111-1111-4111-8111-111111111111";
    // Variable names another organization: the production allowlist refuses it.
    expect(
      await reader(other).read({ ...request, organizationId: other }),
    ).toEqual({ kind: "not_found" });
    // Variable names the demo organization but the request targets another one.
    // (Ordinary authorization refuses a non-member before the allowlist is consulted.)
    expect(
      await reader(organizationId).read({ ...request, organizationId: other }),
    ).toEqual({ kind: "forbidden" });
  });
});
