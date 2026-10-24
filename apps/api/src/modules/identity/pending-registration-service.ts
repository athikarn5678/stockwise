import { randomUUID } from "node:crypto";
import { hashOneTimeToken } from "./one-time-token.ts";
import type { PendingRegistrationRepository } from "./pending-registration-contract.ts";

import {
  DUMMY_PASSWORD_HASH,
  type PasswordHasher,
  type PasswordVerifier,
} from "./password-hasher.ts";
import type {
  VerificationDelivery,
  VerificationResponseDelivery,
} from "./verification-delivery.ts";
import type { VerificationSecurity } from "./verification-security.ts";

export interface PendingRegistrationService {
  register(input: { email: string; password: string }): Promise<
    | { outcome: "limited"; retryAfterSeconds: number }
    | {
        challengeId: string;
        proof: string;
        expiresAt: Date;
        delivery: VerificationResponseDelivery | null;
      }
  >;
  resend(email: string): Promise<
    | { outcome: "limited"; retryAfterSeconds: number }
    | {
        outcome: "accepted";
        challengeId: string;
        delivery: VerificationResponseDelivery | null;
      }
  >;
  provePassword(input: {
    email: string;
    password: string;
  }): Promise<
    | { outcome: "limited"; retryAfterSeconds: number }
    | { outcome: "invalid"; credentialFailure?: boolean }
    | { outcome: "proved"; proof: string; expiresAt: Date }
  >;
  completeCode(input: {
    email: string;
    challengeId: string;
    code: string;
    cookieHeader: string | undefined;
  }): Promise<"verified" | "already_verified" | "invalid" | "proof_required">;
  completeLink(input: {
    token: string;
    cookieHeader: string | undefined;
  }): Promise<"verified" | "already_verified" | "invalid" | "proof_required">;
}

export function createPendingRegistrationService({
  delivery,
  passwordHasher,
  passwordVerifier,
  repository,
  security,
  now = () => new Date(),
}: {
  delivery: VerificationDelivery;
  passwordHasher: PasswordHasher;
  passwordVerifier: PasswordVerifier;
  repository: PendingRegistrationRepository;
  security: VerificationSecurity;
  now?: () => Date;
}): PendingRegistrationService {
  return {
    async register({ email, password }) {
      const registrationAdmission = await repository.admit(
        email,
        "registration",
      );
      if (!registrationAdmission.allowed) {
        return {
          outcome: "limited",
          retryAfterSeconds: registrationAdmission.retryAfterSeconds,
        };
      }

      const passwordHash = await passwordHasher.hash(password);
      const deliveryAdmission = await repository.admit(email, "delivery");
      const reservation = deliveryAdmission.allowed ? delivery.reserve() : null;
      try {
        const prepared = await repository.register({
          email,
          passwordHash,
          security,
          suppressed: reservation === null,
        });
        if (prepared === null) {
          reservation?.release();
          const phantom = security.phantom(now());
          return { challengeId: randomUUID(), ...phantom, delivery: null };
        }
        return {
          challengeId: prepared.challenge.id,
          proof: prepared.proof,
          expiresAt: prepared.challenge.expiresAt,
          delivery:
            reservation?.prepare({ prepared, recipient: email }) ?? null,
        };
      } catch (error: unknown) {
        reservation?.release();
        throw error;
      }
    },

    async resend(email) {
      const admission = await repository.admit(email, "delivery");
      if (!admission.allowed)
        return {
          outcome: "limited",
          retryAfterSeconds: admission.retryAfterSeconds,
        };
      const reservation = delivery.reserve();
      if (reservation === null)
        return { outcome: "limited", retryAfterSeconds: 1 };
      try {
        const prepared = await repository.resend(email, security);
        if (prepared === null) {
          reservation.release();
          return {
            outcome: "accepted",
            challengeId: randomUUID(),
            delivery: null,
          };
        }
        return {
          outcome: "accepted",
          challengeId: prepared.challenge.id,
          delivery: reservation.prepare({ prepared, recipient: email }),
        };
      } catch (error: unknown) {
        reservation.release();
        throw error;
      }
    },

    async provePassword({ email, password }) {
      const admission = await repository.reserveCredential(email);
      if (!admission.allowed)
        return {
          outcome: "limited",
          retryAfterSeconds: admission.retryAfterSeconds,
        };
      const snapshot = await repository.credentialSnapshot(email);
      const valid = await passwordVerifier.verify(
        snapshot?.passwordHash ?? DUMMY_PASSWORD_HASH,
        password,
      );
      const proof = await repository.finishCredential(
        email,
        admission.attemptId,
        valid ? snapshot : null,
        security,
      );
      return proof === null || "ineligible" in proof
        ? {
            outcome: "invalid",
            credentialFailure: !(valid && snapshot !== null),
          }
        : { outcome: "proved", ...proof };
    },

    completeCode({ email, challengeId, code, cookieHeader }) {
      return repository.completeCode({
        email,
        challengeId,
        code,
        cookieHeader,
        security,
      });
    },

    completeLink({ token, cookieHeader }) {
      return repository.completeLink({
        linkTokenHash: hashOneTimeToken(token),
        cookieHeader,
        security,
      });
    },
  };
}
