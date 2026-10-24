import { prismaAdapter } from "@better-auth/prisma-adapter";
import { betterAuth } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";

import type { PrismaClient } from "../../generated/prisma/client.ts";
import {
  createBetterAuthNative,
  BETTER_AUTH_NATIVE_COOKIE_NAME,
} from "./better-auth-native.ts";
import { loginRequestSchema } from "./login-router.ts";
import type { LoginLimiter } from "./login-limiter.ts";
import { DUMMY_PASSWORD_HASH, verifyPassword } from "./password-hasher.ts";
import type { SessionConfiguration } from "./session-configuration.ts";
import type { PendingRegistrationService } from "./pending-registration-service.ts";
import { isNativeAuthoritySessionValid } from "./better-auth-session-repository.ts";

export type NativeLoginResult =
  | { outcome: "invalid" }
  | { outcome: "forbidden" }
  | { outcome: "validation_error" }
  | { outcome: "limited"; retryAfterSeconds: number }
  | {
      outcome: "verification_required";
      proof: string;
      expiresAt: Date;
      challengeId: string | null;
    }
  | {
      outcome: "authenticated";
      cookies: string[];
      user: { id: string; email: string; displayName: string | null };
    };

export interface BetterAuthApplicationSessionService {
  login(body: unknown, headers: Headers): Promise<NativeLoginResult>;
  logout(
    headers: Headers,
  ): Promise<
    { outcome: "forbidden" } | { outcome: "logged_out"; cookies: string[] }
  >;
  logoutAll(
    headers: Headers,
  ): Promise<
    | { outcome: "forbidden" }
    | { outcome: "authentication_required" }
    | { outcome: "logged_out"; cookies: string[] }
  >;
}

