import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  capturedSecrets,
  createHostDependencies,
  createRunDirectory,
  newEntries,
  portReleased,
  readRunnerJournal,
  scanForSecrets,
} from "./demo-runner-host.mts";
import {
  failureCode,
  runDemo,
  type CleanupVerification,
  type DemoDependencies,
  type LauncherHandle,
  type TestResult,
} from "./demo-runner.mts";
import { derivePassword } from "./demo-secrets.mts";

// Synthetic canaries standing in for credentials that must never be reported.
const PASSWORD = "canary-password-Zx9Qw7Lm3Np5Rt1Vb8Kd2Hf6";
const OTP = "482913";
const LINK =
  "http://localhost:3202/verify-email?token=canary-token-Ab3Cd5Ef7Gh9";
const SECRETS = new Map([
  [PASSWORD, "password"],
  [OTP, "verification-otp"],
  [LINK, "verification-link"],
]);
const PASSED: TestResult[] = [1, 2, 3, 4].map((n) => ({
  title: `${n} journey`,
  status: "passed",
}));
const CLEAN: CleanupVerification = { verified: true, checks: { all: true } };
const TIMEOUTS = { startupMs: 10_000, stopMs: 10_000, pollMs: 1_000 };

function errorWith(code: string): Error {
  // Messages carry canaries to prove only codes are ever reported.
  return Object.assign(new Error(`${code} ${PASSWORD} ${OTP} ${LINK}`), {
    code,
  });
}

type Behaviour = {
  launcher?: "normal" | "exits-before-ready" | "ignores-stop" | "never-ready";
  startThrows?: boolean;
  overrides?: Partial<DemoDependencies>;
};

/** Fake host with a simulated clock; records the order of side effects. */
function harness(behaviour: Behaviour = {}) {
  const events: string[] = [];
  const lines: string[] = [];
  let clock = 0;
  let stopped = false;
  let code: number | null = null;
  const mode = behaviour.launcher ?? "normal";
  const launcher: LauncherHandle = {
    exitCode: () => code,
    async waitForExit(ms) {
      if (code === null && stopped && mode !== "ignores-stop") code = 0;
      if (code === null) clock += ms;
      return code;
    },
  };
  const deps: DemoDependencies = {
    startLauncher() {
      events.push("start");
      if (behaviour.startThrows) throw errorWith("ENOENT");
      if (mode === "exits-before-ready") code = 1;
      return launcher;
    },
    readyFileExists: () =>
      mode !== "never-ready" && mode !== "exits-before-ready",
    async requestStop() {
      events.push("stop");
      stopped = true;
    },
    async runPlaywright() {
      events.push("playwright");
      return 0;
    },
    async persistPlaywrightLog() {
      events.push("persist");
    },
    async collectSecrets() {
      events.push("secrets");
      return SECRETS;
    },
    readCapturedKinds: async () => ({ verification: 2, invitation: 1 }),
    async scanOutputs() {
      events.push("scan");
      return [];
    },
    readResults: async () => PASSED,
    async verifyCleanup() {
      events.push("verify");
      return CLEAN;
    },
    async writeSummary() {
      events.push("summary");
    },
    log: (line) => lines.push(line),
    async sleep(ms) {
      clock += ms;
    },
    now: () => clock,
    ...behaviour.overrides,
  };
  return { deps, events, lines };
}

function assertTornDown(events: string[]) {
  const stop = events.indexOf("stop");
  const verify = events.indexOf("verify");
  assert.ok(stop !== -1, "stop must be requested");
  assert.ok(verify > stop, "cleanup must be verified after stop");
  assert.ok(events.indexOf("summary") > verify, "summary is written last");
}

function assertNoCredential(...values: unknown[]) {
  const text = JSON.stringify(values);
  for (const secret of [PASSWORD, OTP, LINK, "canary-token"])
    assert.equal(text.includes(secret), false, "credential leaked");
}

test("a successful demo passes only after stop and verified cleanup", async () => {
  const { deps, events, lines } = harness();
  const { exitCode, summary } = await runDemo(deps, TIMEOUTS);
  assert.equal(exitCode, 0);
  assert.equal(summary.demoGate, "PASS");
  assert.deepEqual(summary.failures, []);
  assert.deepEqual(summary.cleanupFailures, []);
  assert.equal(summary.cleanup.verified, true);
  assertTornDown(events);
  assert.equal(lines.at(-1), "DEMO_GATE:PASS");
});

