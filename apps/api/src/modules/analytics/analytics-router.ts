import { Router, type RequestHandler, type Response } from "express";
import { z } from "zod";

import { getTrustedAuthenticationContext } from "../identity/authentication-context.ts";
import type { createAnalyticsBranchService } from "./analytics-branch-service.ts";
import type { createAnalyticsCategoryService } from "./analytics-category-service.ts";
import type { AnalyticsExecutionContext } from "./analytics-context.ts";
import type { AnalyticsPeriodError } from "./analytics-period.ts";
import { AnalyticsPeriodError as PeriodError } from "./analytics-period.ts";
import type { AnalyticsSalesService } from "./analytics-sales-service.ts";
import type { createAnalyticsInventoryService } from "./analytics-inventory-service.ts";
import type { createForecastService } from "./analytics-forecast-service.ts";
import type { createReorderService } from "./analytics-reorder-service.ts";
import type { InventoryDimension } from "./analytics-inventory-values.ts";
import type { InventoryBranchSummary } from "./analytics-inventory-repository.ts";
import type { AnalyticsSalesMetricBucket } from "./analytics-sales-values.ts";
import type {
  AnalyticsCategoryMetricBucket,
  AnalyticsCategorySeries,
} from "./analytics-category-values.ts";
import type { AnalyticsBranchSeries } from "./analytics-branch-repository.ts";
import { analyticsPeriodSelectorSchema } from "./analytics-schemas.ts";

const paramsSchema = z.object({ organizationId: z.string().uuid() }).strict();
const limitSchema = z
  .string()
  .regex(/^[1-9]\d*$/)
  .transform(Number)
  .pipe(z.number().int().max(100));
const salesQuerySchema = z.discriminatedUnion("scope", [
  analyticsPeriodSelectorSchema.extend({ scope: z.literal("organization") }),
  analyticsPeriodSelectorSchema.extend({
    branchId: z.string().uuid(),
    scope: z.literal("branch"),
  }),
]);
const pageFields = {
  cursor: z.string().min(1).max(4096).optional(),
  limit: limitSchema.optional(),
};
const dimensionQuerySchema = z.discriminatedUnion("scope", [
  analyticsPeriodSelectorSchema.extend({
    scope: z.literal("organization"),
    ...pageFields,
  }),
  analyticsPeriodSelectorSchema.extend({
    branchId: z.string().uuid(),
    scope: z.literal("branch"),
    ...pageFields,
  }),
]);
const pairQuerySchema = z
  .object({
    branchId: z.string().uuid(),
    productId: z.string().uuid(),
  })
  .strict();
const reorderQuerySchema = pairQuerySchema.extend({
  // ADR-032 amendment: planning lead time options are exactly 7 and 30 days.
  leadTimeDays: z.enum(["7", "30"]).transform(Number).optional(),
});

function requestId(response: Response): string {
  const value = response.getHeader("X-Request-Id");
  return typeof value === "string" ? value : "unavailable";
}

function error(
  response: Response,
  status: number,
  code: string,
  message: string,
): void {
  response
    .status(status)
    .json({ error: { code, message, requestId: requestId(response) } });
}

function metadata(context: AnalyticsExecutionContext, response: Response) {
  const { period, scope } = context;
  return {
    dataStatus: period.dataStatus,
    generatedAt: new Date().toISOString(),
    granularity: period.granularity,
    includedBranchCount: scope.branchCount,
    includedBranchIds: scope.branchIds,
    localFromInclusive: period.from,
    localToExclusive: period.to,
    metricDefinitionVersion: period.metricDefinitionVersion,
    organizationId: scope.organizationId,
    periodEndExclusive: period.periodEndExclusive.toISOString(),
    periodStartInclusive: period.periodStartInclusive.toISOString(),
    reportingTimezone: period.reportingTimezone,
    requestId: requestId(response),
    scopeType: scope.kind,
    sourceCutoff: period.sourceCutoff.toISOString(),
  };
}

