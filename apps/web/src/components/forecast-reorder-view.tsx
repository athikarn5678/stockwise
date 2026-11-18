"use client";
import type { TranslationKey } from "@/i18n/en";
import { useLanguage } from "@/providers/language-provider";
import { Label } from "@/components/ui/label";
import { OptionSelect } from "@/components/option-select";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxLoadMore,
} from "@/components/ui/combobox";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";

import {
  AnalyticsApiError,
  getAnalyticsForecast,
  getAnalyticsReorder,
} from "@/analytics-api-client";
import type { AccessibleOrganization } from "@/branch-api-client";
import { listProducts } from "@/catalog-api-client";

/**
 * The product list is server-searched, so the debounce happens here rather than
 * inside the combobox (a `filter={null}` root never filters on its own).
 */
const PRODUCT_SEARCH_DEBOUNCE_MS = 300;

// Base UI reports change reasons as kebab-case strings.
const USER_INPUT_REASONS = new Set(["input-change", "clear-press"]);

type ProductOption = { value: string; label: string };

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
  const allowed =
    organization.role === "OWNER" ||
    organization.role === "ADMIN" ||
    organization.role === "BRANCH_MANAGER";

  const [branchId, setBranchId] = useState(organization.branches[0]?.id ?? "");
  const [productId, setProductId] = useState("");
  // `queryText` is what the user typed; `search` is the debounced value that
  // becomes the product query key, so selecting an item (which rewrites the
  // input with the item label) never restarts the search.
  const [queryText, setQueryText] = useState("");
  const [search, setSearch] = useState("");
  const [leadTimeDays, setLeadTimeDays] = useState<7 | 30 | null>(null);
  const productInputId = useId();
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
    enabled: allowed && activeBranch !== undefined,
  });
  const options =
    products.data?.pages.flatMap((page) => page.data.products) ?? [];
  const items: ProductOption[] = options.map((product) => ({
    value: product.id,
    label: `${product.sku} — ${product.name}${
      product.status === "INACTIVE" ? t("uiInactiveSuffix") : ""
    }`,
  }));
  const selectedItem = items.find((item) => item.value === productId) ?? null;
  const chosenProduct = options.find((product) => product.id === productId);

  useEffect(() => {
    if (queryText === search) return undefined;
    const timeout = setTimeout(
      () => setSearch(queryText),
      PRODUCT_SEARCH_DEBOUNCE_MS,
    );
    return () => clearTimeout(timeout);
  }, [queryText, search]);
  const pair = {
    organizationId: organization.id,
    branchId: activeBranch?.id ?? "",
    productId,
  };
  const enabled =
    allowed && activeBranch !== undefined && chosenProduct !== undefined;
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

  if (!allowed) return <p role="alert">{t("accessDenied")}</p>;

  return (
    <section aria-label={t("uiForecastAndReorder")} className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold">{t("uiForecastAndReorder")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("uiOneBranchAndProductForecastDatesAndTrainingWindow")}
        </p>
      </div>
      <div className="grid grid-cols-1 items-start gap-4 rounded-lg border bg-card p-4 sm:grid-cols-3">
        <div className="min-w-0">
          <Label className="form-field flex-col items-stretch gap-1">
            {t("branch")}
            <OptionSelect
              className="w-full "
              onValueChange={(value) => {
                setBranchId(value);
                setProductId("");
              }}
              options={organization.branches.map((branch) => ({
                label: `${branch.code} — ${branch.name}`,
                value: branch.id,
              }))}
              value={activeBranch?.id ?? ""}
            />
          </Label>
        </div>
        <div className="min-w-0 space-y-2">
          <Label
            className="form-field flex-col items-stretch gap-1"
            htmlFor={productInputId}
          >
            {t("marketingProduct")}
            <Combobox<ProductOption>
              filter={null}
              inputValue={selectedItem?.label ?? queryText}
              itemToStringLabel={(item) => item.label}
              itemToStringValue={(item) => item.value}
              items={items}
              onInputValueChange={(value, details) => {
                // Base UI also reports its own input writes (item press, popup
                // close, value sync). Only a user edit or the clear button may
                // drop the selected product. An `input-clear` while a product
                // is selected is the user deleting the label itself (the only
                // path that skips `input-change` is IME composition).
                const dropSelection =
                  USER_INPUT_REASONS.has(details.reason) ||
                  (details.reason === "input-clear" && selectedItem !== null);
                if (!dropSelection) {
                  return;
                }
                // Seed the query with exactly what the input now shows, so the
                // first edit after a selection searches the edited text
                // instead of re-sending the pre-selection query.
                setQueryText(value);
                setProductId("");
              }}
              onValueChange={(item) => setProductId(item?.value ?? "")}
              value={selectedItem}
            >
              <ComboboxInput
                clearLabel={t("uiClearProductSearch")}
                id={productInputId}
                placeholder={t("uiSearchProductsPlaceholder")}
                showClear
                triggerLabel={t("uiShowProductOptions")}
              />
              <ComboboxContent>
                <ComboboxEmpty>
                  {/* A new server query empties the list while it loads; only a
                      settled empty result is a true "no matches" state. A
                      disabled query (no active Branch) stays pending forever,
                      so it gets its own hint instead of a loading label. */}
                  {activeBranch === undefined
                    ? t("uiChooseABranchToSearchProducts")
                    : products.isError
                      ? t("uiProductsCouldNotBeLoaded")
                      : products.isLoading
                        ? t("uiLoadingProducts")
                        : t("uiNoProductsMatchThisSearch")}
                </ComboboxEmpty>
                <ComboboxList>
                  {items.map((item) => (
                    <ComboboxItem
                      data-value={item.value}
                      key={item.value}
                      value={item}
                    >
                      {item.label}
                    </ComboboxItem>
                  ))}
                </ComboboxList>
                {products.hasNextPage ? (
                  <ComboboxLoadMore
                    loading={products.isFetchingNextPage}
                    onClick={() => void products.fetchNextPage()}
                    // Keep focus in the input so the click cannot dismiss the
                    // popup before the next page arrives.
                    onMouseDown={(event) => event.preventDefault()}
                  >
                    {t("uiLoadMoreProducts")}
                  </ComboboxLoadMore>
                ) : null}
              </ComboboxContent>
            </Combobox>
          </Label>
        </div>
        <div className="min-w-0">
          <Label className="form-field flex-col items-stretch gap-1">
            {t("uiPlanningLeadTime")}
            <OptionSelect
              className="w-full form-control--compact"
              onValueChange={(value) =>
                setLeadTimeDays(value === "7" ? 7 : value === "30" ? 30 : null)
              }
              options={[
                { label: t("uiChoose7Or30Days"), value: "" },
                { label: t("uiLeadTime7Days"), value: "7" },
                { label: t("uiLeadTime30Days"), value: "30" },
              ]}
              value={leadTimeDays === null ? "" : String(leadTimeDays)}
            />
          </Label>
        </div>
      </div>
      <div className="empty:hidden">
        {products.isLoading && activeBranch ? (
          <p aria-live="polite" className="text-sm">
            {t("uiLoadingProducts")}
          </p>
        ) : null}
        {products.isError ? (
          <p role="alert" className="text-sm form-message">
            {t("uiProductsCouldNotBeLoaded")}
          </p>
        ) : null}
      </div>
      <p className="text-sm text-muted-foreground">
        {t("uiForecastReorderHint")}
      </p>
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
    </section>
  );
}
