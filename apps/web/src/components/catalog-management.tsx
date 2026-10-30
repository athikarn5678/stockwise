"use client";
import type { TranslationKey } from "@/i18n/en";
import { Badge } from "@/components/ui/badge";
import { useLanguage } from "@/providers/language-provider";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { useEffect, useId, useState } from "react";

import { ProductBarcodeLabels } from "./product-barcode-labels";

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
  type CatalogApiErrorKind,
  CatalogApiError,
  type CatalogCategory,
  type CatalogProduct,
  type CatalogRequestContext,
  createCategory,
  createProduct,
  listCategories,
  listProducts,
  PRODUCT_UNITS,
  setCategoryLifecycle,
  setProductLifecycle,
  updateCategory,
  updateProduct,
} from "@/catalog-api-client";

type CatalogView = "categories" | "products";
type CategoryPage = Awaited<ReturnType<typeof listCategories>>;
type ProductPage = Awaited<ReturnType<typeof listProducts>>;
type CatalogRole = AccessibleOrganization["role"];

const MANAGEMENT_ROLES = new Set<CatalogRole>([
  "OWNER",
  "ADMIN",
  "BRANCH_MANAGER",
]);
const LIFECYCLE_ROLES = new Set<CatalogRole>([
  "OWNER",
  "ADMIN",
  "BRANCH_MANAGER",
]);
const BRANCH_SCOPED_ROLES = new Set<CatalogRole>([
  "BRANCH_MANAGER",
  "INVENTORY_STAFF",
  "CASHIER",
]);

function catalogUrl(organizationId: string, branchId: string | null): string {
  const params = new URLSearchParams({ organizationId });
  if (branchId !== null) params.set("branchId", branchId);
  return `/app/catalog?${params.toString()}`;
}

function catalogScopeKey(context: CatalogRequestContext): readonly unknown[] {
  return context.branchId === undefined
    ? ["organization-scoped", context.organizationId, "catalog"]
    : ["branch-scoped", context.organizationId, context.branchId, "catalog"];
}

function errorMessage(error: unknown): TranslationKey {
  if (!(error instanceof CatalogApiError))
    return "uiTheCatalogIsTemporarilyUnavailable";
  const messages: Record<CatalogApiErrorKind, TranslationKey> = {
    authentication_required: "branchErrAuth",
    barcode_conflict: "uiThatBarcodeAlreadyExistsInThisOrganization",
    branch_context_required: "uiChooseAValidActiveBranchToUseTheCatalog",
    category_inactive: "uiTheSelectedCategoryIsNoLongerActiveRefreshThe",
    category_name_conflict: "uiThatCategoryNameAlreadyExistsInThisOrganization",
    category_not_found: "uiThatCategoryIsNoLongerAvailableRefreshTheList",
    category_stale: "uiThisItemChangedSinceYouOpenedItRefreshThe",
    forbidden: "uiThisCatalogActionIsNotAvailableForYourCurrent",
    invalid_cursor: "uiTheCatalogListChangedTheFirstPageWasReloaded",
    product_not_found: "uiThatProductIsNoLongerAvailableRefreshTheList",
    product_stale: "uiThisItemChangedSinceYouOpenedItRefreshThe",
    sku_conflict: "uiThatSKUAlreadyExistsInThisOrganization",
    unavailable: "uiTheCatalogIsTemporarilyUnavailableTryAgain",
    validation: "teamErrorValidation",
  };
  return messages[error.kind];
}

function isStaleError(error: unknown): boolean {
  return (
    error instanceof CatalogApiError &&
    (error.kind === "category_stale" || error.kind === "product_stale")
  );
}

function safeBasePrice(value: string): boolean {
  return /^\d+(?:\.\d{1,4})?$/.test(value);
}

function StatusBadge({ status }: { status: "ACTIVE" | "INACTIVE" }) {
  const { t } = useLanguage();

  return (
    <Badge variant="outline" data-status={status.toLowerCase()}>
      {status === "ACTIVE" ? t("commonActive") : t("commonInactive")}
    </Badge>
  );
}