/** Isolated service only: never exposes a native handler or installs a live router. */
export function createBetterAuthApplicationSessionService(input: {
  prisma: PrismaClient;
  native: ReturnType<typeof createBetterAuthNative>;
  publicWebOrigin: string;
  configuration: SessionConfiguration;
  limiter: LoginLimiter;
  pendingRegistrationService: Pick<PendingRegistrationService, "provePassword">;
}): BetterAuthApplicationSessionService {
  const { native } = input;
  const cookieName = `${input.configuration.secureCookie ? "__Secure-" : ""}${BETTER_AUTH_NATIVE_COOKIE_NAME}`;
  function cookieHeaders(headers: Headers) {
    const cookies = (headers.get("cookie") ?? "")
      .split(";")
      .map((value) => value.trim())
      .filter((value) => value.startsWith(`${cookieName}=`));
    return new Headers(
      cookies.length === 1 && cookies[0]!.length <= 4096
        ? { cookie: cookies[0]! }
        : {},
    );
  }
  return {
    async login(body: unknown, headers: Headers): Promise<NativeLoginResult> {
      if (
        headers.get("origin") !== input.publicWebOrigin ||
        headers.get("sec-fetch-site") === "cross-site"
      )
        return { outcome: "forbidden" };
      const parsed = loginRequestSchema.safeParse(body);
      if (!parsed.success) return { outcome: "validation_error" };
      const { email, password } = parsed.data;
      return input.limiter.serializeByEmail(email, async () => {
        const limit = input.limiter.check(email);
        if (!limit.allowed)
          return {
            outcome: "limited",
            retryAfterSeconds: limit.retryAfterSeconds,
          };
        const snapshot = await input.prisma.user.findUnique({
          where: { email },
        });
        if (snapshot === null) {
          const proof = await input.pendingRegistrationService.provePassword({
            email,
            password,
          });
          if (proof.outcome === "limited")
            return {
              outcome: "limited",
              retryAfterSeconds: proof.retryAfterSeconds,
            };
          if (proof.outcome !== "proved") {
            if (
              proof.outcome === "invalid" &&
              proof.credentialFailure !== false
            )
              input.limiter.recordCredentialFailure(email);
            return { outcome: "invalid" };
          }
          return {
            outcome: "verification_required",
            proof: proof.proof,
            expiresAt: proof.expiresAt,
            challengeId: null,
          };
        }
        const credential =
          snapshot &&
          (await input.prisma.betterAuthAccount.findUnique({
            where: {
              providerId_accountId: {
                providerId: "credential",
                accountId: snapshot.id,
              },
            },
          }));
        const hasCredential =
          snapshot !== null &&
          credential?.password != null &&
          credential.userId === snapshot.id;
        const passwordMatches = await verifyPassword(
          hasCredential ? credential.password! : DUMMY_PASSWORD_HASH,
          password,
        );
        if (!hasCredential || !passwordMatches) {
          input.limiter.recordCredentialFailure(email);
          return { outcome: "invalid" };
        }
        if (
          snapshot === null ||
          credential?.password == null ||
          credential.userId !== snapshot.id ||
          snapshot.status !== "ACTIVE" ||
          snapshot.disabledAt !== null ||
          !snapshot.emailVerified ||
          snapshot.emailVerifiedAt === null ||
          snapshot.nativeRegistrationCompletedAt === null
        ) {
          return { outcome: "invalid" };
        }
        let used = false;
        let provisionalId: string | undefined;
        // One-use internal capability; provisional sessions have neither purpose nor version.
        // No password computation or native sign-in runs while row locks are held.
        const writer = betterAuth({
          ...native.options,
          session: {
            ...native.options.session,
            expiresIn: input.configuration.absoluteTimeoutMilliseconds / 1000,
          },
          emailAndPassword: {
            ...native.options.emailAndPassword,
            // StockWise validates 128 code points; supplementary characters use two UTF-16 units.
            maxPasswordLength: 256,
            password: {
              hash: native.options.emailAndPassword!.password!.hash!,
              // Reuse the exact snapshot proof; do not repeat Argon2 or accept a different input.
              verify: async ({ hash, password: candidate }) =>
                hash === credential.password && candidate === password,
            },
          },
          hooks: {
            before: createAuthMiddleware(async (context) => {
              if (
                context.request !== undefined ||
                context.path !== "/sign-in/email"
              )
                throw new Error("Native writer unavailable");
            }),
          },
          databaseHooks: {
            session: {
              create: {
                before: async (session, context) => {
                  if (
                    used ||
                    context?.request !== undefined ||
                    context?.path !== "/sign-in/email" ||
                    session.userId !== snapshot.id
                  )
                    return false;
                  used = true;
                  return { data: { ...session, stockwisePurpose: null } };
                },
                after: async (session) => {
                  provisionalId = session.id;
                },
              },
            },
          },
        });
        let finalized = false;
        let result: NativeLoginResult;
        const compensate = async () => {
          if (provisionalId === undefined) return;
          await input.prisma.betterAuthSession.deleteMany({
            where: { id: provisionalId },
          });
          if (
            await input.prisma.betterAuthSession.findUnique({
              where: { id: provisionalId },
            })
          )
            throw new Error("Native session compensation failed");
        };
        try {
          const response = await writer.api.signInEmail({
            body: { email, password },
            headers: new Headers({ origin: input.publicWebOrigin }),
            asResponse: true,
          });
          if (response.status === 401 || response.status === 403) {
            result = { outcome: "invalid" };
          } else {
            if (!response.ok) throw new Error("Native session creation failed");
            const cookies = response.headers
              .getSetCookie()
              .filter((cookie) => cookie.startsWith(`${cookieName}=`));
            if (cookies.length !== 1)
              throw new Error("Native session cookie unavailable");
            const resolved = await native.api.getSession({
              headers: new Headers({ cookie: cookies[0]!.split(";")[0]! }),
              query: { disableCookieCache: true, disableRefresh: true },
            });
            if (
              resolved === null ||
              resolved.user.id !== snapshot.id ||
              resolved.session.id !== provisionalId
            )
              throw new Error("Native session resolution failed");
            const old = await native.api.getSession({
              headers: cookieHeaders(headers),
              query: { disableCookieCache: true, disableRefresh: true },
            });
            result = await input.prisma.$transaction(
              async (tx): Promise<NativeLoginResult> => {
                // Credential mutation lock order: user, then credential account.
                await tx.$queryRaw`SELECT id FROM users WHERE id = ${snapshot.id}::uuid FOR UPDATE`;
                await tx.$queryRaw`SELECT id FROM better_auth_accounts WHERE user_id = ${snapshot.id}::uuid AND provider_id = 'credential' FOR UPDATE`;
                const user = await tx.user.findUnique({
                  where: { id: snapshot.id },
                });
                const account = await tx.betterAuthAccount.findUnique({
                  where: { id: credential.id },
                });
                const created = await tx.betterAuthSession.findUnique({
                  where: { id: resolved.session.id },
                });
                if (
                  user === null ||
                  user.email !== email ||
                  user.credentialVersion !== snapshot.credentialVersion ||
                  user.passwordChangedAt.getTime() !==
                    snapshot.passwordChangedAt.getTime() ||
                  user.status !== "ACTIVE" ||
                  user.disabledAt !== null ||
                  !user.emailVerified ||
                  user.emailVerifiedAt === null ||
                  user.nativeRegistrationCompletedAt === null ||
                  user.nativeRegistrationCompletedAt.getTime() !==
                    snapshot.nativeRegistrationCompletedAt!.getTime() ||
                  account?.password !== credential.password ||
                  account.userId !== user.id ||
                  account.providerId !== "credential" ||
                  account.accountId !== user.id ||
                  created === null ||
                  created.userId !== user.id ||
                  created.stockwisePurpose !== null ||
                  created.stockwiseCredentialVersion !== null ||
                  created.expiresAt.getTime() <= Date.now() ||
                  user.nativeRegistrationCompletedAt > created.createdAt ||
                  user.passwordChangedAt > created.createdAt
                )
                  return { outcome: "invalid" };
                await tx.betterAuthSession.update({
                  where: { id: created.id },
                  data: {
                    stockwisePurpose: "APPLICATION",
                    stockwiseCredentialVersion: user.credentialVersion,
                    expiresAt: new Date(
                      created.createdAt.getTime() +
                        input.configuration.absoluteTimeoutMilliseconds,
                    ),
                  },
                });
                if (old !== null) {
                  const reader = betterAuth({
                    ...native.options,
                    database: prismaAdapter(tx, { provider: "postgresql" }),
                  });
                  await (
                    await reader.$context
                  ).internalAdapter.deleteSession(old.session.token);
                  if (
                    await tx.betterAuthSession.findUnique({
                      where: { id: old.session.id },
                    })
                  )
                    throw new Error("Native session rotation failed");
                }
                return {
                  outcome: "authenticated",
                  cookies,
                  user: {
                    id: user.id,
                    email: user.email,
                    displayName: user.displayName,
                  },
                };
              },
            );
            finalized = result.outcome === "authenticated";
          }
        } catch (error) {
          try {
            await compensate();
          } catch {
            // Preserve the original failure; an unmarked session cannot grant authority.
          }
          throw error;
        }
        if (!finalized) await compensate();
        return result;
      });
    },
    async logout(
      headers: Headers,
    ): Promise<
      { outcome: "forbidden" } | { outcome: "logged_out"; cookies: string[] }
    > {
      if (
        headers.get("origin") !== input.publicWebOrigin ||
        headers.get("sec-fetch-site") === "cross-site"
      )
        return { outcome: "forbidden" };
      const resolved = await native.api.getSession({
        headers: cookieHeaders(headers),
        query: { disableCookieCache: true, disableRefresh: true },
      });
      // Native signOut swallows DB failures; deleteSession propagates them, so no cookie is cleared on failure.
      if (resolved !== null)
        await (
          await native.$context
        ).internalAdapter.deleteSession(resolved.session.token);
      if (
        resolved !== null &&
        (await input.prisma.betterAuthSession.findUnique({
          where: { id: resolved.session.id },
        })) !== null
      )
        throw new Error("Native session revocation failed");
      return {
        outcome: "logged_out",
        cookies: [
          `${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${input.configuration.secureCookie ? "; Secure" : ""}`,
        ],
      };
    },
    async logoutAll(
      headers: Headers,
    ): Promise<
      | { outcome: "forbidden" }
      | { outcome: "authentication_required" }
      | { outcome: "logged_out"; cookies: string[] }
    > {
      if (
        headers.get("origin") !== input.publicWebOrigin ||
        headers.get("sec-fetch-site") === "cross-site"
      )
        return { outcome: "forbidden" };
      const resolved = await native.api.getSession({
        headers: cookieHeaders(headers),
        query: { disableCookieCache: true, disableRefresh: true },
      });
      if (resolved === null) return { outcome: "authentication_required" };
      const revoked = await input.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM users WHERE id = ${resolved.user.id}::uuid FOR UPDATE`;
        // Same user -> session lock order and eligibility predicate as the Bridge.
        await tx.$queryRaw`SELECT id FROM better_auth_sessions WHERE id = ${resolved.session.id}::uuid FOR UPDATE`;
        const session = await tx.betterAuthSession.findUnique({
          where: { id: resolved.session.id },
          include: {
            user: {
              include: {
                betterAuthAccounts: {
                  where: { providerId: "credential", password: { not: null } },
                  select: { id: true },
                  take: 1,
                },
              },
            },
          },
        });
        if (
          session === null ||
          session.token !== resolved.session.token ||
          !isNativeAuthoritySessionValid(
            session,
            resolved.user.id,
            Date.now(),
            input.configuration,
          )
        )
          return false;
        await tx.betterAuthSession.deleteMany({
          where: { userId: session.userId },
        });
        if (
          await tx.betterAuthSession.count({
            where: { userId: session.userId },
          })
        ) {
          throw new Error("Native session revocation failed");
        }
        return true;
      });
      if (!revoked) return { outcome: "authentication_required" };
      return {
        outcome: "logged_out",
        cookies: [
          `${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${input.configuration.secureCookie ? "; Secure" : ""}`,
        ],
      };
    },
  };
}
