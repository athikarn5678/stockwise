"use client";
import type { TranslationKey } from "@/i18n/en";
import { useLanguage } from "@/providers/language-provider";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { OptionSelect } from "@/components/option-select";

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

import { PosBarcodeScanner } from "./pos-barcode-scanner";
import {
  PromptPayPanel,
  type PromptPayQr,
  renderPromptPayQrImage,
} from "./promptpay-panel";
import { SaleReceipt } from "./sale-receipt";

import { useSubscriptionWriteGate } from "@/providers/subscription-provider";

import { formatThb } from "@/money-display";
import {
  applicationContextUrl,
  resolveApplicationContext,
} from "@/application-context";
import {
  type AccessibleOrganization,
  fetchAccessContext,
} from "@/branch-api-client";
import {
  checkoutSale,
  getPaymentOptions,
  getSalesVatProfile,
  type CompletedSale,
  type PosProduct,
  type PosUnit,
  quotePromptPay,
  SalesApiError,
  type SalesApiErrorKind,
  type SalesRequestContext,
  searchPosProducts,
  type SalesVatProfile,
  updateSalesVatProfile,
} from "@/sales-api-client";

type PosRole = AccessibleOrganization["role"];
type PosPage = Awaited<ReturnType<typeof searchPosProducts>>;
type CartLine = Pick<
  PosProduct,
  "basePrice" | "id" | "name" | "sku" | "unit"
> & {
  quantity: string;
};
type DiscountType = "NONE" | "AMOUNT" | "PERCENT";
// POS offers Cash and PromptPay only. Historic Transfer sales keep displaying
// elsewhere; the API and stored sales are unchanged (PromptPay is stored as a
// TRANSFER with the "PromptPay" reference).
type PaymentMethod = "CASH" | "PROMPTPAY";

const CHECKOUT_ROLES = new Set<PosRole>([
  "OWNER",
  "ADMIN",
  "BRANCH_MANAGER",
  "CASHIER",
]);
const DISCOUNT_ROLES = new Set<PosRole>(["OWNER", "ADMIN", "BRANCH_MANAGER"]);
const INTEGER_UNITS = new Set<PosUnit>(["EA", "PACK", "BOX"]);
/** Checkout failures that make any already-displayed PromptPay QR stale. */
const STALE_PROMPTPAY_ERRORS = new Set<SalesApiErrorKind>([
  "insufficient_stock",
  "price_changed",
  "product_inactive",
  "total_mismatch",
]);

function posUrl(organizationId: string, branchId: string | null): string {
  const params = new URLSearchParams({ organizationId });
  if (branchId !== null) params.set("branchId", branchId);
  return `/app/pos?${params.toString()}`;
}

function posScopeKey(context: SalesRequestContext): readonly unknown[] {
  return ["branch-scoped", context.organizationId, context.branchId, "pos"];
}

function quantityIsValid(value: string, unit: PosUnit): boolean {
  if (!/^\d+(?:\.\d{1,4})?$/.test(value)) return false;
  const [whole = "0", fraction] = value.split(".");
  if (/^0+$/.test(whole) && (fraction === undefined || /^0+$/.test(fraction))) {
    return false;
  }
  return !(
    INTEGER_UNITS.has(unit) &&
    fraction !== undefined &&
    !/^0+$/.test(fraction)
  );
}

function decimalToScaled(value: string, scale: number): bigint | null {
  if (!/^\d+(?:\.\d+)?$/.test(value)) return null;
  const [whole = "0", fraction = ""] = value.split(".");
  if (fraction.length > scale) return null;
  return (
    BigInt(whole) * 10n ** BigInt(scale) +
    BigInt((fraction + "0".repeat(scale)).slice(0, scale))
  );
}

function displayScaled(value: bigint, scale: number): string {
  const divisor = 10n ** BigInt(scale);
  const whole = value / divisor;
  const fraction = (value % divisor).toString().padStart(scale, "0");
  return scale === 0 ? whole.toString() : `${whole}.${fraction}`;
}

function trimQuantity(value: string): string {
  return value.includes(".") ? value.replace(/\.?0+$/, "") : value;
}

function addOne(quantity: string): string {
  const scaled = decimalToScaled(quantity, 4);
  if (scaled === null) return quantity;
  return displayScaled(scaled + 10_000n, 4).replace(/\.0+$/, "");
}

function subtractOne(quantity: string): string | null {
  const scaled = decimalToScaled(quantity, 4);
  if (scaled === null || scaled <= 10_000n) return null;
  return displayScaled(scaled - 10_000n, 4).replace(/\.0+$/, "");
}

function estimatedSubtotal(lines: CartLine[]): string | null {
  let total = 0n;
  for (const line of lines) {
    const price = decimalToScaled(line.basePrice, 4);
    const quantity = decimalToScaled(line.quantity, 4);
    if (price === null || quantity === null) return null;
    total += price * quantity;
  }
  // Convert exact 8-place extensions to THB cents with ROUND_HALF_UP.
  return displayScaled((total + 500_000n) / 1_000_000n, 2);
}

