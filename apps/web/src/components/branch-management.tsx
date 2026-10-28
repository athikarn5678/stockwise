"use client";
import { useLanguage } from "@/providers/language-provider";
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

function errorMessage(error: unknown): string {
  if (!(error instanceof BranchApiError)) return "The request failed.";
  const messages: Record<BranchApiError["kind"], string> = {
    authentication_required: "Sign in again to continue.",
    code_conflict: "That branch code is already in use.",
    forbidden: "You do not have permission to manage branches.",
    last_active_branch: "An organization must retain one active branch.",
    not_found: "The branch no longer exists.",
    stale: "This branch changed. Refresh and try again.",
    unavailable: "The branch service is unavailable.",
    validation: "Check the branch values and try again.",
  };
  return messages[error.kind];
}

export function BranchManagement() {
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

  if (contextQuery.isPending) return <p>Loading access…</p>;
  if (contextQuery.isError)
    return (
      <p className="form-message" role="alert">
        Access could not be loaded.
      </p>
    );
  if (!canManage || organizationId === null) {
    return (
      <section className="space-y-4">
        <h1 className="text-2xl font-semibold">
          Branch management unavailable
        </h1>
        <p>
          You do not have branch management permission for this organization.
        </p>
        <Link className="underline" href="/app">
          Return to application
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
          Return to application
        </Link>
        <h1 className="mt-3 text-2xl font-semibold">Branches</h1>
        <p className="text-muted-foreground">{organization.name}</p>
      </header>
      <CreateBranchForm organizationId={organizationId} onSaved={refresh} />
      {branchesQuery.isPending ? <p>Loading branches…</p> : null}
      {branchesQuery.isError ? (
        <p className="form-message" role="alert">
          {errorMessage(branchesQuery.error)}
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
  const [error, setError] = useState<string | null>(null);
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
      setError(errorMessage(cause));
    }
  }

  return (
    <form className="rounded-lg border bg-card p-5" onSubmit={submit}>
      <h2 className="font-semibold">Create branch</h2>
      <div className="mt-4 grid max-w-4xl items-start gap-4 sm:grid-cols-2">
        <Field
          label="Code (optional — generated as BR-001, BR-002… if blank)"
          maxLength={16}
          name="code"
        />
        <Field label="Name" maxLength={200} name="name" required />
        <Field label="Phone (optional)" maxLength={32} name="phone" />
        <Field label="Address (optional)" maxLength={500} name="address" />
      </div>
      {error ? (
        <p className="mt-3 text-sm text-destructive form-message" role="alert">
          {error}
        </p>
      ) : null}
      <Button className="mt-4" disabled={mutation.isPending} type="submit">
        {mutation.isPending ? "Creating…" : "Create branch"}
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

  const [error, setError] = useState<string | null>(null);
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
      setError(errorMessage(cause));
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
        <span className="text-sm text-muted-foreground">{branch.status}</span>
      </div>
      <div className="mt-4 grid max-w-4xl items-start gap-4 sm:grid-cols-2">
        <Field
          defaultValue={branch.name}
          label="Name"
          maxLength={200}
          name="name"
          required
        />
        <Field
          defaultValue={branch.phone ?? ""}
          label="Phone"
          maxLength={32}
          name="phone"
        />
        <Field
          defaultValue={branch.address ?? ""}
          label="Address"
          maxLength={500}
          name="address"
        />
      </div>
      {error ? (
        <p className="mt-3 text-sm text-destructive form-message" role="alert">
          {error}
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
          {branch.status === "ACTIVE" ? "Deactivate" : "Reactivate"}
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
