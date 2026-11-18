import { Prisma, type PrismaClient } from "../../generated/prisma/client.ts";
import { readForecastInTransaction } from "./analytics-forecast-repository.ts";
import { REORDER_HORIZON_DAYS } from "./analytics-forecast-values.ts";
import {
  invalidInventoryMovementSql,
  inventorySourceItemErrorsSql,
} from "./analytics-inventory-integrity.ts";
import {
  buildReorder,
  isSupportedLeadTime,
  type ReorderResult,
  type ReorderStock,
} from "./analytics-reorder-values.ts";

export type ReorderRepositoryOutcome =
  | Readonly<{ kind: "success"; recommendation: ReorderResult }>
  | Readonly<{
      kind: "forbidden" | "invalid_reporting_timezone" | "not_found";
    }>;

export interface ReorderRepository {
  read(input: {
    actorUserId: string;
    organizationId: string;
    branchId: string;
    productId: string;
    leadTimeDays?: number;
  }): Promise<ReorderRepositoryOutcome>;
}

export function createPrismaReorderRepository(
  prisma: Pick<PrismaClient, "$transaction">,
  options: {
    now?: () => Date;
    afterSnapshotCaptured?: () => Promise<void>;
  } = {},
): ReorderRepository {
  return {
    async read(input) {
      return prisma.$transaction(
        async (tx) => {
          // This first statement establishes the snapshot and its one event cutoff.
          const captured = await tx.$queryRaw<{ capturedAt: Date }[]>(
            options.now === undefined
              ? Prisma.sql`SELECT clock_timestamp() AS "capturedAt"`
              : Prisma.sql`SELECT ${options.now()}::timestamptz AS "capturedAt"`,
          );
          const sourceCutoff = captured[0]!.capturedAt;
          await options.afterSnapshotCaptured?.();
          const forecast = await readForecastInTransaction(
            tx,
            {
              actorUserId: input.actorUserId,
              organizationId: input.organizationId,
              productId: input.productId,
              scope: { kind: "branch", branchId: input.branchId },
            },
            sourceCutoff,
            { activeBranchOnly: true, horizonLength: REORDER_HORIZON_DAYS },
          );
          if (forecast.kind !== "success") return forecast;
          const pair = forecast.forecasts[0];
          if (pair === undefined || forecast.forecasts.length !== 1)
            throw new Error(
              "Reorder requires one authorized Branch/Product forecast.",
            );

          // Earlier unavailable reasons need no stock read.
          if (
            pair.status === "UNAVAILABLE" ||
            input.leadTimeDays === undefined ||
            !isSupportedLeadTime(input.leadTimeDays)
          ) {
            return {
              kind: "success",
              recommendation: buildReorder({
                forecast: pair,
                ...(input.leadTimeDays === undefined
                  ? {}
                  : { leadTimeDays: input.leadTimeDays }),
              }),
            };
          }

          const rows = await tx.$queryRaw<ReorderStock[]>(Prisma.sql`
            WITH page AS (
              SELECT branch.id AS branch_id, product.id AS product_id,
                product.unit::text AS product_unit
              FROM branches AS branch CROSS JOIN products AS product
              WHERE branch.organization_id = ${input.organizationId}::uuid
                AND branch.id = ${input.branchId}::uuid AND branch.status = 'ACTIVE'
                AND product.organization_id = ${input.organizationId}::uuid
                AND product.id = ${input.productId}::uuid
            ), ledger AS (
              SELECT page.branch_id, page.product_id,
                COALESCE(SUM(t.delta), 0)::numeric AS ledger_quantity,
                COUNT(t.id) FILTER (WHERE ${invalidInventoryMovementSql})::bigint AS invalid_source_count
              FROM page
              LEFT JOIN inventory_transactions AS t ON t.organization_id = ${input.organizationId}::uuid
                AND t.branch_id = page.branch_id AND t.product_id = page.product_id
              LEFT JOIN purchase_receipt_items AS r ON r.id = t.purchase_receipt_item_id
                AND r.organization_id = t.organization_id AND r.branch_id = t.branch_id AND r.product_id = t.product_id
              LEFT JOIN sale_items AS s ON s.id = t.sale_item_id
                AND s.organization_id = t.organization_id AND s.branch_id = t.branch_id AND s.product_id = t.product_id
              LEFT JOIN sale_refund_items AS f ON f.id = t.sale_refund_item_id
                AND f.organization_id = t.organization_id AND f.branch_id = t.branch_id AND f.product_id = t.product_id
              GROUP BY page.branch_id, page.product_id
            ), ${inventorySourceItemErrorsSql(input.organizationId)}
            SELECT COALESCE(balance.quantity, 0)::numeric AS "onHand",
              ledger.ledger_quantity AS "ledgerQuantity",
              (ledger.invalid_source_count + source_item_errors.error_count)::bigint AS "invalidSourceCount"
            FROM page
            JOIN ledger ON ledger.branch_id = page.branch_id AND ledger.product_id = page.product_id
            JOIN source_item_errors ON source_item_errors.branch_id = page.branch_id
              AND source_item_errors.product_id = page.product_id
            LEFT JOIN inventory_balances AS balance ON balance.organization_id = ${input.organizationId}::uuid
              AND balance.branch_id = page.branch_id AND balance.product_id = page.product_id
          `);
          const stock = rows[0];
          if (stock === undefined || rows.length !== 1)
            return { kind: "not_found" };
          return {
            kind: "success",
            recommendation: buildReorder({
              forecast: pair,
              leadTimeDays: input.leadTimeDays,
              stock,
            }),
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      );
    },
  };
}
