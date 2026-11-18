import { describe, expect, it } from "vitest";

import { validateAiSummaryProse } from "./ai-summary-prompt.ts";
import {
  buildSeededReportText,
  SEEDED_REPORT_HEADINGS,
  SEEDED_REPORT_MAX_BYTES,
  type SeededReportTextInput,
} from "./seeded-report-text.ts";

const FORBIDDEN = /demo|uat|ตัวอย่าง|sample/iu;

const headings = [
  SEEDED_REPORT_HEADINGS.overview,
  SEEDED_REPORT_HEADINGS.sales,
  SEEDED_REPORT_HEADINGS.products,
  SEEDED_REPORT_HEADINGS.notes,
  SEEDED_REPORT_HEADINGS.actions,
];

function salesInput(
  overrides: Partial<SeededReportTextInput["sales"]> = {},
): SeededReportTextInput["sales"] {
  return {
    averageOrderValue: { reason: null, value: "250.00" },
    costCoverage: "complete",
    grossMarginPercent: { reason: null, value: "31.25" },
    grossProfitAmount: { reason: null, value: "1234.5678900000" },
    netSalesAmount: "3947.00",
    netSalesGrowthPercent: { reason: null, value: "12.34" },
    refundAmount: "120.00",
    refundCount: 2,
    saleCount: 16,
    ...overrides,
  };
}

function input(
  overrides: Partial<SeededReportTextInput> = {},
): SeededReportTextInput {
  return {
    best: [
      { name: "Siam Drinking Water 600 ml", quantity: "48.0000", unit: "EA" },
      { name: "Thai Jasmine Rice 1 kg", quantity: "30.0000", unit: "PACK" },
      { name: "Fresh Chicken Breast", quantity: "12.5000", unit: "KG" },
      { name: "Palm Cooking Oil 1 L", quantity: "9.0000", unit: "L" },
    ],
    granularity: "week",
    localFromInclusive: "2026-08-03",
    localToExclusive: "2026-08-10",
    lowStock: [
      {
        branchName: "Siam Mart Main",
        coverageDays: "0.70",
        onHand: "3.0000",
        productName: "Siam Drinking Water 600 ml",
        unit: "EA",
      },
    ],
    lowStockTotal: 1,
    replenishment: [
      {
        branchName: "Siam Mart Main",
        productName: "Siam Drinking Water 600 ml",
        quantity: "24.0000",
        unit: "EA",
      },
    ],
    sales: salesInput(),
    scopeKind: "branch",
    scopeName: "Siam Mart Main",
    slowest: [
      { name: "Fresh Eggs 10 Pack", quantity: "0.0000", unit: "PACK" },
      { name: "Fresh Pork Shoulder", quantity: "1.0000", unit: "KG" },
      { name: "Laundry Detergent 3 L", quantity: "2.0000", unit: "L" },
      { name: "Instant Noodle Pack", quantity: "4.0000", unit: "EA" },
    ],
    ...overrides,
  };
}

