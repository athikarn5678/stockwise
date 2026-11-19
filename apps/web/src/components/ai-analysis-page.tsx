"use client";

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import {
  AiAnalysisApiError,
  createRun,
  listRuns,
  retryRun,
  type AiAnalysisDays,
  type AiAnalysisLanguage,
  type AiAnalysisRun,
  type AiAnalysisRunPage,
  type AiAnalysisScope,
} from "@/ai-analysis-api-client";
import {
  fetchBranches,
  type AccessibleOrganization,
} from "@/branch-api-client";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import type { TranslationKey } from "@/i18n/en";
import { useLanguage } from "@/providers/language-provider";

const DAY_OPTIONS = [7, 14, 30] as const satisfies readonly AiAnalysisDays[];

const LANGUAGE_LABELS: Record<AiAnalysisLanguage, TranslationKey> = {
  en: "aiAnalysisLanguageEn",
  th: "aiAnalysisLanguageTh",
};

/** Same roles the API authorizes for the three insight permissions. */
export function mayAnalyze(organization: AccessibleOrganization) {
  if (organization.role === "OWNER" || organization.role === "ADMIN")
    return true;
  return (
    organization.role === "BRANCH_MANAGER" && organization.branches.length > 0
  );
}

function createdTime(run: AiAnalysisRun, language: AiAnalysisLanguage): string {
  return new Intl.DateTimeFormat(
    language === "th" ? "th-TH-u-ca-gregory" : "en",
    {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: run.period.timezone,
    },
  ).format(new Date(run.createdAt));
}

function errorKey(error: unknown): TranslationKey {
  if (error instanceof AiAnalysisApiError) {
    if (error.status === 429) return "aiAnalyzeErrRate";
    if (error.status === 401 || error.status === 403 || error.status === 404)
      return "aiAnalyzeErrAccess";
    if (error.status === 422) return "aiAnalyzeErrInsufficient";
    if (error.status === 502) return "aiAnalyzeErrProvider";
  }
  return "aiAnalyzeErrLoad";
}