function lineEstimate(line: CartLine): string | null {
  return estimatedSubtotal([line]);
}

function createIdempotencyKey(): string {
  if (typeof crypto?.randomUUID !== "function") {
    throw new SalesApiError("unavailable");
  }
  return crypto.randomUUID();
}

function errorMessage(error: unknown): TranslationKey {
  if (!(error instanceof SalesApiError)) {
    return "uiCheckoutIsTemporarilyUnavailableYourCartWasKeptUnchanged";
  }
  const messages: Record<SalesApiErrorKind, TranslationKey> = {
    authentication_required: "branchErrAuth",
    branch_inactive: "uiThisBranchIsInactiveChooseAnotherActiveBranch",
    forbidden: "uiCheckoutIsNotAvailableForYourCurrentAccess",
    idempotency_conflict:
      "uiThisCheckoutKeyRepresentsDifferentSaleDetailsReviewThe",
    insufficient_stock: "uiStockIsNoLongerSufficientForThisCartAdjust",
    invalid_cursor: "uiTheProductResultsChangedSearchAgain",
    price_changed: "uiAProductPriceChangedTheLatestProductPricesWere",
    product_inactive: "uiAProductInThisCartIsInactiveRemoveIt",
    product_not_found: "uiAProductInThisCartNoLongerExistsRemove",
    promptpay_not_configured: "uiPromptPayIsNotAvailableChooseCashOrTransfer",
    sale_not_found:
      "uiCheckoutIsTemporarilyUnavailableYourCartWasKeptUnchanged",
    sale_already_fully_refunded:
      "uiCheckoutIsTemporarilyUnavailableYourCartWasKeptUnchanged",
    refund_quantity_exceeded:
      "uiCheckoutIsTemporarilyUnavailableYourCartWasKeptUnchanged",
    stale_vat_profile: "uiTheVATProfileChangedRefreshTheLatestVATSettings",
    total_mismatch: "uiTheTotalChangedGenerateANewPromptPayQr",
    unavailable: "uiCheckoutIsTemporarilyUnavailableYourCartWasKeptUnchanged",
    validation: "uiCheckTheCartDiscountAndPaymentDetailsBeforeTrying",
    vat_configuration_required:
      "uiCheckoutIsBlockedUntilTheOrganizationSalesVATProfile",
  };
  return messages[error.kind];
}

export function PosManagement() {
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
    const canonical = posUrl(
      resolved.organization.id,
      resolved.branch?.id ?? null,
    );
    const current = posUrl(requestedOrganizationId ?? "", requestedBranchId);
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
        heading={t("uiPOSUnavailable")}
        message={t(
          "uiChooseAnActiveOrganizationFromTheWorkspaceBeforeStarting",
        )}
      />
    );
  }
  if (resolved === null) return null;
  if (resolved.branch === null) {
    return (
      <ContextUnavailable
        heading={t("uiBranchContextRequired")}
        message={t("uiChooseAnActiveBranchBeforeStartingASale")}
      />
    );
  }
  if (!CHECKOUT_ROLES.has(resolved.organization.role)) {
    return (
      <ContextUnavailable
        heading={t("uiPOSUnavailable")}
        message={t("uiYourCurrentRoleCannotPerformCheckout")}
      />
    );
  }
  return (
    <PosContent
      key={`${resolved.organization.id}:${resolved.branch.id}`}
      branch={resolved.branch}
      organization={resolved.organization}
    />
  );
}

function ContextUnavailable({
  heading,
  message,
}: {
  heading: string;
  message: string;
}) {
  const { t } = useLanguage();

  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-semibold">{heading}</h1>
      <p className="text-muted-foreground">{message}</p>
      <Link className="underline" href="/app">
        {t("uiReturnToWorkspace")}
      </Link>
    </section>
  );
}

