import { describe, expect, it } from "vitest";

import {
  apiEnvironmentSchema,
  databaseUrlSchema,
  loadApiEnvironment,
} from "./environment.ts";

const analyticsKey = Buffer.alloc(32, 7).toString("base64url");

const verificationOtpKey = Buffer.alloc(32, 3).toString("base64url");
const verificationProofKey = Buffer.alloc(32, 4).toString("base64url");
const verificationKeys = {
  STOCKWISE_VERIFICATION_OTP_KEY: verificationOtpKey,
  STOCKWISE_VERIFICATION_OTP_KEY_ID: "1",
  STOCKWISE_VERIFICATION_PROOF_KEY: verificationProofKey,
  STOCKWISE_VERIFICATION_PROOF_KEY_ID: "2",
};

describe("API environment boundary", () => {
  it("refuses accidental Production Demo Insight enablement", () => {
    const result = apiEnvironmentSchema.safeParse({
      DATABASE_URL: "postgresql://local:local@127.0.0.1:5432/local",
      STOCKWISE_API_PORT: "3001",
      STOCKWISE_ANALYTICS_CURSOR_HMAC_KEY: analyticsKey,
      STOCKWISE_PUBLIC_WEB_ORIGIN: "https://stockwise.example.com",
      STOCKWISE_RUNTIME_ENV: "production",
      STOCKWISE_AUTHENTICATION_AUTHORITY: "native",
      STOCKWISE_EMAIL_PROVIDER: "resend",
      RESEND_API_KEY: "test-only-key",
      STOCKWISE_EMAIL_FROM: "StockWise <sender@example.com>",
      STOCKWISE_DEMO_INSIGHT_ORGANIZATION_ID:
        "00000000-0000-4000-8000-000000000001",
      ...verificationKeys,
    });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ["STOCKWISE_DEMO_INSIGHT_ORGANIZATION_ID"],
            message: "Demo Insight is disabled in production.",
          }),
        ]),
      );
  });
  it("loads the required local API and database configuration", () => {
    expect(
      loadApiEnvironment({
        DATABASE_URL:
          "postgresql://local-user:local-password@127.0.0.1:5432/local-database",
        STOCKWISE_API_PORT: "3001",
        STOCKWISE_ANALYTICS_CURSOR_HMAC_KEY: analyticsKey,
        STOCKWISE_PUBLIC_WEB_ORIGIN: "http://localhost:3000/",
        STOCKWISE_RUNTIME_ENV: "development",
        ...verificationKeys,
      }),
    ).toEqual({
      DATABASE_URL:
        "postgresql://local-user:local-password@127.0.0.1:5432/local-database",
      STOCKWISE_RUNTIME_ENV: "development",
      STOCKWISE_AUTHENTICATION_AUTHORITY: "legacy",
      STOCKWISE_EMAIL_PROVIDER: "non_delivery",
      STOCKWISE_API_PORT: 3001,
      STOCKWISE_ANALYTICS_CURSOR_HMAC_KEY: analyticsKey,
      STOCKWISE_PUBLIC_WEB_ORIGIN: "http://localhost:3000",
      STOCKWISE_SESSION_ABSOLUTE_TIMEOUT_MINUTES: 10_080,
      STOCKWISE_SESSION_IDLE_TIMEOUT_MINUTES: 1_440,
      STOCKWISE_SESSION_TOUCH_INTERVAL_MINUTES: 15,
      STOCKWISE_VERIFICATION_OTP_KEY: verificationOtpKey,
      STOCKWISE_VERIFICATION_OTP_KEY_ID: 1,
      STOCKWISE_VERIFICATION_PROOF_KEY: verificationProofKey,
      STOCKWISE_VERIFICATION_PROOF_KEY_ID: 2,
      STOCKWISE_VERIFICATION_PREVIOUS_PROOF_KEY: undefined,
      STOCKWISE_VERIFICATION_PREVIOUS_PROOF_KEY_ID: undefined,
      STOCKWISE_VERIFICATION_PREVIOUS_PROOF_KEY_LAST_ISSUED_AT: undefined,
    });
  });

  it("loads production cookie mode and configurable session timeouts", () => {
    expect(
      loadApiEnvironment({
        DATABASE_URL:
          "postgresql://local-user:local-password@127.0.0.1:5432/local-database",
        STOCKWISE_API_PORT: "3001",
        STOCKWISE_ANALYTICS_CURSOR_HMAC_KEY: analyticsKey,
        STOCKWISE_EMAIL_FROM: "StockWise <verified@example.com>",
        STOCKWISE_PUBLIC_WEB_ORIGIN: "https://stockwise.example.com",
        STOCKWISE_RUNTIME_ENV: "production",
        RESEND_API_KEY: "server-only-resend-key",
        STOCKWISE_SESSION_ABSOLUTE_TIMEOUT_MINUTES: "20160",
        STOCKWISE_SESSION_IDLE_TIMEOUT_MINUTES: "2880",
        STOCKWISE_SESSION_TOUCH_INTERVAL_MINUTES: "30",
        ...verificationKeys,
      }),
    ).toMatchObject({
      STOCKWISE_RUNTIME_ENV: "production",
      STOCKWISE_AUTHENTICATION_AUTHORITY: "native",
      STOCKWISE_EMAIL_PROVIDER: "resend",
      STOCKWISE_ANALYTICS_CURSOR_HMAC_KEY: analyticsKey,
      RESEND_API_KEY: "server-only-resend-key",
      STOCKWISE_EMAIL_FROM: "StockWise <verified@example.com>",
      STOCKWISE_PUBLIC_WEB_ORIGIN: "https://stockwise.example.com",
      STOCKWISE_SESSION_ABSOLUTE_TIMEOUT_MINUTES: 20_160,
      STOCKWISE_SESSION_IDLE_TIMEOUT_MINUTES: 2_880,
      STOCKWISE_SESSION_TOUCH_INTERVAL_MINUTES: 30,
    });
  });

  it("locks production to Native authentication and rejects unknown authorities", () => {
    const production = {
      DATABASE_URL:
        "postgresql://local-user:local-password@127.0.0.1:5432/local-database",
      STOCKWISE_API_PORT: "3001",
      STOCKWISE_ANALYTICS_CURSOR_HMAC_KEY: analyticsKey,
      STOCKWISE_EMAIL_FROM: "StockWise <verified@example.com>",
      STOCKWISE_PUBLIC_WEB_ORIGIN: "https://stockwise.example.com",
      STOCKWISE_RUNTIME_ENV: "production",
      RESEND_API_KEY: "server-only-resend-key",
      ...verificationKeys,
    };
    expect(
      loadApiEnvironment({
        ...production,
        STOCKWISE_AUTHENTICATION_AUTHORITY: "native",
      }).STOCKWISE_AUTHENTICATION_AUTHORITY,
    ).toBe("native");
    expect(() =>
      loadApiEnvironment({
        ...production,
        STOCKWISE_AUTHENTICATION_AUTHORITY: "legacy",
      }),
    ).toThrow("Production runtime requires Native authentication.");
    for (const runtime of ["development", "test", "production"]) {
      expect(() =>
        loadApiEnvironment({
          ...production,
          STOCKWISE_RUNTIME_ENV: runtime,
          STOCKWISE_EMAIL_PROVIDER:
            runtime === "production" ? "resend" : "non_delivery",
          STOCKWISE_AUTHENTICATION_AUTHORITY: "bridge",
        }),
      ).toThrow();
    }
    expect(
      loadApiEnvironment({
        ...production,
        STOCKWISE_RUNTIME_ENV: "development",
        STOCKWISE_EMAIL_PROVIDER: "non_delivery",
        STOCKWISE_AUTHENTICATION_AUTHORITY: "native",
      }).STOCKWISE_AUTHENTICATION_AUTHORITY,
    ).toBe("native");
  });

  it("rejects missing, invalid, and unowned configuration", () => {
    expect(() => apiEnvironmentSchema.parse({})).toThrow();
    expect(() =>
      apiEnvironmentSchema.parse({ DATABASE_URL: "not-a-url" }),
    ).toThrow();
    expect(() =>
      apiEnvironmentSchema.parse({
        DATABASE_URL: "mysql://local-user@127.0.0.1:3306/local-database",
        STOCKWISE_API_PORT: "3001",
        STOCKWISE_PUBLIC_WEB_ORIGIN: "http://localhost:3000",
        STOCKWISE_RUNTIME_ENV: "development",
      }),
    ).toThrow();
    expect(() =>
      apiEnvironmentSchema.parse({
        DATABASE_URL:
          "postgresql://local-user:local-password@127.0.0.1:5432/local-database",
        STOCKWISE_API_PORT: "3001",
        STOCKWISE_PUBLIC_WEB_ORIGIN: "http://localhost:3000",
        STOCKWISE_RUNTIME_ENV: "development",
        UNOWNED_VALUE: "must-not-be-accepted",
      }),
    ).toThrow();
    expect(() =>
      loadApiEnvironment({
        DATABASE_URL:
          "postgresql://local-user:local-password@127.0.0.1:5432/local-database",
        STOCKWISE_API_PORT: "3001",
        STOCKWISE_RUNTIME_ENV: "development",
        STOCKWISE_SESSION_ABSOLUTE_TIMEOUT_MINUTES: "60",
        STOCKWISE_SESSION_IDLE_TIMEOUT_MINUTES: "61",
      }),
    ).toThrow();
    expect(() =>
      loadApiEnvironment({
        DATABASE_URL:
          "postgresql://local-user:local-password@127.0.0.1:5432/local-database",
        STOCKWISE_API_PORT: "3001",
        STOCKWISE_PUBLIC_WEB_ORIGIN: "https://stockwise.example.com",
        STOCKWISE_RUNTIME_ENV: "production",
      }),
    ).toThrow();
  });

  it("requires one canonical stable analytics key in every runtime mode", () => {
    const base = {
      DATABASE_URL:
        "postgresql://local-user:local-password@127.0.0.1:5432/local-database",
      STOCKWISE_API_PORT: "3001",
      STOCKWISE_PUBLIC_WEB_ORIGIN: "http://localhost:3000",
      STOCKWISE_RUNTIME_ENV: "test",
      ...verificationKeys,
    };
    expect(() => loadApiEnvironment(base)).toThrow();
    for (const key of [
      "short",
      Buffer.alloc(31, 1).toString("base64url"),
      `${analyticsKey}=`,
    ]) {
      expect(() =>
        loadApiEnvironment({
          ...base,
          STOCKWISE_ANALYTICS_CURSOR_HMAC_KEY: key,
        }),
      ).toThrow();
    }
    expect(
      loadApiEnvironment({
        ...base,
        STOCKWISE_ANALYTICS_CURSOR_HMAC_KEY: analyticsKey,
      }).STOCKWISE_ANALYTICS_CURSOR_HMAC_KEY,
    ).toBe(analyticsKey);
  });

  it("validates database-only connectivity without requiring analytics configuration", () => {
    expect(
      databaseUrlSchema.parse(
        "postgresql://local-user@127.0.0.1:5432/local-database",
      ),
    ).toBe("postgresql://local-user@127.0.0.1:5432/local-database");
    expect(() =>
      databaseUrlSchema.parse(
        "mysql://local-user@127.0.0.1:3306/local-database",
      ),
    ).toThrow();
  });

  it("resolves email provider defaults and rejects unsafe runtime combinations", () => {
    const base = {
      DATABASE_URL:
        "postgresql://local-user:local-password@127.0.0.1:5432/local-database",
      STOCKWISE_API_PORT: "3001",
      STOCKWISE_ANALYTICS_CURSOR_HMAC_KEY: analyticsKey,
      STOCKWISE_PUBLIC_WEB_ORIGIN: "http://localhost:3000",
      RESEND_API_KEY: "placeholder-key",
      STOCKWISE_EMAIL_FROM: "StockWise <no-reply@example.com>",
      ...verificationKeys,
    };
    for (const runtime of ["development", "test"] as const) {
      expect(
        loadApiEnvironment({ ...base, STOCKWISE_RUNTIME_ENV: runtime })
          .STOCKWISE_EMAIL_PROVIDER,
      ).toBe("non_delivery");
    }
    expect(
      loadApiEnvironment({
        ...base,
        STOCKWISE_RUNTIME_ENV: "development",
        STOCKWISE_EMAIL_PROVIDER: "non_delivery",
      }).STOCKWISE_EMAIL_PROVIDER,
    ).toBe("non_delivery");
    expect(
      loadApiEnvironment({
        ...base,
        STOCKWISE_RUNTIME_ENV: "development",
        STOCKWISE_EMAIL_PROVIDER: "resend",
      }).STOCKWISE_EMAIL_PROVIDER,
    ).toBe("resend");
    for (const missing of ["RESEND_API_KEY", "STOCKWISE_EMAIL_FROM"] as const) {
      expect(() =>
        loadApiEnvironment({
          ...base,
          [missing]: undefined,
          STOCKWISE_RUNTIME_ENV: "development",
          STOCKWISE_EMAIL_PROVIDER: "resend",
        }),
      ).toThrow();
    }
    expect(() =>
      loadApiEnvironment({
        ...base,
        STOCKWISE_RUNTIME_ENV: "test",
        STOCKWISE_EMAIL_PROVIDER: "resend",
      }),
    ).toThrow();
    expect(
      loadApiEnvironment({ ...base, STOCKWISE_RUNTIME_ENV: "production" })
        .STOCKWISE_EMAIL_PROVIDER,
    ).toBe("resend");
    expect(
      loadApiEnvironment({
        ...base,
        STOCKWISE_RUNTIME_ENV: "production",
        STOCKWISE_EMAIL_PROVIDER: "resend",
      }).STOCKWISE_EMAIL_PROVIDER,
    ).toBe("resend");
    expect(() =>
      loadApiEnvironment({
        ...base,
        STOCKWISE_RUNTIME_ENV: "production",
        STOCKWISE_EMAIL_PROVIDER: "non_delivery",
      }),
    ).toThrow();
    expect(() =>
      loadApiEnvironment({
        ...base,
        STOCKWISE_RUNTIME_ENV: "production",
        RESEND_API_KEY: undefined,
      }),
    ).toThrow();
    expect(() =>
      loadApiEnvironment({
        ...base,
        STOCKWISE_RUNTIME_ENV: "production",
        STOCKWISE_EMAIL_FROM: undefined,
      }),
    ).toThrow();
    expect(() =>
      loadApiEnvironment({
        ...base,
        STOCKWISE_RUNTIME_ENV: "development",
        STOCKWISE_EMAIL_PROVIDER: "other",
      }),
    ).toThrow();
  });

  it("keeps the optional OpenRouter key server-only and rejects blank or malformed values", () => {
    const base = {
      DATABASE_URL:
        "postgresql://local-user:local-password@127.0.0.1:5432/local-database",
      STOCKWISE_API_PORT: "3001",
      STOCKWISE_ANALYTICS_CURSOR_HMAC_KEY: analyticsKey,
      STOCKWISE_PUBLIC_WEB_ORIGIN: "http://localhost:3000",
      STOCKWISE_RUNTIME_ENV: "development",
      ...verificationKeys,
    };
    expect(loadApiEnvironment(base).OPENROUTER_API_KEY).toBeUndefined();
    expect(
      loadApiEnvironment({ ...base, OPENROUTER_API_KEY: "server-only-key" })
        .OPENROUTER_API_KEY,
    ).toBe("server-only-key");
    for (const key of ["", " ", "key\nsecret"]) {
      expect(() =>
        loadApiEnvironment({ ...base, OPENROUTER_API_KEY: key }),
      ).toThrow();
    }
    let error: unknown;
    try {
      loadApiEnvironment({ ...base, OPENROUTER_API_KEY: "secret\nvalue" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeDefined();
    expect(String(error)).not.toContain("secret\nvalue");
  });

  it("requires distinct dedicated canonical verification keys", () => {
    const base = {
      DATABASE_URL:
        "postgresql://local-user:local-password@127.0.0.1:5432/local-database",
      STOCKWISE_API_PORT: "3001",
      STOCKWISE_ANALYTICS_CURSOR_HMAC_KEY: analyticsKey,
      STOCKWISE_PUBLIC_WEB_ORIGIN: "http://localhost:3000",
      STOCKWISE_RUNTIME_ENV: "development",
      ...verificationKeys,
    };
    const parsed = loadApiEnvironment(base);
    expect(parsed.STOCKWISE_VERIFICATION_OTP_KEY_ID).toBe(1);
    expect(parsed.STOCKWISE_VERIFICATION_PROOF_KEY_ID).toBe(2);
    expect(parsed.STOCKWISE_VERIFICATION_PREVIOUS_PROOF_KEY).toBeUndefined();

    for (const [field, value] of [
      [
        "STOCKWISE_VERIFICATION_OTP_KEY",
        Buffer.alloc(31, 1).toString("base64url"),
      ],
      ["STOCKWISE_VERIFICATION_OTP_KEY", `${verificationOtpKey}=`],
      ["STOCKWISE_VERIFICATION_OTP_KEY", "not-base64url!"],
      [
        "STOCKWISE_VERIFICATION_PROOF_KEY",
        Buffer.alloc(31, 1).toString("base64url"),
      ],
      [
        "STOCKWISE_VERIFICATION_PROOF_KEY",
        Buffer.alloc(33, 1).toString("base64url"),
      ],
    ] as const) {
      expect(() => loadApiEnvironment({ ...base, [field]: value })).toThrow();
    }
    for (const [field, value] of [
      ["STOCKWISE_VERIFICATION_OTP_KEY_ID", "0"],
      ["STOCKWISE_VERIFICATION_OTP_KEY_ID", "2147483648"],
      ["STOCKWISE_VERIFICATION_OTP_KEY_ID", "1.5"],
      ["STOCKWISE_VERIFICATION_PROOF_KEY_ID", "-1"],
      ["STOCKWISE_VERIFICATION_PROOF_KEY_ID", "4294967296"],
    ] as const) {
      expect(() => loadApiEnvironment({ ...base, [field]: value })).toThrow();
    }

    // OTP and proof keys must be distinct dedicated keys.
    expect(() =>
      loadApiEnvironment({
        ...base,
        STOCKWISE_VERIFICATION_PROOF_KEY: verificationOtpKey,
      }),
    ).toThrow();

    // A previous proof key must be complete, distinct, and ID-unique.
    const previousKey = Buffer.alloc(32, 5).toString("base64url");
    const previousBase = {
      ...base,
      STOCKWISE_VERIFICATION_PREVIOUS_PROOF_KEY: previousKey,
      STOCKWISE_VERIFICATION_PREVIOUS_PROOF_KEY_ID: "3",
      STOCKWISE_VERIFICATION_PREVIOUS_PROOF_KEY_LAST_ISSUED_AT: new Date(
        1_700_000_000_000,
      ).toISOString(),
    };
    expect(
      loadApiEnvironment(previousBase)
        .STOCKWISE_VERIFICATION_PREVIOUS_PROOF_KEY_ID,
    ).toBe(3);
    expect(() =>
      loadApiEnvironment({
        ...previousBase,
        STOCKWISE_VERIFICATION_PREVIOUS_PROOF_KEY_ID: "2",
      }),
    ).toThrow();
    expect(() =>
      loadApiEnvironment({
        ...previousBase,
        STOCKWISE_VERIFICATION_PREVIOUS_PROOF_KEY: verificationProofKey,
      }),
    ).toThrow();
    expect(() =>
      loadApiEnvironment({
        ...previousBase,
        STOCKWISE_VERIFICATION_PREVIOUS_PROOF_KEY: verificationOtpKey,
      }),
    ).toThrow();
    expect(() =>
      loadApiEnvironment({
        ...previousBase,
        STOCKWISE_VERIFICATION_PREVIOUS_PROOF_KEY_ID: undefined,
      }),
    ).toThrow();
    expect(() =>
      loadApiEnvironment({
        ...previousBase,
        STOCKWISE_VERIFICATION_PREVIOUS_PROOF_KEY_LAST_ISSUED_AT: undefined,
      }),
    ).toThrow();
    expect(() =>
      loadApiEnvironment({
        ...previousBase,
        STOCKWISE_VERIFICATION_PREVIOUS_PROOF_KEY_LAST_ISSUED_AT: "not-a-time",
      }),
    ).toThrow();
    for (const metadata of [
      { STOCKWISE_VERIFICATION_PREVIOUS_PROOF_KEY_ID: "3" },
      {
        STOCKWISE_VERIFICATION_PREVIOUS_PROOF_KEY_LAST_ISSUED_AT: new Date(
          1_700_000_000_000,
        ).toISOString(),
      },
    ]) {
      expect(() => loadApiEnvironment({ ...base, ...metadata })).toThrow();
    }
    expect(() =>
      loadApiEnvironment({
        ...previousBase,
        STOCKWISE_VERIFICATION_PREVIOUS_PROOF_KEY_LAST_ISSUED_AT:
          "2026-01-01 12:00:00",
      }),
    ).toThrow();

    // Verification key material must be isolated from analytics and
    // provider material as well as the other verification keys.
    expect(() =>
      loadApiEnvironment({
        ...base,
        STOCKWISE_VERIFICATION_OTP_KEY: analyticsKey,
      }),
    ).toThrow();
    expect(() =>
      loadApiEnvironment({
        ...base,
        STOCKWISE_VERIFICATION_PROOF_KEY: analyticsKey,
      }),
    ).toThrow();
    expect(() =>
      loadApiEnvironment({
        ...base,
        RESEND_API_KEY: verificationOtpKey,
      }),
    ).toThrow();
    expect(() =>
      loadApiEnvironment({
        ...base,
        OPENROUTER_API_KEY: verificationProofKey,
      }),
    ).toThrow();
    expect(() =>
      loadApiEnvironment({
        ...base,
        STOCKWISE_VERIFICATION_OTP_KEY: "sk-placeholder-key",
        RESEND_API_KEY: "sk-placeholder-key",
      }),
    ).toThrow();

    // Key material must never appear in validation errors.
    let error: unknown;
    try {
      loadApiEnvironment({
        ...base,
        STOCKWISE_VERIFICATION_PROOF_KEY: verificationOtpKey,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeDefined();
    expect(String(error)).not.toContain(verificationOtpKey);
  });
});
