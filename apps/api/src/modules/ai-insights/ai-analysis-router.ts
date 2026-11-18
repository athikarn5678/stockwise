import { Router, type RequestHandler, type Response } from "express";
import { z } from "zod";

import { getTrustedAuthenticationContext } from "../identity/authentication-context.ts";
import type { AiAnalyzeService } from "./ai-analyze-service.ts";
import type { AiAnalysisStore } from "./ai-analysis-store.ts";
import { publicAnalysisRun } from "./ai-analysis-store.ts";
import type {
  AiInsightReadReader,
  InsightReadScope,
} from "./ai-insight-store.ts";

const paramsSchema = z.object({ organizationId: z.string().uuid() }).strict();
const detailParamsSchema = paramsSchema.extend({ runId: z.string().uuid() });
const emptyQuerySchema = z.object({}).strict();
const limitSchema = z
  .string()
  .regex(/^[1-9]\d*$/)
  .transform(Number)
  .pipe(z.number().int().max(50));
const scopeFields = {
  scope: z.literal("organization"),
} as const;
const scopeQuerySchema = z.discriminatedUnion("scope", [
  z.object(scopeFields).strict(),
  z.object({ scope: z.literal("branch"), branchId: z.uuid() }).strict(),
]);
const listQuerySchema = z.discriminatedUnion("scope", [
  z
    .object({
      ...scopeFields,
      cursor: z.uuid().optional(),
      limit: limitSchema.optional(),
    })
    .strict(),
  z
    .object({
      scope: z.literal("branch"),
      branchId: z.uuid(),
      cursor: z.uuid().optional(),
      limit: limitSchema.optional(),
    })
    .strict(),
]);
const createBodySchema = z
  .object({
    days: z.union([z.literal(7), z.literal(14), z.literal(30)]).optional(),
  })
  .strict();
const retryBodySchema = z.object({ language: z.enum(["th", "en"]) }).strict();

function error(
  response: Response,
  status: number,
  code: string,
  message: string,
): void {
  response.status(status).json({
    error: {
      code,
      message,
      requestId: response.getHeader("X-Request-Id") ?? "unavailable",
    },
  });
}

function invalid(response: Response): void {
  error(response, 400, "VALIDATION_ERROR", "The analysis request is invalid.");
}

function forbidden(response: Response): void {
  error(response, 403, "FORBIDDEN", "The operation is not permitted.");
}

/** Missing and unauthorized runs share one body so scopes cannot be probed. */
function notFound(response: Response): void {
  error(response, 404, "NOT_FOUND", "The resource is unavailable.");
}

function scopeOf(
  query: z.infer<typeof scopeQuerySchema> | z.infer<typeof listQuerySchema>,
): InsightReadScope {
  return query.scope === "organization"
    ? { kind: "organization" }
    : { kind: "branch", branchId: query.branchId };
}

function serviceFailure(
  response: Response,
  result: Exclude<
    Awaited<ReturnType<AiAnalyzeService["analyze"]>>,
    { kind: "ok" }
  >,
): void {
  if (result.kind === "not_found") return notFound(response);
  if (result.kind === "insufficient_data")
    return error(
      response,
      422,
      "INSUFFICIENT_DATA",
      "There are no sales in the selected period to analyze.",
    );
  if (result.kind === "rate_limited") {
    response.setHeader("Retry-After", String(result.retryAfterSeconds));
    return error(
      response,
      429,
      "RATE_LIMITED",
      "The analysis was requested too recently.",
    );
  }
  if (result.kind === "provider_failed")
    return error(
      response,
      502,
      "AI_PROVIDER_FAILED",
      "The AI provider is unavailable.",
    );
  return error(
    response,
    502,
    "AI_RESPONSE_REJECTED",
    "The AI response did not meet the required contract.",
  );
}

