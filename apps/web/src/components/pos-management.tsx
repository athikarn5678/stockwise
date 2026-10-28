"use client";
import { useLanguage } from "@/providers/language-provider";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";

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
import { SaleReceipt } from "./sale-receipt";

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
  getSalesVatProfile,
  type CompletedSale,
  type PosProduct,
  type PosUnit,
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
type PaymentMethod = "CASH" | "TRANSFER";

const CHECKOUT_ROLES = new Set<PosRole>([
  "OWNER",
  "ADMIN",
  "BRANCH_MANAGER",
  "CASHIER",
]);
const DISCOUNT_ROLES = new Set<PosRole>(["OWNER", "ADMIN", "BRANCH_MANAGER"]);
const INTEGER_UNITS = new Set<PosUnit>(["EA", "PACK", "BOX"]);

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

function errorMessage(error: unknown): string {
  if (!(error instanceof SalesApiError)) {
    return "Checkout is temporarily unavailable. Your cart was kept unchanged.";
  }
  const messages: Record<SalesApiErrorKind, string> = {
    authentication_required: "Sign in again to continue.",
    branch_inactive: "This branch is inactive. Choose another active branch.",
    forbidden: "Checkout is not available for your current access.",
    idempotency_conflict:
      "This checkout key represents different sale details. Review the cart before starting a new sale.",
    insufficient_stock:
      "Stock is no longer sufficient for this cart. Adjust the quantities and try again.",
    invalid_cursor: "The product results changed. Search again.",
    price_changed:
      "A product price changed. The latest product prices were refreshed; review the cart before retrying.",
    product_inactive:
      "A product in this cart is inactive. Remove it and try again.",
    product_not_found:
      "A product in this cart no longer exists. Remove it and try again.",
    sale_not_found:
      "Checkout is temporarily unavailable. Your cart was kept unchanged.",
    sale_already_fully_refunded:
      "Checkout is temporarily unavailable. Your cart was kept unchanged.",
    refund_quantity_exceeded:
      "Checkout is temporarily unavailable. Your cart was kept unchanged.",
    stale_vat_profile:
      "The VAT profile changed. Refresh the latest VAT settings.",
    unavailable:
      "Checkout is temporarily unavailable. Your cart was kept unchanged.",
    validation:
      "Check the cart, discount, and payment details before trying again.",
    vat_configuration_required:
      "Checkout is blocked until the organization sales VAT profile is configured.",
  };
  return messages[error.kind];
}

