"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fetchAccessContext, type AccessContext } from "@/branch-api-client";
import { resolveApplicationContext } from "@/application-context";
import {
  OrganizationApiError,
  fetchOrganizationSettings,
  updateOrganizationSettings,
} from "@/organization-api-client";
import { currentPrivateSessionSignal } from "@/session-lifecycle";
import { useAccountDraft } from "@/providers/account-draft";
import { useLanguage } from "@/providers/language-provider";

export function OrganizationSettings() {
  const { t } = useLanguage();
  const searchParams = useSearchParams();
  const organizationId = searchParams.get("organizationId");
  const accessQuery = useQuery({
    queryKey: ["access-context"],
    queryFn: ({ signal }) => fetchAccessContext({ signal }),
    retry: false,
  });
  const organization =
    organizationId && accessQuery.data
      ? resolveApplicationContext(accessQuery.data, organizationId, null)
          .organization
      : null;

  if (accessQuery.isPending)
    return <p aria-live="polite">{t("organizationSettingsLoading")}</p>;
  if (accessQuery.isError)
    return <AccessError onRetry={() => void accessQuery.refetch()} />;
  if (
    !organizationId ||
    !organization ||
    (organization.role !== "OWNER" && organization.role !== "ADMIN")
  )
    return <p role="alert">{t("organizationSettingsDenied")}</p>;

  return (
    <OrganizationEditor
      key={organization.id}
      organizationId={organization.id}
    />
  );
}

export function OrganizationSettingsFallback() {
  const { t } = useLanguage();
  return <p aria-live="polite">{t("organizationSettingsLoading")}</p>;
}

function AccessError({ onRetry }: { onRetry: () => void }) {
  const { t } = useLanguage();
  return (
    <section className="w-full max-w-2xl space-y-4">
      <p role="alert">{t("organizationSettingsLoadError")}</p>
      <Button type="button" onClick={onRetry}>
        {t("organizationSettingsRetry")}
      </Button>
    </section>
  );
}

