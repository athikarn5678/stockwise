import { randomUUID } from "node:crypto";

import {
  Prisma,
  type AiInsightReport,
  type AnalyticsSnapshot,
  type AnalyticsSnapshotCadence,
  type PrismaClient,
} from "../../generated/prisma/client.ts";
import {
  can,
  createTrustedAuthorizationContext,
  createTrustedBranchScope,
  createTrustedOrganizationScope,
  PERMISSIONS,
} from "../identity/authorization-policy.ts";
import type {
  AiProviderAttempt,
  AiProviderFailureCategory,
} from "./ai-provider.ts";

export type InsightIdentity = Readonly<{
  organizationId: string;
  scopeKey: string;
  cadence: AnalyticsSnapshotCadence;
  reportingTimezone: string;
  periodStartInclusive: Date;
  periodEndExclusive: Date;
}>;

type Claim = Readonly<{ report: AiInsightReport; token: string }>;
export type ClaimResult =
  | Readonly<{ kind: "claimed"; claim: Claim }>
  | Readonly<{ kind: "observed"; report: AiInsightReport }>;

const CLAIM_MILLISECONDS = 60_000;

export type InsightReadScope =
  | Readonly<{ kind: "organization" }>
  | Readonly<{ kind: "branch"; branchId: string }>;

const readSelect = {
  id: true,
  organizationId: true,
  scope: true,
  branchId: true,
  cadence: true,
  reportingTimezone: true,
  periodStartInclusive: true,
  periodEndExclusive: true,
  schemaVersion: true,
  metricDefinitionVersion: true,
  sourceCutoff: true,
  promptVersion: true,
  state: true,
  attemptCount: true,
  provider: true,
  actualModel: true,
  content: true,
  failureCategory: true,
  generatedAt: true,
  completedAt: true,
  snapshot: {
    select: {
      organizationId: true,
      branchId: true,
      scope: true,
      cadence: true,
      reportingTimezone: true,
      periodStartInclusive: true,
      periodEndExclusive: true,
      schemaVersion: true,
      metricDefinitionVersion: true,
      sourceCutoff: true,
    },
  },
} as const;

const newestFirst = [
  { periodEndExclusive: "desc" },
  { periodStartInclusive: "desc" },
  { id: "desc" },
] satisfies Prisma.AiInsightReportOrderByWithRelationInput[];

type ReadRow = Prisma.AiInsightReportGetPayload<{ select: typeof readSelect }>;

