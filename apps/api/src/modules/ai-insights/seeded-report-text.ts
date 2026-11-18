import { Temporal } from "@js-temporal/polyfill";

import type { AnalyticsSnapshotPayload } from "../analytics/analytics-snapshot-store.ts";
import { AI_ANALYZE_HEADINGS } from "./ai-analyze-prompt.ts";

/** The `ai_insight_reports.content` storage limit enforced by the database check. */
export const SEEDED_REPORT_MAX_BYTES = 4096;

/** At most this many best or slowest products are described per period. */
export const SEEDED_REPORT_LIST_LIMIT = 4;

const DEFAULT_NAME_LIMIT = 48;

const heading = (index: 0 | 1 | 2 | 3 | 4) =>
  `${AI_ANALYZE_HEADINGS.th[index]} / ${AI_ANALYZE_HEADINGS.en[index]}`;

/** The same five bilingual headings, in the same order, as the on-demand analysis. */
export const SEEDED_REPORT_HEADINGS = Object.freeze({
  actions: heading(4),
  notes: heading(3),
  overview: heading(0),
  products: heading(2),
  sales: heading(1),
});

export interface SeededReportProductFact {
  name: string;
  unit: string;
  quantity: string;
}

/**
 * Facts a seed step computes for one period and scope from that period's own
 * analytics reads. They never contain cross-period or cross-scope figures and
 * never describe a current stock level: only sale depletion inside the period.
 */
export interface SeededReportFacts {
  best: readonly SeededReportProductFact[];
  scopeKind: "organization" | "branch";
  scopeName: string;
  slowest: readonly SeededReportProductFact[];
}

export interface SeededReportTextInput extends SeededReportFacts {
  granularity: "week" | "month";
  localFromInclusive: string;
  localToExclusive: string;
  sales: AnalyticsSnapshotPayload["sales"];
}

const THAI_GRANULARITY = { month: "เดือน", week: "สัปดาห์" } as const;
const THAI_SCOPE = { branch: "สาขา", organization: "องค์กร" } as const;

export class SeededReportTextError extends Error {
  constructor() {
    super("Seeded report text is invalid.");
  }
}

function truncateName(value: string, limit: number): string {
  const characters = [...value];
  return characters.length <= limit
    ? value
    : `${characters.slice(0, limit).join("")}…`;
}

/** Display-only shortening; the authoritative values stay in the snapshot. */
function money2(value: string): string {
  const separator = value.indexOf(".");
  return separator === -1 ? value : value.slice(0, separator + 3);
}

/**
 * One reading of the supplied comparison, never a recomputation: the sign of
 * the stored growth percentage decides the sentence.
 */
function growthReading(value: string | null): string {
  if (value === null) return "ไม่มีข้อมูลเปรียบเทียบช่วงก่อนหน้า";
  if (!/[1-9]/u.test(value)) return "ยอดขายสุทธิใกล้เคียงช่วงก่อนหน้า";
  return value.trimStart().startsWith("-")
    ? "ยอดขายสุทธิลดลงเมื่อเทียบช่วงก่อนหน้า"
    : "ยอดขายสุทธิเพิ่มขึ้นเมื่อเทียบช่วงก่อนหน้า";
}

function list(values: readonly string[], empty: string): string {
  return values.length === 0 ? empty : values.join("; ");
}

interface RenderLimits {
  listLimit: number;
  nameLimit: number;
}

/**
 * Bounded widening order: full names and lists first, then shorter ranked lists
 * and finally shorter names. The reduction is always at the tail of a list, so
 * repeated runs over the same facts render identical text.
 */
const RENDER_LIMITS: readonly RenderLimits[] = [
  { listLimit: SEEDED_REPORT_LIST_LIMIT, nameLimit: DEFAULT_NAME_LIMIT },
  { listLimit: 2, nameLimit: DEFAULT_NAME_LIMIT },
  { listLimit: SEEDED_REPORT_LIST_LIMIT, nameLimit: 32 },
  { listLimit: 2, nameLimit: 32 },
  { listLimit: 1, nameLimit: 32 },
  { listLimit: 1, nameLimit: 24 },
  { listLimit: 1, nameLimit: 16 },
];

/**
 * Deterministic bilingual-heading, Thai-body report text for one completed
 * period and scope. Every figure comes from that period's snapshot payload or
 * from the period-scoped facts passed in; nothing is re-derived here.
 *
 * The stored row is bounded by a 4096-byte database check, so an unusually wide
 * fact set is rendered with the next bounded layout instead of being truncated
 * mid-line or rejected by the database.
 */
