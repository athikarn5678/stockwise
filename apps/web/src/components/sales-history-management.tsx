"use client";
import type { TranslationKey } from "@/i18n/en";
import { useLanguage } from "@/providers/language-provider";
import { Label } from "@/components/ui/label";
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
import { Textarea } from "@/components/ui/textarea";

import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { formatThb } from "@/money-display";
import { SaleReceipt } from "@/components/sale-receipt";
import {
  applicationContextUrl,
  resolveApplicationContext,
} from "@/application-context";
import {
  type AccessibleOrganization,
  fetchAccessContext,
} from "@/branch-api-client";
import {
  createSaleRefund,
  getSalesHistoryDetail,
  listSalesHistory,
  type SalesApiErrorKind,
  SalesApiError,
  type SalesHistoryDetail,
  type SalesHistorySummary,
  type SalesRequestContext,
} from "@/sales-api-client";

type SalesHistoryRole = AccessibleOrganization["role"];
type SalesHistoryPage = Awaited<ReturnType<typeof listSalesHistory>>;

const HISTORY_ROLES = new Set<SalesHistoryRole>([
  "OWNER",
  "ADMIN",
  "BRANCH_MANAGER",
  "CASHIER",
]);
const REFUND_CREATE_ROLES = new Set<SalesHistoryRole>([
  "OWNER",
  "ADMIN",
  "BRANCH_MANAGER",
]);
const REFUND_LABELS: Record<
  SalesHistorySummary["refundState"],
  TranslationKey
> = {
  NONE: "refundStateNone",
  PARTIALLY_REFUNDED: "refundStatePartial",
  FULLY_REFUNDED: "refundStateFull",
};
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function salesUrl(organizationId: string, branchId: string | null): string {
  const params = new URLSearchParams({ organizationId });
  if (branchId !== null) params.set("branchId", branchId);
  return `/app/sales?${params.toString()}`;
}

function salesScopeKey(context: SalesRequestContext): readonly unknown[] {
  return ["branch-scoped", context.organizationId, context.branchId, "sales"];
}