function salesBucket(bucket: AnalyticsSalesMetricBucket) {
  return {
    averageOrderValue: bucket.averageOrderValue,
    bucketEndExclusive: bucket.bucketEndExclusive.toISOString(),
    bucketStartInclusive: bucket.bucketStartInclusive.toISOString(),
    ...(bucket.cost === undefined ? {} : { cost: bucket.cost }),
    dataStatus: bucket.dataStatus,
    discountAmount: bucket.discountAmount,
    grossSalesAmount: bucket.grossSalesAmount,
    label: bucket.label,
    localEndExclusive: bucket.localEndExclusive,
    localStartInclusive: bucket.localStartInclusive,
    netOutputVatAmount: bucket.netOutputVatAmount,
    netSalesAmount: bucket.netSalesAmount,
    netSalesGrowthPercent: bucket.netSalesGrowthPercent,
    outputVatAmount: bucket.outputVatAmount,
    refundAmount: bucket.refundAmount,
    refundCount: bucket.refundCount,
    refundedDiscountAmount: bucket.refundedDiscountAmount,
    refundedOutputVatAmount: bucket.refundedOutputVatAmount,
    refundedRegisteredTaxableAmount: bucket.refundedRegisteredTaxableAmount,
    refundedSaleCount: bucket.refundedSaleCount,
    registeredTaxableSalesAmount: bucket.registeredTaxableSalesAmount,
    saleCount: bucket.saleCount,
    salesAfterDiscountAmount: bucket.salesAfterDiscountAmount,
  };
}

function categoryBucket(bucket: AnalyticsCategoryMetricBucket) {
  return {
    bucketEndExclusive: bucket.bucketEndExclusive.toISOString(),
    bucketStartInclusive: bucket.bucketStartInclusive.toISOString(),
    categorySharePercent: bucket.categorySharePercent,
    dataStatus: bucket.dataStatus,
    discountAmount: bucket.discountAmount,
    grossSalesAmount: bucket.grossSalesAmount,
    label: bucket.label,
    localEndExclusive: bucket.localEndExclusive,
    localStartInclusive: bucket.localStartInclusive,
    netSalesAmount: bucket.netSalesAmount,
    refundAmount: bucket.refundAmount,
    salesAfterDiscountAmount: bucket.salesAfterDiscountAmount,
  };
}

function inventoryBucket(bucket: InventoryDimension["buckets"][number]) {
  return {
    bucketEndExclusive: bucket.bucketEndExclusive.toISOString(),
    bucketStartInclusive: bucket.bucketStartInclusive.toISOString(),
    dataStatus: bucket.dataStatus,
    label: bucket.label,
    localEndExclusive: bucket.localEndExclusive,
    localStartInclusive: bucket.localStartInclusive,
    purchaseReceivedQuantity: bucket.purchaseReceivedQuantity,
    saleDepletionQuantity: bucket.saleDepletionQuantity,
    refundReturnQuantity: bucket.refundReturnQuantity,
    positiveAdjustmentQuantity: bucket.positiveAdjustmentQuantity,
    negativeAdjustmentQuantity: bucket.negativeAdjustmentQuantity,
  };
}

function inventoryDimension(row: InventoryDimension) {
  return { ...row, buckets: row.buckets.map(inventoryBucket) };
}

type AnalyticsHttpMetadata = ReturnType<typeof metadata>;
type AnalyticsDimensionMetadata = AnalyticsHttpMetadata & {
  nextCursor: string | null;
};

export interface AnalyticsSalesHttpResponse {
  data: { buckets: ReturnType<typeof salesBucket>[] };
  meta: AnalyticsHttpMetadata;
}

export interface AnalyticsCategoryHttpResponse {
  data: {
    categories: (Pick<
      AnalyticsCategorySeries,
      "categoryId" | "categoryKind" | "categoryName" | "categoryStatus"
    > & {
      buckets: ReturnType<typeof categoryBucket>[];
    })[];
  };
  meta: AnalyticsDimensionMetadata;
}

export interface AnalyticsBranchHttpResponse {
  data: {
    branches: (Pick<
      AnalyticsBranchSeries,
      "branchId" | "branchName" | "branchStatus"
    > & {
      buckets: ReturnType<typeof salesBucket>[];
    })[];
  };
  meta: AnalyticsDimensionMetadata;
}

export interface AnalyticsInventoryHttpResponse {
  data: {
    dimensions: ReturnType<typeof inventoryDimension>[];
    branches: readonly InventoryBranchSummary[];
  };
  meta: AnalyticsDimensionMetadata & { currentSnapshotCapturedAt: string };
}

function handlePeriodError(cause: unknown, response: Response): boolean {
  if (!(cause instanceof PeriodError)) return false;
  const code: AnalyticsPeriodError["code"] = cause.code;
  if (code === "INVALID_TIMEZONE" || code === "INVALID_SOURCE_CUTOFF") {
    error(
      response,
      500,
      "ANALYTICS_CONFIGURATION_ERROR",
      "Analytics configuration is invalid.",
    );
  } else {
    error(
      response,
      400,
      "VALIDATION_ERROR",
      "The analytics period is invalid.",
    );
  }
  return true;
}

