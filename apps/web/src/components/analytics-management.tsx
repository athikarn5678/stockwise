"use client";
import type { TranslationKey } from "@/i18n/en";
import { useLanguage } from "@/providers/language-provider";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { Label } from "@/components/ui/label";
import { DateInput } from "@/components/ui/date-input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Button } from "@/components/ui/button";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  AnalyticsApiError,
  type AnalyticsCategoryBucket,
  type AnalyticsPeriod,
  type AnalyticsRequest,
  type AnalyticsSalesBucket,
  getAnalyticsBranches,
  getAnalyticsCategories,
  getAnalyticsSales,
} from "@/analytics-api-client";
import { formatThb } from "@/money-display";
import { resolveApplicationContext } from "@/application-context";
import { AiInsightView } from "@/components/ai-insight-view";
import { InventoryAnalyticsView } from "@/components/inventory-analytics-view";
import { ForecastReorderView } from "@/components/forecast-reorder-view";
import {
  fetchAccessContext,
  type AccessibleOrganization,
} from "@/branch-api-client";

type View =
  | "sales"
  | "categories"
  | "branches"
  | "inventory"
  | "forecast-reorder"
  | "insights";

function initialPeriod(): AnalyticsPeriod {
  const today = new Date();
  const from = new Date(today);
  from.setUTCDate(from.getUTCDate() - 6);
  const to = new Date(today);
  to.setUTCDate(to.getUTCDate() + 1);
  return {
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
    granularity: "day",
  };
}

function money(value: string): string {
  return formatThb(value, true);
}

function reasonText(
  reason: string | null,
  t: (key: TranslationKey) => string,
): string {
  const messages: Record<string, string> = {
    INCOMPLETE_COST_COVERAGE: t("uiCostCoverageIsIncomplete"),
    NO_BASELINE: t("uiNoComparisonBaseline"),
    NON_COMPARABLE_PERIOD: t("uiPeriodCannotBeCompared"),
    NON_POSITIVE_NET_SALES: t("uiNetSalesIsNotPositive"),
    NO_REGISTERED_REFUNDS: t("uiNoRegisteredRefunds"),
    NO_REGISTERED_SALES: t("uiNoRegisteredSales"),
    NO_SALES: t("uiNoSales"),
  };
  return reason === null
    ? t("posUnavailable")
    : (messages[reason] ?? t("posUnavailable"));
}

function nullable(
  value: { value: string | null; reason: string | null },
  format: "money" | "percent",
  t: (key: TranslationKey) => string,
) {
  return value.value === null
    ? reasonText(value.reason, t)
    : format === "money"
      ? money(value.value)
      : `${value.value}%`;
}

function errorMessage(
  error: unknown,
  t: (key: TranslationKey) => string,
): string {
  if (!(error instanceof AnalyticsApiError))
    return t("uiAnalyticsCouldNotBeLoadedTryAgain");
  switch (error.kind) {
    case "authentication_required":
      return t("uiSignInAgainToViewAnalytics");
    case "forbidden":
      return t("uiAnalyticsIsNotAvailableForYourCurrentAccess");
    case "invalid_cursor":
      return t("uiThisPageCanNoLongerBeContinuedRestartThis");
    case "validation":
      return t("uiCheckThePeriodAndScopeThenTryAgainWeek");
    case "configuration":
      return t(
        "uiAnalyticsReportingTimeNeedsConfigurationAskAnAdministratorTo",
      );
    default:
      return t("uiAnalyticsCouldNotBeLoadedTryAgain");
  }
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-2 break-words text-xl font-semibold tabular-nums">
        {value}
      </dd>
    </div>
  );
}

