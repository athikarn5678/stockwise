import { Router, type RequestHandler, type Response } from "express";
import { z } from "zod";

import { canonicalEmailSchema, passwordSchema } from "./credential-schemas.ts";
import type { PasswordResetService } from "./credential-lifecycle-service.ts";
import type { NativePasswordResetLimiter } from "./native-password-reset-limiter.ts";
import type { EmailRequestLimitResult } from "./email-request-limiter.ts";
import { isOneTimeToken } from "./one-time-token.ts";
import type { VerificationResponseDelivery } from "./verification-delivery.ts";

const REQUEST_ID_HEADER = "X-Request-Id";
// Check media type independently of body presence; payload validation stays separate.
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;|$)/i;

const emailRequestSchema = z.object({ email: canonicalEmailSchema }).strict();
const tokenSchema = z.string().refine(isOneTimeToken);
const resetPasswordRequestSchema = z
  .object({ newPassword: passwordSchema, token: tokenSchema })
  .strict();

function requestId(response: Response): string {
  const value = response.getHeader(REQUEST_ID_HEADER);
  return typeof value === "string" ? value : "unavailable";
}

function validationError(response: Response): void {
  response.status(400).json({
    error: {
      code: "VALIDATION_ERROR",
      message: "The request is invalid.",
      requestId: requestId(response),
    },
  });
}

function invalidToken(response: Response): void {
  response.status(400).json({
    error: {
      code: "INVALID_TOKEN",
      message: "The token is invalid or expired.",
      requestId: requestId(response),
    },
  });
}

function rateLimited(response: Response, retryAfterSeconds: number): void {
  response.setHeader("Retry-After", retryAfterSeconds.toString());
  response.status(429).json({
    error: {
      code: "RATE_LIMITED",
      message: "Too many requests. Try again later.",
      requestId: requestId(response),
    },
  });
}

function accepted(response: Response): void {
  response.status(202).json({
    data: { status: "accepted" },
    meta: { requestId: requestId(response) },
  });
}
export function attachVerificationDelivery(
  response: Response,
  delivery: VerificationResponseDelivery | null,
): void {
  if (delivery === null) return;
  if (response.destroyed) {
    delivery.abort();
    return;
  }
  response.once("finish", () => delivery.finish());
  response.once("close", () => {
    if (!response.writableFinished) delivery.abort();
  });
}

export function createCrossSiteRequestProtection(
  publicWebOrigin: string,
  strict = false,
): RequestHandler {
  return (request, response, next) => {
    if (strict) {
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Referrer-Policy", "no-referrer");
    }
    const fetchSite = request.get("Sec-Fetch-Site");
    const origin = request.get("Origin");
    let originMatches = true;

    if (strict) {
      originMatches =
        origin === publicWebOrigin &&
        JSON_CONTENT_TYPE.test(request.get("Content-Type")?.trim() ?? "");
    } else if (origin !== undefined) {
      try {
        originMatches = new URL(origin).origin === publicWebOrigin;
      } catch {
        originMatches = false;
      }
    }

    if (fetchSite === "cross-site" || !originMatches) {
      response.status(403).json({
        error: {
          code: "FORBIDDEN",
          message: "The request is not allowed.",
          requestId: requestId(response),
        },
      });
      return;
    }

    next();
  };
}

function createPasswordResetRouterWithLimiter({
  lifecycleService,
  passwordResetLimiter,
  publicWebOrigin,
  strictProtection = false,
}: {
  lifecycleService: PasswordResetService;
  passwordResetLimiter: {
    consume(
      canonicalEmail: string,
    ): EmailRequestLimitResult | Promise<EmailRequestLimitResult>;
  };
  publicWebOrigin: string;
  strictProtection?: boolean;
}): Router {
  const router = Router();
  if (strictProtection) {
    router.use(createCrossSiteRequestProtection(publicWebOrigin, true));
  }

  router.post("/auth/forgot-password", async (request, response, next) => {
    const parsed = emailRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      validationError(response);
      return;
    }

    try {
      const limit = await passwordResetLimiter.consume(parsed.data.email);
      if (!limit.allowed) {
        rateLimited(response, limit.retryAfterSeconds);
        return;
      }

      await lifecycleService.requestPasswordReset(parsed.data.email);
      accepted(response);
    } catch (error: unknown) {
      next(error);
    }
  });

  router.post("/auth/reset-password", async (request, response, next) => {
    const parsed = resetPasswordRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      validationError(response);
      return;
    }

    try {
      const reset = await lifecycleService.resetPassword({
        newPassword: parsed.data.newPassword,
        rawToken: parsed.data.token,
      });
      if (!reset) {
        invalidToken(response);
        return;
      }

      response.status(200).json({
        data: { status: "password_reset" },
        meta: { requestId: requestId(response) },
      });
    } catch (error: unknown) {
      next(error);
    }
  });

  return router;
}

export function createBetterAuthPasswordResetRouter({
  lifecycleService,
  passwordResetLimiter,
  publicWebOrigin,
}: {
  lifecycleService: PasswordResetService;
  passwordResetLimiter: NativePasswordResetLimiter;
  publicWebOrigin: string;
}): Router {
  return createPasswordResetRouterWithLimiter({
    lifecycleService,
    passwordResetLimiter,
    publicWebOrigin,
    strictProtection: true,
  });
}
