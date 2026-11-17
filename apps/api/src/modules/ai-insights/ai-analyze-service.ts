import type { AiProvider, AiProviderFailureCategory } from "./ai-provider.ts";
import {
  AiAnalyzeOutputError,
  buildMockAiAnalyzeOutput,
  parseAiAnalyzeOutput,
  type AiAnalyzeSection,
} from "./ai-analyze-output.ts";
import {
  buildAiAnalyzePrompt,
  type AiAnalyzeLanguage,
} from "./ai-analyze-prompt.ts";
import type {
  AiAnalyzeScope,
  AiAnalyzeSnapshot,
  AiAnalyzeSnapshotOutcome,
  AiAnalyzeSnapshotPeriod,
  AiAnalyzeSnapshotRequest,
} from "./ai-analyze-snapshot.ts";

const RATE_LIMIT_MILLISECONDS = 60_000;

export type AiAnalyzeServiceResult =
  | Readonly<{
      kind: "ok";
      language: AiAnalyzeLanguage;
      mock: boolean;
      period: AiAnalyzeSnapshotPeriod;
      sections: readonly AiAnalyzeSection[];
      text: string;
    }>
  | Readonly<{ kind: "forbidden" }>
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "rate_limited"; retryAfterSeconds: number }>
  | Readonly<{ category: AiProviderFailureCategory; kind: "provider_failed" }>
  | Readonly<{ kind: "rejected" }>;

export type AiAnalyzeRequest = Readonly<{
  actorUserId: string;
  days: number;
  language: AiAnalyzeLanguage;
  organizationId: string;
  scope: AiAnalyzeScope;
}>;

type SnapshotBuilder = (
  request: AiAnalyzeSnapshotRequest,
) => Promise<AiAnalyzeSnapshotOutcome>;

export function createAiAnalyzeService(input: {
  buildSnapshot: SnapshotBuilder;
  now?: () => number;
  provider?: AiProvider;
}) {
  const now = input.now ?? Date.now;
  // Process-local by user; the endpoint is a manual, bounded-cost action.
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

  async function analyze(
    request: AiAnalyzeRequest,
  ): Promise<AiAnalyzeServiceResult> {
    const retryAfterSeconds = consumeAllowance(request.actorUserId);
    if (retryAfterSeconds !== null)
      return { kind: "rate_limited", retryAfterSeconds };

    const snapshotOutcome = await input.buildSnapshot({
      actorUserId: request.actorUserId,
      days: request.days,
      organizationId: request.organizationId,
      scope: request.scope,
    });
    if (snapshotOutcome.kind === "forbidden") return { kind: "forbidden" };
    if (snapshotOutcome.kind === "unavailable") return { kind: "not_found" };

    const snapshot: AiAnalyzeSnapshot = snapshotOutcome.snapshot;
    const parsed = (text: string) => {
      try {
        return parseAiAnalyzeOutput({
          language: request.language,
          snapshot,
          text,
        });
      } catch (error) {
        if (error instanceof AiAnalyzeOutputError) return null;
        throw error;
      }
    };

    if (input.provider === undefined) {
      const text = buildMockAiAnalyzeOutput({
        language: request.language,
        snapshot,
      });
      const sections = parsed(text);
      if (sections === null) return { kind: "rejected" };
      return {
        kind: "ok",
        language: request.language,
        mock: true,
        period: snapshot.period,
        sections,
        text,
      };
    }

    const generated = await input.provider.generate({
      text: buildAiAnalyzePrompt({ language: request.language, snapshot }),
    });
    if (!generated.ok)
      return { category: generated.failureCategory, kind: "provider_failed" };
    const sections = parsed(generated.text);
    if (sections === null) return { kind: "rejected" };
    return {
      kind: "ok",
      language: request.language,
      mock: false,
      period: snapshot.period,
      sections,
      text: generated.text,
    };
  }

  return { analyze };
}

export type AiAnalyzeService = ReturnType<typeof createAiAnalyzeService>;
