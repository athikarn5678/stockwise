import { Router, type RequestHandler, type Response } from "express";
import { z } from "zod";

import { getTrustedAuthenticationContext } from "../identity/authentication-context.ts";
import type { DemoInsightReader } from "./demo-production-insight.ts";
import {
  publicInsight,
  type createPrismaAiInsightReader,
  type InsightReadScope,
} from "./ai-insight-store.ts";

const paramsSchema = z.object({ organizationId: z.string().uuid() }).strict();
const detailParamsSchema = paramsSchema.extend({
  insightId: z.string().uuid(),
});
const cadenceSchema = z.enum(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]);
const limitSchema = z
  .string()
  .regex(/^[1-9]\d*$/)
  .transform(Number)
  .pipe(z.number().int().max(100));
const selectorSchema = z.discriminatedUnion("scope", [
  z
    .object({ scope: z.literal("organization"), cadence: cadenceSchema })
    .strict(),
  z
    .object({
      scope: z.literal("branch"),
      branchId: z.string().uuid(),
      cadence: cadenceSchema,
    })
    .strict(),
]);
const listSchema = z.discriminatedUnion("scope", [
  z
    .object({
      scope: z.literal("organization"),
      cadence: cadenceSchema,
      cursor: z.string().uuid().optional(),
      limit: limitSchema.optional(),
    })
    .strict(),
  z
    .object({
      scope: z.literal("branch"),
      branchId: z.string().uuid(),
      cadence: cadenceSchema,
      cursor: z.string().uuid().optional(),
      limit: limitSchema.optional(),
    })
    .strict(),
]);

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

