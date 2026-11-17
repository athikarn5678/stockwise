import { z } from "zod";

export const databaseUrlSchema = z
  .string()
  .url()
  .refine((value) => new URL(value).protocol === "postgresql:", {
    message: "must be a postgresql:// connection URL",
  });

const analyticsCursorKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/, "must be canonical base64url")
  .refine(
    (value) => {
      const bytes = Buffer.from(value, "base64url");
      return bytes.length >= 32 && bytes.toString("base64url") === value;
    },
    { message: "must encode at least 32 bytes" },
  );

const verificationOtpKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/, "must be canonical base64url")
  .refine(
    (value) => {
      const bytes = Buffer.from(value, "base64url");
      return bytes.length >= 32 && bytes.toString("base64url") === value;
    },
    { message: "must encode at least 32 canonical bytes" },
  );

const verificationProofKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/, "must be canonical base64url")
  .refine(
    (value) => {
      const bytes = Buffer.from(value, "base64url");
      return bytes.length === 32 && bytes.toString("base64url") === value;
    },
    { message: "must encode exactly 32 canonical bytes" },
  );

const verificationOtpKeyIdSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(2_147_483_647);

const verificationProofKeyIdSchema = z.coerce
  .number()
  .int()
  .min(0)
  .max(4_294_967_295);

const verificationPreviousKeyLastIssuedAtSchema = z
  .string()
  .datetime({ offset: true });

