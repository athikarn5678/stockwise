"use client";

import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";

import { resolveApplicationContext } from "@/application-context";
import { fetchAccessContext } from "@/branch-api-client";
import { OrganizationSettings } from "@/components/organization-settings";
import { SelfProfile } from "@/components/self-profile";
import { useLanguage } from "@/providers/language-provider";

/**
 * One Settings page: the profile card for everyone and the organization card
 * only for the roles that may manage it today (OWNER and ADMIN). The API stays
 * the authorization boundary; hiding the card is a UX rule.
 */
export function SettingsPage() {
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
  const mayManageOrganization =
    organization?.role === "OWNER" || organization?.role === "ADMIN";

  return (
    <div className="w-full max-w-3xl space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">{t("settingsTitle")}</h1>
        <p className="text-muted-foreground">{t("settingsDescription")}</p>
      </header>
      <section
        aria-label={t("profileTitle")}
        className="rounded-lg border bg-card p-5 sm:p-6"
      >
        <SelfProfile embedded />
      </section>
      {mayManageOrganization ? (
        <section
          aria-label={t("organizationSettingsTitle")}
          className="rounded-lg border bg-card p-5 sm:p-6"
        >
          <OrganizationSettings embedded />
        </section>
      ) : null}
    </div>
  );
}

export function SettingsPageFallback() {
  const { t } = useLanguage();
  return <p aria-live="polite">{t("settingsLoading")}</p>;
}
