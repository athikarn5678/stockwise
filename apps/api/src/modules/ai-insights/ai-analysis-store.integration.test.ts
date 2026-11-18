import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { Prisma } from "../../generated/prisma/client.ts";
import { loadTestDatabaseEnvironment } from "../../test/database-environment.ts";
import {
  createTestPrismaClient,
  resetTestDatabase,
} from "../../test/database-harness.ts";
import { createPrismaAiAnalysisStore } from "./ai-analysis-store.ts";

const environment = loadTestDatabaseEnvironment();
const prisma = createTestPrismaClient(environment);
const store = createPrismaAiAnalysisStore(prisma);

const thaiText = [
  "## ภาพรวม",
  "ยอดขายสุทธิ 1400.00",
  "## ยอดขาย",
  "ยอดคืนเงิน 50.00",
  "## สินค้าขายดีและขายช้า",
  "Food 900.00",
  "## ข้อสังเกต",
  "ต้นทุน unavailable",
  "## สิ่งที่ควรทำ",
  "ตรวจสอบ Drinks",
].join("\n");

const englishText = [
  "## Overview",
  "Net sales 1400.00",
  "## Sales",
  "Refunds 50.00",
  "## Products",
  "Food 900.00",
  "## Notes & risks",
  "Cost unavailable",
  "## Recommended actions",
  "Review Drinks",
].join("\n");

async function organization(name = "Sample shop") {
  return prisma.organization.create({ data: { name } });
}

async function branch(organizationId: string, code = "MAIN") {
  return prisma.branch.create({
    data: { code, name: `Branch ${code}`, organizationId },
  });
}

async function actor(email = "ai-analysis@example.com") {
  return prisma.user.create({ data: { email } });
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return null;
}

/** Prisma maps CHECK/FK violations to known errors; the pg adapter may keep the SQLSTATE. */
function isConstraintViolation(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) return true;
  const code = (error as { code?: unknown } | null)?.code;
  return code === "23514" || code === "23503" || code === "23505";
}

function run(
  input: Readonly<{
    actorUserId: string;
    branchId: string | null;
    days?: number;
    organizationId: string;
  }>,
) {
  return store.create({
    actorUserId: input.actorUserId,
    branchId: input.branchId,
    contentEn: englishText,
    contentTh: thaiText,
    days: input.days ?? 7,
    localFrom: "2026-11-09",
    localTo: "2026-11-16",
    model: "deepseek-v4.1-flash",
    organizationId: input.organizationId,
    reportingTimezone: "Asia/Bangkok",
  });
}

