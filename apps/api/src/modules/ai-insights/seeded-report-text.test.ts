import { describe, expect, it } from "vitest";

import { validateAiSummaryProse } from "./ai-summary-prompt.ts";
import {
  buildSeededReportText,
  SEEDED_REPORT_HEADINGS,
  SEEDED_REPORT_MAX_BYTES,
  type SeededReportTextInput,
} from "./seeded-report-text.ts";

const FORBIDDEN = /demo|uat|ตัวอย่าง|sample/iu;
const STOCK_CLAIM = /ใกล้หมด|on hand|on-hand|สต็อกคงเหลือ|สินค้าคงเหลือ/iu;

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
    baselineInsideSeedWindow: true,
    best: [
      { name: "Siam Drinking Water 600 ml", quantity: "48.0000", unit: "EA" },
      { name: "Thai Jasmine Rice 1 kg", quantity: "30.0000", unit: "PACK" },
      { name: "Fresh Chicken Breast", quantity: "12.5000", unit: "KG" },
      { name: "Palm Cooking Oil 1 L", quantity: "9.0000", unit: "L" },
    ],
    granularity: "week",
    localFromInclusive: "2026-08-03",
    localToExclusive: "2026-08-10",
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
    expect(text).toContain("กำไรขั้นต้น: 1234.57 THB (31.25%)");
    expect(text).toContain(
      "สินค้าขายดีตามหน่วยฐาน: Siam Drinking Water 600 ml",
    );
    expect(text).toContain("สินค้าขายช้าตามหน่วยฐาน: Fresh Eggs 10 Pack");
  });

  it("states the refund line once, in Sales only", () => {
    const text = buildSeededReportText(input());
    expect(text.split("การคืนเงิน")).toHaveLength(2);
    const [salesSection, notesSection] = text.split("\n\n").slice(1, 3);
    expect(salesSection).toContain("การคืนเงิน");
    expect(notesSection).not.toContain("การคืนเงิน");
  });

  it("never claims a stock level, on-hand quantity or coverage", () => {
    const text = buildSeededReportText(input());
    expect(text).not.toMatch(STOCK_CLAIM);
    expect(text).not.toContain("onHand");
    expect(text).not.toContain("coverageDays");
    const longText = buildSeededReportText(
      input({
        best: [{ name: "ก".repeat(300), quantity: "5.0000", unit: "EA" }],
        slowest: [{ name: "ข".repeat(300), quantity: "1.0000", unit: "EA" }],
      }),
    );
    expect(longText).not.toMatch(STOCK_CLAIM);
  });

  it("reads the supplied growth percentage sign without recomputing it", () => {
    const readings = [
      ["12.34", "ยอดขายสุทธิเพิ่มขึ้นเมื่อเทียบช่วงก่อนหน้า"],
      ["0.01", "ยอดขายสุทธิเพิ่มขึ้นเมื่อเทียบช่วงก่อนหน้า"],
      ["-12.34", "ยอดขายสุทธิลดลงเมื่อเทียบช่วงก่อนหน้า"],
      ["-0.01", "ยอดขายสุทธิลดลงเมื่อเทียบช่วงก่อนหน้า"],
      ["0", "ยอดขายสุทธิใกล้เคียงช่วงก่อนหน้า"],
      ["0.00", "ยอดขายสุทธิใกล้เคียงช่วงก่อนหน้า"],
      ["-0.00", "ยอดขายสุทธิใกล้เคียงช่วงก่อนหน้า"],
    ] as const;
    for (const [value, reading] of readings) {
      const text = buildSeededReportText(
        input({
          sales: salesInput({
            netSalesGrowthPercent: { reason: null, value },
          }),
        }),
      );
      const notes = text.split("\n\n")[3]!;
      expect(notes).toContain(reading);
      expect(text).toContain(`การเติบโตเทียบช่วงก่อนหน้า: ${value}%`);
    }
  });

  it("treats a baseline outside the seed window as no comparison", () => {
    // The first completed week of the seed window compares against a baseline
    // week that holds only a couple of seeded days: its stored growth number is
    // not a comparable reading, however large it is.
    for (const value of ["412.75", "-93.50", "0"]) {
      const text = buildSeededReportText(
        input({
          baselineInsideSeedWindow: false,
          sales: salesInput({
            netSalesGrowthPercent: { reason: null, value },
          }),
        }),
      );
      expect(text).toContain(
        "การเติบโตเทียบช่วงก่อนหน้า: ไม่มีข้อมูลเปรียบเทียบ",
      );
      expect(text).not.toMatch(/การเติบโตเทียบช่วงก่อนหน้า: [-\d]/u);
      expect(text).not.toContain("ยอดขายสุทธิเพิ่มขึ้นเมื่อเทียบช่วงก่อนหน้า");
      expect(text).not.toContain("ยอดขายสุทธิลดลงเมื่อเทียบช่วงก่อนหน้า");
      expect(text).not.toContain("ยอดขายสุทธิใกล้เคียงช่วงก่อนหน้า");
      expect(text.split("\n\n")[3]!).toContain(
        "ไม่มีข้อมูลเปรียบเทียบช่วงก่อนหน้า",
      );
    }
  });

  it("renders the comparison reading when the baseline is inside the window", () => {
    const readings = [
      ["12.34", "ยอดขายสุทธิเพิ่มขึ้นเมื่อเทียบช่วงก่อนหน้า"],
      ["-12.34", "ยอดขายสุทธิลดลงเมื่อเทียบช่วงก่อนหน้า"],
      ["0", "ยอดขายสุทธิใกล้เคียงช่วงก่อนหน้า"],
    ] as const;
    for (const [value, reading] of readings) {
      const text = buildSeededReportText(
        input({
          baselineInsideSeedWindow: true,
          sales: salesInput({
            netSalesGrowthPercent: { reason: null, value },
          }),
        }),
      );
      expect(text).toContain(`การเติบโตเทียบช่วงก่อนหน้า: ${value}%`);
      expect(text.split("\n\n")[3]!).toContain(reading);
    }
  });

  it("rounds money half-up to two decimals for display", () => {
    const amounts = [
      ["12.3456789", "12.35"],
      ["0.004", "0.00"],
      ["0.005", "0.01"],
      ["1234.5678900000", "1234.57"],
      ["250.00", "250.00"],
    ] as const;
    for (const [value, rendered] of amounts) {
      const text = buildSeededReportText(
        input({
          sales: salesInput({
            grossProfitAmount: { reason: null, value },
          }),
        }),
      );
      expect(text).toContain(`กำไรขั้นต้น: ${rendered} THB (31.25%)`);
    }
  });

  it("states cost coverage in Thai words", () => {
    const coverages = [
      ["complete", "ครบถ้วน"],
      ["partial", "บางส่วน"],
      ["none", "ไม่มี"],
    ] as const;
    for (const [coverage, thai] of coverages) {
      const text = buildSeededReportText(
        input({ sales: salesInput({ costCoverage: coverage }) }),
      );
      expect(text).toContain(`ความครบถ้วนของต้นทุน: ${thai}`);
      expect(text).not.toContain(`ความครบถ้วนของต้นทุน: ${coverage}`);
    }
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
    expect(text).toContain("ความครบถ้วนของต้นทุน: ไม่มี");
    const notes = text.split("\n\n")[3]!;
    expect(notes).toContain("ไม่มีข้อมูลเปรียบเทียบช่วงก่อนหน้า");
  });

  it("derives deterministic actions from the period's own ranked products and refunds", () => {
    const text = buildSeededReportText(input());
    const actions = text.split("\n\n")[4]!;
    expect(actions).toContain(
      "ควรเตรียมสต็อกสินค้าขายดีต่อหน่วยฐานให้เพียงพอ: Siam Drinking Water 600 ml; Thai Jasmine Rice 1 kg",
    );
    expect(actions).toContain(
      "ทบทวนการสั่งซื้อและโปรโมชันของสินค้าขายช้า: Fresh Eggs 10 Pack; Fresh Pork Shoulder",
    );
    expect(actions).toContain("ติดตามสาเหตุการคืนสินค้า 2 รายการในช่วงนี้");
  });

  it("keeps only the applicable actions when facts are absent", () => {
    const onlyRefunds = buildSeededReportText(
      input({ best: [], slowest: [] }),
    ).split("\n\n")[4]!;
    expect(onlyRefunds).toContain("ติดตามสาเหตุการคืนสินค้า 2 รายการในช่วงนี้");
    expect(onlyRefunds).not.toContain("ควรเตรียมสต็อกสินค้าขายดี");
    expect(onlyRefunds).not.toContain("ทบทวนการสั่งซื้อ");

    const none = buildSeededReportText(
      input({
        best: [],
        sales: salesInput({ refundCount: 0 }),
        slowest: [],
      }),
    ).split("\n\n")[4]!;
    expect(none).toContain("ติดตามยอดขายต่อเนื่องในช่วงถัดไป");
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
    expect(worstCase).not.toMatch(STOCK_CLAIM);
    expect(
      worstCase.split("\n").filter((line) => headings.includes(line)),
    ).toEqual(headings);
    // The bounded ladder reduces the tail of the ranked lists, never the head.
    expect(worstCase).toContain("สินค้าขายดีตามหน่วยฐาน: ");
    expect(worstCase).not.toContain("CM");
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