function OrganizationEditor({ organizationId }: { organizationId: string }) {
  const { t } = useLanguage();
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({
    queryKey: ["organization-settings", organizationId],
    queryFn: ({ signal }) =>
      fetchOrganizationSettings(organizationId, { signal }),
    retry: false,
  });
  const draft = useAccountDraft(`organization:${organizationId}`);
  const candidate = draft.restored;
  const restored = candidate && "name" in candidate ? candidate : null;
  const organization = settingsQuery.data;
  const [name, setName] = useState(restored?.name ?? "");
  const [savedName, setSavedName] = useState(restored?.savedName ?? "");
  const [baseUpdatedAt, setBaseUpdatedAt] = useState<string | null>(
    restored?.baseUpdatedAt ?? null,
  );
  const [message, setMessage] = useState<
    "success" | "stale" | "validation" | "error" | "forbidden" | null
  >(null);
  const [saving, setSaving] = useState(false);
  const [editorForbidden, setEditorForbidden] = useState(false);
  const [localValidation, setLocalValidation] = useState(false);
  const showValidation = localValidation || message === "validation";
  const dirty = organization !== undefined && name !== savedName;
  const forbidden =
    editorForbidden ||
    message === "forbidden" ||
    (settingsQuery.error instanceof OrganizationApiError &&
      settingsQuery.error.kind === "forbidden");

  useEffect(() => {
    if (!organization || dirty || forbidden) return;
    setName(organization.name);
    setSavedName(organization.name);
    setBaseUpdatedAt(organization.updatedAt);
  }, [organization, dirty, forbidden]);

  useEffect(() => {
    if (!organization || forbidden) return;
    draft.remember(dirty ? { name, savedName, baseUpdatedAt } : null);
  }, [draft, organization, forbidden, dirty, name, savedName, baseUpdatedAt]);

  useEffect(() => {
    if (!forbidden) return;
    setEditorForbidden(true);
    setName(savedName);
    setBaseUpdatedAt(null);
    setLocalValidation(false);
    draft.remember(null);
  }, [forbidden, savedName, draft]);
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const onClick = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const link = target.closest("a[href]");
      if (
        !(link instanceof HTMLAnchorElement) ||
        link.target ||
        link.origin !== window.location.origin
      )
        return;
      const destination = new URL(link.href);
      if (
        destination.pathname === window.location.pathname &&
        destination.search === window.location.search &&
        destination.hash === window.location.hash
      )
        return;
      if (!window.confirm(t("organizationSettingsUnsavedConfirm"))) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [dirty, t]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!organization || baseUpdatedAt === null || forbidden || saving) return;
    const trimmed = name.trim();
    if (!trimmed || Array.from(trimmed).length > 200) {
      setLocalValidation(true);
      setMessage("validation");
      return;
    }
    setLocalValidation(false);
    setMessage(null);
    setSaving(true);
    const authoritySignal = currentPrivateSessionSignal();
    try {
      const updated = await updateOrganizationSettings(organizationId, {
        name: trimmed,
        expectedUpdatedAt: baseUpdatedAt,
      });
      authoritySignal.throwIfAborted();
      queryClient.setQueryData(
        ["organization-settings", organizationId],
        updated,
      );
      queryClient.setQueryData(
        ["access-context"],
        (current: AccessContext | undefined) =>
          current
            ? {
                ...current,
                organizations: current.organizations.map((item) =>
                  item.id === organizationId
                    ? { ...item, name: updated.name }
                    : item,
                ),
              }
            : current,
      );
      setSavedName(updated.name);
      setName(updated.name);
      setBaseUpdatedAt(updated.updatedAt);
      setMessage("success");
      draft.remember(null);
    } catch (error) {
      if (
        !authoritySignal.aborted &&
        !(error instanceof Error && error.name === "AbortError")
      ) {
        const kind =
          error instanceof OrganizationApiError ? error.kind : "error";
        setMessage(kind === "unavailable" ? "error" : kind);
        if (kind === "forbidden") {
          setEditorForbidden(true);
          setName(savedName);
          setBaseUpdatedAt(null);
          draft.remember(null);
          void queryClient.invalidateQueries({ queryKey: ["access-context"] });
        }
      }
    } finally {
      setSaving(false);
    }
  }

  async function reload() {
    const result = await settingsQuery.refetch();
    if (!result.data) return;
    setName(result.data.name);
    setSavedName(result.data.name);
    setBaseUpdatedAt(result.data.updatedAt);
    setLocalValidation(false);
    setMessage(null);
  }

  if (forbidden) return <p role="alert">{t("organizationSettingsDenied")}</p>;
  if (settingsQuery.isPending)
    return <p aria-live="polite">{t("organizationSettingsLoading")}</p>;
  if (settingsQuery.isError || !organization)
    return (
      <section className="w-full max-w-2xl space-y-4">
        <p role="alert">{t("organizationSettingsLoadError")}</p>
        <Button type="button" onClick={() => void settingsQuery.refetch()}>
          {t("organizationSettingsRetry")}
        </Button>
      </section>
    );

  return (
    <section className="w-full max-w-2xl space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">
          {t("organizationSettingsTitle")}
        </h1>
        <p className="text-muted-foreground">
          {t("organizationSettingsDescription")}
        </p>
      </header>
      {dirty && (
        <p className="text-muted-foreground" role="status">
          {t("organizationSettingsUnsaved")}
        </p>
      )}
      <form className="space-y-4" onSubmit={submit}>
        <div className="space-y-2">
          <Label htmlFor="organization-name">
            {t("organizationSettingsName")}
          </Label>
          <Input
            id="organization-name"
            autoComplete="organization"
            maxLength={400}
            disabled={saving}
            value={name}
            onChange={(event) => {
              if (saving) return;
              setName(event.target.value);
              setMessage(null);
              setLocalValidation(false);
            }}
            aria-invalid={showValidation || undefined}
            aria-describedby={
              showValidation ? "organization-name-error" : undefined
            }
          />
          {showValidation && (
            <p
              className="form-message"
              id="organization-name-error"
              role="alert"
            >
              {t("organizationSettingsValidation")}
            </p>
          )}
        </div>
        {message === "success" && (
          <p className="form-message" role="status">
            {t("organizationSettingsSaved")}
          </p>
        )}
        {message === "stale" && (
          <div className="space-y-2" role="alert">
            <p className="form-message">{t("organizationSettingsStale")}</p>
            <Button
              type="button"
              variant="outline"
              onClick={() => void reload()}
            >
              {t("organizationSettingsReload")}
            </Button>
          </div>
        )}
        {message === "error" && (
          <p className="form-message" role="alert">
            {t("organizationSettingsSaveError")}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            type="submit"
            disabled={saving || !dirty || message === "stale"}
          >
            {saving ? t("organizationSettingsSaving") : t("saveChanges")}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={saving || !dirty}
            onClick={() => {
              setName(savedName);
              setMessage(null);
              setLocalValidation(false);
            }}
          >
            {t("cancel")}
          </Button>
        </div>
      </form>
    </section>
  );
}
