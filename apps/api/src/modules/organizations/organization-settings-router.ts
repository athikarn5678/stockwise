import { Router, type RequestHandler, type Response } from "express";

import { getTrustedAuthenticationContext } from "../identity/authentication-context.ts";
import { createCrossSiteRequestProtection } from "../identity/credential-lifecycle-router.ts";
import type { OrganizationSettingsOutcome } from "./organization-settings-repository.ts";
import {
  organizationIdParamsSchema,
  organizationNameUpdateSchema,
} from "./organization-settings-schema.ts";
import type { OrganizationSettingsService } from "./organization-settings-service.ts";

const REQUEST_ID_HEADER = "X-Request-Id";

function requestId(response: Response): string {
  const value = response.getHeader(REQUEST_ID_HEADER);
  return typeof value === "string" ? value : "unavailable";
}

function error(
  response: Response,
  status: number,
  code: string,
  message: string,
): void {
  response
    .status(status)
    .json({ error: { code, message, requestId: requestId(response) } });
}

function sendOutcome(
  response: Response,
  outcome: OrganizationSettingsOutcome,
): void {
  if (outcome.kind === "success") {
    response.status(200).json({
      data: outcome.organization,
      meta: { requestId: requestId(response) },
    });
    return;
  }
  if (outcome.kind === "stale") {
    error(
      response,
      409,
      "ORGANIZATION_STALE",
      "The organization changed. Refresh and try again.",
    );
    return;
  }
  error(response, 403, "FORBIDDEN", "The operation is not permitted.");
}

export function createOrganizationSettingsRouter({
  authenticationMiddleware,
  organizationSettingsService,
  publicWebOrigin,
}: {
  authenticationMiddleware: RequestHandler;
  organizationSettingsService: OrganizationSettingsService;
  publicWebOrigin: string;
}): Router {
  const router = Router();
  const protectMutation = createCrossSiteRequestProtection(publicWebOrigin);
  const noStore: RequestHandler = (_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    next();
  };

  router.get(
    "/organizations/:organizationId",
    noStore,
    authenticationMiddleware,
    async (request, response, next) => {
      const actorUserId = getTrustedAuthenticationContext(response)?.actor.id;
      if (actorUserId === undefined) {
        error(
          response,
          401,
          "AUTHENTICATION_REQUIRED",
          "Authentication is required.",
        );
        return;
      }
      const params = organizationIdParamsSchema.safeParse(request.params);
      if (!params.success || Object.keys(request.query).length !== 0) {
        error(response, 400, "VALIDATION_ERROR", "The request is invalid.");
        return;
      }
      try {
        sendOutcome(
          response,
          await organizationSettingsService.get(
            actorUserId,
            params.data.organizationId,
          ),
        );
      } catch (cause: unknown) {
        next(cause);
      }
    },
  );

  router.patch(
    "/organizations/:organizationId",
    noStore,
    protectMutation,
    authenticationMiddleware,
    async (request, response, next) => {
      const actorUserId = getTrustedAuthenticationContext(response)?.actor.id;
      if (actorUserId === undefined) {
        error(
          response,
          401,
          "AUTHENTICATION_REQUIRED",
          "Authentication is required.",
        );
        return;
      }
      const params = organizationIdParamsSchema.safeParse(request.params);
      const body = organizationNameUpdateSchema.safeParse(request.body);
      if (
        !params.success ||
        !body.success ||
        Object.keys(request.query).length !== 0
      ) {
        error(response, 400, "VALIDATION_ERROR", "The request is invalid.");
        return;
      }
      try {
        sendOutcome(
          response,
          await organizationSettingsService.update(
            actorUserId,
            params.data.organizationId,
            body.data,
          ),
        );
      } catch (cause: unknown) {
        next(cause);
      }
    },
  );

  return router;
}
