import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createApp } from "../../app.ts";
import type { ApiLogger } from "../../logger.ts";
import { startApiServer, type RunningApiServer } from "../../server.ts";
import { createSessionAuthenticationMiddleware } from "../identity/authentication-context.ts";
import type { AiAnalysisRun } from "../../generated/prisma/client.ts";
import {
  publicAnalysisRun,
  type AiAnalysisRunView,
} from "./ai-analysis-store.ts";
import { createAiAnalysisRouter } from "./ai-analysis-router.ts";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const BRANCH_ID = "20000000-0000-4000-8000-000000000001";
const RUN_ID = "70000000-0000-4000-8000-000000000001";
const TOKEN = "A".repeat(43);
const TEST_COOKIE_NAME = "stockwise_test_session";
const logger: ApiLogger = { error() {}, info() {} };

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

const row: AiAnalysisRun = {
  actorUserId: "trusted-user-id",
  branchId: null,
  contentEn: englishText,
  contentTh: thaiText,
  createdAt: new Date("2026-11-16T03:00:00.000Z"),
  days: 7,
  id: RUN_ID,
  localFrom: new Date("2026-11-09T00:00:00.000Z"),
  localTo: new Date("2026-11-16T00:00:00.000Z"),
  model: "deepseek-v4.1-flash",
  organizationId: ORGANIZATION_ID,
  reportingTimezone: "Asia/Bangkok",
  updatedAt: new Date("2026-11-16T03:00:00.000Z"),
};

const run: AiAnalysisRunView = publicAnalysisRun(row);

const errorCodeSchema = z.object({ error: z.object({ code: z.string() }) });

async function errorCode(response: Response): Promise<string> {
  return errorCodeSchema.parse(await response.json()).error.code;
}

const headers = {
  "content-type": "application/json",
  cookie: `${TEST_COOKIE_NAME}=${TOKEN}`,
};

