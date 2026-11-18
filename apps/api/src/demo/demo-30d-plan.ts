import { createHash } from "node:crypto";

import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";

import { Prisma, type ProductUnit } from "../generated/prisma/client.ts";
import { localDateToUtcBoundary } from "../modules/analytics/analytics-period.ts";

export const DEMO_30D_ORGANIZATION = "UAT Demo Siam Mart";
/**
 * The presentation organization shows this name. Its id stays derived from
 * `DEMO_30D_ORGANIZATION` so the deterministic organization id never changes.
 */
export const DEMO_PRESENTATION_ORGANIZATION = "Siam Mart";
/** Names the demo tooling accepts for the deterministic organization. */
export const DEMO_ORGANIZATION_NAMES: readonly string[] = [
  DEMO_30D_ORGANIZATION,
  DEMO_PRESENTATION_ORGANIZATION,
];

const optionsSchema = z
  .object({
    referenceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    seed: z.number().int().min(0).max(4_294_967_295),
  })
  .strict();

/** Optional widening of the deterministic demo beyond the legacy 30-day shape. */
export const demoShapeSchema = z
  .object({
    // Three full calendar months plus the days of the run month before today: 89..122.
    days: z.number().int().min(15).max(123),
    branchLimit: z.number().int().min(1).max(3),
    productLimit: z.number().int().min(3).max(12),
    adjustments: z.boolean(),
  })
  .strict();

export type Demo30dShape = z.infer<typeof demoShapeSchema>;

/**
 * The presentation window: history starts on the 1st day of the month three full
 * calendar months before the run month and ends yesterday (`referenceDate` is the
 * exclusive boundary, so today carries no seeded transaction). Run 2026-11-18
 * covers 2026-08-01..2026-11-17 (109 days). Three branches, twelve products,
 * manual adjustments.
 */
export function demoWindowShape(referenceDate: string): Demo30dShape {
  const end = Temporal.PlainDate.from(referenceDate);
  const start = end.with({ day: 1 }).subtract({ months: 3 });
  return {
    days: start.until(end, { largestUnit: "days" }).days,
    branchLimit: 3,
    productLimit: 12,
    adjustments: true,
  };
}

export interface Demo30dProduct {
  id: string;
  name: string;
  sku: string;
  unit: ProductUnit;
  basePrice: string;
}

export interface Demo30dSaleItem {
  productId: string;
  expectedUnitPrice: string;
  quantity: string;
}

export interface Demo30dSale {
  key: string;
  branchId: string;
  day: number;
  at: Date;
  method: "CASH" | "TRANSFER";
  items: Demo30dSaleItem[];
  refund: boolean;
}

export interface Demo30dOrderItem {
  productId: string;
  quantity: string;
  expectedUnitCost: string;
}

export interface Demo30dOrder {
  reference: string;
  branchId: string;
  day: number;
  date: string;
  at: Date;
  items: Demo30dOrderItem[];
}

/** A deterministic manual stock adjustment applied after that day's sales. */
export interface Demo30dAdjustment {
  key: string;
  branchId: string;
  day: number;
  at: Date;
  productId: string;
  delta: string;
  reason: "DAMAGE" | "STOCK_COUNT" | "LOSS";
  note: string;
}

export interface Demo30dSettings {
  actorUserId: string;
  supplierId: string;
  salesVatStatus: "NOT_REGISTERED" | "REGISTERED";
  salesVatRate: string | null;
}

export interface Demo30dPlanData {
  version: "demo30d-v1" | "demo90d-v1";
  signature: string;
  prefix: string;
  referenceDate: string;
  seed: number;
  organizationId: string;
  reportingTimezone: string;
  from: string;
  to: string;
  branches: { id: string; code: string }[];
  products: Demo30dProduct[];
  orders: Demo30dOrder[];
  sales: Demo30dSale[];
  settings: Demo30dSettings;
  shape?: Demo30dShape;
  adjustments?: Demo30dAdjustment[];
}

type Demo30dBranch = { id: string; code: string };

/** Synthetic adjustment days stay inside the shaped plan window only. */
const DEMO_ADJUSTMENT_TEMPLATES = [
  {
    day: 20,
    delta: "-1",
    reason: "DAMAGE",
    note: "Damaged in store",
  },
  {
    day: 50,
    delta: "2",
    reason: "STOCK_COUNT",
    note: "Stock count found extra",
  },
  {
    day: 80,
    delta: "-2",
    reason: "LOSS",
    note: "Shrinkage found at stock count",
  },
] as const satisfies readonly Pick<
  Demo30dAdjustment,
  "day" | "delta" | "reason" | "note"
>[];

