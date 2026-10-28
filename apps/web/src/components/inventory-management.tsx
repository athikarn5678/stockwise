"use client";
import { useLanguage } from "@/providers/language-provider";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { useEffect, useId, useRef, useState } from "react";

import {
  applicationContextUrl,
  resolveApplicationContext,
} from "@/application-context";
import {
  type AccessibleOrganization,
  fetchAccessContext,
} from "@/branch-api-client";
import {
  createInventoryAdjustment,
  getInventoryItem,
  InventoryApiError,
  type InventoryApiErrorKind,
  type InventoryAdjustmentReason,
  type InventoryItem,
  type InventoryRequestContext,
  type InventoryUnit,
  listInventory,
  listInventoryHistory,
} from "@/inventory-api-client";

type InventoryRole = AccessibleOrganization["role"];
type InventoryStatus = "ACTIVE" | "INACTIVE" | "ALL";
type InventoryPage = Awaited<ReturnType<typeof listInventory>>;
type InventoryHistoryPage = Awaited<ReturnType<typeof listInventoryHistory>>;

const ADJUSTMENT_ROLES = new Set<InventoryRole>([
  "OWNER",
  "ADMIN",
  "BRANCH_MANAGER",
  "INVENTORY_STAFF",
]);
const INTEGER_UNITS = new Set<InventoryUnit>(["EA", "PACK", "BOX"]);
const ADJUSTMENT_REASONS: readonly InventoryAdjustmentReason[] = [
  "STOCK_COUNT",
  "DAMAGE",
  "LOSS",
  "FOUND",
  "CORRECTION",
  "OTHER",
];

function inventoryUrl(organizationId: string, branchId: string | null): string {
  const params = new URLSearchParams({ organizationId });
  if (branchId !== null) params.set("branchId", branchId);
  return `/app/inventory?${params.toString()}`;
}

function inventoryScopeKey(
  context: InventoryRequestContext,
): readonly unknown[] {
  return [
    "branch-scoped",
    context.organizationId,
    context.branchId,
    "inventory",
  ];
}

function errorMessage(error: unknown): string {
  if (!(error instanceof InventoryApiError)) {
    return "Inventory is temporarily unavailable. Try again.";
  }
  const messages: Record<InventoryApiErrorKind, string> = {
    authentication_required: "Sign in again to continue.",
    branch_inactive: "This branch is inactive and cannot receive adjustments.",
    forbidden:
      "This inventory action is not available for your current access.",
    idempotency_conflict:
      "This submission conflicts with an earlier adjustment. Refresh before trying again.",
    insufficient_stock: "This adjustment would make stock negative.",
    invalid_cursor: "This list changed. Refresh the latest results.",
    product_inactive:
      "This product is inactive and cannot receive adjustments.",
    product_not_found: "This product is no longer available. Refresh the list.",
    unavailable: "Inventory is temporarily unavailable. Try again.",
    validation: "Check the adjustment values and try again.",
  };
  return messages[error.kind];
}

function isValidDelta(delta: string, unit: InventoryUnit): boolean {
  if (!/^[+-]?\d+(?:\.\d{1,4})?$/.test(delta)) return false;
  if (/^[+-]?0+(?:\.0+)?$/.test(delta)) return false;
  const decimal = delta.replace(/^[+-]/, "").split(".")[1];
  return !(
    INTEGER_UNITS.has(unit) &&
    decimal !== undefined &&
    !/^0+$/.test(decimal)
  );
}

function signedDelta(delta: string): string {
  return delta.startsWith("-") ? delta : `+${delta}`;
}

function formatOccurredAt(value: string): string {
  return value.replace("T", " ").replace(".000Z", " UTC");
}

function createIdempotencyKey(): string {
  if (typeof crypto?.randomUUID !== "function") {
    throw new InventoryApiError("unavailable");
  }
  return crypto.randomUUID();
}

export function InventoryManagement() {
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
    const canonical = inventoryUrl(
      resolved.organization.id,
      resolved.branch?.id ?? null,
    );
    const current = inventoryUrl(
      requestedOrganizationId ?? "",
      requestedBranchId,
    );
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
      <section className="space-y-4">
        <h1 className="text-2xl font-semibold">Inventory unavailable</h1>
        <p className="text-muted-foreground">
          Choose an active organization from the workspace before viewing stock.
        </p>
        <Link className="underline" href="/app">
          Return to workspace
        </Link>
      </section>
    );
  }
  if (resolved === null) return null;
  if (resolved.branch === null) {
    return (
      <section className="space-y-4">
        <h1 className="text-2xl font-semibold">Branch context required</h1>
        <p className="text-muted-foreground">
          Choose an active branch before viewing inventory.
        </p>
        <Link
          className="underline"
          href={applicationContextUrl(resolved.organization.id, null)}
        >
          Return to workspace
        </Link>
      </section>
    );
  }
  return (
    <InventoryContent
      branch={resolved.branch}
      organization={resolved.organization}
    />
  );
}