export function publicInsight(row: ReadRow) {
  const snapshot = row.snapshot;
  if (
    snapshot.organizationId !== row.organizationId ||
    snapshot.branchId !== row.branchId ||
    snapshot.scope !== row.scope ||
    snapshot.cadence !== row.cadence ||
    snapshot.reportingTimezone !== row.reportingTimezone ||
    snapshot.periodStartInclusive.getTime() !==
      row.periodStartInclusive.getTime() ||
    snapshot.periodEndExclusive.getTime() !==
      row.periodEndExclusive.getTime() ||
    snapshot.schemaVersion !== row.schemaVersion ||
    snapshot.metricDefinitionVersion !== row.metricDefinitionVersion ||
    snapshot.sourceCutoff.getTime() !== row.sourceCutoff.getTime()
  )
    throw new Error("AI insight provenance is inconsistent.");
  const privateProviderFailure =
    row.state === "FAILED" && row.failureCategory === "AUTHENTICATION";
  return {
    id: row.id,
    scope: row.scope,
    ...(row.branchId === null ? {} : { branchId: row.branchId }),
    cadence: row.cadence,
    reportingTimezone: row.reportingTimezone,
    periodStartInclusive: row.periodStartInclusive.toISOString(),
    periodEndExclusive: row.periodEndExclusive.toISOString(),
    schemaVersion: row.schemaVersion,
    metricDefinitionVersion: row.metricDefinitionVersion,
    sourceCutoff: row.sourceCutoff.toISOString(),
    promptVersion: row.promptVersion,
    state: row.state,
    attemptCount:
      row.state === "IN_PROGRESS" || privateProviderFailure
        ? null
        : row.attemptCount,
    provider:
      row.state === "IN_PROGRESS" || privateProviderFailure
        ? null
        : row.provider,
    actualModel:
      row.state === "IN_PROGRESS" || privateProviderFailure
        ? null
        : row.actualModel,
    content: row.state === "SUCCEEDED" ? row.content : null,
    failureCategory: privateProviderFailure
      ? "PROVIDER_ERROR"
      : row.state === "FAILED"
        ? row.failureCategory
        : null,
    generatedAt: row.generatedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

export function createPrismaAiInsightReader(prisma: PrismaClient) {
  async function authorize(input: {
    actorUserId: string;
    organizationId: string;
    scope: InsightReadScope;
  }) {
    const membership = await prisma.organizationMembership.findUnique({
      where: {
        organizationId_userId: {
          organizationId: input.organizationId,
          userId: input.actorUserId,
        },
      },
      select: {
        organization: { select: { status: true } },
        organizationId: true,
        role: true,
        status: true,
        userId: true,
        user: { select: { id: true, status: true } },
        branchAssignments: {
          select: {
            branchId: true,
            organizationId: true,
            status: true,
            userId: true,
          },
        },
      },
    });
    if (membership === null || membership.organization.status !== "ACTIVE")
      return false;
    const context = createTrustedAuthorizationContext({
      actor: membership.user,
      membership,
      branchAssignments: membership.branchAssignments,
    });
    const branch =
      input.scope.kind === "branch"
        ? await prisma.branch.findFirst({
            where: {
              id: input.scope.branchId,
              organizationId: input.organizationId,
            },
            select: { id: true, organizationId: true, status: true },
          })
        : null;
    if (input.scope.kind === "branch" && branch === null) return false;
    if (
      branch?.status === "INACTIVE" &&
      membership.role !== "OWNER" &&
      membership.role !== "ADMIN"
    )
      return false;
    const scope =
      branch === null
        ? createTrustedOrganizationScope(input.organizationId)
        : createTrustedBranchScope({
            branchId: branch.id,
            branchOrganizationId: branch.organizationId,
            organizationId: input.organizationId,
          });
    return [
      PERMISSIONS.AI_BUSINESS_SUMMARY_VIEW,
      PERMISSIONS.BUSINESS_ANALYTICS_VIEW,
      PERMISSIONS.SALES_COST_VIEW,
    ].every((permission) => can(context, permission, scope));
  }

  function where(
    organizationId: string,
    scope: InsightReadScope,
    cadence: AnalyticsSnapshotCadence,
  ) {
    return {
      organizationId,
      cadence,
      scope:
        scope.kind === "organization"
          ? ("ORGANIZATION" as const)
          : ("BRANCH" as const),
      branchId: scope.kind === "organization" ? null : scope.branchId,
    };
  }

  return {
    authorize,
    async list(input: {
      organizationId: string;
      scope: InsightReadScope;
      cadence: AnalyticsSnapshotCadence;
      cursor?: string;
      limit: number;
    }) {
      const filter = where(input.organizationId, input.scope, input.cadence);
      let after: ReadRow | null = null;
      if (input.cursor !== undefined) {
        after = await prisma.aiInsightReport.findFirst({
          where: { ...filter, id: input.cursor },
          select: readSelect,
        });
        if (after === null) return null;
      }
      const rows = await prisma.aiInsightReport.findMany({
        where: {
          ...filter,
          ...(after === null
            ? {}
            : {
                OR: [
                  { periodEndExclusive: { lt: after.periodEndExclusive } },
                  {
                    periodEndExclusive: after.periodEndExclusive,
                    periodStartInclusive: { lt: after.periodStartInclusive },
                  },
                  {
                    periodEndExclusive: after.periodEndExclusive,
                    periodStartInclusive: after.periodStartInclusive,
                    id: { lt: after.id },
                  },
                ],
              }),
        },
        orderBy: newestFirst,
        take: input.limit + 1,
        select: readSelect,
      });
      return {
        items: rows.slice(0, input.limit).map(publicInsight),
        nextCursor:
          rows.length > input.limit ? rows[input.limit - 1]!.id : null,
      };
    },
    async latest(input: {
      organizationId: string;
      scope: InsightReadScope;
      cadence: AnalyticsSnapshotCadence;
    }) {
      const filter = where(input.organizationId, input.scope, input.cadence);
      const [newest, success] = await prisma.$transaction(
        [
          prisma.aiInsightReport.findFirst({
            where: filter,
            orderBy: newestFirst,
            select: readSelect,
          }),
          prisma.aiInsightReport.findFirst({
            where: { ...filter, state: "SUCCEEDED" },
            orderBy: newestFirst,
            select: readSelect,
          }),
        ],
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      );
      return {
        latest: newest === null ? null : publicInsight(newest),
        lastSuccess: success === null ? null : publicInsight(success),
        stale:
          newest !== null && (success === null || newest.id !== success.id),
      };
    },
    async detail(organizationId: string, id: string, actorUserId: string) {
      return prisma.aiInsightReport.findFirst({
        where: {
          organizationId,
          id,
          organization: {
            status: "ACTIVE",
            memberships: {
              some: {
                userId: actorUserId,
                status: "ACTIVE",
                user: { status: "ACTIVE" },
              },
            },
          },
        },
        select: readSelect,
      });
    },
  };
}

export function createPrismaAiInsightStore(prisma: PrismaClient) {
  const find = (identity: InsightIdentity) =>
    prisma.aiInsightReport.findUnique({
      where: {
        organizationId_scopeKey_cadence_reportingTimezone_periodStartInclusive_periodEndExclusive:
          identity,
      },
    });

  async function observeOrReclaim(
    identity: InsightIdentity,
  ): Promise<ClaimResult | null> {
    const report = await find(identity);
    if (report === null) return null;
    if (report.state !== "IN_PROGRESS") return { kind: "observed", report };
    const now = new Date();
    if (report.claimExpiresAt !== null && report.claimExpiresAt > now)
      return { kind: "observed", report };

    // Once an attempt was reserved, external delivery is ambiguous after a crash.
    if (report.attemptCount !== 0) {
      await prisma.aiInsightReport.updateMany({
        where: {
          id: report.id,
          state: "IN_PROGRESS",
          claimToken: report.claimToken,
          claimExpiresAt: { lte: now },
        },
        data: {
          state: "FAILED",
          failureCategory: "INTERRUPTED",
          completedAt: now,
          claimToken: null,
          claimExpiresAt: null,
        },
      });
      return { kind: "observed", report: (await find(identity))! };
    }

    const token = randomUUID();
    const updated = await prisma.aiInsightReport.updateMany({
      where: {
        id: report.id,
        state: "IN_PROGRESS",
        claimToken: report.claimToken,
        claimExpiresAt: { lte: now },
        attemptCount: 0,
      },
      data: {
        claimToken: token,
        claimedAt: now,
        claimExpiresAt: new Date(now.getTime() + CLAIM_MILLISECONDS),
      },
    });
    const current = (await find(identity))!;
    return updated.count === 1
      ? { kind: "claimed", claim: { report: current, token } }
      : { kind: "observed", report: current };
  }

  return {
    observeOrReclaim,
    async claimNew(
      snapshot: AnalyticsSnapshot,
      promptVersion: string,
    ): Promise<ClaimResult> {
      const identity: InsightIdentity = {
        organizationId: snapshot.organizationId,
        scopeKey: snapshot.scopeKey,
        cadence: snapshot.cadence,
        reportingTimezone: snapshot.reportingTimezone,
        periodStartInclusive: snapshot.periodStartInclusive,
        periodEndExclusive: snapshot.periodEndExclusive,
      };
      const now = new Date();
      const token = randomUUID();
      try {
        const report = await prisma.aiInsightReport.create({
          data: {
            ...identity,
            branchId: snapshot.branchId,
            scope: snapshot.scope,
            snapshotId: snapshot.id,
            schemaVersion: snapshot.schemaVersion,
            metricDefinitionVersion: snapshot.metricDefinitionVersion,
            sourceCutoff: snapshot.sourceCutoff,
            promptVersion,
            claimToken: token,
            claimedAt: now,
            claimExpiresAt: new Date(now.getTime() + CLAIM_MILLISECONDS),
          },
        });
        return { kind: "claimed", claim: { report, token } };
      } catch (error) {
        if (
          !(error instanceof Prisma.PrismaClientKnownRequestError) ||
          error.code !== "P2002"
        )
          throw error;
        return (await observeOrReclaim(identity))!;
      }
    },
    async startAttempt(
      claim: Claim,
      attempt: Pick<
        AiProviderAttempt,
        "provider" | "requestedModel" | "attemptNumber"
      >,
    ) {
      await prisma.$transaction(async (tx) => {
        const changed = await tx.aiInsightReport.updateMany({
          where: {
            id: claim.report.id,
            claimToken: claim.token,
            state: "IN_PROGRESS",
            attemptCount: attempt.attemptNumber - 1,
          },
          data: { attemptCount: null },
        });
        if (changed.count !== 1 || attempt.attemptNumber > 3)
          throw new Error("AI insight claim or call budget is unavailable.");
        await tx.aiInsightAttempt.create({
          data: {
            reportId: claim.report.id,
            ordinal: attempt.attemptNumber,
            provider: attempt.provider,
            requestedModel: attempt.requestedModel,
            startedAt: new Date(),
          },
        });
      });
    },
    async finishAttempt(claim: Claim, attempt: AiProviderAttempt) {
      await prisma.$transaction(async (tx) => {
        const changed = await tx.aiInsightReport.updateMany({
          where: {
            id: claim.report.id,
            claimToken: claim.token,
            state: "IN_PROGRESS",
            attemptCount: null,
          },
          data: {
            attemptCount: attempt.attemptNumber,
            provider: attempt.provider,
          },
        });
        if (changed.count !== 1)
          throw new Error("AI insight claim is unavailable.");
        const finished = await tx.aiInsightAttempt.updateMany({
          where: {
            reportId: claim.report.id,
            ordinal: attempt.attemptNumber,
            finishedAt: null,
            provider: attempt.provider,
            requestedModel: attempt.requestedModel,
          },
          data: {
            finishedAt: new Date(),
            ...(attempt.failureCategory === undefined
              ? {}
              : { failureCategory: attempt.failureCategory }),
            ...(attempt.actualModel === undefined
              ? {}
              : { actualModel: attempt.actualModel }),
            ...(attempt.usage?.promptTokens === undefined
              ? {}
              : { promptTokens: BigInt(attempt.usage.promptTokens) }),
            ...(attempt.usage?.completionTokens === undefined
              ? {}
              : { completionTokens: BigInt(attempt.usage.completionTokens) }),
            ...(attempt.usage?.totalTokens === undefined
              ? {}
              : { totalTokens: BigInt(attempt.usage.totalTokens) }),
            ...(attempt.usage?.cost === undefined
              ? {}
              : { cost: attempt.usage.cost }),
          },
        });
        if (finished.count !== 1)
          throw new Error("AI insight attempt is unavailable.");
      });
    },
    async finish(
      claim: Claim,
      result: Readonly<
        | {
            state: "SUCCEEDED";
            attemptCount: number;
            content: string;
            actualModel: string;
          }
        | {
            state: "FAILED";
            attemptCount: number;
            failureCategory: AiProviderFailureCategory | "INTERRUPTED";
          }
      >,
    ) {
      const now = new Date();
      const changed = await prisma.aiInsightReport.updateMany({
        where: {
          id: claim.report.id,
          claimToken: claim.token,
          state: "IN_PROGRESS",
          attemptCount: result.attemptCount,
        },
        data: {
          state: result.state,
          claimToken: null,
          claimExpiresAt: null,
          completedAt: now,
          ...(result.state === "SUCCEEDED"
            ? {
                content: result.content,
                actualModel: result.actualModel,
                generatedAt: now,
              }
            : { failureCategory: result.failureCategory }),
        },
      });
      if (changed.count !== 1)
        throw new Error("AI insight claim is unavailable.");
      return prisma.aiInsightReport.findUniqueOrThrow({
        where: { id: claim.report.id },
      });
    },
  };
}

export type AiInsightReader = ReturnType<typeof createPrismaAiInsightReader>;
export type AiInsightReadReader = Pick<
  AiInsightReader,
  "authorize" | "detail" | "latest" | "list"
>;
