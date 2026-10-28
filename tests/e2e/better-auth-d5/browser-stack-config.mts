import { isAbsolute } from "node:path";

/**
 * Configuration and synthetic fixtures for the test-only Native browser
 * acceptance stack (`browser-stack.mts`). Nothing here is a credential for any
 * real system: every value exists only inside a disposable, receipt-bound
 * PostgreSQL cluster that the launcher creates and destroys.
 */
export const STACK_IMAGE =
  "postgres:16.15-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea";
export const WEB_PORT = 3202;
export const API_PORT = 3203;
export const WEB_ORIGIN = `http://localhost:${WEB_PORT}`;
export const API_ORIGIN = `http://127.0.0.1:${API_PORT}`;

// Signal files inside the output directory (see docs/development/BETTER_AUTH_MIGRATION.md).
export const READY_FILE = "stack-ready.json";
export const STOP_FILE = "stack-stop.txt";
export const RESTART_REQUEST_FILE = "stack-restart-api.txt";
export const RESTART_DONE_FILE = "stack-restarted.txt";

/** Synthetic password of every seeded fixture user. A human types it. */
export const FIXTURE_PASSWORD = "Synthetic browser password 2026!";

// Users without an organization are not Native-enrolled by the accepted cutover
// (INCOMPLETE_ONBOARDING), so onboarding is exercised through registration.
export const FIXTURES = Object.freeze({
  // Verified, onboarded OWNER of "Synthetic Review Store" with branch MAIN.
  owner: "d5br-owner@example.invalid",
  // Verified, onboarded OWNER of a different organization.
  second: "d5br-second@example.invalid",
});

export type StackConfig = Readonly<{
  dockerExecutable: string;
  outputDirectory: string;
  runTimeoutMs: number;
}>;

export class StackConfigError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`BROWSER_STACK_CONFIG_REFUSED:${reason}`);
    this.name = "StackConfigError";
    this.reason = reason;
  }
}

/** The image is pinned by the launcher, never configurable. */
export function parseStackConfig(text: string): StackConfig {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new StackConfigError("NOT_JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new StackConfigError("NOT_OBJECT");
  const input = value as Record<string, unknown>;
  const allowed = new Set([
    "dockerExecutable",
    "outputDirectory",
    "runTimeoutMs",
  ]);
  for (const key of Object.keys(input))
    if (!allowed.has(key)) throw new StackConfigError("UNKNOWN_KEY");
  const { dockerExecutable, outputDirectory } = input;
  if (typeof dockerExecutable !== "string" || !isAbsolute(dockerExecutable))
    throw new StackConfigError("DOCKER_EXECUTABLE_INVALID");
  if (typeof outputDirectory !== "string" || !isAbsolute(outputDirectory))
    throw new StackConfigError("OUTPUT_DIRECTORY_INVALID");
  const runTimeoutMs = input.runTimeoutMs ?? 7_200_000;
  if (
    typeof runTimeoutMs !== "number" ||
    !Number.isInteger(runTimeoutMs) ||
    runTimeoutMs < 300_000 ||
    runTimeoutMs > 14_400_000
  )
    throw new StackConfigError("RUN_TIMEOUT_INVALID");
  return Object.freeze({ dockerExecutable, outputDirectory, runTimeoutMs });
}
