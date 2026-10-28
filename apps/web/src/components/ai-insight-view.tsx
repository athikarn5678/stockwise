"use client";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import type { TranslationKey } from "@/i18n/en";
import { useLanguage } from "@/providers/language-provider";

import {
  getLatestInsight,
  InsightApiError,
  type InsightCadence,
  type InsightScope,
} from "@/ai-insight-api-client";
import {
  fetchBranches,
  type AccessibleOrganization,
} from "@/branch-api-client";

function period(
  report: {
    periodStartInclusive: string;
    periodEndExclusive: string;
    reportingTimezone: string;
  },
  language: "en" | "th",
) {
  const format = new Intl.DateTimeFormat(
    language === "th" ? "th-TH-u-ca-gregory" : "en",
    {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: report.reportingTimezone,
    },
  );
  return `${format.format(new Date(report.periodStartInclusive))}–${format.format(new Date(Date.parse(report.periodEndExclusive) - 1))}`;
}

function errorMessage(error: unknown, t: (key: TranslationKey) => string) {
  if (error instanceof InsightApiError) {
    if (error.status === 401) return t("aiErr401");
    if (error.status === 403 || error.status === 404) return t("aiErrAccess");
    if (error.status === 400) return t("aiErrInvalid");
  }
  return t("aiErrLoad");
}

export function AiInsightView({
  organization,
  selectedBranchId,
}: {
  organization: AccessibleOrganization;
  selectedBranchId: string | null;
}) {
  const { t, language } = useLanguage();
  const wide = organization.role === "OWNER" || organization.role === "ADMIN";
  const [scopeValue, setScopeValue] = useState(
    wide
      ? "organization"
      : (selectedBranchId ?? organization.branches[0]?.id ?? ""),
  );
  const [cadence, setCadence] = useState<InsightCadence>("DAILY");
  const branchesQuery = useQuery({
    queryKey: ["branches", organization.id, true],
    queryFn: () => fetchBranches(organization.id, true),
    enabled: wide,
  });
  const branches = wide
    ? (branchesQuery.data ?? organization.branches)
    : organization.branches;
  const branch = branches.find((candidate) => candidate.id === scopeValue);
  const scope: InsightScope =
    wide && scopeValue === "organization"
      ? { scope: "organization" }
      : { scope: "branch", branchId: branch?.id ?? "" };
  const enabled = scope.scope === "organization" || scope.branchId !== "";
  const insightQuery = useQuery({
    queryKey: [
      "ai-insights",
      organization.id,
      scope.scope,
      scope.scope === "branch" ? scope.branchId : null,
      cadence,
    ],
    queryFn: ({ signal }) =>
      getLatestInsight(organization.id, scope, cadence, signal),
    enabled,
  });
  const latest = insightQuery.data?.latest;
  const success = insightQuery.data?.lastSuccess;

  return (
    <section aria-label={t("aiTitle")} className="space-y-5">
      <div className="rounded-lg border bg-card p-4 sm:p-5">
        <h2 className="text-xl font-semibold">{t("aiTitle")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("aiIntroBefore")}{" "}
          <Link
            className="underline"
            href={`/app/analytics?organizationId=${organization.id}&branchId=${selectedBranchId ?? ""}`}
          >
            {t("aiIntroLink")}
          </Link>{" "}
          {t("aiIntroAfter")}
        </p>
        <div className="mt-4 grid max-w-4xl gap-4 sm:grid-cols-2">
          <Label className="form-field">
            {t("aiScope")}
            <NativeSelect
              className="w-full "
              onChange={(event) => setScopeValue(event.target.value)}
              value={
                scope.scope === "organization" ? "organization" : scope.branchId
              }
            >
              {wide ? (
                <NativeSelectOption value="organization">
                  {t("aiAllBranches")}
                </NativeSelectOption>
              ) : null}
              {branches.map((item) => (
                <NativeSelectOption key={item.id} value={item.id}>
                  {item.code} — {item.name}
                  {"status" in item && item.status === "INACTIVE"
                    ? t("aiInactiveSuffix")
                    : ""}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Label>
          <Label className="form-field">
            {t("aiCadence")}
            <NativeSelect
              className="w-full "
              onChange={(event) =>
                setCadence(event.target.value as InsightCadence)
              }
              value={cadence}
            >
              <NativeSelectOption value="DAILY">
                {t("cadenceDaily")}
              </NativeSelectOption>
              <NativeSelectOption value="WEEKLY">
                {t("cadenceWeekly")}
              </NativeSelectOption>
              <NativeSelectOption value="MONTHLY">
                {t("cadenceMonthly")}
              </NativeSelectOption>
              <NativeSelectOption value="YEARLY">
                {t("cadenceYearly")}
              </NativeSelectOption>
            </NativeSelect>
          </Label>
        </div>
        {wide && branchesQuery.isPending ? (
          <p className="mt-2 text-sm" aria-live="polite">
            {t("aiLoadingBranches")}
          </p>
        ) : null}
        {wide && branchesQuery.isError ? (
          <p className="mt-2 text-sm form-message" role="alert">
            {t("aiBranchesError")}
          </p>
        ) : null}
      </div>

      {!enabled ? (
        <p>{t("aiChooseBranch")}</p>
      ) : insightQuery.isPending ? (
        <p aria-live="polite">{t("aiLoadingInsight")}</p>
      ) : insightQuery.isError ? (
        <p className="form-message" role="alert">
          {errorMessage(insightQuery.error, t)}
        </p>
      ) : !latest ? (
        <p className="rounded-lg border bg-card p-4">{t("aiNone")}</p>
      ) : (
        <>
          <div className="rounded-lg border bg-card p-4" role="status">
            <p className="font-medium">
              {latest.state === "SUCCEEDED"
                ? t("aiStateSucceeded")
                : latest.state === "FAILED"
                  ? t("aiStateFailed")
                  : latest.state === "INSUFFICIENT"
                    ? t("aiStateInsufficient")
                    : t("aiStatePreparing")}
            </p>
            <p className="mt-1 text-sm">
              {t("aiLatestPeriod").replace(
                "{period}",
                period(latest, language),
              )}
            </p>
            {insightQuery.data.stale && success ? (
              <p className="mt-1 text-sm">{t("aiStale")}</p>
            ) : null}
            {!success ? (
              <p className="mt-1 text-sm">{t("aiNoSuccess")}</p>
            ) : null}
          </div>
          {success?.content ? (
            <article className="rounded-lg border bg-card p-4 sm:p-5">
              <h3 className="text-lg font-semibold">{t("aiSuccessTitle")}</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {t("aiReportPeriod").replace(
                  "{period}",
                  period(success, language),
                )}{" "}
                · {success.reportingTimezone}
              </p>
              {success.completedAt ? (
                <p className="text-sm text-muted-foreground">
                  {t("aiCompleted")}{" "}
                  {new Intl.DateTimeFormat(
                    language === "th" ? "th-TH-u-ca-gregory" : "en",
                    {
                      dateStyle: "medium",
                      timeStyle: "short",
                      timeZone: success.reportingTimezone,
                    },
                  ).format(new Date(success.completedAt))}
                </p>
              ) : null}
              <p className="mt-4 whitespace-pre-wrap break-words">
                {success.content}
              </p>
            </article>
          ) : null}
        </>
      )}
    </section>
  );
}
