import { createInvitationContinuationRouter } from "./invitation-continuation-router.ts";
import { createPrismaInvitationContinuationRepository } from "./invitation-continuation-repository.ts";
import { createPrismaMembershipAccessRepository } from "./membership-access-repository.ts";
import { createMembershipAccessService } from "./membership-access-service.ts";
import { secureOneTimeTokenProvider } from "./one-time-token.ts";
import { parseInvitationContinuationKey } from "./invitation-continuation-cookie.ts";
import { Router } from "express";

import type { ApiEnvironment } from "../../environment.ts";
import type { PrismaClient } from "../../generated/prisma/client.ts";
import { createAuthenticationMiddleware } from "./authentication-context.ts";
import {
  createPrismaAuthenticationRepository,
  createPrismaAuthenticationSessionRepository,
} from "./authentication-repository.ts";
import { createPrismaCredentialLifecycleRepository } from "./credential-lifecycle-repository.ts";
import { createCredentialLifecycleRouter } from "./credential-lifecycle-router.ts";
import { createCredentialLifecycleService } from "./credential-lifecycle-service.ts";
import type { IdentityEmailProvider } from "./email-provider.ts";
import { createEmailRequestLimiter } from "./email-request-limiter.ts";
import { createLoginLimiter } from "./login-limiter.ts";
import { createLoginRouter } from "./login-router.ts";
import { createLoginService } from "./login-service.ts";
import {
  argon2PasswordHasher,
  argon2PasswordVerifier,
} from "./password-hasher.ts";
import { createRegistrationLimiter } from "./registration-limiter.ts";
import { createRegistrationRouter } from "./registration-router.ts";
import { createRegistrationService } from "./registration-service.ts";
import { createSessionConfiguration } from "./session-configuration.ts";
import { secureSessionTokenProvider } from "./session-token.ts";
import {
  createVerificationDelivery,
  type VerificationDeliveryFailure,
} from "./verification-delivery.ts";
import { createPrismaVerificationRepository } from "./verification-repository.ts";
import {
  createVerificationSecurity,
  verificationSecurityConfiguration,
} from "./verification-security.ts";
import { createVerificationService } from "./verification-service.ts";

// One composition path for the application and its real-response test coordinator.
export function createAuthenticationRuntime({
  environment,
  prisma,
  emailProvider,
  onDeliveryFailure,
}: {
  environment: ApiEnvironment;
  prisma: PrismaClient;
  emailProvider: IdentityEmailProvider;
  onDeliveryFailure: (
    kind:
      | "verification"
      | "verification_compensation"
      | "password_reset"
      | "password_reset_compensation",
    failure?: VerificationDeliveryFailure,
  ) => void;
}) {
  parseInvitationContinuationKey(
    environment.STOCKWISE_INVITATION_CONTINUATION_KEY,
  );
  const configuration = createSessionConfiguration(environment);
  const membershipAccessService = createMembershipAccessService({
    emailProvider,
    publicWebOrigin: environment.STOCKWISE_PUBLIC_WEB_ORIGIN,
    repository: createPrismaMembershipAccessRepository(prisma),
    tokenProvider: secureOneTimeTokenProvider,
  });
  const repository = createPrismaVerificationRepository(prisma);
  const security = createVerificationSecurity(
    verificationSecurityConfiguration(environment),
  );
  const deliveryLimiter = createEmailRequestLimiter();
  const delivery = createVerificationDelivery({
    emailProvider,
    publicWebOrigin: environment.STOCKWISE_PUBLIC_WEB_ORIGIN,
    repository,
    onFailure: onDeliveryFailure,
  });
  const registrationService = createRegistrationService({
    passwordHasher: argon2PasswordHasher,
    repository,
    security,
    delivery,
    deliveryLimiter,
  });
  const loginService = createLoginService({
    configuration,
    passwordVerifier: argon2PasswordVerifier,
    repository: createPrismaAuthenticationRepository(prisma),
    tokenProvider: secureSessionTokenProvider,
    verificationRepository: repository,
    security,
  });
  const lifecycleService = createCredentialLifecycleService({
    emailProvider,
    onDeliveryFailure,
    passwordHasher: argon2PasswordHasher,
    publicWebOrigin: environment.STOCKWISE_PUBLIC_WEB_ORIGIN,
    repository: createPrismaCredentialLifecycleRepository(prisma),
    tokenProvider: secureOneTimeTokenProvider,
  });
  const authenticationMiddleware = createAuthenticationMiddleware({
    configuration,
    repository: createPrismaAuthenticationSessionRepository(prisma),
  });
  const router = Router();
  router.use(
    createRegistrationRouter({
      limiter: createRegistrationLimiter(),
      registrationService,
      publicWebOrigin: environment.STOCKWISE_PUBLIC_WEB_ORIGIN,
    }),
  );
  router.use(
    createCredentialLifecycleRouter({
      authenticationMiddleware,
      configuration,
      lifecycleService,
      passwordResetLimiter: createEmailRequestLimiter(),
      publicWebOrigin: environment.STOCKWISE_PUBLIC_WEB_ORIGIN,
      verificationService: createVerificationService({
        repository,
        security,
        delivery,
        deliveryLimiter,
      }),
    }),
  );
  router.use(
    createInvitationContinuationRouter({
      authenticationMiddleware,
      key: environment.STOCKWISE_INVITATION_CONTINUATION_KEY!,
      membershipAccessService,
      repository: createPrismaInvitationContinuationRepository(prisma),
      publicWebOrigin: environment.STOCKWISE_PUBLIC_WEB_ORIGIN,
    }),
  );
  router.use(
    createLoginRouter({
      configuration,
      continuationKey: environment.STOCKWISE_INVITATION_CONTINUATION_KEY!,
      limiter: createLoginLimiter(),
      loginService,
      publicWebOrigin: environment.STOCKWISE_PUBLIC_WEB_ORIGIN,
    }),
  );
  return { router, authenticationMiddleware, drain: () => delivery.drain() };
}
