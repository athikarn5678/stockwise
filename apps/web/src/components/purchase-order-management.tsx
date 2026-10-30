"use client";
import type { TranslationKey } from "@/i18n/en";
import { useLanguage } from "@/providers/language-provider";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Input } from "@/components/ui/input";
import { DateInput } from "@/components/ui/date-input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";

import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";

import { formatMoney } from "@/money-display";
import {
  applicationContextUrl,
  resolveApplicationContext,
} from "@/application-context";
import {
  type AccessibleOrganization,
  fetchAccessContext,
} from "@/branch-api-client";
import {
  listProducts,
  type CatalogProduct,
  type CatalogRequestContext,
  type ProductUnit,
} from "@/catalog-api-client";
import {
  createPurchaseOrder,
  getPurchaseOrder,
  listPurchaseOrders,
  PurchaseOrderApiError,
  purchaseOrderScopeKey,
  transitionPurchaseOrder,
  type PurchaseOrder,
  type PurchaseOrderInput,
  type PurchaseOrderRequestContext,
  type PurchaseOrderStatus,
  updatePurchaseOrder,
} from "@/purchase-order-api-client";
import { listSuppliers, type Supplier } from "@/supplier-api-client";
import {
  receivePurchaseOrder,
  ReceivingApiError,
  type Receipt,
} from "@/receiving-api-client";

type PurchaseOrderRole = AccessibleOrganization["role"];
type DraftLine = PurchaseOrderInput["items"][number];
type DraftInput = PurchaseOrderInput;
type LifecycleIntent = "ORDERED" | "CANCELLED";
type PurchaseOrderPage = Awaited<ReturnType<typeof listPurchaseOrders>>;

const MANAGEMENT_ROLES = new Set<PurchaseOrderRole>([
  "OWNER",
  "ADMIN",
  "BRANCH_MANAGER",
]);
const INTEGER_UNITS = new Set<ProductUnit>(["EA", "PACK", "BOX"]);
const STATUS_OPTIONS: Array<PurchaseOrderStatus | "all"> = [
  "all",
  "DRAFT",
  "ORDERED",
  "RECEIVED",
  "CANCELLED",
];

function purchaseOrdersUrl(organizationId: string, branchId: string | null) {
  const params = new URLSearchParams({ organizationId });
  if (branchId !== null) params.set("branchId", branchId);
  return `/app/purchase-orders?${params.toString()}`;
}

function emptyDraft(): DraftInput {
  return {
    expectedDate: null,
    items: [{ expectedUnitCost: "", productId: "", quantity: "" }],
    orderDate: new Date().toISOString().slice(0, 10),
    supplierId: "",
  };
}

function draftFromOrder(order: PurchaseOrder | null): DraftInput {
  if (order === null) return emptyDraft();
  return {
    expectedDate: order.expectedDate,
    items: order.items.map(({ expectedUnitCost, productId, quantity }) => ({
      expectedUnitCost,
      productId,
      quantity,
    })),
    orderDate: order.orderDate,
    supplierId: order.supplierId,
  };
}

function errorMessage(error: unknown): TranslationKey {
  if (!(error instanceof PurchaseOrderApiError)) {
    return "uiPurchaseOrderDataIsTemporarilyUnavailableTryAgain";
  }
  const messages: Record<PurchaseOrderApiError["kind"], TranslationKey> = {
    authentication_required: "branchErrAuth",
    branch_inactive: "uiThisBranchIsInactiveAndCannotAcceptPurchaseOrders",
    forbidden: "uiPurchaseOrderManagementIsNotAvailableForYourCurrent",
    invalid_cursor: "uiThisListChangedRefreshTheLatestPurchaseOrders",
    not_found: "uiThatPurchaseOrderIsNoLongerAvailable",
    product_inactive: "uiASelectedProductIsInactiveReviewTheDraftBefore",
    product_not_found: "uiASelectedProductIsNoLongerAvailable",
    stale: "uiThisPurchaseOrderChangedElsewhereTheCurrentServerState",
    state_conflict: "uiThisPurchaseOrderCanNoLongerMakeThatTransition",
    supplier_inactive: "uiTheSelectedSupplierIsInactiveChooseAnActiveSupplier",
    supplier_not_found: "uiTheSelectedSupplierIsNoLongerAvailable",
    unavailable: "uiPurchaseOrderDataIsTemporarilyUnavailableTryAgain",
    validation: "uiCheckThePurchaseOrderValuesAndTryAgain",
  };
  return messages[error.kind];
}

function receivingErrorMessage(error: unknown): TranslationKey {
  if (!(error instanceof ReceivingApiError))
    return "uiReceivingStatusIsUnknownRetryWithTheSameIntent";
  const messages: Record<ReceivingApiError["kind"], TranslationKey> = {
    authentication_required: "branchErrAuth",
    forbidden: "uiReceivingIsNotAvailableForYourCurrentAccess",
    not_found: "uiThatPurchaseOrderIsNoLongerAvailable",
    branch_inactive: "uiReceivingIsBlockedBecauseThisBranchIsInactive",
    product_inactive:
      "uiReceivingIsBlockedUntilTheAffectedProductIsReactivated",
    state_conflict: "uiThisOrderChangedStateRefreshItBeforeTryingAgain",
    receipt_invalid: "uiTheServerRejectedThisReceiptReviewTheEnteredValues",
    idempotency_conflict:
      "uiThePreviousRequestKeyRepresentsDifferentReceiptIntentReview",
    reference_conflict: "uiTheReceiptReferenceCouldNotBeAllocatedRetryWith",
    validation: "uiReviewTheReceiptValuesAndVATFields",
    unavailable: "uiReceivingStatusIsUnknownRetryWithTheSameIntent",
  };
  return messages[error.kind];
}