function PosContent({
  branch,
  organization,
}: {
  branch: AccessibleOrganization["branches"][number];
  organization: AccessibleOrganization;
}) {
  const { t } = useLanguage();
  const { writeBlocked } = useSubscriptionWriteGate();

  const queryClient = useQueryClient();
  const context = {
    branchId: branch.id,
    organizationId: organization.id,
  } satisfies SalesRequestContext;
  const scopeKey = posScopeKey(context);
  const canDiscount = DISCOUNT_ROLES.has(organization.role);
  const canConfigureVat =
    organization.role === "OWNER" || organization.role === "ADMIN";
  const [search, setSearch] = useState({ q: "" });
  const [cart, setCart] = useState<CartLine[]>([]);
  const [discountType, setDiscountType] = useState<DiscountType>("NONE");
  const [discountValue, setDiscountValue] = useState("");
  const [discountReason, setDiscountReason] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("CASH");
  const [amountTendered, setAmountTendered] = useState("");
  const [notice, setNotice] = useState<TranslationKey | null>(null);
  const [promptPayQr, setPromptPayQr] = useState<PromptPayQr | null>(null);
  const [promptPayError, setPromptPayError] = useState<TranslationKey | null>(
    null,
  );
  const [intentVersion, setIntentVersion] = useState(0);
  const [completedSale, setCompletedSale] = useState<CompletedSale | null>(
    null,
  );
  const keyRef = useRef<string | null>(null);
  // Guards a PromptPay quote that resolves after the cart already changed.
  const intentVersionRef = useRef(0);
  const checkoutPendingRef = useRef(false);
  const scansPendingRef = useRef(0);
  const [scansPending, setScansPending] = useState(0);

  const vatProfileQuery = useQuery({
    enabled: canConfigureVat,
    queryFn: () => getSalesVatProfile(organization.id),
    queryKey: ["organization-scoped", organization.id, "sales-vat-profile"],
  });
  const productsQuery = useInfiniteQuery<
    PosPage,
    Error,
    InfiniteData<PosPage>,
    readonly unknown[],
    string | null
  >({
    getNextPageParam: (page) => page.meta.nextCursor,
    initialPageParam: null,
    queryFn: ({ pageParam }) =>
      searchPosProducts(context, { ...search, cursor: pageParam }),
    queryKey: [...scopeKey, "products", search],
  });
  const products =
    productsQuery.data?.pages.flatMap((page) => page.data.products) ?? [];
  const subtotal = estimatedSubtotal(cart);
  const paymentOptionsQuery = useQuery({
    queryFn: () => getPaymentOptions(context),
    queryKey: [...scopeKey, "payment-options"],
    staleTime: 60_000,
  });
  // While the options are loading or failed, PromptPay stays unavailable.
  const promptPayAvailable = paymentOptionsQuery.data?.promptPay === true;
  const vatBlocked =
    canConfigureVat && vatProfileQuery.data?.salesVatStatus === "UNCONFIGURED";

  useEffect(() => {
    if (promptPayAvailable || paymentMethod !== "PROMPTPAY") return;
    setPaymentMethod("CASH");
    setPromptPayQr(null);
    setPromptPayError(null);
  }, [paymentMethod, promptPayAvailable]);

  const resetPromptPay = () => {
    intentVersionRef.current += 1;
    setPromptPayQr(null);
    setPromptPayError(null);
    setIntentVersion(intentVersionRef.current);
  };
  const changeIntent = () => {
    keyRef.current = null;
    setNotice(null);
    resetPromptPay();
  };

  /** The exact cart and discount every checkout and quote request sends. */
  const buildIntent = () => {
    if (cart.length === 0 || subtotal === null)
      throw new SalesApiError("validation");
    for (const line of cart) {
      if (!quantityIsValid(line.quantity, line.unit))
        throw new SalesApiError("validation");
    }
    const discount = buildDiscount(
      discountType,
      discountValue,
      discountReason,
      canDiscount,
    );
    if (discount === "invalid") throw new SalesApiError("validation");
    return {
      discount,
      items: cart.map((line) => ({
        expectedUnitPrice: line.basePrice,
        productId: line.id,
        quantity: line.quantity,
      })),
    };
  };
  const startCheckout = () => {
    if (checkoutPendingRef.current || scansPendingRef.current > 0) return;
    checkoutPendingRef.current = true;
    void checkoutMutation
      .mutateAsync()
      .catch(() => undefined)
      .finally(() => {
        checkoutPendingRef.current = false;
      });
  };
  const addProduct = (product: PosProduct) => {
    if (!product.available || checkoutPendingRef.current) return;
    changeIntent();
    setCart((current) => {
      const existing = current.find((line) => line.id === product.id);
      if (existing === undefined) {
        return [...current, { ...product, quantity: "1" }];
      }
      return current.map((line) =>
        line.id === product.id
          ? { ...line, quantity: addOne(line.quantity) }
          : line,
      );
    });
  };

  const checkoutMutation = useMutation({
    mutationFn: async () => {
      const intent = buildIntent();
      const payment = buildPayment(
        paymentMethod,
        amountTendered,
        promptPayQr?.amount ?? null,
      );
      if (payment === "invalid") throw new SalesApiError("validation");
      keyRef.current ??= createIdempotencyKey();
      return checkoutSale(context, keyRef.current, { ...intent, payment });
    },
    onError: async (error) => {
      if (error instanceof SalesApiError && error.kind === "price_changed") {
        await queryClient.invalidateQueries({
          queryKey: [...scopeKey, "products"],
        });
      }
      if (
        error instanceof SalesApiError &&
        STALE_PROMPTPAY_ERRORS.has(error.kind)
      ) {
        resetPromptPay();
      }
      if (
        error instanceof SalesApiError &&
        error.kind === "vat_configuration_required"
      ) {
        await queryClient.invalidateQueries({
          queryKey: [
            "organization-scoped",
            organization.id,
            "sales-vat-profile",
          ],
        });
      }
      setNotice(errorMessage(error));
    },
    onSuccess: (sale) => {
      setCompletedSale(sale);
      setNotice(null);
      resetPromptPay();
      void queryClient.invalidateQueries({
        queryKey: [...scopeKey, "products"],
      });
      void queryClient.invalidateQueries({
        queryKey: ["branch-scoped", organization.id, branch.id, "inventory"],
      });
    },
  });

  const quoteMutation = useMutation({
    mutationFn: async (version: number): Promise<PromptPayQr | null> => {
      const intent = buildIntent();
      const quote = await quotePromptPay(context, intent);
      const svg = await renderPromptPayQrImage(quote.payload);
      // A cart change while the request was in flight makes this answer stale.
      if (version !== intentVersionRef.current) return null;
      return { amount: quote.amount, svg };
    },
    onError: (error, version) => {
      // A failure for a cart that has since changed says nothing about the current one.
      if (version !== intentVersionRef.current) return;
      setPromptPayQr(null);
      setPromptPayError(errorMessage(error));
      if (error instanceof SalesApiError && error.kind === "price_changed") {
        void queryClient.invalidateQueries({
          queryKey: [...scopeKey, "products"],
        });
      }
    },
    onSuccess: (qr) => {
      if (qr === null) return;
      setPromptPayQr(qr);
      setPromptPayError(null);
    },
  });

  if (completedSale !== null) {
    return (
      <SaleComplete
        onNewSale={() => {
          keyRef.current = null;
          setCart([]);
          setDiscountType("NONE");
          setDiscountValue("");
          setDiscountReason("");
          setPaymentMethod("CASH");
          setAmountTendered("");
          setPromptPayQr(null);
          setPromptPayError(null);
          setCompletedSale(null);
        }}
        sale={completedSale}
      />
    );
  }

  return (
    <section className="w-full space-y-6">
      <header className="space-y-2">
        <Link
          className="text-sm underline"
          href={applicationContextUrl(organization.id, branch.id)}
        >
          {t("backToWorkspace")}
        </Link>
        <h1 className="text-2xl font-semibold">{t("marketingFeaturePos")}</h1>
        <p className="text-muted-foreground">
          {branch.code} — {branch.name}
          {t("uiProductPricesAndFinalTotalsAreConfirmedByCheckout")}
        </p>
      </header>

      {canConfigureVat ? (
        <VatProfilePanel
          error={vatProfileQuery.error}
          isLoading={vatProfileQuery.isPending}
          onSaved={() => void vatProfileQuery.refetch()}
          profile={vatProfileQuery.data}
          organizationId={organization.id}
        />
      ) : null}
      {canConfigureVat &&
      vatProfileQuery.data?.salesVatStatus === "UNCONFIGURED" ? (
        <p
          className="rounded-md border border-destructive p-4 form-message"
          role="alert"
        >
          {t("uiCheckoutIsBlockedUntilTheOrganizationSalesVATProfile")}
        </p>
      ) : null}
      {notice ? (
        <p className="rounded-md border p-4 form-message" role="alert">
          {t(notice)}
        </p>
      ) : null}

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(22rem,0.8fr)]">
        <section aria-labelledby="pos-product-heading" className="space-y-4">
          <h2 className="text-xl font-semibold" id="pos-product-heading">
            {t("uiProducts")}
          </h2>
          <PosBarcodeScanner
            context={context}
            disabled={checkoutMutation.isPending}
            onAdd={addProduct}
            onPendingChange={(count) => {
              scansPendingRef.current = count;
              setScansPending(count);
            }}
          />
          <form
            aria-label={t("uiSearchPOSProducts")}
            className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]"
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              setSearch({
                q: String(data.get("q") ?? ""),
              });
            }}
          >
            <Label className="form-field">
              {t("uiSearchProducts")}
              <Input
                className=""
                defaultValue={search.q}
                name="q"
                placeholder={t("uiNameOrSKU")}
              />
            </Label>
            <Button className="self-end" type="submit">
              {t("uiSearch")}
            </Button>
          </form>
          <ProductResults
            error={productsQuery.error}
            hasNextPage={productsQuery.hasNextPage}
            isLoading={productsQuery.isPending}
            isLoadingNext={productsQuery.isFetchingNextPage}
            onAdd={addProduct}
            onLoadMore={() => void productsQuery.fetchNextPage()}
            products={products}
          />
        </section>

        <aside
          aria-labelledby="pos-cart-heading"
          className="space-y-5 rounded-lg border bg-card p-4 sm:p-5 lg:sticky lg:top-4"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold" id="pos-cart-heading">
                {t("uiCurrentSale")}
              </h2>
              <p className="text-sm text-muted-foreground">
                {t("uiTransientCartOnlyStockIsConfirmedAtCheckout")}
              </p>
            </div>
            <Button
              variant="outline"
              disabled={cart.length === 0 || checkoutMutation.isPending}
              onClick={() => {
                changeIntent();
                setCart([]);
              }}
              type="button"
            >
              {t("uiClearCart")}
            </Button>
          </div>
          <fieldset
            className="m-0 min-w-0 space-y-5 border-0 p-0"
            disabled={checkoutMutation.isPending}
          >
            <CartLines
              lines={cart}
              onChangeQuantity={(productId, quantity) => {
                changeIntent();
                setCart((current) =>
                  current.map((line) =>
                    line.id === productId ? { ...line, quantity } : line,
                  ),
                );
              }}
              onDecrement={(productId) => {
                changeIntent();
                setCart((current) =>
                  current.flatMap((line) => {
                    if (line.id !== productId) return [line];
                    const quantity = subtractOne(line.quantity);
                    return quantity === null ? [] : [{ ...line, quantity }];
                  }),
                );
              }}
              onIncrement={(productId) => {
                changeIntent();
                setCart((current) =>
                  current.map((line) =>
                    line.id === productId
                      ? { ...line, quantity: addOne(line.quantity) }
                      : line,
                  ),
                );
              }}
              onRemove={(productId) => {
                changeIntent();
                setCart((current) =>
                  current.filter((line) => line.id !== productId),
                );
              }}
            />
            <div className="flex items-center justify-between border-t pt-4">
              <span className="font-medium">{t("uiCurrentPriceSubtotal")}</span>
              <strong>
                {subtotal === null
                  ? t("uiCheckQuantities")
                  : formatThb(subtotal)}
              </strong>
            </div>
            <p className="text-xs text-muted-foreground">
              {t("uiThisExactDecimalEstimateIsNotAFinalTotal")}
            </p>
            {canDiscount ? (
              <DiscountControls
                onChange={(type, value, reason) => {
                  changeIntent();
                  setDiscountType(type);
                  setDiscountValue(value);
                  setDiscountReason(reason);
                }}
                reason={discountReason}
                type={discountType}
                value={discountValue}
              />
            ) : null}
            <PaymentControls
              amountTendered={amountTendered}
              onChange={(method, tendered) => {
                changeIntent();
                setPaymentMethod(method);
                setAmountTendered(tendered);
              }}
              promptPayAvailable={promptPayAvailable}
              subtotal={subtotal}
              method={paymentMethod}
            />
            {paymentMethod === "PROMPTPAY" ? (
              <PromptPayPanel
                canConfirm={
                  promptPayQr !== null &&
                  !checkoutMutation.isPending &&
                  scansPending === 0 &&
                  !vatBlocked
                }
                canGenerate={cart.length > 0}
                error={promptPayError}
                isConfirming={checkoutMutation.isPending}
                isGenerating={quoteMutation.isPending}
                onConfirm={() => {
                  if (promptPayQr === null) return;
                  startCheckout();
                }}
                onGenerate={() => {
                  if (quoteMutation.isPending) return;
                  void quoteMutation
                    .mutateAsync(intentVersionRef.current)
                    .catch(() => undefined);
                }}
                qr={promptPayQr}
                resetToken={intentVersion}
              />
            ) : (
              <form
                aria-label={t("uiCheckoutCurrentSale")}
                onSubmit={(event) => {
                  event.preventDefault();
                  startCheckout();
                }}
              >
                <Button
                  aria-busy={checkoutMutation.isPending}
                  disabled={
                    cart.length === 0 ||
                    checkoutMutation.isPending ||
                    scansPending > 0 ||
                    vatBlocked ||
                    writeBlocked
                  }
                  type="submit"
                >
                  {checkoutMutation.isPending
                    ? t("uiCompletingSale")
                    : t("uiCompleteSale")}
                </Button>
              </form>
            )}
          </fieldset>
        </aside>
      </div>
    </section>
  );
}

