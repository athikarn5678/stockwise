import { describe, expect, it, vi } from "vitest";

import type { AiAnalysisRun } from "../../generated/prisma/client.ts";
import type { AiProvider, AiProviderResult } from "./ai-provider.ts";
import type { AiAnalyzeProductFacts } from "./ai-analyze-product-facts.ts";
import type { AiAnalyzeSnapshot } from "./ai-analyze-snapshot.ts";
import { createAiAnalyzeService } from "./ai-analyze-service.ts";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const BRANCH_ID = "20000000-0000-4000-8000-000000000001";
const RUN_ID = "70000000-0000-4000-8000-000000000001";

const productFacts: AiAnalyzeProductFacts = {
  lowStock: {
    count: 2,
    coverDaysThreshold: 7,
    items: [
      {
        daysOfCover: "1.50",
        name: "Cola 330ml",
        onHandQuantity: "3",
        quantitySoldInPeriod: "14",
      },
      {
        daysOfCover: "6.00",
        name: "Iced Tea",
        onHandQuantity: "12",
        quantitySoldInPeriod: "14",
      },
    ],
  },
  noSales: { count: 1, names: ["Ginger Ale"] },
  outOfStock: {
    count: 1,
    items: [
      {
        daysOfCover: null,
        name: "Soda Water",
        onHandQuantity: "0",
        quantitySoldInPeriod: "2",
      },
    ],
  },
  slowestByNetSales: [
    { name: "Iced Tea", netSalesAmount: "70.00", quantity: "14" },
  ],
  slowestByQuantity: [
    { name: "Iced Tea", netSalesAmount: "70.00", quantity: "14" },
  ],
  soldProductCount: 2,
  topByNetSales: [
    { name: "Cola 330ml", netSalesAmount: "210.00", quantity: "14" },
  ],
  topByQuantity: [
    { name: "Cola 330ml", netSalesAmount: "210.00", quantity: "14" },
  ],
};

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
    days: 7,
    from: "2026-11-09",
    scope: "organization",
    timezone: "Asia/Bangkok",
    to: "2026-11-16",
  },
  products: productFacts,
  totals: {
    averageOrderValue: "200.00",
    netSalesAmount: "1400.00",
    refundAmount: "50.00",
    refundCount: 1,
    saleCount: 7,
  },
  worstDay: { date: "2026-11-11", netSalesAmount: "200.00" },
};

/** A period with no completed sales: nothing to analyze and no provider value. */
const noSalesSnapshot: AiAnalyzeSnapshot = {
  ...snapshot,
  bestDay: null,
  categories: { bottom: [], top: [] },
  days: [],
  products: {
    ...productFacts,
    lowStock: { count: 0, coverDaysThreshold: 7, items: [] },
    noSales: { count: 0, names: [] },
    outOfStock: { count: 0, items: [] },
    slowestByNetSales: [],
    slowestByQuantity: [],
    soldProductCount: 0,
    topByNetSales: [],
    topByQuantity: [],
  },
  totals: {
    averageOrderValue: null,
    netSalesAmount: "0.00",
    refundAmount: "0.00",
    refundCount: 0,
    saleCount: 0,
  },
  worstDay: null,
};

const englishText = [
  "## Overview",
  "Net sales 1400.00 from 7 sales.",
  "## Sales",
  "Refunds 50.00.",
  "## Products",
  "Top product Cola 330ml: 14 units, 210.00 net sales.",
  "## Notes & risks",
  "Cost is unavailable.",
  "## Recommended actions",
  "Review Drinks.",
].join("\n");

const thaiText = [
  "## ภาพรวม",
  "ยอดขายสุทธิ 1400.00 จาก 7 รายการ",
  "## ยอดขาย",
  "ยอดคืนเงิน 50.00",
  "## สินค้าขายดีและขายช้า",
  "สินค้าขายดี Cola 330ml: 14 หน่วย ยอดขาย 210.00",
  "## ข้อสังเกต",
  "ต้นทุน unavailable",
  "## สิ่งที่ควรทำ",
  "ตรวจสอบ Drinks",
].join("\n");

const analyzeRequest = {
  actorUserId: "trusted-user-id",
  days: 7,
  organizationId: ORGANIZATION_ID,
  scope: { kind: "organization" as const },
};

