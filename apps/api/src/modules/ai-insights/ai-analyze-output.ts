import type { AiAnalyzeSnapshot } from "./ai-analyze-snapshot.ts";
import {
  AI_ANALYZE_HEADINGS,
  type AiAnalyzeLanguage,
} from "./ai-analyze-prompt.ts";

export type AiAnalyzeSection = Readonly<{ body: string; heading: string }>;

export class AiAnalyzeOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiAnalyzeOutputError";
  }
}

const HEADING_PREFIX = "## ";
const LOCAL_DATE = /(\d{4})-(\d{2})-(\d{2})/g;
// Magnitudes only: a hyphen is a range or sign, never part of the token.
const NUMBER = /\d+(?:\.\d+)?/g;
const NON_ASCII_DIGIT = /(?![0-9])\p{Nd}/u;
const LIST_MARKER = /^\s*\d{1,2}[.)]\s+/;
const GROUPED_DIGITS = /(?<=\d),(?=\d)/g;
const TOLERATED_DECIMALS = [0, 1] as const;

function numbersIn(text: string): readonly number[] {
  const withoutDates = text.replace(LOCAL_DATE, "$1 $2 $3");
  const values: number[] = [];
  for (const match of withoutDates.matchAll(NUMBER)) {
    const value = Number(match[0]);
    if (Number.isFinite(value)) values.push(value);
  }
  return values;
}

function collectNumbers(value: unknown, collected: number[]): void {
  if (typeof value === "number") {
    if (Number.isFinite(value)) collected.push(value);
    return;
  }
  if (typeof value === "string") {
    collected.push(...numbersIn(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectNumbers(item, collected);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) collectNumbers(item, collected);
  }
}

function hasSnapshotNumber(
  token: number,
  snapshotNumbers: readonly number[],
): boolean {
  return snapshotNumbers.some(
    (candidate) =>
      candidate === token ||
      TOLERATED_DECIMALS.some(
        (decimals) => Number(candidate.toFixed(decimals)) === token,
      ),
  );
}

function sectionsOf(
  text: string,
  language: AiAnalyzeLanguage,
): readonly AiAnalyzeSection[] {
  const expected = AI_ANALYZE_HEADINGS[language];
  const collected: { heading: string; lines: string[] }[] = [];
  if (NON_ASCII_DIGIT.test(text))
    throw new AiAnalyzeOutputError("The analysis must use Arabic digits.");
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith(HEADING_PREFIX)) {
      collected.push({
        heading: line.slice(HEADING_PREFIX.length).trim(),
        lines: [],
      });
      continue;
    }
    const current = collected.at(-1);
    if (current === undefined) {
      // Text before the first heading would bypass validation but still be shown.
      if (line.trim() !== "")
        throw new AiAnalyzeOutputError(
          "The analysis has text before the first section.",
        );
      continue;
    }
    current.lines.push(line);
  }
  if (collected.length !== expected.length)
    throw new AiAnalyzeOutputError(
      "The analysis does not contain the five required sections.",
    );
  const sections = collected.map((section, index) => {
    if (section.heading !== expected[index])
      throw new AiAnalyzeOutputError(
        "The analysis headings are missing, unknown, or out of order.",
      );
    return Object.freeze({
      body: section.lines.join("\n").trim(),
      heading: section.heading,
    });
  });
  return Object.freeze(sections);
}

/** Validates model prose: exact headings/order and only snapshot numbers. */
export function parseAiAnalyzeOutput(input: {
  language: AiAnalyzeLanguage;
  snapshot: AiAnalyzeSnapshot;
  text: string;
}): readonly AiAnalyzeSection[] {
  const sections = sectionsOf(input.text, input.language);
  const snapshotNumbers: number[] = [];
  collectNumbers(input.snapshot, snapshotNumbers);
  for (const section of sections) {
    for (const line of section.body.split(/\r?\n/)) {
      const withoutMarker = line.replace(LIST_MARKER, "");
      for (const token of numbersIn(
        withoutMarker.replace(GROUPED_DIGITS, ""),
      )) {
        if (!hasSnapshotNumber(token, snapshotNumbers))
          throw new AiAnalyzeOutputError(
            "The analysis contains a number that is absent from the snapshot.",
          );
      }
    }
  }
  return sections;
}

function singleSection(
  text: string,
  heading: string,
): readonly AiAnalyzeSection[] {
  return Object.freeze([Object.freeze({ body: text.trim(), heading })]);
}

/**
 * Lenient split for text that was already accepted when it was stored: no
 * heading-order or number validation. Text that no longer splits into the five
 * expected sections is shown as one section so a stored run is never hidden.
 */
