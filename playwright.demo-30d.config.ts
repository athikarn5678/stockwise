import { defineConfig, devices } from "@playwright/test";

// This config only connects to the separately prepared disposable local stack.
export default defineConfig({
  testDir: "./tests/e2e/demo-30d",
  testMatch: "*.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  outputDir: process.env.DEMO30D_BROWSER_OUTPUT ?? "test-results/demo30d",
  reporter: [
    ["list"],
    [
      "json",
      {
        outputFile:
          process.env.DEMO30D_BROWSER_REPORT ??
          "test-results/demo30d-report.json",
      },
    ],
  ],
  use: {
    baseURL: "http://localhost:3230",
    trace: "off",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
