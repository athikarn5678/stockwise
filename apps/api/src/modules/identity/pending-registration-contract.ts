import type {
  PreparedVerification,
  VerificationChallengeMaterial,
  VerificationSecurity,
} from "./verification-security.ts";

export type PendingRegistrationCompletion =
  "verified" | "already_verified" | "invalid" | "proof_required";
export type PendingCredentialSnapshot =
  | {
      kind: "pending";
      id: string;
      credentialVersion: bigint;
      passwordHash: string;
    }
  | {
      kind: "verified";
      id: string;
      credentialVersion: bigint;
      passwordHash: string;
      passwordChangedAt: Date;
      nativeRegistrationCompletedAt: Date | null;
      eligible: boolean;
    };
export interface PendingRegistrationRepository {
  admit(
    email: string,
    purpose: "registration" | "delivery",
  ): Promise<{ allowed: boolean; retryAfterSeconds: number }>;
  reserveCredential(
    email: string,
  ): Promise<
    | { allowed: true; attemptId: string; retryAfterSeconds: 0 }
    | { allowed: false; retryAfterSeconds: number }
  >;
  register(input: {
    email: string;
    passwordHash: string;
    security: VerificationSecurity;
    suppressed?: boolean;
  }): Promise<PreparedVerification | null>;
  resend(
    email: string,
    security: VerificationSecurity,
  ): Promise<VerificationChallengeMaterial | null>;
  credentialSnapshot(email: string): Promise<PendingCredentialSnapshot | null>;
  finishCredential(
    email: string,
    attemptId: string,
    snapshot: PendingCredentialSnapshot | null,
    security: VerificationSecurity,
  ): Promise<{ proof: string; expiresAt: Date } | { ineligible: true } | null>;
  completeCode(input: {
    email: string;
    challengeId: string;
    code: string;
    cookieHeader: string | undefined;
    security: VerificationSecurity;
  }): Promise<PendingRegistrationCompletion>;
  completeLink(input: {
    linkTokenHash: string;
    cookieHeader: string | undefined;
    security: VerificationSecurity;
  }): Promise<PendingRegistrationCompletion>;
  canDeliver(challengeId: string): Promise<boolean>;
  revokeDelivery(input: {
    challengeId: string;
    reason: "DELIVERY_FAILED" | "RESPONSE_ABORTED";
  }): Promise<void>;
  sweepExpired(limit: number): Promise<number>;
}
