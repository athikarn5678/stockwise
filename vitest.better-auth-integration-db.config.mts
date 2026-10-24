import { defineConfig } from "vitest/config";

// The D4-N3 coordinator alone creates and migrates the owned disposable database.
export default defineConfig({
  test: {
    fileParallelism: false,
    reporters: ["default", "json"],
    outputFile: { json: "test-results/native-database-results.json" },
    include: [
      "apps/api/src/modules/identity/pending-registration.integration.test.ts",
      "apps/api/src/modules/identity/pending-registration-suppression.integration.test.ts",
      "apps/api/src/modules/identity/better-auth-application-session.integration.test.ts",
      "apps/api/src/modules/identity/better-auth-application-proof.integration.test.ts",
      "apps/api/src/modules/identity/better-auth-application-concurrency.integration.test.ts",
      "apps/api/src/modules/identity/better-auth-password-reset.integration.test.ts",
      "apps/api/src/modules/identity/native-password-reset-limiter.integration.test.ts",
    ],
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
