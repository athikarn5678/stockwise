import { clearPresentedInvitationContinuationCookies } from "./invitation-continuation-cookie.ts";
import { Router, type RequestHandler, type Response } from "express";
import { z } from "zod";

import { getTrustedAuthenticationContext } from "./authentication-context.ts";
import { canonicalEmailSchema, passwordSchema } from "./credential-schemas.ts";
import type {
  CredentialLifecycleService,
  PasswordResetService,
} from "./credential-lifecycle-service.ts";
import type { NativePasswordResetLimiter } from "./native-password-reset-limiter.ts";
import type {
  EmailRequestLimiter,
  EmailRequestLimitResult,
} from "./email-request-limiter.ts";
import { isOneTimeToken } from "./one-time-token.ts";
import type { SessionConfiguration } from "./session-configuration.ts";
import {
  readSessionCookie,
  serializeClearedSessionCookie,
} from "./session-cookie.ts";
import { hashSessionToken } from "./session-token.ts";
import type { VerificationService } from "./verification-service.ts";
import { serializeClearedVerificationProofCookie } from "./verification-security.ts";
import type { VerificationResponseDelivery } from "./verification-delivery.ts";

const REQUEST_ID_HEADER = "X-Request-Id";
// Check media type independently of body presence; payload validation stays separate.
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;|$)/i;

const emailRequestSchema = z.object({ email: canonicalEmailSchema }).strict();
const tokenSchema = z.string().refine(isOneTimeToken);
const tokenRequestSchema = z.object({ token: tokenSchema }).strict();
const resetPasswordRequestSchema = z
  .object({ newPassword: passwordSchema, token: tokenSchema })
  .strict();
const verificationCodeRequestSchema = z
  .object({
    email: canonicalEmailSchema,
    challengeId: z.uuid(),
    code: z.string().regex(/^[0-9]{6}$/),
  })
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

function verificationCompletion(
  response: Response,
  result: "verified" | "already_verified" | "invalid" | "proof_required",
  invalidCode: boolean,
): void {
  if (result === "invalid") {
    if (!invalidCode) {
      invalidToken(response);
      return;
    }
    response.status(400).json({
      error: {
        code: "INVALID_VERIFICATION_CODE",
        message: "The verification code is invalid or expired.",
        requestId: requestId(response),
      },
    });
    return;
  }
  if (result === "proof_required") {
    response.status(401).json({
      error: {
        code: "VERIFICATION_PASSWORD_PROOF_REQUIRED",
        message: "Current password proof is required.",
        requestId: requestId(response),
      },
    });
    return;
  }
  if (result === "already_verified") {
    // Informational replay only; never sets or clears a session/proof cookie.
    response.status(200).json({
      data: { status: "already_verified" },
      meta: { requestId: requestId(response) },
    });
    return;
  }
  response.append("Set-Cookie", serializeClearedVerificationProofCookie());
  response.status(200).json({
    data: { status: "verified" },
    meta: { requestId: requestId(response) },
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

export function createPasswordResetRouter({
  lifecycleService,
  passwordResetLimiter,
  publicWebOrigin,
  strictProtection = false,
}: {
  lifecycleService: PasswordResetService;
  passwordResetLimiter: EmailRequestLimiter;
  publicWebOrigin: string;
  strictProtection?: boolean;
}): Router {
  return createPasswordResetRouterWithLimiter({
    lifecycleService,
    passwordResetLimiter,
    publicWebOrigin,
    strictProtection,
  });
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

export function createCredentialLifecycleRouter({
  authenticationMiddleware,
  configuration,
  lifecycleService,
  passwordResetLimiter,
  publicWebOrigin,
  verificationService,
}: {
  authenticationMiddleware: RequestHandler;
  configuration: SessionConfiguration;
  lifecycleService: CredentialLifecycleService;
  passwordResetLimiter: EmailRequestLimiter;
  publicWebOrigin: string;
  verificationService: VerificationService;
}): Router {
  const router = Router();
  const crossSiteRequestProtection =
    createCrossSiteRequestProtection(publicWebOrigin);
  const strictProtection = createCrossSiteRequestProtection(
    publicWebOrigin,
    true,
  );

  router.post(
    "/auth/logout",
    crossSiteRequestProtection,
    async (request, response, next) => {
      const rawToken = readSessionCookie(request.headers.cookie);

      try {
        if (rawToken !== null) {
          await lifecycleService.logoutCurrent(hashSessionToken(rawToken));
        }
        response.setHeader(
          "Set-Cookie",
          serializeClearedSessionCookie(configuration.secureCookie),
        );
        response.append(
          "Set-Cookie",
          serializeClearedVerificationProofCookie(),
        );
        for (const cookie of clearPresentedInvitationContinuationCookies(
          request.headers.cookie,
        )) {
          response.append("Set-Cookie", cookie);
        }
        response.status(204).end();
      } catch (error: unknown) {
        next(error);
      }
    },
  );

  router.post(
    "/auth/logout-all",
    crossSiteRequestProtection,
    authenticationMiddleware,
    async (request, response, next) => {
      const context = getTrustedAuthenticationContext(response);
      if (context === null) {
        response.status(401).json({
          error: {
            code: "AUTHENTICATION_REQUIRED",
            message: "Authentication is required.",
            requestId: requestId(response),
          },
        });
        return;
      }

      try {
        await lifecycleService.logoutAll(context.actor.id);
        response.setHeader(
          "Set-Cookie",
          serializeClearedSessionCookie(configuration.secureCookie),
        );
        response.append(
          "Set-Cookie",
          serializeClearedVerificationProofCookie(),
        );
        for (const cookie of clearPresentedInvitationContinuationCookies(
          request.headers.cookie,
        )) {
          response.append("Set-Cookie", cookie);
        }
        response.status(204).end();
      } catch (error: unknown) {
        next(error);
      }
    },
  );

  router.post(
    "/auth/verification-resend",
    strictProtection,
    async (request, response, next) => {
      const parsed = emailRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        validationError(response);
        return;
      }
      try {
        const result = await verificationService.resend(parsed.data.email);
        if (result.outcome === "limited") {
          rateLimited(response, result.retryAfterSeconds);
          return;
        }
        attachVerificationDelivery(response, result.delivery);
        response.status(202).json({
          data: {
            status: "accepted",
            verification: { challengeId: result.challengeId },
          },
          meta: { requestId: requestId(response) },
        });
      } catch (error: unknown) {
        next(error);
      }
    },
  );

  router.post(
    "/auth/verify-email-code",
    strictProtection,
    async (request, response, next) => {
      const parsed = verificationCodeRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        verificationCompletion(response, "invalid", true);
        return;
      }
      try {
        const result = await verificationService.completeCode({
          ...parsed.data,
          cookieHeader: request.headers.cookie,
        });
        verificationCompletion(response, result, true);
      } catch (error: unknown) {
        next(error);
      }
    },
  );

  router.post(
    "/auth/verify-email",
    strictProtection,
    async (request, response, next) => {
      const parsed = tokenRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        invalidToken(response);
        return;
      }
      try {
        const result = await verificationService.completeLink({
          token: parsed.data.token,
          cookieHeader: request.headers.cookie,
        });
        verificationCompletion(response, result, false);
      } catch (error: unknown) {
        next(error);
      }
    },
  );

  router.use(
    createPasswordResetRouter({
      lifecycleService,
      passwordResetLimiter,
      publicWebOrigin,
    }),
  );

  return router;
}
