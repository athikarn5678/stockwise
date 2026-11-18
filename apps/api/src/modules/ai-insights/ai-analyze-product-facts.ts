import { Prisma } from "../../generated/prisma/client.ts";
import type { AnalyticsProductFactRow } from "../analytics/analytics-product-facts-repository.ts";

const ExactDecimal = Prisma.Decimal.clone({ precision: 80 });
type Decimal = InstanceType<typeof ExactDecimal>;

const LIST_SIZE = 5;
const NAME_LIST_SIZE = 10;
/** Low stock = on hand covers at most this many days at the period's own pace. */
export const LOW_STOCK_COVER_DAYS = 7;

export type ProductSale = Readonly<{
  name: string;
  netSalesAmount: string;
  quantity: string;
}>;

export type ProductStock = Readonly<{
  /** Days the on-hand quantity lasts at the period's average daily sales (2 dp). */
  daysOfCover: string | null;
  name: string;
  onHandQuantity: string;
  quantitySoldInPeriod: string;
}>;

/** Deterministic product-level inputs; names and aggregates only. */
export type AiAnalyzeProductFacts = Readonly<{
  lowStock: Readonly<{
    count: number;
    coverDaysThreshold: number;
    items: readonly ProductStock[];
  }>;
  noSales: Readonly<{ count: number; names: readonly string[] }>;
  outOfStock: Readonly<{ count: number; items: readonly ProductStock[] }>;
  slowestByNetSales: readonly ProductSale[];
  slowestByQuantity: readonly ProductSale[];
  soldProductCount: number;
  topByNetSales: readonly ProductSale[];
  topByQuantity: readonly ProductSale[];
}>;

export const EMPTY_PRODUCT_FACTS: AiAnalyzeProductFacts = Object.freeze({
  lowStock: { count: 0, coverDaysThreshold: LOW_STOCK_COVER_DAYS, items: [] },
  noSales: { count: 0, names: [] },
  outOfStock: { count: 0, items: [] },
  slowestByNetSales: [],
  slowestByQuantity: [],
  soldProductCount: 0,
  topByNetSales: [],
  topByQuantity: [],
});

type Measured = Readonly<{
  name: string;
  net: Decimal;
  onHand: Decimal | null;
  quantity: Decimal;
  status: AnalyticsProductFactRow["status"];
}>;

function quantityText(value: Decimal): string {
  // Up to four decimals, no trailing zeros ("12", "0.5"), matching stored scale.
  return value.toDecimalPlaces(4).toFixed().replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

function byName(left: Measured, right: Measured): number {
  return left.name.localeCompare(right.name);
}

function ranked(
  products: readonly Measured[],
  key: (product: Measured) => Decimal,
  direction: "desc" | "asc",
): Measured[] {
  return [...products].sort((left, right) => {
    const compared =
      direction === "desc"
        ? key(right).comparedTo(key(left))
        : key(left).comparedTo(key(right));
    return compared !== 0 ? compared : byName(left, right);
  });
}

function sale(product: Measured): ProductSale {
  return Object.freeze({
    name: product.name,
    netSalesAmount: product.net.toFixed(2),
    quantity: quantityText(product.quantity),
  });
}

/** Ranks product rows without any floating-point arithmetic. */
export function buildAiAnalyzeProductFacts(input: {
  days: number;
  rows: readonly AnalyticsProductFactRow[];
}): AiAnalyzeProductFacts {
  const products: Measured[] = input.rows.map((row) => ({
    name: row.name,
    net: new ExactDecimal(row.netSalesAmount),
    onHand:
      row.onHandQuantity === null ? null : new ExactDecimal(row.onHandQuantity),
    quantity: new ExactDecimal(row.netQuantity),
    status: row.status,
  }));
  const sold = products.filter((product) => product.quantity.greaterThan(0));

  const top = (key: (product: Measured) => Decimal) =>
    ranked(sold, key, "desc").slice(0, LIST_SIZE);
  const topByNetSales = top((product) => product.net);
  const topByQuantity = top((product) => product.quantity);
  const slowest = (
    key: (product: Measured) => Decimal,
    exclude: readonly Measured[],
  ) =>
    ranked(
      sold.filter((product) => !exclude.includes(product)),
      key,
      "asc",
    ).slice(0, LIST_SIZE);

  // Stocked, active products that sold nothing in the period.
  const unsold = products
    .filter(
      (product) =>
        product.status === "ACTIVE" &&
        product.onHand !== null &&
        !product.quantity.greaterThan(0),
    )
    .sort(byName);

  const days = new ExactDecimal(input.days);
  const stocked = products.filter(
    (product) => product.status === "ACTIVE" && product.onHand !== null,
  );
  const stockOf = (product: Measured): ProductStock => {
    const onHand = product.onHand ?? new ExactDecimal(0);
    const dailyPace = product.quantity.div(days);
    return Object.freeze({
      daysOfCover:
        dailyPace.greaterThan(0) && onHand.greaterThan(0)
          ? onHand.div(dailyPace).toFixed(2)
          : null,
      name: product.name,
      onHandQuantity: quantityText(onHand),
      quantitySoldInPeriod: quantityText(
        product.quantity.greaterThan(0) ? product.quantity : new ExactDecimal(0),
      ),
    });
  };
  const outOfStock = stocked
    .filter((product) => !(product.onHand ?? new ExactDecimal(0)).greaterThan(0))
    .sort((left, right) => {
      const compared = right.quantity.comparedTo(left.quantity);
      return compared !== 0 ? compared : byName(left, right);
    });
  const threshold = new ExactDecimal(LOW_STOCK_COVER_DAYS);
  const lowStock = stocked
    .filter((product) => {
      const onHand = product.onHand;
      if (onHand === null || !onHand.greaterThan(0)) return false;
      const dailyPace = product.quantity.div(days);
      return dailyPace.greaterThan(0) && onHand.div(dailyPace).lessThanOrEqualTo(threshold);
    })
    .sort((left, right) => {
      const cover = (product: Measured) =>
        (product.onHand ?? new ExactDecimal(0)).div(product.quantity.div(days));
      const compared = cover(left).comparedTo(cover(right));
      return compared !== 0 ? compared : byName(left, right);
    });

  return Object.freeze({
    lowStock: {
      count: lowStock.length,
      coverDaysThreshold: LOW_STOCK_COVER_DAYS,
      items: lowStock.slice(0, NAME_LIST_SIZE).map(stockOf),
    },
    noSales: {
      count: unsold.length,
      names: unsold.slice(0, NAME_LIST_SIZE).map((product) => product.name),
    },
    outOfStock: {
      count: outOfStock.length,
      items: outOfStock.slice(0, NAME_LIST_SIZE).map(stockOf),
    },
    slowestByNetSales: slowest((product) => product.net, topByNetSales).map(sale),
    slowestByQuantity: slowest((product) => product.quantity, topByQuantity).map(sale),
    soldProductCount: sold.length,
    topByNetSales: topByNetSales.map(sale),
    topByQuantity: topByQuantity.map(sale),
  });
}
