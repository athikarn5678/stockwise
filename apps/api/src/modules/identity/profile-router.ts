import { Router, type RequestHandler, type Response } from "express";

import { getTrustedAuthenticationContext } from "./authentication-context.ts";
import { createCrossSiteRequestProtection } from "./credential-lifecycle-router.ts";
import type { SelfProfileService } from "./profile-service.ts";
import { updateProfileRequestSchema } from "./profile-schema.ts";

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
  response.status(status).json({
    error: { code, message, requestId: requestId(response) },
  });
}

function success(response: Response, data: unknown): void {
  response.status(200).json({ data, meta: { requestId: requestId(response) } });
}

export function createSelfProfileRouter({
  authenticationMiddleware,
  publicWebOrigin,
  profileService,
}: {
  authenticationMiddleware: RequestHandler;
  publicWebOrigin: string;
  profileService: SelfProfileService;
}): Router {
  const router = Router();
  const noStore: RequestHandler = (_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    next();
  };

  router.get(
    "/me",
    noStore,
    authenticationMiddleware,
    async (_request, response, next) => {
      if (Object.keys(_request.query).length !== 0) {
        error(response, 400, "VALIDATION_ERROR", "The request is invalid.");
        return;
      }
      const context = getTrustedAuthenticationContext(response);
      if (context === null) {
        error(
          response,
          401,
          "AUTHENTICATION_REQUIRED",
          "Authentication is required.",
        );
        return;
      }
      try {
        const profile = await profileService.get(context.actor.id);
        if (profile === null) {
          error(
            response,
            401,
            "AUTHENTICATION_REQUIRED",
            "Authentication is required.",
          );
          return;
        }
        success(response, profile);
      } catch (cause: unknown) {
        next(cause);
      }
    },
  );

  router.patch(
    "/me/profile",
    noStore,
    createCrossSiteRequestProtection(publicWebOrigin),
    authenticationMiddleware,
    async (request, response, next) => {
      const context = getTrustedAuthenticationContext(response);
      if (context === null) {
        error(
          response,
          401,
          "AUTHENTICATION_REQUIRED",
          "Authentication is required.",
        );
        return;
      }
      if (Object.keys(request.query).length !== 0) {
        error(response, 400, "VALIDATION_ERROR", "The request is invalid.");
        return;
      }
      const parsed = updateProfileRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        error(response, 400, "VALIDATION_ERROR", "The request is invalid.");
        return;
      }
      try {
        const outcome = await profileService.update(
          context.actor.id,
          parsed.data,
        );
        if (outcome.kind === "stale") {
          error(
            response,
            409,
            "PROFILE_STALE",
            "The profile has changed. Reload and try again.",
          );
          return;
        }
        if (outcome.kind === "missing") {
          error(
            response,
            401,
            "AUTHENTICATION_REQUIRED",
            "Authentication is required.",
          );
          return;
        }
        success(response, outcome.profile);
      } catch (cause: unknown) {
        next(cause);
      }
    },
  );

  return router;
}
