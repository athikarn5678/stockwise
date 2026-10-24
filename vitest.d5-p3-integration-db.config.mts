import { defineConfig } from "vitest/config";

// The D5-P3 coordinator runs this irreversible transition suite last on its owned database.
export default defineConfig({
  test: {
    fileParallelism: false,
    reporters: ["default", "json"],
    outputFile: { json: "test-results/native-transition-results.json" },
    include: [
      "apps/api/src/modules/identity/better-auth-transition.integration.test.ts",
    ],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
