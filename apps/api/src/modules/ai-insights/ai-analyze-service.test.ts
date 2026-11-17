import { describe, expect, it, vi } from "vitest";

import type { AiProvider, AiProviderResult } from "./ai-provider.ts";
import { buildMockAiAnalyzeOutput } from "./ai-analyze-output.ts";
import type { AiAnalyzeSnapshot } from "./ai-analyze-snapshot.ts";
import { createAiAnalyzeService } from "./ai-analyze-service.ts";

const snapshot: AiAnalyzeSnapshot = {
  bestDay: { date: "2026-11-12", netSalesAmount: "1200.00" },
  categories: {
    bottom: [{ name: "Drinks", netSalesAmount: "100.00" }],
    top: [{ name: "Food", netSalesAmount: "900.00" }],
  },
  cost: { costNote: "unavailable" },
  days: [
    {
      date: "2026-11-11",
      netSalesAmount: "200.00",
      refundAmount: "0.00",
      refundCount: 0,
      saleCount: 2,
      salesAfterDiscountAmount: "200.00",
    },
    {
      date: "2026-11-12",
      netSalesAmount: "1200.00",
      refundAmount: "50.00",
      refundCount: 1,
      saleCount: 5,
      salesAfterDiscountAmount: "1250.00",
    },
  ],
  period: {
    days: 2,
    from: "2026-11-11",
    scope: "branch",
    timezone: "Asia/Bangkok",
    to: "2026-11-13",
  },
  totals: {
    averageOrderValue: "200.00",
    netSalesAmount: "1400.00",
    refundAmount: "50.00",
    refundCount: 1,
    saleCount: 7,
  },
  worstDay: { date: "2026-11-11", netSalesAmount: "200.00" },
};

const request = {
  actorUserId: "trusted-user-id",
  days: 7,
  language: "en" as const,
  organizationId: "10000000-0000-4000-8000-000000000001",
  scope: { kind: "organization" as const },
};

const validText = [
  "## Overview",
  "Net sales 1400.00 from 7 sales.",
  "## Sales",
  "Refunds 50.00.",
  "## Products",
  "Category-level only: Food 900.00.",
  "## Notes & risks",
  "Cost is unavailable.",
  "## Recommended actions",
  "Review Drinks.",
].join("\n");

function success(text: string): AiProviderResult {
  return {
    actualModel: "deepseek-v4.1-flash",
    attempts: [],
    ok: true,
    requestedModel: "deepseek-v4.1-flash",
    text,
  };
}

function fakeProvider(result: AiProviderResult) {
  const generate = vi.fn<AiProvider["generate"]>(async () => result);
  return {
    generate,
    provider: { generate } satisfies AiProvider,
  };
}

function service(provider?: AiProvider) {
  const buildSnapshot = vi.fn(async () => ({
    kind: "ok" as const,
    snapshot,
  }));
  let clock = 1_000;
  const analyzeService = createAiAnalyzeService({
    ...(provider === undefined ? {} : { provider }),
    buildSnapshot,
    now: () => clock,
  });
  return {
    analyzeService,
    buildSnapshot,
    advance(milliseconds: number) {
      clock += milliseconds;
    },
  };
}

describe("AI analyze service", () => {
  it("returns validated provider sections without persisting anything", async () => {
    const { generate, provider } = fakeProvider(success(validText));
    const { analyzeService, buildSnapshot } = service(provider);
    const result = await analyzeService.analyze(request);

    expect(result).toMatchObject({ kind: "ok", mock: false, language: "en" });
    if (result.kind !== "ok") throw new Error("expected success");
    expect(result.sections).toHaveLength(5);
    expect(result.period).toEqual(snapshot.period);
    expect(generate).toHaveBeenCalledWith({
      text: expect.stringContaining("## Overview"),
    });
    expect(buildSnapshot).toHaveBeenCalledWith({
      actorUserId: request.actorUserId,
      days: request.days,
      organizationId: request.organizationId,
      scope: request.scope,
    });
  });

  it("falls back to deterministic mock text without a provider", async () => {
    const { analyzeService } = service();
    const result = await analyzeService.analyze(request);
    expect(result).toMatchObject({ kind: "ok", mock: true });
    if (result.kind !== "ok") throw new Error("expected success");
    expect(result.text).toBe(
      buildMockAiAnalyzeOutput({ language: "en", snapshot }),
    );
  });

  it("limits one run per user per 60 seconds after authorization", async () => {
    const { generate, provider } = fakeProvider(success(validText));
    const { analyzeService, buildSnapshot, advance } = service(provider);
    expect((await analyzeService.analyze(request)).kind).toBe("ok");

    advance(30_000);
    await expect(analyzeService.analyze(request)).resolves.toEqual({
      kind: "rate_limited",
      retryAfterSeconds: 30,
    });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(buildSnapshot).toHaveBeenCalledTimes(1);

    advance(30_000);
    expect((await analyzeService.analyze(request)).kind).toBe("ok");
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("counts a provider failure toward the rate limit", async () => {
    const { provider } = fakeProvider({
      attempts: [],
      failureCategory: "TIMEOUT",
      ok: false,
    });
    const { analyzeService } = service(provider);
    await expect(analyzeService.analyze(request)).resolves.toEqual({
      category: "TIMEOUT",
      kind: "provider_failed",
    });
    await expect(analyzeService.analyze(request)).resolves.toMatchObject({
      kind: "rate_limited",
    });
  });

  it("rejects a hallucinated number", async () => {
    const { provider } = fakeProvider(
      success(validText.replace("1400.00", "9876.54")),
    );
    const { analyzeService } = service(provider);
    await expect(analyzeService.analyze(request)).resolves.toEqual({
      kind: "rejected",
    });
  });

  it("maps snapshot authorization failures and never calls the provider", async () => {
    const generate = vi.fn<AiProvider["generate"]>();
    const buildSnapshot = vi.fn(async () => ({ kind: "forbidden" as const }));
    const analyzeService = createAiAnalyzeService({
      buildSnapshot,
      provider: { generate },
    });
    await expect(analyzeService.analyze(request)).resolves.toEqual({
      kind: "forbidden",
    });
    const unavailable = createAiAnalyzeService({
      buildSnapshot: async () => ({ kind: "unavailable" }),
      provider: { generate },
    });
    await expect(unavailable.analyze(request)).resolves.toEqual({
      kind: "not_found",
    });
    expect(generate).not.toHaveBeenCalled();
  });
});
