"use client";
import type { TranslationKey } from "@/i18n/en";
import { useLanguage } from "@/providers/language-provider";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";

import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";

import {
  AnalyticsApiError,
  getAnalyticsInventory,
  type AnalyticsInventoryResponse,
  type AnalyticsRequest,
} from "@/analytics-api-client";

import { formatMoney } from "@/money-display";

const CLASSIFICATION_LABELS: Record<
  "LOW_STOCK" | "NORMAL" | "OVERSTOCK",
  TranslationKey
> = {
  LOW_STOCK: "classificationLow",
  NORMAL: "classificationNormal",
  OVERSTOCK: "classificationOver",
};

function reasonLabels(
  t: (key: TranslationKey) => string,
): Record<string, string> {
  return {
    INCOMPLETE_PERIOD: t("uiTheSelectedPeriodIsNotComplete"),
    INSUFFICIENT_DATA: t("uiFewerThan28CompleteDaysOfInventoryHistory"),
    NO_RECENT_DEMAND: t("uiNoSalesDepletionInTheRecent28CompleteDays"),
    NO_STOCK_AND_NO_DEMAND: t("uiNoStockAndNoRecentSalesDepletion"),
    INVENTORY_INTEGRITY_ERROR: t("uiInventoryBalanceOrCostStateNeedsReview"),
    INACTIVE_PRODUCT: t("uiProductIsInactive"),
    INCOMPLETE_COST_COVERAGE: t("uiSomeStockedProductsHaveUnknownCost"),
  };
}

function metric(
  metric: { value: string | null; reason: string | null },
  unit = "",
  t: (key: TranslationKey) => string,
) {
  return metric.value === null
    ? (reasonLabels(t)[metric.reason ?? ""] ?? t("posUnavailable"))
    : `${metric.value}${unit}`;
}

function costDetail(
  cost: NonNullable<
    AnalyticsInventoryResponse["data"]["branches"][number]["cost"]
  >,
  t: (key: TranslationKey) => string,
) {
  return (
    <dl className="grid gap-2 text-sm sm:grid-cols-2">
      <div>
        <dt>{t("uiCurrentInventoryValue")}</dt>
        <dd>
          {cost.inventoryValue.value === null
            ? metric(cost.inventoryValue, undefined, t)
            : `${formatMoney(cost.inventoryValue.value)} THB`}
        </dd>
      </div>
      <div>
        <dt>{t("uiKnownInventoryValue")}</dt>
        <dd>{formatMoney(cost.knownInventoryValue)} THB</dd>
      </div>
      <div>
        <dt>{t("uiProductsWithKnownCost")}</dt>
        <dd>{cost.knownCostProductCount}</dd>
      </div>
      <div>
        <dt>{t("uiProductsWithUnknownCost")}</dt>
        <dd>{cost.unknownCostProductCount}</dd>
      </div>
      <div>
        <dt>{t("uiUnknownCostQuantityByUnit")}</dt>
        <dd>
          {Object.entries(cost.unknownQuantityByUnit)
            .map(([unit, quantity]) => `${quantity} ${unit}`)
            .join(", ") || t("uiNone")}
        </dd>
      </div>
    </dl>
  );
}

function errorText(error: unknown, t: (key: TranslationKey) => string) {
  if (error instanceof AnalyticsApiError) {
    if (error.kind === "invalid_cursor")
      return t("uiTheInventoryPageCanNoLongerBeContinuedRestart");
    if (error.kind === "forbidden")
      return t("uiInventoryAnalyticsIsNotAvailableForYourCurrentAccess");
    if (error.kind === "validation")
      return t("uiCheckThePeriodAndScopeThenTryAgain");
    if (error.kind === "authentication_required")
      return t("uiSignInAgainToViewInventoryAnalytics");
    if (error.kind === "configuration")
      return t("uiAnalyticsReportingTimeNeedsConfiguration");
  }
  return t("uiInventoryAnalyticsCouldNotBeLoadedTryAgain");
}

