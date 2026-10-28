/**
 * TEST-ONLY orchestration for the STOCKWISE-DEMO-E2E-01 runner. Every side
 * effect is an injected dependency so the failure paths are testable without
 * Docker. Once the launcher has been started, teardown (stop request + bounded
 * wait for the launcher's own verified cleanup) and independent cleanup
 * verification always run, whatever failed before them. The runner itself
 * deletes nothing: the launcher owns and removes its database, capture and
 * source copy through the accepted contracts.
 *
 * Failures are reported as `STAGE:CODE` only (an errno/name code, never an
 * error message), so no credential can reach a report through an exception.
 */
export type LauncherHandle = Readonly<{
  /** Exit code once exited, otherwise null. */
  exitCode(): number | null;
  /** Resolves with the exit code, or null if it has not exited within `ms`. */
  waitForExit(ms: number): Promise<number | null>;
}>;

export type TestResult = Readonly<{ title: string; status: string }>;

export type CleanupVerification = Readonly<{
  /** True only when every check below was actually performed and passed. */
  verified: boolean;
  checks: Readonly<Record<string, string | number | boolean>>;
}>;

export type DemoDependencies = Readonly<{
  startLauncher(): LauncherHandle;
  readyFileExists(): boolean;
  /** Idempotent: (re)writes the launcher's stop control file. */
  requestStop(): Promise<void>;
  runPlaywright(signal: AbortSignal): Promise<number>;
  persistPlaywrightLog(): Promise<void>;
  /** Synthetic passwords plus every captured link/token/OTP, read before stop. */
  collectSecrets(): Promise<ReadonlyMap<string, string>>;
  readCapturedKinds(): Promise<Readonly<Record<string, number>>>;
  /** Returns `path:kind` for every secret found in retained outputs. */
  scanOutputs(secrets: ReadonlyMap<string, string>): Promise<string[]>;
  readResults(): Promise<TestResult[]>;
  verifyCleanup(launcherExitCode: number | null): Promise<CleanupVerification>;
  writeSummary(summary: DemoSummary): Promise<void>;
  log(line: string): void;
  sleep(ms: number): Promise<void>;
  now(): number;
}>;

export type DemoTimeouts = Readonly<{
  startupMs: number;
  stopMs: number;
  pollMs: number;
}>;

export const DEFAULT_TIMEOUTS: DemoTimeouts = Object.freeze({
  startupMs: 900_000,
  // The launcher checks its stop file only once ready, after a Next build.
  stopMs: 900_000,
  pollMs: 1_000,
});

export const EXPECTED_JOURNEYS = 4;

export type DemoSummary = {
  task: "STOCKWISE-DEMO-E2E-01";
  authority: "native";
  playwrightExitCode: number | null;
  tests: TestResult[];
  capturedMailKinds: Record<string, number>;
  playwrightOutputLeaks: string[];
  launcherExitCode: number | null;
  /** Execution, validation and reporting failures, original first. */
  failures: string[];
  /** Teardown and verification failures, kept apart from `failures`. */
  cleanupFailures: string[];
  cleanup: CleanupVerification | { verified: false; checks: { state: string } };
  demoGate: "PASS" | "FAIL";
};

/** `STAGE:CODE` with a code from the error's errno code or name only. */
export function failureCode(stage: string, error: unknown): string {
  let code = "UNKNOWN";
  if (error instanceof Error) {
    const errno = (error as NodeJS.ErrnoException).code;
    code =
      typeof errno === "string" && /^[A-Z0-9_]{1,40}$/.test(errno)
        ? errno
        : /^[A-Za-z0-9_]{1,40}$/.test(error.name)
          ? error.name
          : "Error";
  }
  return `${stage}:${code}`;
}

export class DemoInterrupted extends Error {
  constructor() {
    super("DEMO_INTERRUPTED");
    this.name = "DemoInterrupted";
  }
}

/**
 * Runs the demo once. Never throws: every failure lands in the summary and the
 * exit code. `interrupt` aborts the execution phase only; teardown still runs.
 */
