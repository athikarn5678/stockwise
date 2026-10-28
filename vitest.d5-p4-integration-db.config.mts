import { defineConfig } from "vitest/config";

// Only the receipt-bound local coordinator supplies this fresh disposable target.
export default defineConfig({
  test: {
    fileParallelism: false,
    reporters: ["default", "json"],
    outputFile: { json: "test-results/native-cutover-results.json" },
    include: [
      "apps/api/src/modules/identity/better-auth-cutover.integration.test.ts",
      "apps/api/src/native-cutover/native-cutover.integration.test.ts",
      // Database-free ownership matrix guarding the suite above.
      "apps/api/src/test/disposable-ownership.test.ts",
    ],
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
