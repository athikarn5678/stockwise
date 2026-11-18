import { z } from "zod";
import { privateFetch, readPrivateJson } from "@/session-lifecycle";

export type AiAnalysisScope =
  | Readonly<{ scope: "organization" }>
  | Readonly<{ scope: "branch"; branchId: string }>;

export type AiAnalysisLanguage = "th" | "en";
export type AiAnalysisDays = 7 | 14 | 30;

const sectionSchema = z.object({
  body: z.string(),
  heading: z.string(),
});

const languageSectionsSchema = z.array(sectionSchema).nullable();

const runSchema = z.object({
  createdAt: z.string(),
  days: z.number().int().positive(),
  id: z.uuid().nullable(),
  languages: z.object({
    en: languageSectionsSchema,
    th: languageSectionsSchema,
  }),
  missing: z.array(z.enum(["th", "en"])),
  mock: z.boolean(),
  model: z.string(),
  period: z.object({
    from: z.string(),
    scope: z.enum(["organization", "branch"]),
    timezone: z.string(),
    to: z.string(),
  }),
});

const runResponseSchema = z.object({ data: runSchema });
const runListResponseSchema = z.object({
  data: z.array(runSchema),
  meta: z.object({ nextCursor: z.uuid().nullable() }),
});
const errorResponseSchema = z.object({ error: z.object({ code: z.string() }) });

export type AiAnalysisRun = z.infer<typeof runSchema>;
export type AiAnalysisRunPage = z.infer<typeof runListResponseSchema>;
export type AiAnalysisSection = z.infer<typeof sectionSchema>;

export class AiAnalysisApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null = null,
  ) {
    super("AI analysis request failed");
  }
}

async function errorCode(response: Response): Promise<string | null> {
  try {
    const parsed = errorResponseSchema.safeParse(await response.json());
    return parsed.success ? parsed.data.error.code : null;
  } catch {
    return null;
  }
}

function query(scope: AiAnalysisScope, cursor?: string | null): string {
  const params = new URLSearchParams({ scope: scope.scope });
  if (scope.scope === "branch") params.set("branchId", scope.branchId);
  if (cursor !== undefined && cursor !== null) params.set("cursor", cursor);
  return params.toString();
}

async function send(path: string, init: RequestInit): Promise<Response> {
  try {
    return await privateFetch(path, {
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      ...init,
    });
  } catch {
    throw new AiAnalysisApiError(0);
  }
}

async function readRun(response: Response): Promise<AiAnalysisRun> {
  if (!response.ok)
    throw new AiAnalysisApiError(response.status, await errorCode(response));
  try {
    return runResponseSchema.parse(await readPrivateJson(response)).data;
  } catch {
    throw new AiAnalysisApiError(0);
  }
}

/** One provider run for both languages; the API persists the result. */
export function createRun(
  organizationId: string,
  scope: AiAnalysisScope,
  days: AiAnalysisDays,
): Promise<AiAnalysisRun> {
  return send(
    `/api/v1/organizations/${organizationId}/ai-analysis/runs?${query(scope)}`,
    { body: JSON.stringify({ days }), method: "POST" },
  ).then(readRun);
}

/** Newest-first history page; `cursor` is the previous page's `nextCursor`. */
export async function listRuns(
  organizationId: string,
  scope: AiAnalysisScope,
  cursor?: string | null,
  signal?: AbortSignal,
): Promise<AiAnalysisRunPage> {
  const response = await send(
    `/api/v1/organizations/${organizationId}/ai-analysis/runs?${query(scope, cursor)}`,
    { method: "GET", ...(signal ? { signal } : {}) },
  );
  if (!response.ok)
    throw new AiAnalysisApiError(response.status, await errorCode(response));
  try {
    return runListResponseSchema.parse(await readPrivateJson(response));
  } catch {
    throw new AiAnalysisApiError(0);
  }
}

/** Generate one missing language of a stored run. */
export function retryRun(
  organizationId: string,
  scope: AiAnalysisScope,
  runId: string,
  language: AiAnalysisLanguage,
): Promise<AiAnalysisRun> {
  return send(
    `/api/v1/organizations/${organizationId}/ai-analysis/runs/${runId}/retry?${query(scope)}`,
    { body: JSON.stringify({ language }), method: "POST" },
  ).then(readRun);
}
