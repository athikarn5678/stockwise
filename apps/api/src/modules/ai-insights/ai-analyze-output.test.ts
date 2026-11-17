import { describe, expect, it } from "vitest";

import type { AiAnalyzeSnapshot } from "./ai-analyze-snapshot.ts";
import {
  AiAnalyzeOutputError,
  buildMockAiAnalyzeOutput,
  parseAiAnalyzeOutput,
} from "./ai-analyze-output.ts";

const snapshot: AiAnalyzeSnapshot = {
  bestDay: { date: "2026-11-12", netSalesAmount: "1200.00" },
  categories: {
    bottom: [{ name: "Drinks", netSalesAmount: "100.00" }],
    top: [{ name: "Food", netSalesAmount: "900.00" }],
  },
  cost: {
    costCoverage: "complete",
    grossMarginPercent: "33.33",
    grossProfitAmount: "400.00",
  },
  days: [
    {
      date: "2026-11-11",
      netSalesAmount: "200.00",
      refundAmount: "0.00",
      refundCount: 0,
      saleCount: 2,
    },
    {
      date: "2026-11-12",
      netSalesAmount: "1200.00",
      refundAmount: "50.00",
      refundCount: 1,
      saleCount: 5,
    },
  ],
  period: {
    days: 2,
    from: "2026-11-11",
    scope: "organization",
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

function english(sections: readonly string[]) {
  const headings = [
    "Overview",
    "Sales",
    "Products",
    "Notes & risks",
    "Recommended actions",
  ];
  return headings
    .map((heading, index) => `## ${heading}\n${sections[index] ?? "Text."}`)
    .join("\n");
}

describe("AI analyze output validation", () => {
  it("accepts the five headings in order with snapshot numbers", () => {
    const sections = parseAiAnalyzeOutput({
      language: "en",
      snapshot,
      text: english([
        "Net sales 1,400.00 from 7 sales.",
        "Refunds 50.00.",
        "Only category-level data: Food 900.00.",
        "Gross margin 33.33%.",
        "Review Drinks.",
      ]),
    });
    expect(sections.map((section) => section.heading)).toEqual([
      "Overview",
      "Sales",
      "Products",
      "Notes & risks",
      "Recommended actions",
    ]);
    expect(sections[1]?.body).toBe("Refunds 50.00.");
  });

  it("rejects missing, reordered, or unknown headings", () => {
    const missing = english(["a", "b", "c", "d", "e"]).replace(
      "## Products\n",
      "",
    );
    expect(() =>
      parseAiAnalyzeOutput({ language: "en", snapshot, text: missing }),
    ).toThrow(AiAnalyzeOutputError);
    const reordered = english(["a", "b", "c", "d", "e"]).replace(
      "## Sales\nb\n## Products",
      "## Products\nb\n## Sales",
    );
    expect(() =>
      parseAiAnalyzeOutput({ language: "en", snapshot, text: reordered }),
    ).toThrow(AiAnalyzeOutputError);
    expect(() =>
      parseAiAnalyzeOutput({
        language: "th",
        snapshot,
        text: english(["a", "b", "c", "d", "e"]),
      }),
    ).toThrow(AiAnalyzeOutputError);
  });

  it("rejects a number that is absent from the snapshot", () => {
    expect(() =>
      parseAiAnalyzeOutput({
        language: "en",
        snapshot,
        text: english([
          "Net sales 1400.00.",
          "Refunds 999.99.",
          "Categories only.",
          "No risks.",
          "Act.",
        ]),
      }),
    ).toThrow(AiAnalyzeOutputError);
  });

  it("tolerates comma grouping and rounding of snapshot values", () => {
    expect(() =>
      parseAiAnalyzeOutput({
        language: "en",
        snapshot,
        text: english([
          "Net sales 1,400.00 across 7 sales.",
          "Refunds 50.00 on 2 days.",
          "Food 900.00.",
          "Margin 33.3 percent.",
          "Review 1,200.00 day.",
        ]),
      }),
    ).not.toThrow();
  });

  it("builds deterministic mock text that satisfies the same contract", () => {
    for (const language of ["en", "th"] as const) {
      const text = buildMockAiAnalyzeOutput({ language, snapshot });
      expect(text).toContain("MOCK");
      expect(parseAiAnalyzeOutput({ language, snapshot, text })).toHaveLength(
        5,
      );
      expect(text).toContain("1400.00");
    }
  });
});