export const apiEnvironmentSchema = z
  .object({
    DATABASE_URL: databaseUrlSchema,
    OPENROUTER_API_KEY: z
      .string()
      .regex(/^[\x21-\x7e]+$/)
      .optional(),
    OPENCODE_GO_API_KEY: z
      .string()
      .regex(/^[\x21-\x7e]+$/)
      .optional(),
    OPENCODE_GO_MODEL: z
      .string()
      .regex(/^[A-Za-z0-9_./:-]{1,128}$/)
      .optional(),
    RESEND_API_KEY: z.string().min(1).optional(),
    // Stripe is test mode only (ADR-047): any other key fails startup. The
    // message never echoes the value.
    STRIPE_SECRET_KEY: z
      .string()
      .regex(/^sk_test_[A-Za-z0-9]+$/, {
        message: "STRIPE_SECRET_KEY must be a Stripe test-mode secret key",
      })
      .optional(),
    STOCKWISE_BETTER_AUTH_SECRET: z.string().min(1),
    STOCKWISE_INVITATION_CONTINUATION_KEY: z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/)
      .refine((value) => {
        const bytes = Buffer.from(value, "base64url");
        return bytes.length === 32 && bytes.toString("base64url") === value;
      })
      .optional(),
    STOCKWISE_ANALYTICS_CURSOR_HMAC_KEY: analyticsCursorKeySchema,
    STOCKWISE_VERIFICATION_OTP_KEY: verificationOtpKeySchema,
    STOCKWISE_VERIFICATION_OTP_KEY_ID: verificationOtpKeyIdSchema,
    STOCKWISE_VERIFICATION_PROOF_KEY: verificationProofKeySchema,
    STOCKWISE_VERIFICATION_PROOF_KEY_ID: verificationProofKeyIdSchema,
    STOCKWISE_VERIFICATION_PREVIOUS_PROOF_KEY:
      verificationProofKeySchema.optional(),
    STOCKWISE_VERIFICATION_PREVIOUS_PROOF_KEY_ID:
      verificationProofKeyIdSchema.optional(),
    STOCKWISE_VERIFICATION_PREVIOUS_PROOF_KEY_LAST_ISSUED_AT:
      verificationPreviousKeyLastIssuedAtSchema.optional(),
    STOCKWISE_EMAIL_PROVIDER: z.enum(["non_delivery", "resend"]).optional(),
    STOCKWISE_DEMO_INSIGHT_ORGANIZATION_ID: z.string().uuid().optional(),
    STOCKWISE_RUNTIME_ENV: z.enum(["development", "test", "production"]),
    STOCKWISE_API_PORT: z.coerce.number().int().min(1).max(65_535),
    STOCKWISE_EMAIL_FROM: z.string().min(1).max(320).optional(),
    // Optional merchant PromptPay mobile number. Invalid values must never
    // appear in the validation error text, so the message is fixed.
    // An empty value (blank container variable, copied example) means "not configured".
    STOCKWISE_PROMPTPAY_ID: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z
        .string()
        .regex(/^0\d{9}$/, {
          message: "must be a 10-digit Thai mobile number",
        })
        .optional(),
    ),
    STOCKWISE_PUBLIC_WEB_ORIGIN: z
      .string()
      .url()
      .refine(
        (value) => ["http:", "https:"].includes(new URL(value).protocol),
        { message: "must be an HTTP(S) origin" },
      )
      .transform((value) => new URL(value).origin),
    STOCKWISE_SESSION_ABSOLUTE_TIMEOUT_MINUTES: z.coerce
      .number()
      .int()
      .positive()
      .default(7 * 24 * 60),
    STOCKWISE_SESSION_IDLE_TIMEOUT_MINUTES: z.coerce
      .number()
      .int()
      .positive()
      .default(24 * 60),
    STOCKWISE_SESSION_TOUCH_INTERVAL_MINUTES: z.coerce
      .number()
      .int()
      .positive()
      .default(15),
  })
  .strict()
  .transform((environment) => ({
    ...environment,
    STOCKWISE_EMAIL_PROVIDER:
      environment.STOCKWISE_EMAIL_PROVIDER ??
      (environment.STOCKWISE_RUNTIME_ENV === "production"
        ? "resend"
        : "non_delivery"),
  }))
  .superRefine((environment, context) => {
    if (
      (environment.STOCKWISE_RUNTIME_ENV === "production" &&
        environment.STOCKWISE_EMAIL_PROVIDER !== "resend") ||
      (environment.STOCKWISE_RUNTIME_ENV === "test" &&
        environment.STOCKWISE_EMAIL_PROVIDER !== "non_delivery")
    ) {
      context.addIssue({
        code: "custom",
        message: "Email provider is not allowed in this runtime.",
        path: ["STOCKWISE_EMAIL_PROVIDER"],
      });
    }
    if (environment.STOCKWISE_EMAIL_PROVIDER === "resend") {
      if (environment.RESEND_API_KEY === undefined) {
        context.addIssue({
          code: "custom",
          message: "Resend API key is required for email delivery.",
          path: ["RESEND_API_KEY"],
        });
      }
      if (environment.STOCKWISE_EMAIL_FROM === undefined) {
        context.addIssue({
          code: "custom",
          message: "Email sender is required for email delivery.",
          path: ["STOCKWISE_EMAIL_FROM"],
        });
      }
    }

    const otpKeyBytes = Buffer.from(
      environment.STOCKWISE_VERIFICATION_OTP_KEY,
      "base64url",
    );
    const proofKeyBytes = Buffer.from(
      environment.STOCKWISE_VERIFICATION_PROOF_KEY,
      "base64url",
    );
    if (otpKeyBytes.equals(proofKeyBytes)) {
      context.addIssue({
        code: "custom",
        message:
          "Verification OTP and proof keys must be distinct dedicated keys.",
        path: ["STOCKWISE_VERIFICATION_PROOF_KEY"],
      });
    }
    const continuationKey = environment.STOCKWISE_INVITATION_CONTINUATION_KEY;
    if (continuationKey !== undefined) {
      const continuationBytes = Buffer.from(continuationKey, "base64url");
      const otherKeys = [
        environment.STOCKWISE_ANALYTICS_CURSOR_HMAC_KEY,
        environment.STOCKWISE_VERIFICATION_OTP_KEY,
        environment.STOCKWISE_VERIFICATION_PROOF_KEY,
        environment.STOCKWISE_VERIFICATION_PREVIOUS_PROOF_KEY,
        environment.STOCKWISE_BETTER_AUTH_SECRET,
      ].filter((value): value is string => value !== undefined);
      if (
        otherKeys.some(
          (value) =>
            value === continuationKey ||
            Buffer.from(value, "base64url").equals(continuationBytes),
        )
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Invitation continuation key must be distinct from all other application keys.",
          path: ["STOCKWISE_INVITATION_CONTINUATION_KEY"],
        });
      }
    }
    const analyticsKeyBytes = Buffer.from(
      environment.STOCKWISE_ANALYTICS_CURSOR_HMAC_KEY,
      "base64url",
    );
    const providerKeyValues = [
      environment.OPENROUTER_API_KEY,
      environment.OPENCODE_GO_API_KEY,
      environment.RESEND_API_KEY,
    ].filter((value): value is string => value !== undefined);
    const rejectReusedVerificationMaterial = (
      keyName: string,
      keyBytes: Buffer,
      rawValue: string,
    ): void => {
      if (keyBytes.equals(analyticsKeyBytes)) {
        context.addIssue({
          code: "custom",
          message:
            "Verification keys must be distinct from the analytics cursor key.",
          path: [keyName],
        });
      }
      for (const providerKey of providerKeyValues) {
        if (
          rawValue === providerKey ||
          keyBytes.toString("utf8") === providerKey
        ) {
          context.addIssue({
            code: "custom",
            message:
              "Verification keys must be distinct from provider API keys.",
            path: [keyName],
          });
        }
      }
    };
    rejectReusedVerificationMaterial(
      "STOCKWISE_VERIFICATION_OTP_KEY",
      otpKeyBytes,
      environment.STOCKWISE_VERIFICATION_OTP_KEY,
    );
    rejectReusedVerificationMaterial(
      "STOCKWISE_VERIFICATION_PROOF_KEY",
      proofKeyBytes,
      environment.STOCKWISE_VERIFICATION_PROOF_KEY,
    );
    const previousProofKey =
      environment.STOCKWISE_VERIFICATION_PREVIOUS_PROOF_KEY;
    if (previousProofKey !== undefined) {
      const previousProofKeyBytes = Buffer.from(previousProofKey, "base64url");
      if (previousProofKeyBytes.equals(proofKeyBytes)) {
        context.addIssue({
          code: "custom",
          message:
            "Current and previous verification proof keys must be distinct.",
          path: ["STOCKWISE_VERIFICATION_PREVIOUS_PROOF_KEY"],
        });
      }
      if (previousProofKeyBytes.equals(otpKeyBytes)) {
        context.addIssue({
          code: "custom",
          message: "Verification OTP and previous proof keys must be distinct.",
          path: ["STOCKWISE_VERIFICATION_PREVIOUS_PROOF_KEY"],
        });
      }
      rejectReusedVerificationMaterial(
        "STOCKWISE_VERIFICATION_PREVIOUS_PROOF_KEY",
        previousProofKeyBytes,
        previousProofKey,
      );
      if (
        environment.STOCKWISE_VERIFICATION_PREVIOUS_PROOF_KEY_ID ===
          undefined ||
        environment.STOCKWISE_VERIFICATION_PREVIOUS_PROOF_KEY_LAST_ISSUED_AT ===
          undefined
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Previous verification proof key requires an ID and last-issued timestamp.",
          path: ["STOCKWISE_VERIFICATION_PREVIOUS_PROOF_KEY"],
        });
      } else if (
        environment.STOCKWISE_VERIFICATION_PREVIOUS_PROOF_KEY_ID ===
        environment.STOCKWISE_VERIFICATION_PROOF_KEY_ID
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Current and previous verification proof key IDs must be distinct.",
          path: ["STOCKWISE_VERIFICATION_PREVIOUS_PROOF_KEY_ID"],
        });
      }
    }
    if (
      previousProofKey === undefined &&
      (environment.STOCKWISE_VERIFICATION_PREVIOUS_PROOF_KEY_ID !== undefined ||
        environment.STOCKWISE_VERIFICATION_PREVIOUS_PROOF_KEY_LAST_ISSUED_AT !==
          undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Previous verification proof key metadata requires its key.",
        path: ["STOCKWISE_VERIFICATION_PREVIOUS_PROOF_KEY"],
      });
    }

    if (
      environment.STOCKWISE_SESSION_IDLE_TIMEOUT_MINUTES >
      environment.STOCKWISE_SESSION_ABSOLUTE_TIMEOUT_MINUTES
    ) {
      context.addIssue({
        code: "custom",
        message: "Session idle timeout must not exceed absolute timeout.",
        path: ["STOCKWISE_SESSION_IDLE_TIMEOUT_MINUTES"],
      });
    }

    if (
      environment.STOCKWISE_SESSION_TOUCH_INTERVAL_MINUTES >
      environment.STOCKWISE_SESSION_IDLE_TIMEOUT_MINUTES
    ) {
      context.addIssue({
        code: "custom",
        message: "Session touch interval must not exceed idle timeout.",
        path: ["STOCKWISE_SESSION_TOUCH_INTERVAL_MINUTES"],
      });
    }
  });