function formatAbsoluteTimestamp(value: string): string {
  return value.replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

function errorMessage(
  error: unknown,
  t: (key: TranslationKey) => string,
): string {
  if (!(error instanceof SalesApiError)) {
    return t("uiSalesHistoryIsTemporarilyUnavailableTryAgain");
  }
  const messages: Record<SalesApiErrorKind, string> = {
    authentication_required: t("uiSignInAgainToViewSalesHistory"),
    branch_inactive: t("uiThisBranchIsInactive"),
    forbidden: t("uiSalesHistoryIsNotAvailableForYourCurrentAccess"),
    idempotency_conflict: t("uiSalesHistoryIsTemporarilyUnavailableTryAgain"),
    insufficient_stock: t("uiSalesHistoryIsTemporarilyUnavailableTryAgain"),
    invalid_cursor: t("uiThisSalesListChangedRefreshTheLatestResults"),
    price_changed: t("uiSalesHistoryIsTemporarilyUnavailableTryAgain"),
    product_inactive: t("uiSalesHistoryIsTemporarilyUnavailableTryAgain"),
    product_not_found: t("uiSalesHistoryIsTemporarilyUnavailableTryAgain"),
    sale_not_found: t("uiThisSaleIsNoLongerAvailableAtThisBranch"),
    sale_already_fully_refunded: t("uiThisSaleIsAlreadyFullyRefunded"),
    refund_quantity_exceeded: t(
      "uiARefundQuantityExceedsWhatRemainsOnTheOriginal",
    ),
    stale_vat_profile: t("uiSalesHistoryIsTemporarilyUnavailableTryAgain"),
    unavailable: t("uiSalesHistoryIsTemporarilyUnavailableTryAgain"),
    validation: t("uiCheckTheCashierUserIDAndTryAgain"),
    vat_configuration_required: t(
      "uiSalesHistoryIsTemporarilyUnavailableTryAgain",
    ),
  };
  return messages[error.kind];
}

export function SalesHistoryManagement() {
  const { t } = useLanguage();

  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedOrganizationId = searchParams.get("organizationId");
  const requestedBranchId = searchParams.get("branchId");
  const contextQuery = useQuery({
    queryFn: fetchAccessContext,
    queryKey: ["access-context"],
  });
  const resolved = contextQuery.data
    ? resolveApplicationContext(
        contextQuery.data,
        requestedOrganizationId,
        requestedBranchId,
      )
    : null;

  useEffect(() => {
    if (resolved?.organization === null || resolved?.organization === undefined)
      return;
    const canonical = salesUrl(
      resolved.organization.id,
      resolved.branch?.id ?? null,
    );
    const current = salesUrl(requestedOrganizationId ?? "", requestedBranchId);
    if (canonical !== current) router.replace(canonical);
  }, [requestedBranchId, requestedOrganizationId, resolved, router]);

  if (contextQuery.isPending)
    return <p aria-live="polite">{t("loadingAccess")}</p>;
  if (contextQuery.isError)
    return (
      <p className="form-message" role="alert">
        {t("accessError")}
      </p>
    );
  if (resolved?.organization === null) {
    return (
      <ContextUnavailable
        message={t("uiChooseAnActiveOrganizationFromTheWorkspaceBeforeViewing")}
      />
    );
  }
  if (resolved === null) return null;
  if (resolved.branch === null) {
    return (
      <ContextUnavailable
        message={t("uiChooseAnActiveBranchBeforeViewingSales")}
        title={t("uiBranchContextRequired")}
      />
    );
  }
  if (!HISTORY_ROLES.has(resolved.organization.role)) {
    return (
      <ContextUnavailable
        message={t("uiYourCurrentRoleCannotViewSalesHistory")}
        title={t("uiSalesHistoryUnavailable")}
      />
    );
  }
  return (
    <SalesHistoryContent
      branch={resolved.branch}
      organization={resolved.organization}
    />
  );
}

function ContextUnavailable({
  message,
  title,
}: {
  message: string;
  title?: string;
}) {
  const { t } = useLanguage();

  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-semibold">
        {title ?? t("uiSalesHistoryUnavailable")}
      </h1>
      <p className="text-muted-foreground">{message}</p>
      <Link className="underline" href="/app">
        {t("uiReturnToWorkspace")}
      </Link>
    </section>
  );
}

function SalesHistoryContent({
  branch,
  organization,
}: {
  branch: AccessibleOrganization["branches"][number];
  organization: AccessibleOrganization;
}) {
  const { t } = useLanguage();

  const context = {
    branchId: branch.id,
    organizationId: organization.id,
  } satisfies SalesRequestContext;
  const scopeKey = salesScopeKey(context);
  const [actorInput, setActorInput] = useState("");
  const [actorUserId, setActorUserId] = useState<string | undefined>();
  const [filterError, setFilterError] = useState<TranslationKey | null>(null);
  const [selectedSaleId, setSelectedSaleId] = useState<string | null>(null);
  const historyQuery = useInfiniteQuery<
    SalesHistoryPage,
    Error,
    InfiniteData<SalesHistoryPage>,
    readonly unknown[],
    string | null
  >({
    getNextPageParam: (page) => page.meta.nextCursor,
    initialPageParam: null,
    queryFn: ({ pageParam }) =>
      listSalesHistory(context, {
        ...(actorUserId === undefined ? {} : { actorUserId }),
        cursor: pageParam,
      }),
    queryKey: [...scopeKey, "history", { actorUserId: actorUserId ?? null }],
  });
  const sales =
    historyQuery.data?.pages.flatMap((page) => page.data.sales) ?? [];

  useEffect(() => {
    setSelectedSaleId(null);
  }, [branch.id, organization.id, actorUserId]);

  return (
    <section className="w-full space-y-8">
      <header className="space-y-2">
        <Link
          className="text-sm underline"
          href={applicationContextUrl(organization.id, branch.id)}
        >
          {t("backToWorkspace")}
        </Link>
        <h1 className="text-2xl font-semibold">{t("sales")}</h1>
        <p className="text-muted-foreground">
          {t("uiCompletedSalesAt")} {branch.code} — {branch.name}
          {t("uiSaleTimestampsAreShownInUTCAnalyticsUsesThe")}
        </p>
      </header>

      <form
        aria-label={t("uiFilterSalesHistory")}
        className="flex flex-wrap items-end gap-3 rounded-lg border bg-card p-4"
        onSubmit={(event) => {
          event.preventDefault();
          const value = actorInput.trim();
          if (value !== "" && !UUID_PATTERN.test(value)) {
            setFilterError("uiEnterAValidCashierUserIDOrLeaveIt");
            return;
          }
          setFilterError(null);
          setActorUserId(value === "" ? undefined : value);
        }}
      >
        <Label className="form-field w-full sm:w-96">
          {t("uiCashierUserIDOptional")}
          <Input
            aria-describedby={filterError ? "sales-filter-error" : undefined}
            className=""
            onChange={(event) => setActorInput(event.target.value)}
            placeholder={t("uiExactUUIDOnly")}
            value={actorInput}
          />
        </Label>
        <Button variant="outline" type="submit">
          {t("uiApplyFilter")}
        </Button>
        <Button
          variant="outline"
          disabled={actorInput === "" && actorUserId === undefined}
          onClick={() => {
            setActorInput("");
            setActorUserId(undefined);
            setFilterError(null);
          }}
          type="button"
        >
          {t("uiClearFilter")}
        </Button>
        {filterError ? (
          <p className="form-message" id="sales-filter-error" role="alert">
            {t(filterError)}
          </p>
        ) : null}
      </form>

      <SalesList
        error={historyQuery.error}
        hasNextPage={historyQuery.hasNextPage}
        isLoading={historyQuery.isPending}
        isLoadingNext={historyQuery.isFetchingNextPage}
        onLoadMore={() => void historyQuery.fetchNextPage()}
        onSelect={setSelectedSaleId}
        sales={sales}
        selectedSaleId={selectedSaleId}
      />
      {selectedSaleId !== null ? (
        <SalesDetail
          canCreateRefund={REFUND_CREATE_ROLES.has(organization.role)}
          context={context}
          key={selectedSaleId}
          saleId={selectedSaleId}
          scopeKey={scopeKey}
        />
      ) : null}
    </section>
  );
}