export function AiAnalysisContent({
  organization,
  selectedBranchId,
}: {
  organization: AccessibleOrganization;
  selectedBranchId: string | null;
}) {
  const { t, language } = useLanguage();
  const queryClient = useQueryClient();
  const wide = organization.role === "OWNER" || organization.role === "ADMIN";
  const [scopeValue, setScopeValue] = useState(
    wide
      ? "organization"
      : (selectedBranchId ?? organization.branches[0]?.id ?? ""),
  );
  const [days, setDays] = useState<AiAnalysisDays>(7);
  // Display only: switching never calls the API.
  const [viewLanguage, setViewLanguage] =
    useState<AiAnalysisLanguage>(language);
  const [viewer, setViewer] = useState<AiAnalysisRun | null>(null);
  const branchesQuery = useQuery({
    queryKey: ["branches", organization.id, true],
    queryFn: () => fetchBranches(organization.id, true),
    enabled: wide,
  });
  const branches = wide
    ? (branchesQuery.data ?? organization.branches)
    : organization.branches;
  const branch = branches.find((candidate) => candidate.id === scopeValue);
  const scope: AiAnalysisScope =
    wide && scopeValue === "organization"
      ? { scope: "organization" }
      : { scope: "branch", branchId: branch?.id ?? "" };
  const enabled = scope.scope === "organization" || scope.branchId !== "";
  const scopeItems = [
    ...(wide
      ? [{ value: "organization", label: t("aiAnalysisAllBranches") }]
      : []),
    ...branches.map((item) => ({
      value: item.id,
      label: `${item.code} — ${item.name}${
        "status" in item && item.status === "INACTIVE"
          ? t("aiInactiveSuffix")
          : ""
      }`,
    })),
  ];
  const dayItems = DAY_OPTIONS.map((option) => ({
    value: String(option),
    label: t("aiAnalysisDaysOption").replace("{days}", String(option)),
  }));
  const historyQuery = useInfiniteQuery<
    AiAnalysisRunPage,
    Error,
    InfiniteData<AiAnalysisRunPage>,
    readonly unknown[],
    string | null
  >({
    enabled,
    getNextPageParam: (page) => page.meta.nextCursor,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      listRuns(organization.id, scope, pageParam, signal),
    queryKey: [
      "ai-analysis",
      organization.id,
      scope.scope,
      scope.scope === "branch" ? scope.branchId : null,
    ],
  });
  const runs = historyQuery.data?.pages.flatMap((page) => page.data) ?? [];
  // Show a run; if the viewed language is the missing one, show the other.
  const showRun = (run: AiAnalysisRun) => {
    setViewer(run);
    setViewLanguage((current) => {
      const other = current === "th" ? "en" : "th";
      return run.missing.includes(current) && !run.missing.includes(other)
        ? other
        : current;
    });
  };
  const createMutation = useMutation({
    mutationFn: () => createRun(organization.id, scope, days),
    onSuccess: (run) => {
      showRun(run);
      void queryClient.invalidateQueries({
        queryKey: ["ai-analysis", organization.id],
      });
    },
  });
  const retryMutation = useMutation({
    mutationFn: (request: { language: AiAnalysisLanguage; runId: string }) =>
      retryRun(organization.id, scope, request.runId, request.language),
    onSuccess: (run) => {
      showRun(run);
      void queryClient.invalidateQueries({
        queryKey: ["ai-analysis", organization.id],
      });
    },
  });
  // A late response must not land under a different scope selector.
  const busy = createMutation.isPending || retryMutation.isPending;
  // 429: count the Retry-After seconds down, then re-enable Generate.
  const rateError = [createMutation.error, retryMutation.error].find(
    (error): error is AiAnalysisApiError =>
      error instanceof AiAnalysisApiError && error.status === 429,
  );
  const rateWait = rateError?.retryAfterSeconds ?? (rateError ? 60 : 0);
  const [cooldown, setCooldown] = useState(0);
  useEffect(() => {
    if (rateError === undefined) {
      setCooldown(0);
      return;
    }
    setCooldown(rateWait);
    const timer = setInterval(() => {
      setCooldown((value) => {
        if (value <= 1) {
          clearInterval(timer);
          return 0;
        }
        return value - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [rateError, rateWait]);
  const retryError = retryMutation.isError ? retryMutation.error : null;
  const missingLanguage =
    viewer !== null && viewer.missing.length === 1
      ? (viewer.missing[0] ?? null)
      : null;
  const sections = viewer?.languages[viewLanguage] ?? null;
  const viewerMissing =
    viewer !== null && viewer.missing.includes(viewLanguage);

  return (
    <section aria-label={t("aiAnalysisTitle")} className="w-full space-y-6">
      <header className="space-y-2">
        <h2 className="text-xl font-semibold">{t("aiAnalysisTitle")}</h2>
        <p className="max-w-3xl text-sm text-muted-foreground">
          {t("aiAnalysisIntro")}
        </p>
      </header>

      <div className="space-y-4 rounded-lg border bg-card p-4 sm:p-5">
        <div className="grid max-w-4xl gap-4 sm:grid-cols-2">
          <div className="form-field">
            <Label htmlFor="ai-analysis-scope">{t("aiScope")}</Label>
            <Select
              disabled={busy}
              id="ai-analysis-scope"
              items={scopeItems}
              onValueChange={(next) => {
                if (typeof next !== "string") return;
                createMutation.reset();
                retryMutation.reset();
                setViewer(null);
                setScopeValue(next);
              }}
              value={
                scope.scope === "organization" ? "organization" : scope.branchId
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {scopeItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="form-field">
            <Label htmlFor="ai-analysis-days">{t("aiAnalysisDays")}</Label>
            <Select
              disabled={busy}
              id="ai-analysis-days"
              items={dayItems}
              onValueChange={(next) =>
                setDays(next === "30" ? 30 : next === "14" ? 14 : 7)
              }
              value={String(days)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {dayItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {wide && branchesQuery.isError ? (
          <p className="text-sm form-message" role="alert">
            {t("aiBranchesError")}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <Button
            disabled={!enabled || createMutation.isPending || cooldown > 0}
            onClick={() => createMutation.mutate()}
            type="button"
          >
            {createMutation.isPending ? (
              <>
                <Loader2 aria-hidden="true" className="animate-spin" />
                {t("aiAnalysisGenerating")}
              </>
            ) : cooldown > 0 ? (
              t("aiAnalysisCooldown").replace("{seconds}", String(cooldown))
            ) : (
              t("aiAnalysisGenerate")
            )}
          </Button>
          <div
            aria-label={t("aiAnalysisLanguageSwitch")}
            className="flex items-center gap-1"
            role="group"
          >
            {(["th", "en"] as const).map((option) => (
              <Button
                aria-pressed={viewLanguage === option}
                key={option}
                onClick={() => setViewLanguage(option)}
                type="button"
                variant={viewLanguage === option ? "secondary" : "outline"}
              >
                {t(LANGUAGE_LABELS[option])}
              </Button>
            ))}
          </div>
        </div>

        {createMutation.isPending ? (
          <div aria-live="polite" className="space-y-1">
            <p className="text-sm text-muted-foreground">
              {t("aiAnalysisGenerating")}
            </p>
          </div>
        ) : null}
        {createMutation.isPending ? <AnalysisSkeleton /> : null}
        {createMutation.isError ? (
          <p className="text-sm form-message" role="alert">
            {t(errorKey(createMutation.error))}
          </p>
        ) : null}

        {viewer !== null && !createMutation.isPending ? (
          <article
            aria-label={t("aiAnalysisTitle")}
            className="rounded-lg border bg-card p-4"
          >
            <div className="flex flex-wrap items-center gap-2">
              {viewer.mock ? (
                <span className="rounded-full border px-2 py-0.5 text-xs font-medium">
                  {t("aiAnalyzeMockBadge")}
                </span>
              ) : null}
              <p className="text-sm text-muted-foreground">
                {t("aiAnalyzePeriod").replace(
                  "{period}",
                  `${viewer.period.from} – ${viewer.period.to} (${viewer.period.timezone})`,
                )}
              </p>
            </div>
            <p className="text-sm text-muted-foreground">
              {t("aiAnalysisModel").replace("{model}", viewer.model)}
            </p>
            {viewer.mock ? (
              <p className="mt-1 text-sm text-muted-foreground">
                {t("aiAnalyzeMockNote")}
              </p>
            ) : null}

            {missingLanguage !== null &&
            viewer.id !== null &&
            sections !== null ? (
              <div className="mt-3 space-y-2 rounded-md border p-3">
                <p role="status">{t("aiAnalysisMissing")}</p>
                <Button
                  disabled={retryMutation.isPending}
                  onClick={() => {
                    if (viewer.id === null) return;
                    retryMutation.mutate({
                      language: missingLanguage,
                      runId: viewer.id,
                    });
                  }}
                  type="button"
                >
                  {retryMutation.isPending ? (
                    <>
                      <Loader2 aria-hidden="true" className="animate-spin" />
                      {t("aiAnalysisRetrying")}
                    </>
                  ) : (
                    t("aiAnalysisRetry").replace(
                      "{language}",
                      t(LANGUAGE_LABELS[missingLanguage]),
                    )
                  )}
                </Button>
              </div>
            ) : null}
            {sections === null ? (
              <div className="mt-4 space-y-3">
                <p role="alert">{t("aiAnalysisMissing")}</p>
                {viewerMissing && viewer.id !== null ? (
                  <Button
                    disabled={retryMutation.isPending}
                    onClick={() => {
                      if (viewer.id === null) return;
                      retryMutation.mutate({
                        language: viewLanguage,
                        runId: viewer.id,
                      });
                    }}
                    type="button"
                  >
                    {retryMutation.isPending
                      ? t("aiAnalysisRetrying")
                      : t("aiAnalysisRetry").replace(
                          "{language}",
                          t(LANGUAGE_LABELS[viewLanguage]),
                        )}
                  </Button>
                ) : null}
              </div>
            ) : (
              sections.map((section) => (
                <div className="mt-4" key={section.heading}>
                  <h3 className="text-base font-semibold">{section.heading}</h3>
                  <p className="mt-1 whitespace-pre-wrap break-words">
                    {section.body}
                  </p>
                </div>
              ))
            )}
            {retryError !== null ? (
              <p className="mt-3 text-sm form-message" role="alert">
                {t(errorKey(retryError))}
              </p>
            ) : null}
          </article>
        ) : null}
      </div>

      <section
        aria-label={t("aiAnalysisHistory")}
        className="space-y-3 rounded-lg border bg-card p-4 sm:p-5"
      >
        <h2 className="text-xl font-semibold">{t("aiAnalysisHistory")}</h2>
        {!enabled ? (
          <p>{t("aiChooseBranch")}</p>
        ) : historyQuery.isPending ? (
          <p aria-live="polite">{t("aiAnalysisHistoryLoading")}</p>
        ) : historyQuery.isError ? (
          <p role="alert">{t("aiAnalysisHistoryError")}</p>
        ) : runs.length === 0 ? (
          <p>{t("aiAnalysisHistoryEmpty")}</p>
        ) : (
          <ul className="space-y-2">
            {runs.map((run) => {
              const missingLanguage =
                run.missing.length === 1 ? run.missing[0] : undefined;
              return (
                <li key={run.id ?? run.createdAt}>
                  <button
                    className="w-full rounded-md border p-3 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                    disabled={busy}
                    onClick={() => {
                      createMutation.reset();
                      retryMutation.reset();
                      showRun(run);
                    }}
                    type="button"
                  >
                    <span className="block text-sm font-medium">
                      {t("aiAnalysisHistoryItem")
                        .replace("{time}", createdTime(run, language))
                        .replace("{days}", String(run.days))
                        .replace("{model}", run.model)}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {t("aiAnalyzePeriod").replace(
                        "{period}",
                        `${run.period.from} – ${run.period.to}`,
                      )}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {missingLanguage === undefined
                        ? t("aiAnalysisHistoryBothLanguages")
                        : t("aiAnalysisHistoryOneLanguage").replace(
                            "{language}",
                            t(LANGUAGE_LABELS[missingLanguage]),
                          )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {historyQuery.hasNextPage ? (
          <Button
            disabled={historyQuery.isFetchingNextPage}
            onClick={() => void historyQuery.fetchNextPage()}
            type="button"
            variant="outline"
          >
            {t("aiAnalysisHistoryLoadMore")}
          </Button>
        ) : null}
        <p className="text-xs text-muted-foreground">
          <Link
            className="underline"
            href={`/app/analytics?organizationId=${organization.id}&branchId=${selectedBranchId ?? ""}`}
          >
            {t("analytics")}
          </Link>
        </p>
      </section>
    </section>
  );
}

function AnalysisSkeleton() {
  return (
    <div aria-hidden="true" className="space-y-4">
      {[0, 1, 2, 3, 4].map((index) => (
        <div className="space-y-2" key={index}>
          <Skeleton className="h-5 w-2/5" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-11/12" />
          {index % 2 === 0 ? <Skeleton className="h-3 w-3/4" /> : null}
        </div>
      ))}
    </div>
  );
}