function ProductResults({
  error,
  hasNextPage,
  isLoading,
  isLoadingNext,
  onAdd,
  onLoadMore,
  products,
}: {
  error: Error | null;
  hasNextPage: boolean;
  isLoading: boolean;
  isLoadingNext: boolean;
  onAdd: (product: PosProduct) => void;
  onLoadMore: () => void;
  products: PosProduct[];
}) {
  const { t } = useLanguage();
  if (isLoading)
    return <p aria-live="polite">{t("uiLoadingSellableProducts")}</p>;
  if (error)
    return (
      <p className="form-message" role="alert">
        {t(errorMessage(error))}
      </p>
    );
  if (products.length === 0)
    return (
      <p className="rounded-lg border p-5 text-muted-foreground">
        {t("uiNoProductsMatchThisPOSSearch")}
      </p>
    );
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        {products.map((product) => (
          <article className="rounded-lg border bg-card p-4" key={product.id}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="font-semibold">{product.name}</h3>
                <p className="text-sm text-muted-foreground">
                  {product.sku} · {product.unit}
                </p>
              </div>
              <span className="rounded-full border px-2 py-1 text-xs">
                {product.available ? t("posAvailable") : t("posUnavailable")}
              </span>
            </div>
            <p className="mt-3 text-sm text-muted-foreground">
              {t("posInStock")}{" "}
              <span className="font-medium text-foreground">
                {trimQuantity(product.availableQuantity)} {product.unit}
              </span>
            </p>
            <p className="mt-4 font-medium">{formatThb(product.basePrice)}</p>
            <Button
              className="mt-4 w-full"
              disabled={!product.available}
              onClick={() => onAdd(product)}
              type="button"
            >
              {product.available
                ? t("uiAddProductName").replace("{name}", product.name)
                : t("posUnavailable")}
            </Button>
          </article>
        ))}
      </div>
      {hasNextPage ? (
        <Button
          variant="outline"
          disabled={isLoadingNext}
          onClick={onLoadMore}
          type="button"
        >
          {isLoadingNext ? t("inventoryLoadingMore") : t("inventoryLoadMore")}
        </Button>
      ) : null}
    </div>
  );
}

