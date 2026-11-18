import { createHash } from "node:crypto";

import { Temporal } from "@js-temporal/polyfill";
import { describe, expect, it } from "vitest";

import { Prisma } from "../generated/prisma/client.ts";
import {
  buildDemo30dPlan,
  demoWindowShape,
  type Demo30dPlan,
} from "./demo-30d-plan.ts";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function demoProducts(count: number, sku: (index: number) => string) {
  return Array.from({ length: count }, (_, index) => ({
    id: id(10 + index),
    name: `P${index}`,
    sku: sku(index),
    unit: "EA" as const,
    basePrice: `${10 + index}.0000`,
  }));
}

const legacyInput = {
  referenceDate: "2026-11-01",
  seed: 30,
  reportingTimezone: "Asia/Bangkok",
  organizationId: id(1),
  branches: [
    { id: id(2), code: "MAIN" },
    { id: id(3), code: "NORTH" },
  ],
  products: demoProducts(8, (index) => `SKU-${index}`),
  settings: {
    actorUserId: id(4),
    supplierId: id(5),
    salesVatStatus: "NOT_REGISTERED" as const,
    salesVatRate: null,
  },
};

const WINDOW_SHAPE = demoWindowShape("2026-11-01");

const shapedInput = {
  referenceDate: "2026-11-01",
  seed: 30,
  reportingTimezone: "Asia/Bangkok",
  organizationId: id(1),
  branches: [
    { id: id(2), code: "MAIN" },
    { id: id(3), code: "NORTH" },
    { id: id(4), code: "SOUTH" },
  ],
  products: demoProducts(
    12,
    (index) => `SKU-${String(index).padStart(2, "0")}`,
  ),
  settings: {
    actorUserId: id(5),
    supplierId: id(6),
    salesVatStatus: "NOT_REGISTERED" as const,
    salesVatRate: null,
  },
};

function buildShapedPlan(): Demo30dPlan {
  return buildDemo30dPlan({ ...shapedInput, shape: WINDOW_SHAPE });
}

