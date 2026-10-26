import type { Express } from "express";
import { Router } from "express";

import { createApp } from "../app.ts";
import type { PrismaClient } from "../generated/prisma/client.ts";
import type { ApiLogger } from "../logger.ts";
import { createAuthenticationMiddleware } from "../modules/identity/authentication-context.ts";
import {
  createPrismaAuthenticationRepository,
  createPrismaAuthenticationSessionRepository,
} from "../modules/identity/authentication-repository.ts";
import { createPrismaCredentialLifecycleRepository } from "../modules/identity/credential-lifecycle-repository.ts";
import { createCredentialLifecycleRouter } from "../modules/identity/credential-lifecycle-router.ts";
import { createCredentialLifecycleService } from "../modules/identity/credential-lifecycle-service.ts";
import { createEmailRequestLimiter } from "../modules/identity/email-request-limiter.ts";
import {
  createRecordingEmailProvider,
  type IdentityEmailProvider,
} from "../modules/identity/email-provider.ts";
import { createLoginLimiter } from "../modules/identity/login-limiter.ts";
import { createLoginRouter } from "../modules/identity/login-router.ts";
import { createLoginService } from "../modules/identity/login-service.ts";
import { secureOneTimeTokenProvider } from "../modules/identity/one-time-token.ts";
import {
  argon2PasswordHasher,
  argon2PasswordVerifier,
  type PasswordHasher,
  type PasswordVerifier,
} from "../modules/identity/password-hasher.ts";
import { createRegistrationLimiter } from "../modules/identity/registration-limiter.ts";
import { createRegistrationRouter } from "../modules/identity/registration-router.ts";
import { createRegistrationService } from "../modules/identity/registration-service.ts";
import type { SessionConfiguration } from "../modules/identity/session-configuration.ts";
import { secureSessionTokenProvider } from "../modules/identity/session-token.ts";
import {
  createVerificationDelivery,
  type VerificationDelivery,
} from "../modules/identity/verification-delivery.ts";
import {
  createPrismaVerificationRepository,
  type VerificationRepository,
} from "../modules/identity/verification-repository.ts";
import {
  createVerificationSecurity,
  type VerificationSecurity,
} from "../modules/identity/verification-security.ts";
import { createVerificationService } from "../modules/identity/verification-service.ts";

export const TEST_PUBLIC_WEB_ORIGIN = "http://localhost:3000";
export interface IdentityBackendTestFixture {
  app: Express;
  delivery: VerificationDelivery;
  security: VerificationSecurity;
  repository: VerificationRepository;
  emailProvider: IdentityEmailProvider;
}

export function testVerificationSecurity(): VerificationSecurity {
  return createVerificationSecurity({
    publicWebOrigin: TEST_PUBLIC_WEB_ORIGIN,
    otpKey: Buffer.alloc(32, 11),
    otpKeyId: 1,
    proofKey: Buffer.alloc(32, 22),
    proofKeyId: 2,
  });
}

export function createIdentityBackendTestFixture(
  prisma: PrismaClient,
  {
    emailProvider = createRecordingEmailProvider(),
    logger = { error() {}, info() {} },
    now = () => new Date(),
    passwordHasher = argon2PasswordHasher,
    passwordVerifier = argon2PasswordVerifier,
    configuration = {
      absoluteTimeoutMilliseconds: 604_800_000,
      idleTimeoutMilliseconds: 86_400_000,
      touchIntervalMilliseconds: 900_000,
      secureCookie: false,
    },
  }: {
    emailProvider?: IdentityEmailProvider;
    logger?: ApiLogger;
    now?: () => Date;
    passwordHasher?: PasswordHasher;
    passwordVerifier?: PasswordVerifier;
    configuration?: SessionConfiguration;
  } = {},
): IdentityBackendTestFixture {
  const security = testVerificationSecurity();
  const repository = createPrismaVerificationRepository(prisma);
  const delivery = createVerificationDelivery({
    emailProvider,
    repository,
    publicWebOrigin: TEST_PUBLIC_WEB_ORIGIN,
  });
  const deliveryLimiter = createEmailRequestLimiter();
  const verificationService = createVerificationService({
    repository,
    security,
    delivery,
    deliveryLimiter,
  });
  const loginService = createLoginService({
    configuration,
    now,
    passwordVerifier,
    repository: createPrismaAuthenticationRepository(prisma),
    tokenProvider: secureSessionTokenProvider,
    verificationRepository: repository,
    security,
  });
  const lifecycleService = createCredentialLifecycleService({
    emailProvider,
    now,
    passwordHasher,
    publicWebOrigin: TEST_PUBLIC_WEB_ORIGIN,
    repository: createPrismaCredentialLifecycleRepository(prisma),
    tokenProvider: secureOneTimeTokenProvider,
  });
  const authenticationMiddleware = createAuthenticationMiddleware({
    configuration,
    now,
    repository: createPrismaAuthenticationSessionRepository(prisma),
  });
  const apiRouter = Router();
  apiRouter.use(
    createRegistrationRouter({
      limiter: createRegistrationLimiter(),
      publicWebOrigin: TEST_PUBLIC_WEB_ORIGIN,
      registrationService: createRegistrationService({
        passwordHasher,
        repository,
        security,
        delivery,
        deliveryLimiter,
        now,
      }),
    }),
  );
  apiRouter.use(
    createLoginRouter({
      configuration,
      limiter: createLoginLimiter(),
      loginService,
      continuationKey: Buffer.alloc(32).toString("base64url"),
      publicWebOrigin: TEST_PUBLIC_WEB_ORIGIN,
    }),
  );
  apiRouter.use(
    createCredentialLifecycleRouter({
      authenticationMiddleware,
      configuration,
      lifecycleService,
      passwordResetLimiter: createEmailRequestLimiter(),
      publicWebOrigin: TEST_PUBLIC_WEB_ORIGIN,
      verificationService,
    }),
  );
  apiRouter.get("/protected", authenticationMiddleware, (_request, response) =>
    response.json({ status: "authenticated" }),
  );
  return {
    app: createApp({ apiRouter, logger }),
    delivery,
    security,
    repository,
    emailProvider,
  };
}
