import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../../app.ts";
import type { ApiLogger } from "../../logger.ts";
import { startApiServer, type RunningApiServer } from "../../server.ts";
import { createSessionAuthenticationMiddleware } from "../identity/authentication-context.ts";
import type { AiInsightReadReader } from "./ai-insight-store.ts";
import { createAiInsightRouter } from "./ai-insight-router.ts";
import type { AiAnalyzeServiceResult } from "./ai-analyze-service.ts";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const BRANCH_ID = "20000000-0000-4000-8000-000000000001";
const TOKEN = "A".repeat(43);
const TEST_COOKIE_NAME = "stockwise_test_session";
const logger: ApiLogger = { error() {}, info() {} };
const period = {
  days: 7,
  from: "2026-11-09",
  scope: "organization" as const,
  timezone: "Asia/Bangkok",
  to: "2026-11-16",
};
const success: AiAnalyzeServiceResult = {
  kind: "ok",
  language: "th",
  mock: true,
  period,
  sections: [{ body: "ข้อความ", heading: "ภาพรวม" }],
  text: "## ภาพรวม\nข้อความ",
};

describe("AI analyze route", () => {
  let server: RunningApiServer | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  async function start({
    authenticated = true,
    authorized = true,
    result = success,
  }: {
    authenticated?: boolean;
    authorized?: boolean;
    result?: AiAnalyzeServiceResult;
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
    const authorize = vi.fn(async () => authorized);
    const reader: AiInsightReadReader = {
      authorize,
      detail: vi.fn(async () => null),
      latest: vi.fn(async () => ({
        lastSuccess: null,
        latest: null,
        stale: false,
      })),
      list: vi.fn(async () => null),
    };
    const analyze = vi.fn(async () => result);
    const router = createAiInsightRouter({
      analyzeService: { analyze },
      authenticationMiddleware,
      reader,
    });
    server = await startApiServer(createApp({ apiRouter: router, logger }), {
      host: "127.0.0.1",
      port: 0,
    });
    return {
      analyze,
      authorize,
      url: `http://${server.address.host}:${server.address.port}/api/v1`,
    };
  }

  function request(
    url: string,
    body: unknown,
    query = "scope=organization",
  ): Promise<Response> {
    return fetch(
      `${url}/organizations/${ORGANIZATION_ID}/ai-insights/analyze?${query}`,
      {
        body: JSON.stringify(body),
        headers: {
          "content-type": "application/json",
          cookie: `${TEST_COOKIE_NAME}=${TOKEN}`,
        },
        method: "POST",
      },
    );
  }

  it("returns the analysis with a private cache policy", async () => {
    const { analyze, url } = await start();
    const response = await request(url, { language: "th" });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      data: {
        language: "th",
        mock: true,
        period,
        sections: [{ body: "ข้อความ", heading: "ภาพรวม" }],
        text: "## ภาพรวม\nข้อความ",
      },
    });
    expect(analyze).toHaveBeenCalledWith({
      actorUserId: "trusted-user-id",
      days: 7,
      language: "th",
      organizationId: ORGANIZATION_ID,
      scope: { kind: "organization" },
    });
  });

  it("takes scope from the query and rejects client-owned scope fields", async () => {
    const { analyze, url } = await start();
    const response = await request(
      url,
      { language: "en", organizationId: "forged", branchId: BRANCH_ID },
      `scope=branch&branchId=${BRANCH_ID}`,
    );
    expect(response.status).toBe(400);
    expect(analyze).not.toHaveBeenCalled();

    const scoped = await request(
      url,
      { days: 14, language: "en" },
      `scope=branch&branchId=${BRANCH_ID}`,
    );
    expect(scoped.status).toBe(200);
    expect(analyze).toHaveBeenCalledWith({
      actorUserId: "trusted-user-id",
      days: 14,
      language: "en",
      organizationId: ORGANIZATION_ID,
      scope: { branchId: BRANCH_ID, kind: "branch" },
    });
  });

  it("denies unauthenticated and unauthorized requests before analysis", async () => {
    const unauthenticated = await start({ authenticated: false });
    expect(
      (
        await fetch(
          `${unauthenticated.url}/organizations/${ORGANIZATION_ID}/ai-insights/analyze?scope=organization`,
          { method: "POST" },
        )
      ).status,
    ).toBe(401);

    const forbidden = await start({ authorized: false });
    const response = await request(forbidden.url, { language: "en" });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: "FORBIDDEN" },
    });
    expect(forbidden.analyze).not.toHaveBeenCalled();
  });

  it("maps rate limiting with Retry-After and provider failures", async () => {
    const limited = await start({
      result: { kind: "rate_limited", retryAfterSeconds: 42 },
    });
    const limitedResponse = await request(limited.url, { language: "en" });
    expect(limitedResponse.status).toBe(429);
    expect(limitedResponse.headers.get("retry-after")).toBe("42");
    expect(await limitedResponse.json()).toMatchObject({
      error: { code: "RATE_LIMITED" },
    });

    const failed = await start({
      result: { category: "TIMEOUT", kind: "provider_failed" },
    });
    const failedResponse = await request(failed.url, { language: "en" });
    expect(failedResponse.status).toBe(502);
    expect(await failedResponse.json()).toMatchObject({
      error: { code: "AI_PROVIDER_FAILED" },
    });

    const rejected = await start({ result: { kind: "rejected" } });
    const rejectedResponse = await request(rejected.url, { language: "en" });
    expect(rejectedResponse.status).toBe(502);
    expect(await rejectedResponse.json()).toMatchObject({
      error: { code: "AI_RESPONSE_REJECTED" },
    });
  });

  it("returns NOT_FOUND when analysis is not configured", async () => {
    const authenticationMiddleware = createSessionAuthenticationMiddleware(
      async () => ({
        actor: { displayName: null, email: "owner@example.com", id: "a" },
        sessionId: "s",
      }),
    );
    const router = createAiInsightRouter({
      authenticationMiddleware,
      reader: {
        authorize: vi.fn(async () => true),
        detail: vi.fn(async () => null),
        latest: vi.fn(async () => ({
          lastSuccess: null,
          latest: null,
          stale: false,
        })),
        list: vi.fn(async () => null),
      },
    });
    const local = await startApiServer(
      createApp({ apiRouter: router, logger }),
      { host: "127.0.0.1", port: 0 },
    );
    try {
      const response = await fetch(
        `http://${local.address.host}:${local.address.port}/api/v1/organizations/${ORGANIZATION_ID}/ai-insights/analyze?scope=organization`,
        {
          body: JSON.stringify({ language: "en" }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      expect(response.status).toBe(404);
    } finally {
      await local.stop();
    }
  });
});