describe("buildDemo30dPlan", () => {
  it("keeps the legacy 30-day plan byte-identical", () => {
    const plan = buildDemo30dPlan(legacyInput);

    expect(plan.signature).toBe(
      "11550e8d49de3262c03c72480240bbd5ff0b7f9ffcd5ed04a6ef499042f9a745",
    );
    expect(plan.version).toBe("demo30d-v1");
    expect(plan.prefix).toBe(`DEMO30D-${plan.signature.slice(0, 24)}`);
    expect(plan.from).toBe("2026-10-02");
    expect(plan.to).toBe("2026-11-01");
    expect(plan.branches).toHaveLength(2);
    expect(plan.products).toHaveLength(6);
    expect(plan.sales).toHaveLength(436);
    expect(plan.orders).toHaveLength(4);
    expect(plan.sales.filter((sale) => sale.refund)).toHaveLength(3);
    expect(
      createHash("sha256").update(JSON.stringify(plan)).digest("hex"),
    ).toBe("73ff732bd87720631fe3c9080ce88ae0dfe1c53ea38e4b6e1e8c3e9c9208b27f");
    expect(Object.keys(plan)).toEqual([
      "version",
      "signature",
      "prefix",
      "referenceDate",
      "seed",
      "organizationId",
      "reportingTimezone",
      "from",
      "to",
      "branches",
      "products",
      "orders",
      "sales",
      "settings",
    ]);
    expect("shape" in plan).toBe(false);
    expect("adjustments" in plan).toBe(false);
  });

  it("builds a deterministic windowed plan with adjustments", () => {
    const plan = buildShapedPlan();

    expect(plan.shape).toEqual(WINDOW_SHAPE);
    expect(plan.version).toBe("demo90d-v1");
    expect(plan.prefix).toBe(`SM-${plan.signature.slice(0, 12)}`);
    expect(plan.branches).toHaveLength(3);
    expect(plan.products).toHaveLength(12);
    expect(
      Temporal.PlainDate.from(plan.to)
        .since(Temporal.PlainDate.from(plan.from))
        .days.valueOf(),
    ).toBe(WINDOW_SHAPE.days);

    expect(plan.orders).toHaveLength(21);
    for (const branch of plan.branches) {
      const orders = plan.orders.filter((o) => o.branchId === branch.id);
      expect(orders).toHaveLength(7);
      for (const order of orders) expect(order.items).toHaveLength(12);
    }

    expect(plan.adjustments).toHaveLength(9);
    const adjustmentDays = [
      ...new Set(plan.adjustments?.map((adjustment) => adjustment.day) ?? []),
    ];
    expect(adjustmentDays).toEqual([20, 50, 80]);
    expect(plan.adjustments?.map((a) => a.day)).toEqual(
      adjustmentDays.flatMap((day) => [day, day, day]),
    );
    expect(plan.adjustments?.map((a) => a.branchId)).toEqual(
      adjustmentDays.flatMap(() => plan.branches.map((branch) => branch.id)),
    );
    for (const adjustment of plan.adjustments ?? [])
      expect(
        plan.products.findIndex((p) => p.id === adjustment.productId) % 3,
      ).toBe(1);

    expect(plan.sales.length).toBeGreaterThanOrEqual(700);
    expect(plan.sales.length).toBeLessThanOrEqual(1100);
    expect(plan.sales.filter((sale) => sale.refund)).toHaveLength(9);
    expect(new Set(plan.sales.map((sale) => sale.method))).toEqual(
      new Set(["CASH", "TRANSFER"]),
    );
    for (const sale of plan.sales) {
      expect(sale.items).toHaveLength(2);
      expect(sale.items[0]!.productId).not.toBe(sale.items[1]!.productId);
    }

    expect(buildShapedPlan()).toEqual(plan);
    expect(
      buildDemo30dPlan({ ...shapedInput, seed: 31, shape: WINDOW_SHAPE })
        .signature,
    ).not.toBe(plan.signature);
  });

  it("never spends more stock than the shaped plan supplies", () => {
    const plan = buildShapedPlan();
    const events: { at: number; key: string; delta: Prisma.Decimal }[] = [];
    for (const order of plan.orders)
      for (const item of order.items)
        events.push({
          at: order.at.getTime(),
          key: `${order.branchId}:${item.productId}`,
          delta: new Prisma.Decimal(item.quantity),
        });
    for (const sale of plan.sales) {
      for (const item of sale.items)
        events.push({
          at: sale.at.getTime(),
          key: `${sale.branchId}:${item.productId}`,
          delta: new Prisma.Decimal(item.quantity).neg(),
        });
      if (sale.refund)
        events.push({
          at: sale.at.getTime() + 60_000,
          key: `${sale.branchId}:${sale.items[0]!.productId}`,
          delta: new Prisma.Decimal(1),
        });
    }
    for (const adjustment of plan.adjustments ?? [])
      events.push({
        at: adjustment.at.getTime(),
        key: `${adjustment.branchId}:${adjustment.productId}`,
        delta: new Prisma.Decimal(adjustment.delta),
      });
    events.sort((left, right) => left.at - right.at);

    const balances = new Map<string, Prisma.Decimal>();
    for (const event of events) {
      const balance = (balances.get(event.key) ?? new Prisma.Decimal(0)).plus(
        event.delta,
      );
      expect(balance.gte(0)).toBe(true);
      balances.set(event.key, balance);
    }
    expect(balances.size).toBe(plan.branches.length * plan.products.length);
  });

  it("rejects shapes outside the accepted bounds", () => {
    expect(() =>
      buildDemo30dPlan({
        ...shapedInput,
        shape: { ...WINDOW_SHAPE, days: 130 },
      }),
    ).toThrow();
    expect(() =>
      buildDemo30dPlan({
        ...shapedInput,
        shape: { ...WINDOW_SHAPE, branchLimit: 4 },
      }),
    ).toThrow();
    expect(() =>
      buildDemo30dPlan({
        ...shapedInput,
        shape: { ...WINDOW_SHAPE, productLimit: 2 },
      }),
    ).toThrow();
  });

  it("keeps the adjustments key empty when the shape disables them", () => {
    const plan = buildDemo30dPlan({
      ...shapedInput,
      shape: { ...WINDOW_SHAPE, adjustments: false },
    });
    expect(plan.adjustments).toEqual([]);
    expect(plan.shape?.adjustments).toBe(false);
  });

  it.each([
    ["2026-11-18", "2026-08-01", 109],
    ["2026-12-01", "2026-09-01", 91],
    ["2026-11-30", "2026-08-01", 121],
    ["2027-01-01", "2026-10-01", 92],
    ["2027-03-01", "2026-12-01", 90],
    ["2028-03-01", "2027-12-01", 91],
  ] as const)(
    "starts the window on the 1st three months back for a %s run",
    (referenceDate, firstDay, days) => {
      const shape = demoWindowShape(referenceDate);
      expect(shape.days).toBe(days);
      const plan = buildDemo30dPlan({
        ...shapedInput,
        referenceDate,
        shape,
      });
      expect(plan.from).toBe(firstDay);
      expect(plan.to).toBe(referenceDate);
      const lastDay = Temporal.PlainDate.from(referenceDate)
        .subtract({ days: 1 })
        .toString();
      const saleDays = plan.sales.map((sale) =>
        sale.at.toLocaleDateString("en-CA", {
          timeZone: plan.reportingTimezone,
        }),
      );
      // History covers the first day and yesterday; today has no seeded transaction.
      expect(saleDays).toContain(firstDay);
      expect(saleDays).toContain(lastDay);
      expect(saleDays).not.toContain(referenceDate);
      expect(Math.min(...saleDays.map((day) => Date.parse(day)))).toBe(
        Date.parse(firstDay),
      );
      expect(plan.orders).toHaveLength(3 * Math.ceil(days / 15));
    },
  );
});
