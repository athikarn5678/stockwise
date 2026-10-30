"use client";
import { Badge } from "@/components/ui/badge";
import { useLanguage } from "@/providers/language-provider";
import type { TranslationKey } from "@/i18n/en";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import {
  applicationContextUrl,
  resolveApplicationContext,
} from "@/application-context";
import { fetchAccessContext } from "@/branch-api-client";
import {
  createSupplier,
  listSuppliers,
  setSupplierLifecycle,
  supplierScopeKey,
  SupplierApiError,
  type Supplier,
  type SupplierInput,
  type SupplierStatusFilter,
  updateSupplier,
} from "@/supplier-api-client";

const MANAGEMENT_ROLES = new Set(["OWNER", "ADMIN", "BRANCH_MANAGER"]);
const LIFECYCLE_ROLES = new Set(["OWNER", "ADMIN"]);
const emptyInput: SupplierInput = {
  name: "",
  contactName: "",
  email: "",
  phone: "",
  address: "",
};
function message(error: unknown, t: (key: TranslationKey) => string): string {
  if (error instanceof SupplierApiError) {
    if (error.kind === "forbidden") return t("supplierErrForbidden");
    if (error.kind === "validation") return t("supplierErrValidation");
    if (error.kind === "not_found") return t("supplierErrNotFound");
  }
  return t("supplierErrLoad");
}