function SalesList({
  error,
  hasNextPage,
  isLoading,
  isLoadingNext,
  onLoadMore,
  onSelect,
  sales,
  selectedSaleId,
}: {
  error: Error | null;
  hasNextPage: boolean;
  isLoading: boolean;
  isLoadingNext: boolean;
  onLoadMore: () => void;
  onSelect: (saleId: string) => void;
  sales: SalesHistorySummary[];
  selectedSaleId: string | null;
}) {
  const { t } = useLanguage();

  if (isLoading) return <p aria-live="polite">{t("uiLoadingSalesHistory")}</p>;
  if (error !== null)
    return (
      <p className="form-message" role="alert">
        {errorMessage(error, t)}
      </p>
    );
  if (sales.length === 0) {
    return (
      <p className="rounded-lg border p-5 text-muted-foreground">
        {t("uiNoCompletedSalesMatchThisBranchAndFilter")}
      </p>
    );
  }
  return (
    <section aria-label={t("sales")} className="space-y-4">
      <div className="overflow-x-auto rounded-lg border bg-card">
        <Table className="w-full min-w-[45rem] text-left text-sm">
          <TableHeader className="border-b bg-muted text-xs uppercase tracking-wide text-muted-foreground">
            <TableRow>
              <TableHead className="px-4 py-3 font-medium">
                {t("uiSale")}
              </TableHead>
              <TableHead className="px-4 py-3 font-medium">
                {t("uiCashier")}
              </TableHead>
              <TableHead className="px-4 py-3 font-medium">
                {t("uiPayment")}
              </TableHead>
              <TableHead className="px-4 py-3 text-right font-medium">
                {t("receiptTotal")}
              </TableHead>
              <TableHead className="relative px-4 py-3 font-medium">
                <span className="sr-only">{t("uiOpenDetail")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sales.map((sale) => (
              <TableRow className="border-b last:border-0" key={sale.id}>
                <TableCell className="px-4 py-3">
                  <p className="font-medium">{sale.reference}</p>
                  <p className="text-muted-foreground">
                    {formatAbsoluteTimestamp(sale.createdAt)} · {sale.itemCount}{" "}
                    {t("uiItem")}
                    {sale.itemCount === 1 ? "" : "s"}
                  </p>
                  <p className="text-muted-foreground">
                    {t(REFUND_LABELS[sale.refundState])} {t("uiRemaining")}{" "}
                    {formatThb(sale.remainingAmount)}
                  </p>
                </TableCell>
                <TableCell className="px-4 py-3">
                  {sale.actorDisplayName}
                </TableCell>
                <TableCell className="px-4 py-3">
                  {t(
                    sale.payment.method === "CASH"
                      ? "paymentCash"
                      : "paymentTransfer",
                  )}
                </TableCell>
                <TableCell className="px-4 py-3 text-right font-medium">
                  {formatThb(sale.totalAmount)}
                </TableCell>
                <TableCell className="px-4 py-3 text-right">
                  <Button
                    variant="outline"
                    aria-pressed={selectedSaleId === sale.id}
                    onClick={() => onSelect(sale.id)}
                    type="button"
                  >
                    {t("uiViewDetail")}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {hasNextPage ? (
        <Button
          variant="outline"
          disabled={isLoadingNext}
          onClick={onLoadMore}
          type="button"
        >
          {isLoadingNext ? t("inventoryLoadingMore") : t("uiLoadMoreSales")}
        </Button>
      ) : null}
    </section>
  );
}

function SalesDetail({
  canCreateRefund,
  context,
  saleId,
  scopeKey,
}: {
  canCreateRefund: boolean;
  context: SalesRequestContext;
  saleId: string;
  scopeKey: readonly unknown[];
}) {
  const { t } = useLanguage();

  const detailRef = useRef<HTMLElement>(null);
  const hasScrolled = useRef(false);
  const detailQuery = useQuery({
    queryFn: () => getSalesHistoryDetail(context, saleId),
    queryKey: [...scopeKey, "detail", saleId],
  });

  useEffect(() => {
    if (!detailQuery.isSuccess || hasScrolled.current || !detailRef.current)
      return;
    hasScrolled.current = true;
    detailRef.current.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
      block: "start",
    });
  }, [detailQuery.isSuccess]);

  return (
    <section
      aria-live="polite"
      className="scroll-mt-6 space-y-6 rounded-lg border bg-card p-5 sm:p-7"
      ref={detailRef}
    >
      {detailQuery.isPending ? <p>{t("uiLoadingSaleDetail")}</p> : null}
      {detailQuery.isError ? (
        <p className="form-message" role="alert">
          {errorMessage(detailQuery.error, t)}
        </p>
      ) : null}
      {detailQuery.data ? (
        <SaleDetailContent
          canCreateRefund={canCreateRefund}
          context={context}
          sale={detailQuery.data}
          scopeKey={scopeKey}
        />
      ) : null}
    </section>
  );
}

function SaleDetailContent({
  canCreateRefund,
  context,
  sale,
  scopeKey,
}: {
  canCreateRefund: boolean;
  context: SalesRequestContext;
  sale: SalesHistoryDetail;
  scopeKey: readonly unknown[];
}) {
  const { t } = useLanguage();

  const includesCosts = sale.items.some(
    (item) => item.cogsAmount !== undefined || item.unitCost !== undefined,
  );
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold">{sale.reference}</h2>
          <p className="text-sm text-muted-foreground">
            {formatAbsoluteTimestamp(sale.createdAt)} · {sale.actorDisplayName}
          </p>
        </div>
        <Button variant="outline" onClick={() => window.print()} type="button">
          {t("uiPrintReceipt")}
        </Button>
      </div>
      <SaleItems sale={sale} />
      <SaleTotals sale={sale} />
      <PaymentDetails payment={sale.payment} />
      {includesCosts ? <CostDetails sale={sale} /> : null}
      <RefundHistory sale={sale} />
      {canCreateRefund && sale.refundState !== "FULLY_REFUNDED" ? (
        <RefundPanel
          context={context}
          key={sale.id}
          sale={sale}
          scopeKey={scopeKey}
        />
      ) : null}
      <SaleReceipt sale={sale} />
    </>
  );
}

