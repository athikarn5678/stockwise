import { parseInvitationContinuationKey } from "./invitation-continuation-cookie.ts";
import { createInvitationContinuationRouter } from "./invitation-continuation-router.ts";
import { createPrismaInvitationContinuationRepository } from "./invitation-continuation-repository.ts";
import { createPrismaMembershipAccessRepository } from "./membership-access-repository.ts";
import { createMembershipAccessService } from "./membership-access-service.ts";
import { Router } from "express";
import type { ApiEnvironment } from "../../environment.ts";
import type { PrismaClient } from "../../generated/prisma/client.ts";
import { createSessionAuthenticationMiddleware } from "./authentication-context.ts";
import { createBetterAuthApplicationRouter } from "./better-auth-application-router.ts";
import { createBetterAuthApplicationSessionService } from "./better-auth-application-session.ts";
import { createBetterAuthSessionResolver } from "./better-auth-bridge.ts";
import {
  createBetterAuthNative,
  denyAllNativeAuthRoutes,
} from "./better-auth-native.ts";
import { createPrismaBetterAuthSessionRepository } from "./better-auth-session-repository.ts";
import { requireBetterAuthSecret } from "./better-auth-secret.ts";
import { createBetterAuthPasswordResetRouter } from "./credential-lifecycle-router.ts";
import { createPrismaBetterAuthCredentialLifecycleRepository } from "./credential-lifecycle-repository.ts";
import { createPasswordResetService } from "./credential-lifecycle-service.ts";
import type { IdentityEmailProvider } from "./email-provider.ts";
import { createLoginLimiter } from "./login-limiter.ts";
import { createNativePasswordResetLimiter } from "./native-password-reset-limiter.ts";
import { secureOneTimeTokenProvider } from "./one-time-token.ts";
import { hashPassword, verifyPassword } from "./password-hasher.ts";
import { createPendingRegistrationRepository } from "./pending-registration-repository.ts";
import { createPendingRegistrationRouter } from "./pending-registration-router.ts";
import {
  createPendingRegistrationService,
  type PendingRegistrationService,
} from "./pending-registration-service.ts";
import { createSessionConfiguration } from "./session-configuration.ts";
import {
  createVerificationSecurity,
  verificationSecurityConfiguration,
} from "./verification-security.ts";
import {
  createVerificationDelivery,
  type VerificationDeliveryFailure,
} from "./verification-delivery.ts";

/**
 * D5-P2 source candidate only. Construct exactly one authentication authority
 * per API process. The application must not mount this until cutover gates,
 * route parity, secret provisioning and rollback have independently passed.
 *
 * This is never called by the active runtime while
 * BETTER_AUTH_NATIVE_ENABLED remains false.
 */
export function createBetterAuthApplicationRuntime(input: {
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
    input.environment.STOCKWISE_INVITATION_CONTINUATION_KEY,
  );
  const { environment, prisma, emailProvider, onDeliveryFailure } = input;
  const secret = requireBetterAuthSecret(environment);

  const configuration = createSessionConfiguration(environment);
  const publicWebOrigin = environment.STOCKWISE_PUBLIC_WEB_ORIGIN;
  if (
    environment.STOCKWISE_RUNTIME_ENV === "production" &&
    new URL(publicWebOrigin).protocol !== "https:"
  ) {
    throw new Error("Native production authentication requires HTTPS.");
  }
  const verificationSecurity = createVerificationSecurity(
    verificationSecurityConfiguration(environment),
  );
  const pendingRepository = createPendingRegistrationRepository(prisma);
  const delivery = createVerificationDelivery({
    emailProvider,
    publicWebOrigin,
    repository: pendingRepository,
    onFailure: onDeliveryFailure,
  });
  const limiter = createLoginLimiter();
  const pending = createPendingRegistrationService({
    delivery,
    passwordHasher: { hash: hashPassword },
    passwordVerifier: { verify: verifyPassword },
    repository: pendingRepository,
    security: verificationSecurity,
  });
  // Both public credential paths share this process-local admission queue.
  // Login receives the raw proof service to avoid reacquiring its own queue.
  const pendingRegistrationService: PendingRegistrationService = {
    ...pending,
    async provePassword(input) {
      return limiter.serializeByEmail(input.email, async () => {
        const admission = limiter.check(input.email);
        if (!admission.allowed) {
          return {
            outcome: "limited",
            retryAfterSeconds: admission.retryAfterSeconds,
          };
        }
        const result = await pending.provePassword(input);
        if (
          result.outcome === "invalid" &&
          result.credentialFailure !== false
        ) {
          limiter.recordCredentialFailure(input.email);
        }
        return result;
      });
    },
  };
  const native = createBetterAuthNative({
    prisma,
    secret,
    publicWebOrigin,
    secureCookie: configuration.secureCookie,
  });
  const authenticationMiddleware = createSessionAuthenticationMiddleware(
    createBetterAuthSessionResolver({
      native,
      repository: createPrismaBetterAuthSessionRepository(prisma),
      configuration,
      publicWebOrigin,
    }),
  );
  const membershipAccessService = createMembershipAccessService({
    emailProvider,
    publicWebOrigin,
    repository: createPrismaMembershipAccessRepository(prisma),
    tokenProvider: secureOneTimeTokenProvider,
  });

  const router = Router();
  router.use(
    createPendingRegistrationRouter({
      pendingRegistrationService,
      publicWebOrigin,
    }),
  );
  router.use(
    createInvitationContinuationRouter({
      authenticationMiddleware,
      key: environment.STOCKWISE_INVITATION_CONTINUATION_KEY!,
      membershipAccessService,
      repository: createPrismaInvitationContinuationRepository(prisma),
      publicWebOrigin,
    }),
  );
  router.use(
    createBetterAuthApplicationRouter({
      service: createBetterAuthApplicationSessionService({
        prisma,
        publicWebOrigin,
        configuration,
        native,
        pendingRegistrationService: pending,
        limiter,
      }),
      continuationKey: environment.STOCKWISE_INVITATION_CONTINUATION_KEY!,
      publicWebOrigin,
    }),
  );

  // The reset router protects each request it receives. Restrict its dispatch
  // to the two recognized routes, as in the accepted isolated harness.
  router.post(
    ["/auth/forgot-password", "/auth/reset-password"],
    createBetterAuthPasswordResetRouter({
      lifecycleService: createPasswordResetService({
        emailProvider,
        onDeliveryFailure,
        passwordHasher: { hash: hashPassword },
        publicWebOrigin,
        repository: createPrismaBetterAuthCredentialLifecycleRepository(prisma),
        tokenProvider: secureOneTimeTokenProvider,
      }),
      passwordResetLimiter: createNativePasswordResetLimiter(prisma),
      publicWebOrigin,
    }),
  );

  // No generic Better Auth handler or Legacy writer is exposed.
  router.use("/auth", denyAllNativeAuthRoutes);
  return {
    router,
    authenticationMiddleware,
    drain: () => delivery.drain(),
  };
}
