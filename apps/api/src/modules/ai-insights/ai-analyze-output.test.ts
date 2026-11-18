import { describe, expect, it } from "vitest";

import type { AiAnalyzeProductFacts } from "./ai-analyze-product-facts.ts";
import type { AiAnalyzeSnapshot } from "./ai-analyze-snapshot.ts";
import {
  AiAnalyzeOutputError,
  buildMockAiAnalyzeOutput,
  parseAiAnalyzeOutput,
  splitStoredAiAnalyzeSections,
} from "./ai-analyze-output.ts";
import { buildAiAnalyzePrompt } from "./ai-analyze-prompt.ts";

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
    scope: "organization",
    timezone: "Asia/Bangkok",
    to: "2026-11-13",
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
        "Top product Cola 330ml with 14 units and 210.00 net sales. Food 900.00.",
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

  it("rejects text before the first heading, non-ASCII digits, and keeps ranges", () => {
    const body = ["Net sales 1400.00.", "None.", "Food.", "None.", "Act."];
    expect(() =>
      parseAiAnalyzeOutput({
        language: "en",
        snapshot,
        text: `Preamble with 4242 sales\n${english(body)}`,
      }),
    ).toThrow(AiAnalyzeOutputError);
    expect(() =>
      parseAiAnalyzeOutput({
        language: "en",
        snapshot,
        text: english(["Net sales ๑๔๐๐.", "None.", "Food.", "None.", "Act."]),
      }),
    ).toThrow(AiAnalyzeOutputError);
    expect(() =>
      parseAiAnalyzeOutput({
        language: "en",
        snapshot,
        text: english([
          "Between 2-5 sales.",
          "None.",
          "Food.",
          "None.",
          "Act.",
        ]),
      }),
    ).not.toThrow();
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

  it("splits stored text leniently without re-validating numbers", () => {
    const text = buildMockAiAnalyzeOutput({ language: "en", snapshot });
    const sections = splitStoredAiAnalyzeSections(text, "en");
    expect(sections).toHaveLength(5);
    expect(sections[0]?.heading).toBe("Overview");
    expect(sections[0]?.body).toContain("MOCK");

    // Unrelated numbers and drifted headings stay displayable.
    expect(splitStoredAiAnalyzeSections("## Overview\nStep 99.", "en")).toEqual(
      [{ body: "## Overview\nStep 99.", heading: "Overview" }],
    );
    expect(
      splitStoredAiAnalyzeSections("Preamble\n## Overview\ntext", "en"),
    ).toEqual([{ body: "Preamble\n## Overview\ntext", heading: "Overview" }]);
  });

  it("builds deterministic mock text that satisfies the same contract", () => {
    for (const language of ["en", "th"] as const) {
      const text = buildMockAiAnalyzeOutput({ language, snapshot });
      expect(text).toContain("MOCK");
      expect(parseAiAnalyzeOutput({ language, snapshot, text })).toHaveLength(
        5,
      );
      expect(text).toContain("1400.00");
      // The mock names the real top/slowest/stock products from the snapshot.
      expect(text).toContain("Cola 330ml");
      expect(text).toContain("Iced Tea");
      expect(text).toContain("Soda Water");
      expect(text).toContain("Ginger Ale");
    }
  });

  it("sends the product facts to the model and drops the old caveats", () => {
    for (const language of ["en", "th"] as const) {
      const prompt = buildAiAnalyzePrompt({ language, snapshot });
      expect(prompt).toContain("Cola 330ml");
      expect(prompt).toContain("Iced Tea");
      expect(prompt).toContain("Soda Water");
      expect(prompt).toContain('"lowStock"');
      expect(prompt).not.toContain("category-level");
      expect(prompt).not.toContain("product-level detail is unavailable");
    }
  });

  it("rejects a hallucinated product number or product count", () => {
    expect(() =>
      parseAiAnalyzeOutput({
        language: "en",
        snapshot,
        text: english([
          "Net sales 1400.00.",
          "None.",
          "Cola 330ml sold 41 units for 210.00.",
          "None.",
          "Act.",
        ]),
      }),
    ).toThrow(AiAnalyzeOutputError);
    expect(() =>
      parseAiAnalyzeOutput({
        language: "en",
        snapshot,
        text: english([
          "Net sales 1400.00.",
          "None.",
          "Products with no sales (9): Ginger Ale.",
          "None.",
          "Act.",
        ]),
      }),
    ).toThrow(AiAnalyzeOutputError);
  });

  it("accepts a digit that only appears inside a product name", () => {
    expect(() =>
      parseAiAnalyzeOutput({
        language: "en",
        snapshot,
        text: english([
          "Net sales 1400.00.",
          "None.",
          "Cola 330ml is the top product.",
          "None.",
          "Act.",
        ]),
      }),
    ).not.toThrow();
  });
});