function buildLegacySales(input: {
  branches: readonly Demo30dBranch[];
  days: number;
  prefix: string;
  products: readonly Demo30dProduct[];
  random: () => number;
  reportingTimezone: string;
  start: Temporal.PlainDate;
}): Demo30dSale[] {
  const { branches, days, prefix, products, random, reportingTimezone, start } =
    input;
  return Array.from({ length: days }, (_, day) => {
    const date = start.add({ days: day }).toString();
    const count = 12 + (random() % 7);
    return Array.from({ length: count }, (_, index) => {
      const branch = branches[(day + index) % branches.length]!;
      const selected =
        index % 11 === 0
          ? [products[0]!, products[products.length - 1]!]
          : [products[0]!, products[1 + (random() % (products.length - 2))]!];
      return {
        key: `${prefix}-sale-${day}-${index}`,
        branchId: branch.id,
        day,
        at: new Date(
          localDateToUtcBoundary(date, reportingTimezone).getTime() +
            (10 * 60 + index * 15) * 60_000,
        ),
        method: index % 2 === 0 ? ("CASH" as const) : ("TRANSFER" as const),
        items: selected.map((product, line) => ({
          productId: product.id,
          expectedUnitPrice: product.basePrice,
          quantity: line === 0 ? String(1 + (random() % 3)) : "1",
        })),
        refund: day % 10 === 4 && index === 0,
      };
    });
  }).flat();
}

/** Two distinct lines per sale, skewed toward low product indexes. */
function buildShapedSales(input: {
  branches: readonly Demo30dBranch[];
  days: number;
  prefix: string;
  products: readonly Demo30dProduct[];
  random: () => number;
  reportingTimezone: string;
  start: Temporal.PlainDate;
}): Demo30dSale[] {
  const { branches, days, prefix, products, random, reportingTimezone, start } =
    input;
  return Array.from({ length: days }, (_, day) => {
    const date = start.add({ days: day }).toString();
    const dayOfWeek = Temporal.PlainDate.from(date).dayOfWeek;
    const count =
      7 + (dayOfWeek >= 6 ? 4 : 0) + Math.floor(day / 30) + (random() % 4);
    return Array.from({ length: count }, (_, index) => {
      const branch = branches[(day + index) % branches.length]!;
      const method =
        random() % 100 < 60 ? ("CASH" as const) : ("TRANSFER" as const);
      const x = (random() % 1000) / 1000;
      const first = Math.floor(x * x * products.length);
      const second =
        (first + 1 + (random() % (products.length - 1))) % products.length;
      const firstQuantity = String(1 + (random() % 3));
      return {
        key: `${prefix}-sale-${day}-${index}`,
        branchId: branch.id,
        day,
        at: new Date(
          localDateToUtcBoundary(date, reportingTimezone).getTime() +
            (10 * 60 + index * 15) * 60_000,
        ),
        method,
        items: [
          {
            productId: products[first]!.id,
            expectedUnitPrice: products[first]!.basePrice,
            quantity: firstQuantity,
          },
          {
            productId: products[second]!.id,
            expectedUnitPrice: products[second]!.basePrice,
            quantity: "1",
          },
        ],
        refund: day % 10 === 4 && index === 0,
      };
    });
  }).flat();
}

/** Each 15-day window orders exactly its own demand plus a deterministic surplus. */
function buildOrders(input: {
  branches: readonly Demo30dBranch[];
  days: number;
  prefix: string;
  products: readonly Demo30dProduct[];
  reportingTimezone: string;
  sales: readonly Demo30dSale[];
  start: Temporal.PlainDate;
  surplus: (position: { day: number; index: number }) => number;
}): Demo30dOrder[] {
  const {
    branches,
    days,
    prefix,
    products,
    reportingTimezone,
    sales,
    start,
    surplus,
  } = input;
  return branches.flatMap((branch) =>
    Array.from({ length: Math.ceil(days / 15) }, (_, k) => k * 15).map(
      (day) => {
        const date = start.add({ days: day }).toString();
        return {
          reference: `${prefix}-po-${branch.code}-${day}`,
          branchId: branch.id,
          day,
          date,
          at: new Date(
            localDateToUtcBoundary(date, reportingTimezone).getTime() +
              8 * 3_600_000,
          ),
          items: products.map((product, index) => {
            const demand = sales
              .filter(
                (s) =>
                  s.branchId === branch.id && s.day >= day && s.day < day + 15,
              )
              .flatMap((s) => s.items)
              .filter((i) => i.productId === product.id)
              .reduce(
                (sum, item) => sum.plus(item.quantity),
                new Prisma.Decimal(0),
              );
            return {
              productId: product.id,
              quantity: demand.plus(surplus({ day, index })).toFixed(4),
              expectedUnitCost: new Prisma.Decimal(product.basePrice)
                .div(2)
                .toFixed(4),
            };
          }),
        };
      },
    ),
  );
}