export function PosManagement() {
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

  if (contextQuery.isPending) return <p aria-live="polite">Loading access…</p>;
  if (contextQuery.isError)
    return (
      <p className="form-message" role="alert">
        Your access context could not be loaded.
      </p>
    );
  if (resolved?.organization === null) {
    return (
      <ContextUnavailable
        heading="POS unavailable"
        message="Choose an active organization from the workspace before starting a sale."
      />
    );
  }
  if (resolved === null) return null;
  if (resolved.branch === null) {
    return (
      <ContextUnavailable
        heading="Branch context required"
        message="Choose an active branch before starting a sale."
      />
    );
  }
  if (!CHECKOUT_ROLES.has(resolved.organization.role)) {
    return (
      <ContextUnavailable
        heading="POS unavailable"
        message="Your current role cannot perform checkout."
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
  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-semibold">{heading}</h1>
      <p className="text-muted-foreground">{message}</p>
      <Link className="underline" href="/app">
        Return to workspace
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
  const [transferReference, setTransferReference] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [completedSale, setCompletedSale] = useState<CompletedSale | null>(
    null,
  );
  const keyRef = useRef<string | null>(null);
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

  const changeIntent = () => {
    keyRef.current = null;
    setNotice(null);
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
      const payment = buildPayment(
        paymentMethod,
        amountTendered,
        transferReference,
      );
      if (payment === "invalid") throw new SalesApiError("validation");
      keyRef.current ??= createIdempotencyKey();
      return checkoutSale(context, keyRef.current, {
        discount,
        items: cart.map((line) => ({
          expectedUnitPrice: line.basePrice,
          productId: line.id,
          quantity: line.quantity,
        })),
        payment,
      });
    },
    onError: async (error) => {
      if (error instanceof SalesApiError && error.kind === "price_changed") {
        await queryClient.invalidateQueries({
          queryKey: [...scopeKey, "products"],
        });
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
      void queryClient.invalidateQueries({
        queryKey: [...scopeKey, "products"],
      });
      void queryClient.invalidateQueries({
        queryKey: ["branch-scoped", organization.id, branch.id, "inventory"],
      });
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
          setTransferReference("");
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
        <h1 className="text-2xl font-semibold">Point of sale</h1>
        <p className="text-muted-foreground">
          {branch.code} — {branch.name}. Product prices and final totals are
          confirmed by checkout.
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
          Checkout is blocked until the organization sales VAT profile is
          configured.
        </p>
      ) : null}
      {notice ? (
        <p className="rounded-md border p-4 form-message" role="alert">
          {notice}
        </p>
      ) : null}

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(22rem,0.8fr)]">
        <section aria-labelledby="pos-product-heading" className="space-y-4">
          <h2 className="text-xl font-semibold" id="pos-product-heading">
            Products
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
            aria-label="Search POS products"
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
              Search products
              <Input
                className=""
                defaultValue={search.q}
                name="q"
                placeholder="Name or SKU"
              />
            </Label>
            <Button className="self-end" type="submit">
              Search
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
                Current sale
              </h2>
              <p className="text-sm text-muted-foreground">
                Transient cart only; stock is confirmed at checkout.
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
              Clear cart
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
              <span className="font-medium">Current-price subtotal</span>
              <strong>
                {subtotal === null ? "Check quantities" : formatThb(subtotal)}
              </strong>
            </div>
            <p className="text-xs text-muted-foreground">
              This exact-decimal estimate is not a final total. VAT, discounts,
              stock, and price are revalidated by the server.
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
              onChange={(method, tendered, reference) => {
                changeIntent();
                setPaymentMethod(method);
                setAmountTendered(tendered);
                setTransferReference(reference);
              }}
              reference={transferReference}
              subtotal={subtotal}
              method={paymentMethod}
            />
            <form
              aria-label="Checkout current sale"
              onSubmit={(event) => {
                event.preventDefault();
                if (checkoutPendingRef.current || scansPendingRef.current > 0)
                  return;
                checkoutPendingRef.current = true;
                void checkoutMutation
                  .mutateAsync()
                  .catch(() => undefined)
                  .finally(() => {
                    checkoutPendingRef.current = false;
                  });
              }}
            >
              <Button
                aria-busy={checkoutMutation.isPending}
                disabled={
                  cart.length === 0 ||
                  checkoutMutation.isPending ||
                  scansPending > 0 ||
                  (canConfigureVat &&
                    vatProfileQuery.data?.salesVatStatus === "UNCONFIGURED")
                }
                type="submit"
              >
                {checkoutMutation.isPending
                  ? "Completing sale…"
                  : "Complete sale"}
              </Button>
            </form>
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
  if (isLoading) return <p aria-live="polite">Loading sellable products…</p>;
  if (error)
    return (
      <p className="form-message" role="alert">
        {errorMessage(error)}
      </p>
    );
  if (products.length === 0)
    return (
      <p className="rounded-lg border p-5 text-muted-foreground">
        No products match this POS search.
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
                {product.available ? "Available" : "Unavailable"}
              </span>
            </div>
            <p className="mt-3 text-sm text-muted-foreground">
              In stock at this branch:{" "}
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
              {product.available ? `Add ${product.name}` : "Unavailable"}
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
          {isLoadingNext ? "Loading more…" : "Load more products"}
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
  if (lines.length === 0)
    return (
      <p className="rounded-md border p-4 text-sm text-muted-foreground">
        Add an available product to begin a sale.
      </p>
    );
  return (
    <ul aria-label="Cart items" className="space-y-4">
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
                {estimate === null ? "Check quantity" : formatThb(estimate)}
              </strong>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <Button
                variant="outline"
                aria-label={`Decrease ${line.name} quantity`}
                onClick={() => onDecrement(line.id)}
                type="button"
              >
                −
              </Button>
              <Label className="form-field max-w-48 basis-32 flex-1">
                Quantity for {line.name} ({line.unit})
                <Input
                  aria-invalid={!valid}
                  className="form-control--numeric"
                  inputMode="decimal"
                  onChange={(event) =>
                    onChangeQuantity(line.id, event.target.value)
                  }
                  value={line.quantity}
                />
              </Label>
              <Button
                variant="outline"
                aria-label={`Increase ${line.name} quantity`}
                onClick={() => onIncrement(line.id)}
                type="button"
              >
                +
              </Button>
              <Button
                variant="outline"
                aria-label={`Remove ${line.name} from cart`}
                onClick={() => onRemove(line.id)}
                type="button"
              >
                Remove
              </Button>
            </div>
            {!valid ? (
              <p className="text-sm text-destructive form-message" role="alert">
                Enter a positive quantity with no more than four decimal places.
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
  return (
    <fieldset className="space-y-3 border-t pt-4">
      <legend className="font-medium">Whole-sale discount</legend>
      <Label className="form-field">
        Discount type
        <NativeSelect
          className="w-full "
          onChange={(event) =>
            onChange(event.target.value as DiscountType, value, reason)
          }
          value={type}
        >
          <NativeSelectOption value="NONE">No discount</NativeSelectOption>
          <NativeSelectOption value="AMOUNT">Amount (THB)</NativeSelectOption>
          <NativeSelectOption value="PERCENT">Percent</NativeSelectOption>
        </NativeSelect>
      </Label>
      {type !== "NONE" ? (
        <>
          <Label className="form-field">
            {type === "AMOUNT" ? "Discount amount (THB)" : "Discount percent"}
            <Input
              className="form-control--numeric"
              inputMode="decimal"
              onChange={(event) => onChange(type, event.target.value, reason)}
              value={value}
            />
          </Label>
          <Label className="form-field">
            Discount reason
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
  reference,
  subtotal,
}: {
  amountTendered: string;
  method: PaymentMethod;
  onChange: (
    method: PaymentMethod,
    tendered: string,
    reference: string,
  ) => void;
  reference: string;
  subtotal: string | null;
}) {
  const tendered = decimalToScaled(amountTendered, 2);
  const subtotalCents = subtotal === null ? null : decimalToScaled(subtotal, 2);
  const change =
    tendered !== null && subtotalCents !== null && tendered >= subtotalCents
      ? displayScaled(tendered - subtotalCents, 2)
      : null;
  return (
    <fieldset className="space-y-3 border-t pt-4">
      <legend className="font-medium">Payment</legend>
      <div className="flex flex-wrap gap-4">
        <Label className="flex min-h-11 items-center gap-2 text-sm font-medium">
          <Input
            className=""
            checked={method === "CASH"}
            name="payment-method"
            onChange={() => onChange("CASH", amountTendered, reference)}
            type="radio"
            value="CASH"
          />
          Cash
        </Label>
        <Label className="flex items-center gap-2">
          <Input
            className=""
            checked={method === "TRANSFER"}
            name="payment-method"
            onChange={() => onChange("TRANSFER", amountTendered, reference)}
            type="radio"
            value="TRANSFER"
          />
          Transfer
        </Label>
      </div>
      {method === "CASH" ? (
        <>
          <Label className="form-field">
            Amount tendered (THB)
            <Input
              className="form-control--numeric"
              inputMode="decimal"
              onChange={(event) =>
                onChange("CASH", event.target.value, reference)
              }
              required
              value={amountTendered}
            />
          </Label>
          <p className="text-sm text-muted-foreground">
            {change === null
              ? "Enter tendered cash at or above the current-price subtotal."
              : `Estimated change: ${formatThb(change)}. Final change is server-confirmed.`}
          </p>
        </>
      ) : (
        <Label className="form-field">
          Transfer reference (optional)
          <Input
            className=""
            onChange={(event) =>
              onChange("TRANSFER", amountTendered, event.target.value)
            }
            value={reference}
          />
        </Label>
      )}
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
  reference: string,
) {
  if (method === "TRANSFER")
    return { method, reference: reference.trim() || null } as const;
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
  const [status, setStatus] =
    useState<SalesVatProfile["salesVatStatus"]>("NOT_REGISTERED");
  const [rate, setRate] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: (input: {
      expectedUpdatedAt: string;
      salesVatRate: string | null;
      salesVatStatus: SalesVatProfile["salesVatStatus"];
    }) => updateSalesVatProfile(organizationId, input),
    onError: (cause) => setNotice(errorMessage(cause)),
    onSuccess: () => {
      setNotice(null);
      onSaved();
    },
  });
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
  if (isLoading) return <p aria-live="polite">Loading sales VAT profile…</p>;
  if (error)
    return (
      <p className="form-message" role="alert">
        {errorMessage(error)}
      </p>
    );
  if (!profile) return null;
  return (
    <form
      aria-label="Sales VAT profile"
      className="grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
      onSubmit={(event) => {
        event.preventDefault();
        if (status === "REGISTERED" && decimalToScaled(rate, 6) === null) {
          setNotice("Enter a valid VAT rate before saving.");
          return;
        }
        void mutation
          .mutateAsync({
            expectedUpdatedAt: profile.updatedAt,
            salesVatRate: status === "REGISTERED" ? rate : null,
            salesVatStatus: status,
          })
          .catch(() => undefined);
      }}
    >
      <Label className="form-field">
        Sales VAT status
        <NativeSelect
          className="w-full "
          onChange={(event) =>
            setStatus(event.target.value as SalesVatProfile["salesVatStatus"])
          }
          value={status}
        >
          <NativeSelectOption value="NOT_REGISTERED">
            Not registered
          </NativeSelectOption>
          <NativeSelectOption value="REGISTERED">Registered</NativeSelectOption>
        </NativeSelect>
      </Label>
      {status === "REGISTERED" ? (
        <Label className="form-field">
          VAT rate (%)
          <Input
            className="form-control--numeric"
            inputMode="decimal"
            onChange={(event) => setRate(event.target.value)}
            value={rate}
          />
        </Label>
      ) : (
        <div />
      )}
      {notice ? (
        <p className="sm:col-span-2 form-message" role="alert">
          {notice}
        </p>
      ) : null}
      <Button
        aria-busy={mutation.isPending}
        className="self-end"
        disabled={mutation.isPending}
        type="submit"
      >
        {mutation.isPending ? "Saving VAT…" : "Save VAT profile"}
      </Button>
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
  return (
    <section
      aria-live="polite"
      className="w-full max-w-2xl space-y-5 rounded-lg border bg-card p-5 sm:p-7"
    >
      <h1 className="text-2xl font-semibold">Sale completed</h1>
      <p className="text-muted-foreground">
        {sale.reference} · {sale.branchCodeSnapshot} — {sale.branchNameSnapshot}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <p>
          <span className="text-muted-foreground">Total</span>
          <br />
          <strong className="text-xl">{formatThb(sale.totalAmount)}</strong>
        </p>
        <p>
          <span className="text-muted-foreground">Payment</span>
          <br />
          <strong>
            {sale.payment.method === "CASH"
              ? `Cash · change ${formatThb(sale.payment.changeAmount)}`
              : `Transfer${sale.payment.reference ? ` · ${sale.payment.reference}` : ""}`}
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
        New sale
      </Button>
      <Button onClick={() => window.print()} type="button">
        Print receipt
      </Button>
      <SaleReceipt sale={sale} />
    </section>
  );
}
