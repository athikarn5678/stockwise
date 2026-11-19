import type {
  AiProvider,
  AiProviderFailureCategory,
  AiProviderFailureDetail,
} from "./ai-provider.ts";
import {
  AiAnalyzeOutputError,
  buildMockAiAnalyzeOutput,
  parseAiAnalyzeOutput,
  splitStoredAiAnalyzeSections,
} from "./ai-analyze-output.ts";
import {
  buildAiAnalyzePrompt,
  type AiAnalyzeLanguage,
} from "./ai-analyze-prompt.ts";
import {
  localDateString,
  publicAnalysisRun,
  type AiAnalysisRunView,
  type AiAnalysisStore,
} from "./ai-analysis-store.ts";
import type {
  AiAnalyzeScope,
  AiAnalyzeSnapshot,
  AiAnalyzeSnapshotOutcome,
  AiAnalyzeSnapshotRequest,
} from "./ai-analyze-snapshot.ts";

const RATE_LIMIT_MILLISECONDS = 60_000;
// The ALB idle timeout is 60 s: a second attempt (25 s timeout) may only start
// when the first ended within 20 s, so a whole run stays under ~50 s.
const SECOND_ATTEMPT_DEADLINE_MILLISECONDS = 20_000;
const RETRYABLE_CATEGORIES: ReadonlySet<AiProviderFailureCategory> = new Set([
  "INVALID_RESPONSE",
  "RATE_LIMITED",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_ERROR",
  "TRANSPORT",
]);
const EMPTY_PERIOD_COOLDOWN_MILLISECONDS = 5_000;
const LANGUAGES = ["th", "en"] as const;

export type AiAnalyzeServiceResult =
  | Readonly<{ kind: "ok"; run: AiAnalysisRunView }>
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "insufficient_data" }>
  | Readonly<{ kind: "rate_limited"; retryAfterSeconds: number }>
  | Readonly<{ category: AiProviderFailureCategory; kind: "provider_failed" }>
  | Readonly<{ kind: "rejected" }>;

type SnapshotBuilder = (
  request: AiAnalyzeSnapshotRequest,
) => Promise<AiAnalyzeSnapshotOutcome>;

type LanguageOutcome =
  | Readonly<{
      kind: "ok";
      language: AiAnalyzeLanguage;
      model: string;
      text: string;
    }>
  | Readonly<{ kind: "rejected"; language: AiAnalyzeLanguage }>
  | Readonly<{
      category: AiProviderFailureCategory;
      detail?: AiProviderFailureDetail | undefined;
      kind: "provider_failed";
      language: AiAnalyzeLanguage;
    }>;

function scopeBranchId(scope: AiAnalyzeScope): string | null {
  return scope.kind === "branch" ? scope.branchId : null;
}