function InventoryContent({
  branch,
  organization,
}: {
  branch: AccessibleOrganization["branches"][number];
  organization: AccessibleOrganization;
}) {
  const { t } = useLanguage();

  const [status, setStatus] = useState<InventoryStatus>("ACTIVE");
  const [selectedProductId, setSelectedProductId] = useState<string | null>(
    null,
  );
  const requestContext = {
    branchId: branch.id,
    organizationId: organization.id,
  } satisfies InventoryRequestContext;
  const scopeKey = inventoryScopeKey(requestContext);
  const balancesQuery = useInfiniteQuery<
    InventoryPage,
    Error,
    InfiniteData<InventoryPage>,
    readonly unknown[],
    string | null
  >({
    getNextPageParam: (page) => page.meta.nextCursor,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      listInventory(requestContext, { cursor: pageParam, status }),
    queryKey: [...scopeKey, "balances", { status }],
  });
  const balances = balancesQuery.data?.pages.flatMap((page) => page.data) ?? [];

  useEffect(() => {
    setSelectedProductId(null);
  }, [branch.id, organization.id]);

  return (
    <section className="w-full space-y-8">
      <header className="space-y-2">
        <Link
          className="text-sm underline"
          href={applicationContextUrl(organization.id, branch.id)}
        >
          {t("backToWorkspace")}
        </Link>
        <h1 className="text-2xl font-semibold">{t("inventoryTitle")}</h1>
        <p className="text-muted-foreground">
          {t("inventorySubtitle").replace(
            "{branch}",
            `${branch.code} — ${branch.name}`,
          )}
        </p>
      </header>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <Label className="form-field">
          {t("inventoryProductStatus")}
          <NativeSelect
            className="w-full "
            onChange={(event) =>
              setStatus(event.target.value as InventoryStatus)
            }
            value={status}
          >
            <NativeSelectOption value="ACTIVE">
              {t("inventoryActiveProducts")}
            </NativeSelectOption>
            <NativeSelectOption value="INACTIVE">
              {t("inventoryInactiveProducts")}
            </NativeSelectOption>
            <NativeSelectOption value="ALL">
              {t("inventoryAllProducts")}
            </NativeSelectOption>
          </NativeSelect>
        </Label>
        <Button
          variant="outline"
          onClick={() => void balancesQuery.refetch()}
          type="button"
        >
          {t("inventoryRefresh")}
        </Button>
      </div>

      <BalanceList
        error={balancesQuery.error}
        hasNextPage={balancesQuery.hasNextPage}
        isLoading={balancesQuery.isPending}
        isLoadingNext={balancesQuery.isFetchingNextPage}
        items={balances}
        onLoadMore={() => void balancesQuery.fetchNextPage()}
        onSelect={setSelectedProductId}
        selectedProductId={selectedProductId}
      />

      {selectedProductId !== null ? (
        <InventoryDetail
          canAdjust={ADJUSTMENT_ROLES.has(organization.role)}
          context={requestContext}
          productId={selectedProductId}
          scopeKey={scopeKey}
        />
      ) : null}
    </section>
  );
}