function RefundHistory({ sale }: { sale: SalesHistoryDetail }) {
  const { t } = useLanguage();

  return (
    <section aria-labelledby="refund-history-heading" className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold" id="refund-history-heading">
          {t("uiRefunds")}
        </h3>
        <p className="text-sm text-muted-foreground">
          {t(REFUND_LABELS[sale.refundState])} {t("uiRefunded")}{" "}
          {formatThb(sale.refundedAmount)} {t("uiRemaining")}{" "}
          {formatThb(sale.remainingAmount)}
        </p>
      </div>
      {sale.refunds.length === 0 ? (
        <p className="rounded-md border p-4 text-sm text-muted-foreground">
          {t("uiNoRefundsAreLinkedToThisSale")}
        </p>
      ) : (
        <div className="space-y-3">
          {sale.refunds.map((refund) => (
            <article className="rounded-md border p-4 text-sm" key={refund.id}>
              <div className="flex flex-wrap justify-between gap-2">
                <div>
                  <p className="font-medium">{refund.reference}</p>
                  <p className="text-muted-foreground">
                    {formatAbsoluteTimestamp(refund.completedAt)} ·{" "}
                    {refund.actorDisplayName}
                  </p>
                </div>
                <p className="font-medium">{formatThb(refund.totalAmount)}</p>
              </div>
              <p className="mt-2">
                {t("uiReason")} {refund.reason}
              </p>
              <p className="text-muted-foreground">
                {t(
                  refund.payment.method === "CASH"
                    ? "paymentCash"
                    : "paymentTransfer",
                )}
                {refund.payment.reference === null
                  ? ""
                  : ` · ${refund.payment.reference}`}
              </p>
              <ul className="mt-3 space-y-1 border-t pt-3">
                {refund.items.map((item) => {
                  const original = sale.items.find(
                    (saleItem) => saleItem.id === item.saleItemId,
                  );
                  return (
                    <li key={item.id}>
                      {original?.productName ?? item.productId}
                      {t("uiRefunded2")} {item.refundQuantity}
                      {t("uiRestocked")} {item.restockQuantity} ·{" "}
                      {formatThb(item.reversedLineNet)}
                      {item.cogsReversalAmount === undefined
                        ? ""
                        : item.cogsReversalAmount === null
                          ? t("uiCogsUnavailableSuffix")
                          : t("uiCogsAmount").replace(
                              "{amount}",
                              formatThb(item.cogsReversalAmount),
                            )}
                    </li>
                  );
                })}
              </ul>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function RefundPanel({
  context,
  sale,
  scopeKey,
}: {
  context: SalesRequestContext;
  sale: SalesHistoryDetail;
  scopeKey: readonly unknown[];
}) {
  const { t } = useLanguage();

  const queryClient = useQueryClient();
  const [reason, setReason] = useState("");
  const [transferReference, setTransferReference] = useState("");
  const [lines, setLines] = useState(() =>
    Object.fromEntries(
      sale.items.map((item) => [
        item.id,
        { quantity: "", restockQuantity: "0" },
      ]),
    ),
  );
  const [validationError, setValidationError] = useState<TranslationKey | null>(
    null,
  );
  const lastAttempt = useRef<{ key: string; signature: string } | null>(null);
  const mutation = useMutation({
    mutationFn: (request: {
      idempotencyKey: string;
      input: Parameters<typeof createSaleRefund>[3];
    }) =>
      createSaleRefund(context, sale.id, request.idempotencyKey, request.input),
    onSuccess: async () => {
      setReason("");
      setTransferReference("");
      setLines(
        Object.fromEntries(
          sale.items.map((item) => [
            item.id,
            { quantity: "", restockQuantity: "0" },
          ]),
        ),
      );
      lastAttempt.current = null;
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: [...scopeKey, "detail", sale.id],
        }),
        queryClient.invalidateQueries({ queryKey: [...scopeKey, "history"] }),
      ]);
    },
  });
  const refundableItems = sale.items.filter(
    (item) => item.remainingRefundableQuantity !== "0.0000",
  );

  return (
    <form
      aria-label={t("uiCreateSaleRefund")}
      className="space-y-4 rounded-md border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        const items = refundableItems.flatMap((item) => {
          const line = lines[item.id];
          const quantity = line?.quantity.trim() ?? "";
          return quantity === ""
            ? []
            : [
                {
                  quantity,
                  restockQuantity: line?.restockQuantity.trim() || "0",
                  saleItemId: item.id,
                },
              ];
        });
        if (items.length === 0) {
          setValidationError("uiEnterARefundQuantityForAtLeastOneItem");
          return;
        }
        if (reason.trim() === "") {
          setValidationError("uiEnterAReasonForThisRefund");
          return;
        }
        if (
          sale.payment.method === "TRANSFER" &&
          transferReference.trim() === ""
        ) {
          setValidationError("uiEnterTheConfirmedTransferReference");
          return;
        }
        const input = {
          items,
          reason,
          transferReference:
            sale.payment.method === "TRANSFER" ? transferReference : null,
        };
        const signature = JSON.stringify(input);
        const idempotencyKey =
          lastAttempt.current?.signature === signature
            ? lastAttempt.current.key
            : crypto.randomUUID();
        lastAttempt.current = { key: idempotencyKey, signature };
        setValidationError(null);
        mutation.mutate({ idempotencyKey, input });
      }}
    >
      <div>
        <h3 className="font-semibold">{t("uiCreateRefund")}</h3>
        <p className="text-sm text-muted-foreground">
          {t("uiRefundMoneyAndReturnedStockAreRecordedSeparatelyThis")}
        </p>
      </div>
      <div className="space-y-3">
        {refundableItems.map((item) => (
          <fieldset
            className="grid gap-3 rounded-md border p-3 sm:grid-cols-2"
            key={item.id}
          >
            <legend className="px-1 text-sm font-medium">
              {item.productName} · {item.remainingRefundableQuantity}{" "}
              {item.unit} {t("uiRemaining2")}
            </legend>
            <Label className="form-field">
              {t("uiRefundQuantity")}
              <Input
                className="form-control--numeric"
                inputMode="decimal"
                onChange={(event) =>
                  setLines((current) => ({
                    ...current,
                    [item.id]: {
                      ...current[item.id]!,
                      quantity: event.target.value,
                    },
                  }))
                }
                placeholder="0"
                value={lines[item.id]?.quantity ?? ""}
              />
            </Label>
            <Label className="form-field">
              {t("uiRestockQuantity")}
              <Input
                className="form-control--numeric"
                inputMode="decimal"
                onChange={(event) =>
                  setLines((current) => ({
                    ...current,
                    [item.id]: {
                      ...current[item.id]!,
                      restockQuantity: event.target.value,
                    },
                  }))
                }
                value={lines[item.id]?.restockQuantity ?? "0"}
              />
            </Label>
          </fieldset>
        ))}
      </div>
      <Label className="form-field">
        {t("uiReason2")}
        <Textarea
          className=""
          maxLength={200}
          onChange={(event) => setReason(event.target.value)}
          required
          value={reason}
        />
      </Label>
      {sale.payment.method === "TRANSFER" ? (
        <Label className="form-field">
          {t("uiConfirmedTransferReference")}
          <Input
            className=""
            maxLength={100}
            onChange={(event) => setTransferReference(event.target.value)}
            required
            value={transferReference}
          />
        </Label>
      ) : null}
      {validationError !== null ? (
        <p className="form-message" role="alert">
          {t(validationError)}
        </p>
      ) : null}
      {mutation.isError ? (
        <p className="form-message" role="alert">
          {errorMessage(mutation.error, t)}
        </p>
      ) : null}
      {mutation.data ? (
        <p role="status">
          {t("uiRefund")} {mutation.data.reference} {t("uiCompleted")}
        </p>
      ) : null}
      <Button variant="outline" disabled={mutation.isPending} type="submit">
        {mutation.isPending
          ? t("uiRecordingRefund")
          : t("uiConfirmIrreversibleRefund")}
      </Button>
    </form>
  );
}