function validCost(value: string): boolean {
  return /^\d+(?:\.\d{1,4})?$/.test(value);
}

function validQuantity(value: string, unit: ProductUnit | undefined): boolean {
  if (!/^\d+(?:\.\d{1,4})?$/.test(value)) return false;
  if (/^0+(?:\.0+)?$/.test(value)) return false;
  const fraction = value.split(".")[1];
  return !(
    unit !== undefined &&
    INTEGER_UNITS.has(unit) &&
    fraction !== undefined &&
    !/^0+$/.test(fraction)
  );
}

function statusLabel(
  status: PurchaseOrderStatus,
  t: (key: TranslationKey) => string,
): string {
  const keys: Record<PurchaseOrderStatus, TranslationKey> = {
    DRAFT: "poStatusDraft",
    ORDERED: "poStatusOrdered",
    RECEIVED: "poStatusReceived",
    CANCELLED: "poStatusCancelled",
  };
  return t(keys[status]);
}

function StatusBadge({ status }: { status: PurchaseOrderStatus }) {
  const { t } = useLanguage();
  return (
    <span className="rounded-full border px-2 py-1 text-xs font-medium">
      {statusLabel(status, t)}
    </span>
  );
}

export function PurchaseOrderManagement() {
  const { t } = useLanguage();

  const router = useRouter();
  const params = useSearchParams();
  const requestedOrganizationId = params.get("organizationId");
  const requestedBranchId = params.get("branchId");
  const access = useQuery({
    queryFn: fetchAccessContext,
    queryKey: ["access-context"],
  });
  const resolved = access.data
    ? resolveApplicationContext(
        access.data,
        requestedOrganizationId,
        requestedBranchId,
      )
    : null;

  useEffect(() => {
    if (resolved?.organization === null || resolved?.organization === undefined)
      return;
    const canonical = purchaseOrdersUrl(
      resolved.organization.id,
      resolved.branch?.id ?? null,
    );
    const current = purchaseOrdersUrl(
      requestedOrganizationId ?? "",
      requestedBranchId,
    );
    if (canonical !== current) router.replace(canonical);
  }, [requestedBranchId, requestedOrganizationId, resolved, router]);

  if (access.isPending) return <p aria-live="polite">{t("loadingAccess")}</p>;
  if (access.isError)
    return (
      <p className="form-message" role="alert">
        {t("accessError")}
      </p>
    );
  if (resolved?.organization === null) {
    return (
      <section className="space-y-4">
        <h1 className="text-2xl font-semibold">
          {t("uiPurchaseOrdersUnavailable")}
        </h1>
        <p className="text-muted-foreground">
          {t("uiChooseAnActiveOrganizationFromTheWorkspaceFirst")}
        </p>
        <Link className="underline" href="/app">
          {t("uiReturnToWorkspace")}
        </Link>
      </section>
    );
  }
  if (resolved === null) return null;
  if (resolved.branch === null) {
    return (
      <section className="space-y-4">
        <h1 className="text-2xl font-semibold">
          {t("uiBranchContextRequired")}
        </h1>
        <p className="text-muted-foreground">
          {t("uiChooseAnActiveBranchBeforeManagingPurchaseOrders")}
        </p>
        <Link
          className="underline"
          href={applicationContextUrl(resolved.organization.id, null)}
        >
          {t("uiReturnToWorkspace")}
        </Link>
      </section>
    );
  }
  if (!MANAGEMENT_ROLES.has(resolved.organization.role)) {
    return (
      <section className="space-y-4">
        <Link
          className="text-sm underline"
          href={applicationContextUrl(
            resolved.organization.id,
            resolved.branch.id,
          )}
        >
          {t("backToWorkspace")}
        </Link>
        <h1 className="text-2xl font-semibold">{t("purchaseOrders")}</h1>
        <p className="form-message" role="alert">
          {t("uiYouDoNotHavePermissionToManagePurchaseOrders")}
        </p>
      </section>
    );
  }
  return (
    <PurchaseOrderContent
      branch={resolved.branch}
      organization={resolved.organization}
    />
  );
}

