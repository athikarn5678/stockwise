"use client";
import { useLanguage } from "@/providers/language-provider";
import type { TranslationKey } from "@/i18n/en";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { type FormEvent, useState } from "react";

import {
  BranchApiError,
  changeBranchLifecycle,
  createBranch,
  fetchAccessContext,
  fetchBranches,
  updateBranch,
  type Branch,
} from "@/branch-api-client";
import { applicationContextUrl } from "@/application-context";

function errorMessage(
  error: unknown,
  t: (key: TranslationKey) => string,
): string {
  if (!(error instanceof BranchApiError)) return t("branchErrRequest");
  const messages: Record<BranchApiError["kind"], string> = {
    authentication_required: t("branchErrAuth"),
    code_conflict: t("branchErrCodeConflict"),
    forbidden: t("branchErrForbidden"),
    last_active_branch: t("branchErrLastActive"),
    not_found: t("branchErrNotFound"),
    stale: t("branchErrStale"),
    unavailable: t("branchErrUnavailable"),
    validation: t("branchErrValidation"),
  };
  return messages[error.kind];
}

export function BranchManagement() {
  const { t } = useLanguage();
  const searchParams = useSearchParams();
  const organizationId = searchParams.get("organizationId");
  const branchId = searchParams.get("branchId");
  const queryClient = useQueryClient();
  const contextQuery = useQuery({
    queryFn: fetchAccessContext,
    queryKey: ["access-context"],
  });
  const organization = contextQuery.data?.organizations.find(
    ({ id }) => id === organizationId,
  );
  const canManage =
    organization?.role === "OWNER" || organization?.role === "ADMIN";
  const branchesQuery = useQuery({
    enabled: organizationId !== null && canManage,
    queryFn: () => fetchBranches(organizationId ?? "", true),
    queryKey: ["branches", organizationId, true],
  });

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["access-context"] }),
      queryClient.invalidateQueries({
        queryKey: ["branches", organizationId, true],
      }),
    ]);
  }

  if (contextQuery.isPending) return <p>{t("loadingAccess")}</p>;
  if (contextQuery.isError)
    return (
      <p className="form-message" role="alert">
        {t("accessError")}
      </p>
    );
  if (!canManage || organizationId === null) {
    return (
      <section className="space-y-4">
        <h1 className="text-2xl font-semibold">{t("branchUnavailable")}</h1>
        <p>{t("branchNoPermission")}</p>
        <Link className="underline" href="/app">
          {t("commonReturnToApp")}
        </Link>
      </section>
    );
  }

  return (
    <section className="w-full space-y-8">
      <header>
        <Link
          className="text-sm underline"
          href={applicationContextUrl(organizationId, branchId)}
        >
          {t("commonReturnToApp")}
        </Link>
        <h1 className="mt-3 text-2xl font-semibold">{t("branchTitle")}</h1>
        <p className="text-muted-foreground">{organization.name}</p>
      </header>
      <CreateBranchForm organizationId={organizationId} onSaved={refresh} />
      {branchesQuery.isPending ? <p>{t("branchLoading")}</p> : null}
      {branchesQuery.isError ? (
        <p className="form-message" role="alert">
          {errorMessage(branchesQuery.error, t)}
        </p>
      ) : null}
      <div className="grid gap-4">
        {branchesQuery.data?.map((branch) => (
          <BranchEditor
            branch={branch}
            key={branch.id}
            onSaved={refresh}
            organizationId={organizationId}
          />
        ))}
      </div>
    </section>
  );
}

