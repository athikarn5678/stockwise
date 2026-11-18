"use client";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";

import { useMutation, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import type { TranslationKey } from "@/i18n/en";
import { useLanguage } from "@/providers/language-provider";

import {
  getDemoInsight,
  InsightApiError,
  listStoredInsights,
  postAnalyze,
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

function analyzeErrorMessage(
  error: unknown,
  t: (key: TranslationKey) => string,
) {
  if (error instanceof InsightApiError) {
    if (error.status === 429) return t("aiAnalyzeErrRate");
    if (error.status === 401 || error.status === 403 || error.status === 404)
      return t("aiAnalyzeErrAccess");
    if (error.status === 502) return t("aiAnalyzeErrProvider");
  }
  return t("aiAnalyzeErrLoad");
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
  const [cadence, setCadence] = useState<InsightCadence>("WEEKLY");
  const [selectedPeriodId, setSelectedPeriodId] = useState<string | null>(null);
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
  const reportsQuery = useQuery({
    queryKey: [
      "ai-insights",
      organization.id,
      scope.scope,
      scope.scope === "branch" ? scope.branchId : null,
      cadence,
    ],
    queryFn: ({ signal }) =>
      listStoredInsights(organization.id, scope, cadence, signal),
    enabled,
  });
  // The list is newest first, and only completed reports carry report text.
  const periods = (reportsQuery.data ?? []).filter(
    (report) =>
      report.state === "SUCCEEDED" && (report.content ?? "").trim() !== "",
  );
  // `null` means "the newest stored report", so switching scope or cadence
  // always restarts at the newest report of the new list.
  const selected =
    (selectedPeriodId === null
      ? undefined
      : periods.find((report) => report.id === selectedPeriodId)) ??
    periods[0] ??
    null;
  const analyzeMutation = useMutation({
    mutationFn: () => postAnalyze(organization.id, scope, language, 7),
  });
  const analysis = analyzeMutation.data;

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
              onChange={(event) => {
                analyzeMutation.reset();
                setSelectedPeriodId(null);
                setScopeValue(event.target.value);
              }}
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
              onChange={(event) => {
                setSelectedPeriodId(null);
                setCadence(event.target.value as InsightCadence);
              }}
              value={cadence}
            >
              <NativeSelectOption value="WEEKLY">
                {t("cadenceWeekly")}
              </NativeSelectOption>
              <NativeSelectOption value="MONTHLY">
                {t("cadenceMonthly")}
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
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button
            disabled={!enabled || analyzeMutation.isPending}
            onClick={() => analyzeMutation.mutate()}
            type="button"
          >
            {t("aiAnalyze")}
          </Button>
          <p aria-live="polite" className="text-sm">
            {analyzeMutation.isPending ? t("aiAnalyzeLoading") : ""}
          </p>
        </div>
        {analyzeMutation.isError ? (
          <p className="mt-2 text-sm form-message" role="alert">
            {analyzeErrorMessage(analyzeMutation.error, t)}
          </p>
        ) : null}
        {analysis ? (
          <article
            aria-label={t("aiAnalyzeTitle")}
            className="mt-4 rounded-lg border bg-card p-4"
          >
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-lg font-semibold">{t("aiAnalyzeTitle")}</h3>
              {analysis.mock ? (
                <span className="rounded-full border px-2 py-0.5 text-xs font-medium">
                  {t("aiAnalyzeMockBadge")}
                </span>
              ) : null}
            </div>
            {analysis.mock ? (
              <p className="mt-1 text-sm text-muted-foreground">
                {t("aiAnalyzeMockNote")}
              </p>
            ) : null}
            <p className="mt-1 text-sm text-muted-foreground">
              {t("aiAnalyzePeriod").replace(
                "{period}",
                `${analysis.period.from} – ${analysis.period.to} (${analysis.period.timezone})`,
              )}
            </p>
            {analysis.sections.map((section) => (
              <div className="mt-4" key={section.heading}>
                <h4 className="text-base font-semibold">{section.heading}</h4>
                <p className="mt-1 whitespace-pre-wrap break-words">
                  {section.body}
                </p>
              </div>
            ))}
          </article>
        ) : null}
      </div>

      {enabled ? (
        <DemoInsight organizationId={organization.id} scope={scope} />
      ) : null}

      {!enabled ? (
        <p>{t("aiChooseBranch")}</p>
      ) : (
        <>
          <div className="rounded-lg border bg-card p-4">
            <Label className="form-field max-w-md">
              {t("aiReportPeriodPicker")}
              <NativeSelect
                className="w-full"
                disabled={reportsQuery.isPending || periods.length === 0}
                onChange={(event) => setSelectedPeriodId(event.target.value)}
                value={selected?.id ?? ""}
              >
                {periods.length === 0 ? (
                  <NativeSelectOption value="">
                    {t("aiNoReportPeriods")}
                  </NativeSelectOption>
                ) : (
                  periods.map((report) => (
                    <NativeSelectOption key={report.id} value={report.id}>
                      {period(report, language)}
                    </NativeSelectOption>
                  ))
                )}
              </NativeSelect>
            </Label>
          </div>
          {reportsQuery.isPending ? (
            <p aria-live="polite">{t("aiLoadingInsight")}</p>
          ) : reportsQuery.isError ? (
            <p className="form-message" role="alert">
              {errorMessage(reportsQuery.error, t)}
            </p>
          ) : !selected ? (
            <p className="rounded-lg border bg-card p-4">{t("aiNone")}</p>
          ) : (
            <article className="rounded-lg border bg-card p-4 sm:p-5">
              <h3 className="text-lg font-semibold">{t("aiSuccessTitle")}</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {t("aiReportPeriod").replace(
                  "{period}",
                  period(selected, language),
                )}{" "}
                · {selected.reportingTimezone}
              </p>
              {selected.completedAt ? (
                <p className="text-sm text-muted-foreground">
                  {t("aiCompleted")}{" "}
                  {new Intl.DateTimeFormat(
                    language === "th" ? "th-TH-u-ca-gregory" : "en",
                    {
                      dateStyle: "medium",
                      timeStyle: "short",
                      timeZone: selected.reportingTimezone,
                    },
                  ).format(new Date(selected.completedAt))}
                </p>
              ) : null}
              <p className="mt-4 whitespace-pre-wrap break-words">
                {selected.content}
              </p>
            </article>
          )}
        </>
      )}
    </section>
  );
}

function DemoInsight({
  organizationId,
  scope,
}: {
  organizationId: string;
  scope: InsightScope;
}) {
  const { language } = useLanguage();
  const query = useQuery({
    queryKey: [
      "demo-insight",
      organizationId,
      scope.scope,
      scope.scope === "branch" ? scope.branchId : null,
      language,
    ],
    queryFn: ({ signal }) =>
      getDemoInsight(organizationId, scope, language, signal),
  });
  if (query.isError)
    return (
      <p role="alert">
        {language === "th"
          ? "โหลดข้อมูลตัวอย่างไม่สำเร็จ"
          : "Demo Insight could not be loaded."}
      </p>
    );
  if (!query.data) return null;
  return (
    <article
      aria-label={query.data.label}
      className="rounded-lg border bg-card p-4 sm:p-5"
    >
      <h3 className="text-lg font-semibold">{query.data.label}</h3>
      <p className="text-sm text-muted-foreground">{query.data.explanation}</p>
      <p className="text-sm text-muted-foreground">
        {query.data.from} – {query.data.to} ({query.data.reportingTimezone})
      </p>
      <p className="mt-3 whitespace-pre-line">{query.data.content}</p>
    </article>
  );
}