function buildAdjustments(input: {
  branches: readonly Demo30dBranch[];
  days: number;
  prefix: string;
  products: readonly Demo30dProduct[];
  reportingTimezone: string;
  start: Temporal.PlainDate;
}): Demo30dAdjustment[] {
  const { branches, days, prefix, products, reportingTimezone, start } = input;
  return DEMO_ADJUSTMENT_TEMPLATES.filter((t) => t.day < days).flatMap(
    (template) =>
      branches.map((branch, position) => {
        const date = start.add({ days: template.day }).toString();
        return {
          key: `${prefix}-adj-${branch.code}-${template.day}`,
          branchId: branch.id,
          day: template.day,
          at: new Date(
            localDateToUtcBoundary(date, reportingTimezone).getTime() +
              20 * 3_600_000,
          ),
          productId: products[(1 + 3 * position) % products.length]!.id,
          delta: template.delta,
          reason: template.reason,
          note: template.note,
        };
      }),
  );
}

/** The reference date is the exclusive local calendar boundary, never a partial day. */
export function buildDemo30dPlan(input: {
  referenceDate: string;
  seed: number;
  reportingTimezone: string;
  organizationId: string;
  branches: readonly { id: string; code: string }[];
  products: readonly Demo30dProduct[];
  settings: {
    actorUserId: string;
    supplierId: string;
    salesVatStatus: "NOT_REGISTERED" | "REGISTERED";
    salesVatRate: string | null;
  };
  shape?: Demo30dShape | undefined;
}): Demo30dPlanData {
  optionsSchema.parse({ referenceDate: input.referenceDate, seed: input.seed });
  const shape =
    input.shape === undefined ? undefined : demoShapeSchema.parse(input.shape);
  const end = Temporal.PlainDate.from(input.referenceDate);
  const days = shape === undefined ? 30 : shape.days;
  const start = end.subtract({ days });
  const branches = [...input.branches]
    .sort((a, b) => a.code.localeCompare(b.code))
    .slice(0, shape === undefined ? 2 : shape.branchLimit)
    .map(({ id, code }) => ({ id, code }));
  const products = [...input.products]
    .sort((a, b) => a.sku.localeCompare(b.sku))
    .slice(0, shape === undefined ? 6 : shape.productLimit);
  if (
    branches.length === 0 ||
    products.length < 3 ||
    products.some((p) => new Prisma.Decimal(p.basePrice).lte(0))
  )
    throw new Error(
      "Demo30d requires active branches and at least three positive-price products.",
    );
  const signature = createHash("sha256")
    .update(
      JSON.stringify({
        version: shape === undefined ? "demo30d-v1" : "demo90d-v1",
        organizationId: input.organizationId,
        referenceDate: input.referenceDate,
        seed: input.seed,
        reportingTimezone: input.reportingTimezone,
        branches,
        products,
        settings: input.settings,
        ...(shape === undefined ? {} : { shape }),
      }),
    )
    .digest("hex");
  // The shaped plan feeds user-visible references (PO numbers, transfer references).
  const prefix =
    shape === undefined
      ? `DEMO30D-${signature.slice(0, 24)}`
      : `SM-${signature.slice(0, 12)}`;
  let state = input.seed >>> 0;
  const random = () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state;
  };
  const salesInput = {
    branches,
    days,
    prefix,
    products,
    random,
    reportingTimezone: input.reportingTimezone,
    start,
  };
  const sales =
    shape === undefined
      ? buildLegacySales(salesInput)
      : buildShapedSales(salesInput);
  const orders = buildOrders({
    branches,
    days,
    prefix,
    products,
    reportingTimezone: input.reportingTimezone,
    sales,
    start,
    surplus:
      shape === undefined
        ? ({ day, index }) => (day === 15 ? (index === 0 ? 1 : 80) : 1)
        : ({ index }) => (index % 3 === 0 ? 1 : 30),
  });
  const plan: Demo30dPlanData = {
    version: shape === undefined ? "demo30d-v1" : "demo90d-v1",
    signature,
    prefix,
    referenceDate: input.referenceDate,
    seed: input.seed,
    organizationId: input.organizationId,
    reportingTimezone: input.reportingTimezone,
    from: start.toString(),
    to: end.toString(),
    branches,
    products,
    orders,
    sales,
    settings: input.settings,
  };
  if (shape !== undefined) {
    plan.shape = shape;
    plan.adjustments = shape.adjustments
      ? buildAdjustments({
          branches,
          days,
          prefix,
          products,
          reportingTimezone: input.reportingTimezone,
          start,
        })
      : [];
  }
  return plan;
}

export type Demo30dPlan = ReturnType<typeof buildDemo30dPlan>;