function CartLines({
  lines,
  onChangeQuantity,
  onDecrement,
  onIncrement,
  onRemove,
}: {
  lines: CartLine[];
  onChangeQuantity: (productId: string, quantity: string) => void;
  onDecrement: (productId: string) => void;
  onIncrement: (productId: string) => void;
  onRemove: (productId: string) => void;
}) {
  const { t } = useLanguage();

  if (lines.length === 0)
    return (
      <p className="rounded-md border p-4 text-sm text-muted-foreground">
        {t("uiAddAnAvailableProductToBeginASale")}
      </p>
    );
  return (
    <ul aria-label={t("uiCartItems")} className="space-y-4">
      {lines.map((line) => {
        const estimate = lineEstimate(line);
        const valid = quantityIsValid(line.quantity, line.unit);
        return (
          <li className="space-y-3 border-b pb-4 last:border-0" key={line.id}>
            <div className="flex justify-between gap-3">
              <div>
                <h3 className="font-medium">{line.name}</h3>
                <p className="text-sm text-muted-foreground">
                  {line.sku} · {formatThb(line.basePrice)} / {line.unit}
                </p>
              </div>
              <strong>
                {estimate === null ? t("uiCheckQuantity") : formatThb(estimate)}
              </strong>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                aria-label={t("uiDecreaseQuantity").replace(
                  "{name}",
                  line.name,
                )}
                onClick={() => onDecrement(line.id)}
                type="button"
              >
                −
              </Button>
              <Input
                aria-invalid={!valid}
                aria-label={`${t("uiQuantityFor")} ${line.name} (${line.unit})`}
                className="form-control--numeric w-20 min-w-0 text-center"
                inputMode="decimal"
                onChange={(event) =>
                  onChangeQuantity(line.id, event.target.value)
                }
                value={line.quantity}
              />
              <span
                aria-hidden="true"
                className="text-sm text-muted-foreground"
              >
                {line.unit}
              </span>
              <Button
                variant="outline"
                aria-label={t("uiIncreaseQuantity").replace(
                  "{name}",
                  line.name,
                )}
                onClick={() => onIncrement(line.id)}
                type="button"
              >
                +
              </Button>
              <Button
                className="ml-auto"
                variant="outline"
                aria-label={t("uiRemoveFromCart").replace("{name}", line.name)}
                onClick={() => onRemove(line.id)}
                type="button"
              >
                {t("uiRemove")}
              </Button>
            </div>
            {!valid ? (
              <p className="text-sm text-destructive form-message" role="alert">
                {t("uiEnterAPositiveQuantityWithNoMoreThanFour")}
              </p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function DiscountControls({
  onChange,
  reason,
  type,
  value,
}: {
  onChange: (type: DiscountType, value: string, reason: string) => void;
  reason: string;
  type: DiscountType;
  value: string;
}) {
  const { t } = useLanguage();

  return (
    <fieldset className="space-y-3 border-t pt-4">
      <legend className="font-medium">{t("uiWholeSaleDiscount")}</legend>
      <Label className="form-field">
        {t("uiDiscountType")}
        <OptionSelect
          className="w-full "
          onValueChange={(nextType) =>
            onChange(nextType as DiscountType, value, reason)
          }
          options={[
            { label: t("uiNoDiscount"), value: "NONE" },
            { label: t("uiAmountTHB"), value: "AMOUNT" },
            { label: t("uiPercent"), value: "PERCENT" },
          ]}
          value={type}
        />
      </Label>
      {type !== "NONE" ? (
        <>
          <Label className="form-field">
            {type === "AMOUNT"
              ? t("uiDiscountAmountTHB")
              : t("uiDiscountPercent")}
            <Input
              className="form-control--numeric"
              inputMode="decimal"
              onChange={(event) => onChange(type, event.target.value, reason)}
              value={value}
            />
          </Label>
          <Label className="form-field">
            {t("uiDiscountReason")}
            <Input
              className=""
              onChange={(event) => onChange(type, value, event.target.value)}
              value={reason}
            />
          </Label>
        </>
      ) : null}
    </fieldset>
  );
}

function PaymentControls({
  amountTendered,
  method,
  onChange,
  promptPayAvailable,
  subtotal,
}: {
  amountTendered: string;
  method: PaymentMethod;
  onChange: (method: PaymentMethod, tendered: string) => void;
  promptPayAvailable: boolean;
  subtotal: string | null;
}) {
  const { t } = useLanguage();

  const tendered = decimalToScaled(amountTendered, 2);
  const subtotalCents = subtotal === null ? null : decimalToScaled(subtotal, 2);
  const change =
    tendered !== null && subtotalCents !== null && tendered >= subtotalCents
      ? displayScaled(tendered - subtotalCents, 2)
      : null;
  return (
    <fieldset className="space-y-3 border-t pt-4">
      <legend className="font-medium">{t("uiPayment")}</legend>
      <div className="flex flex-wrap gap-4">
        <Label className="flex min-h-11 items-center gap-2 text-sm font-medium">
          <Input
            className=""
            checked={method === "CASH"}
            name="payment-method"
            onChange={() => onChange("CASH", amountTendered)}
            type="radio"
            value="CASH"
          />
          {t("paymentCash")}
        </Label>
        {promptPayAvailable ? (
          <Label className="flex min-h-11 items-center gap-2 text-sm font-medium">
            <Input
              className=""
              checked={method === "PROMPTPAY"}
              name="payment-method"
              onChange={() => onChange("PROMPTPAY", amountTendered)}
              type="radio"
              value="PROMPTPAY"
            />
            {t("paymentPromptPay")}
          </Label>
        ) : null}
      </div>
      {method === "CASH" ? (
        <>
          <Label className="form-field">
            {t("uiAmountTenderedTHB")}
            <Input
              className="form-control--numeric"
              inputMode="decimal"
              onChange={(event) => onChange("CASH", event.target.value)}
              required
              value={amountTendered}
            />
          </Label>
          <p className="text-sm text-muted-foreground">
            {change === null
              ? t("uiEnterTenderedCashAtOrAboveTheCurrentPrice")
              : t("uiEstimatedChange").replace("{amount}", formatThb(change))}
          </p>
        </>
      ) : null}
    </fieldset>
  );
}

function buildDiscount(
  type: DiscountType,
  value: string,
  reason: string,
  allowed: boolean,
) {
  if (type === "NONE") return null;
  const scale = type === "AMOUNT" ? 2 : 4;
  const decimal = decimalToScaled(value, scale);
  if (!allowed || decimal === null || decimal === 0n || reason.trim() === "")
    return "invalid" as const;
  return type === "AMOUNT"
    ? { amount: value, reason: reason.trim(), type }
    : { percent: value, reason: reason.trim(), type };
}

function buildPayment(
  method: PaymentMethod,
  tendered: string,
  promptPayAmount: string | null,
) {
  if (method === "PROMPTPAY") {
    // Only the server amount is ever sent; the browser never computes it.
    return promptPayAmount === null
      ? ("invalid" as const)
      : ({
          expectedTotalAmount: promptPayAmount,
          method: "TRANSFER",
          reference: "PromptPay",
        } as const);
  }
  const amount = decimalToScaled(tendered, 2);
  return amount === null || amount <= 0n
    ? ("invalid" as const)
    : ({ amountTendered: tendered, method } as const);
}

function VatProfilePanel({
  error,
  isLoading,
  onSaved,
  organizationId,
  profile,
}: {
  error: Error | null;
  isLoading: boolean;
  onSaved: () => void;
  organizationId: string;
  profile: SalesVatProfile | undefined;
}) {
  const { t } = useLanguage();
  const { writeBlocked } = useSubscriptionWriteGate();

  const [status, setStatus] =
    useState<SalesVatProfile["salesVatStatus"]>("NOT_REGISTERED");
  const [rate, setRate] = useState("");
  const [notice, setNotice] = useState<TranslationKey | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const mutation = useMutation({
    mutationFn: (input: {
      expectedUpdatedAt: string;
      salesVatRate: string | null;
      salesVatStatus: SalesVatProfile["salesVatStatus"];
    }) => updateSalesVatProfile(organizationId, input),
    onError: (cause) => {
      setJustSaved(false);
      setNotice(errorMessage(cause));
    },
    onSuccess: () => {
      setNotice(null);
      setJustSaved(true);
      onSaved();
    },
  });
  // The form always starts from, and falls back to, the saved profile: leaving
  // the page without saving never changes the stored value.
  useEffect(() => {
    if (profile) {
      setStatus(
        profile.salesVatStatus === "UNCONFIGURED"
          ? "NOT_REGISTERED"
          : profile.salesVatStatus,
      );
      setRate(profile.salesVatRate ?? "");
    }
  }, [profile]);
  if (isLoading)
    return <p aria-live="polite">{t("uiLoadingSalesVATProfile")}</p>;
  if (error)
    return (
      <p className="form-message" role="alert">
        {t(errorMessage(error))}
      </p>
    );
  if (!profile) return null;
  const unconfigured = profile.salesVatStatus === "UNCONFIGURED";
  // Save is offered only for a change: an unconfigured profile must be saved
  // once; afterwards only a different status or VAT rate counts.
  const dirty =
    unconfigured ||
    status !== profile.salesVatStatus ||
    (status === "REGISTERED" && rate.trim() !== (profile.salesVatRate ?? ""));
  const savedSummary = unconfigured
    ? t("uiVatNotConfiguredYet")
    : profile.salesVatStatus === "REGISTERED"
      ? t("uiVatSavedRegistered").replace("{rate}", profile.salesVatRate ?? "")
      : t("uiVatSavedNotRegistered");
  return (
    <form
      aria-label={t("uiSalesVATProfile")}
      className="grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
      onSubmit={(event) => {
        event.preventDefault();
        if (!dirty) return;
        if (status === "REGISTERED" && decimalToScaled(rate, 6) === null) {
          setNotice("uiEnterAValidVATRateBeforeSaving");
          return;
        }
        setJustSaved(false);
        void mutation
          .mutateAsync({
            expectedUpdatedAt: profile.updatedAt,
            salesVatRate: status === "REGISTERED" ? rate : null,
            salesVatStatus: status,
          })
          .catch(() => undefined);
      }}
    >
      <p
        className="font-medium sm:col-span-3"
        data-testid="vat-saved-summary"
        role="status"
      >
        {justSaved && !dirty ? t("uiVatSaved") + " " : ""}
        {savedSummary}
      </p>
      <Label className="form-field">
        {t("uiSalesVATStatus")}
        <OptionSelect
          className="w-full "
          onValueChange={(value) => {
            setJustSaved(false);
            setNotice(null);
            setStatus(value as SalesVatProfile["salesVatStatus"]);
          }}
          options={[
            { label: t("uiNotRegistered"), value: "NOT_REGISTERED" },
            { label: t("uiRegistered"), value: "REGISTERED" },
          ]}
          value={status}
        />
      </Label>
      {status === "REGISTERED" ? (
        <Label className="form-field">
          {t("uiVATRate")}
          <Input
            className="form-control--numeric"
            inputMode="decimal"
            onChange={(event) => {
              setJustSaved(false);
              setNotice(null);
              setRate(event.target.value);
            }}
            value={rate}
          />
        </Label>
      ) : (
        <div />
      )}
      {notice ? (
        <p className="sm:col-span-2 form-message" role="alert">
          {t(notice)}
        </p>
      ) : null}
      {dirty ? (
        <Button
          aria-busy={mutation.isPending}
          className="self-end"
          disabled={mutation.isPending || writeBlocked}
          type="submit"
        >
          {mutation.isPending ? t("uiSavingVAT") : t("uiSaveVATProfile")}
        </Button>
      ) : null}
    </form>
  );
}

function SaleComplete({
  onNewSale,
  sale,
}: {
  onNewSale: () => void;
  sale: CompletedSale;
}) {
  const { t } = useLanguage();

  return (
    <section
      aria-live="polite"
      className="w-full max-w-2xl space-y-5 rounded-lg border bg-card p-5 sm:p-7"
    >
      <h1 className="text-2xl font-semibold">{t("uiSaleCompleted")}</h1>
      <p className="text-muted-foreground">
        {sale.reference} · {sale.branchCodeSnapshot} — {sale.branchNameSnapshot}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <p>
          <span className="text-muted-foreground">{t("receiptTotal")}</span>
          <br />
          <strong className="text-xl">{formatThb(sale.totalAmount)}</strong>
        </p>
        <p>
          <span className="text-muted-foreground">{t("uiPayment")}</span>
          <br />
          <strong>
            {sale.payment.method === "CASH"
              ? t("paymentCash") +
                " · " +
                t("uiChangeAmount").replace(
                  "{amount}",
                  formatThb(sale.payment.changeAmount),
                )
              : sale.payment.reference === "PromptPay"
                ? t("paymentPromptPay")
                : t("paymentTransfer") +
                  (sale.payment.reference
                    ? ` · ${sale.payment.reference}`
                    : "")}
          </strong>
        </p>
      </div>
      <ul className="space-y-2 border-y py-4">
        {sale.items.map((item) => (
          <li
            className="flex justify-between gap-3"
            key={`${item.nameSnapshot}-${item.quantity}`}
          >
            <span>
              {item.nameSnapshot} · {item.quantity} {item.unitSnapshot}
            </span>
            <span>{formatThb(item.lineGross)}</span>
          </li>
        ))}
      </ul>
      <Button onClick={onNewSale} type="button">
        {t("uiNewSale")}
      </Button>
      <Button onClick={() => window.print()} type="button">
        {t("uiPrintReceipt")}
      </Button>
      <SaleReceipt sale={sale} />
    </section>
  );
}