export type ApiEnvironment = z.infer<typeof apiEnvironmentSchema>;

export function loadApiEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ApiEnvironment {
  return apiEnvironmentSchema.parse({
    DATABASE_URL: environment.DATABASE_URL,
    OPENROUTER_API_KEY: environment.OPENROUTER_API_KEY,
    OPENCODE_GO_API_KEY: environment.OPENCODE_GO_API_KEY,
    OPENCODE_GO_MODEL: environment.OPENCODE_GO_MODEL,
    RESEND_API_KEY: environment.RESEND_API_KEY,
    STRIPE_SECRET_KEY: environment.STRIPE_SECRET_KEY,
    STOCKWISE_BETTER_AUTH_SECRET: environment.STOCKWISE_BETTER_AUTH_SECRET,
    STOCKWISE_INVITATION_CONTINUATION_KEY:
      environment.STOCKWISE_INVITATION_CONTINUATION_KEY,
    STOCKWISE_ANALYTICS_CURSOR_HMAC_KEY:
      environment.STOCKWISE_ANALYTICS_CURSOR_HMAC_KEY,
    STOCKWISE_VERIFICATION_OTP_KEY: environment.STOCKWISE_VERIFICATION_OTP_KEY,
    STOCKWISE_VERIFICATION_OTP_KEY_ID:
      environment.STOCKWISE_VERIFICATION_OTP_KEY_ID,
    STOCKWISE_VERIFICATION_PROOF_KEY:
      environment.STOCKWISE_VERIFICATION_PROOF_KEY,
    STOCKWISE_VERIFICATION_PROOF_KEY_ID:
      environment.STOCKWISE_VERIFICATION_PROOF_KEY_ID,
    STOCKWISE_VERIFICATION_PREVIOUS_PROOF_KEY:
      environment.STOCKWISE_VERIFICATION_PREVIOUS_PROOF_KEY,
    STOCKWISE_VERIFICATION_PREVIOUS_PROOF_KEY_ID:
      environment.STOCKWISE_VERIFICATION_PREVIOUS_PROOF_KEY_ID,
    STOCKWISE_VERIFICATION_PREVIOUS_PROOF_KEY_LAST_ISSUED_AT:
      environment.STOCKWISE_VERIFICATION_PREVIOUS_PROOF_KEY_LAST_ISSUED_AT,
    STOCKWISE_EMAIL_PROVIDER: environment.STOCKWISE_EMAIL_PROVIDER,
    STOCKWISE_DEMO_INSIGHT_ORGANIZATION_ID:
      environment.STOCKWISE_DEMO_INSIGHT_ORGANIZATION_ID,
    STOCKWISE_RUNTIME_ENV: environment.STOCKWISE_RUNTIME_ENV,
    STOCKWISE_API_PORT: environment.STOCKWISE_API_PORT,
    STOCKWISE_EMAIL_FROM: environment.STOCKWISE_EMAIL_FROM,
    STOCKWISE_PROMPTPAY_ID: environment.STOCKWISE_PROMPTPAY_ID,
    STOCKWISE_PUBLIC_WEB_ORIGIN: environment.STOCKWISE_PUBLIC_WEB_ORIGIN,
    STOCKWISE_SESSION_ABSOLUTE_TIMEOUT_MINUTES:
      environment.STOCKWISE_SESSION_ABSOLUTE_TIMEOUT_MINUTES,
    STOCKWISE_SESSION_IDLE_TIMEOUT_MINUTES:
      environment.STOCKWISE_SESSION_IDLE_TIMEOUT_MINUTES,
    STOCKWISE_SESSION_TOUCH_INTERVAL_MINUTES:
      environment.STOCKWISE_SESSION_TOUCH_INTERVAL_MINUTES,
  });
}