export function createAiInsightRouter(input: {
  authenticationMiddleware: RequestHandler;
  reader: ReturnType<typeof createPrismaAiInsightReader>;
  demoReader?: DemoInsightReader;
}): Router {
  const router = Router();

  router.get(
    "/organizations/:organizationId/ai-insights/demo",
    input.authenticationMiddleware,
    async (request, response, next) => {
      try {
        const params = paramsSchema.safeParse(request.params);
        const query = z
          .discriminatedUnion("scope", [
            z
              .object({
                scope: z.literal("organization"),
                language: z.enum(["en", "th"]),
              })
              .strict(),
            z
              .object({
                scope: z.literal("branch"),
                branchId: z.uuid(),
                language: z.enum(["en", "th"]),
              })
              .strict(),
          ])
          .safeParse(request.query);
        if (!params.success || !query.success)
          return error(
            response,
            400,
            "VALIDATION_ERROR",
            "The insight request is invalid.",
          );
        const actor = getTrustedAuthenticationContext(response);
        if (!actor)
          return error(
            response,
            401,
            "AUTHENTICATION_REQUIRED",
            "Authentication is required.",
          );
        const scope: InsightReadScope =
          query.data.scope === "organization"
            ? { kind: "organization" }
            : { kind: "branch", branchId: query.data.branchId };
        if (!input.demoReader)
          return error(
            response,
            404,
            "NOT_FOUND",
            "The resource is unavailable.",
          );
        const result = await input.demoReader.read({
          actorUserId: actor.actor.id,
          organizationId: params.data.organizationId,
          scope,
          language: query.data.language,
        });
        if (result.kind === "forbidden")
          return error(
            response,
            403,
            "FORBIDDEN",
            "The operation is not permitted.",
          );
        if (result.kind === "not_found")
          return error(
            response,
            404,
            "NOT_FOUND",
            "The resource is unavailable.",
          );
        response.setHeader("Cache-Control", "no-store");
        response.status(200).json({ data: result.insight });
      } catch (cause) {
        next(cause);
      }
    },
  );

  router.get(
    "/organizations/:organizationId/ai-insights",
    input.authenticationMiddleware,
    async (request, response, next) => {
      try {
        const params = paramsSchema.safeParse(request.params);
        const query = listSchema.safeParse(request.query);
        if (!params.success || !query.success)
          return error(
            response,
            400,
            "VALIDATION_ERROR",
            "The insight request is invalid.",
          );
        const actor = getTrustedAuthenticationContext(response);
        if (actor === null)
          return error(
            response,
            401,
            "AUTHENTICATION_REQUIRED",
            "Authentication is required.",
          );
        const scope: InsightReadScope =
          query.data.scope === "organization"
            ? { kind: "organization" }
            : { kind: "branch", branchId: query.data.branchId };
        if (
          !(await input.reader.authorize({
            actorUserId: actor.actor.id,
            organizationId: params.data.organizationId,
            scope,
          }))
        )
          return error(
            response,
            403,
            "FORBIDDEN",
            "The operation is not permitted.",
          );
        const result = await input.reader.list({
          organizationId: params.data.organizationId,
          scope,
          cadence: query.data.cadence,
          limit: query.data.limit ?? 20,
          ...(query.data.cursor === undefined
            ? {}
            : { cursor: query.data.cursor }),
        });
        if (result === null)
          return error(
            response,
            400,
            "INVALID_CURSOR",
            "The cursor is invalid.",
          );
        response.status(200).json({
          data: result.items,
          meta: { nextCursor: result.nextCursor },
        });
      } catch (cause) {
        next(cause);
      }
    },
  );

  router.get(
    "/organizations/:organizationId/ai-insights/latest",
    input.authenticationMiddleware,
    async (request, response, next) => {
      try {
        const params = paramsSchema.safeParse(request.params);
        const query = selectorSchema.safeParse(request.query);
        if (!params.success || !query.success)
          return error(
            response,
            400,
            "VALIDATION_ERROR",
            "The insight request is invalid.",
          );
        const actor = getTrustedAuthenticationContext(response);
        if (actor === null)
          return error(
            response,
            401,
            "AUTHENTICATION_REQUIRED",
            "Authentication is required.",
          );
        const scope: InsightReadScope =
          query.data.scope === "organization"
            ? { kind: "organization" }
            : { kind: "branch", branchId: query.data.branchId };
        if (
          !(await input.reader.authorize({
            actorUserId: actor.actor.id,
            organizationId: params.data.organizationId,
            scope,
          }))
        )
          return error(
            response,
            403,
            "FORBIDDEN",
            "The operation is not permitted.",
          );
        response.status(200).json({
          data: await input.reader.latest({
            organizationId: params.data.organizationId,
            scope,
            cadence: query.data.cadence,
          }),
        });
      } catch (cause) {
        next(cause);
      }
    },
  );

  router.get(
    "/organizations/:organizationId/ai-insights/:insightId",
    input.authenticationMiddleware,
    async (request, response, next) => {
      try {
        const params = detailParamsSchema.safeParse(request.params);
        if (
          !params.success ||
          !z.object({}).strict().safeParse(request.query).success
        )
          return error(
            response,
            400,
            "VALIDATION_ERROR",
            "The insight request is invalid.",
          );
        const actor = getTrustedAuthenticationContext(response);
        if (actor === null)
          return error(
            response,
            401,
            "AUTHENTICATION_REQUIRED",
            "Authentication is required.",
          );
        const row = await input.reader.detail(
          params.data.organizationId,
          params.data.insightId,
          actor.actor.id,
        );
        if (row === null)
          return error(
            response,
            404,
            "INSIGHT_NOT_FOUND",
            "The insight was not found.",
          );
        const scope: InsightReadScope =
          row.scope === "ORGANIZATION"
            ? { kind: "organization" }
            : { kind: "branch", branchId: row.branchId! };
        if (
          !(await input.reader.authorize({
            actorUserId: actor.actor.id,
            organizationId: params.data.organizationId,
            scope,
          }))
        )
          return error(
            response,
            404,
            "INSIGHT_NOT_FOUND",
            "The insight was not found.",
          );
        response.status(200).json({ data: publicInsight(row) });
      } catch (cause) {
        next(cause);
      }
    },
  );

  return router;
}
