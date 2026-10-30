import { createHash } from "node:crypto";

import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";

import { Prisma, type ProductUnit } from "../generated/prisma/client.ts";
import { localDateToUtcBoundary } from "../modules/analytics/analytics-period.ts";

export const DEMO_30D_ORGANIZATION = "UAT Demo Siam Mart";
const optionsSchema = z
  .object({
    referenceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    seed: z.number().int().min(0).max(4_294_967_295),
  })
  .strict();

export interface Demo30dProduct {
  id: string;
  name: string;
  sku: string;
  unit: ProductUnit;
  basePrice: string;
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
}) {
  optionsSchema.parse({ referenceDate: input.referenceDate, seed: input.seed });
  const end = Temporal.PlainDate.from(input.referenceDate);
  const start = end.subtract({ days: 30 });
  const branches = [...input.branches]
    .sort((a, b) => a.code.localeCompare(b.code))
    .slice(0, 2)
    .map(({ id, code }) => ({ id, code }));
  const products = [...input.products]
    .sort((a, b) => a.sku.localeCompare(b.sku))
    .slice(0, 6);
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
        version: "demo30d-v1",
        organizationId: input.organizationId,
        referenceDate: input.referenceDate,
        seed: input.seed,
        reportingTimezone: input.reportingTimezone,
        branches,
        products,
        settings: input.settings,
      }),
    )
    .digest("hex");
  const prefix = `DEMO30D-${signature.slice(0, 24)}`;
  let state = input.seed >>> 0;
  const random = () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state;
  };
  const sales = Array.from({ length: 30 }, (_, day) => {
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
          localDateToUtcBoundary(date, input.reportingTimezone).getTime() +
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
  const orders = branches.flatMap((branch) =>
    [0, 15].map((day) => {
      const date = start.add({ days: day }).toString();
      return {
        reference: `${prefix}-po-${branch.code}-${day}`,
        branchId: branch.id,
        day,
        date,
        at: new Date(
          localDateToUtcBoundary(date, input.reportingTimezone).getTime() +
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
            quantity: demand
              .plus(day === 15 ? (index === 0 ? 1 : 80) : 1)
              .toFixed(4),
            expectedUnitCost: new Prisma.Decimal(product.basePrice)
              .div(2)
              .toFixed(4),
          };
        }),
      };
    }),
  );
  return {
    version: "demo30d-v1" as const,
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
}

export type Demo30dPlan = ReturnType<typeof buildDemo30dPlan>;
