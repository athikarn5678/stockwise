import { Router, type Response } from "express";
import type { BetterAuthApplicationSessionService } from "./better-auth-application-session.ts";
import { createCrossSiteRequestProtection } from "./credential-lifecycle-router.ts";
import {
  serializeClearedVerificationProofCookie,
  serializeVerificationProofCookie,
} from "./verification-security.ts";
export function createBetterAuthApplicationRouter(input: {
  service: BetterAuthApplicationSessionService;
  publicWebOrigin: string;
}): Router {
  const router = Router();
  const protect = createCrossSiteRequestProtection(input.publicWebOrigin, true);
  function error(
    response: Response,
    status: number,
    code: string,
    message: string,
  ) {
    response.status(status).json({
      error: {
        code,
        message,
        requestId: response.getHeader("X-Request-Id") ?? "unavailable",
      },
    });
  }
  router.post("/auth/login", protect, async (request, response, next) => {
    try {
      const result = await input.service.login(
        request.body,
        new Headers({
          origin: request.get("Origin") ?? "",
          "sec-fetch-site": request.get("Sec-Fetch-Site") ?? "",
          cookie: request.get("Cookie") ?? "",
        }),
      );
      if (result.outcome === "limited") {
        response.setHeader("Retry-After", String(result.retryAfterSeconds));
        error(
          response,
          429,
          "RATE_LIMITED",
          "Too many login attempts. Try again later.",
        );
      } else if (result.outcome === "validation_error") {
        error(response, 400, "VALIDATION_ERROR", "The request is invalid.");
      } else if (result.outcome === "forbidden") {
        error(response, 403, "FORBIDDEN", "The request is not allowed.");
      } else if (result.outcome === "invalid") {
        error(
          response,
          401,
          "INVALID_CREDENTIALS",
          "The email or password is incorrect.",
        );
      } else if (result.outcome === "verification_required") {
        response.setHeader(
          "Set-Cookie",
          serializeVerificationProofCookie(result.proof, result.expiresAt),
        );
        response.status(202).json({
          data: {
            status: "verification_required",
            nextStep: "verify_email",
            verification: { challengeId: result.challengeId },
          },
          meta: {
            requestId: response.getHeader("X-Request-Id") ?? "unavailable",
          },
        });
      } else {
        response.setHeader("Set-Cookie", [
          ...result.cookies,
          serializeClearedVerificationProofCookie(),
        ]);
        response.status(200).json({
          data: { user: result.user },
          meta: {
            requestId: response.getHeader("X-Request-Id") ?? "unavailable",
          },
        });
      }
    } catch (cause) {
      next(cause);
    }
  });
  router.post("/auth/logout", protect, async (request, response, next) => {
    try {
      const result = await input.service.logout(
        new Headers({
          origin: request.get("Origin") ?? "",
          "sec-fetch-site": request.get("Sec-Fetch-Site") ?? "",
          cookie: request.get("Cookie") ?? "",
        }),
      );
      if (result.outcome === "forbidden") {
        error(response, 403, "FORBIDDEN", "The request is not allowed.");
      } else {
        response.setHeader("Set-Cookie", [
          ...result.cookies,
          serializeClearedVerificationProofCookie(),
        ]);
        response.status(204).end();
      }
    } catch (cause) {
      next(cause);
    }
  });
  router.post("/auth/logout-all", protect, async (request, response, next) => {
    try {
      const result = await input.service.logoutAll(
        new Headers({
          origin: request.get("Origin") ?? "",
          "sec-fetch-site": request.get("Sec-Fetch-Site") ?? "",
          cookie: request.get("Cookie") ?? "",
        }),
      );
      if (result.outcome === "forbidden") {
        error(response, 403, "FORBIDDEN", "The request is not allowed.");
      } else if (result.outcome === "authentication_required") {
        error(
          response,
          401,
          "AUTHENTICATION_REQUIRED",
          "Authentication is required.",
        );
      } else {
        response.setHeader("Set-Cookie", [
          ...result.cookies,
          serializeClearedVerificationProofCookie(),
        ]);
        response.status(204).end();
      }
    } catch (cause) {
      next(cause);
    }
  });
  return router;
}
