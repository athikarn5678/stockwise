import { AuthApiError, type AuthApiErrorKind } from "@/api-client";
import type { TranslationKey } from "@/i18n/en";

export function passwordValidationMessage(password: string): string | null {
  const codePointLength = [...password].length;

  if (codePointLength < 15 || codePointLength > 128) {
    return "Password must contain between 15 and 128 Unicode code points.";
  }

  return null;
}

export function hasEmailShape(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

export function authErrorMessage(
  error: unknown,
  t: (key: TranslationKey) => string,
  overrides: Partial<Record<AuthApiErrorKind, TranslationKey>> = {},
): string {
  if (!(error instanceof AuthApiError)) return t("authRequestError");

  if (error.kind === "rate_limited") {
    return error.retryAfterSeconds === null
      ? t("authRateLimitedGeneric")
      : t("authRateLimited")
          .replace("{seconds}", String(error.retryAfterSeconds))
          .replace("{plural}", error.retryAfterSeconds === 1 ? "" : "s");
  }

  const override = overrides[error.kind];
  if (override !== undefined) return t(override);
  return t(
    error.kind === "unavailable" ? "authRequestError" : "authCheckInformation",
  );
}