function PurchaseOrderContent({
  branch,
  organization,
}: {
  branch: AccessibleOrganization["branches"][number];
  organization: AccessibleOrganization;
}) {
  const { t } = useLanguage();

  const queryClient = useQueryClient();
  const context: PurchaseOrderRequestContext = {
    branchId: branch.id,
    organizationId: organization.id,
  };
  const catalogContext: CatalogRequestContext = {
    branchId: branch.id,
    organizationId: organization.id,
  };
  const scope = purchaseOrderScopeKey(context);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<TranslationKey | null>(null);
  const [status, setStatus] = useState<PurchaseOrderStatus | "all">("all");
  const [supplierId, setSupplierId] = useState("");
  const [orderDateFrom, setOrderDateFrom] = useState("");
  const [orderDateTo, setOrderDateTo] = useState("");

  const supplierQuery = useQuery({
    queryFn: () =>
      listSuppliers(organization.id, { limit: 100, status: "all" }),
    queryKey: [
      "organization-scoped",
      organization.id,
      "suppliers",
      "purchase-order-options",
    ],
  });
  const productQuery = useQuery({
    queryFn: () => listProducts(catalogContext, { limit: 100 }),
    queryKey: [
      "branch-scoped",
      organization.id,
      branch.id,
      "catalog",
      "purchase-order-options",
    ],
  });
  const orders = useInfiniteQuery<
    PurchaseOrderPage,
    Error,
    InfiniteData<PurchaseOrderPage>,
    readonly unknown[],
    string | null
  >({
    getNextPageParam: (page) => page.meta.nextCursor,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      listPurchaseOrders(context, {
        cursor: pageParam,
        ...(orderDateFrom === "" ? {} : { orderDateFrom }),
        ...(orderDateTo === "" ? {} : { orderDateTo }),
        status,
        ...(supplierId === "" ? {} : { supplierId }),
      }),
    queryKey: [
      ...scope,
      "list",
      { orderDateFrom, orderDateTo, status, supplierId },
    ],
  });
  const detailKey =
    selectedId === null ? null : [...scope, "detail", selectedId];
  const detail = useQuery({
    enabled: selectedId !== null,
    queryFn: () => getPurchaseOrder(context, selectedId as string),
    queryKey: detailKey ?? [...scope, "detail", "none"],
  });
  const suppliers = supplierQuery.data?.data.suppliers ?? [];
  const activeSuppliers = suppliers.filter(
    (supplier) => supplier.status === "ACTIVE",
  );
  const products = productQuery.data?.data.products ?? [];
  const records =
    orders.data?.pages.flatMap((page) => page.data.purchaseOrders) ?? [];
  const supplierNames = new Map(
    suppliers.map((supplier) => [supplier.id, supplier.name]),
  );

  const refresh = async () => {
    setNotice(null);
    await queryClient.invalidateQueries({ queryKey: scope });
  };
  const applyServerOrder = async (order: PurchaseOrder) => {
    setSelectedId(order.id);
    queryClient.setQueryData([...scope, "detail", order.id], order);
    await queryClient.invalidateQueries({ queryKey: [...scope, "list"] });
  };
  const handleError = (error: unknown, purchaseOrderId?: string) => {
    setNotice(errorMessage(error));
    if (
      error instanceof PurchaseOrderApiError &&
      error.kind === "stale" &&
      purchaseOrderId !== undefined
    ) {
      void queryClient.invalidateQueries({
        queryKey: [...scope, "detail", purchaseOrderId],
      });
      void queryClient.invalidateQueries({ queryKey: [...scope, "list"] });
    }
  };

  return (
    <section className="w-full min-w-0 space-y-6 [overflow-wrap:anywhere]">
      <header className="space-y-2">
        <Link
          className="text-sm underline"
          href={applicationContextUrl(organization.id, branch.id)}
        >
          {t("backToWorkspace")}
        </Link>
        <h1 className="text-2xl font-semibold">{t("purchaseOrders")}</h1>
        <p className="text-muted-foreground">
          {t("uiManageBranchOrdersFor")} {branch.name}
          {t("uiTotalsAreCalculatedByTheServerInTHB")}
        </p>
      </header>
      {notice ? (
        <p className="form-message" role="alert">
          {t(notice)}
        </p>
      ) : null}

      <PurchaseOrderForm
        activeSuppliers={activeSuppliers}
        label={t("uiCreateDraftPurchaseOrder")}
        onError={handleError}
        onSave={async (input) => {
          const order = await createPurchaseOrder(context, input);
          await applyServerOrder(order);
        }}
        products={products}
      />

      <div className="grid items-end gap-4 rounded-lg border bg-card p-4 sm:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_12rem_12rem_auto]">
        <Label className="form-field">
          {t("uiStatusFilter")}
          <NativeSelect
            className="w-full "
            onChange={(event) =>
              setStatus(event.target.value as PurchaseOrderStatus | "all")
            }
            value={status}
          >
            {STATUS_OPTIONS.map((value) => (
              <NativeSelectOption key={value} value={value}>
                {value === "all" ? t("uiAllStatuses") : statusLabel(value, t)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Label>
        <Label className="form-field">
          {t("uiSupplierFilter")}
          <NativeSelect
            className="w-full "
            onChange={(event) => setSupplierId(event.target.value)}
            value={supplierId}
          >
            <NativeSelectOption value="">
              {t("uiAllSuppliers")}
            </NativeSelectOption>
            {suppliers.map((supplier) => (
              <NativeSelectOption key={supplier.id} value={supplier.id}>
                {supplier.name}
                {supplier.status === "INACTIVE" ? t("uiInactiveSuffix") : ""}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Label>
        <Label className="form-field">
          {t("uiOrderDateFrom")}
          <DateInput
            className="form-control--date"
            onChange={(event) => setOrderDateFrom(event.target.value)}
            value={orderDateFrom}
          />
        </Label>
        <Label className="form-field">
          {t("uiOrderDateTo")}
          <DateInput
            className="form-control--date"
            onChange={(event) => setOrderDateTo(event.target.value)}
            value={orderDateTo}
          />
        </Label>
        <Button
          variant="outline"
          className="self-end"
          onClick={() => void refresh()}
          type="button"
        >
          {t("uiRefreshOrders")}
        </Button>
      </div>

      {orders.isPending ? (
        <p aria-live="polite">{t("uiLoadingPurchaseOrders")}</p>
      ) : null}
      {orders.isError ? (
        <p className="form-message" role="alert">
          {t(errorMessage(orders.error))}
        </p>
      ) : null}
      {!orders.isPending && !orders.isError && records.length === 0 ? (
        <p>{t("uiNoPurchaseOrdersMatchThisView")}</p>
      ) : null}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(18rem,0.8fr)_minmax(0,1.2fr)]">
        <div className="grid min-w-0 grid-cols-1 content-start gap-3">
          {records.map((order) => (
            <Button
              variant="outline"
              className="block h-auto w-full min-w-0 bg-card p-4 text-left whitespace-normal"
              key={order.id}
              onClick={() => setSelectedId(order.id)}
              type="button"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 break-words font-semibold">
                  {order.reference}
                </span>
                <StatusBadge status={order.status} />
              </div>
              <p className="mt-2 text-sm text-muted-foreground">
                {supplierNames.get(order.supplierId) ??
                  t("uiHistoricalSupplier")}{" "}
                · {order.orderDate}
              </p>
              <p className="mt-1 text-sm tabular-nums">
                {t("uiExpectedTotal")} {formatMoney(order.expectedTotal)} THB
              </p>
            </Button>
          ))}
          {orders.hasNextPage ? (
            <Button
              variant="outline"
              disabled={orders.isFetchingNextPage}
              onClick={() => void orders.fetchNextPage()}
              type="button"
            >
              {orders.isFetchingNextPage
                ? t("commonLoading")
                : t("uiLoadMoreOrders")}
            </Button>
          ) : null}
        </div>
        <div className="min-w-0">
          {selectedId === null ? (
            <p className="rounded-lg border p-5 text-muted-foreground">
              {t("uiSelectAPurchaseOrderToViewItsDetails")}
            </p>
          ) : null}
          {detail.isPending ? (
            <p aria-live="polite">{t("uiLoadingPurchaseOrder")}</p>
          ) : null}
          {detail.isError ? (
            <p className="form-message" role="alert">
              {t(errorMessage(detail.error))}
            </p>
          ) : null}
          {detail.data ? (
            <PurchaseOrderEditor
              activeSuppliers={activeSuppliers}
              allSuppliers={suppliers}
              onError={handleError}
              onSaved={applyServerOrder}
              order={detail.data}
              products={products}
              requestContext={context}
            />
          ) : null}
        </div>
      </div>
    </section>
  );
}

function PurchaseOrderForm({
  activeSuppliers,
  initialOrder = null,
  label,
  onError,
  onSave,
  products,
}: {
  activeSuppliers: Supplier[];
  initialOrder?: PurchaseOrder | null;
  label: string;
  onError: (error: unknown) => void;
  onSave: (input: DraftInput) => Promise<void>;
  products: CatalogProduct[];
}) {
  const { t } = useLanguage();

  const [input, setInput] = useState<DraftInput>(() =>
    draftFromOrder(initialOrder),
  );
  const [validation, setValidation] = useState<TranslationKey | null>(null);
  const mutation = useMutation({ mutationFn: onSave });
  const supplierId = useId();
  const orderDateId = useId();
  const expectedDateId = useId();
  const validationId = useId();

  useEffect(() => {
    setInput(draftFromOrder(initialOrder));
    setValidation(null);
  }, [initialOrder?.id, initialOrder?.updatedAt]);

  const productById = new Map(products.map((product) => [product.id, product]));
  const updateLine = (index: number, change: Partial<DraftLine>) => {
    setInput((current) => ({
      ...current,
      items: current.items.map((line, lineIndex) =>
        lineIndex === index ? { ...line, ...change } : line,
      ),
    }));
  };
  const addLine = () =>
    setInput((current) => ({
      ...current,
      items: [
        ...current.items,
        { expectedUnitCost: "", productId: "", quantity: "" },
      ],
    }));
  const removeLine = (index: number) =>
    setInput((current) => ({
      ...current,
      items: current.items.filter((_, lineIndex) => lineIndex !== index),
    }));
  const validate = (): TranslationKey | null => {
    if (input.supplierId === "") return "uiChooseAnActiveSupplier";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.orderDate))
      return "uiEnterAValidOrderDate";
    if (
      input.expectedDate !== null &&
      !/^\d{4}-\d{2}-\d{2}$/.test(input.expectedDate)
    )
      return "uiEnterAValidExpectedDate";
    if (input.items.length === 0) return "uiAddAtLeastOneProductLine";
    const seen = new Set<string>();
    for (const line of input.items) {
      if (line.productId === "") return "uiChooseAProductForEveryLine";
      if (seen.has(line.productId))
        return "uiEachProductMayAppearOnlyOnceEditTheExisting";
      seen.add(line.productId);
      if (!validQuantity(line.quantity, productById.get(line.productId)?.unit))
        return "uiEachQuantityMustBePositiveAndFollowItsProduct";
      if (!validCost(line.expectedUnitCost))
        return "uiEachExpectedUnitCostMustBeANonNegative";
    }
    return null;
  };
  const describedBy = validation === null ? undefined : validationId;

  return (
    <form
      aria-label={label}
      className="rounded-lg border bg-card p-5"
      onSubmit={(event) => {
        event.preventDefault();
        const message = validate();
        setValidation(message);
        if (message !== null) return;
        void mutation
          .mutateAsync(input)
          .then(() => {
            if (initialOrder === null) setInput(emptyDraft());
          })
          .catch((error: unknown) => onError(error));
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-semibold">{label}</h2>
        {initialOrder ? <StatusBadge status={initialOrder.status} /> : null}
      </div>
      {validation ? (
        <p className="mt-3 form-message" id={validationId} role="alert">
          {t(validation)}
        </p>
      ) : null}
      <div className="mt-4 grid min-w-0 items-start gap-4 sm:grid-cols-2">
        <Label className="form-field" htmlFor={supplierId}>
          {t("uiSupplier")}
          <NativeSelect
            aria-describedby={describedBy}
            aria-invalid={validation !== null}
            className="w-full "
            id={supplierId}
            onChange={(event) =>
              setInput((current) => ({
                ...current,
                supplierId: event.target.value,
              }))
            }
            value={input.supplierId}
          >
            <NativeSelectOption value="">
              {t("uiChooseAnActiveSupplier2")}
            </NativeSelectOption>
            {initialOrder !== null &&
            input.supplierId !== "" &&
            !activeSuppliers.some(
              (supplier) => supplier.id === input.supplierId,
            ) ? (
              <NativeSelectOption value={input.supplierId}>
                {t("uiHistoricalInactiveSupplier")}
              </NativeSelectOption>
            ) : null}
            {activeSuppliers.map((supplier) => (
              <NativeSelectOption key={supplier.id} value={supplier.id}>
                {supplier.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Label>
        <Label className="form-field" htmlFor={orderDateId}>
          {t("uiOrderDate")}
          <DateInput
            aria-describedby={describedBy}
            aria-invalid={validation !== null}
            className="form-control--date"
            id={orderDateId}
            onChange={(event) =>
              setInput((current) => ({
                ...current,
                orderDate: event.target.value,
              }))
            }
            value={input.orderDate}
          />
        </Label>
        <Label className="form-field" htmlFor={expectedDateId}>
          {t("uiExpectedDateOptional")}
          <DateInput
            aria-describedby={describedBy}
            aria-invalid={validation !== null}
            className="form-control--date"
            id={expectedDateId}
            onChange={(event) =>
              setInput((current) => ({
                ...current,
                expectedDate: event.target.value || null,
              }))
            }
            value={input.expectedDate ?? ""}
          />
        </Label>
      </div>
      <div className="mt-5 space-y-3">
        <h3 className="font-medium">{t("uiProductLines")}</h3>
        {input.items.map((line, index) => {
          const availableProducts = products.filter(
            (product) =>
              product.id === line.productId ||
              !input.items.some(
                (other, otherIndex) =>
                  otherIndex !== index && other.productId === product.id,
              ),
          );
          const selected = productById.get(line.productId);
          return (
            <fieldset
              className="grid min-w-0 grid-cols-1 gap-3 rounded-md border p-4 sm:grid-cols-2"
              key={`${line.productId}-${index}`}
            >
              <legend className="sr-only">
                {t("uiProductLine")} {index + 1}
              </legend>
              <Label className="form-field">
                {t("marketingProduct")}
                <NativeSelect
                  aria-describedby={describedBy}
                  aria-invalid={validation !== null}
                  aria-label={t("uiLineProduct").replace(
                    "{number}",
                    String(index + 1),
                  )}
                  className="w-full "
                  onChange={(event) =>
                    updateLine(index, { productId: event.target.value })
                  }
                  value={line.productId}
                >
                  <NativeSelectOption value="">
                    {t("uiChooseAProduct")}
                  </NativeSelectOption>
                  {line.productId !== "" && selected === undefined ? (
                    <NativeSelectOption value={line.productId}>
                      {t("uiHistoricalProduct")}
                    </NativeSelectOption>
                  ) : null}
                  {availableProducts.map((product) => (
                    <NativeSelectOption key={product.id} value={product.id}>
                      {product.name} · {product.sku} ({product.unit})
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Label>
              <Label className="form-field">
                {t("uiQuantity")}
                {selected ? ` (${selected.unit})` : ""}
                <Input
                  aria-describedby={describedBy}
                  aria-invalid={validation !== null}
                  aria-label={
                    t("uiLineQuantity").replace("{number}", String(index + 1)) +
                    (selected ? ` (${selected.unit})` : "")
                  }
                  className="form-control--numeric"
                  inputMode="decimal"
                  onChange={(event) =>
                    updateLine(index, { quantity: event.target.value })
                  }
                  value={line.quantity}
                />
              </Label>
              <Label className="form-field">
                {t("uiExpectedUnitCostTHB")}
                <Input
                  aria-describedby={describedBy}
                  aria-invalid={validation !== null}
                  aria-label={t("uiLineExpectedCost").replace(
                    "{number}",
                    String(index + 1),
                  )}
                  className="form-control--numeric"
                  inputMode="decimal"
                  onChange={(event) =>
                    updateLine(index, { expectedUnitCost: event.target.value })
                  }
                  value={line.expectedUnitCost}
                />
              </Label>
              <Button
                variant="outline"
                aria-label={t("uiRemoveLine").replace(
                  "{number}",
                  String(index + 1),
                )}
                className="self-end"
                disabled={input.items.length === 1}
                onClick={() => removeLine(index)}
                type="button"
              >
                {t("uiRemove")}
              </Button>
            </fieldset>
          );
        })}
        <Button
          variant="outline"
          disabled={input.items.length >= products.length}
          onClick={addLine}
          type="button"
        >
          {t("uiAddProductLine")}
        </Button>
      </div>
      {initialOrder ? (
        <p className="mt-4 text-sm text-muted-foreground">
          {t("uiServerCalculatedExpectedTotal")}{" "}
          {formatMoney(initialOrder.expectedTotal)} THB
        </p>
      ) : null}
      <Button
        aria-busy={mutation.isPending}
        className="mt-5"
        disabled={mutation.isPending}
        type="submit"
      >
        {mutation.isPending ? t("commonSaving") : label}
      </Button>
    </form>
  );
}

function PurchaseOrderEditor({
  activeSuppliers,
  allSuppliers,
  onError,
  onSaved,
  order,
  products,
  requestContext,
}: {
  activeSuppliers: Supplier[];
  allSuppliers: Supplier[];
  onError: (error: unknown, purchaseOrderId?: string) => void;
  onSaved: (order: PurchaseOrder) => Promise<void>;
  order: PurchaseOrder;
  products: CatalogProduct[];
  requestContext: PurchaseOrderRequestContext;
}) {
  const { t } = useLanguage();

  const [intent, setIntent] = useState<LifecycleIntent | null>(null);
  const update = useMutation({
    mutationFn: (input: DraftInput) =>
      updatePurchaseOrder(requestContext, order.id, {
        ...input,
        expectedUpdatedAt: order.updatedAt,
      }),
    onSuccess: onSaved,
  });
  const lifecycle = useMutation({
    mutationFn: (status: LifecycleIntent) =>
      transitionPurchaseOrder(requestContext, order, status),
    onSuccess: onSaved,
  });
  const supplierName =
    allSuppliers.find((supplier) => supplier.id === order.supplierId)?.name ??
    t("uiHistoricalSupplier");
  const pending = update.isPending || lifecycle.isPending;
  return (
    <article className="space-y-4 rounded-lg border bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 max-w-full">
          <h2 className="break-words font-semibold">{order.reference}</h2>
          <p className="text-sm text-muted-foreground">
            {t("uiSupplier2")} {supplierName} {t("uiExpectedTotal2")}{" "}
            {formatMoney(order.expectedTotal)} THB
          </p>
        </div>
        <StatusBadge status={order.status} />
      </div>
      {order.status === "DRAFT" ? (
        <>
          <PurchaseOrderForm
            activeSuppliers={activeSuppliers}
            initialOrder={order}
            label={t("uiSaveDraftChanges")}
            onError={(error) => onError(error, order.id)}
            onSave={(input) => update.mutateAsync(input).then(() => undefined)}
            products={products}
          />
          <p className="rounded-md border p-3 text-sm text-muted-foreground">
            {t("uiOrderingFreezesTheSupplierBranchDatesProductLinesQuantities")}
          </p>
          <div className="flex flex-wrap gap-3">
            <Button
              disabled={pending}
              onClick={() => setIntent("ORDERED")}
              type="button"
            >
              {t("uiOrderPurchaseOrder")}
            </Button>
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => setIntent("CANCELLED")}
              type="button"
            >
              {t("uiCancelPurchaseOrder")}
            </Button>
          </div>
        </>
      ) : (
        <ReadOnlyPurchaseOrder order={order} supplierName={supplierName} />
      )}
      <ReceivingPanel
        key={order.id}
        order={order}
        requestContext={requestContext}
        onReceived={onSaved}
      />
      {order.status === "ORDERED" ? (
        <Button
          variant="outline"
          disabled={pending}
          onClick={() => setIntent("CANCELLED")}
          type="button"
        >
          {t("uiCancelPurchaseOrder")}
        </Button>
      ) : null}
      <ConfirmationDialog
        action={intent}
        busy={lifecycle.isPending}
        onCancel={() => setIntent(null)}
        onConfirm={() => {
          if (intent === null) return;
          const action = intent;
          void lifecycle
            .mutateAsync(action)
            .then(() => setIntent(null))
            .catch((error: unknown) => onError(error, order.id));
        }}
      />
    </article>
  );
}

function ReceivingPanel({
  order,
  requestContext,
  onReceived,
}: {
  order: PurchaseOrder;
  requestContext: PurchaseOrderRequestContext;
  onReceived: (order: PurchaseOrder) => Promise<void>;
}) {
  const { t } = useLanguage();

  const queryClient = useQueryClient();
  const [costs, setCosts] = useState<Record<string, string>>(() =>
    Object.fromEntries(order.items.map((item) => [item.id, ""])),
  );
  const [vat, setVat] = useState({
    organizationVatRegistered: false,
    inputVatRate: "",
    inputVatAmount: "",
    supplierTaxDocumentNumber: "",
    supplierTaxDocumentDate: "",
  });
  const [confirm, setConfirm] = useState(false);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [error, setError] = useState<TranslationKey | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const validationId = useId();
  const cancel = useRef<HTMLButtonElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const valid = (value: string) => /^\d+(?:\.\d{1,4})?$/.test(value);
  const validRate = (value: string) => /^\d+(?:\.\d{1,6})?$/.test(value);
  const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);
  const complete = order.items.every((item) => valid(costs[item.id] ?? ""));
  const vatValid =
    (!vat.organizationVatRegistered &&
      vat.inputVatRate === "" &&
      vat.inputVatAmount === "" &&
      vat.supplierTaxDocumentNumber === "" &&
      vat.supplierTaxDocumentDate === "") ||
    (vat.organizationVatRegistered &&
      validRate(vat.inputVatRate) &&
      valid(vat.inputVatAmount) &&
      vat.supplierTaxDocumentNumber.trim() !== "" &&
      validDate(vat.supplierTaxDocumentDate));
  const validationMessage = !complete
    ? t("uiEnterOneNonNegativeActualUnitCostWithNo")
    : !vatValid
      ? t("uiWhenVATRegistrationIsAssertedEnterValidVATRate")
      : null;
  useEffect(() => {
    if (confirm) cancel.current?.focus();
  }, [confirm]);
  const submit = async () => {
    if (!complete || !vatValid || pending) return;
    const intentKey = key ?? crypto.randomUUID();
    setKey(intentKey);
    setPending(true);
    setError(null);
    try {
      const result = await receivePurchaseOrder(
        requestContext,
        order.id,
        {
          actualCosts: order.items.map((item) => ({
            purchaseOrderItemId: item.id,
            actualUnitCost: costs[item.id]!,
          })),
          vat: {
            organizationVatRegistered: vat.organizationVatRegistered,
            inputVatRate: vat.inputVatRate || null,
            inputVatAmount: vat.inputVatAmount || null,
            supplierTaxDocumentNumber: vat.supplierTaxDocumentNumber || null,
            supplierTaxDocumentDate: vat.supplierTaxDocumentDate || null,
          },
        },
        intentKey,
      );
      setReceipt(result);
      try {
        await onReceived(await getPurchaseOrder(requestContext, order.id));
      } catch {
        setError("uiReceiptCompletedButTheLatestPurchaseOrderStateCould");
        await queryClient.invalidateQueries({
          queryKey: [
            "branch-scoped",
            requestContext.organizationId,
            requestContext.branchId,
            "purchase-orders",
            "detail",
            order.id,
          ],
        });
        await queryClient.invalidateQueries({
          queryKey: [
            "branch-scoped",
            requestContext.organizationId,
            requestContext.branchId,
            "purchase-orders",
            "list",
          ],
        });
      }
      await queryClient.invalidateQueries({
        queryKey: [
          "branch-scoped",
          requestContext.organizationId,
          requestContext.branchId,
          "inventory",
        ],
      });
    } catch (e) {
      setError(receivingErrorMessage(e));
      if (e instanceof ReceivingApiError && e.kind === "state_conflict") {
        void queryClient.invalidateQueries({
          queryKey: [
            "branch-scoped",
            requestContext.organizationId,
            requestContext.branchId,
            "purchase-orders",
            "detail",
            order.id,
          ],
        });
      }
    } finally {
      setPending(false);
      setConfirm(false);
    }
  };
  if (receipt)
    return (
      <div
        className="rounded-md border border-border bg-muted p-4"
        role="status"
      >
        <h3 className="font-semibold">
          {t("uiReceipt")} {receipt.reference} {t("uiCompleted2")}
        </h3>
        <p className="text-sm">
          {t("uiReceivedAt")} {receipt.receivedAt}
          {t("uiThePurchaseOrderIsNowRECEIVED")}
        </p>
        {error ? (
          <p className="form-message" role="alert">
            {t(error)}
          </p>
        ) : null}
        {receipt.items.map((item) => (
          <p className="text-sm" key={item.id}>
            {item.productNameSnapshot}: {item.receivedQuantity} {t("uiAt")}{" "}
            {formatMoney(item.actualUnitCost)} THB
          </p>
        ))}
      </div>
    );
  if (order.status !== "ORDERED") return null;
  return (
    <div className="mt-4 space-y-4 rounded-md border border-dashed p-4">
      <h3 className="font-semibold">{t("uiReceiveFullPurchaseOrder")}</h3>
      <p className="text-sm text-muted-foreground">
        {t("uiFrozenSupplierBranchProductsAndQuantitiesWillBeReceived")}
      </p>
      {order.items.map((item) => (
        <fieldset
          className="grid min-w-0 gap-2 rounded border p-3 sm:grid-cols-3"
          key={item.id}
        >
          <legend className="max-w-full text-sm font-medium">
            {item.productNameSnapshot} · {item.productSkuSnapshot}
          </legend>
          <p className="text-sm">
            {t("uiQuantity2")} {item.quantity}
          </p>
          <p className="text-sm">
            {t("uiExpected")} {formatMoney(item.expectedUnitCost)} THB
          </p>
          <Label className="form-field">
            {t("uiActualUnitCostTHB")}
            <Input
              aria-label={t("uiActualCostFor").replace(
                "{name}",
                item.productNameSnapshot,
              )}
              aria-describedby={
                validationMessage === null ? undefined : validationId
              }
              aria-invalid={costs[item.id] !== "" && !valid(costs[item.id]!)}
              className="form-control--numeric"
              inputMode="decimal"
              value={costs[item.id]}
              onChange={(e) => {
                setCosts((c) => ({ ...c, [item.id]: e.target.value }));
                setKey(null);
              }}
            />
          </Label>
        </fieldset>
      ))}
      <Label className="flex min-h-11 items-center gap-2 text-sm">
        <Checkbox
          className=""
          aria-describedby={
            validationMessage === null ? undefined : validationId
          }

          checked={vat.organizationVatRegistered}
          onCheckedChange={(checked) => {
            setVat((v) => ({
              ...v,
              organizationVatRegistered: checked,
            }));
            setKey(null);
          }}
        />
        {t("uiOrganizationVATRegistrationAssertedForThisReceipt")}
      </Label>
      <div className="grid gap-3 sm:grid-cols-2">
        <Label className="form-field">
          {t("uiInputVATRate")}
          <Input
            aria-describedby={
              validationMessage === null ? undefined : validationId
            }
            aria-invalid={!vatValid}
            className="form-control--numeric"
            value={vat.inputVatRate}
            onChange={(e) => {
              setVat((v) => ({ ...v, inputVatRate: e.target.value }));
              setKey(null);
            }}
          />
        </Label>
        <Label className="form-field">
          {t("uiInputVATAmount")}
          <Input
            aria-describedby={
              validationMessage === null ? undefined : validationId
            }
            aria-invalid={!vatValid}
            className="form-control--numeric"
            value={vat.inputVatAmount}
            onChange={(e) => {
              setVat((v) => ({ ...v, inputVatAmount: e.target.value }));
              setKey(null);
            }}
          />
        </Label>
        <Label className="form-field">
          {t("uiSupplierTaxDocumentNumber")}
          <Input
            aria-describedby={
              validationMessage === null ? undefined : validationId
            }
            aria-invalid={!vatValid}
            className=""
            value={vat.supplierTaxDocumentNumber}
            onChange={(e) => {
              setVat((v) => ({
                ...v,
                supplierTaxDocumentNumber: e.target.value,
              }));
              setKey(null);
            }}
          />
        </Label>
        <Label className="form-field">
          {t("uiSupplierTaxDocumentDate")}
          <DateInput
            aria-describedby={
              validationMessage === null ? undefined : validationId
            }
            aria-invalid={!vatValid}
            className="form-control--date"
            value={vat.supplierTaxDocumentDate}
            onChange={(e) => {
              setVat((v) => ({
                ...v,
                supplierTaxDocumentDate: e.target.value,
              }));
              setKey(null);
            }}
          />
        </Label>
      </div>
      {validationMessage !== null ? (
        <p className="text-sm form-message" id={validationId} role="alert">
          {validationMessage}
        </p>
      ) : null}
      {error ? (
        <p className="form-message" role="alert">
          {t(error)}
        </p>
      ) : null}
      <Button
        disabled={!complete || !vatValid || pending}
        aria-busy={pending}
        onClick={() => setConfirm(true)}
        type="button"
      >
        {pending ? t("uiReceiving") : t("uiReceiveFullPurchaseOrder")}
      </Button>
      {confirm ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-describedby="receive-confirm-description"
          aria-labelledby="receive-confirm-title"
          className="fixed inset-0 z-50 grid overflow-y-auto bg-black/40 p-4"
          onKeyDown={(event) => {
            if (event.key === "Escape" && !pending) setConfirm(false);
            if (event.key === "Tab") {
              event.preventDefault();
              if (event.shiftKey) confirmButton.current?.focus();
              else cancel.current?.focus();
            }
          }}
        >
          <div className="my-auto w-full max-w-md justify-self-center rounded bg-card p-5">
            <h2 id="receive-confirm-title" className="font-semibold">
              {t("uiConfirmIrreversibleReceipt")}
            </h2>
            <p className="mt-2 text-sm" id="receive-confirm-description">
              {t("uiAllFrozenQuantitiesActualCostsAndVATSnapshotFields")}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <Button
                variant="outline"
                className=""
                disabled={pending}
                onClick={() => setConfirm(false)}
                ref={cancel}
                type="button"
              >
                {t("cancel")}
              </Button>
              <Button
                aria-busy={pending}
                className=""
                disabled={pending}
                onClick={() => void submit()}
                ref={confirmButton}
                type="button"
              >
                {pending ? t("uiReceiving") : t("uiConfirmReceive")}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ReadOnlyPurchaseOrder({
  order,
  supplierName,
}: {
  order: PurchaseOrder;
  supplierName: string;
}) {
  const { t } = useLanguage();

  return (
    <div className="space-y-4">
      <dl className="grid min-w-0 gap-3 text-sm sm:grid-cols-2 [&>div]:min-w-0">
        <div>
          <dt className="text-muted-foreground">{t("uiSupplier")}</dt>
          <dd>{supplierName}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t("uiOrderDate")}</dt>
          <dd>{order.orderDate}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t("uiExpectedDate")}</dt>
          <dd>{order.expectedDate ?? t("uiNotSet")}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t("uiExpectedTotal3")}</dt>
          <dd className="tabular-nums">
            {formatMoney(order.expectedTotal)} THB
          </dd>
        </div>
      </dl>
      <div className="space-y-2">
        <h3 className="font-medium">{t("uiFrozenProductLines")}</h3>
        {order.items.map((item) => (
          <div
            className="min-w-0 rounded-md border p-3 text-sm tabular-nums"
            key={item.id}
          >
            {item.productNameSnapshot} · {item.productSkuSnapshot}
            <br />
            {item.quantity} × {formatMoney(item.expectedUnitCost)} THB
          </div>
        ))}
      </div>
      <p className="text-sm text-muted-foreground">
        {t("uiCommercialFieldsAreReadOnlyIn")} {statusLabel(order.status, t)}{" "}
        {t("uiStatus")}
      </p>
    </div>
  );
}

function ConfirmationDialog({
  action,
  busy,
  onCancel,
  onConfirm,
}: {
  action: LifecycleIntent | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useLanguage();

  const cancel = useRef<HTMLButtonElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (action !== null) cancel.current?.focus();
  }, [action]);
  if (action === null) return null;
  const ordering = action === "ORDERED";
  return (
    <div
      aria-describedby="purchase-order-confirmation-description"
      aria-labelledby="purchase-order-confirmation-title"
      aria-modal="true"
      className="fixed inset-0 z-50 grid overflow-y-auto bg-black/40 p-4"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) onCancel();
        if (event.key === "Tab") {
          event.preventDefault();
          if (event.shiftKey) confirm.current?.focus();
          else cancel.current?.focus();
        }
      }}
      role="dialog"
    >
      <div className="my-auto w-full max-w-md justify-self-center rounded-lg bg-card p-5 shadow-lg">
        <h2
          className="text-lg font-semibold"
          id="purchase-order-confirmation-title"
        >
          {ordering
            ? t("uiOrderThisPurchaseOrder")
            : t("uiCancelThisPurchaseOrder")}
        </h2>
        <p
          className="mt-2 text-sm text-muted-foreground"
          id="purchase-order-confirmation-description"
        >
          {ordering
            ? t("uiOrderingFreezesAllCommercialFieldsReviewTheCurrentServer")
            : t("uiCancellationIsTerminalAndCannotBeUndone")}
        </p>
        <div className="mt-5 flex flex-wrap justify-end gap-3">
          <Button
            variant="outline"
            className=""
            disabled={busy}
            onClick={onCancel}
            ref={cancel}
            type="button"
          >
            {t("uiKeepEditing")}
          </Button>
          <Button
            aria-busy={busy}
            className=""
            disabled={busy}
            onClick={onConfirm}
            ref={confirm}
            type="button"
          >
            {busy
              ? t("commonSaving")
              : ordering
                ? t("uiConfirmOrder")
                : t("uiConfirmCancellation")}
          </Button>
        </div>
      </div>
    </div>
  );
}
