import { defineConfig } from "vitest/config";

// D5-P2 source-only checks: no database setup, schema operations or resource acquisition.
export default defineConfig({
  test: {
    fileParallelism: false,
    include: [
      "apps/api/src/modules/identity/invitation-continuation-cookie.test.ts",
      "apps/api/src/modules/identity/login-router.test.ts",
      "apps/api/src/modules/identity/session-cookie.test.ts",
      "apps/api/src/modules/identity/authentication-authority-selection.test.ts",
      "apps/api/src/modules/identity/better-auth-application-runtime.test.ts",
      "apps/api/src/modules/identity/better-auth-application-session.test.ts",
      "apps/api/src/modules/identity/login-limiter.test.ts",
      "apps/api/src/environment.test.ts",
      "apps/api/src/modules/identity/better-auth-bridge.test.ts",
      "apps/api/src/modules/identity/better-auth-native.test.ts",
      "apps/api/src/modules/identity/authentication-runtime.test.ts",
    ],
  },
});