function DetailMetric({
  label,
  value,
}: {
  label: string;
  value: string | number;
}) {
  return (
    <div className="flex flex-wrap justify-between gap-x-4 border-b py-2 last:border-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  );
}

function SalesMetrics({ bucket }: { bucket: AnalyticsSalesBucket }) {
  const { t } = useLanguage();

  return (
    <>
      <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric
          label={t("marketingNetSales")}
          value={money(bucket.netSalesAmount)}
        />
        <Metric
          label={t("uiGrossSales")}
          value={money(bucket.grossSalesAmount)}
        />
        <Metric
          label={t("uiRefundAmount")}
          value={money(bucket.refundAmount)}
        />
        <Metric label={t("marketingSales")} value={bucket.saleCount} />
      </dl>
      <dl className="grid gap-x-8 rounded-lg border bg-card px-4 py-2 text-sm sm:grid-cols-2">
        <DetailMetric
          label={t("receiptDiscount")}
          value={money(bucket.discountAmount)}
        />
        <DetailMetric
          label={t("uiSalesAfterDiscount")}
          value={money(bucket.salesAfterDiscountAmount)}
        />
        <DetailMetric label={t("uiRefunds")} value={bucket.refundCount} />
        <DetailMetric
          label={t("uiRefundedSales")}
          value={bucket.refundedSaleCount}
        />
        <DetailMetric
          label={t("uiAverageOrderValue")}
          value={nullable(bucket.averageOrderValue, "money", t)}
        />
        <DetailMetric
          label={t("uiNetSalesGrowth")}
          value={nullable(bucket.netSalesGrowthPercent, "percent", t)}
        />
        <DetailMetric
          label={t("uiOutputVAT")}
          value={money(bucket.outputVatAmount)}
        />
        <DetailMetric
          label={t("uiNetOutputVAT")}
          value={money(bucket.netOutputVatAmount)}
        />
      </dl>
      <details className="rounded-lg border bg-card p-4 text-sm">
        <summary className="cursor-pointer font-medium">
          {t("uiTaxAndRefundDetail")}
        </summary>
        <dl className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <dt>{t("uiRegisteredTaxableSales")}</dt>
            <dd className="font-medium">
              {nullable(bucket.registeredTaxableSalesAmount, "money", t)}
            </dd>
          </div>
          <div>
            <dt>{t("uiRefundedRegisteredTaxableSales")}</dt>
            <dd className="font-medium">
              {nullable(bucket.refundedRegisteredTaxableAmount, "money", t)}
            </dd>
          </div>
          <div>
            <dt>{t("uiRefundedDiscount")}</dt>
            <dd className="font-medium">
              {money(bucket.refundedDiscountAmount)}
            </dd>
          </div>
          <div>
            <dt>{t("uiRefundedOutputVAT")}</dt>
            <dd className="font-medium">
              {money(bucket.refundedOutputVatAmount)}
            </dd>
          </div>
        </dl>
      </details>
      {bucket.cost ? (
        <section aria-label={t("uiCostAndProfit")} className="space-y-3">
          <div>
            <h3 className="font-semibold">{t("uiCostAndProfit")}</h3>
            <p className="text-sm text-muted-foreground">
              {t("uiCostCoverage")}{" "}
              {t(
                bucket.cost.costCoverage === "complete"
                  ? "coverageComplete"
                  : bucket.cost.costCoverage === "partial"
                    ? "coveragePartial"
                    : "coverageNone",
              )}
            </p>
          </div>
          <dl className="grid gap-3 sm:grid-cols-3">
            <Metric
              label={t("uiNetCOGS")}
              value={nullable(bucket.cost.netCogsAmount, "money", t)}
            />
            <Metric
              label={t("uiGrossProfit")}
              value={nullable(bucket.cost.grossProfitAmount, "money", t)}
            />
            <Metric
              label={t("uiGrossMargin")}
              value={nullable(bucket.cost.grossMarginPercent, "percent", t)}
            />
          </dl>
          <details className="rounded-lg border bg-card p-4 text-sm">
            <summary className="cursor-pointer font-medium">
              {t("uiCostDetail")}
            </summary>
            <dl className="mt-3 grid gap-x-8 sm:grid-cols-2">
              <DetailMetric
                label={t("uiSaleCOGS")}
                value={money(bucket.cost.saleCogsAmount)}
              />
              <DetailMetric
                label={t("uiRefundCOGSReversal")}
                value={money(bucket.cost.refundCogsReversalAmount)}
              />
              <DetailMetric
                label={t("uiKnownNetCOGS")}
                value={money(bucket.cost.knownNetCogsAmount)}
              />
              <DetailMetric
                label={t("uiKnownCostLines")}
                value={bucket.cost.knownCostLineCount}
              />
              <DetailMetric
                label={t("uiUnknownCostLines")}
                value={bucket.cost.unknownCostLineCount}
              />
            </dl>
          </details>
        </section>
      ) : null}
    </>
  );
}

function NetSalesChart({
  buckets,
}: {
  buckets: readonly AnalyticsSalesBucket[];
}) {
  const { t } = useLanguage();

  const chartData = buckets.map((bucket) => ({
    label: bucket.label,
    netSales: Number(bucket.netSalesAmount),
    exact: bucket.netSalesAmount,
  }));
  return (
    <div className="rounded-lg border bg-card p-4">
      <h2 className="font-semibold">{t("uiNetSalesTrend")}</h2>
      <p className="mb-4 text-sm text-muted-foreground">
        {t("uiTHBByReportingPeriodExactValuesAreInThe")}
      </p>
      <div
        aria-label={t("uiNetSalesTrendChart")}
        role="img"
        className="h-64 w-full min-w-0"
      >
        <ResponsiveContainer
          width="100%"
          height="100%"
          initialDimension={{ width: 1, height: 256 }}
          minWidth={1}
          minHeight={1}
        >
          <LineChart
            data={chartData}
            accessibilityLayer
            margin={{ top: 8, right: 12, bottom: 8, left: 8 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis
              dataKey="label"
              minTickGap={24}
              stroke="var(--muted-foreground)"
            />
            <YAxis width={70} stroke="var(--muted-foreground)" />
            <Tooltip
              contentStyle={{
                background: "var(--popover)",
                color: "var(--popover-foreground)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius)",
              }}
              itemStyle={{ color: "var(--popover-foreground)" }}
              formatter={(_value, _name, item) =>
                money(String(item.payload.exact))
              }
            />
            <Line
              type="linear"
              dataKey="netSales"
              name={t("marketingNetSales")}
              stroke="var(--foreground)"
              strokeWidth={2}
              dot={chartData.length <= 15}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function SalesSeriesTable({
  buckets,
}: {
  buckets: readonly AnalyticsSalesBucket[];
}) {
  const { t } = useLanguage();

  return (
    <div className="overflow-x-auto rounded-lg border bg-card">
      <Table className="w-full min-w-[700px] text-left text-sm">
        <caption className="px-4 py-3 text-left font-semibold">
          {t("uiSalesByPeriod")}
        </caption>
        <TableHeader className="border-y bg-muted text-muted-foreground">
          <TableRow>
            <TableHead className="px-4 py-2">{t("uiPeriod")}</TableHead>
            <TableHead className="px-4 py-2">
              {t("marketingNetSales")}
            </TableHead>
            <TableHead className="px-4 py-2">{t("uiGrossSales")}</TableHead>
            <TableHead className="px-4 py-2">{t("uiRefunds")}</TableHead>
            <TableHead className="px-4 py-2">{t("marketingSales")}</TableHead>
            <TableHead className="px-4 py-2">{t("commonStatus")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {buckets.map((bucket) => (
            <TableRow
              className="border-b last:border-0"
              key={bucket.localStartInclusive}
            >
              <TableHead className="px-4 py-2 font-medium">
                {bucket.label}
              </TableHead>
              <TableCell className="px-4 py-2 tabular-nums">
                {money(bucket.netSalesAmount)}
              </TableCell>
              <TableCell className="px-4 py-2 tabular-nums">
                {money(bucket.grossSalesAmount)}
              </TableCell>
              <TableCell className="px-4 py-2 tabular-nums">
                {bucket.refundCount}
              </TableCell>
              <TableCell className="px-4 py-2 tabular-nums">
                {bucket.saleCount}
              </TableCell>
              <TableCell className="px-4 py-2">
                {t(
                  bucket.dataStatus === "complete"
                    ? "coverageComplete"
                    : "coveragePartial",
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function CategorySeriesTable({
  buckets,
}: {
  buckets: readonly AnalyticsCategoryBucket[];
}) {
  const { t } = useLanguage();

  return (
    <div className="overflow-x-auto">
      <Table className="mt-3 w-full min-w-[650px] text-left text-sm">
        <TableHeader className="border-y bg-muted">
          <TableRow>
            <TableHead className="px-3 py-2">{t("uiPeriod")}</TableHead>
            <TableHead className="px-3 py-2">{t("uiGrossSales")}</TableHead>
            <TableHead className="px-3 py-2">{t("receiptDiscount")}</TableHead>
            <TableHead className="px-3 py-2">
              {t("uiSalesAfterDiscount")}
            </TableHead>
            <TableHead className="px-3 py-2">{t("uiRefund")}</TableHead>
            <TableHead className="px-3 py-2">
              {t("marketingNetSales")}
            </TableHead>
            <TableHead className="px-3 py-2">{t("uiShare")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {buckets.map((bucket) => (
            <TableRow
              key={bucket.localStartInclusive}
              className="border-b last:border-0"
            >
              <TableHead className="px-3 py-2">{bucket.label}</TableHead>
              <TableCell className="px-3 py-2">
                {money(bucket.grossSalesAmount)}
              </TableCell>
              <TableCell className="px-3 py-2">
                {money(bucket.discountAmount)}
              </TableCell>
              <TableCell className="px-3 py-2">
                {money(bucket.salesAfterDiscountAmount)}
              </TableCell>
              <TableCell className="px-3 py-2">
                {money(bucket.refundAmount)}
              </TableCell>
              <TableCell className="px-3 py-2">
                {money(bucket.netSalesAmount)}
              </TableCell>
              <TableCell className="px-3 py-2">
                {nullable(bucket.categorySharePercent, "percent", t)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function PageFrame({ children }: { children: React.ReactNode }) {
  const { t } = useLanguage();

  return (
    <section className="mx-auto w-full max-w-6xl space-y-6 px-4 py-8 sm:px-6">
      <div>
        <p className="text-sm font-medium text-muted-foreground">
          {t("uiStockWiseReporting")}
        </p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">
          {t("marketingAnalytics")}
        </h1>
      </div>
      {children}
    </section>
  );
}

export function AnalyticsManagement() {
  const { t } = useLanguage();

  const searchParams = useSearchParams();
  const contextQuery = useQuery({
    queryKey: ["access-context"],
    queryFn: fetchAccessContext,
  });
  const resolved = contextQuery.data
    ? resolveApplicationContext(
        contextQuery.data,
        searchParams.get("organizationId"),
        searchParams.get("branchId"),
      )
    : null;
  if (contextQuery.isPending)
    return (
      <PageFrame>
        <p aria-live="polite">{t("loadingAccess")}</p>
      </PageFrame>
    );
  if (contextQuery.isError)
    return (
      <PageFrame>
        <p className="form-message" role="alert">
          {t("accessError")}
        </p>
      </PageFrame>
    );
  if (!resolved?.organization)
    return (
      <PageFrame>
        <p>{t("uiChooseAnActiveOrganizationBeforeViewingAnalytics")}</p>
        <Link href="/app" className="underline">
          {t("uiReturnToWorkspace")}
        </Link>
      </PageFrame>
    );
  if (resolved.organization.role === "CASHIER")
    return (
      <PageFrame>
        <p className="form-message" role="alert">
          {t("uiAnalyticsIsNotAvailableForYourCurrentAccess")}
        </p>
        <Link href="/app" className="underline">
          {t("uiReturnToWorkspace")}
        </Link>
      </PageFrame>
    );
  return (
    <AnalyticsContent
      key={`${resolved.organization.id}:${resolved.organization.role}:${resolved.organization.branches.map((branch) => branch.id).join(",")}`}
      organization={resolved.organization}
      selectedBranchId={resolved.branch?.id ?? null}
    />
  );
}

function AnalyticsContent({
  organization,
  selectedBranchId,
}: {
  organization: AccessibleOrganization;
  selectedBranchId: string | null;
}) {
  const { t } = useLanguage();

  const [draftPeriod, setDraftPeriod] =
    useState<AnalyticsPeriod>(initialPeriod);
  const [period, setPeriod] = useState<AnalyticsPeriod>(draftPeriod);
  const [scopeValue, setScopeValue] = useState("organization");
  const [view, setView] = useState<View>(
    organization.role === "INVENTORY_STAFF" ? "inventory" : "sales",
  );
  const [selectedBucket, setSelectedBucket] = useState<string | null>(null);
  const [categoryReset, setCategoryReset] = useState(0);
  const [branchReset, setBranchReset] = useState(0);
  const isWideRole =
    organization.role === "OWNER" || organization.role === "ADMIN";
  const allowedBranches = organization.branches;
  const effectiveScope =
    isWideRole && scopeValue === "organization"
      ? { scope: "organization" as const }
      : {
          scope: "branch" as const,
          branchId:
            allowedBranches.find((branch) => branch.id === scopeValue)?.id ??
            allowedBranches[0]?.id ??
            "",
        };
  const enabled =
    period.from < period.to &&
    (effectiveScope.scope === "organization" || effectiveScope.branchId !== "");
  const request: AnalyticsRequest = {
    organizationId: organization.id,
    ...period,
    ...effectiveScope,
  };
  const queryRoot = [
    "analytics",
    organization.id,
    effectiveScope.scope,
    effectiveScope.scope === "branch" ? effectiveScope.branchId : null,
    period.from,
    period.to,
    period.granularity,
  ] as const;
  const salesQuery = useQuery({
    queryKey: [...queryRoot, "sales"],
    queryFn: ({ signal }) => getAnalyticsSales(request, signal),
    enabled:
      enabled &&
      view !== "inventory" &&
      view !== "forecast-reorder" &&
      view !== "insights",
  });
  const categoryQuery = useInfiniteQuery({
    queryKey: [...queryRoot, "categories", categoryReset],
    queryFn: ({ signal, pageParam }) =>
      getAnalyticsCategories(request, signal, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.meta.nextCursor ?? undefined,
    enabled: enabled && view === "categories",
  });
  const branchQuery = useInfiniteQuery({
    queryKey: [...queryRoot, "branches", branchReset],
    queryFn: ({ signal, pageParam }) =>
      getAnalyticsBranches(request, signal, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.meta.nextCursor ?? undefined,
    enabled: enabled && view === "branches",
  });
  const buckets = salesQuery.data?.data.buckets ?? [];
  const activeBucket =
    buckets.find((bucket) => bucket.localStartInclusive === selectedBucket) ??
    buckets.at(-1);
  const activeIndex = activeBucket ? buckets.indexOf(activeBucket) : -1;

  return (
    <PageFrame>
      <p className="text-sm text-muted-foreground">
        {t("uiAnalyticsFor")} {organization.name}.
      </p>
      <form
        hidden={view === "forecast-reorder" || view === "insights"}
        className="rounded-lg border bg-card p-4 sm:p-5"
        onSubmit={(event) => {
          event.preventDefault();
          setSelectedBucket(null);
          setPeriod(draftPeriod);
        }}
      >
        <div className="grid items-start gap-4 sm:grid-cols-2 xl:grid-cols-[12rem_12rem_10rem_minmax(0,1fr)]">
          <Label className="form-field">
            {t("uiFromInclusive")}
            <DateInput
              required
              value={draftPeriod.from}
              onChange={(event) =>
                setDraftPeriod({ ...draftPeriod, from: event.target.value })
              }
              className="form-control--date"
            />
          </Label>
          <Label className="form-field">
            {t("uiToExclusive")}
            <DateInput
              required
              value={draftPeriod.to}
              onChange={(event) =>
                setDraftPeriod({ ...draftPeriod, to: event.target.value })
              }
              className="form-control--date"
            />
          </Label>
          <Label className="form-field">
            {t("uiGranularity")}
            <NativeSelect
              value={draftPeriod.granularity}
              onChange={(event) =>
                setDraftPeriod({
                  ...draftPeriod,
                  granularity: event.target
                    .value as AnalyticsPeriod["granularity"],
                })
              }
              className="w-full "
            >
              <NativeSelectOption value="day">{t("uiDay")}</NativeSelectOption>
              <NativeSelectOption value="week">
                {t("uiWeek")}
              </NativeSelectOption>
              <NativeSelectOption value="month">
                {t("uiMonth")}
              </NativeSelectOption>
              <NativeSelectOption value="year">
                {t("uiYear")}
              </NativeSelectOption>
            </NativeSelect>
          </Label>
          <Label className="form-field">
            {t("uiScope")}
            <NativeSelect
              aria-label={t("uiAnalyticsScope")}
              value={
                effectiveScope.scope === "organization"
                  ? "organization"
                  : effectiveScope.branchId
              }
              onChange={(event) => setScopeValue(event.target.value)}
              className="w-full "
            >
              {isWideRole ? (
                <NativeSelectOption value="organization">
                  {t("aiAllBranches")}
                </NativeSelectOption>
              ) : null}
              {allowedBranches.map((branch) => (
                <NativeSelectOption key={branch.id} value={branch.id}>
                  {branch.code} — {branch.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Label>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button className="" type="submit">
            {t("uiApplyPeriod")}
          </Button>
          <p className="text-xs text-muted-foreground">
            {t("uiDatesUseTheOrganizationReportingTimezoneWeeksBeginMonday")}
          </p>
        </div>
      </form>
      <nav aria-label={t("uiAnalyticsViews")} className="flex flex-wrap gap-2">
        {(organization.role === "INVENTORY_STAFF"
          ? (["inventory", "forecast-reorder"] as const)
          : ([
              "sales",
              "categories",
              "branches",
              "inventory",
              "forecast-reorder",
              "insights",
            ] as const)
        ).map((item) => (
          <Button
            key={item}
            type="button"
            aria-pressed={view === item}
            onClick={() => setView(item)}
            variant={view === item ? "secondary" : "outline"}
          >
            {item === "sales"
              ? t("marketingSales")
              : item === "categories"
                ? t("uiCategories")
                : item === "branches"
                  ? t("branchTitle")
                  : item === "inventory"
                    ? t("inventoryTitle")
                    : item === "insights"
                      ? t("aiTitle")
                      : t("uiForecastReorder")}
          </Button>
        ))}
      </nav>
      {view === "insights" ? (
        <AiInsightView
          key={selectedBranchId ?? ""}
          organization={organization}
          selectedBranchId={selectedBranchId}
        />
      ) : view === "forecast-reorder" ? (
        <ForecastReorderView organization={organization} />
      ) : view === "inventory" ? (
        <InventoryAnalyticsView
          request={request}
          enabled={enabled}
          role={organization.role}
        />
      ) : !enabled ? (
        <p className="form-message" role="alert">
          {t("uiChooseAnAccessibleBranchAndAValidDateRange")}
        </p>
      ) : salesQuery.isPending ? (
        <p aria-live="polite">{t("uiLoadingSalesAnalytics")}</p>
      ) : salesQuery.isError ? (
        <p className="form-message" role="alert">
          {errorMessage(salesQuery.error, t)}
        </p>
      ) : (
        <>
          <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
            <p>
              {t("uiReportingTimezone")}{" "}
              {salesQuery.data.meta.reportingTimezone} ·{" "}
              {t(
                salesQuery.data.meta.dataStatus === "complete"
                  ? "coverageComplete"
                  : "coveragePartial",
              )}{" "}
              · {salesQuery.data.meta.includedBranchCount} {t("uiBranches")}
            </p>
            <p>
              {t("uiDataAsOf")} {salesQuery.data.meta.sourceCutoff}
            </p>
          </div>
          {buckets.length > 0 ? (
            <Label className="form-field max-w-xs">
              {t("uiSelectedPeriod")}
              <NativeSelect
                value={activeBucket?.localStartInclusive ?? ""}
                onChange={(event) => setSelectedBucket(event.target.value)}
                className="w-full "
              >
                {buckets.map((bucket) => (
                  <NativeSelectOption
                    value={bucket.localStartInclusive}
                    key={bucket.localStartInclusive}
                  >
                    {bucket.label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Label>
          ) : null}
          {view === "sales" ? (
            <section className="space-y-5" aria-label={t("uiSalesAnalytics")}>
              {buckets.length === 0 ? (
                <p>{t("uiNoSalesPeriodsWereReturned")}</p>
              ) : (
                <>
                  {activeBucket && <SalesMetrics bucket={activeBucket} />}
                  {buckets.every(
                    (bucket) =>
                      bucket.saleCount === 0 && bucket.refundCount === 0,
                  ) ? (
                    <p className="rounded-lg border bg-card p-4 text-sm">
                      {t("uiNoSalesOrRefundsInThisPeriod")}
                    </p>
                  ) : null}
                  <NetSalesChart buckets={buckets} />
                  <SalesSeriesTable buckets={buckets} />
                </>
              )}
            </section>
          ) : null}
          {view === "categories" ? (
            <section
              className="space-y-4"
              aria-label={t("uiCategoryAnalytics")}
            >
              <h2 className="text-xl font-semibold">{t("uiCategories")}</h2>
              {categoryQuery.isPending ? (
                <p aria-live="polite">{t("uiLoadingCategories")}</p>
              ) : categoryQuery.isError ? (
                <div role="alert">
                  <p>{errorMessage(categoryQuery.error, t)}</p>
                  {categoryQuery.error instanceof AnalyticsApiError &&
                  categoryQuery.error.kind === "invalid_cursor" ? (
                    <Button
                      variant="outline"
                      type="button"
                      onClick={() => setCategoryReset((value) => value + 1)}
                      className="underline"
                    >
                      {t("uiRestartCategoryList")}
                    </Button>
                  ) : null}
                </div>
              ) : (
                <>
                  {categoryQuery.data.pages.flatMap(
                    (page) => page.data.categories,
                  ).length === 0 ? (
                    <p>{t("uiNoCategoriesInThisScope")}</p>
                  ) : (
                    <div className="space-y-3">
                      {categoryQuery.data.pages
                        .flatMap((page) => page.data.categories)
                        .map((category) => {
                          const bucket = category.buckets[activeIndex];
                          return (
                            <details
                              key={category.categoryId ?? "uncategorized"}
                              className="rounded-lg border bg-card p-4"
                            >
                              <summary className="cursor-pointer">
                                <span className="font-medium break-words">
                                  {category.categoryKind === "UNCATEGORIZED"
                                    ? t("uiUncategorized")
                                    : category.categoryName}
                                </span>
                                {category.categoryStatus === "INACTIVE" ? (
                                  <span className="ml-2 rounded bg-muted px-2 py-1 text-xs">
                                    {t("commonInactive")}
                                  </span>
                                ) : null}
                                <span className="ml-3 text-sm text-muted-foreground">
                                  {bucket
                                    ? t("uiCategorySalesSummary")
                                        .replace(
                                          "{amount}",
                                          money(bucket.netSalesAmount),
                                        )
                                        .replace(
                                          "{share}",
                                          nullable(
                                            bucket.categorySharePercent,
                                            "percent",
                                            t,
                                          ),
                                        )
                                    : t("uiNoPeriodData")}
                                </span>
                              </summary>
                              <CategorySeriesTable buckets={category.buckets} />
                            </details>
                          );
                        })}
                    </div>
                  )}
                  {categoryQuery.hasNextPage ? (
                    <Button
                      variant="outline"
                      disabled={categoryQuery.isFetchingNextPage}
                      type="button"
                      onClick={() => void categoryQuery.fetchNextPage()}
                      className="bg-card"
                    >
                      {categoryQuery.isFetchingNextPage
                        ? t("uiLoadingNextPage")
                        : t("uiLoadMoreCategories")}
                    </Button>
                  ) : null}
                </>
              )}
            </section>
          ) : null}
          {view === "branches" ? (
            <section className="space-y-4" aria-label={t("uiBranchAnalytics")}>
              <h2 className="text-xl font-semibold">{t("branchTitle")}</h2>
              {branchQuery.isPending ? (
                <p aria-live="polite">{t("branchLoading")}</p>
              ) : branchQuery.isError ? (
                <div role="alert">
                  <p>{errorMessage(branchQuery.error, t)}</p>
                  {branchQuery.error instanceof AnalyticsApiError &&
                  branchQuery.error.kind === "invalid_cursor" ? (
                    <Button
                      variant="outline"
                      type="button"
                      onClick={() => setBranchReset((value) => value + 1)}
                      className="underline"
                    >
                      {t("uiRestartBranchList")}
                    </Button>
                  ) : null}
                </div>
              ) : (
                <>
                  {branchQuery.data.pages.flatMap((page) => page.data.branches)
                    .length === 0 ? (
                    <p>{t("uiNoBranchesInThisScope")}</p>
                  ) : (
                    <div className="space-y-3">
                      {branchQuery.data.pages
                        .flatMap((page) => page.data.branches)
                        .map((branch) => {
                          const bucket = branch.buckets[activeIndex];
                          return (
                            <details
                              key={branch.branchId}
                              className="rounded-lg border bg-card p-4"
                            >
                              <summary className="cursor-pointer">
                                <span className="font-medium break-words">
                                  {branch.branchName}
                                </span>
                                {branch.branchStatus === "INACTIVE" ? (
                                  <span className="ml-2 rounded bg-muted px-2 py-1 text-xs">
                                    {t("commonInactive")}
                                  </span>
                                ) : null}
                                <span className="ml-3 text-sm text-muted-foreground">
                                  {bucket
                                    ? t("uiBranchSalesSummary")
                                        .replace(
                                          "{amount}",
                                          money(bucket.netSalesAmount),
                                        )
                                        .replace(
                                          "{count}",
                                          String(bucket.saleCount),
                                        )
                                    : t("uiNoPeriodData")}
                                </span>
                              </summary>
                              <div className="mt-4 space-y-4">
                                {bucket ? (
                                  <SalesMetrics bucket={bucket} />
                                ) : null}
                                <SalesSeriesTable buckets={branch.buckets} />
                              </div>
                            </details>
                          );
                        })}
                    </div>
                  )}
                  {branchQuery.hasNextPage ? (
                    <Button
                      variant="outline"
                      disabled={branchQuery.isFetchingNextPage}
                      type="button"
                      onClick={() => void branchQuery.fetchNextPage()}
                      className="bg-card"
                    >
                      {branchQuery.isFetchingNextPage
                        ? t("uiLoadingNextPage")
                        : t("uiLoadMoreBranches")}
                    </Button>
                  ) : null}
                </>
              )}
            </section>
          ) : null}
        </>
      )}
    </PageFrame>
  );
}
