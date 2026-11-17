import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

import { defineConfig, devices } from "@playwright/test";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (testDatabaseUrl === undefined || testDatabaseUrl === "") {
  throw new Error(
    "TEST_DATABASE_URL must be supplied explicitly for destructive test setup. Use a fresh loopback database ending in _test. No database was modified.",
  );
}

function refuseTarget(reason: string): never {
  throw new Error(
    `${reason} Destructive setup was refused. No database was modified.`,
  );
}

// Playwright loads this config separately from E2E global setup. Check before
// web servers start; global setup revalidates through database-environment.ts.
let testUrl: URL;
let testDatabaseName: string;
try {
  testUrl = new URL(testDatabaseUrl);
  testDatabaseName = decodeURIComponent(testUrl.pathname.slice(1));
} catch {
  refuseTarget("TEST_DATABASE_URL must be a valid PostgreSQL URL.");
}

const loopbackHosts = new Set(["127.0.0.1", "[::1]", "localhost"]);
if (testUrl.protocol !== "postgresql:") {
  refuseTarget("TEST_DATABASE_URL must use postgresql://.");
}
if (!loopbackHosts.has(testUrl.hostname)) {
  refuseTarget("TEST_DATABASE_URL must target a loopback host.");
}
if (
  testUrl.searchParams.size > 1 ||
  (testUrl.searchParams.size === 1 &&
    testUrl.searchParams.get("schema") !== "public")
) {
  refuseTarget(
    "TEST_DATABASE_URL query parameters may contain only schema=public.",
  );
}
if (testUrl.hash !== "") {
  refuseTarget("TEST_DATABASE_URL must not contain a fragment.");
}
if (!/^[a-z0-9_]+_test$/.test(testDatabaseName)) {
  refuseTarget("TEST_DATABASE_URL must name a fresh database ending in _test.");
}
const stockwiseTestOptIn = process.env.STOCKWISE_ALLOW_STOCKWISE_TEST;
if (stockwiseTestOptIn !== undefined && stockwiseTestOptIn !== "1") {
  refuseTarget("STOCKWISE_ALLOW_STOCKWISE_TEST accepts only 1.");
}
if (testDatabaseName === "stockwise_test" && stockwiseTestOptIn !== "1") {
  refuseTarget(
    "stockwise_test is refused by default; use a fresh *_test database.",
  );
}

let runtimeDatabaseUrl = process.env.DATABASE_URL;
const runtimeEnvironmentFile = resolve(process.cwd(), ".env");
if (runtimeDatabaseUrl === undefined && existsSync(runtimeEnvironmentFile)) {
  try {
    runtimeDatabaseUrl = parseEnv(
      readFileSync(runtimeEnvironmentFile, "utf8"),
    ).DATABASE_URL;
  } catch {
    refuseTarget("API DATABASE_URL cannot be compared.");
  }
}
if (runtimeDatabaseUrl !== undefined) {
  if (!URL.canParse(runtimeDatabaseUrl)) {
    refuseTarget("API DATABASE_URL cannot be compared.");
  }
  const runtimeUrl = new URL(runtimeDatabaseUrl);
  if (runtimeUrl.protocol !== "postgresql:") {
    refuseTarget("API DATABASE_URL cannot be compared.");
  }
  let runtimeDatabaseName: string;
  try {
    runtimeDatabaseName = decodeURIComponent(runtimeUrl.pathname.slice(1));
  } catch {
    refuseTarget("API DATABASE_URL cannot be compared.");
  }
  const runtimeHost = (
    runtimeUrl.searchParams.get("host") ?? runtimeUrl.hostname
  ).toLowerCase();
  const runtimePort =
    Number.parseInt(
      (runtimeUrl.searchParams.get("port") ?? runtimeUrl.port) || "5432",
      10,
    ) || 5432;
  if (
    loopbackHosts.has(runtimeHost === "::1" ? "[::1]" : runtimeHost) &&
    runtimePort === Number(testUrl.port || "5432") &&
    runtimeDatabaseName === testDatabaseName
  ) {
    refuseTarget("TEST_DATABASE_URL must not equal the API DATABASE_URL.");
  }
}

// One throwaway secret per run unless the operator supplied one. It stays in
// process memory only: never printed, logged or written to disk.
const betterAuthSecret =
  process.env.STOCKWISE_BETTER_AUTH_SECRET ??
  randomBytes(32).toString("base64url");

export default defineConfig({
  forbidOnly: Boolean(process.env.CI),
  globalSetup: "./tests/e2e/catalog-global-setup.mts",
  globalTeardown: "./tests/e2e/catalog-global-teardown.mts",
  outputDir: "test-results",
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  reporter: process.env.CI ? "github" : "list",
  testDir: "./tests/e2e",
  timeout: 30_000,
  use: {
    baseURL: "http://localhost:3000",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  webServer: [
    {
      command: "pnpm start:api",
      env: {
        ...process.env,
        DATABASE_URL: testDatabaseUrl,
        STOCKWISE_API_PORT: "3001",
        STOCKWISE_BETTER_AUTH_SECRET: betterAuthSecret,
        STOCKWISE_PUBLIC_WEB_ORIGIN: "http://localhost:3000",
        STOCKWISE_RUNTIME_ENV: "test",
      },
      reuseExistingServer: false,
      timeout: 120_000,
      url: "http://127.0.0.1:3001/ready",
    },
    {
      command: "pnpm dev:web",
      env: {
        ...process.env,
        STOCKWISE_API_ORIGIN: "http://127.0.0.1:3001",
      },
      reuseExistingServer: false,
      timeout: 120_000,
      url: "http://localhost:3000/api/health",
    },
  ],
  workers: 1,
});