function sendAnalyticsFailure(
  response: Response,
  kind: "forbidden" | "invalid_cursor" | "invalid_reporting_timezone",
): void {
  if (kind === "forbidden") {
    error(response, 403, "FORBIDDEN", "The operation is not permitted.");
  } else if (kind === "invalid_cursor") {
    error(response, 400, "INVALID_CURSOR", "The cursor is invalid.");
  } else {
    error(
      response,
      500,
      "ANALYTICS_CONFIGURATION_ERROR",
      "Analytics configuration is invalid.",
    );
  }
}

export function createAnalyticsRouter(input: {
  authenticationMiddleware: RequestHandler;
  branchService: ReturnType<typeof createAnalyticsBranchService>;
  categoryService: ReturnType<typeof createAnalyticsCategoryService>;
  inventoryService: ReturnType<typeof createAnalyticsInventoryService>;
  forecastService: ReturnType<typeof createForecastService>;
  reorderService: ReturnType<typeof createReorderService>;
  salesService: AnalyticsSalesService;
}): Router {
  const router = Router();

  router.get(
    "/organizations/:organizationId/analytics/sales",
    input.authenticationMiddleware,
    async (request, response, next) => {
      const actor = getTrustedAuthenticationContext(response);
      if (actor === null)
        return error(
          response,
          401,
          "AUTHENTICATION_REQUIRED",
          "Authentication is required.",
        );
      const params = paramsSchema.safeParse(request.params);
      const query = salesQuerySchema.safeParse(request.query);
      if (!params.success || !query.success)
        return error(
          response,
          400,
          "VALIDATION_ERROR",
          "The request is invalid.",
        );
      const { from, granularity, to } = query.data;
      const scope =
        query.data.scope === "branch"
          ? { kind: "branch" as const, branchId: query.data.branchId }
          : { kind: "organization" as const };
      try {
        const outcome = await input.salesService.read({
          actorUserId: actor.actor.id,
          from,
          granularity,
          organizationId: params.data.organizationId,
          scope,
          to,
        });
        if (outcome.kind !== "success")
          return sendAnalyticsFailure(response, outcome.kind);
        const body: AnalyticsSalesHttpResponse = {
          data: { buckets: outcome.metrics.buckets.map(salesBucket) },
          meta: metadata(outcome.metrics.context, response),
        };
        response.status(200).json(body);
      } catch (cause: unknown) {
        if (!handlePeriodError(cause, response)) next(cause);
      }
    },
  );

  const dimensions = [
    { path: "categories", kind: "category" },
    { path: "branches", kind: "branch" },
  ] as const;
  for (const dimension of dimensions) {
    router.get(
      `/organizations/:organizationId/analytics/${dimension.path}`,
      input.authenticationMiddleware,
      async (request, response, next) => {
        const actor = getTrustedAuthenticationContext(response);
        if (actor === null)
          return error(
            response,
            401,
            "AUTHENTICATION_REQUIRED",
            "Authentication is required.",
          );
        const params = paramsSchema.safeParse(request.params);
        const query = dimensionQuerySchema.safeParse(request.query);
        if (!params.success || !query.success)
          return error(
            response,
            400,
            "VALIDATION_ERROR",
            "The request is invalid.",
          );
        const { from, granularity, to } = query.data;
        const scope =
          query.data.scope === "branch"
            ? { kind: "branch" as const, branchId: query.data.branchId }
            : { kind: "organization" as const };
        const page = {
          actorUserId: actor.actor.id,
          ...(query.data.cursor === undefined
            ? {}
            : { cursor: query.data.cursor }),
          from,
          granularity,
          ...(query.data.limit === undefined
            ? {}
            : { limit: query.data.limit }),
          organizationId: params.data.organizationId,
          scope,
          to,
        };
        try {
          if (dimension.kind === "category") {
            const outcome = await input.categoryService.read(page);
            if (outcome.kind !== "success")
              return sendAnalyticsFailure(response, outcome.kind);
            const body: AnalyticsCategoryHttpResponse = {
              data: {
                categories: outcome.page.series.map((series) => ({
                  categoryId: series.categoryId,
                  categoryKind: series.categoryKind,
                  categoryName: series.categoryName,
                  categoryStatus: series.categoryStatus,
                  buckets: series.buckets.map(categoryBucket),
                })),
              },
              meta: {
                ...metadata(outcome.page.context, response),
                nextCursor: outcome.page.nextCursor,
              },
            };
            response.status(200).json(body);
          } else {
            const outcome = await input.branchService.read(page);
            if (outcome.kind !== "success")
              return sendAnalyticsFailure(response, outcome.kind);
            const body: AnalyticsBranchHttpResponse = {
              data: {
                branches: outcome.page.series.map((series) => ({
                  branchId: series.branchId,
                  branchName: series.branchName,
                  branchStatus: series.branchStatus,
                  buckets: series.buckets.map(salesBucket),
                })),
              },
              meta: {
                ...metadata(outcome.page.context, response),
                nextCursor: outcome.page.nextCursor,
              },
            };
            response.status(200).json(body);
          }
        } catch (cause: unknown) {
          if (!handlePeriodError(cause, response)) next(cause);
        }
      },
    );
  }
  router.get(
    "/organizations/:organizationId/analytics/inventory",
    input.authenticationMiddleware,
    async (request, response, next) => {
      const actor = getTrustedAuthenticationContext(response);
      if (actor === null)
        return error(
          response,
          401,
          "AUTHENTICATION_REQUIRED",
          "Authentication is required.",
        );
      const params = paramsSchema.safeParse(request.params);
      const query = dimensionQuerySchema.safeParse(request.query);
      if (!params.success || !query.success)
        return error(
          response,
          400,
          "VALIDATION_ERROR",
          "The request is invalid.",
        );
      const { from, granularity, to } = query.data;
      const scope =
        query.data.scope === "branch"
          ? { kind: "branch" as const, branchId: query.data.branchId }
          : { kind: "organization" as const };
      try {
        const outcome = await input.inventoryService.read({
          actorUserId: actor.actor.id,
          ...(query.data.cursor === undefined
            ? {}
            : { cursor: query.data.cursor }),
          from,
          granularity,
          ...(query.data.limit === undefined
            ? {}
            : { limit: query.data.limit }),
          organizationId: params.data.organizationId,
          scope,
          to,
        });
        if (outcome.kind !== "success")
          return sendAnalyticsFailure(response, outcome.kind);
        const body: AnalyticsInventoryHttpResponse = {
          data: {
            dimensions: outcome.page.series.map(inventoryDimension),
            branches: outcome.page.branches,
          },
          meta: {
            ...metadata(outcome.page.context, response),
            currentSnapshotCapturedAt:
              outcome.page.currentSnapshotCapturedAt.toISOString(),
            nextCursor: outcome.page.nextCursor,
          },
        };
        response.status(200).json(body);
      } catch (cause: unknown) {
        if (!handlePeriodError(cause, response)) next(cause);
      }
    },
  );
  for (const kind of ["forecast", "reorder-recommendations"] as const) {
    router.get(
      `/organizations/:organizationId/analytics/${kind}`,
      input.authenticationMiddleware,
      async (request, response, next) => {
        const actor = getTrustedAuthenticationContext(response);
        if (actor === null)
          return error(
            response,
            401,
            "AUTHENTICATION_REQUIRED",
            "Authentication is required.",
          );
        const params = paramsSchema.safeParse(request.params);
        const query = (
          kind === "forecast" ? pairQuerySchema : reorderQuerySchema
        ).safeParse(request.query);
        if (!params.success || !query.success)
          return error(
            response,
            400,
            "VALIDATION_ERROR",
            "The request is invalid.",
          );
        const pair = {
          actorUserId: actor.actor.id,
          organizationId: params.data.organizationId,
          branchId: query.data.branchId,
          productId: query.data.productId,
        };
        try {
          const outcome =
            kind === "forecast"
              ? await input.forecastService.read({
                  actorUserId: pair.actorUserId,
                  organizationId: pair.organizationId,
                  productId: pair.productId,
                  scope: { kind: "branch", branchId: pair.branchId },
                })
              : await input.reorderService.read({
                  ...pair,
                  ...("leadTimeDays" in query.data &&
                  typeof query.data.leadTimeDays === "number"
                    ? { leadTimeDays: query.data.leadTimeDays }
                    : {}),
                });
          if (outcome.kind === "forbidden")
            return sendAnalyticsFailure(response, "forbidden");
          if (outcome.kind === "invalid_reporting_timezone")
            return sendAnalyticsFailure(response, "invalid_reporting_timezone");
          if (outcome.kind === "not_found")
            return error(
              response,
              404,
              "NOT_FOUND",
              "The resource was not found.",
            );
          if (kind === "forecast") {
            if (!("forecasts" in outcome))
              throw new Error("Forecast outcome mismatch.");
            const forecast = outcome.forecasts[0];
            if (forecast === undefined || outcome.forecasts.length !== 1)
              throw new Error("Expected one Branch/Product forecast.");
            return response.status(200).json({
              data: { forecast },
              meta: { requestId: requestId(response) },
            });
          }
          if (!("recommendation" in outcome))
            throw new Error("Reorder outcome mismatch.");
          return response.status(200).json({
            data: { recommendation: outcome.recommendation },
            meta: { requestId: requestId(response) },
          });
        } catch (cause: unknown) {
          next(cause);
        }
      },
    );
  }
  return router;
}
