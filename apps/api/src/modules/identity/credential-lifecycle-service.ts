import type { IdentityEmailProvider } from "./email-provider.ts";
import type { PasswordHasher } from "./password-hasher.ts";
import {
  type PasswordResetRepository,
  OneTimeTokenCollisionError,
} from "./credential-lifecycle-repository.ts";
import {
  hashOneTimeToken,
  type OneTimeTokenProvider,
} from "./one-time-token.ts";

const MAX_TOKEN_GENERATION_ATTEMPTS = 3;
const PASSWORD_RESET_LIFETIME_MILLISECONDS = 30 * 60 * 1000;

type DeliveryFailureKind = "password_reset" | "password_reset_compensation";

export interface PasswordResetService {
  requestPasswordReset(email: string): Promise<void>;
  resetPassword(input: {
    newPassword: string;
    rawToken: string;
  }): Promise<boolean>;
}

function tokenUrl(origin: string, path: string, rawToken: string): string {
  const url = new URL(path, origin);
  url.searchParams.set("token", rawToken);
  return url.toString();
}

export function createPasswordResetService({
  emailProvider,
  now = () => new Date(),
  onDeliveryFailure = () => undefined,
  passwordHasher,
  publicWebOrigin,
  repository,
  tokenProvider,
}: {
  emailProvider: IdentityEmailProvider;
  now?: () => Date;
  onDeliveryFailure?: (kind: DeliveryFailureKind) => void;
  passwordHasher: PasswordHasher;
  publicWebOrigin: string;
  repository: PasswordResetRepository;
  tokenProvider: OneTimeTokenProvider;
}): PasswordResetService {
  return {
    async requestPasswordReset(email) {
      const issuedAt = now();
      const expiresAt = new Date(
        issuedAt.getTime() + PASSWORD_RESET_LIFETIME_MILLISECONDS,
      );

      for (
        let attempt = 0;
        attempt < MAX_TOKEN_GENERATION_ATTEMPTS;
        attempt += 1
      ) {
        const token = tokenProvider.generate();

        try {
          const issued = await repository.issuePasswordResetToken({
            email,
            expiresAt,
            issuedAt,
            tokenHash: token.tokenHash,
          });
          if (issued === null) {
            return;
          }

          try {
            await emailProvider.send({
              kind: "password_reset",
              recipient: issued.recipient,
              url: tokenUrl(publicWebOrigin, "/reset-password", token.rawToken),
            });
            await repository.confirmPasswordResetDelivery?.({
              tokenId: issued.id,
            });
          } catch {
            onDeliveryFailure("password_reset");
            try {
              await repository.revokePasswordResetToken({
                revokedAt: now(),
                tokenId: issued.id,
              });
            } catch {
              onDeliveryFailure("password_reset_compensation");
            }
          }
          return;
        } catch (error: unknown) {
          if (
            error instanceof OneTimeTokenCollisionError &&
            attempt < MAX_TOKEN_GENERATION_ATTEMPTS - 1
          ) {
            continue;
          }
          throw error;
        }
      }
    },

    async resetPassword({ newPassword, rawToken }) {
      const completedAt = now();
      const validToken = await repository.findValidPasswordResetToken({
        now: completedAt,
        tokenHash: hashOneTimeToken(rawToken),
      });
      if (validToken === null) {
        return false;
      }

      const passwordHash = await passwordHasher.hash(newPassword);
      return repository.completePasswordReset({
        completedAt,
        passwordHash,
        tokenId: validToken.tokenId,
        userId: validToken.userId,
      });
    },
  };
}