function row(overrides: Partial<AiAnalysisRun> = {}): AiAnalysisRun {
  return {
    id: RUN_ID,
    organizationId: ORGANIZATION_ID,
    branchId: null,
    actorUserId: "trusted-user-id",
    days: 7,
    localFrom: new Date("2026-11-09T00:00:00.000Z"),
    localTo: new Date("2026-11-16T00:00:00.000Z"),
    reportingTimezone: "Asia/Bangkok",
    contentTh: null,
    contentEn: null,
    model: "deepseek-v4.1-flash",
    createdAt: new Date("2026-11-16T03:00:00.000Z"),
    updatedAt: new Date("2026-11-16T03:00:00.000Z"),
    ...overrides,
  };
}

function languageOf(prompt: string) {
  return prompt.includes("Answer in Thai.") ? "th" : "en";
}

/** Fake provider keyed by the requested language, so TH and EN differ. */
function fakeProvider(answers: Partial<Record<"en" | "th", AiProviderResult>>) {
  const generate = vi.fn<AiProvider["generate"]>(async ({ text }) => {
    const answer = answers[languageOf(text)];
    return (
      answer ?? {
        attempts: [],
        failureCategory: "TIMEOUT",
        ok: false,
      }
    );
  });
  return { generate, provider: { generate } satisfies AiProvider };
}

function success(text: string): AiProviderResult {
  return {
    actualModel: "deepseek-v4.1-flash",
    attempts: [],
    ok: true,
    requestedModel: "requested-model",
    text,
  };
}

type CreateInput = {
  actorUserId: string;
  branchId: string | null;
  contentEn: string | null;
  contentTh: string | null;
  days: number;
  localFrom: string;
  localTo: string;
  model: string;
  organizationId: string;
  reportingTimezone: string;
};

function fakeStore(initial: AiAnalysisRun[] = []) {
  const rows = [...initial];
  const created: CreateInput[] = [];
  const create = vi.fn(async (input: CreateInput) => {
    created.push(input);
    const stored = row({
      id: RUN_ID,
      branchId: input.branchId,
      contentEn: input.contentEn,
      contentTh: input.contentTh,
      days: input.days,
      model: input.model,
      localFrom: new Date(`${input.localFrom}T00:00:00.000Z`),
      localTo: new Date(`${input.localTo}T00:00:00.000Z`),
      reportingTimezone: input.reportingTimezone,
    });
    rows.push(stored);
    return stored;
  });
  const fillLanguage = vi.fn(
    async (input: {
      content: string;
      language: "th" | "en";
      model: string;
      organizationId: string;
      runId: string;
    }) => {
      const current = rows.find((candidate) => candidate.id === input.runId);
      if (current === undefined) return null;
      const column = input.language === "th" ? "contentTh" : "contentEn";
      if (current[column] !== null) return null;
      const updated = {
        ...current,
        [column]: input.content,
        model: input.model,
      };
      rows.splice(rows.indexOf(current), 1, updated);
      return updated;
    },
  );
  const find = vi.fn(async (organizationId: string, runId: string) => {
    return (
      rows.find(
        (candidate) =>
          candidate.id === runId && candidate.organizationId === organizationId,
      ) ?? null
    );
  });
  return {
    create,
    fillLanguage,
    find,
    created,
    store: { create, fillLanguage, find },
  };
}

function service(options: {
  provider?: AiProvider;
  snapshot?: AiAnalyzeSnapshot;
  store: ReturnType<typeof fakeStore>["store"];
}) {
  const buildSnapshot = vi.fn(async () => ({
    kind: "ok" as const,
    snapshot: options.snapshot ?? snapshot,
  }));
  let clock = 1_000_000;
  const created = createAiAnalyzeService({
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    buildSnapshot,
    now: () => clock,
    store: options.store,
  });
  return {
    analyzeService: created,
    buildSnapshot,
    advance(milliseconds: number) {
      clock += milliseconds;
    },
  };
}

