import { z } from "zod";

import type { PrismaClient } from "../../generated/prisma/client.ts";
import {
  baselineSchema,
  historyDigest,
  renderBaselineInsight,
  scopeKey,
} from "../../demo-production/demo-production-baseline.ts";
import { localDateToUtcBoundary } from "../analytics/analytics-period.ts";
import {
  createPrismaAiInsightReader,
  type InsightReadScope,
} from "./ai-insight-store.ts";

export interface DemoInsightRequest {
  actorUserId: string;
  organizationId: string;
  scope: InsightReadScope;
  language: "en" | "th";
}

/** Structural port shared by the disposable-database and Production readers. */
export interface DemoInsightReader {
  read(
    request: DemoInsightRequest,
  ): Promise<
    | { kind: "forbidden" }
    | { kind: "not_found" }
    | { kind: "success"; insight: unknown }
  >;
}

const planWindowSchema = z.object({
  from: z.string(),
  to: z.string(),
  reportingTimezone: z.string(),
});

/**
 * ADR-043: serves the immutable baseline that the operator `provision-demo`
 * action stored for ONE synthetic organization. Identity comes only from the
 * operator-written, runtime-read-only provenance row; no environment variable
 * or request value selects an organization. Normal authenticated AI-summary
 * authorization and trusted scope apply first. The fixed historical window is
 * validated by a digest of every event before its period end, so later live
 * POS activity (dated at or after that instant) never invalidates it, while
 * any change to the historical events does. No provider is called and nothing
 * is written.
 */
export function createProductionDemoInsightReader(input: {
  prisma: PrismaClient;
}): DemoInsightReader {
  return {
    async read(request) {
      if (!(await createPrismaAiInsightReader(input.prisma).authorize(request)))
        return { kind: "forbidden" } as const;
      const run = await input.prisma.demoDatasetRun.findUnique({
        where: { organizationId: request.organizationId },
      });
      if (!run || run.state !== "COMPLETE" || !run.historyDigest)
        return { kind: "not_found" } as const;
      const organization = await input.prisma.organization.findUnique({
        where: { id: request.organizationId },
        select: { name: true, reportingTimezone: true },
      });
      const window = planWindowSchema.safeParse(run.plan);
      const baseline = baselineSchema.safeParse(run.baseline);
      if (
        organization?.name !== run.name ||
        !window.success ||
        !baseline.success ||
        window.data.reportingTimezone !== organization.reportingTimezone ||
        baseline.data.from !== window.data.from ||
        baseline.data.to !== window.data.to ||
        baseline.data.reportingTimezone !== window.data.reportingTimezone
      )
        return { kind: "not_found" } as const;
      const metrics = baseline.data.scopes[scopeKey(request.scope)];
      if (!metrics) return { kind: "not_found" } as const;
      const boundary = localDateToUtcBoundary(
        window.data.to,
        window.data.reportingTimezone,
      );
      if (
        run.historyDigest !==
        (await historyDigest(input.prisma, request.organizationId, boundary))
      )
        return { kind: "not_found" } as const;
      return {
        kind: "success" as const,
        insight: renderBaselineInsight({
          metrics,
          language: request.language,
          from: baseline.data.from,
          to: baseline.data.to,
          reportingTimezone: baseline.data.reportingTimezone,
        }),
      };
    },
  };
}

/** First reader that does not answer not_found wins; the first one is the local, development-only reader. */
export function composeDemoInsightReaders(
  ...readers: DemoInsightReader[]
): DemoInsightReader {
  return {
    async read(request) {
      let last: Awaited<ReturnType<DemoInsightReader["read"]>> = {
        kind: "not_found",
      };
      for (const reader of readers) {
        last = await reader.read(request);
        if (last.kind !== "not_found") return last;
      }
      return last;
    },
  };
}