describe("AI analysis store with PostgreSQL", () => {
  beforeEach(async () => resetTestDatabase(environment));
  afterAll(async () => {
    await resetTestDatabase(environment);
    await prisma.$disconnect();
  });

  it("never finds or lists another organization's runs", async () => {
    const own = await organization();
    const other = await organization("Other tenant");
    const user = await actor();
    const stored = await run({
      actorUserId: user.id,
      branchId: null,
      organizationId: own.id,
    });

    await expect(store.find(other.id, stored.id)).resolves.toBeNull();
    const foreignList = await store.list({
      branchId: null,
      limit: 10,
      organizationId: other.id,
    });
    expect(foreignList?.items).toEqual([]);
    const ownList = await store.list({
      branchId: null,
      limit: 10,
      organizationId: own.id,
    });
    expect(ownList?.items.map((item) => item.id)).toEqual([stored.id]);
    // Actor ids never leave the store.
    expect(JSON.stringify(ownList)).not.toContain(user.id);
  });

  it("separates organization scope from each branch scope", async () => {
    const tenant = await organization();
    const alpha = await branch(tenant.id, "A");
    const beta = await branch(tenant.id, "B");
    const user = await actor();
    const organizationRun = await run({
      actorUserId: user.id,
      branchId: null,
      organizationId: tenant.id,
    });
    const alphaRun = await run({
      actorUserId: user.id,
      branchId: alpha.id,
      organizationId: tenant.id,
    });
    const betaRun = await run({
      actorUserId: user.id,
      branchId: beta.id,
      organizationId: tenant.id,
    });

    const ids = async (branchId: string | null) =>
      (
        await store.list({
          branchId,
          limit: 10,
          organizationId: tenant.id,
        })
      )?.items.map((item) => item.id);
    await expect(ids(null)).resolves.toEqual([organizationRun.id]);
    await expect(ids(alpha.id)).resolves.toEqual([alphaRun.id]);
    await expect(ids(beta.id)).resolves.toEqual([betaRun.id]);
  });

  it("pages newest first with a keyset cursor", async () => {
    const tenant = await organization();
    const user = await actor();
    const older = await run({
      actorUserId: user.id,
      branchId: null,
      organizationId: tenant.id,
    });
    const middle = await run({
      actorUserId: user.id,
      branchId: null,
      organizationId: tenant.id,
    });
    const newest = await run({
      actorUserId: user.id,
      branchId: null,
      organizationId: tenant.id,
    });
    // Explicit timestamps: sequential inserts can share one millisecond.
    const stamp = (id: string, at: string) =>
      prisma.aiAnalysisRun.update({
        where: { id },
        data: { createdAt: new Date(at) },
      });
    await stamp(older.id, "2026-11-14T03:00:00.000Z");
    await stamp(middle.id, "2026-11-15T03:00:00.000Z");
    await stamp(newest.id, "2026-11-16T03:00:00.000Z");

    const first = await store.list({
      branchId: null,
      limit: 2,
      organizationId: tenant.id,
    });
    expect(first?.items.map((item) => item.id)).toEqual([newest.id, middle.id]);
    expect(first?.nextCursor).toBe(middle.id);

    const second = await store.list({
      branchId: null,
      cursor: first!.nextCursor!,
      limit: 2,
      organizationId: tenant.id,
    });
    expect(second?.items.map((item) => item.id)).toEqual([older.id]);
    expect(second?.nextCursor).toBeNull();

    // A cursor from another scope is invalid, not an offset.
    const otherBranch = await branch(tenant.id, "B");
    await expect(
      store.list({
        branchId: otherBranch.id,
        cursor: middle.id,
        limit: 2,
        organizationId: tenant.id,
      }),
    ).resolves.toBeNull();
  });

  it("stores one language and fills the other only while it is null", async () => {
    const tenant = await organization();
    const user = await actor();
    const stored = await prisma.aiAnalysisRun.create({
      data: {
        actorUserId: user.id,
        contentEn: null,
        contentTh: thaiText,
        days: 14,
        localFrom: new Date("2026-11-02T00:00:00.000Z"),
        localTo: new Date("2026-11-16T00:00:00.000Z"),
        model: "deepseek-v4.1-flash",
        organizationId: tenant.id,
        reportingTimezone: "Asia/Bangkok",
      },
    });
    const view = await store.find(tenant.id, stored.id);
    expect(view).not.toBeNull();
    expect(
      await store.list({
        branchId: null,
        limit: 1,
        organizationId: tenant.id,
      }),
    ).toMatchObject({
      items: [
        {
          days: 14,
          id: stored.id,
          missing: ["en"],
          period: {
            from: "2026-11-02",
            scope: "organization",
            timezone: "Asia/Bangkok",
            to: "2026-11-16",
          },
        },
      ],
    });

    const filled = await store.fillLanguage({
      content: englishText,
      language: "en",
      model: "deepseek-v4.1-flash",
      organizationId: tenant.id,
      runId: stored.id,
    });
    expect(filled?.contentEn).toBe(englishText);
    // The Thai column is already present, so a second write is refused.
    await expect(
      store.fillLanguage({
        content: "## ภาพรวม\nเขียนทับ",
        language: "th",
        model: "deepseek-v4.1-flash",
        organizationId: tenant.id,
        runId: stored.id,
      }),
    ).resolves.toBeNull();
    const unchanged = await store.find(tenant.id, stored.id);
    expect(unchanged?.contentTh).toBe(thaiText);

    const missingRun = await store.fillLanguage({
      content: englishText,
      language: "en",
      model: "deepseek-v4.1-flash",
      organizationId: tenant.id,
      runId: "70000000-0000-4000-8000-0000000000ff",
    });
    expect(missingRun).toBeNull();
  });

  it("rejects a run without any stored language", async () => {
    const tenant = await organization();
    const user = await actor();
    const failure = await rejectionOf(
      prisma.aiAnalysisRun.create({
        data: {
          actorUserId: user.id,
          contentEn: null,
          contentTh: null,
          days: 7,
          localFrom: new Date("2026-11-09T00:00:00.000Z"),
          localTo: new Date("2026-11-16T00:00:00.000Z"),
          model: "deepseek-v4.1-flash",
          organizationId: tenant.id,
          reportingTimezone: "Asia/Bangkok",
        },
      }),
    );
    expect(isConstraintViolation(failure)).toBe(true);
    await expect(
      prisma.aiAnalysisRun.count({ where: { organizationId: tenant.id } }),
    ).resolves.toBe(0);
  });

  it("rejects a branch of another organization", async () => {
    const tenant = await organization();
    const other = await organization("Other tenant");
    const foreignBranch = await branch(other.id, "X");
    const user = await actor();
    const failure = await rejectionOf(
      run({
        actorUserId: user.id,
        branchId: foreignBranch.id,
        organizationId: tenant.id,
      }),
    );
    expect(isConstraintViolation(failure)).toBe(true);
  });
});
