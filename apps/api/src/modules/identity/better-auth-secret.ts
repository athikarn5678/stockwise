import type { ApiEnvironment } from "../../environment.ts";

/** Validate only when Native is selected; never include secret material in errors. */
export function requireBetterAuthSecret(environment: ApiEnvironment): string {
  const secret = environment.STOCKWISE_BETTER_AUTH_SECRET;
  const refuse = () => {
    throw new Error(
      "Native authentication requires a dedicated canonical base64url secret of at least 32 bytes.",
    );
  };
  if (secret === undefined || !/^[A-Za-z0-9_-]+$/.test(secret)) return refuse();
  const bytes = Buffer.from(secret, "base64url");
  if (bytes.length < 32 || bytes.toString("base64url") !== secret)
    return refuse();
  const dedicatedKeys = [
    environment.STOCKWISE_ANALYTICS_CURSOR_HMAC_KEY,
    environment.STOCKWISE_VERIFICATION_OTP_KEY,
    environment.STOCKWISE_VERIFICATION_PROOF_KEY,
    environment.STOCKWISE_VERIFICATION_PREVIOUS_PROOF_KEY,
  ];
  if (
    dedicatedKeys.some(
      (key) => key !== undefined && bytes.equals(Buffer.from(key, "base64url")),
    )
  )
    return refuse();
  if (
    [environment.RESEND_API_KEY, environment.OPENROUTER_API_KEY].some(
      (key) =>
        key !== undefined && (key === secret || key === bytes.toString("utf8")),
    )
  )
    return refuse();
  return secret;
}