test("a Playwright journey failure still tears down and fails the gate", async () => {
  const { deps, events } = harness({
    overrides: {
      runPlaywright: async () => 1,
      readResults: async () => [
        ...PASSED.slice(0, 3),
        { title: "4 journey", status: "failed" },
      ],
    },
  });
  const { exitCode, summary } = await runDemo(deps, TIMEOUTS);
  assert.equal(exitCode, 1);
  assert.equal(summary.demoGate, "FAIL");
  assert.deepEqual(summary.failures, ["VALIDATION:JOURNEYS_NOT_ALL_PASSED"]);
  assert.equal(summary.cleanup.verified, true);
  assertTornDown(events);
});

test("an output-write failure (DEMO-F1) cannot bypass teardown", async () => {
  const { deps, events, lines } = harness({
    overrides: {
      async persistPlaywrightLog() {
        events.push("persist");
        throw errorWith("EISDIR");
      },
    },
  });
  const { exitCode, summary } = await runDemo(deps, TIMEOUTS);
  assert.equal(exitCode, 1);
  assert.equal(summary.failures[0], "PLAYWRIGHT_LOG_WRITE:EISDIR");
  assert.equal(summary.cleanup.verified, true);
  assertTornDown(events);
  assert.ok(lines.includes("DEMO_FAILURE:PLAYWRIGHT_LOG_WRITE:EISDIR"));
  assertNoCredential(summary, lines);
});