describe("seeded stored report text", () => {
  it("starts every section with the five bilingual headings in order", () => {
    const text = buildSeededReportText(input());
    const lines = text.split("\n");
    expect(lines.filter((line) => headings.includes(line))).toEqual(headings);
    for (const heading of headings) expect(text.split(heading)).toHaveLength(2);
    // Sections are separated by exactly one blank line.
    expect(text.split("\n\n")).toHaveLength(5);
    expect(text.trim()).toBe(text);
  });

  it("states the period, scope, sales and refund figures of this period only", () => {
    const text = buildSeededReportText(input());
    expect(text).toContain("ช่วงข้อมูล: 2026-08-03 ถึง 2026-08-09 (สัปดาห์)");
    expect(text).toContain("ขอบเขต: สาขา Siam Mart Main");
    expect(text).toContain(
      "ยอดขายสุทธิ (net sales): 3947.00 THB จาก 16 รายการขาย",
    );
    expect(text).toContain("ยอดเฉลี่ยต่อรายการขาย: 250.00 THB");
    expect(text).toContain("การเติบโตเทียบช่วงก่อนหน้า: 12.34%");
    expect(text).toContain("การคืนเงิน: 2 รายการ รวม 120.00 THB");
    expect(text).toContain("กำไรขั้นต้น: 1234.56 THB (31.25%)");
    expect(text).toContain(
      "สินค้าขายดีตามหน่วยฐาน: Siam Drinking Water 600 ml",
    );
    expect(text).toContain("สินค้าขายช้าตามหน่วยฐาน: Fresh Eggs 10 Pack");
    expect(text).toContain("สินค้าใกล้หมด ณ วันสิ้นสุดช่วง: Siam Mart Main");
    expect(text).toContain("ข้อเสนอแนะการเติมสินค้า (ระยะวางแผน 7 วัน)");
  });

  it("states unavailable comparison and cost facts instead of guessing", () => {
    const text = buildSeededReportText(
      input({
        sales: salesInput({
          averageOrderValue: {
            reason: "NO_REGISTERED_SALES",
            value: null,
          },
          costCoverage: "none",
          grossMarginPercent: {
            reason: "INCOMPLETE_COST_COVERAGE",
            value: null,
          },
          grossProfitAmount: {
            reason: "INCOMPLETE_COST_COVERAGE",
            value: null,
          },
          netSalesGrowthPercent: {
            reason: "NON_COMPARABLE_PERIOD",
            value: null,
          },
        }),
      }),
    );
    expect(text).toContain("ยอดเฉลี่ยต่อรายการขาย: ไม่มีข้อมูล");
    expect(text).toContain(
      "การเติบโตเทียบช่วงก่อนหน้า: ไม่มีข้อมูลเปรียบเทียบ",
    );
    expect(text).toContain("ไม่มีข้อมูลต้นทุนที่ยืนยันได้");
    expect(text).toContain("ความครบถ้วนของต้นทุน: none");
  });

  it("uses a deterministic fallback when there is no low stock or advice", () => {
    const text = buildSeededReportText(
      input({ lowStock: [], lowStockTotal: 0, replenishment: [] }),
    );
    expect(text).toContain("สินค้าใกล้หมด ณ วันสิ้นสุดช่วง: ไม่มี");
    expect(text).toContain("ยังไม่มีข้อเสนอแนะการเติมสินค้าในช่วงนี้");
  });

  it("stays within the stored prose contract and the 4096-byte limit", () => {
    const longName = "ก".repeat(400);
    const worstCase = buildSeededReportText(
      input({
        best: Array.from({ length: 9 }, (_, index) => ({
          name: `${longName}${index}`,
          quantity: "9999999999.9999",
          unit: ["EA", "KG", "G", "L", "ML", "BOX", "PACK", "M", "CM"][index]!,
        })),
        slowest: Array.from({ length: 9 }, (_, index) => ({
          name: `${longName}${index}`,
          quantity: "0.0000",
          unit: ["EA", "KG", "G", "L", "ML", "BOX", "PACK", "M", "CM"][index]!,
        })),
        lowStock: Array.from({ length: 4 }, (_, index) => ({
          branchName: longName,
          coverageDays: "12345.6789",
          onHand: "9999999999.9999",
          productName: `${longName}${index}`,
          unit: "PACK",
        })),
        lowStockTotal: 36,
        replenishment: Array.from({ length: 4 }, (_, index) => ({
          branchName: longName,
          productName: `${longName}${index}`,
          quantity: "9999999999.9999",
          unit: "PACK",
        })),
        granularity: "month",
        localFromInclusive: "2026-08-01",
        localToExclusive: "2026-09-01",
        sales: salesInput({
          grossProfitAmount: {
            reason: null,
            value: "999999999999999999.1234567890",
          },
          netSalesAmount: "999999999999999999.99",
          netSalesGrowthPercent: { reason: null, value: "999999999.99" },
        }),
      }),
    );
    expect(new TextEncoder().encode(worstCase).byteLength).toBeLessThanOrEqual(
      SEEDED_REPORT_MAX_BYTES,
    );
    expect(validateAiSummaryProse(worstCase)).toBe(worstCase);
    expect(worstCase).not.toMatch(FORBIDDEN);
    expect(
      worstCase.split("\n").filter((line) => headings.includes(line)),
    ).toEqual(headings);
  });

  it("passes the AI summary prose validation and states the English word sales", () => {
    const text = buildSeededReportText(input());
    expect(validateAiSummaryProse(text)).toBe(text);
    expect(text).toMatch(/\b(?:sales|revenue)\b/iu);
    expect(text).not.toMatch(FORBIDDEN);
    expect(text).not.toMatch(/<[A-Za-z/]/);
    expect(text).not.toMatch(/```/);
  });
});
