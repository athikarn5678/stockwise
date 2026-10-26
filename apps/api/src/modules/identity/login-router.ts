import {
  loginContinuationCookies,
  parseInvitationContinuationKey,
} from "./invitation-continuation-cookie.ts";
import { Router, type Response } from "express";
import { z } from "zod";

import { canonicalEmailSchema, passwordSchema } from "./credential-schemas.ts";
import type { LoginLimiter } from "./login-limiter.ts";
import type { LoginService } from "./login-service.ts";
import type { SessionConfiguration } from "./session-configuration.ts";
import { readSessionCookie, serializeSessionCookie } from "./session-cookie.ts";
import { hashSessionToken } from "./session-token.ts";
import { createCrossSiteRequestProtection } from "./credential-lifecycle-router.ts";
import {
  serializeClearedVerificationProofCookie,
  serializeVerificationProofCookie,
} from "./verification-security.ts";

const REQUEST_ID_HEADER = "X-Request-Id";

export const loginRequestSchema = z
  .object({
    email: canonicalEmailSchema,
    password: passwordSchema,
  })
  .strict();

function requestId(response: Response): string {
  const value = response.getHeader(REQUEST_ID_HEADER);
  return typeof value === "string" ? value : "unavailable";
}

function invalidCredentials(response: Response): void {
  response.status(401).json({
    error: {
      code: "INVALID_CREDENTIALS",
      message: "The email or password is incorrect.",
      requestId: requestId(response),
    },
  });
}

export function createLoginRouter({
  configuration,
  limiter,
  loginService,
  publicWebOrigin,
  continuationKey,
}: {
  configuration: SessionConfiguration;
  limiter: LoginLimiter;
  loginService: LoginService;
  publicWebOrigin: string;
  continuationKey: string;
}): Router {
  const router = Router();
  const parsedContinuationKey = parseInvitationContinuationKey(continuationKey);
  const protectProof = createCrossSiteRequestProtection(publicWebOrigin, true);

  for (const fallback of [false, true]) {
    router.post(
      fallback ? "/auth/verification-password-proof" : "/auth/login",
      protectProof,
      async (request, response, next) => {
        const parsedRequest = loginRequestSchema.safeParse(request.body);
        if (!parsedRequest.success) {
          response.status(400).json({
            error: {
              code: "VALIDATION_ERROR",
              message: "The request is invalid.",
              requestId: requestId(response),
            },
          });
          return;
        }
        const limit = limiter.check(parsedRequest.data.email);
        if (!limit.allowed) {
          response.setHeader("Retry-After", limit.retryAfterSeconds.toString());
          response.status(429).json({
            error: {
              code: "RATE_LIMITED",
              message: "Too many login attempts. Try again later.",
              requestId: requestId(response),
            },
          });
          return;
        }
        try {
          const existingToken = readSessionCookie(request.headers.cookie);
          const result = fallback
            ? await loginService.provePassword(parsedRequest.data)
            : await loginService.login({
                ...parsedRequest.data,
                existingTokenHash:
                  existingToken === null
                    ? null
                    : hashSessionToken(existingToken),
              });
          if (result.outcome === "credential_failure") {
            limiter.recordCredentialFailure(parsedRequest.data.email);
            invalidCredentials(response);
            return;
          }
          if (result.outcome === "account_ineligible") {
            invalidCredentials(response);
            return;
          }
          if (
            result.outcome === "accepted" ||
            result.outcome === "verification_required"
          ) {
            response.append(
              "Set-Cookie",
              serializeVerificationProofCookie(result.proof, result.expiresAt),
            );
            response.status(202).json({
              data:
                result.outcome === "accepted"
                  ? { status: "accepted" }
                  : {
                      status: "verification_required",
                      nextStep: "verify_email",
                      verification: { challengeId: result.challengeId },
                    },
              meta: { requestId: requestId(response) },
            });
            return;
          }
          response.append(
            "Set-Cookie",
            serializeSessionCookie(
              result.rawSessionToken,
              configuration.secureCookie,
            ),
          );
          response.append(
            "Set-Cookie",
            serializeClearedVerificationProofCookie(),
          );
          for (const cookie of loginContinuationCookies({
            cookieHeader: request.headers.cookie,
            flowHeader: request.get("X-Stockwise-Invitation-Flow"),
            key: parsedContinuationKey,
            newSessionCredential: result.rawSessionToken,
            origin: publicWebOrigin,
          })) {
            response.append("Set-Cookie", cookie);
          }
          response.status(200).json({
            data: { user: result.user },
            meta: { requestId: requestId(response) },
          });
        } catch (error: unknown) {
          next(error);
        }
      },
    );
  }
  return router;
}
