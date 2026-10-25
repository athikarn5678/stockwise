"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ProfileApiError,
  fetchSelfProfile,
  updateSelfProfile,
} from "@/profile-api-client";
import { useLanguage } from "@/providers/language-provider";
import { useAccountDraft } from "@/providers/account-draft";
import { currentPrivateSessionSignal } from "@/session-lifecycle";

export function SelfProfile() {
  const { t } = useLanguage();
  const queryClient = useQueryClient();
  const { restored: candidate, remember } = useAccountDraft("profile");
  const restored = candidate && "displayName" in candidate ? candidate : null;
  const profileQuery = useQuery({
    queryKey: ["self-profile"],
    queryFn: ({ signal }) => fetchSelfProfile({ signal }),
    retry: false,
  });
  const profile = profileQuery.data;
  const [displayName, setDisplayName] = useState(restored?.displayName ?? "");
  const [phone, setPhone] = useState(restored?.phone ?? "");
  const [saved, setSaved] = useState(
    restored?.saved ?? { displayName: "", phone: "" },
  );
  const [baseUpdatedAt, setBaseUpdatedAt] = useState<string | null>(
    restored?.baseUpdatedAt ?? null,
  );
  const [message, setMessage] = useState<
    "success" | "stale" | "validation" | "error" | null
  >(null);
  const [saving, setSaving] = useState(false);
  const [localValidation, setLocalValidation] = useState(false);
  const dirty =
    profile !== undefined &&
    (displayName !== saved.displayName || phone !== saved.phone);

  useEffect(() => {
    remember(
      dirty || (restored && !profile)
        ? { displayName, phone, saved, baseUpdatedAt }
        : null,
    );
  }, [
    dirty,
    profile,
    restored,
    displayName,
    phone,
    saved,
    baseUpdatedAt,
    remember,
  ]);

  // Update the initial values on first load and refetch only while untouched.
  useEffect(() => {
    if (!profile || dirty) return;
    const next = {
      displayName: profile.displayName ?? "",
      phone: profile.phone ?? "",
    };
    setSaved(next);
    setDisplayName(next.displayName);
    setPhone(next.phone);
    setBaseUpdatedAt(profile.updatedAt);
  }, [profile, dirty]);

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
      if (!window.confirm(t("profileUnsavedConfirm"))) {
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
    if (!profile || baseUpdatedAt === null) return;
    const name = displayName.trim();
    const trimmedPhone = phone.trim();
    if (!name || name.length > 200 || trimmedPhone.length > 32) {
      setLocalValidation(true);
      setMessage("validation");
      return;
    }
    setLocalValidation(false);
    setMessage(null);
    setSaving(true);
    const authoritySignal = currentPrivateSessionSignal();
    try {
      const updated = await updateSelfProfile({
        displayName: name,
        phone: trimmedPhone,
        expectedUpdatedAt: baseUpdatedAt,
      });
      authoritySignal.throwIfAborted();
      queryClient.setQueryData(["self-profile"], updated);
      queryClient.setQueryData(
        ["access-context"],
        (current: { user: { displayName: string | null } } | undefined) =>
          current
            ? {
                ...current,
                user: { ...current.user, displayName: updated.displayName },
              }
            : current,
      );
      await queryClient.invalidateQueries({
        queryKey: ["access-context"],
        refetchType: "none",
      });
      void queryClient.refetchQueries({
        queryKey: ["access-context"],
        type: "active",
      });
      const next = {
        displayName: updated.displayName ?? "",
        phone: updated.phone ?? "",
      };
      setSaved(next);
      setDisplayName(next.displayName);
      setPhone(next.phone);
      setBaseUpdatedAt(updated.updatedAt);
      setMessage("success");
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError"))
        setMessage(
          error instanceof ProfileApiError && error.kind !== "unavailable"
            ? error.kind
            : "error",
        );
    } finally {
      setSaving(false);
    }
  }

  async function reloadAfterConflict() {
    const result = await profileQuery.refetch();
    if (!result.data) return;
    const next = {
      displayName: result.data.displayName ?? "",
      phone: result.data.phone ?? "",
    };
    setSaved(next);
    setDisplayName(next.displayName);
    setPhone(next.phone);
    setBaseUpdatedAt(result.data.updatedAt);
    setMessage(null);
    setLocalValidation(false);
  }

  if (profileQuery.isPending)
    return <p aria-live="polite">{t("profileLoading")}</p>;
  if (profileQuery.isError)
    return (
      <section className="w-full max-w-2xl space-y-4">
        <h1 className="text-2xl font-semibold">{t("profileTitle")}</h1>
        <p role="alert">{t("profileLoadError")}</p>
        <Button type="button" onClick={() => void profileQuery.refetch()}>
          {t("profileRetry")}
        </Button>
      </section>
    );
  return (
    <section className="w-full max-w-2xl space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">{t("profileTitle")}</h1>
        <p className="text-muted-foreground">{t("profileDescription")}</p>
      </header>
      <form
        className="space-y-5 rounded-lg border bg-card p-5"
        onSubmit={submit}
        noValidate
      >
        <div className="space-y-2">
          <Label htmlFor="profile-email">{t("profileEmail")}</Label>
          <Input id="profile-email" readOnly value={profileQuery.data.email} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="profile-name">{t("profileName")}</Label>
          <Input
            id="profile-name"
            autoComplete="name"
            maxLength={200}
            required
            value={displayName}
            disabled={saving}
            aria-invalid={localValidation && !displayName.trim()}
            aria-describedby={
              localValidation ? "profile-validation" : undefined
            }
            onChange={(event) => {
              setDisplayName(event.target.value);
              setMessage(null);
              setLocalValidation(false);
            }}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="profile-phone">{t("profilePhone")}</Label>
          <Input
            id="profile-phone"
            autoComplete="tel"
            maxLength={32}
            value={phone}
            disabled={saving}
            onChange={(event) => {
              setPhone(event.target.value);
              setMessage(null);
              setLocalValidation(false);
            }}
          />
        </div>
        {dirty ? (
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {t("profileUnsaved")}
          </p>
        ) : null}
        {message === "success" ? (
          <p role="status" className="text-sm">
            {t("profileSaved")}
          </p>
        ) : null}
        {message && message !== "success" ? (
          <div>
            <p
              id={message === "validation" ? "profile-validation" : undefined}
              role="alert"
              className="text-sm text-destructive"
            >
              {t(
                message === "stale"
                  ? "profileStale"
                  : message === "validation"
                    ? "profileValidation"
                    : "profileError",
              )}
            </p>
            {message === "stale" ? (
              <Button
                className="mt-2"
                type="button"
                variant="outline"
                onClick={() => void reloadAfterConflict()}
              >
                {t("profileReload")}
              </Button>
            ) : null}
          </div>
        ) : null}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="outline"
            disabled={!dirty || saving}
            onClick={() => {
              setDisplayName(saved.displayName);
              setPhone(saved.phone);
              setMessage(null);
              setLocalValidation(false);
            }}
          >
            {t("cancel")}
          </Button>
          <Button type="submit" disabled={!dirty || saving}>
            {saving ? t("profileSaving") : t("saveChanges")}
          </Button>
        </div>
      </form>
    </section>
  );
}