export function splitStoredAiAnalyzeSections(
  text: string,
  language: AiAnalyzeLanguage,
): readonly AiAnalyzeSection[] {
  const expected = AI_ANALYZE_HEADINGS[language];
  const collected: { heading: string; lines: string[] }[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith(HEADING_PREFIX)) {
      collected.push({
        heading: line.slice(HEADING_PREFIX.length).trim(),
        lines: [],
      });
      continue;
    }
    const current = collected.at(-1);
    if (current === undefined) {
      if (line.trim() !== "") return singleSection(text, expected[0]);
      continue;
    }
    current.lines.push(line);
  }
  if (collected.length !== expected.length)
    return singleSection(text, expected[0]);
  return Object.freeze(
    collected.map((section) =>
      Object.freeze({
        body: section.lines.join("\n").trim(),
        heading: section.heading,
      }),
    ),
  );
}

function categoryList(
  categories: AiAnalyzeSnapshot["categories"]["top"],
): readonly string[] {
  return categories.map(
    (category) => `- ${category.name}: ${category.netSalesAmount}`,
  );
}

function extremeDay(
  day: AiAnalyzeSnapshot["bestDay"],
  description: string,
): string {
  return day === null
    ? description
    : `${description} ${day.date}: ${day.netSalesAmount}`;
}

function costLine(snapshot: AiAnalyzeSnapshot, language: AiAnalyzeLanguage) {
  if ("costNote" in snapshot.cost)
    return language === "th"
      ? "ต้นทุนและกำไรขั้นต้น: unavailable"
      : "Cost and gross profit: unavailable";
  return language === "th"
    ? `กำไรขั้นต้น ${snapshot.cost.grossProfitAmount}; อัตรากำไรขั้นต้น ${snapshot.cost.grossMarginPercent ?? "unavailable"}`
    : `Gross profit ${snapshot.cost.grossProfitAmount}; gross margin ${snapshot.cost.grossMarginPercent ?? "unavailable"}`;
}

/**
 * Deterministic sample text used when no provider is configured. It obeys the
 * same heading and number contract as provider output.
 */
export function buildMockAiAnalyzeOutput(input: {
  language: AiAnalyzeLanguage;
  snapshot: AiAnalyzeSnapshot;
}): string {
  const { period, totals, categories } = input.snapshot;
  const average = totals.averageOrderValue ?? "unavailable";
  if (input.language === "th") {
    return [
      "## ภาพรวม",
      "ตัวอย่าง (MOCK): ยังไม่ได้ตั้งค่าคีย์ AI ข้อความนี้จึงเป็นตัวอย่างที่สร้างจากข้อมูลที่คำนวณไว้ ไม่ใช่บทวิเคราะห์จากผู้ให้บริการ AI",
      `ช่วงข้อมูล ${period.from} ถึง ${period.to} รวม ${period.days} วัน เขตเวลา ${period.timezone} ขอบเขต ${period.scope}`,
      "## ยอดขาย",
      `ยอดขายสุทธิ ${totals.netSalesAmount} จาก ${totals.saleCount} รายการ`,
      `ยอดคืนเงิน ${totals.refundAmount} จำนวน ${totals.refundCount} รายการ`,
      `มูลค่าเฉลี่ยต่อรายการ ${average}`,
      "## สินค้าขายดีและขายช้า",
      "ข้อมูลที่มีคือระดับหมวดหมู่เท่านั้น ยังไม่มีข้อมูลระดับสินค้า",
      ...(categories.top.length === 0
        ? ["ยังไม่มีข้อมูลหมวดหมู่"]
        : ["หมวดหมู่ขายดี:", ...categoryList(categories.top)]),
      ...(categories.bottom.length === 0
        ? []
        : ["หมวดหมู่ขายช้า:", ...categoryList(categories.bottom)]),
      "## ข้อสังเกต",
      costLine(input.snapshot, "th"),
      extremeDay(input.snapshot.bestDay, "วันที่ขายดีที่สุด"),
      extremeDay(input.snapshot.worstDay, "วันที่ขายน้อยที่สุด"),
      "## สิ่งที่ควรทำ",
      "ตรวจสอบหมวดหมู่ที่มียอดขายต่ำและต้นทุนที่ยังไม่ครบก่อนตัดสินใจใด ๆ",
    ].join("\n");
  }
  return [
    "## Overview",
    "Sample (MOCK): no AI key is configured, so this text is a deterministic sample built from the calculated data, not provider analysis.",
    `Period ${period.from} to ${period.to}, ${period.days} days, timezone ${period.timezone}, scope ${period.scope}`,
    "## Sales",
    `Net sales ${totals.netSalesAmount} from ${totals.saleCount} sales`,
    `Refunds ${totals.refundAmount} across ${totals.refundCount} refunds`,
    `Average order value ${average}`,
    "## Products",
    "Only category-level data is supplied; product-level detail is unavailable.",
    ...(categories.top.length === 0
      ? ["No category data"]
      : ["Top categories:", ...categoryList(categories.top)]),
    ...(categories.bottom.length === 0
      ? []
      : ["Slowest categories:", ...categoryList(categories.bottom)]),
    "## Notes & risks",
    costLine(input.snapshot, "en"),
    extremeDay(input.snapshot.bestDay, "Best day"),
    extremeDay(input.snapshot.worstDay, "Weakest day"),
    "## Recommended actions",
    "Review the lowest-selling categories and any incomplete cost data before acting.",
  ].join("\n");
}