function Field({
  label,
  name,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  name: string;
}) {
  const id = useId();
  return (
    <Label className="form-field" htmlFor={id}>
      {label}
      <Input
        className={name === "basePrice" ? "form-control--numeric" : ""}
        id={id}
        name={name}
        type="text"
        {...props}
      />
    </Label>
  );
}

function TextareaField({
  label,
  name,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label: string;
  name: string;
}) {
  const id = useId();
  return (
    <Label className="form-field sm:col-span-full" htmlFor={id}>
      {label}
      <Textarea className="" id={id} name={name} {...props} />
    </Label>
  );
}

export function CatalogManagement() {
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
    if (
      resolved?.organization === null ||
      resolved?.organization === undefined
    ) {
      return;
    }
    const canonical = catalogUrl(
      resolved.organization.id,
      resolved.branch?.id ?? null,
    );
    const current = catalogUrl(
      requestedOrganizationId ?? "",
      requestedBranchId,
    );
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
      <section className="space-y-4">
        <h1 className="text-2xl font-semibold">{t("uiCatalogUnavailable")}</h1>
        <p className="text-muted-foreground">
          {t("uiChooseAnActiveOrganizationFromTheWorkspaceBeforeManaging")}
        </p>
        <Link className="underline" href="/app">
          {t("uiReturnToWorkspace")}
        </Link>
      </section>
    );
  }
  if (resolved === null) return null;
  return (
    <CatalogContent
      branch={resolved.branch}
      organization={resolved.organization}
    />
  );
}

function CatalogContent({
  branch,
  organization,
}: {
  branch: AccessibleOrganization["branches"][number] | null;
  organization: AccessibleOrganization;
}) {
  const { t } = useLanguage();

  if (organization.role === "INVENTORY_STAFF") {
    return <p role="alert">{t("accessDenied")}</p>;
  }

  if (BRANCH_SCOPED_ROLES.has(organization.role) && branch === null) {
    return (
      <section className="space-y-4">
        <h1 className="text-2xl font-semibold">
          {t("uiBranchContextRequired")}
        </h1>
        <p className="text-muted-foreground">
          {t("uiChooseAnActiveAssignedBranchInTheWorkspaceBefore")}
        </p>
        <Link
          className="underline"
          href={applicationContextUrl(organization.id, null)}
        >
          {t("uiReturnToWorkspace")}
        </Link>
      </section>
    );
  }
  return <CatalogContentLoaded branch={branch} organization={organization} />;
}

