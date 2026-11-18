import { randomBytes } from "node:crypto";

import { Prisma, type PrismaClient } from "../generated/prisma/client.ts";
import { createAnalyticsContextEngine } from "../modules/analytics/analytics-context.ts";
import { createAnalyticsDimensionCursorCodec } from "../modules/analytics/analytics-dimension-cursor.ts";
import { createPrismaAnalyticsInventoryRepository } from "../modules/analytics/analytics-inventory-repository.ts";
import { createAnalyticsInventoryService } from "../modules/analytics/analytics-inventory-service.ts";
import type { InventoryDimension } from "../modules/analytics/analytics-inventory-values.ts";
import { createPrismaAnalyticsScopeRepository } from "../modules/analytics/analytics-scope-repository.ts";
import type { AnalyticsScopeCandidate } from "../modules/analytics/analytics-scope.ts";
import {
  createAiInsightJob,
  type AiInsightJobInput,
} from "../modules/ai-insights/ai-insight-job.ts";
import { createSeededTemplateProvider } from "../modules/ai-insights/seeded-template-provider.ts";
import {
  type SeededReportFacts,
  type SeededReportProductFact,
} from "../modules/ai-insights/seeded-report-text.ts";
import {
  seededReportPeriods,
  type SeededReportPeriod,
} from "./demo-seed-periods.ts";

const Decimal = Prisma.Decimal.clone({ precision: 80 });
const PAGE_LIMIT = 100;

export interface SeedStoredReportsInput {
  from: string;
  organizationId: string;
  reportingTimezone: string;
  to: string;
}

export interface SeedStoredReportsCounts {
  monthly: number;
  /** Reports that already existed before this run and were therefore reused. */
  observed: number;
  scopes: number;
  succeeded: number;
  weekly: number;
}

interface SeedScope {
  candidate: AnalyticsScopeCandidate;
  label: string;
  scopeKey: string;
}

interface SeedContext extends SeedScope {
  codec: ReturnType<typeof createAnalyticsDimensionCursorCodec>;
  organizationId: string;
  period: SeededReportPeriod;
  prisma: PrismaClient;
  scopeRepository: ReturnType<typeof createPrismaAnalyticsScopeRepository>;
  actorUserId: string;
}

function sum(values: readonly string[]): Prisma.Decimal {
  return values.reduce((total, value) => total.plus(value), new Decimal(0));
}

function productFacts(
  dimensions: readonly InventoryDimension[],
  direction: "best" | "slowest",
): SeededReportProductFact[] {
  const products = new Map<
    string,
    { id: string; name: string; unit: string; quantity: Prisma.Decimal }
  >();
  for (const item of dimensions) {
    const current = products.get(item.productId) ?? {
      id: item.productId,
      name: item.productName,
      quantity: new Decimal(0),
      unit: item.productUnit,
    };
    current.quantity = current.quantity.plus(
      sum(item.buckets.map((bucket) => bucket.saleDepletionQuantity)),
    );
    products.set(item.productId, current);
  }
  // Rank within each base unit: adding kilograms and individual units is meaningless.
  return [...new Set([...products.values()].map((p) => p.unit))]
    .sort()
    .map(
      (unit) =>
        [...products.values()]
          .filter((p) => p.unit === unit)
          .sort((a, b) =>
            direction === "best"
              ? b.quantity.cmp(a.quantity) || a.id.localeCompare(b.id)
              : a.quantity.cmp(b.quantity) || a.id.localeCompare(b.id),
          )[0]!,
    )
    .filter((p) => (direction === "best" ? p.quantity.gt(0) : true))
    .map((p) => ({
      name: p.name,
      quantity: p.quantity.toFixed(4),
      unit: p.unit,
    }));
}

/**
 * Reads one completed period and scope through the same analytics read path the
 * Demo Insight uses. Sales and per-product sale depletion are cut off at the
 * period end, so a later sale can never change this period's figures. The
 * inventory dimension is read for those depletion quantities only: its current
 * on-hand balance describes today, not the period end, and is never stored in a
 * report.
 */
