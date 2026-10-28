import { prismaAdapter } from "@better-auth/prisma-adapter";
import { betterAuth } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import type { RequestHandler } from "express";

import type { PrismaClient } from "../../generated/prisma/client.ts";
import { hashPassword, verifyPassword } from "./password-hasher.ts";

export const BETTER_AUTH_NATIVE_COOKIE_NAME = "stockwise_native.session_token";

export interface BetterAuthNativeSessionReader {
  api: {
    getSession(input: {
      headers: Headers;
      query: { disableCookieCache: boolean; disableRefresh: boolean };
    }): Promise<{
      session: { id: string; userId: string; token: string };
      user: { id: string };
    } | null>;
  };
}
const DENIED_RESPONSE = () =>
  new Response(JSON.stringify({ error: "Authentication route unavailable" }), {
    headers: { "content-type": "application/json; charset=utf-8" },
    status: 404,
  });

/** Always closed: native public flows cannot become active by mounting this middleware. */
export const denyAllNativeAuthRoutes: RequestHandler = (_request, response) => {
  response.status(404).json({ error: "Authentication route unavailable" });
};

export function createBetterAuthNative(input: {
  prisma: PrismaClient;
  secret: string;
  publicWebOrigin: string;
  secureCookie: boolean;
}) {
  return betterAuth({
    appName: "StockWise",
    baseURL: input.publicWebOrigin,
    basePath: "/api/v1/auth",
    secret: input.secret,
    logger: { disabled: true },
    trustedOrigins: [input.publicWebOrigin],
    database: prismaAdapter(input.prisma, {
      provider: "postgresql",
    }),
    advanced: {
      database: {
        generateId: "uuid",
        joins: false,
      },
      useSecureCookies: input.secureCookie,
      cookiePrefix: "stockwise_native",
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: input.secureCookie,
      },
      cookies: {
        session_token: {
          name: BETTER_AUTH_NATIVE_COOKIE_NAME,
        },
      },
    },
    user: {
      modelName: "User",
      fields: { name: "displayName" },
      additionalFields: {
        nativeRegistrationCompletedAt: {
          type: "date",
          required: false,
          input: false,
          returned: false,
        },
      },
    },
    session: {
      modelName: "BetterAuthSession",
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 15 * 60,
      disableSessionRefresh: true,
      cookieCache: { enabled: false },
      additionalFields: {
        stockwisePurpose: {
          type: "string",
          required: false,
          input: false,
          returned: false,
        },
      },
    },
    account: {
      modelName: "BetterAuthAccount",
      accountLinking: { enabled: false },
    },
    verification: { modelName: "BetterAuthVerification" },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      autoSignIn: false,
      requireEmailVerification: true,
      password: {
        hash: hashPassword,
        verify: ({ hash, password }) => verifyPassword(hash, password),
      },
    },
    databaseHooks: {
      session: {
        create: {
          // Until the accepted registration/login writer can mark provenance,
          // no native session may be minted, including by server-side APIs.
          before: async () => false,
        },
      },
    },
    disabledPaths: [
      "/sign-up/email",
      "/sign-in/email",
      "/sign-in/username",
      "/sign-in/social",
      "/sign-in/credential",
      "/sign-out",
      "/callback/:id",
      "/oauth2/callback/:id",
      "/email-otp/send-verification-otp",
      "/email-otp/verify-email",
      "/email-otp/sign-in",
      "/email-otp/request-password-reset",
      "/email-otp/reset-password",
      "/request-password-reset",
      "/reset-password",
      "/send-verification-email",
      "/verify-email",
      "/change-email",
      "/update-user",
      "/change-password",
      "/set-password",
      "/delete-user",
      "/delete-user/callback",
      "/unlink-account",
      "/link-social",
      "/update-session",
      "/revoke-session",
      "/revoke-sessions",
      "/revoke-other-sessions",
    ],
    hooks: {
      // Defense in depth for accidental direct use of auth.handler().
      // Internal `api.getSession` remains available to the read-only bridge.
      before: createAuthMiddleware(async (context) => {
        if (context.request !== undefined || context.path !== "/get-session") {
          return DENIED_RESPONSE();
        }
        return undefined;
      }),
    },
  });
}