function CatalogContentLoaded({
  branch,
  organization,
}: {
  branch: AccessibleOrganization["branches"][number] | null;
  organization: AccessibleOrganization;
}) {
  const { t } = useLanguage();

  const queryClient = useQueryClient();
  const [view, setView] = useState<CatalogView>("products");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [categorySearch, setCategorySearch] = useState("");
  const [productSearch, setProductSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [notice, setNotice] = useState<TranslationKey | null>(null);
  const role = organization.role;
  const requestContext: CatalogRequestContext = {
    ...(branch === null ? {} : { branchId: branch.id }),
    organizationId: organization.id,
  };
  const canManage = MANAGEMENT_ROLES.has(role);
  const canLifecycle = LIFECYCLE_ROLES.has(role);
  const canIncludeInactive = canManage || canLifecycle;
  const scopeKey = catalogScopeKey(requestContext);
  const categoryOptionsQuery = useQuery({
    queryFn: () => listCategories(requestContext, { limit: 100 }),
    queryKey: [...scopeKey, "category-options"],
  });
  const categoryQuery = useInfiniteQuery<
    CategoryPage,
    Error,
    InfiniteData<CategoryPage>,
    readonly unknown[],
    string | null
  >({
    getNextPageParam: (page) => page.meta.nextCursor,
    initialPageParam: null,
    queryFn: ({ pageParam }) =>
      listCategories(requestContext, {
        cursor: pageParam,
        includeInactive,
        q: categorySearch,
      }),
    queryKey: [
      ...scopeKey,
      "categories",
      { includeInactive, q: categorySearch },
    ],
  });
  const productQuery = useInfiniteQuery<
    ProductPage,
    Error,
    InfiniteData<ProductPage>,
    readonly unknown[],
    string | null
  >({
    getNextPageParam: (page) => page.meta.nextCursor,
    initialPageParam: null,
    queryFn: ({ pageParam }) =>
      listProducts(requestContext, {
        ...(categoryFilter === "" ? {} : { categoryId: categoryFilter }),
        cursor: pageParam,
        includeInactive,
        q: productSearch,
      }),
    queryKey: [
      ...scopeKey,
      "products",
      { categoryId: categoryFilter, includeInactive, q: productSearch },
    ],
  });

  const refreshCatalog = async () => {
    setNotice(null);
    await queryClient.invalidateQueries({ queryKey: scopeKey });
  };
  const handleError = (error: unknown) => {
    setNotice(errorMessage(error));
    if (error instanceof CatalogApiError && error.kind === "invalid_cursor") {
      void refreshCatalog();
    }
  };

  const categories =
    categoryQuery.data?.pages.flatMap((page) => page.data.categories) ?? [];
  const products =
    productQuery.data?.pages.flatMap((page) => page.data.products) ?? [];
  const categoryNames = new Map(
    [...(categoryOptionsQuery.data?.data.categories ?? []), ...categories].map(
      (category) => [category.id, category.name],
    ),
  );

  return (
    <section className="w-full space-y-8">
      <header className="space-y-2">
        <Link
          className="text-sm underline"
          href={applicationContextUrl(organization.id, branch?.id ?? null)}
        >
          {t("backToWorkspace")}
        </Link>
        <h1 className="text-2xl font-semibold">
          {t("marketingFeatureCatalog")}
        </h1>
        <p className="text-muted-foreground">
          {t("uiManageProductsAndCategoriesFor")} {organization.name}.
        </p>
      </header>

      {notice ? (
        <div
          className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-4"
          role="alert"
        >
          <p>{t(notice)}</p>
          {isStaleError(categoryQuery.error) ||
          isStaleError(productQuery.error) ? null : (
            <Button
              variant="outline"
              onClick={() => void refreshCatalog()}
              type="button"
            >
              {t("uiRefreshLatest")}
            </Button>
          )}
        </div>
      ) : null}

      <div
        aria-label={t("uiCatalogViews")}
        className="flex gap-2 border-b"
        role="tablist"
      >
        <Button
          variant={view === "products" ? "secondary" : "outline"}
          aria-controls="products-panel"
          aria-selected={view === "products"}
          className=""
          onClick={() => setView("products")}
          role="tab"
          type="button"
        >
          {t("uiProducts")}
        </Button>
        <Button
          variant={view === "categories" ? "secondary" : "outline"}
          aria-controls="categories-panel"
          aria-selected={view === "categories"}
          className=""
          onClick={() => setView("categories")}
          role="tab"
          type="button"
        >
          {t("uiCategories")}
        </Button>
      </div>

      {canIncludeInactive ? (
        <Label className="flex min-h-11 items-center gap-3 text-sm font-medium">
          <Checkbox
            className=""
            checked={includeInactive}
            onCheckedChange={(checked) => setIncludeInactive(checked)}
          />
          {t("uiIncludeInactiveCatalogRecords")}
        </Label>
      ) : null}

      {view === "products" ? (
        <section
          aria-labelledby="products-heading"
          id="products-panel"
          role="tabpanel"
        >
          <h2 className="sr-only" id="products-heading">
            {t("uiProducts")}
          </h2>
          {canManage ? (
            <ProductCreateForm
              categories={categoryOptionsQuery.data?.data.categories ?? []}
              context={requestContext}
              onError={handleError}
              onSaved={refreshCatalog}
            />
          ) : null}
          <ProductListControls
            categories={categoryOptionsQuery.data?.data.categories ?? []}
            categoryFilter={categoryFilter}
            onCategoryFilterChange={setCategoryFilter}
            onSearch={setProductSearch}
            search={productSearch}
          />
          <CatalogListState
            emptyMessage={t("uiNoProductsMatchThisCatalogView")}
            error={productQuery.error}
            isEmpty={products.length === 0}
            isPending={productQuery.isPending}
            onRefresh={refreshCatalog}
          >
            <div className="grid gap-4">
              {products.map((product) => (
                <ProductEditor
                  canLifecycle={canLifecycle}
                  canManage={canManage}
                  categories={categoryOptionsQuery.data?.data.categories ?? []}
                  categoryName={
                    product.categoryId === null
                      ? null
                      : (categoryNames.get(product.categoryId) ??
                        t("uiCurrentInactiveCategory"))
                  }
                  context={requestContext}
                  key={product.id}
                  onError={handleError}
                  onSaved={refreshCatalog}
                  product={product}
                />
              ))}
            </div>
            <LoadMore
              hasNextPage={productQuery.hasNextPage}
              isPending={productQuery.isFetchingNextPage}
              onLoadMore={() => void productQuery.fetchNextPage()}
            />
          </CatalogListState>
        </section>
      ) : (
        <section
          aria-labelledby="categories-heading"
          className="space-y-5"
          id="categories-panel"
          role="tabpanel"
        >
          <h2 className="sr-only" id="categories-heading">
            {t("uiCategories")}
          </h2>
          {canManage ? (
            <CategoryCreateForm
              context={requestContext}
              onError={handleError}
              onSaved={refreshCatalog}
            />
          ) : null}
          <SearchControl onSearch={setCategorySearch} search={categorySearch} />
          <CatalogListState
            emptyMessage={t("uiNoCategoriesMatchThisCatalogView")}
            error={categoryQuery.error}
            isEmpty={categories.length === 0}
            isPending={categoryQuery.isPending}
            onRefresh={refreshCatalog}
          >
            <div className="grid gap-4">
              {categories.map((category) => (
                <CategoryEditor
                  canLifecycle={canLifecycle}
                  canManage={canManage}
                  category={category}
                  context={requestContext}
                  key={category.id}
                  onError={handleError}
                  onSaved={refreshCatalog}
                />
              ))}
            </div>
            <LoadMore
              hasNextPage={categoryQuery.hasNextPage}
              isPending={categoryQuery.isFetchingNextPage}
              onLoadMore={() => void categoryQuery.fetchNextPage()}
            />
          </CatalogListState>
        </section>
      )}
    </section>
  );
}

function CatalogListState({
  children,
  emptyMessage,
  error,
  isEmpty,
  isPending,
  onRefresh,
}: {
  children: React.ReactNode;
  emptyMessage: string;
  error: Error | null;
  isEmpty: boolean;
  isPending: boolean;
  onRefresh: () => Promise<void>;
}) {
  const { t } = useLanguage();

  if (isPending) return <p aria-live="polite">{t("uiLoadingCatalog")}</p>;
  if (error)
    return (
      <div className="space-y-3" role="alert">
        <p>{t(errorMessage(error))}</p>
        <Button
          variant="outline"
          onClick={() => void onRefresh()}
          type="button"
        >
          {t("uiRefreshLatest")}
        </Button>
      </div>
    );
  if (isEmpty) return <p>{emptyMessage}</p>;
  return <>{children}</>;
}

function LoadMore({
  hasNextPage,
  isPending,
  onLoadMore,
}: {
  hasNextPage: boolean;
  isPending: boolean;
  onLoadMore: () => void;
}) {
  const { t } = useLanguage();

  if (!hasNextPage) return null;
  return (
    <div className="mt-4">
      <Button
        variant="outline"
        disabled={isPending}
        onClick={onLoadMore}
        type="button"
      >
        {isPending ? t("commonLoading") : t("commonLoadMore")}
      </Button>
    </div>
  );
}

function SearchControl({
  onSearch,
  search,
}: {
  onSearch: (value: string) => void;
  search: string;
}) {
  const { t } = useLanguage();

  return (
    <form
      className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-end [&>label]:flex-1"
      onSubmit={(event) => {
        event.preventDefault();
        onSearch(String(new FormData(event.currentTarget).get("q") ?? ""));
      }}
    >
      <Field defaultValue={search} label={t("uiSearchCatalog")} name="q" />
      <Button type="submit">{t("uiSearch")}</Button>
    </form>
  );
}

function ProductListControls({
  categories,
  categoryFilter,
  onCategoryFilterChange,
  onSearch,
  search,
}: {
  categories: CatalogCategory[];
  categoryFilter: string;
  onCategoryFilterChange: (value: string) => void;
  onSearch: (value: string) => void;
  search: string;
}) {
  const { t } = useLanguage();

  const categorySelectId = useId();
  return (
    <div className="my-5 grid gap-3 md:grid-cols-[minmax(0,1fr)_16rem] md:items-end">
      <SearchControl onSearch={onSearch} search={search} />
      <Label className="form-field" htmlFor={categorySelectId}>
        {t("uiCategoryFilter")}
        <NativeSelect
          className="w-full "
          id={categorySelectId}
          onChange={(event) => onCategoryFilterChange(event.target.value)}
          value={categoryFilter}
        >
          <NativeSelectOption value="">
            {t("uiAllCategories")}
          </NativeSelectOption>
          <NativeSelectOption value="uncategorized">
            {t("uiUncategorized")}
          </NativeSelectOption>
          {categories.map((category) => (
            <NativeSelectOption key={category.id} value={category.id}>
              {category.name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Label>
    </div>
  );
}

function CategoryCreateForm({
  context,
  onError,
  onSaved,
}: {
  context: CatalogRequestContext;
  onError: (error: unknown) => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useLanguage();

  const mutation = useMutation({
    mutationFn: (form: HTMLFormElement) => {
      const data = new FormData(form);
      return createCategory(context, {
        description: String(data.get("description") ?? ""),
        name: String(data.get("name") ?? ""),
      });
    },
    onSuccess: onSaved,
  });
  return (
    <form
      className="rounded-lg border bg-card p-5"
      onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        void mutation
          .mutateAsync(form)
          .then(() => form.reset())
          .catch(onError);
      }}
    >
      <h2 className="font-semibold">{t("uiCreateCategory")}</h2>
      <div className="mt-4 mb-4 grid max-w-4xl items-start gap-4 sm:grid-cols-2">
        <Field label={t("uiCategoryName")} name="name" required />
        <TextareaField label={t("uiDescriptionOptional")} name="description" />
      </div>
      <Button
        aria-busy={mutation.isPending}
        disabled={mutation.isPending}
        type="submit"
      >
        {mutation.isPending ? t("branchCreating") : t("uiCreateCategory")}
      </Button>
    </form>
  );
}

function CategoryEditor({
  canLifecycle,
  canManage,
  category,
  context,
  onError,
  onSaved,
}: {
  canLifecycle: boolean;
  canManage: boolean;
  category: CatalogCategory;
  context: CatalogRequestContext;
  onError: (error: unknown) => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useLanguage();

  const updateMutation = useMutation({
    mutationFn: (form: HTMLFormElement) => {
      const data = new FormData(form);
      return updateCategory(context, category.id, {
        description: String(data.get("description") ?? ""),
        expectedUpdatedAt: category.updatedAt,
        name: String(data.get("name") ?? ""),
      });
    },
    onSuccess: onSaved,
  });
  const lifecycleMutation = useMutation({
    mutationFn: () => setCategoryLifecycle(context, category),
    onSuccess: onSaved,
  });
  const pending = updateMutation.isPending || lifecycleMutation.isPending;
  return (
    <form
      className="rounded-lg border bg-card p-5"
      onSubmit={(event) => {
        event.preventDefault();
        void updateMutation.mutateAsync(event.currentTarget).catch(onError);
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-semibold">{category.name}</h3>
        <StatusBadge status={category.status} />
      </div>
      {canManage ? (
        <div className="mt-4 mb-4 grid max-w-4xl items-start gap-4 sm:grid-cols-2">
          <Field
            defaultValue={category.name}
            label={t("uiCategoryName")}
            name="name"
            required
          />
          <TextareaField
            defaultValue={category.description ?? ""}
            label={t("uiDescriptionOptional")}
            name="description"
          />
        </div>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">
          {category.description ?? t("uiNoDescription")}
        </p>
      )}
      {canManage || canLifecycle ? (
        <div className="mt-4 flex flex-wrap gap-3">
          {canManage ? (
            <Button
              variant="outline"
              aria-busy={updateMutation.isPending}
              disabled={pending}
              type="submit"
            >
              {t("saveChanges")}
            </Button>
          ) : null}
          {canLifecycle ? (
            <Button
              variant="outline"
              aria-busy={lifecycleMutation.isPending}
              disabled={pending}
              onClick={() =>
                void lifecycleMutation.mutateAsync().catch(onError)
              }
              type="button"
            >
              {category.status === "ACTIVE"
                ? t("commonDeactivate")
                : t("commonReactivate")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}

function ProductCreateForm({
  categories,
  context,
  onError,
  onSaved,
}: {
  categories: CatalogCategory[];
  context: CatalogRequestContext;
  onError: (error: unknown) => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useLanguage();

  const [validation, setValidation] = useState<TranslationKey | null>(null);
  const mutation = useMutation({
    mutationFn: (form: HTMLFormElement) => {
      const data = new FormData(form);
      const basePrice = String(data.get("basePrice") ?? "");
      if (!safeBasePrice(basePrice)) {
        throw new CatalogApiError("validation");
      }
      return createProduct(context, {
        barcode: String(data.get("barcode") ?? ""),
        basePrice,
        categoryId: String(data.get("categoryId") ?? "") || null,
        description: String(data.get("description") ?? ""),
        name: String(data.get("name") ?? ""),
        sku: String(data.get("sku") ?? ""),
        unit: String(
          data.get("unit") ?? "EA",
        ) as (typeof PRODUCT_UNITS)[number],
      });
    },
    onSuccess: onSaved,
  });
  const unitId = useId();
  const categoryId = useId();
  return (
    <form
      className="rounded-lg border bg-card p-5"
      onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        setValidation(null);
        void mutation
          .mutateAsync(form)
          .then(() => form.reset())
          .catch((error: unknown) => {
            setValidation(errorMessage(error));
            onError(error);
          });
      }}
    >
      <h2 className="font-semibold">{t("uiCreateProduct")}</h2>
      <div className="mt-4 mb-4 grid max-w-5xl items-start gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <Field label={t("uiProductName")} name="name" required />
        <Field label={t("uiSKU")} name="sku" required />
        <Field label={t("uiBarcodeOptional")} name="barcode" />
        <Field
          inputMode="decimal"
          label={t("uiBasePrice")}
          name="basePrice"
          required
        />
        <Label className="form-field" htmlFor={unitId}>
          {t("uiUnit")}
          <NativeSelect
            className="w-full form-control--compact"
            defaultValue="EA"
            id={unitId}
            name="unit"
          >
            {PRODUCT_UNITS.map((unit) => (
              <NativeSelectOption key={unit}>{unit}</NativeSelectOption>
            ))}
          </NativeSelect>
        </Label>
        <Label className="form-field" htmlFor={categoryId}>
          {t("uiCategoryOptional")}
          <NativeSelect className="w-full " id={categoryId} name="categoryId">
            <NativeSelectOption value="">
              {t("uiUncategorized")}
            </NativeSelectOption>
            {categories.map((category) => (
              <NativeSelectOption key={category.id} value={category.id}>
                {category.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Label>
        <TextareaField label={t("uiDescriptionOptional")} name="description" />
      </div>
      {validation ? (
        <p className="mt-3 text-sm form-message" role="alert">
          {t(validation)}
        </p>
      ) : null}
      <Button
        aria-busy={mutation.isPending}
        disabled={mutation.isPending}
        type="submit"
      >
        {mutation.isPending ? t("branchCreating") : t("uiCreateProduct")}
      </Button>
    </form>
  );
}

function ProductEditor({
  canLifecycle,
  canManage,
  categories,
  categoryName,
  context,
  onError,
  onSaved,
  product,
}: {
  canLifecycle: boolean;
  canManage: boolean;
  categories: CatalogCategory[];
  categoryName: string | null;
  context: CatalogRequestContext;
  onError: (error: unknown) => void;
  onSaved: () => Promise<void>;
  product: CatalogProduct;
}) {
  const { t } = useLanguage();

  const [validation, setValidation] = useState<TranslationKey | null>(null);
  const updateMutation = useMutation({
    mutationFn: (form: HTMLFormElement) => {
      const data = new FormData(form);
      const basePrice = String(data.get("basePrice") ?? "");
      if (!safeBasePrice(basePrice)) throw new CatalogApiError("validation");
      return updateProduct(context, product.id, {
        barcode: String(data.get("barcode") ?? ""),
        basePrice,
        categoryId: String(data.get("categoryId") ?? "") || null,
        description: String(data.get("description") ?? ""),
        expectedUpdatedAt: product.updatedAt,
        name: String(data.get("name") ?? ""),
        sku: String(data.get("sku") ?? ""),
      });
    },
    onSuccess: onSaved,
  });
  const lifecycleMutation = useMutation({
    mutationFn: () => setProductLifecycle(context, product),
    onSuccess: onSaved,
  });
  const categorySelectId = useId();
  const pending = updateMutation.isPending || lifecycleMutation.isPending;
  const needsCurrentCategoryOption =
    product.categoryId !== null &&
    !categories.some(({ id }) => id === product.categoryId);
  return (
    <form
      aria-label={t("uiEditNamedProduct").replace("{name}", product.name)}
      className="rounded-lg border bg-card p-5"
      onSubmit={(event) => {
        event.preventDefault();
        setValidation(null);
        void updateMutation
          .mutateAsync(event.currentTarget)
          .catch((error: unknown) => {
            setValidation(errorMessage(error));
            onError(error);
          });
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold">{product.name}</h3>
          <p className="text-sm text-muted-foreground">
            {product.sku} · {formatMoney(product.basePrice)} · {product.unit}
          </p>
        </div>
        <StatusBadge status={product.status} />
      </div>
      {canManage ? (
        <div className="mt-4 mb-4 grid max-w-5xl items-start gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <Field
            defaultValue={product.name}
            label={t("uiProductName")}
            name="name"
            required
          />
          <Field
            defaultValue={product.sku}
            label={t("uiSKU")}
            name="sku"
            required
          />
          <Field
            defaultValue={product.barcode ?? ""}
            label={t("uiBarcodeOptional")}
            name="barcode"
          />
          <Field
            defaultValue={product.basePrice}
            inputMode="decimal"
            label={t("uiBasePrice")}
            name="basePrice"
            required
          />
          <Label className="form-field" htmlFor={categorySelectId}>
            {t("uiCategoryOptional")}
            <NativeSelect
              className="w-full "
              defaultValue={product.categoryId ?? ""}
              id={categorySelectId}
              name="categoryId"
            >
              <NativeSelectOption value="">
                {t("uiUncategorized")}
              </NativeSelectOption>
              {needsCurrentCategoryOption ? (
                <NativeSelectOption value={product.categoryId ?? ""}>
                  {categoryName}
                </NativeSelectOption>
              ) : null}
              {categories.map((category) => (
                <NativeSelectOption key={category.id} value={category.id}>
                  {category.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Label>
          <p className="self-end text-sm text-muted-foreground">
            {t("uiUnit2")} {product.unit} {t("uiImmutable")}
          </p>
          <TextareaField
            defaultValue={product.description ?? ""}
            label={t("uiDescriptionOptional")}
            name="description"
          />
        </div>
      ) : (
        <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">{t("uiCategory")}</dt>
            <dd>{categoryName ?? t("uiUncategorized")}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t("uiBarcode")}</dt>
            <dd>{product.barcode ?? t("uiNotSet")}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t("uiDescription")}</dt>
            <dd>{product.description ?? t("uiNoDescription")}</dd>
          </div>
        </dl>
      )}
      <ProductBarcodeLabels product={product} />
      {validation ? (
        <p className="mt-3 text-sm form-message" role="alert">
          {t(validation)}
        </p>
      ) : null}
      {canManage || canLifecycle ? (
        <div className="mt-4 flex flex-wrap gap-3">
          {canManage ? (
            <Button
              variant="outline"
              aria-busy={updateMutation.isPending}
              disabled={pending}
              type="submit"
            >
              {t("saveChanges")}
            </Button>
          ) : null}
          {canLifecycle ? (
            <Button
              variant="outline"
              aria-busy={lifecycleMutation.isPending}
              disabled={pending}
              onClick={() =>
                void lifecycleMutation.mutateAsync().catch(onError)
              }
              type="button"
            >
              {product.status === "ACTIVE"
                ? t("commonDeactivate")
                : t("commonReactivate")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}