export function createAiAnalyzeService(input: {
  buildSnapshot: SnapshotBuilder;
  now?: () => number;
  /** Failure category only (never content), for operator diagnostics. */
  onLanguageFailure?: (event: {
    attempt: 1 | 2;
    category: string;
    /** finish_reason, content byte length and which check failed; no content. */
    detail?: AiProviderFailureDetail | undefined;
    language: AiAnalyzeLanguage;
  }) => void;
  provider?: AiProvider;
  store: Pick<AiAnalysisStore, "create" | "fillLanguage" | "find">;
}) {
  const now = input.now ?? Date.now;
  // Process-local by user; both actions spend real provider calls.
  const lastRunByActor = new Map<string, number>();

  function consumeAllowance(actorUserId: string): number | null {
    const startedAt = lastRunByActor.get(actorUserId);
    const current = now();
    // Bound the map: entries older than the window can no longer limit anyone.
    for (const [actor, at] of lastRunByActor)
      if (current - at >= RATE_LIMIT_MILLISECONDS) lastRunByActor.delete(actor);
    if (startedAt !== undefined) {
      const elapsed = current - startedAt;
      if (elapsed >= 0 && elapsed < RATE_LIMIT_MILLISECONDS)
        return Math.max(
          1,
          Math.ceil((RATE_LIMIT_MILLISECONDS - elapsed) / 1_000),
        );
    }
    lastRunByActor.set(actorUserId, current);
    return null;
  }

  function modelOf(result: { actualModel: string; requestedModel: string }) {
    // The column is VARCHAR(128); an oversized id must not fail the insert
    // after the provider cost was already spent.
    return (
      result.actualModel.trim() === ""
        ? result.requestedModel
        : result.actualModel
    ).slice(0, 128);
  }

  function parseLanguage(
    language: AiAnalyzeLanguage,
    snapshot: AiAnalyzeSnapshot,
    text: string,
  ): boolean {
    try {
      parseAiAnalyzeOutput({ language, snapshot, text });
      return true;
    } catch (error) {
      if (error instanceof AiAnalyzeOutputError) return false;
      throw error;
    }
  }

  /** No provider configured: sample text for both languages, never stored. */
  function mockRun(snapshot: AiAnalyzeSnapshot): AiAnalysisRunView {
    return {
      createdAt: new Date(now()).toISOString(),
      days: snapshot.period.days,
      id: null,
      languages: {
        en: splitStoredAiAnalyzeSections(
          buildMockAiAnalyzeOutput({ language: "en", snapshot }),
          "en",
        ),
        th: splitStoredAiAnalyzeSections(
          buildMockAiAnalyzeOutput({ language: "th", snapshot }),
          "th",
        ),
      },
      missing: [],
      mock: true,
      model: "mock",
      period: {
        from: snapshot.period.from,
        scope: snapshot.period.scope,
        timezone: snapshot.period.timezone,
        to: snapshot.period.to,
      },
    };
  }

  async function analyze(request: {
    actorUserId: string;
    days: number;
    organizationId: string;
    scope: AiAnalyzeScope;
  }): Promise<AiAnalyzeServiceResult> {
    const previousRun = lastRunByActor.get(request.actorUserId);
    const retryAfterSeconds = consumeAllowance(request.actorUserId);
    if (retryAfterSeconds !== null)
      return { kind: "rate_limited", retryAfterSeconds };

    const snapshotOutcome = await input.buildSnapshot({
      actorUserId: request.actorUserId,
      days: request.days,
      organizationId: request.organizationId,
      scope: request.scope,
    });
    // The router already authorized; a snapshot refusal is a race, not a 403.
    if (snapshotOutcome.kind !== "ok") return { kind: "not_found" };
    const snapshot = snapshotOutcome.snapshot;
    // No sales in the period: nothing to analyze, so spend no provider call and
    // give the allowance back.
    if (snapshot.totals.saleCount === 0) {
      // Keep a short cooldown so an empty period cannot be polled for free.
      lastRunByActor.set(
        request.actorUserId,
        previousRun === undefined
          ? now() -
              (RATE_LIMIT_MILLISECONDS - EMPTY_PERIOD_COOLDOWN_MILLISECONDS)
          : previousRun,
      );
      return { kind: "insufficient_data" };
    }
    const provider = input.provider;
    if (provider === undefined) return { kind: "ok", run: mockRun(snapshot) };

    // Both languages are generated together and validated separately. A failed
    // language gets one more attempt inside the same run (one limiter use): a
    // transient provider error or a rejected draft is the common cause of a
    // missing language. The validator is never relaxed.
    const attempt = async (
      language: AiAnalyzeLanguage,
    ): Promise<LanguageOutcome> => {
      const generated = await provider.generate({
        text: buildAiAnalyzePrompt({ language, snapshot }),
      });
      if (!generated.ok)
        return {
          category: generated.failureCategory,
          detail: generated.attempts.at(-1)?.failureDetail,
          kind: "provider_failed",
          language,
        };
      if (!parseLanguage(language, snapshot, generated.text))
        return { kind: "rejected", language };
      return {
        kind: "ok",
        language,
        model: modelOf(generated),
        text: generated.text,
      };
    };
    const outcomes = await Promise.all(
      LANGUAGES.map(async (language): Promise<LanguageOutcome> => {
        const startedAt = now();
        const first = await attempt(language);
        if (first.kind === "ok") return first;
        input.onLanguageFailure?.({
          attempt: 1,
          category:
            first.kind === "provider_failed" ? first.category : "REJECTED",
          ...(first.kind === "provider_failed" ? { detail: first.detail } : {}),
          language,
        });
        // Retry a rejected draft or a transient provider error, and only while
        // the first attempt was quick (never after a timeout or auth failure).
        const transient =
          first.kind === "rejected" || RETRYABLE_CATEGORIES.has(first.category);
        if (
          !transient ||
          now() - startedAt > SECOND_ATTEMPT_DEADLINE_MILLISECONDS
        )
          return first;
        const second = await attempt(language);
        if (second.kind !== "ok")
          input.onLanguageFailure?.({
            attempt: 2,
            category:
              second.kind === "provider_failed" ? second.category : "REJECTED",
            ...(second.kind === "provider_failed"
              ? { detail: second.detail }
              : {}),
            language,
          });
        return second;
      }),
    );
    const th = outcomes.find((outcome) => outcome.language === "th");
    const en = outcomes.find((outcome) => outcome.language === "en");
    const stored = outcomes.filter((outcome) => outcome.kind === "ok");
    if (stored.length === 0) {
      const failure = outcomes.find(
        (outcome) => outcome.kind === "provider_failed",
      );
      if (failure !== undefined && failure.kind === "provider_failed")
        return { kind: "provider_failed", category: failure.category };
      return { kind: "rejected" };
    }

    const row = await input.store.create({
      actorUserId: request.actorUserId,
      branchId: scopeBranchId(request.scope),
      contentEn: en?.kind === "ok" ? en.text : null,
      contentTh: th?.kind === "ok" ? th.text : null,
      days: snapshot.period.days,
      localFrom: snapshot.period.from,
      localTo: snapshot.period.to,
      model: stored[0]!.model,
      organizationId: request.organizationId,
      reportingTimezone: snapshot.period.timezone,
    });
    return { kind: "ok", run: publicAnalysisRun(row) };
  }

  async function retry(request: {
    actorUserId: string;
    language: AiAnalyzeLanguage;
    organizationId: string;
    runId: string;
    scope: AiAnalyzeScope;
  }): Promise<AiAnalyzeServiceResult> {
    const row = await input.store.find(request.organizationId, request.runId);
    // A run from another tenant or scope is indistinguishable from a missing one.
    if (row === null || row.branchId !== scopeBranchId(request.scope))
      return { kind: "not_found" };
    if ((request.language === "th" ? row.contentTh : row.contentEn) !== null)
      return { kind: "ok", run: publicAnalysisRun(row) };

    const provider = input.provider;
    if (provider === undefined)
      return { kind: "provider_failed", category: "PROVIDER_UNAVAILABLE" };
    const retryAfterSeconds = consumeAllowance(request.actorUserId);
    if (retryAfterSeconds !== null)
      return { kind: "rate_limited", retryAfterSeconds };

    const snapshotOutcome = await input.buildSnapshot({
      actorUserId: request.actorUserId,
      days: row.days,
      fixedPeriod: {
        from: localDateString(row.localFrom),
        to: localDateString(row.localTo),
      },
      organizationId: request.organizationId,
      scope: request.scope,
    });
    if (snapshotOutcome.kind !== "ok") return { kind: "not_found" };
    const snapshot = snapshotOutcome.snapshot;

    const prompt = buildAiAnalyzePrompt({
      language: request.language,
      snapshot,
    });
    const startedAt = now();
    let generated = await provider.generate({ text: prompt });
    // One automatic second attempt for a transient failure or a rejected draft,
    // only while the first attempt was quick (same limiter use).
    const transient = generated.ok
      ? !parseLanguage(request.language, snapshot, generated.text)
      : RETRYABLE_CATEGORIES.has(generated.failureCategory);
    if (transient && now() - startedAt <= SECOND_ATTEMPT_DEADLINE_MILLISECONDS)
      generated = await provider.generate({ text: prompt });
    if (!generated.ok)
      return { kind: "provider_failed", category: generated.failureCategory };
    if (!parseLanguage(request.language, snapshot, generated.text))
      return { kind: "rejected" };

    const filled = await input.store.fillLanguage({
      content: generated.text,
      language: request.language,
      model: modelOf(generated),
      organizationId: request.organizationId,
      runId: request.runId,
    });
    if (filled !== null) return { kind: "ok", run: publicAnalysisRun(filled) };
    // Another request filled the column first; show the stored run.
    const current = await input.store.find(
      request.organizationId,
      request.runId,
    );
    return current === null
      ? { kind: "not_found" }
      : { kind: "ok", run: publicAnalysisRun(current) };
  }

  return { analyze, retry };
}

export type AiAnalyzeService = ReturnType<typeof createAiAnalyzeService>;
