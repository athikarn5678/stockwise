import { randomBytes } from "node:crypto";

import type { Request } from "express";

import type { PrismaClient } from "../generated/prisma/client.ts";
import { createSessionAuthenticationMiddleware } from "../modules/identity/authentication-context.ts";
import { createPrismaBetterAuthSessionRepository } from "../modules/identity/better-auth-session-repository.ts";
import type { SessionConfiguration } from "../modules/identity/session-configuration.ts";
import { withTriggersDisabled } from "./trigger-bypass.ts";

/**
 * Test-only Native authentication double for router/integration tests. It
 * resolves sessions through the real Native persistence rules (the
 * `isNativeAuthoritySessionValid` predicate and the activity touch in
 * `createPrismaBetterAuthSessionRepository`), but reads a plain
 * `<id>.<token>` test cookie instead of Better Auth's signed cookie. It never
 * grants tenant or role authority: it only produces the same
 * `TrustedAuthenticationContext` the real Native middleware produces.
 */
export const NATIVE_TEST_SESSION_COOKIE = "stockwise_native_test_session";

const MINUTE = 60_000;
export const NATIVE_TEST_SESSION_CONFIGURATION: SessionConfiguration = {
  absoluteTimeoutMilliseconds: 7 * 24 * 60 * MINUTE,
  idleTimeoutMilliseconds: 24 * 60 * MINUTE,
  secureCookie: false,
  touchIntervalMilliseconds: 15 * MINUTE,
};

// Far in the past so the Native predicate (`provenance <= session.createdAt`)
// holds for any test clock.
const PROVENANCE_INSTANT = new Date("2020-01-01T00:00:00.000Z");
// Public dummy verifier (schema default of users.password_hash): the Native
// predicate only needs a non-null credential account password to exist.
const PLACEHOLDER_CREDENTIAL =
  "$argon2id$v=19$m=65536,p=4,t=3$MELWslgkJzw87Me69Wz1tw$l9XoBv1UBhpmS40M2xzT5cHzqoSubftPd1Md5u/ZmvQ";

export interface NativeTestSession {
  id: string;
  token: string;
  /** Value for the request `Cookie` header. */
  cookie: string;
}

export interface NativeTestSessionOptions {
  createdAt?: Date;
  updatedAt?: Date;
  expiresAt?: Date;
  /** Defaults to `APPLICATION`; `null` creates a provisional (non-application) session. */
  purpose?: "APPLICATION" | null;
}

/**
 * Makes an existing test user Native-eligible without changing intent: a user
 * that is unverified (`emailVerifiedAt` null), disabled or otherwise ineligible
 * stays ineligible, so authentication-denial cases keep their meaning.
 */
async function promoteToNative(
  prisma: Pick<PrismaClient, "user" | "betterAuthAccount">,
  userId: string,
): Promise<{ credentialVersion: bigint; eligible: boolean }> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (user.emailVerifiedAt !== null) {
    await prisma.user.update({
      where: { id: userId },
      data: {
        emailVerified: true,
        nativeRegistrationCompletedAt:
          user.nativeRegistrationCompletedAt ?? PROVENANCE_INSTANT,
        passwordChangedAt: PROVENANCE_INSTANT,
      },
    });
    await prisma.betterAuthAccount.upsert({
      where: {
        providerId_accountId: { providerId: "credential", accountId: userId },
      },
      create: {
        providerId: "credential",
        accountId: userId,
        userId,
        password: PLACEHOLDER_CREDENTIAL,
      },
      update: {},
    });
  }
  return {
    credentialVersion: user.credentialVersion,
    eligible:
      user.emailVerifiedAt !== null &&
      user.status === "ACTIVE" &&
      user.disabledAt === null,
  };
}

export async function createNativeTestSession(
  prisma: Pick<
    PrismaClient,
    "user" | "betterAuthAccount" | "betterAuthSession" | "$transaction"
  >,
  userId: string,
  options: NativeTestSessionOptions = {},
): Promise<NativeTestSession> {
  const { credentialVersion, eligible } = await promoteToNative(prisma, userId);
  const token = randomBytes(24).toString("base64url");
  const purpose = options.purpose === undefined ? "APPLICATION" : null;
  const common = {
    token,
    userId,
    expiresAt: options.expiresAt ?? new Date(Date.now() + 7 * 24 * 60 * MINUTE),
    ...(options.createdAt === undefined
      ? {}
      : { createdAt: options.createdAt }),
  };
  const updatedAt = options.updatedAt ?? options.createdAt;
  const touched = updatedAt === undefined ? {} : { updatedAt };
  let session: { id: string };
  if (eligible) {
    // The Native database guard only accepts a provisional insert for an
    // eligible user, then a finalizing update, exactly like real login.
    session = await prisma.betterAuthSession.create({
      data: {
        ...common,
        ...touched,
        stockwisePurpose: null,
        stockwiseCredentialVersion: null,
      },
    });
    if (purpose !== null)
      await prisma.betterAuthSession.update({
        where: { id: session.id },
        data: {
          stockwisePurpose: purpose,
          stockwiseCredentialVersion: credentialVersion,
          ...touched,
        },
      });
  } else {
    // A session that pre-dates the user becoming ineligible (disabled or
    // unverified) cannot be created through the guard; reproduce that stored
    // state for authentication-denial cases only.
    session = await withTriggersDisabled(prisma, (tx) =>
      tx.betterAuthSession.create({
        data: {
          ...common,
          ...touched,
          stockwisePurpose: purpose,
          stockwiseCredentialVersion:
            purpose === null ? null : credentialVersion,
        },
      }),
    );
  }
  return {
    id: session.id,
    token,
    cookie: `${NATIVE_TEST_SESSION_COOKIE}=${session.id}.${token}`,
  };
}

function readTestCookie(
  request: Request,
): { id: string; token: string } | null {
  const header = request.headers.cookie;
  if (typeof header !== "string") return null;
  const matches = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${NATIVE_TEST_SESSION_COOKIE}=`));
  if (matches.length !== 1) return null;
  const value = matches[0]?.slice(NATIVE_TEST_SESSION_COOKIE.length + 1) ?? "";
  const match = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]+)$/.exec(value);
  return match === null ? null : { id: match[1]!, token: match[2]! };
}

export function createNativeTestAuthenticationMiddleware(
  prisma: Parameters<typeof createPrismaBetterAuthSessionRepository>[0] &
    Pick<PrismaClient, "betterAuthSession">,
  options: {
    configuration?: SessionConfiguration;
    now?: () => Date;
  } = {},
) {
  const repository = createPrismaBetterAuthSessionRepository(prisma);
  const configuration =
    options.configuration ?? NATIVE_TEST_SESSION_CONFIGURATION;
  const now = options.now ?? (() => new Date());
  return createSessionAuthenticationMiddleware(async (request) => {
    const cookie = readTestCookie(request);
    if (cookie === null) return null;
    const row = await prisma.betterAuthSession.findUnique({
      where: { id: cookie.id, token: cookie.token },
      select: { userId: true },
    });
    if (row === null) return null;
    const session = await repository.findSession({
      sessionId: cookie.id,
      token: cookie.token,
      userId: row.userId,
      configuration,
      now,
    });
    if (session === null) return null;
    return {
      actor: {
        id: session.user.id,
        email: session.user.email,
        displayName: session.user.displayName,
      },
      sessionId: session.id,
    };
  });
}