export function SupplierManagement() {
  const params = useSearchParams();
  const { t } = useLanguage();
  const contextQuery = useQuery({
    queryKey: ["access-context"],
    queryFn: fetchAccessContext,
  });
  if (contextQuery.isPending)
    return <p aria-live="polite">{t("loadingAccess")}</p>;
  if (contextQuery.isError || contextQuery.data === undefined)
    return (
      <p className="form-message" role="alert">
        {t("accessError")}
      </p>
    );
  const context = contextQuery.data;
  const resolved = resolveApplicationContext(
    context,
    params.get("organizationId"),
    params.get("branchId"),
  );
  if (resolved.organization === null)
    return (
      <p className="form-message" role="alert">
        {t("supplierNoOrg")}
      </p>
    );
  if (resolved.organization.role === "INVENTORY_STAFF")
    return <p role="alert">{t("accessDenied")}</p>;
  return (
    <SupplierContent
      organization={resolved.organization}
      branchId={resolved.branch?.id ?? null}
    />
  );
}
function SupplierContent({
  organization,
  branchId,
}: {
  organization: {
    id: string;
    name: string;
    role: "OWNER" | "ADMIN" | "BRANCH_MANAGER" | "INVENTORY_STAFF" | "CASHIER";
  };
  branchId: string | null;
}) {
  const { t } = useLanguage();

  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<SupplierStatusFilter>("active");
  const [notice, setNotice] = useState<unknown>(null);
  const canManage = MANAGEMENT_ROLES.has(organization.role);
  const canLifecycle = LIFECYCLE_ROLES.has(organization.role);
  const scope = supplierScopeKey(organization.id);
  const suppliers = useInfiniteQuery({
    queryKey: [...scope, search, status],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      listSuppliers(organization.id, { cursor: pageParam, q: search, status }),
    getNextPageParam: (last) => last.meta.nextCursor,
  });
  const refresh = async () => {
    setNotice(null);
    await queryClient.invalidateQueries({ queryKey: scope });
  };
  if (!canManage)
    return (
      <section className="space-y-4">
        <Link
          className="text-sm underline"
          href={applicationContextUrl(organization.id, branchId)}
        >
          {t("backToWorkspace")}
        </Link>
        <h1 className="text-2xl font-semibold">{t("supplierTitle")}</h1>
        <p className="form-message" role="alert">
          {t("supplierNoPermission")}
        </p>
      </section>
    );
  const records =
    suppliers.data?.pages.flatMap((page) => page.data.suppliers) ?? [];
  return (
    <section className="w-full space-y-6">
      <header>
        <Link
          className="text-sm underline"
          href={applicationContextUrl(organization.id, branchId)}
        >
          {t("backToWorkspace")}
        </Link>
        <h1 className="mt-3 text-2xl font-semibold">{t("supplierTitle")}</h1>
        <p className="text-muted-foreground">
          {t("supplierManageFor").replace("{name}", organization.name)}
        </p>
      </header>
      {notice ? (
        <p className="form-message" role="alert">
          {message(notice, t)}
        </p>
      ) : null}
      <SupplierForm
        label={t("supplierCreate")}
        onError={(error) => setNotice(error)}
        onSave={(input) => createSupplier(organization.id, input).then(refresh)}
      />
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem_auto]">
        <Label className="form-field">
          {t("supplierSearch")}
          <Input
            className=""
            defaultValue={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </Label>
        <Label className="form-field">
          {t("commonStatus")}
          <NativeSelect
            className="w-full "
            onChange={(event) =>
              setStatus(event.target.value as SupplierStatusFilter)
            }
            value={status}
          >
            <NativeSelectOption value="active">
              {t("commonActive")}
            </NativeSelectOption>
            <NativeSelectOption value="inactive">
              {t("commonInactive")}
            </NativeSelectOption>
            <NativeSelectOption value="all">
              {t("commonAll")}
            </NativeSelectOption>
          </NativeSelect>
        </Label>
        <Button
          variant="outline"
          className="self-end"
          onClick={() => void refresh()}
          type="button"
        >
          {t("commonRefresh")}
        </Button>
      </div>
      {suppliers.isPending ? (
        <p aria-live="polite">{t("supplierLoading")}</p>
      ) : suppliers.isError ? (
        <p className="form-message" role="alert">
          {message(suppliers.error, t)}
        </p>
      ) : records.length === 0 ? (
        <p>{t("supplierEmpty")}</p>
      ) : (
        <div className="grid gap-4">
          {records.map((supplier) => (
            <SupplierCard
              canLifecycle={canLifecycle}
              key={supplier.id}
              onError={(error) => setNotice(error)}
              onSave={refresh}
              organizationId={organization.id}
              supplier={supplier}
            />
          ))}
        </div>
      )}
      {suppliers.hasNextPage ? (
        <Button
          variant="outline"
          className=""
          disabled={suppliers.isFetchingNextPage}
          onClick={() => void suppliers.fetchNextPage()}
          type="button"
        >
          {suppliers.isFetchingNextPage
            ? t("commonLoading")
            : t("commonLoadMore")}
        </Button>
      ) : null}
    </section>
  );
}
function SupplierForm({
  initial = emptyInput,
  label,
  onError,
  onSave,
}: {
  initial?: SupplierInput;
  label: string;
  onError: (error: unknown) => void;
  onSave: (input: SupplierInput) => Promise<unknown>;
}) {
  const { t } = useLanguage();
  const mutation = useMutation({ mutationFn: onSave });
  return (
    <form
      className="rounded-lg border bg-card p-5"
      onSubmit={(event) => {
        event.preventDefault();
        const formElement = event.currentTarget;
        const form = new FormData(formElement);
        void mutation
          .mutateAsync({
            name: String(form.get("name") ?? ""),
            contactName: String(form.get("contactName") ?? ""),
            email: String(form.get("email") ?? ""),
            phone: String(form.get("phone") ?? ""),
            address: String(form.get("address") ?? ""),
          })
          .then(() => {
            if (label === t("supplierCreate")) formElement.reset();
          })
          .catch(onError);
      }}
    >
      <h2 className="font-semibold">{label}</h2>
      <div className="mt-4 grid max-w-4xl items-start gap-4 sm:grid-cols-2">
        <Field
          defaultValue={initial.name}
          label={t("supplierName")}
          name="name"
          required
        />
        <Field
          defaultValue={initial.contactName}
          label={t("supplierContact")}
          name="contactName"
        />
        <Field
          defaultValue={initial.email}
          label={t("supplierEmail")}
          name="email"
          type="email"
        />
        <Field
          defaultValue={initial.phone}
          label={t("supplierPhone")}
          name="phone"
        />
        <Label className="form-field sm:col-span-2">
          {t("supplierAddress")}
          <Textarea
            className=""
            defaultValue={initial.address}
            name="address"
          />
        </Label>
      </div>
      <Button
        aria-busy={mutation.isPending}
        className="mt-4"
        disabled={mutation.isPending}
        type="submit"
      >
        {mutation.isPending ? t("commonSaving") : label}
      </Button>
    </form>
  );
}
function SupplierCard({
  canLifecycle,
  onError,
  onSave,
  organizationId,
  supplier,
}: {
  canLifecycle: boolean;
  onError: (error: unknown) => void;
  onSave: () => Promise<void>;
  organizationId: string;
  supplier: Supplier;
}) {
  const { t } = useLanguage();
  const edit = useMutation({
    mutationFn: (input: SupplierInput) =>
      updateSupplier(organizationId, supplier.id, input),
    onSuccess: onSave,
  });
  const lifecycle = useMutation({
    mutationFn: () => setSupplierLifecycle(organizationId, supplier),
    onSuccess: onSave,
  });
  const pending = edit.isPending || lifecycle.isPending;
  return (
    <article className="rounded-lg border bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-semibold">{supplier.name}</h2>
        <Badge variant="outline">
          {supplier.status === "ACTIVE"
            ? t("commonActive")
            : t("commonInactive")}
        </Badge>
      </div>
      <SupplierForm
        initial={{
          name: supplier.name,
          contactName: supplier.contactName ?? "",
          email: supplier.email ?? "",
          phone: supplier.phone ?? "",
          address: supplier.address ?? "",
        }}
        label={t("saveChanges")}
        onError={onError}
        onSave={(input) => edit.mutateAsync(input)}
      />
      {canLifecycle ? (
        <Button
          variant="outline"
          aria-busy={lifecycle.isPending}
          className="mt-3"
          disabled={pending}
          onClick={() => void lifecycle.mutateAsync().catch(onError)}
          type="button"
        >
          {supplier.status === "ACTIVE"
            ? t("supplierDeactivate")
            : t("supplierReactivate")}
        </Button>
      ) : null}
    </article>
  );
}
function Field({
  defaultValue,
  label,
  name,
  required,
  type = "text",
}: {
  defaultValue: string;
  label: string;
  name: string;
  required?: boolean;
  type?: string;
}) {
  return (
    <Label className="form-field">
      {label}
      <Input
        className={name === "phone" ? "form-control--compact" : ""}
        defaultValue={defaultValue}
        name={name}
        required={required}
        type={type}
      />
    </Label>
  );
}