function CreateBranchForm({
  onSaved,
  organizationId,
}: {
  onSaved: () => Promise<void>;
  organizationId: string;
}) {
  const { t } = useLanguage();
  const [error, setError] = useState<unknown>(null);
  const mutation = useMutation({
    mutationFn: (form: HTMLFormElement) => {
      const data = new FormData(form);
      return createBranch(organizationId, {
        address: String(data.get("address") ?? ""),
        code: String(data.get("code") ?? ""),
        name: String(data.get("name") ?? ""),
        phone: String(data.get("phone") ?? ""),
      });
    },
    onSuccess: onSaved,
  });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setError(null);
    try {
      await mutation.mutateAsync(form);
      form.reset();
    } catch (cause: unknown) {
      setError(cause);
    }
  }

  return (
    <form className="rounded-lg border bg-card p-5" onSubmit={submit}>
      <h2 className="font-semibold">{t("branchCreate")}</h2>
      <div className="mt-4 grid max-w-4xl items-start gap-4 sm:grid-cols-2">
        <Field label={t("branchCodeOptional")} maxLength={16} name="code" />
        <Field label={t("commonName")} maxLength={200} name="name" required />
        <Field label={t("branchPhoneOptional")} maxLength={32} name="phone" />
        <Field
          label={t("branchAddressOptional")}
          maxLength={500}
          name="address"
        />
      </div>
      {error ? (
        <p className="mt-3 text-sm text-destructive form-message" role="alert">
          {errorMessage(error, t)}
        </p>
      ) : null}
      <Button className="mt-4" disabled={mutation.isPending} type="submit">
        {mutation.isPending ? t("branchCreating") : t("branchCreate")}
      </Button>
    </form>
  );
}

function BranchEditor({
  branch,
  onSaved,
  organizationId,
}: {
  branch: Branch;
  onSaved: () => Promise<void>;
  organizationId: string;
}) {
  const { t } = useLanguage();

  const [error, setError] = useState<unknown>(null);
  const updateMutation = useMutation({
    mutationFn: (form: HTMLFormElement) => {
      const data = new FormData(form);
      return updateBranch(organizationId, branch.id, {
        address: String(data.get("address") ?? ""),
        expectedUpdatedAt: branch.updatedAt,
        name: String(data.get("name") ?? ""),
        phone: String(data.get("phone") ?? ""),
      });
    },
    onSuccess: onSaved,
  });
  const lifecycleMutation = useMutation({
    mutationFn: () => changeBranchLifecycle(organizationId, branch),
    onSuccess: onSaved,
  });

  async function run(operation: () => Promise<unknown>) {
    setError(null);
    try {
      await operation();
    } catch (cause: unknown) {
      setError(cause);
    }
  }

  return (
    <form
      className="rounded-lg border bg-card p-5"
      onSubmit={(event) => {
        event.preventDefault();
        void run(() => updateMutation.mutateAsync(event.currentTarget));
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">{branch.code}</h2>
        <span className="text-sm text-muted-foreground">
          {branch.status === "ACTIVE" ? t("commonActive") : t("commonInactive")}
        </span>
      </div>
      <div className="mt-4 grid max-w-4xl items-start gap-4 sm:grid-cols-2">
        <Field
          defaultValue={branch.name}
          label={t("commonName")}
          maxLength={200}
          name="name"
          required
        />
        <Field
          defaultValue={branch.phone ?? ""}
          label={t("commonPhone")}
          maxLength={32}
          name="phone"
        />
        <Field
          defaultValue={branch.address ?? ""}
          label={t("commonAddress")}
          maxLength={500}
          name="address"
        />
      </div>
      {error ? (
        <p className="mt-3 text-sm text-destructive form-message" role="alert">
          {errorMessage(error, t)}
        </p>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-3">
        <Button
          variant="outline"
          className=""
          disabled={updateMutation.isPending || lifecycleMutation.isPending}
          type="submit"
        >
          {t("saveChanges")}
        </Button>
        <Button
          variant="outline"
          className=""
          disabled={updateMutation.isPending || lifecycleMutation.isPending}
          onClick={() => void run(() => lifecycleMutation.mutateAsync())}
          type="button"
        >
          {branch.status === "ACTIVE"
            ? t("commonDeactivate")
            : t("commonReactivate")}
        </Button>
      </div>
    </form>
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
  return (
    <Label
      className={name === "address" ? "form-field sm:col-span-2" : "form-field"}
    >
      {label}
      <Input
        className={
          name === "code"
            ? "form-control--compact"
            : name === "phone"
              ? "form-control--compact"
              : ""
        }
        name={name}
        type="text"
        {...props}
      />
    </Label>
  );
}