export function buildSeededReportText(input: SeededReportTextInput): string {
  for (const limits of RENDER_LIMITS) {
    const text = renderSeededReportText(input, limits);
    if (new TextEncoder().encode(text).byteLength <= SEEDED_REPORT_MAX_BYTES)
      return text;
  }
  throw new SeededReportTextError();
}

function renderSeededReportText(
  input: SeededReportTextInput,
  limits: RenderLimits,
): string {
  const name = (value: string) => truncateName(value, limits.nameLimit);
  const productFact = (fact: SeededReportProductFact) =>
    `${name(fact.name)}: ${fact.quantity} ${fact.unit}`;

  const listedBest = input.best.slice(0, limits.listLimit);
  const listedSlowest = input.slowest.slice(0, limits.listLimit);
  const lastDay = Temporal.PlainDate.from(input.localToExclusive)
    .subtract({ days: 1 })
    .toString();
  const { sales } = input;
  // The growth percentage is a Sales fact; Notes re-reads its sign only.
  const growthValue = sales.netSalesGrowthPercent.value;
  const refunds = `การคืนเงิน: ${sales.refundCount} รายการ รวม ${money2(sales.refundAmount)} THB`;
  const averageOrderValue =
    sales.averageOrderValue.value === null
      ? "ยอดเฉลี่ยต่อรายการขาย: ไม่มีข้อมูล"
      : `ยอดเฉลี่ยต่อรายการขาย: ${money2(sales.averageOrderValue.value)} THB`;
  const growth =
    sales.netSalesGrowthPercent.value === null
      ? "การเติบโตเทียบช่วงก่อนหน้า: ไม่มีข้อมูลเปรียบเทียบ"
      : `การเติบโตเทียบช่วงก่อนหน้า: ${sales.netSalesGrowthPercent.value}%`;
  const profit =
    sales.grossProfitAmount.value === null ||
    sales.grossMarginPercent.value === null
      ? `กำไรขั้นต้น: ไม่มีข้อมูลต้นทุนที่ยืนยันได้ (ความครบถ้วนของต้นทุน: ${sales.costCoverage})`
      : `กำไรขั้นต้น: ${money2(sales.grossProfitAmount.value)} THB (${sales.grossMarginPercent.value}%) · ความครบถ้วนของต้นทุน: ${sales.costCoverage}`;
  // Actions stay deterministic and use only this period's own facts: ranked
  // products and refunds. No action may claim a current stock level.
  const actionLimit = Math.min(2, limits.listLimit);
  const bestNames = listedBest
    .slice(0, actionLimit)
    .map((fact) => name(fact.name));
  const slowestNames = listedSlowest
    .slice(0, actionLimit)
    .map((fact) => name(fact.name));
  const actions: string[] = [];
  if (bestNames.length > 0)
    actions.push(
      `ควรเตรียมสต็อกสินค้าขายดีให้เพียงพอ: ${bestNames.join("; ")}`,
    );
  if (slowestNames.length > 0)
    actions.push(
      `ทบทวนการสั่งซื้อและโปรโมชันของสินค้าขายช้า: ${slowestNames.join("; ")}`,
    );
  if (sales.refundCount > 0)
    actions.push(
      `ติดตามสาเหตุการคืนสินค้า ${sales.refundCount} รายการในช่วงนี้`,
    );
  const actionLines =
    actions.length === 0 ? ["ติดตามยอดขายต่อเนื่องในช่วงถัดไป"] : actions;

  const sections: ReadonlyArray<readonly [string, readonly string[]]> = [
    [
      SEEDED_REPORT_HEADINGS.overview,
      [
        `ช่วงข้อมูล: ${input.localFromInclusive} ถึง ${lastDay} (${THAI_GRANULARITY[input.granularity]})`,
        `ขอบเขต: ${THAI_SCOPE[input.scopeKind]} ${name(input.scopeName)}`,
        `ยอดขายสุทธิ (net sales): ${sales.netSalesAmount} THB จาก ${sales.saleCount} รายการขาย`,
      ],
    ],
    [SEEDED_REPORT_HEADINGS.sales, [averageOrderValue, growth, refunds]],
    [
      SEEDED_REPORT_HEADINGS.products,
      [
        `สินค้าขายดีตามหน่วยฐาน: ${list(listedBest.map(productFact), "ยังไม่มีการขาย")}`,
        `สินค้าขายช้าตามหน่วยฐาน: ${list(listedSlowest.map(productFact), "ยังไม่มีการขาย")}`,
      ],
    ],
    [SEEDED_REPORT_HEADINGS.notes, [profit, growthReading(growthValue)]],
    [SEEDED_REPORT_HEADINGS.actions, actionLines],
  ];
  return sections
    .map(([sectionHeading, lines]) => [sectionHeading, ...lines].join("\n"))
    .join("\n\n");
}
