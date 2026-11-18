import { Prisma, type PrismaClient } from "../../generated/prisma/client.ts";
import type { AnalyticsExecutionContext } from "./analytics-context.ts";

/** One catalog product's period facts inside the authorized scope. */
export type AnalyticsProductFactRow = Readonly<{
  name: string;
  /** Sold minus refunded quantity in the period (decimal string). */
  netQuantity: string;
  /** Sale line net minus refunded line net in the period (decimal string). */
  netSalesAmount: string;
  /** Current on-hand summed over the scope's branches; null = never stocked there. */
  onHandQuantity: string | null;
  status: "ACTIVE" | "INACTIVE";
}>;

export type AnalyticsProductFacts = Readonly<{
  rows: readonly AnalyticsProductFactRow[];
  /** True when the product list was cut at the safety limit. */
  truncated: boolean;
}>;

export interface AnalyticsProductFactsRepository {
  read(context: AnalyticsExecutionContext): Promise<AnalyticsProductFacts>;
}

// A deliberate bound: ranking over a partial product list would be wrong, so
// callers treat `truncated` as "unavailable" instead of using the rows.
export const PRODUCT_FACT_ROW_LIMIT = 5_000;

export function createPrismaAnalyticsProductFactsRepository(
  prisma: Pick<PrismaClient, "$queryRaw">,
): AnalyticsProductFactsRepository {
  return {
    async read(context) {
      const organizationId = context.scope.organizationId;
      const branchIds = Prisma.join(
        context.scope.branchIds.map((id) => Prisma.sql`${id}::uuid`),
      );
      const start = context.period.periodStartInclusive;
      const end = context.period.periodEndExclusive;
      const cutoff = context.period.sourceCutoff;

      // Every table is filtered by the trusted organization and branch ids from
      // the authorized scope; no request value reaches this query.
      const rows = await prisma.$queryRaw<
        {
          name: string;
          netQuantity: string;
          netSalesAmount: string;
          onHandQuantity: string | null;
          status: "ACTIVE" | "INACTIVE";
        }[]
      >(Prisma.sql`
        WITH sale_facts AS (
          SELECT items.product_id,
            SUM(items.quantity)::numeric AS quantity,
            SUM(items.line_net)::numeric AS net
          FROM sales
          JOIN sale_items AS items ON items.sale_id = sales.id
            AND items.organization_id = sales.organization_id
            AND items.branch_id = sales.branch_id
          WHERE sales.organization_id = ${organizationId}::uuid
            AND sales.branch_id IN (${branchIds})
            AND sales.completed_at >= ${start}::timestamptz
            AND sales.completed_at < ${end}::timestamptz
            AND sales.completed_at <= ${cutoff}::timestamptz
          GROUP BY items.product_id
        ),
        refund_facts AS (
          SELECT items.product_id,
            SUM(items.refund_quantity)::numeric AS quantity,
            SUM(items.reversed_line_net)::numeric AS net
          FROM sale_refunds AS refund
          JOIN sale_refund_items AS items ON items.sale_refund_id = refund.id
            AND items.organization_id = refund.organization_id
            AND items.branch_id = refund.branch_id
            AND items.sale_id = refund.sale_id
          WHERE refund.organization_id = ${organizationId}::uuid
            AND refund.branch_id IN (${branchIds})
            AND refund.completed_at >= ${start}::timestamptz
            AND refund.completed_at < ${end}::timestamptz
            AND refund.completed_at <= ${cutoff}::timestamptz
          GROUP BY items.product_id
        ),
        stock AS (
          SELECT product_id, SUM(quantity)::numeric AS on_hand
          FROM inventory_balances
          WHERE organization_id = ${organizationId}::uuid
            AND branch_id IN (${branchIds})
          GROUP BY product_id
        )
        SELECT products.name AS "name",
          products.status::text AS "status",
          (COALESCE(sale_facts.quantity, 0) - COALESCE(refund_facts.quantity, 0))::text AS "netQuantity",
          (COALESCE(sale_facts.net, 0) - COALESCE(refund_facts.net, 0))::text AS "netSalesAmount",
          stock.on_hand::text AS "onHandQuantity"
        FROM products
        LEFT JOIN sale_facts ON sale_facts.product_id = products.id
        LEFT JOIN refund_facts ON refund_facts.product_id = products.id
        LEFT JOIN stock ON stock.product_id = products.id
        WHERE products.organization_id = ${organizationId}::uuid
          AND (sale_facts.product_id IS NOT NULL
            OR refund_facts.product_id IS NOT NULL
            OR stock.product_id IS NOT NULL)
        ORDER BY products.id
        LIMIT ${PRODUCT_FACT_ROW_LIMIT + 1}
      `);
      return {
        rows: rows.slice(0, PRODUCT_FACT_ROW_LIMIT),
        truncated: rows.length > PRODUCT_FACT_ROW_LIMIT,
      };
    },
  };
}