function SaleItems({ sale }: { sale: SalesHistoryDetail }) {
  const { t } = useLanguage();

  return (
    <section aria-labelledby="sale-items-heading" className="space-y-3">
      <h3 className="font-semibold" id="sale-items-heading">
        {t("uiItems")}
      </h3>
      <div
        aria-label={t("uiSaleItemDetails")}
        className="overflow-x-auto rounded-md border focus-visible:outline-2 focus-visible:outline-ring"
        role="region"
        tabIndex={0}
      >
        <Table className="w-full min-w-[40rem] text-left text-sm">
          <TableHeader className="border-b bg-muted text-xs uppercase tracking-wide text-muted-foreground">
            <TableRow>
              <TableHead className="px-3 py-2">
                {t("marketingProduct")}
              </TableHead>
              <TableHead className="px-3 py-2">{t("uiQuantity")}</TableHead>
              <TableHead className="px-3 py-2 text-right">
                {t("uiUnitPrice")}
              </TableHead>
              <TableHead className="px-3 py-2 text-right">
                {t("uiLineTotal")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sale.items.map((item) => (
              <TableRow className="border-b last:border-0" key={item.id}>
                <TableCell className="px-3 py-2">
                  <p className="font-medium">{item.productName}</p>
                  <p className="text-muted-foreground">
                    {item.productSku} · {item.unit}
                  </p>
                </TableCell>
                <TableCell className="px-3 py-2">{item.quantity}</TableCell>
                <TableCell className="px-3 py-2 text-right">
                  {formatThb(item.unitPrice)}
                </TableCell>
                <TableCell className="px-3 py-2 text-right">
                  {formatThb(item.lineNet)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

function SaleTotals({ sale }: { sale: SalesHistoryDetail }) {
  const { t } = useLanguage();

  return (
    <section
      aria-label={t("uiSaleTotals")}
      className="ml-auto max-w-sm space-y-2 text-sm"
    >
      <TotalRow label={t("receiptSubtotal")} value={sale.subtotalAmount} />
      {sale.discountAmount !== "0.00" ? (
        <TotalRow label={t("receiptDiscount")} value={sale.discountAmount} />
      ) : null}
      {sale.taxableAmount !== null ? (
        <TotalRow label={t("receiptTaxable")} value={sale.taxableAmount} />
      ) : null}
      <TotalRow label={t("receiptVat")} value={sale.outputVatAmount} />
      <TotalRow emphasis label={t("receiptTotal")} value={sale.totalAmount} />
    </section>
  );
}

function TotalRow({
  emphasis = false,
  label,
  value,
}: {
  emphasis?: boolean;
  label: string;
  value: string;
}) {
  return (
    <div
      className={
        emphasis
          ? "flex justify-between border-t pt-2 text-base font-semibold"
          : "flex justify-between"
      }
    >
      <span>{label}</span>
      <span>{formatThb(value)}</span>
    </div>
  );
}

function PaymentDetails({
  payment,
}: {
  payment: SalesHistoryDetail["payment"];
}) {
  const { t } = useLanguage();

  return (
    <section
      aria-labelledby="payment-heading"
      className="rounded-md border p-4 text-sm"
    >
      <h3 className="font-semibold" id="payment-heading">
        {t("uiPayment")}
      </h3>
      <p className="mt-2">
        {t(payment.method === "CASH" ? "paymentCash" : "paymentTransfer")} ·{" "}
        {formatThb(payment.amount)}
      </p>
      {payment.method === "CASH" ? (
        <p className="text-muted-foreground">
          {t("uiTendered")} {formatThb(payment.amountTendered)} {t("uiChange")}{" "}
          {formatThb(payment.changeAmount)}
        </p>
      ) : null}
      {payment.method === "TRANSFER" && payment.reference !== null ? (
        <p className="text-muted-foreground">
          {t("uiReference")} {payment.reference}
        </p>
      ) : null}
    </section>
  );
}

function CostDetails({ sale }: { sale: SalesHistoryDetail }) {
  const { t } = useLanguage();

  return (
    <section
      aria-labelledby="cost-details-heading"
      className="rounded-md border p-4 text-sm"
    >
      <h3 className="font-semibold" id="cost-details-heading">
        {t("uiInternalCostDetails")}
      </h3>
      <ul className="mt-2 space-y-1">
        {sale.items.map((item) =>
          item.cogsAmount !== undefined ? (
            <li key={item.id}>
              {item.productName}
              {t("uiCOGS")}{" "}
              {item.cogsAmount === null
                ? t("posUnavailable")
                : formatThb(item.cogsAmount)}
            </li>
          ) : null,
        )}
      </ul>
    </section>
  );
}
