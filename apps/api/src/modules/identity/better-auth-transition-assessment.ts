/** Internal consistent-snapshot metadata only; never supply hashes or passwords. */
export interface BetterAuthTransitionObservation {
  userId: string;
  status: "ACTIVE" | "DISABLED";
  disabledAt: Date | null;
  emailVerifiedAt: Date | null;
  emailVerified: boolean;
  nativeRegistrationCompletedAt: Date | null;
  passwordChangedAt: Date;
  credentialVersion: bigint;
  legacyPassword: "PRESENT" | "DUMMY" | "ABSENT";
  accounts: readonly {
    userId: string;
    accountId: string;
    providerId: string;
    passwordPresent: boolean;
  }[];
}

export type BetterAuthTransitionIssue =
  | "INVALID_TIME"
  | "INVALID_CREDENTIAL_VERSION"
  | "DISABLED_USER"
  | "UNVERIFIED_USER"
  | "VERIFICATION_MISMATCH"
  | "LEGACY_CREDENTIAL_UNAVAILABLE"
  | "ACCOUNT_OWNERSHIP_CONFLICT"
  | "UNSUPPORTED_PROVIDER"
  | "DUPLICATE_CREDENTIAL_ACCOUNTS"
  | "NONCANONICAL_CREDENTIAL_ACCOUNT"
  | "NATIVE_PASSWORD_MISSING"
  | "INCOMPLETE_NATIVE_ENROLLMENT";

export interface BetterAuthTransitionAssessment {
  state: "LEGACY_ONLY" | "NATIVE_PRESENT" | "CONFLICT";
  issues: BetterAuthTransitionIssue[];
  /** Even a consistent destination is never permission to import or refresh it. */
  destination: "ABSENT" | "PRESERVE";
}

/**
 * Reports observations, not authentication eligibility or migration permission.
 * No clock, database, credential conversion or mutation; replay is observational.
 */
export function assessBetterAuthTransition(
  observation: BetterAuthTransitionObservation,
  observedAt: Date,
): BetterAuthTransitionAssessment {
  const issues: BetterAuthTransitionIssue[] = [];
  const times = [
    observation.disabledAt,
    observation.emailVerifiedAt,
    observation.nativeRegistrationCompletedAt,
    observation.passwordChangedAt,
  ];
  if (
    !Number.isFinite(observedAt.getTime()) ||
    times.some(
      (time) =>
        time !== null &&
        (!Number.isFinite(time.getTime()) ||
          time.getTime() > observedAt.getTime()),
    )
  ) {
    issues.push("INVALID_TIME");
  }
  if (observation.credentialVersion < 1n) {
    issues.push("INVALID_CREDENTIAL_VERSION");
  }
  if (observation.status !== "ACTIVE" || observation.disabledAt !== null) {
    issues.push("DISABLED_USER");
  }
  if (observation.emailVerifiedAt === null || !observation.emailVerified) {
    issues.push("UNVERIFIED_USER");
  }
  if ((observation.emailVerifiedAt !== null) !== observation.emailVerified) {
    issues.push("VERIFICATION_MISMATCH");
  }
  if (observation.legacyPassword !== "PRESENT") {
    issues.push("LEGACY_CREDENTIAL_UNAVAILABLE");
  }

  const credentials = observation.accounts.filter(
    (account) => account.providerId === "credential",
  );
  if (observation.accounts.some((a) => a.userId !== observation.userId)) {
    issues.push("ACCOUNT_OWNERSHIP_CONFLICT");
  }
  if (credentials.length !== observation.accounts.length) {
    issues.push("UNSUPPORTED_PROVIDER");
  }
  if (credentials.length > 1) {
    issues.push("DUPLICATE_CREDENTIAL_ACCOUNTS");
  }
  if (credentials.some((a) => a.accountId !== observation.userId)) {
    issues.push("NONCANONICAL_CREDENTIAL_ACCOUNT");
  }
  if (credentials.some((a) => !a.passwordPresent)) {
    issues.push("NATIVE_PASSWORD_MISSING");
  }

  const marked = observation.nativeRegistrationCompletedAt !== null;
  const hasDestination = marked || observation.accounts.length > 0;
  const canonicalCredential =
    credentials.length === 1 &&
    credentials[0]?.userId === observation.userId &&
    credentials[0]?.accountId === observation.userId &&
    credentials[0]?.passwordPresent === true &&
    observation.accounts.length === 1;
  if (hasDestination && (!marked || !canonicalCredential)) {
    issues.push("INCOMPLETE_NATIVE_ENROLLMENT");
  }

  const conflict = issues.some((issue) =>
    [
      "INVALID_TIME",
      "INVALID_CREDENTIAL_VERSION",
      "ACCOUNT_OWNERSHIP_CONFLICT",
      "UNSUPPORTED_PROVIDER",
      "DUPLICATE_CREDENTIAL_ACCOUNTS",
      "NONCANONICAL_CREDENTIAL_ACCOUNT",
      "NATIVE_PASSWORD_MISSING",
      "INCOMPLETE_NATIVE_ENROLLMENT",
    ].includes(issue),
  );
  return {
    state: conflict
      ? "CONFLICT"
      : hasDestination
        ? "NATIVE_PRESENT"
        : "LEGACY_ONLY",
    issues,
    destination: hasDestination ? "PRESERVE" : "ABSENT",
  };
}