describe("AI analysis routes", () => {
  let server: RunningApiServer | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  async function start({
    authorized = true,
    analyzeResult = { kind: "ok" as const, run },
    retryResult = { kind: "ok" as const, run },
    listResult = { items: [run], nextCursor: null as string | null },
    foundRow = row,
  }: {
    authorized?: boolean;
    analyzeResult?: Awaited<
      ReturnType<
        Parameters<typeof createAiAnalysisRouter>[0]["service"]["analyze"]
      >
    >;
    retryResult?: Awaited<
      ReturnType<
        Parameters<typeof createAiAnalysisRouter>[0]["service"]["retry"]
      >
    >;
    listResult?: {
      items: AiAnalysisRunView[];
      nextCursor: string | null;
    } | null;
    foundRow?: AiAnalysisRun | null;
  } = {}) {
    const authenticationMiddleware = createSessionAuthenticationMiddleware(
      async (request) =>
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
    const authorize = vi.fn(async () => authorized);
    const analyze = vi.fn(async () => analyzeResult);
    const retry = vi.fn(async () => retryResult);
    const list = vi.fn(async () => listResult);
    const find = vi.fn(async () => foundRow);
    const router = createAiAnalysisRouter({
      authenticationMiddleware,
      reader: { authorize },
      service: { analyze, retry },
      store: { find, list },
    });
    server = await startApiServer(createApp({ apiRouter: router, logger }), {
      host: "127.0.0.1",
      port: 0,
    });
    return {
      analyze,
      authorize,
      list,
      retry,
      url: `http://${server.address.host}:${server.address.port}/api/v1/organizations/${ORGANIZATION_ID}/ai-analysis/runs`,
    };
  }

  function post(url: string, body: unknown, query = "scope=organization") {
    return fetch(`${url}?${query}`, {
      body: JSON.stringify(body),
      headers,
      method: "POST",
    });
  }

  it("creates a run and reports both languages", async () => {
    const { analyze, authorize, url } = await start();
    const response = await post(url, { days: 14 });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ data: run });
    expect(authorize).toHaveBeenCalledWith({
      actorUserId: "trusted-user-id",
      organizationId: ORGANIZATION_ID,
      scope: { kind: "organization" },
    });
    expect(analyze).toHaveBeenCalledWith({
      actorUserId: "trusted-user-id",
      days: 14,
      organizationId: ORGANIZATION_ID,
      scope: { kind: "organization" },
    });
  });

  it("takes scope from the query and rejects client-owned fields", async () => {
    const { analyze, url } = await start();
    const withLanguage = await post(url, { language: "th" });
    expect(withLanguage.status).toBe(400);
    const withScope = await post(
      url,
      { days: 7, branchId: BRANCH_ID },
      "scope=organization",
    );
    expect(withScope.status).toBe(400);
    expect(analyze).not.toHaveBeenCalled();

    const branch = await post(url, {}, `scope=branch&branchId=${BRANCH_ID}`);
    expect(branch.status).toBe(200);
    expect(analyze).toHaveBeenCalledWith(
      expect.objectContaining({
        days: 7,
        scope: { kind: "branch", branchId: BRANCH_ID },
      }),
    );
  });

  it("forbids before touching the service", async () => {
    const { analyze, authorize, list, retry, url } = await start({
      authorized: false,
    });
    for (const response of [
      await post(url, {}),
      await fetch(`${url}?scope=organization`, { headers }),
      await post(`${url}/${RUN_ID}/retry`, { language: "th" }),
    ]) {
      expect(response.status).toBe(403);
      expect(await errorCode(response)).toBe("FORBIDDEN");
    }
    // A detail read of a scope the actor cannot see is a 404, not a 403.
    const detail = await fetch(`${url}/${RUN_ID}`, { headers });
    expect(detail.status).toBe(404);
    expect(authorize).toHaveBeenCalledTimes(4);
    expect(analyze).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it("returns 429 with Retry-After seconds", async () => {
    const { url } = await start({
      analyzeResult: { kind: "rate_limited", retryAfterSeconds: 42 },
    });
    const response = await post(url, {});
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("42");
    expect(await errorCode(response)).toBe("RATE_LIMITED");
  });

  it("maps provider outcomes to 502 and an unavailable snapshot to 404", async () => {
    const provider = await start({
      analyzeResult: { category: "TIMEOUT", kind: "provider_failed" },
    });
    expect((await post(provider.url, {})).status).toBe(502);
    const rejected = await start({ analyzeResult: { kind: "rejected" } });
    const rejectedResponse = await post(rejected.url, {});
    expect(rejectedResponse.status).toBe(502);
    expect(await errorCode(rejectedResponse)).toBe("AI_RESPONSE_REJECTED");
    const missing = await start({ analyzeResult: { kind: "not_found" } });
    expect((await post(missing.url, {})).status).toBe(404);
  });

  it("maps insufficient_data to 422 without a retry hint", async () => {
    const { analyze, url } = await start({
      analyzeResult: { kind: "insufficient_data" },
    });
    const response = await post(url, { days: 30 });
    expect(response.status).toBe(422);
    expect(await errorCode(response)).toBe("INSUFFICIENT_DATA");
    expect(response.headers.get("retry-after")).toBeNull();
    expect(response.headers.get("cache-control")).toBeNull();
    expect(analyze).toHaveBeenCalledTimes(1);
  });

  it("pages the history newest first", async () => {
    const { list, url } = await start({
      listResult: { items: [run], nextCursor: RUN_ID },
    });
    const response = await fetch(`${url}?scope=organization&limit=5`, {
      headers,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: [run],
      meta: { nextCursor: RUN_ID },
    });
    expect(list).toHaveBeenCalledWith({
      branchId: null,
      limit: 5,
      organizationId: ORGANIZATION_ID,
    });
  });

  it("rejects an invalid cursor and an out-of-range limit", async () => {
    const { list, url } = await start({ listResult: null });
    const cursor = await fetch(`${url}?scope=organization&cursor=${RUN_ID}`, {
      headers,
    });
    expect(cursor.status).toBe(400);
    expect(await errorCode(cursor)).toBe("INVALID_CURSOR");
    expect(list).toHaveBeenCalledTimes(1);
    expect(
      (await fetch(`${url}?scope=organization&limit=51`, { headers })).status,
    ).toBe(400);
    expect(
      (await fetch(`${url}?scope=organization&limit=0`, { headers })).status,
    ).toBe(400);
  });

  it("hides runs of an unauthorized scope behind the same 404", async () => {
    const { authorize, url } = await start({ authorized: false });
    const response = await fetch(`${url}/${RUN_ID}`, { headers });
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe("NOT_FOUND");
    expect(authorize).toHaveBeenCalledTimes(1);
  });

  it("returns a stored run authorized against its own scope", async () => {
    const { authorize, url } = await start();
    const response = await fetch(`${url}/${RUN_ID}`, { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: run });
    expect(authorize).toHaveBeenCalledWith({
      actorUserId: "trusted-user-id",
      organizationId: ORGANIZATION_ID,
      scope: { kind: "organization" },
    });
  });

  it("returns 404 for a missing run without authorizing anything", async () => {
    const { authorize, url } = await start({ foundRow: null });
    const response = await fetch(`${url}/${RUN_ID}`, { headers });
    expect(response.status).toBe(404);
    expect(authorize).not.toHaveBeenCalled();
  });

  it("requires a language to retry and forwards the scope", async () => {
    const { retry, url } = await start();
    expect(
      (
        await post(
          `${url}/${RUN_ID}/retry`,
          { language: "en" },
          "scope=organization",
        )
      ).status,
    ).toBe(200);
    expect(
      (await post(`${url}/${RUN_ID}/retry`, {}, "scope=organization")).status,
    ).toBe(400);
    expect(
      (
        await post(
          `${url}/${RUN_ID}/retry`,
          { language: "en", runId: "forged" },
          "scope=organization",
        )
      ).status,
    ).toBe(400);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(retry).toHaveBeenCalledWith({
      actorUserId: "trusted-user-id",
      language: "en",
      organizationId: ORGANIZATION_ID,
      runId: RUN_ID,
      scope: { kind: "organization" },
    });
  });

  it("rejects an unauthenticated request", async () => {
    const { url } = await start();
    const response = await fetch(`${url}?scope=organization`);
    expect(response.status).toBe(401);
  });
});
