import {
  Prisma,
  type PrismaClient,
  type ProductUnit,
} from "../../generated/prisma/client.ts";
import type { AnalyticsScopeCandidate } from "./analytics-scope.ts";
import { createPrismaAnalyticsScopeRepository } from "./analytics-scope-repository.ts";
import {
  buildForecast,
  createForecastWindow,
  FORECAST_HORIZON_DAYS,
  type ForecastResult,
  type ForecastWindow,
} from "./analytics-forecast-values.ts";

interface ForecastAggregateRow {
  branchId: string;
  productId: string;
  unit: ProductUnit;
  productStatus: "ACTIVE" | "INACTIVE";
  historyStartAt: Date | null;
  dayIndex: number;
  quantity: Prisma.Decimal;
}

export type ForecastRepositoryOutcome =
  | Readonly<{ kind: "success"; forecasts: readonly ForecastResult[] }>
  | Readonly<{
      kind: "forbidden" | "invalid_reporting_timezone" | "not_found";
    }>;

export interface ForecastRepository {
  read(input: {
    actorUserId: string;
    organizationId: string;
    productId: string;
    scope: AnalyticsScopeCandidate;
  }): Promise<ForecastRepositoryOutcome>;
}

type ForecastReadInput = Parameters<ForecastRepository["read"]>[0];

function boundsSql(window: ForecastWindow): Prisma.Sql[] {
  return window.trainingDays.map(
    (day, index) => Prisma.sql`(
    ${index}::integer,
    ${new Date(day.bucketStartInclusive)}::timestamptz,
    ${new Date(day.bucketEndExclusive)}::timestamptz
  )`,
  );
}

export function createPrismaForecastRepository(
  prisma: Pick<PrismaClient, "$transaction">,
  options: { now?: () => Date } = {},
): ForecastRepository {
  return {
    async read(input) {
      return prisma.$transaction(
        async (tx) => {
          // The first statement fixes the MVCC snapshot and obtains its database clock.
          const captured = await tx.$queryRaw<{ capturedAt: Date }[]>(
            options.now === undefined
              ? Prisma.sql`SELECT clock_timestamp() AS "capturedAt"`
              : Prisma.sql`SELECT ${options.now()}::timestamptz AS "capturedAt"`,
          );
          const sourceCutoff = captured[0]!.capturedAt;
          return readForecastInTransaction(tx, input, sourceCutoff);
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      );
    },
  };
}

/** Reorder composes this read after capturing its own snapshot clock. */
export async function readForecastInTransaction(
  tx: Prisma.TransactionClient,
  input: ForecastReadInput,
  sourceCutoff: Date,
  options: { activeBranchOnly?: boolean; horizonLength?: number } = {},
): Promise<ForecastRepositoryOutcome> {
  const resolved = await createPrismaAnalyticsScopeRepository(tx).resolve({
    actorUserId: input.actorUserId,
    analyticsKind: "forecast",
    candidate: input.scope,
    organizationId: input.organizationId,
  });
  if (resolved.kind !== "success") return resolved;

  const window = createForecastWindow(
    sourceCutoff,
    resolved.reportingTimezone,
    options.horizonLength ?? FORECAST_HORIZON_DAYS,
  );
  const branchIds = resolved.scope.branchIds.map(
    (id) => Prisma.sql`${id}::uuid`,
  );
  // Sale existence is the completed-Sale fact in the current immutable model.
  // Refunds, current stock, category, price and cost are intentionally absent.
  const rows = await tx.$queryRaw<ForecastAggregateRow[]>(Prisma.sql`
          WITH day_bounds (day_index, start_inclusive, end_exclusive) AS (
            VALUES ${Prisma.join(boundsSql(window))}
          ), pairs AS (
            SELECT branch.id AS branch_id, product.id AS product_id,
              product.unit::text AS unit, product.status::text AS product_status
            FROM branches AS branch
            CROSS JOIN products AS product
            WHERE branch.organization_id = ${input.organizationId}::uuid
              AND branch.id IN (${Prisma.join(branchIds)})
              ${options.activeBranchOnly === true ? Prisma.sql`AND branch.status = 'ACTIVE'` : Prisma.empty}
              AND product.organization_id = ${input.organizationId}::uuid
              AND product.id = ${input.productId}::uuid
          )
          SELECT pairs.branch_id::text AS "branchId",
            pairs.product_id::text AS "productId",
            pairs.unit, pairs.product_status AS "productStatus",
            history.first_movement_at AS "historyStartAt",
            days.day_index AS "dayIndex",
            COALESCE(SUM(items.quantity), 0)::numeric AS quantity
          FROM pairs
          CROSS JOIN day_bounds AS days
          LEFT JOIN LATERAL (
            SELECT MIN(movement.occurred_at) AS first_movement_at
            FROM inventory_transactions AS movement
            WHERE movement.organization_id = ${input.organizationId}::uuid
              AND movement.branch_id = pairs.branch_id
              AND movement.product_id = pairs.product_id
              AND movement.occurred_at <= ${sourceCutoff}::timestamptz
          ) AS history ON true
          LEFT JOIN sales AS sale
            ON sale.organization_id = ${input.organizationId}::uuid
            AND sale.branch_id = pairs.branch_id
            AND sale.completed_at >= days.start_inclusive
            AND sale.completed_at < days.end_exclusive
            AND sale.completed_at <= ${sourceCutoff}::timestamptz
          LEFT JOIN sale_items AS items
            ON items.sale_id = sale.id
            AND items.organization_id = sale.organization_id
            AND items.branch_id = sale.branch_id
            AND items.product_id = pairs.product_id
          GROUP BY pairs.branch_id, pairs.product_id, pairs.unit,
            pairs.product_status, history.first_movement_at, days.day_index
          ORDER BY pairs.branch_id, days.day_index
        `);
  if (rows.length === 0) return { kind: "not_found" };
  const byBranch = new Map<string, ForecastAggregateRow[]>();
  for (const row of rows) {
    const group = byBranch.get(row.branchId) ?? [];
    group.push(row);
    byBranch.set(row.branchId, group);
  }
  const forecasts = [...byBranch.values()].map((group) => {
    if (
      group.length !== 28 ||
      group.some((row, index) => row.dayIndex !== index)
    ) {
      throw new Error("Forecast training buckets are incomplete.");
    }
    const first = group[0]!;
    return buildForecast({
      organizationId: input.organizationId,
      branchId: first.branchId,
      productId: first.productId,
      unit: first.unit,
      productStatus: first.productStatus,
      generatedAt: sourceCutoff,
      sourceCutoff,
      historyStartAt: first.historyStartAt,
      window,
      training: group.map((row) => row.quantity),
    });
  });
  return { kind: "success", forecasts };
}
