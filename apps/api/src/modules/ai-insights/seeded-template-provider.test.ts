import { describe, expect, it } from "vitest";

import {
  prepareAiSummaryPrompt,
  validateAiSummaryProse,
} from "./ai-summary-prompt.ts";
import type { AiProviderAttempt } from "./ai-provider.ts";
import {
  createSeededTemplateProvider,
  SEEDED_TEMPLATE_MODEL,
  SEEDED_TEMPLATE_PROVIDER,
} from "./seeded-template-provider.ts";
import {
  SEEDED_REPORT_HEADINGS,
  type SeededReportFacts,
} from "./seeded-report-text.ts";

const facts: SeededReportFacts = {
  best: [
    { name: "Siam Drinking Water 600 ml", quantity: "48.0000", unit: "EA" },
  ],
  lowStock: [],
  lowStockTotal: 0,
  replenishment: [],
  scopeKind: "organization",
  scopeName: "Siam Mart",
  slowest: [{ name: "Fresh Eggs 10 Pack", quantity: "0.0000", unit: "PACK" }],
};

function snapshot(cadence: "WEEKLY" | "MONTHLY" = "WEEKLY") {
  return {
    scope: "ORGANIZATION" as const,
    cadence,
    dataStatus: "complete" as const,
    localFromInclusive: "2026-08-03",
    localToExclusive: "2026-08-10",
    metricDefinitionVersion: "analytics-v1" as const,
    payload: {
      sales: {
        averageOrderValue: { reason: null, value: "250.00" },
        costCoverage: "complete" as const,
        grossMarginPercent: { reason: null, value: "31.25" },
        grossProfitAmount: { reason: null, value: "1234.5678900000" },
        netSalesAmount: "3947.00",
        netSalesGrowthPercent: { reason: null, value: "12.34" },
        refundAmount: "120.00",
        refundCount: 2,
        saleCount: 16,
      },
    },
    periodEndExclusive: new Date("2026-08-09T17:00:00.000Z"),
    periodStartInclusive: new Date("2026-08-02T17:00:00.000Z"),
    reportingTimezone: "Asia/Bangkok",
    schemaVersion: "analytics-snapshot-v1" as const,
    sourceCutoff: new Date("2026-08-10T03:00:00.000Z"),
  };
}

function prompt(cadence: "WEEKLY" | "MONTHLY" = "WEEKLY") {
  return prepareAiSummaryPrompt(snapshot(cadence)).text;
}

describe("seeded template AI provider", () => {
  it("renders deterministic prose from the prompt snapshot without a network call", async () => {
    let loaded = 0;
    const provider = createSeededTemplateProvider(async () => {
      loaded++;
      return facts;
    });
    const observer = {
      afterAttempt: async () => undefined,
      beforeAttempt: async () => undefined,
    };
    const result = await provider.generate({ text: prompt() }, observer);
    if (!result.ok) throw new Error("The seeded provider must succeed.");
    expect(loaded).toBe(1);
    expect(result.requestedModel).toBe(SEEDED_TEMPLATE_MODEL);
    expect(result.actualModel).toBe(SEEDED_TEMPLATE_MODEL);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]).toMatchObject({
      actualModel: SEEDED_TEMPLATE_MODEL,
      attemptNumber: 1,
      provider: "seeded-template",
      requestedModel: SEEDED_TEMPLATE_MODEL,
    });
    expect(result.attempts[0]?.failureCategory).toBeUndefined();
    expect(validateAiSummaryProse(result.text)).toBe(result.text);
    expect(result.text).toContain(SEEDED_REPORT_HEADINGS.overview);
    expect(result.text).toContain("2026-08-03 ถึง 2026-08-09");
    expect(result.text).toContain("ขอบเขต: องค์กร Siam Mart");
    expect(result.text).toContain("net sales): 3947.00 THB จาก 16 รายการขาย");
  });

  it("reserves and records exactly one attempt through the job observer", async () => {
    const events: string[] = [];
    const attempts: AiProviderAttempt[] = [];
    const provider = createSeededTemplateProvider(async () => facts);
    const result = await provider.generate(
      { text: prompt("MONTHLY") },
      {
        beforeAttempt: async (attempt) => {
          events.push(
            `before:${attempt.provider}:${attempt.requestedModel}:${attempt.attemptNumber}`,
          );
        },
        afterAttempt: async (attempt) => {
          events.push(`after:${attempt.provider}:${attempt.attemptNumber}`);
          attempts.push(attempt);
        },
      },
    );
    expect(result.ok).toBe(true);
    expect(events).toEqual([
      `before:${SEEDED_TEMPLATE_PROVIDER}:${SEEDED_TEMPLATE_MODEL}:1`,
      `after:${SEEDED_TEMPLATE_PROVIDER}:1`,
    ]);
    expect(attempts).toHaveLength(1);
    if (!result.ok) return;
    // The monthly cadence is rendered with the monthly period label.
    expect(result.text).toContain(SEEDED_REPORT_HEADINGS.overview);
  });

  it("rejects a prompt without the snapshot payload before any attempt is reserved", async () => {
    let loaded = 0;
    const provider = createSeededTemplateProvider(async () => {
      loaded++;
      return facts;
    });
    const events: string[] = [];
    const result = await provider.generate(
      { text: "Instructions without a snapshot." },
      {
        afterAttempt: async () => {
          events.push("after");
        },
        beforeAttempt: async () => {
          events.push("before");
        },
      },
    );
    expect(result).toEqual({
      attempts: [],
      failureCategory: "INVALID_REQUEST",
      ok: false,
    });
    expect(events).toEqual([]);
    expect(loaded).toBe(0);
  });

  it("rejects a snapshot payload that does not match the analytics schema", async () => {
    const provider = createSeededTemplateProvider(async () => facts);
    const valid = prompt();
    const invalid = valid.replace(`"saleCount":16`, `"saleCount":"sixteen"`);
    expect(invalid).not.toBe(valid);
    const result = await provider.generate({ text: invalid });
    expect(result).toMatchObject({
      attempts: [],
      failureCategory: "INVALID_REQUEST",
      ok: false,
    });
  });
});
