import type {
  AnalyticsContextEngine,
  AnalyticsContextOutcome,
} from "./analytics-context.ts";
import type { AnalyticsScopeCandidate } from "./analytics-scope.ts";
import type {
  AnalyticsProductFacts,
  AnalyticsProductFactsRepository,
} from "./analytics-product-facts-repository.ts";

export type AnalyticsProductFactsOutcome =
  | Readonly<{ facts: AnalyticsProductFacts; kind: "success" }>
  | Exclude<AnalyticsContextOutcome, { kind: "success" }>;

/**
 * Product-level facts for the AI analysis. Scope, branch ids and the source
 * cutoff come from the same authorized context as every other analytics read.
 */
export function createAnalyticsProductFactsService(input: {
  contextEngine: AnalyticsContextEngine;
  repository: AnalyticsProductFactsRepository;
}) {
  return {
    async read(request: {
      actorUserId: string;
      from: string;
      organizationId: string;
      scope: AnalyticsScopeCandidate;
      to: string;
    }): Promise<AnalyticsProductFactsOutcome> {
      const outcome = await input.contextEngine.resolve({
        ...request,
        analyticsKind: "business",
        granularity: "day",
      });
      if (outcome.kind !== "success") return outcome;
      return {
        facts: await input.repository.read(outcome.context),
        kind: "success",
      };
    },
  };
}

export type AnalyticsProductFactsService = ReturnType<
  typeof createAnalyticsProductFactsService
>;