export function createAiAnalysisRouter(input: {
  authenticationMiddleware: RequestHandler;
  reader: Pick<AiInsightReadReader, "authorize">;
  service: AiAnalyzeService;
  store: Pick<AiAnalysisStore, "find" | "list">;
}): Router {
  const router = Router();

  router.post(
    "/organizations/:organizationId/ai-analysis/runs",
    input.authenticationMiddleware,
    async (request, response, next) => {
      try {
        const params = paramsSchema.safeParse(request.params);
        const query = scopeQuerySchema.safeParse(request.query);
        if (!params.success || !query.success) return invalid(response);
        const actor = getTrustedAuthenticationContext(response);
        if (actor === null)
          return error(
            response,
            401,
            "AUTHENTICATION_REQUIRED",
            "Authentication is required.",
          );
        const scope = scopeOf(query.data);
        // Same three-permission check as the persisted reads (ADR-046/048).
        if (
          !(await input.reader.authorize({
            actorUserId: actor.actor.id,
            organizationId: params.data.organizationId,
            scope,
          }))
        )
          return forbidden(response);
        const body = createBodySchema.safeParse(request.body);
        if (!body.success) return invalid(response);
        const result = await input.service.analyze({
          actorUserId: actor.actor.id,
          days: body.data.days ?? 7,
          organizationId: params.data.organizationId,
          scope,
        });
        if (result.kind !== "ok") return serviceFailure(response, result);
        response.setHeader("Cache-Control", "no-store");
        response.status(200).json({ data: result.run });
      } catch (cause) {
        next(cause);
      }
    },
  );

  router.get(
    "/organizations/:organizationId/ai-analysis/runs",
    input.authenticationMiddleware,
    async (request, response, next) => {
      try {
        const params = paramsSchema.safeParse(request.params);
        const query = listQuerySchema.safeParse(request.query);
        if (!params.success || !query.success) return invalid(response);
        const actor = getTrustedAuthenticationContext(response);
        if (actor === null)
          return error(
            response,
            401,
            "AUTHENTICATION_REQUIRED",
            "Authentication is required.",
          );
        const scope = scopeOf(query.data);
        if (
          !(await input.reader.authorize({
            actorUserId: actor.actor.id,
            organizationId: params.data.organizationId,
            scope,
          }))
        )
          return forbidden(response);
        const result = await input.store.list({
          branchId: scope.kind === "branch" ? scope.branchId : null,
          ...(query.data.cursor === undefined
            ? {}
            : { cursor: query.data.cursor }),
          limit: query.data.limit ?? 10,
          organizationId: params.data.organizationId,
        });
        if (result === null)
          return error(
            response,
            400,
            "INVALID_CURSOR",
            "The cursor is invalid.",
          );
        response.setHeader("Cache-Control", "no-store");
        response.status(200).json({
          data: result.items,
          meta: { nextCursor: result.nextCursor },
        });
      } catch (cause) {
        next(cause);
      }
    },
  );

  router.post(
    "/organizations/:organizationId/ai-analysis/runs/:runId/retry",
    input.authenticationMiddleware,
    async (request, response, next) => {
      try {
        const params = detailParamsSchema.safeParse(request.params);
        const query = scopeQuerySchema.safeParse(request.query);
        if (!params.success || !query.success) return invalid(response);
        const actor = getTrustedAuthenticationContext(response);
        if (actor === null)
          return error(
            response,
            401,
            "AUTHENTICATION_REQUIRED",
            "Authentication is required.",
          );
        const scope = scopeOf(query.data);
        if (
          !(await input.reader.authorize({
            actorUserId: actor.actor.id,
            organizationId: params.data.organizationId,
            scope,
          }))
        )
          return forbidden(response);
        const body = retryBodySchema.safeParse(request.body);
        if (!body.success) return invalid(response);
        const result = await input.service.retry({
          actorUserId: actor.actor.id,
          language: body.data.language,
          organizationId: params.data.organizationId,
          runId: params.data.runId,
          scope,
        });
        if (result.kind !== "ok") return serviceFailure(response, result);
        response.setHeader("Cache-Control", "no-store");
        response.status(200).json({ data: result.run });
      } catch (cause) {
        next(cause);
      }
    },
  );

  router.get(
    "/organizations/:organizationId/ai-analysis/runs/:runId",
    input.authenticationMiddleware,
    async (request, response, next) => {
      try {
        const params = detailParamsSchema.safeParse(request.params);
        if (
          !params.success ||
          !emptyQuerySchema.safeParse(request.query).success
        )
          return invalid(response);
        const actor = getTrustedAuthenticationContext(response);
        if (actor === null)
          return error(
            response,
            401,
            "AUTHENTICATION_REQUIRED",
            "Authentication is required.",
          );
        const row = await input.store.find(
          params.data.organizationId,
          params.data.runId,
        );
        if (row === null) return notFound(response);
        // A run is authorized against its own stored scope, never the query.
        const scope: InsightReadScope =
          row.branchId === null
            ? { kind: "organization" }
            : { kind: "branch", branchId: row.branchId };
        if (
          !(await input.reader.authorize({
            actorUserId: actor.actor.id,
            organizationId: params.data.organizationId,
            scope,
          }))
        )
          return notFound(response);
        response.setHeader("Cache-Control", "no-store");
        response.status(200).json({ data: publicAnalysisRun(row) });
      } catch (cause) {
        next(cause);
      }
    },
  );

  return router;
}