describe("AI analysis service", () => {
  it("generates both languages with one allowance and persists one row", async () => {
    const { generate, provider } = fakeProvider({
      en: success(englishText),
      th: success(thaiText),
    });
    const { store, created } = fakeStore();
    const { analyzeService: analysis } = service({ provider, store });

    const result = await analysis.analyze(analyzeRequest);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("expected success");
    expect(result.run).toMatchObject({
      id: RUN_ID,
      days: 7,
      mock: false,
      missing: [],
      model: "deepseek-v4.1-flash",
      period: {
        from: "2026-11-09",
        scope: "organization",
        timezone: "Asia/Bangkok",
        to: "2026-11-16",
      },
    });
    expect(result.run.languages.th?.[0]).toEqual({
      body: "ยอดขายสุทธิ 1400.00 จาก 7 รายการ",
      heading: "ภาพรวม",
    });
    expect(result.run.languages.en?.[0]?.heading).toBe("Overview");
    expect(generate).toHaveBeenCalledTimes(2);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      branchId: null,
      contentEn: englishText,
      contentTh: thaiText,
    });
  });

  it("persists one language and reports the other as missing", async () => {
    const { generate, provider } = fakeProvider({ en: success(englishText) });
    const { store, created } = fakeStore();
    const { analyzeService: analysis } = service({ provider, store });

    const result = await analysis.analyze(analyzeRequest);
    if (result.kind !== "ok") throw new Error("expected success");
    expect(result.run.missing).toEqual(["th"]);
    expect(result.run.languages.th).toBeNull();
    expect(result.run.languages.en).toHaveLength(5);
    expect(created).toHaveLength(1);
    expect(created[0]?.contentTh).toBeNull();
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("persists nothing when both languages fail", async () => {
    const { store, created } = fakeStore();
    const { analyzeService: analysis } = service({
      provider: fakeProvider({
        en: { attempts: [], failureCategory: "TIMEOUT", ok: false },
        th: { attempts: [], failureCategory: "TIMEOUT", ok: false },
      }).provider,
      store,
    });

    await expect(analysis.analyze(analyzeRequest)).resolves.toEqual({
      category: "TIMEOUT",
      kind: "provider_failed",
    });
    expect(created).toHaveLength(0);
  });

  it("rejects a hallucinated number for that language only", async () => {
    const { store, created } = fakeStore();
    const { analyzeService: analysis } = service({
      provider: fakeProvider({
        en: success(englishText.replace("1400.00", "9876.54")),
        th: success(thaiText),
      }).provider,
      store,
    });

    const result = await analysis.analyze(analyzeRequest);
    if (result.kind !== "ok") throw new Error("expected success");
    expect(result.run.missing).toEqual(["en"]);
    expect(created[0]?.contentEn).toBeNull();
    await expect(
      service({
        provider: fakeProvider({
          en: success(englishText.replace("1400.00", "9876.54")),
          th: success(thaiText.replace("1400.00", "9876.54")),
        }).provider,
        store: fakeStore().store,
      }).analyzeService.analyze(analyzeRequest),
    ).resolves.toEqual({ kind: "rejected" });
  });

  it("returns sample text for both languages without storing it", async () => {
    const { store, created } = fakeStore();
    const { analyzeService: analysis } = service({ store });
    const result = await analysis.analyze(analyzeRequest);
    if (result.kind !== "ok") throw new Error("expected success");
    expect(result.run).toMatchObject({ id: null, mock: true, missing: [] });
    expect(result.run.languages.th?.[0]?.heading).toBe("ภาพรวม");
    expect(result.run.languages.en?.[0]?.heading).toBe("Overview");
    expect(created).toHaveLength(0);
  });

  it("limits one provider-spending call per user per 60 seconds", async () => {
    const { generate, provider } = fakeProvider({
      en: success(englishText),
      th: success(thaiText),
    });
    const { store } = fakeStore();
    const { analyzeService: analysis, advance } = service({ provider, store });

    expect((await analysis.analyze(analyzeRequest)).kind).toBe("ok");
    advance(30_000);
    await expect(analysis.analyze(analyzeRequest)).resolves.toEqual({
      kind: "rate_limited",
      retryAfterSeconds: 30,
    });
    expect(generate).toHaveBeenCalledTimes(2);
    advance(30_000);
    expect((await analysis.analyze(analyzeRequest)).kind).toBe("ok");
  });

  it("answers insufficient_data without a provider call and gives the allowance back", async () => {
    const { generate, provider } = fakeProvider({
      en: success(englishText),
      th: success(thaiText),
    });
    const { store, created } = fakeStore();
    const { analyzeService: analysis, buildSnapshot } = service({
      provider,
      snapshot: noSalesSnapshot,
      store,
    });

    await expect(analysis.analyze(analyzeRequest)).resolves.toEqual({
      kind: "insufficient_data",
    });
    expect(generate).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);

    // The wasteful attempt did not spend the allowance: asking again is not 429.
    await expect(analysis.analyze(analyzeRequest)).resolves.toEqual({
      kind: "insufficient_data",
    });

    // A real period immediately after is allowed, and that run does spend it.
    buildSnapshot.mockResolvedValue({ kind: "ok" as const, snapshot });
    expect((await analysis.analyze(analyzeRequest)).kind).toBe("ok");
    expect(generate).toHaveBeenCalledTimes(2);
    await expect(analysis.analyze(analyzeRequest)).resolves.toEqual({
      kind: "rate_limited",
      retryAfterSeconds: 60,
    });
    expect(created).toHaveLength(1);
  });

  it("keeps an expired previous timestamp instead of clearing it twice", async () => {
    const { generate, provider } = fakeProvider({
      en: success(englishText),
      th: success(thaiText),
    });
    const { store } = fakeStore();
    const {
      analyzeService: analysis,
      advance,
      buildSnapshot,
    } = service({
      provider,
      store,
    });

    expect((await analysis.analyze(analyzeRequest)).kind).toBe("ok");
    advance(60_000);
    buildSnapshot.mockResolvedValueOnce({
      kind: "ok" as const,
      snapshot: noSalesSnapshot,
    });
    await expect(analysis.analyze(analyzeRequest)).resolves.toEqual({
      kind: "insufficient_data",
    });
    // The stale entry was restored (harmless) and still allows a real run.
    expect((await analysis.analyze(analyzeRequest)).kind).toBe("ok");
    expect(generate).toHaveBeenCalledTimes(4);
  });

  it("retries only the missing language and counts one allowance", async () => {
    const { generate, provider } = fakeProvider({
      en: success(englishText),
      th: success(thaiText),
    });
    const { store, fillLanguage } = fakeStore([
      row({ contentEn: englishText, contentTh: null }),
    ]);
    const { analyzeService: analysis, buildSnapshot } = service({
      provider,
      store,
    });

    const result = await analysis.retry({
      ...analyzeRequest,
      language: "th",
      runId: RUN_ID,
    });
    if (result.kind !== "ok") throw new Error("expected success");
    expect(result.run.missing).toEqual([]);
    expect(result.run.languages.th?.[0]?.heading).toBe("ภาพรวม");
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]?.[0].text).toContain("Answer in Thai.");
    expect(fillLanguage).toHaveBeenCalledTimes(1);
    // The stored run period is reused, not "today minus N days".
    expect(buildSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        days: 7,
        fixedPeriod: { from: "2026-11-09", to: "2026-11-16" },
      }),
    );

    // The store now holds both languages, so a second retry is a plain read.
    const again = await analysis.retry({
      ...analyzeRequest,
      language: "th",
      runId: RUN_ID,
    });
    if (again.kind !== "ok") throw new Error("expected success");
    expect(generate).toHaveBeenCalledTimes(1);

    // The retry spent the one allowance for this user.
    await expect(analysis.analyze(analyzeRequest)).resolves.toMatchObject({
      kind: "rate_limited",
    });
  });

  it("never calls the provider when the language is already stored", async () => {
    const { generate, provider } = fakeProvider({
      th: success(thaiText),
    });
    const { store } = fakeStore([
      row({ contentEn: englishText, contentTh: thaiText }),
    ]);
    const { analyzeService: analysis, buildSnapshot } = service({
      provider,
      store,
    });

    const result = await analysis.retry({
      ...analyzeRequest,
      language: "en",
      runId: RUN_ID,
    });
    if (result.kind !== "ok") throw new Error("expected success");
    expect(result.run.languages.en).toHaveLength(5);
    expect(generate).not.toHaveBeenCalled();
    expect(buildSnapshot).not.toHaveBeenCalled();
  });

  it("treats a run of another scope or tenant as missing", async () => {
    const { generate, provider } = fakeProvider({ th: success(thaiText) });
    const branchRuns = fakeStore([row({ branchId: BRANCH_ID })]);
    const { analyzeService: sameTenant } = service({
      provider,
      store: branchRuns.store,
    });
    await expect(
      sameTenant.retry({
        ...analyzeRequest,
        language: "th",
        runId: RUN_ID,
      }),
    ).resolves.toEqual({ kind: "not_found" });
    await expect(
      sameTenant.retry({
        ...analyzeRequest,
        language: "th",
        runId: RUN_ID,
        scope: {
          kind: "branch",
          branchId: "20000000-0000-4000-8000-000000000009",
        },
      }),
    ).resolves.toEqual({ kind: "not_found" });

    const foreign = fakeStore([
      row({ organizationId: "10000000-0000-4000-8000-000000000009" }),
    ]);
    await expect(
      service({ provider, store: foreign.store }).analyzeService.retry({
        ...analyzeRequest,
        language: "th",
        runId: RUN_ID,
      }),
    ).resolves.toEqual({ kind: "not_found" });
    expect(generate).not.toHaveBeenCalled();
  });
});
