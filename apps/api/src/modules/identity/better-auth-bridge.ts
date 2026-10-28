import type { Request } from "express";
import { z } from "zod";

import { createSessionAuthenticationMiddleware } from "./authentication-context.ts";
import type { ResolvedAuthenticationSession } from "./authentication-repository.ts";
import {
  BETTER_AUTH_NATIVE_COOKIE_NAME,
  type BetterAuthNativeSessionReader,
} from "./better-auth-native.ts";
import type { SessionConfiguration } from "./session-configuration.ts";
import {
  isNativeAuthoritySessionValid,
  type BetterAuthSessionRepository,
} from "./better-auth-session-repository.ts";

const uuidSchema = z.uuid();
const SAFE_METHODS: Readonly<Record<string, true>> = {
  GET: true,
  HEAD: true,
  OPTIONS: true,
};

type BridgeDependencies = {
  native: BetterAuthNativeSessionReader;
  repository: BetterAuthSessionRepository;
  configuration: SessionConfiguration;
  publicWebOrigin: string;
  now?: () => Date;
};

function nativeCookie(
  header: string | undefined,
  secureCookie: boolean,
): string | null {
  if (header === undefined) return null;
  const name = `${secureCookie ? "__Secure-" : ""}${BETTER_AUTH_NATIVE_COOKIE_NAME}`;
  const values = header.split(";").map((part) => part.trim());
  const matching = values.filter(
    (part) => part.slice(0, part.indexOf("=")) === name,
  );
  if (matching.length !== 1) return null;
  const cookie = matching[0];
  if (cookie === undefined || cookie.length > 4096) return null;
  const value = cookie.slice(cookie.indexOf("=") + 1);
  return /^[A-Za-z0-9._~%+/=-]+$/.test(value) ? cookie : null;
}

// Isolated composition only. Live runtime never selects this resolver in M1.
export function createBetterAuthSessionResolver({
  native,
  repository,
  configuration,
  publicWebOrigin,
  now = () => new Date(),
}: BridgeDependencies): (
  request: Request,
) => Promise<ResolvedAuthenticationSession | null> {
  return async (request) => {
    if (
      SAFE_METHODS[request.method] !== true &&
      (request.headers.origin !== publicWebOrigin ||
        request.headers["sec-fetch-site"] === "cross-site")
    ) {
      return null;
    }
    const cookie = nativeCookie(
      request.headers.cookie,
      configuration.secureCookie,
    );
    if (cookie === null) return null;

    const resolved = await native.api.getSession({
      // No bearer headers, forged actor/scope headers, or other cookies reach native auth.
      headers: new Headers({ cookie }),
      query: { disableCookieCache: true, disableRefresh: true },
    });
    if (
      resolved === null ||
      !uuidSchema.safeParse(resolved.session.id).success ||
      !uuidSchema.safeParse(resolved.user.id).success ||
      resolved.session.userId !== resolved.user.id
    ) {
      return null;
    }

    // Native identity is a selector only. Persisted authority is revalidated
    // under revocation locks and activity is touched before accepting the actor.
    const session = await repository.findSession({
      sessionId: resolved.session.id,
      token: resolved.session.token,
      userId: resolved.user.id,
      configuration,
      now,
    });
    if (
      session === null ||
      !isNativeAuthoritySessionValid(
        session,
        resolved.user.id,
        now().getTime(),
        configuration,
      )
    )
      return null;
    return {
      actor: {
        id: session.user.id,
        email: session.user.email,
        displayName: session.user.displayName,
      },
      sessionId: session.id,
    };
  };
}

/** Resolves Native sessions only when the process selected Native authority. */
export function createBetterAuthAuthenticationMiddleware(
  dependencies: BridgeDependencies,
  nativeEnabled: boolean,
) {
  const resolveSession = createBetterAuthSessionResolver(dependencies);
  return createSessionAuthenticationMiddleware((request) =>
    nativeEnabled ? resolveSession(request) : Promise.resolve(null),
  );
}
