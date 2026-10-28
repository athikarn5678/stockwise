import { join } from "node:path";

import { defineConfig, devices } from "@playwright/test";

process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";
// The runner passes its fresh run directory; standalone runs use a fixed one.
const output = process.env.DEMO_OUTPUT_DIR ?? "test-results/demo-acceptance";

// STOCKWISE-DEMO-E2E-01. Requires a running Native browser stack; normally
// started and stopped by `tests/e2e/demo-acceptance/run-demo.mts`.
export default defineConfig({
  testDir: "./tests/e2e/demo-acceptance",
  testMatch: "*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 120_000,
  outputDir: join(output, "playwright"),
  // No HTML report, trace, video or screenshot: they could retain credentials.
  reporter: [["list"], ["json", { outputFile: join(output, "results.json") }]],
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  use: {
    baseURL: "http://localhost:3202",
    actionTimeout: 15_000,
    navigationTimeout: 20_000,
    trace: "off",
    video: "off",
    screenshot: "off",
    acceptDownloads: false,
    serviceWorkers: "block",
  },
});