test("a real EISDIR from the host log writer is caught and cleanup still runs", async () => {
  const parent = await mkdtemp(join(tmpdir(), "demo-runner-"));
  try {
    const runDirectory = await createRunDirectory(parent);
    // Codex's reproduction: a directory where the log file must be written.
    await mkdir(join(runDirectory, "playwright.log"));
    const host = createHostDependencies({
      repositoryRoot: parent,
      runDirectory,
      docker: "unused",
      before: {
        docker: { containers: [], networks: [], volumes: [] },
        sourceCopies: [],
      },
    });
    const { deps, events } = harness({
      overrides: { persistPlaywrightLog: host.persistPlaywrightLog },
    });
    const { exitCode, summary } = await runDemo(deps, TIMEOUTS);
    assert.equal(exitCode, 1);
    assert.equal(summary.failures[0], "PLAYWRIGHT_LOG_WRITE:EISDIR");
    assertTornDown(events);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("read, parse and report failures after the journeys all still tear down", async () => {
  for (const [stage, override] of [
    [
      "SECRET_COLLECTION",
      {
        collectSecrets: async () => {
          throw errorWith("ENOENT");
        },
      },
    ],
    [
      "RESULTS_READ",
      {
        readResults: async () => {
          throw new SyntaxError(PASSWORD);
        },
      },
    ],
    [
      "LEAK_SCAN",
      {
        scanOutputs: async () => {
          throw errorWith("EACCES");
        },
      },
    ],
  ] as const) {
    const { deps, events, lines } = harness({ overrides: override });
    const { exitCode, summary } = await runDemo(deps, TIMEOUTS);
    assert.equal(exitCode, 1, stage);
    assert.ok(summary.failures[0]?.startsWith(`${stage}:`), stage);
    assert.ok(events.includes("stop") && events.includes("verify"), stage);
    assertNoCredential(summary, lines);
  }
  const { deps, events } = harness({
    overrides: {
      async writeSummary() {
        events.push("summary");
        throw errorWith("EACCES");
      },
    },
  });
  const { exitCode, summary } = await runDemo(deps, TIMEOUTS);
  assert.equal(exitCode, 1);
  assert.equal(summary.demoGate, "FAIL");
  assert.deepEqual(summary.failures, ["SUMMARY_WRITE:EACCES"]);
  assertTornDown(events);
});

test("failed validation (leak, missing journey) tears down and fails", async () => {
  const leak = harness({
    overrides: { scanOutputs: async () => ["playwright.log:password"] },
  });
  const leaked = await runDemo(leak.deps, TIMEOUTS);
  assert.equal(leaked.exitCode, 1);
  assert.deepEqual(leaked.summary.failures, ["VALIDATION:OUTPUT_LEAK"]);
  assertTornDown(leak.events);

  const short = harness({
    overrides: { readResults: async () => PASSED.slice(0, 3) },
  });
  const missing = await runDemo(short.deps, TIMEOUTS);
  assert.equal(missing.exitCode, 1);
  assert.deepEqual(missing.summary.failures, [
    "VALIDATION:JOURNEYS_NOT_ALL_PASSED",
  ]);
  assertTornDown(short.events);
});

test("a startup failure after partial acquisition is still verified", async () => {
  const early = harness({ launcher: "exits-before-ready" });
  const exited = await runDemo(early.deps, TIMEOUTS);
  assert.equal(exited.exitCode, 1);
  assert.deepEqual(exited.summary.failures, [
    "EXECUTION:LAUNCHER_EXITED",
    "LAUNCHER:EXIT_1",
  ]);
  assert.ok(early.events.includes("verify"));
  assert.ok(!early.events.includes("playwright"));

  // Still starting at the deadline: stop is requested until it exits.
  const slow = harness({ launcher: "never-ready" });
  const timedOut = await runDemo(slow.deps, TIMEOUTS);
  assert.equal(timedOut.exitCode, 1);
  assert.equal(timedOut.summary.failures[0], "EXECUTION:READY_TIMEOUT");
  assert.equal(timedOut.summary.launcherExitCode, 0);
  assertTornDown(slow.events);
});

test("cleanup failures are reported explicitly and never claimed as success", async () => {
  const stuck = harness({ launcher: "ignores-stop" });
  const hung = await runDemo(stuck.deps, TIMEOUTS);
  assert.equal(hung.exitCode, 1);
  assert.equal(hung.summary.demoGate, "FAIL");
  assert.ok(
    hung.summary.cleanupFailures.includes("LAUNCHER_STOP:DID_NOT_EXIT"),
  );
  assert.ok(
    stuck.lines.includes("DEMO_CLEANUP_FAILURE:LAUNCHER_STOP:DID_NOT_EXIT"),
  );

  const unwritable = harness({
    launcher: "ignores-stop",
    overrides: {
      requestStop: async () => {
        throw errorWith("ENOENT");
      },
    },
  });
  const blocked = await runDemo(unwritable.deps, TIMEOUTS);
  assert.deepEqual(blocked.summary.cleanupFailures, [
    "STOP_REQUEST:ENOENT",
    "LAUNCHER_STOP:DID_NOT_EXIT",
  ]);

  const throwing = harness({
    overrides: {
      verifyCleanup: async () => {
        throw errorWith("EPERM");
      },
    },
  });
  const unverified = await runDemo(throwing.deps, TIMEOUTS);
  assert.equal(unverified.exitCode, 1);
  assert.equal(unverified.summary.cleanup.verified, false);
  assert.deepEqual(unverified.summary.cleanupFailures, [
    "CLEANUP_VERIFY:EPERM",
  ]);
  assert.ok(throwing.lines.includes("DEMO_CLEANUP_VERIFIED:NO"));

  const dirty = harness({
    overrides: {
      verifyCleanup: async () => ({
        verified: false,
        checks: { newDockerVolumes: 1 },
      }),
    },
  });
  const notClean = await runDemo(dirty.deps, TIMEOUTS);
  assert.equal(notClean.exitCode, 1);
  assert.deepEqual(notClean.summary.cleanupFailures, [
    "CLEANUP_VERIFY:NOT_CLEAN",
  ]);
});

test("an original failure and a cleanup failure are both preserved", async () => {
  const { deps, lines } = harness({
    launcher: "ignores-stop",
    overrides: {
      persistPlaywrightLog: async () => {
        throw errorWith("EISDIR");
      },
    },
  });
  const { exitCode, summary } = await runDemo(deps, TIMEOUTS);
  assert.equal(exitCode, 1);
  assert.equal(summary.failures[0], "PLAYWRIGHT_LOG_WRITE:EISDIR");
  assert.ok(summary.cleanupFailures.includes("LAUNCHER_STOP:DID_NOT_EXIT"));
  assert.ok(lines.includes("DEMO_FAILURE:PLAYWRIGHT_LOG_WRITE:EISDIR"));
  assert.ok(lines.includes("DEMO_CLEANUP_FAILURE:LAUNCHER_STOP:DID_NOT_EXIT"));
  assertNoCredential(summary, lines);
});

test("an interruption aborts execution but never teardown", async () => {
  const controller = new AbortController();
  const { deps, events } = harness({
    overrides: {
      async runPlaywright() {
        events.push("playwright");
        controller.abort();
        return 1;
      },
    },
  });
  const { exitCode, summary } = await runDemo(
    deps,
    TIMEOUTS,
    controller.signal,
  );
  assert.equal(exitCode, 1);
  assert.ok(summary.failures.includes("EXECUTION:DemoInterrupted"));
  assertTornDown(events);
});

test("a launcher that cannot start owns nothing and fails without teardown", async () => {
  const { deps, events } = harness({ startThrows: true });
  const { exitCode, summary } = await runDemo(deps, TIMEOUTS);
  assert.equal(exitCode, 1);
  assert.deepEqual(summary.failures, ["LAUNCHER_START:ENOENT"]);
  assert.deepEqual(events, ["start", "summary"]);
  assertNoCredential(summary);
});

test("error reports carry stage and code only, never messages", () => {
  assert.equal(failureCode("X", errorWith("EISDIR")), "X:EISDIR");
  assert.equal(failureCode("X", new Error(PASSWORD)), "X:Error");
  assert.equal(
    failureCode("X", Object.assign(new Error(), { code: `${OTP} ${LINK}` })),
    "X:Error",
  );
  assert.equal(failureCode("X", PASSWORD), "X:UNKNOWN");
});

test("unowned files are never deleted, reused or read through captures", async () => {
  const parent = await mkdtemp(join(tmpdir(), "demo-owned-"));
  try {
    await writeFile(join(parent, "foreign.txt"), "keep");
    await mkdir(join(parent, "run-foreign"));
    await writeFile(join(parent, "run-foreign", "demo-summary.json"), "keep");
    const first = await createRunDirectory(parent);
    const second = await createRunDirectory(parent);
    assert.notEqual(first, second);
    assert.equal(await readFile(join(parent, "foreign.txt"), "utf8"), "keep");
    assert.equal(
      await readFile(join(parent, "run-foreign", "demo-summary.json"), "utf8"),
      "keep",
    );
    // A stale capture directory is skipped by the scan and left untouched.
    const capture = join(first, "stack", "stack-capture-0123");
    await mkdir(capture);
    await writeFile(join(capture, "mail-capture.jsonl"), PASSWORD);
    await writeFile(join(first, "playwright.log"), `ok ${OTP}1 ${PASSWORD}`);
    const leaks = await scanForSecrets(first, SECRETS);
    assert.deepEqual(leaks, ["playwright.log:password"]);
    assert.deepEqual(await readdir(capture), ["mail-capture.jsonl"]);
    assertNoCredential(leaks);
    // Pre-existing Docker resources are never counted as this run's.
    assert.deepEqual(newEntries(["a", "b"], ["a", "b", "c"]), ["c"]);
    assert.deepEqual(newEntries(["a", "b"], ["a"]), []);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("journal, capture and port evidence is read without side effects", async () => {
  const parent = await mkdtemp(join(tmpdir(), "demo-journal-"));
  try {
    const event = (value: object) => `${JSON.stringify(value)}\n`;
    await writeFile(
      join(parent, "owner.jsonl"),
      event({ event: "RESOURCE_ACQUIRED", kind: "volume", name: "v1" }) +
        event({ event: "RESOURCE_ACQUIRED", kind: "container", name: "c1" }) +
        event({ event: "RESOURCE_REMOVED", name: "c1" }) +
        event({ event: "RUN_FINISHED", cleanup: "INCOMPLETE" }),
    );
    const journal = await readRunnerJournal(parent);
    assert.equal(journal.runs, 1);
    assert.deepEqual([...journal.acquired.keys()], ["v1", "c1"]);
    assert.deepEqual([...journal.removed], ["c1"]);
    assert.deepEqual(journal.finished, ["INCOMPLETE"]);
    assert.equal((await readRunnerJournal(join(parent, "absent"))).runs, 0);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }

  const record = (fields: object) => `${JSON.stringify(fields)}\n`;
  const { secrets, kinds } = capturedSecrets(
    record({
      seq: 1,
      at: "2026-10-28T00:00:00.000Z",
      kind: "verification",
      recipient: "d5br-a@example.invalid",
      url: LINK,
      code: OTP,
    }) + record({ overflow: true }),
    "seed",
  );
  assert.deepEqual(kinds, { verification: 1 });
  assert.equal(secrets.get(OTP), "verification-otp");
  assert.equal(secrets.get("canary-token-Ab3Cd5Ef7Gh9"), "verification-token");
  assert.equal(secrets.get(derivePassword("seed", "owner")), "password");
  assert.throws(() => capturedSecrets('{"seq":1', "seed"));

  const server = createServer().listen(0, "127.0.0.1");
  await new Promise((done) => server.once("listening", done));
  const { port } = server.address() as { port: number };
  assert.equal(await portReleased(port), false);
  await new Promise((done) => server.close(done));
  assert.equal(await portReleased(port), true);
});
