import type {
  AiAnalysisRun,
  PrismaClient,
} from "../../generated/prisma/client.ts";
import {
  splitStoredAiAnalyzeSections,
  type AiAnalyzeSection,
} from "./ai-analyze-output.ts";
import type { AiAnalyzeLanguage } from "./ai-analyze-prompt.ts";

/** Local calendar date stored as a UTC-midnight `DATE`. */
export function localDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

export function localDateString(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export type AiAnalysisRunPeriod = Readonly<{
  from: string;
  scope: "organization" | "branch";
  timezone: string;
  to: string;
}>;

/** Public run shape: no actor, tenant or prompt data leaves the API. */
export type AiAnalysisRunView = Readonly<{
  createdAt: string;
  days: number;
  id: string | null;
  languages: Readonly<{
    en: readonly AiAnalyzeSection[] | null;
    th: readonly AiAnalyzeSection[] | null;
  }>;
  missing: readonly AiAnalyzeLanguage[];
  mock: boolean;
  model: string;
  period: AiAnalysisRunPeriod;
}>;

export function publicAnalysisRun(row: AiAnalysisRun): AiAnalysisRunView {
  const th =
    row.contentTh === null
      ? null
      : splitStoredAiAnalyzeSections(row.contentTh, "th");
  const en =
    row.contentEn === null
      ? null
      : splitStoredAiAnalyzeSections(row.contentEn, "en");
  return {
    createdAt: row.createdAt.toISOString(),
    days: row.days,
    id: row.id,
    languages: { en, th },
    missing: [
      ...(th === null ? (["th"] as const) : []),
      ...(en === null ? (["en"] as const) : []),
    ],
    mock: false,
    model: row.model,
    period: {
      from: localDateString(row.localFrom),
      scope: row.branchId === null ? "organization" : "branch",
      timezone: row.reportingTimezone,
      to: localDateString(row.localTo),
    },
  };
}

export function createPrismaAiAnalysisStore(prisma: PrismaClient) {
  return {
    async create(
      input: Readonly<{
        actorUserId: string;
        branchId: string | null;
        contentEn: string | null;
        contentTh: string | null;
        days: number;
        localFrom: string;
        localTo: string;
        model: string;
        organizationId: string;
        reportingTimezone: string;
      }>,
    ) {
      return prisma.aiAnalysisRun.create({
        data: {
          actorUserId: input.actorUserId,
          branchId: input.branchId,
          contentEn: input.contentEn,
          contentTh: input.contentTh,
          days: input.days,
          localFrom: localDate(input.localFrom),
          localTo: localDate(input.localTo),
          model: input.model,
          organizationId: input.organizationId,
          reportingTimezone: input.reportingTimezone,
        },
      });
    },

    /** `branchId: null` is the organization scope only (no branch row). */
    async list(
      input: Readonly<{
        branchId: string | null;
        cursor?: string;
        limit: number;
        organizationId: string;
      }>,
    ) {
      const filter = {
        branchId: input.branchId,
        organizationId: input.organizationId,
      };
      let after: Pick<AiAnalysisRun, "createdAt" | "id"> | null = null;
      if (input.cursor !== undefined) {
        // A cursor from another tenant or scope must not act as an offset.
        after = await prisma.aiAnalysisRun.findFirst({
          select: { createdAt: true, id: true },
          where: { ...filter, id: input.cursor },
        });
        if (after === null) return null;
      }
      const rows = await prisma.aiAnalysisRun.findMany({
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: input.limit + 1,
        where: {
          ...filter,
          ...(after === null
            ? {}
            : {
                OR: [
                  { createdAt: { lt: after.createdAt } },
                  { createdAt: after.createdAt, id: { lt: after.id } },
                ],
              }),
        },
      });
      return {
        items: rows.slice(0, input.limit).map(publicAnalysisRun),
        nextCursor:
          rows.length > input.limit ? rows[input.limit - 1]!.id : null,
      };
    },

    async find(organizationId: string, runId: string) {
      return prisma.aiAnalysisRun.findFirst({
        where: { id: runId, organizationId },
      });
    },

    /**
     * Fills one language only while that column is still NULL, so a concurrent
     * retry for the same language never overwrites the first stored text.
     */
    async fillLanguage(
      input: Readonly<{
        content: string;
        language: AiAnalyzeLanguage;
        model: string;
        organizationId: string;
        runId: string;
      }>,
    ) {
      const filled = await prisma.aiAnalysisRun.updateMany({
        where: {
          id: input.runId,
          organizationId: input.organizationId,
          ...(input.language === "th"
            ? { contentTh: null }
            : { contentEn: null }),
        },
        data:
          input.language === "th"
            ? { contentTh: input.content, model: input.model }
            : { contentEn: input.content, model: input.model },
      });
      if (filled.count === 0) return null;
      return prisma.aiAnalysisRun.findFirst({
        where: { id: input.runId, organizationId: input.organizationId },
      });
    },
  };
}

export type AiAnalysisStore = ReturnType<typeof createPrismaAiAnalysisStore>;
