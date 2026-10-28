"use client";
import type { TranslationKey } from "@/i18n/en";
import { useLanguage } from "@/providers/language-provider";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useState } from "react";

import {
  AnalyticsApiError,
  getAnalyticsForecast,
  getAnalyticsReorder,
} from "@/analytics-api-client";
import type { AccessibleOrganization } from "@/branch-api-client";
import { listProducts } from "@/catalog-api-client";

function reasonLabels(
  t: (key: TranslationKey) => string,
): Record<string, string> {
  return {
    INACTIVE_PRODUCT: t("uiThisProductIsInactiveEstimatesAreUnavailable"),
    INSUFFICIENT_DATA: t("uiNoInventoryMovementForThisBranchProductIsRecorded"),
    LEAD_TIME_REQUIRED: t("uiChooseAPlanningLeadTimeToSeeAReorder"),
    UNSUPPORTED_LEAD_TIME: t("uiPlanningLeadTimeMustBeAWholeNumberFrom"),
    INVENTORY_INTEGRITY_ERROR: t(
      "uiInventoryBalanceOrLedgerIntegrityNeedsReviewBeforeRecommending",
    ),
    QUANTITY_OUT_OF_RANGE: t("uiTheCalculatedQuantityExceedsTheSupportedRange"),
  };
}

function requestError(
  error: unknown,
  t: (key: TranslationKey) => string,
): string {
  if (error instanceof AnalyticsApiError) {
    if (error.kind === "forbidden")
      return t("uiForecastAndReorderAreNotAvailableForYourCurrent");
    if (error.kind === "authentication_required")
      return t("uiSignInAgainToViewForecastAndReorder");
    if (error.kind === "configuration")
      return t("uiAnalyticsReportingTimeNeedsConfiguration");
    if (error.kind === "validation")
      return t("uiCheckTheSelectedBranchAndProduct");
  }
  return t("uiForecastAndReorderCouldNotBeLoadedTryAgain");
}

