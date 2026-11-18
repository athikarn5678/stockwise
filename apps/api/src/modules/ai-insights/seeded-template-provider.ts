import { z } from "zod";

import { analyticsSnapshotPayloadSchema } from "../analytics/analytics-snapshot-store.ts";
import type {
  AiProvider,
  AiProviderAttempt,
  AiProviderAttemptObserver,
  AiProviderResult,
} from "./ai-provider.ts";
import {
  buildSeededReportText,
  type SeededReportFacts,
} from "./seeded-report-text.ts";

/** Deterministic seed-only provider name and model, stored on the report row. */
export const SEEDED_TEMPLATE_PROVIDER = "seeded-template";
export const SEEDED_TEMPLATE_MODEL = "seeded-template-v1";

// `prepareAiSummaryPrompt` appends exactly one JSON document after this marker.
const SNAPSHOT_MARKER = "Snapshot data:\n";

const seededSnapshotSchema = z.object({
  cadence: z.enum(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]),
  localFromInclusive: z.iso.date(),
  localToExclusive: z.iso.date(),
  scope: z.enum(["Organization summary", "Branch summary"]),
  sales: analyticsSnapshotPayloadSchema.shape.sales,
});

type SeededSnapshot = z.infer<typeof seededSnapshotSchema>;

function parseSnapshot(text: string): SeededSnapshot | null {
  const marker = text.lastIndexOf(SNAPSHOT_MARKER);
  if (marker === -1) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(marker + SNAPSHOT_MARKER.length));
  } catch {
    return null;
  }
  const checked = seededSnapshotSchema.safeParse(parsed);
  return checked.success ? checked.data : null;
}

/**
 * A deterministic provider for seeded stored reports. It never performs a
 * network call, never reads environment or provider configuration, and derives
 * its prose only from the pinned snapshot serialized in the job prompt plus the
 * already-computed period-scoped facts.
 *
 * The facts are loaded lazily because the insight job returns an already
 * stored report without calling the provider at all; an idempotent reseed must
 * therefore not repeat the period analytics reads.
 */
export function createSeededTemplateProvider(
  loadFacts: () => Promise<SeededReportFacts>,
): AiProvider {
  return {
    async generate(
      input,
      observer?: AiProviderAttemptObserver,
    ): Promise<AiProviderResult> {
      const snapshot = parseSnapshot(input.text);
      if (snapshot === null)
        return { attempts: [], failureCategory: "INVALID_REQUEST", ok: false };
      const facts = await loadFacts();
      const text = buildSeededReportText({
        ...facts,
        granularity: snapshot.cadence === "WEEKLY" ? "week" : "month",
        localFromInclusive: snapshot.localFromInclusive,
        localToExclusive: snapshot.localToExclusive,
        sales: snapshot.sales,
        scopeKind:
          snapshot.scope === "Branch summary" ? "branch" : "organization",
      });

      const attemptNumber = 1;
      await observer?.beforeAttempt({
        attemptNumber,
        provider: SEEDED_TEMPLATE_PROVIDER,
        requestedModel: SEEDED_TEMPLATE_MODEL,
      });
      const attemptedAt = performance.now();
      const attempt: AiProviderAttempt = {
        actualModel: SEEDED_TEMPLATE_MODEL,
        attemptNumber,
        durationMilliseconds: performance.now() - attemptedAt,
        provider: SEEDED_TEMPLATE_PROVIDER,
        requestedModel: SEEDED_TEMPLATE_MODEL,
      };
      await observer?.afterAttempt(attempt);
      return {
        actualModel: SEEDED_TEMPLATE_MODEL,
        attempts: [attempt],
        ok: true,
        requestedModel: SEEDED_TEMPLATE_MODEL,
        text,
      };
    },
  };
}