export async function runDemo(
  deps: DemoDependencies,
  timeouts: DemoTimeouts = DEFAULT_TIMEOUTS,
  interrupt: AbortSignal = new AbortController().signal,
): Promise<{ exitCode: number; summary: DemoSummary }> {
  const summary: DemoSummary = {
    task: "STOCKWISE-DEMO-E2E-01",
    authority: "native",
    playwrightExitCode: null,
    tests: [],
    capturedMailKinds: {},
    playwrightOutputLeaks: [],
    launcherExitCode: null,
    failures: [],
    cleanupFailures: [],
    cleanup: { verified: false, checks: { state: "NOT_ATTEMPTED" } },
    demoGate: "FAIL",
  };
  const attempt = async <T,>(
    target: string[],
    stage: string,
    step: () => Promise<T>,
  ): Promise<T | undefined> => {
    try {
      return await step();
    } catch (error) {
      target.push(failureCode(stage, error));
      return undefined;
    }
  };

  let launcher: LauncherHandle;
  try {
    launcher = deps.startLauncher();
  } catch (error) {
    // Nothing was acquired by this runner; the launcher never started.
    summary.failures.push(failureCode("LAUNCHER_START", error));
    summary.cleanup = {
      verified: false,
      checks: { state: "NOTHING_ACQUIRED" },
    };
    await attempt(summary.failures, "SUMMARY_WRITE", () =>
      deps.writeSummary(summary),
    );
    deps.log("DEMO_GATE:FAIL");
    return { exitCode: 1, summary };
  }

  let secrets: ReadonlyMap<string, string> = new Map();
  try {
    // ── Execution: any throw here still reaches the finally below. ──
    const deadline = deps.now() + timeouts.startupMs;
    while (!deps.readyFileExists()) {
      if (interrupt.aborted) throw new DemoInterrupted();
      if (launcher.exitCode() !== null)
        throw Object.assign(new Error(), { name: "LAUNCHER_EXITED" });
      if (deps.now() > deadline)
        throw Object.assign(new Error(), { name: "READY_TIMEOUT" });
      await deps.sleep(timeouts.pollMs);
    }
    if (launcher.exitCode() !== null)
      throw Object.assign(new Error(), { name: "LAUNCHER_EXITED" });

    summary.playwrightExitCode =
      (await attempt(summary.failures, "PLAYWRIGHT", () =>
        deps.runPlaywright(interrupt),
      )) ?? null;
    if (interrupt.aborted) throw new DemoInterrupted();
    await attempt(summary.failures, "PLAYWRIGHT_LOG_WRITE", () =>
      deps.persistPlaywrightLog(),
    );
    // Secrets must be read while the capture still exists (before stop).
    const collected = await attempt(summary.failures, "SECRET_COLLECTION", () =>
      deps.collectSecrets(),
    );
    if (collected) secrets = collected;
    summary.capturedMailKinds = {
      ...((await attempt(summary.failures, "CAPTURE_KINDS", () =>
        deps.readCapturedKinds(),
      )) ?? {}),
    };
    summary.tests =
      (await attempt(summary.failures, "RESULTS_READ", () =>
        deps.readResults(),
      )) ?? [];
  } catch (error) {
    summary.failures.push(failureCode("EXECUTION", error));
  } finally {
    // ── Teardown: unconditional once the launcher exists. ──
    const stopDeadline = deps.now() + timeouts.stopMs;
    let exitCode = launcher.exitCode();
    while (exitCode === null && deps.now() <= stopDeadline) {
      // Rewritten each poll: a launcher that has not reached its control loop
      // yet clears a stop file written before it started.
      await attempt(summary.cleanupFailures, "STOP_REQUEST", () =>
        deps.requestStop(),
      );
      exitCode = await launcher.waitForExit(timeouts.pollMs);
    }
    // Keep one STOP_REQUEST failure code per distinct cause.
    summary.cleanupFailures = [...new Set(summary.cleanupFailures)];
    summary.launcherExitCode = exitCode;
    // A nonzero exit may still have cleaned up (e.g. a startup failure); the
    // independent verification below decides cleanup, the exit code fails the run.
    if (exitCode === null)
      summary.cleanupFailures.push("LAUNCHER_STOP:DID_NOT_EXIT");
    else if (exitCode !== 0) summary.failures.push(`LAUNCHER:EXIT_${exitCode}`);
  }

  // The launcher log is final only after exit, so scan once it has ended.
  summary.playwrightOutputLeaks =
    (await attempt(summary.failures, "LEAK_SCAN", () =>
      deps.scanOutputs(secrets),
    )) ?? [];
  if (secrets.size === 0 && !summary.failures.length)
    summary.failures.push("LEAK_SCAN:NO_SECRETS_COLLECTED");
  const verification = await attempt(
    summary.cleanupFailures,
    "CLEANUP_VERIFY",
    () => deps.verifyCleanup(summary.launcherExitCode),
  );
  summary.cleanup = verification ?? {
    verified: false,
    checks: { state: "UNVERIFIED" },
  };
  if (verification && !verification.verified)
    summary.cleanupFailures.push("CLEANUP_VERIFY:NOT_CLEAN");

  const journeysPassed =
    summary.playwrightExitCode === 0 &&
    summary.tests.length === EXPECTED_JOURNEYS &&
    summary.tests.every((test) => test.status === "passed");
  if (!journeysPassed && !summary.failures.length)
    summary.failures.push("VALIDATION:JOURNEYS_NOT_ALL_PASSED");
  if (summary.playwrightOutputLeaks.length)
    summary.failures.push("VALIDATION:OUTPUT_LEAK");
  summary.demoGate =
    journeysPassed &&
    !summary.failures.length &&
    !summary.cleanupFailures.length &&
    summary.cleanup.verified
      ? "PASS"
      : "FAIL";

  // Written last, after teardown, so a report failure can never skip cleanup.
  await attempt(summary.failures, "SUMMARY_WRITE", () =>
    deps.writeSummary(summary),
  );
  if (summary.failures.some((code) => code.startsWith("SUMMARY_WRITE:")))
    summary.demoGate = "FAIL";
  for (const code of summary.failures) deps.log(`DEMO_FAILURE:${code}`);
  for (const code of summary.cleanupFailures)
    deps.log(`DEMO_CLEANUP_FAILURE:${code}`);
  deps.log(`DEMO_CLEANUP_VERIFIED:${summary.cleanup.verified ? "YES" : "NO"}`);
  deps.log(`DEMO_GATE:${summary.demoGate}`);
  return { exitCode: summary.demoGate === "PASS" ? 0 : 1, summary };
}