export function ForecastReorderView({
  organization,
}: {
  organization: AccessibleOrganization;
}) {
  const { t } = useLanguage();

  const [branchId, setBranchId] = useState(organization.branches[0]?.id ?? "");
  const [productId, setProductId] = useState("");
  const [search, setSearch] = useState("");
  const [leadTimeDays, setLeadTimeDays] = useState<number | null>(null);
  const activeBranch = organization.branches.find(
    (branch) => branch.id === branchId,
  );
  const scopeKey = [
    "forecast-reorder",
    organization.id,
    organization.role,
    organization.branches.map((branch) => branch.id).join(","),
    activeBranch?.id ?? null,
  ] as const;
  const products = useInfiniteQuery({
    queryKey: [...scopeKey, "products", search],
    queryFn: ({ pageParam }) =>
      listProducts(
        {
          organizationId: organization.id,
          ...(activeBranch ? { branchId: activeBranch.id } : {}),
        },
        {
          includeInactive: true,
          q: search,
          limit: 100,
          ...(pageParam === undefined ? {} : { cursor: pageParam }),
        },
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.meta.nextCursor ?? undefined,
    enabled: activeBranch !== undefined,
  });
  const options =
    products.data?.pages.flatMap((page) => page.data.products) ?? [];
  const chosenProduct = options.find((product) => product.id === productId);
  const pair = {
    organizationId: organization.id,
    branchId: activeBranch?.id ?? "",
    productId,
  };
  const enabled = activeBranch !== undefined && chosenProduct !== undefined;
  const forecast = useQuery({
    queryKey: [...scopeKey, productId, "forecast"],
    queryFn: ({ signal }) => getAnalyticsForecast(pair, signal),
    enabled,
  });
  const reorder = useQuery({
    queryKey: [...scopeKey, productId, leadTimeDays, "reorder"],
    queryFn: ({ signal }) =>
      getAnalyticsReorder({ ...pair, leadTimeDays }, signal),
    enabled,
  });
  const forecastResult = forecast.data?.data.forecast;
  const reorderResult = reorder.data?.data.recommendation;

  return (
    <section aria-label={t("uiForecastAndReorder")} className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold">{t("uiForecastAndReorder")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("uiOneBranchAndProductForecastDatesAndTrainingWindow")}
        </p>
      </div>
      <div className="grid gap-4 rounded-lg border bg-card p-4 sm:grid-cols-3">
        <Label className="form-field">
          {t("branch")}
          <NativeSelect
            value={activeBranch?.id ?? ""}
            onChange={(event) => {
              setBranchId(event.target.value);
              setProductId("");
            }}
            className="w-full "
          >
            {organization.branches.map((branch) => (
              <NativeSelectOption key={branch.id} value={branch.id}>
                {branch.code} — {branch.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Label>
        <div className="space-y-2">
          <Label className="form-field">
            {t("uiFindProduct")}
            <Input
              type="search"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setProductId("");
              }}
              className=""
            />
          </Label>
          <Label className="form-field">
            {t("marketingProduct")}
            <NativeSelect
              value={chosenProduct?.id ?? ""}
              onChange={(event) => setProductId(event.target.value)}
              className="w-full "
            >
              <NativeSelectOption value="">
                {t("uiChooseAProduct2")}
              </NativeSelectOption>
              {options.map((product) => (
                <NativeSelectOption key={product.id} value={product.id}>
                  {product.sku} — {product.name}
                  {product.status === "INACTIVE" ? t("uiInactiveSuffix") : ""}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Label>
          {products.isPending && activeBranch ? (
            <p aria-live="polite" className="text-sm">
              {t("uiLoadingProducts")}
            </p>
          ) : null}
          {products.isError ? (
            <p role="alert" className="text-sm form-message">
              {t("uiProductsCouldNotBeLoaded")}
            </p>
          ) : null}
          {products.isSuccess && options.length === 0 ? (
            <p className="text-sm">{t("uiNoProductsMatchThisSearch")}</p>
          ) : null}
          {products.hasNextPage ? (
            <Button
              variant="outline"
              type="button"
              onClick={() => void products.fetchNextPage()}
              disabled={products.isFetchingNextPage}
              className=""
            >
              {products.isFetchingNextPage
                ? t("commonLoading")
                : t("uiLoadMoreProducts")}
            </Button>
          ) : null}
        </div>
        <Label className="form-field">
          {t("uiPlanningLeadTime")}
          <NativeSelect
            value={leadTimeDays ?? ""}
            onChange={(event) =>
              setLeadTimeDays(
                event.target.value === "" ? null : Number(event.target.value),
              )
            }
            className="w-full form-control--compact"
          >
            <NativeSelectOption value="">
              {t("uiChoose17Days")}
            </NativeSelectOption>
            {[1, 2, 3, 4, 5, 6, 7].map((days) => (
              <NativeSelectOption key={days} value={days}>
                {days} {days === 1 ? "day" : "days"}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Label>
      </div>
      {!activeBranch ? (
        <p className="form-message" role="alert">
          {t("uiNoAccessibleActiveBranchIsAvailable")}
        </p>
      ) : !chosenProduct ? (
        <p>{t("uiChooseAProductToSeeItsForecastAndReorder")}</p>
      ) : (
        <>
          <section
            aria-label={t("uiForecastResult")}
            className="space-y-3 rounded-lg border bg-card p-4"
          >
            <h3 className="font-semibold">{t("uiSevenDayForecast")}</h3>
            {forecast.isPending ? (
              <p aria-live="polite">{t("uiLoadingForecast")}</p>
            ) : forecast.isError ? (
              <p className="form-message" role="alert">
                {requestError(forecast.error, t)}
              </p>
            ) : forecastResult ? (
              <>
                <p className="text-sm">
                  {t("uiVersion")} {forecastResult.forecastVersion}{" "}
                  {t("uiStatus2")}{" "}
                  {t(
                    forecastResult.status === "AVAILABLE"
                      ? "forecastAvailable"
                      : "forecastUnavailable",
                  )}
                </p>
                <p className="text-sm">
                  {t("uiReportingTimezone")} {forecastResult.reportingTimezone}{" "}
                  {t("uiDataAsOfSeparator")} {forecastResult.sourceCutoff}
                </p>
                <p className="text-sm">
                  {t("uiTraining")} {forecastResult.trainingStartInclusive}{" "}
                  {t("uiTo")} {forecastResult.trainingEndExclusive}{" "}
                  {t("uiHorizon")} {forecastResult.horizonStartInclusive}{" "}
                  {t("uiTo")} {forecastResult.horizonEndExclusive}
                </p>
                {forecastResult.status === "UNAVAILABLE" ? (
                  <p role="status">
                    {reasonLabels(t)[forecastResult.reason ?? ""]}
                  </p>
                ) : (
                  <>
                    <p className="text-2xl font-semibold tabular-nums">
                      {forecastResult.horizonTotal} {forecastResult.unit}{" "}
                      {t("uiTotal")}
                    </p>
                    <div className="overflow-x-auto">
                      <Table className="w-full text-left text-sm">
                        <caption className="py-2 text-left font-medium">
                          {t("uiDailyForecastIn")} {forecastResult.unit}
                        </caption>
                        <TableHeader>
                          <TableRow>
                            <TableHead scope="col" className="py-2">
                              {t("uiLocalDate")}
                            </TableHead>
                            <TableHead scope="col">{t("uiQuantity")}</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {forecastResult.days.map((day) => (
                            <TableRow key={day.localDate} className="border-t">
                              <TableHead
                                scope="row"
                                className="py-2 font-normal"
                              >
                                {day.localDate}
                              </TableHead>
                              <TableCell className="tabular-nums">
                                {day.quantity} {forecastResult.unit}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </>
                )}
              </>
            ) : null}
          </section>
          <section
            aria-label={t("uiReorderResult")}
            className="space-y-3 rounded-lg border bg-card p-4"
          >
            <h3 className="font-semibold">
              {t("uiAdvisoryReorderRecommendation")}
            </h3>
            {reorder.isPending ? (
              <p aria-live="polite">{t("uiLoadingReorderRecommendation")}</p>
            ) : reorder.isError ? (
              <p className="form-message" role="alert">
                {requestError(reorder.error, t)}
              </p>
            ) : reorderResult ? (
              <>
                <p className="text-sm">
                  {t("uiVersion")} {reorderResult.reorderVersion}{" "}
                  {t("uiForecast")} {reorderResult.forecastVersion}{" "}
                  {t("uiStatus2")}{" "}
                  {t(
                    reorderResult.status === "AVAILABLE"
                      ? "forecastAvailable"
                      : "forecastUnavailable",
                  )}
                </p>
                <p className="text-sm">
                  {t("uiDataAsOf")} {reorderResult.sourceCutoff}
                </p>
                {reorderResult.status === "UNAVAILABLE" ? (
                  <p role="status">
                    {reasonLabels(t)[reorderResult.reason ?? ""]}
                  </p>
                ) : (
                  <>
                    <p className="text-2xl font-semibold tabular-nums">
                      {t("uiRecommend")} {reorderResult.recommendedQuantity}{" "}
                      {reorderResult.unit}
                    </p>
                    <dl className="grid gap-2 text-sm sm:grid-cols-2">
                      <div>
                        <dt>{t("uiPlanningLeadTime")}</dt>
                        <dd>
                          {reorderResult.leadTimeDays} {t("uiDays")}
                        </dd>
                      </div>
                      <div>
                        <dt>{t("uiForecastDemand")}</dt>
                        <dd>
                          {reorderResult.leadTimeDemand} {reorderResult.unit}
                        </dd>
                      </div>
                      <div>
                        <dt>{t("uiOnHand")}</dt>
                        <dd>
                          {reorderResult.onHand} {reorderResult.unit}
                        </dd>
                      </div>
                      <div>
                        <dt>{t("uiNeedBeforeUnitRounding")}</dt>
                        <dd>
                          {reorderResult.rawNeed} {reorderResult.unit}
                        </dd>
                      </div>
                    </dl>
                  </>
                )}
              </>
            ) : null}
          </section>
        </>
      )}
      <section
        className="space-y-2 rounded-lg border bg-muted/40 p-4 text-sm"
        aria-label={t("uiForecastAndReorderLimitations")}
      >
        <h3 className="font-semibold">{t("uiHowToInterpretTheseEstimates")}</h3>
        <p>{t("uiForecastUsesASimpleMeanOfObservedCompletedSale")}</p>
        <p>{t("uiReorderUsesYourSelectedLeadTimeOfAtMost")}</p>
      </section>
    </section>
  );
}
