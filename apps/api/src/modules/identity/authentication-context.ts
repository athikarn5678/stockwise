import type { Request, RequestHandler, Response } from "express";

const REQUEST_ID_HEADER = "X-Request-Id";
const trustedAuthenticationContextKey: unique symbol = Symbol(
  "trustedAuthenticationContext",
);
const trustedAuthenticationContextBrand: unique symbol = Symbol(
  "trustedAuthenticationContextBrand",
);

export interface ResolvedAuthenticationSession {
  actor: {
    displayName: string | null;
    email: string;
    id: string;
  };
  sessionId: string;
}

export type TrustedAuthenticationContext = Readonly<{
  actor: Readonly<{
    displayName: string | null;
    email: string;
    id: string;
    status: "ACTIVE";
    verified: true;
  }>;
  sessionId: string;
  [trustedAuthenticationContextBrand]: true;
}>;

type AuthenticationLocals = {
  [trustedAuthenticationContextKey]?: TrustedAuthenticationContext;
};

function requestId(response: Response): string {
  const value = response.getHeader(REQUEST_ID_HEADER);
  return typeof value === "string" ? value : "unavailable";
}

function denyAuthentication(response: Response): void {
  response.status(401).json({
    error: {
      code: "AUTHENTICATION_REQUIRED",
      message: "Authentication is required.",
      requestId: requestId(response),
    },
  });
}

export function getTrustedAuthenticationContext(
  response: Response,
): TrustedAuthenticationContext | null {
  const locals = response.locals as AuthenticationLocals;
  const context = locals[trustedAuthenticationContextKey];

  return context?.[trustedAuthenticationContextBrand] === true ? context : null;
}

// Both adapters share the private brand; neither supplies membership or RBAC.
export function createSessionAuthenticationMiddleware(
  resolveSession: (
    request: Request,
  ) => Promise<ResolvedAuthenticationSession | null>,
): RequestHandler {
  return async (request, response, next) => {
    try {
      const resolved = await resolveSession(request);
      if (resolved === null) {
        denyAuthentication(response);
        return;
      }

      const context = Object.freeze({
        actor: Object.freeze({
          ...resolved.actor,
          status: "ACTIVE" as const,
          verified: true as const,
        }),
        sessionId: resolved.sessionId,
        [trustedAuthenticationContextBrand]: true as const,
      });
      const locals = response.locals as AuthenticationLocals;
      locals[trustedAuthenticationContextKey] = context;
      next();
    } catch (error: unknown) {
      next(error);
    }
  };
}
