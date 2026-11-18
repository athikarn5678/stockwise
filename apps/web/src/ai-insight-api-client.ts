import { z } from "zod";
import { privateFetch, readPrivateJson } from "@/session-lifecycle";

const insightSchema = z.object({
  cadence: z.enum(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]),
  reportingTimezone: z.string(),
  periodStartInclusive: z.string().datetime(),
  periodEndExclusive: z.string().datetime(),
  state: z.enum(["SUCCEEDED", "FAILED", "INSUFFICIENT", "IN_PROGRESS"]),
  content: z.string().nullable(),
  completedAt: z.string().datetime().nullable(),
});

export type InsightCadence = z.infer<typeof insightSchema>["cadence"];
export type InsightScope =
  { scope: "organization" } | { scope: "branch"; branchId: string };

export class InsightApiError extends Error {
  constructor(readonly status: number) {
    super("Insight read failed");
  }
}

const storedInsightSchema = insightSchema.extend({ id: z.uuid() });

const insightListResponseSchema = z.object({
  data: z.array(storedInsightSchema),
  meta: z.object({ nextCursor: z.uuid().nullable() }),
});

export type StoredInsightReport = z.infer<typeof storedInsightSchema>;

/** One stored report page; callers follow `meta.nextCursor` for full history. */
export const STORED_INSIGHT_PAGE_LIMIT = 100;

export async function listStoredInsights(
  organizationId: string,
  scope: InsightScope,
  cadence: InsightCadence,
  signal?: AbortSignal,
): Promise<StoredInsightReport[]> {
  const reports: StoredInsightReport[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  for (;;) {
    const params = new URLSearchParams({
      scope: scope.scope,
      cadence,
      limit: String(STORED_INSIGHT_PAGE_LIMIT),
    });
    if (scope.scope === "branch") params.set("branchId", scope.branchId);
    if (cursor !== null) params.set("cursor", cursor);
    let response: Response;
    try {
      response = await privateFetch(
        `/api/v1/organizations/${organizationId}/ai-insights?${params}`,
        {
          credentials: "same-origin",
          headers: { accept: "application/json" },
          ...(signal ? { signal } : {}),
        },
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new InsightApiError(0);
    }
    if (!response.ok) throw new InsightApiError(response.status);
    let page: z.infer<typeof insightListResponseSchema>;
    try {
      page = insightListResponseSchema.parse(await readPrivateJson(response));
    } catch {
      throw new InsightApiError(0);
    }
    reports.push(...page.data);
    const nextCursor = page.meta.nextCursor;
    // A repeated cursor would otherwise loop forever.
    if (nextCursor === null || seenCursors.has(nextCursor)) return reports;
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
}

const demoInsightSchema = z.object({
  data: z.object({
    mode: z.literal("DEMO"),
    label: z.string(),
    explanation: z.string(),
    content: z.string(),
    from: z.string(),
    to: z.string(),
    reportingTimezone: z.string(),
    provider: z.null(),
    providerCalls: z.literal(0),
  }),
});

export async function getDemoInsight(
  organizationId: string,
  scope: InsightScope,
  language: "en" | "th",
  signal?: AbortSignal,
) {
  const params = new URLSearchParams({ scope: scope.scope, language });
  if (scope.scope === "branch") params.set("branchId", scope.branchId);
  const response = await privateFetch(
    `/api/v1/organizations/${organizationId}/ai-insights/demo?${params}`,
    {
      credentials: "same-origin",
      headers: { accept: "application/json" },
      ...(signal ? { signal } : {}),
    },
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new InsightApiError(response.status);
  return demoInsightSchema.parse(await readPrivateJson(response)).data;
}