async function readSeededReportFacts(
  context: SeedContext,
): Promise<SeededReportFacts> {
  const { period } = context;
  const atPeriodEnd = () => context.period.periodEndExclusive;
  const inventoryService = createAnalyticsInventoryService({
    contextEngine: createAnalyticsContextEngine({
      now: atPeriodEnd,
      scopeRepository: context.scopeRepository,
    }),
    cursorCodec: context.codec,
    repository: createPrismaAnalyticsInventoryRepository(
      context.prisma,
      context.codec,
      { now: atPeriodEnd },
    ),
  });
  const dimensions: InventoryDimension[] = [];
  let cursor: string | undefined;
  do {
    const page = await inventoryService.read({
      actorUserId: context.actorUserId,
      from: period.from,
      granularity: period.granularity,
      limit: PAGE_LIMIT,
      organizationId: context.organizationId,
      scope: context.candidate,
      to: period.to,
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (page.kind !== "success")
      throw new Error("Demo90d reports requires readable inventory analytics.");
    dimensions.push(...page.page.series);
    cursor = page.page.nextCursor ?? undefined;
  } while (cursor !== undefined);

  return {
    best: productFacts(dimensions, "best"),
    scopeKind: context.candidate.kind === "branch" ? "branch" : "organization",
    scopeName: context.label,
    slowest: productFacts(dimensions, "slowest"),
  };
}

function identityKey(input: {
  cadence: string;
  periodEndExclusive: Date;
  periodStartInclusive: Date;
  scopeKey: string;
}): string {
  return [
    input.scopeKey,
    input.cadence,
    input.periodStartInclusive.toISOString(),
    input.periodEndExclusive.toISOString(),
  ].join("|");
}

/**
 * Stores one immutable SUCCEEDED AI insight report, with its analytics snapshot,
 * for every completed week and month inside the seed window and for every
 * in-organization scope (the organization plus each branch), through the
 * existing snapshot + insight job pipeline and a deterministic seed-only
 * provider. A rerun reuses the stored reports and creates nothing new.
 */
export async function seedStoredReports(
  prisma: PrismaClient,
  input: SeedStoredReportsInput,
): Promise<SeedStoredReportsCounts> {
  const periods = seededReportPeriods(input);
  if (periods.length === 0)
    throw new Error(
      "Demo90d reports requires at least one completed week or month in the seed window.",
    );
  const organization = await prisma.organization.findUnique({
    select: {
      branches: {
        orderBy: { id: "asc" },
        select: { id: true, name: true },
      },
      name: true,
    },
    where: { id: input.organizationId },
  });
  if (organization === null)
    throw new Error("Demo90d reports requires the seeded organization.");
  const membership = await prisma.organizationMembership.findFirst({
    select: { userId: true },
    where: {
      organizationId: input.organizationId,
      role: "OWNER",
      status: "ACTIVE",
      user: { emailVerifiedAt: { not: null }, status: "ACTIVE" },
    },
  });
  if (membership === null)
    throw new Error(
      "Demo90d reports requires one verified active organization owner.",
    );

  const scopes: SeedScope[] = [
    {
      candidate: { kind: "organization" },
      label: organization.name,
      scopeKey: "organization",
    },
    ...organization.branches.map((branch) => ({
      candidate: { branchId: branch.id, kind: "branch" as const },
      label: branch.name,
      scopeKey: branch.id,
    })),
  ];

  // The seed-only provider signs nothing, so a per-run key is enough.
  const codec = createAnalyticsDimensionCursorCodec(randomBytes(32));
  const scopeRepository = createPrismaAnalyticsScopeRepository(prisma);
  const existing = await prisma.aiInsightReport.findMany({
    select: {
      cadence: true,
      periodEndExclusive: true,
      periodStartInclusive: true,
      scopeKey: true,
    },
    where: { organizationId: input.organizationId },
  });
  const known = new Set(existing.map(identityKey));

  const counts: SeedStoredReportsCounts = {
    monthly: 0,
    observed: 0,
    scopes: scopes.length,
    succeeded: 0,
    weekly: 0,
  };
  for (const period of periods) {
    counts[period.granularity === "week" ? "weekly" : "monthly"]++;
    for (const scope of scopes) {
      const jobInput: AiInsightJobInput = {
        from: period.from,
        granularity: period.granularity,
        organizationId: input.organizationId,
        periodEndExclusive: period.periodEndExclusive,
        periodStartInclusive: period.periodStartInclusive,
        reportingTimezone: input.reportingTimezone,
        scope: scope.candidate,
        to: period.to,
      };
      const cadence = period.granularity === "week" ? "WEEKLY" : "MONTHLY";
      const key = identityKey({
        cadence,
        periodEndExclusive: period.periodEndExclusive,
        periodStartInclusive: period.periodStartInclusive,
        scopeKey: scope.scopeKey,
      });
      const report = await createAiInsightJob(
        prisma,
        createSeededTemplateProvider(() =>
          readSeededReportFacts({
            ...scope,
            actorUserId: membership.userId,
            codec,
            organizationId: input.organizationId,
            period,
            prisma,
            scopeRepository,
          }),
        ),
      )(jobInput);
      if (report.state !== "SUCCEEDED")
        throw new Error(
          `Demo90d reports requires every stored insight to succeed; ${key} ended ${report.state}.`,
        );
      counts.succeeded++;
      if (known.has(key)) counts.observed++;
    }
  }
  return counts;
}