function BalanceList({
  error,
  hasNextPage,
  isLoading,
  isLoadingNext,
  items,
  onLoadMore,
  onSelect,
  selectedProductId,
}: {
  error: Error | null;
  hasNextPage: boolean;
  isLoading: boolean;
  isLoadingNext: boolean;
  items: InventoryItem[];
  onLoadMore: () => void;
  onSelect: (productId: string) => void;
  selectedProductId: string | null;
}) {
  const { t } = useLanguage();
  if (isLoading)
    return <p aria-live="polite">{t("inventoryLoadingBalances")}</p>;
  if (error !== null)
    return (
      <p className="form-message" role="alert">
        {errorMessage(error)}
      </p>
    );
  if (items.length === 0) {
    return (
      <p className="rounded-lg border p-5 text-muted-foreground">
        No products match this inventory view.
      </p>
    );
  }
  return (
    <section aria-label="Inventory balances" className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((item) => (
          <Button
            variant="outline"
            aria-pressed={selectedProductId === item.product.id}
            className="block h-auto w-full min-w-0 whitespace-normal bg-card p-4 text-left transition-colors"
            key={item.product.id}
            onClick={() => onSelect(item.product.id)}
            type="button"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="font-semibold">{item.product.name}</h2>
                <p className="text-sm text-muted-foreground">
                  {item.product.sku}
                </p>
              </div>
              <span className="rounded-full border px-2 py-1 text-xs">
                {item.product.status === "ACTIVE"
                  ? t("inventoryActive")
                  : t("inventoryInactive")}
              </span>
            </div>
            <p className="mt-5 text-2xl font-semibold">
              {item.balance.quantity} {item.product.unit}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {item.balance.exists
                ? t("inventoryPersisted")
                : t("inventoryNoBalance")}
            </p>
            <span className="mt-4 inline-block text-sm underline">
              {t("inventoryViewHistory")}
            </span>
          </Button>
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
    </section>
  );
}

function InventoryDetail({
  canAdjust,
  context,
  productId,
  scopeKey,
}: {
  canAdjust: boolean;
  context: InventoryRequestContext;
  productId: string;
  scopeKey: readonly unknown[];
}) {
  const detailQuery = useQuery({
    queryFn: () => getInventoryItem(context, productId),
    queryKey: [...scopeKey, "product", productId],
  });
  const historyQuery = useInfiniteQuery<
    InventoryHistoryPage,
    Error,
    InfiniteData<InventoryHistoryPage>,
    readonly unknown[],
    string | null
  >({
    getNextPageParam: (page) => page.meta.nextCursor,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      listInventoryHistory(context, productId, { cursor: pageParam }),
    queryKey: [...scopeKey, "product", productId, "history"],
  });
  const transactions =
    historyQuery.data?.pages.flatMap((page) => page.data) ?? [];

  return (
    <section
      aria-live="polite"
      className="space-y-6 rounded-lg border bg-card p-5 sm:p-7"
    >
      {detailQuery.isPending ? <p>Loading product inventory…</p> : null}
      {detailQuery.isError ? (
        <p className="form-message" role="alert">
          {errorMessage(detailQuery.error)}
        </p>
      ) : null}
      {detailQuery.data ? (
        <>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold">
                {detailQuery.data.product.name}
              </h2>
              <p className="text-sm text-muted-foreground">
                {detailQuery.data.product.sku} · {detailQuery.data.product.unit}
              </p>
            </div>
            <p className="text-xl font-semibold">
              {detailQuery.data.balance.quantity}{" "}
              {detailQuery.data.product.unit}
            </p>
          </div>
          {canAdjust && detailQuery.data.product.status === "ACTIVE" ? (
            <AdjustmentForm
              context={context}
              product={detailQuery.data}
              scopeKey={scopeKey}
            />
          ) : (
            <p className="rounded-md border p-4 text-sm text-muted-foreground">
              {detailQuery.data.product.status === "INACTIVE"
                ? "This inactive product remains readable, but cannot receive an adjustment."
                : "Your current role can view inventory but cannot adjust stock."}
            </p>
          )}
        </>
      ) : null}
      <HistoryList
        error={historyQuery.error}
        hasNextPage={historyQuery.hasNextPage}
        isLoading={historyQuery.isPending}
        isLoadingNext={historyQuery.isFetchingNextPage}
        onLoadMore={() => void historyQuery.fetchNextPage()}
        transactions={transactions}
      />
    </section>
  );
}

function AdjustmentForm({
  context,
  product,
  scopeKey,
}: {
  context: InventoryRequestContext;
  product: InventoryItem;
  scopeKey: readonly unknown[];
}) {
  const queryClient = useQueryClient();
  const [validation, setValidation] = useState<string | null>(null);
  const keyRef = useRef<string | null>(null);
  const deltaId = useId();
  const reasonId = useId();
  const noteId = useId();
  const errorId = useId();
  const mutation = useMutation({
    mutationFn: (form: HTMLFormElement) => {
      const data = new FormData(form);
      const delta = String(data.get("delta") ?? "");
      const reason = String(
        data.get("reason") ?? "STOCK_COUNT",
      ) as InventoryAdjustmentReason;
      const note = String(data.get("note") ?? "");
      if (!isValidDelta(delta, product.product.unit)) {
        throw new InventoryApiError("validation");
      }
      if (reason === "OTHER" && note.trim() === "") {
        throw new InventoryApiError("validation");
      }
      keyRef.current ??= createIdempotencyKey();
      return createInventoryAdjustment(context, keyRef.current, {
        delta,
        note,
        productId: product.product.id,
        reason,
      });
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: [...scopeKey, "balances"] }),
        queryClient.invalidateQueries({
          queryKey: [...scopeKey, "product", product.product.id],
        }),
      ]);
    },
  });

  return (
    <form
      aria-label={`Adjust stock for ${product.product.name}`}
      className="space-y-4 rounded-md border p-4"
      onChange={() => {
        keyRef.current = null;
      }}
      onSubmit={(event) => {
        event.preventDefault();
        setValidation(null);
        const form = event.currentTarget;
        void mutation
          .mutateAsync(form)
          .then(() => {
            keyRef.current = null;
            form.reset();
          })
          .catch((error: unknown) => setValidation(errorMessage(error)));
      }}
    >
      <div>
        <h3 className="font-semibold">Manual adjustment</h3>
        <p className="text-sm text-muted-foreground">
          Enter a signed quantity. Stock changes only after the server confirms
          it.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-[12rem_minmax(0,1fr)]">
        <Label className="form-field" htmlFor={deltaId}>
          Signed adjustment ({product.product.unit})
          <Input
            aria-describedby={validation ? errorId : undefined}
            className="form-control--numeric"
            id={deltaId}
            inputMode="decimal"
            name="delta"
            placeholder="e.g. +2 or -1.25"
            required
          />
        </Label>
        <Label className="form-field" htmlFor={reasonId}>
          Reason
          <NativeSelect
            className="w-full form-control--compact"
            defaultValue="STOCK_COUNT"
            id={reasonId}
            name="reason"
          >
            {ADJUSTMENT_REASONS.map((reason) => (
              <NativeSelectOption key={reason} value={reason}>
                {reason.replaceAll("_", " ")}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Label>
      </div>
      <Label className="form-field" htmlFor={noteId}>
        Note (required for OTHER)
        <Textarea
          aria-describedby={validation ? errorId : undefined}
          className=""
          id={noteId}
          name="note"
        />
      </Label>
      {validation ? (
        <p className="form-message" id={errorId} role="alert">
          {validation}
        </p>
      ) : null}
      <Button
        aria-busy={mutation.isPending}
        disabled={mutation.isPending}
        type="submit"
      >
        {mutation.isPending ? "Submitting adjustment…" : "Submit adjustment"}
      </Button>
    </form>
  );
}

const MOVEMENT_LABELS: Record<string, string> = {
  MANUAL_ADJUSTMENT: "Manual adjustment",
  PURCHASE_RECEIVE: "Purchase receive",
  SALE: "Sale",
  SALE_REFUND_RETURN: "Sale refund return",
};

function HistoryList({
  error,
  hasNextPage,
  isLoading,
  isLoadingNext,
  onLoadMore,
  transactions,
}: {
  error: Error | null;
  hasNextPage: boolean;
  isLoading: boolean;
  isLoadingNext: boolean;
  onLoadMore: () => void;
  transactions: Awaited<ReturnType<typeof listInventoryHistory>>["data"];
}) {
  return (
    <section aria-labelledby="inventory-history-heading" className="space-y-4">
      <div>
        <h3 className="font-semibold" id="inventory-history-heading">
          Transaction history
        </h3>
        <p className="text-sm text-muted-foreground">
          Chronological immutable movements. Times are shown in UTC.
        </p>
      </div>
      {isLoading ? (
        <p aria-live="polite">Loading transaction history…</p>
      ) : null}
      {error !== null ? (
        <p className="form-message" role="alert">
          {errorMessage(error)}
        </p>
      ) : null}
      {!isLoading && error === null && transactions.length === 0 ? (
        <p className="rounded-md border p-4 text-muted-foreground">
          No transactions have been recorded for this product at this branch.
        </p>
      ) : null}
      {transactions.length > 0 ? (
        <ol className="space-y-3">
          {transactions.map((transaction) => (
            <li className="rounded-md border p-4" key={transaction.id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-medium">
                    {signedDelta(transaction.delta)} ·{" "}
                    {transaction.reason?.replaceAll("_", " ") ??
                      MOVEMENT_LABELS[transaction.source] ??
                      transaction.source.replaceAll("_", " ")}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {transaction.source.replaceAll("_", " ")} ·{" "}
                    {formatOccurredAt(transaction.occurredAt)}
                  </p>
                </div>
                <p className="text-sm text-muted-foreground">
                  {transaction.actor.displayName ?? "Unknown user"}
                </p>
              </div>
              {transaction.note !== null ? (
                <p className="mt-3 text-sm">{transaction.note}</p>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
      {hasNextPage ? (
        <Button
          variant="outline"
          disabled={isLoadingNext}
          onClick={onLoadMore}
          type="button"
        >
          {isLoadingNext ? "Loading more…" : "Load more history"}
        </Button>
      ) : null}
    </section>
  );
}