export function InventoryAnalyticsView({
  request,
  enabled,
  role,
}: {
  request: AnalyticsRequest;
  enabled: boolean;
  role: string;
}) {
  const { t } = useLanguage();

  const [reset, setReset] = useState(0);
  const query = useInfiniteQuery({
    queryKey: [
      "analytics",
      request.organizationId,
      role,
      request.scope,
      request.scope === "branch" ? request.branchId : null,
      request.from,
      request.to,
      request.granularity,
      "inventory",
      reset,
    ],
    queryFn: ({ signal, pageParam }) =>
      getAnalyticsInventory(request, signal, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.meta.nextCursor ?? undefined,
    enabled,
  });
  if (!enabled)
    return (
      <p role="alert">{t("uiChooseAnAccessibleBranchAndAValidDateRange")}</p>
    );
  if (query.isPending)
    return <p aria-live="polite">{t("uiLoadingInventoryAnalytics")}</p>;
  if (query.isError)
    return (
      <div role="alert">
        <p>{errorText(query.error, t)}</p>
        {query.error instanceof AnalyticsApiError &&
        query.error.kind === "invalid_cursor" ? (
          <Button
            variant="outline"
            type="button"
            className="underline"
            onClick={() => setReset((value) => value + 1)}
          >
            {t("uiRestartInventoryList")}
          </Button>
        ) : null}
      </div>
    );

  const pages = query.data.pages;
  const latest = pages.at(-1)!;
  const dimensions = pages.flatMap((page) => page.data.dimensions);
  const noMovements =
    dimensions.length > 0 &&
    dimensions.every((row) =>
      row.buckets.every((bucket) =>
        [
          bucket.purchaseReceivedQuantity,
          bucket.saleDepletionQuantity,
          bucket.refundReturnQuantity,
          bucket.positiveAdjustmentQuantity,
          bucket.negativeAdjustmentQuantity,
        ].every((value) => /^0(?:\.0+)?$/.test(value)),
      ),
    );
  return (
    <section aria-label={t("uiInventoryAnalytics")} className="space-y-5">
      <h2 className="text-xl font-semibold">{t("inventoryTitle")}</h2>
      <p className="text-sm text-muted-foreground">
        {t("uiReportingTimezone")} {latest.meta.reportingTimezone} ·{" "}
        {t(
          latest.meta.dataStatus === "complete"
            ? "coverageComplete"
            : "coveragePartial",
        )}{" "}
        · {latest.meta.includedBranchCount} {t("uiBranches")}
        <br />
        {t("uiMovementFactsThrough")} {latest.meta.sourceCutoff}
        {t("uiCurrentStockIsCapturedSeparatelyForEachPage")}
      </p>
      <section
        aria-label={t("uiCurrentBranchAvailability")}
        className="space-y-3"
      >
        <h3 className="text-lg font-semibold">
          {t("uiCurrentBranchAvailability")}
        </h3>
        <p className="text-xs text-muted-foreground">
          {t("uiCurrentSnapshotCaptured")}{" "}
          {latest.meta.currentSnapshotCapturedAt}
        </p>
        {latest.data.branches.length === 0 ? (
          <p>{t("uiNoBranchesInThisScope")}</p>
        ) : (
          latest.data.branches.map((branch) => (
            <div
              key={branch.branchId}
              className="rounded-lg border bg-card p-4"
            >
              <h4 className="font-medium">
                {branch.branchName}
                {branch.branchStatus === "INACTIVE"
                  ? t("uiInactiveSuffix")
                  : ""}
              </h4>
              <dl className="mt-2 grid gap-2 text-sm sm:grid-cols-3">
                <div>
                  <dt>{t("inventoryActiveProducts")}</dt>
                  <dd>{branch.activeProductCount}</dd>
                </div>
                <div>
                  <dt>{t("uiInStock")}</dt>
                  <dd>{branch.inStockProductCount}</dd>
                </div>
                <div>
                  <dt>{t("uiOutOfStock")}</dt>
                  <dd>{branch.outOfStockProductCount}</dd>
                </div>
              </dl>
              {branch.cost ? (
                <div className="mt-3 border-t pt-3">
                  {costDetail(branch.cost, t)}
                </div>
              ) : (
                <p className="mt-3 text-sm text-muted-foreground">
                  {t("uiCostAndValueRequireAdditionalAccess")}
                </p>
              )}
            </div>
          ))
        )}
      </section>
      <section
        aria-label={t("uiProductMovementAndCoverage")}
        className="space-y-3"
      >
        <h3 className="text-lg font-semibold">
          {t("uiProductMovementAndCoverage")}
        </h3>
        {dimensions.length === 0 ? (
          <p>{t("uiNoProductDimensionsInThisScope")}</p>
        ) : null}
        {noMovements && !query.hasNextPage ? (
          <p>{t("uiNoMovementsInTheSelectedPeriodCurrentStockIs")}</p>
        ) : null}
        {pages.map((page, pageIndex) => (
          <div key={pageIndex} className="space-y-3">
            {page.data.dimensions.map((row) => (
              <details
                key={`${row.branchId}/${row.productId}`}
                className="rounded-lg border bg-card p-4"
              >
                <summary className="cursor-pointer font-medium">
                  {row.productName} · {row.branchName} · {row.onHandQuantity}{" "}
                  {row.productUnit} {t("uiOnHand2")}
                  {row.productStatus === "INACTIVE"
                    ? t("uiInactiveProductSuffix")
                    : ""}
                  {" · "}
                  {(row.stockClassification.classification
                    ? t(
                        CLASSIFICATION_LABELS[
                          row.stockClassification.classification
                        ],
                      )
                    : null) ?? t("uiClassificationUnavailable")}
                </summary>
                <div className="mt-3 space-y-3 text-sm">
                  <p className="text-xs text-muted-foreground">
                    {t("uiCurrentSnapshotCaptured")}{" "}
                    {page.meta.currentSnapshotCapturedAt}
                  </p>
                  <dl className="grid gap-2 sm:grid-cols-2">
                    <div>
                      <dt>{t("uiRequestedPeriodAverageDailySales")}</dt>
                      <dd>
                        {metric(
                          row.requestedPeriodAds,
                          ` ${row.productUnit}/` + t("uiPerDay"),
                          t,
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt>{t("ui28DaySalesVelocity")}</dt>
                      <dd>
                        {metric(
                          row.coverageSalesVelocity,
                          ` ${row.productUnit}/` + t("uiPerDay"),
                          t,
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt>{t("uiCurrentCoverage")}</dt>
                      <dd>{metric(row.coverageDays, t("uiDaysSuffix"), t)}</dd>
                    </div>
                    <div>
                      <dt>
                        {t("uiStockClassification")}
                        {row.stockClassification.thresholdVersion})
                      </dt>
                      <dd>
                        {(row.stockClassification.classification
                          ? t(
                              CLASSIFICATION_LABELS[
                                row.stockClassification.classification
                              ],
                            )
                          : null) ??
                          reasonLabels(t)[
                            row.stockClassification.reason ?? ""
                          ] ??
                          t("posUnavailable")}
                      </dd>
                    </div>
                  </dl>
                  {row.cost ? (
                    <section
                      aria-label={t("uiProductInventoryValue")}
                      className="border-t pt-3"
                    >
                      {costDetail(row.cost, t)}
                    </section>
                  ) : null}
                  <div className="overflow-x-auto">
                    <Table className="w-full min-w-[700px] text-left text-sm">
                      <caption className="py-2 text-left font-medium">
                        {t("uiMovementByPeriodFor")} {row.productName} (
                        {row.productUnit})
                      </caption>
                      <TableHeader>
                        <TableRow className="border-b">
                          <TableHead scope="col">{t("uiPeriod")}</TableHead>
                          <TableHead scope="col">{t("uiReceived")}</TableHead>
                          <TableHead scope="col">
                            {t("uiSalesDepletion")}
                          </TableHead>
                          <TableHead scope="col">
                            {t("uiRefundReturns")}
                          </TableHead>
                          <TableHead scope="col">
                            {t("uiPositiveAdjustments")}
                          </TableHead>
                          <TableHead scope="col">
                            {t("uiNegativeAdjustments")}
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {row.buckets.map((bucket) => (
                          <TableRow
                            key={bucket.localStartInclusive}
                            className="border-b last:border-0"
                          >
                            <TableHead scope="row" className="py-2">
                              {bucket.label}
                            </TableHead>
                            <TableCell>
                              {bucket.purchaseReceivedQuantity}
                            </TableCell>
                            <TableCell>
                              {bucket.saleDepletionQuantity}
                            </TableCell>
                            <TableCell>{bucket.refundReturnQuantity}</TableCell>
                            <TableCell>
                              {bucket.positiveAdjustmentQuantity}
                            </TableCell>
                            <TableCell>
                              {bucket.negativeAdjustmentQuantity}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              </details>
            ))}
          </div>
        ))}
        {query.hasNextPage ? (
          <Button
            variant="outline"
            type="button"
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
            className="bg-card"
          >
            {query.isFetchingNextPage
              ? t("uiLoadingNextPage")
              : t("uiLoadMoreInventory")}
          </Button>
        ) : null}
      </section>
    </section>
  );
}
