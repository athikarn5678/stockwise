import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { basename, delimiter, dirname, join, relative } from "node:path";

import { parseCaptureRecords } from "../better-auth-d5/browser-capture-store.mts";
import {
  API_PORT,
  READY_FILE,
  STOP_FILE,
  WEB_PORT,
} from "../better-auth-d5/browser-stack-config.mts";
import type {
  CleanupVerification,
  DemoDependencies,
  LauncherHandle,
  TestResult,
} from "./demo-runner.mts";
import { derivePassword } from "./demo-secrets.mts";

/**
 * Real (host) dependencies of the demo runner. Read-only towards everything
 * the runner did not create: it never deletes a file, directory, container,
 * network, volume or database. The launcher removes what it owns.
 */
export const SOURCE_COPY_PREFIX = ".stockwise-d4n3-";
const CAPTURE_PREFIX = "stack-capture-";
const PASSWORD_LABELS = ["owner", "cashier"] as const;

export function findDocker(argv: readonly string[], path = ""): string {
  const flag = argv.indexOf("--docker");
  const explicit = flag === -1 ? undefined : argv[flag + 1];
  if (explicit) return explicit;
  const name = process.platform === "win32" ? "docker.exe" : "docker";
  for (const directory of path.split(delimiter))
    if (directory && existsSync(join(directory, name)))
      return join(directory, name);
  throw Object.assign(new Error(), { name: "DOCKER_NOT_FOUND" });
}

/** Creates a fresh run directory; refuses (never reuses) an existing one. */
export async function createRunDirectory(parent: string): Promise<string> {
  await mkdir(parent, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const directory = join(
    parent,
    `run-${stamp}-${randomBytes(4).toString("hex")}`,
  );
  await mkdir(directory, { recursive: false });
  await mkdir(join(directory, "stack"), { recursive: false });
  return directory;
}

export type DockerSnapshot = Readonly<{
  containers: readonly string[];
  networks: readonly string[];
  volumes: readonly string[];
}>;

function dockerList(docker: string, args: string[]): string[] {
  const result = spawnSync(docker, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
  });
  if (result.status !== 0)
    throw Object.assign(new Error(), { name: "DOCKER_LIST_FAILED" });
  return result.stdout.split(/\s+/).filter(Boolean).sort();
}

export function dockerSnapshot(docker: string): DockerSnapshot {
  return {
    containers: dockerList(docker, ["ps", "-aq", "--no-trunc"]),
    networks: dockerList(docker, ["network", "ls", "-q", "--no-trunc"]),
    volumes: dockerList(docker, ["volume", "ls", "-q"]),
  };
}

export function newEntries(
  before: readonly string[],
  after: readonly string[],
): string[] {
  const known = new Set(before);
  return after.filter((entry) => !known.has(entry));
}

export async function sourceCopies(parent: string): Promise<string[]> {
  return (await readdir(parent))
    .filter((name) => name.startsWith(SOURCE_COPY_PREFIX))
    .sort();
}

/** True when nothing accepts TCP connections on the port. */
export function portReleased(port: number, host = "127.0.0.1") {
  return new Promise<boolean>((done) => {
    const socket = connect({ port, host });
    socket.setTimeout(2_000);
    socket.once("connect", () => {
      socket.destroy();
      done(false);
    });
    socket.once("timeout", () => {
      socket.destroy();
      done(false);
    });
    socket.once("error", (error: NodeJS.ErrnoException) =>
      done(error.code === "ECONNREFUSED"),
    );
  });
}

type JournalEvent = {
  event?: string;
  kind?: string;
  name?: string;
  cleanup?: string;
};

/** Reads the launcher's runner journal; resources acquired vs removed. */
export async function readRunnerJournal(directory: string) {
  const acquired = new Map<string, string>();
  const removed = new Set<string>();
  const finished: string[] = [];
  const files = existsSync(directory)
    ? (await readdir(directory)).filter((name) => name.endsWith(".jsonl"))
    : [];
  for (const file of files)
    for (const line of (await readFile(join(directory, file), "utf8")).split(
      "\n",
    )) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as JournalEvent;
      if (event.event === "RESOURCE_ACQUIRED" && event.kind && event.name)
        acquired.set(event.name, event.kind);
      if (event.event === "RESOURCE_REMOVED" && event.name)
        removed.add(event.name);
      if (event.event === "RUN_FINISHED") finished.push(event.cleanup ?? "");
    }
  return { runs: files.length, acquired, removed, finished };
}

/** Docker reports the named resource absent (read-only `inspect`). */
export function dockerResourceAbsent(
  docker: string,
  kind: string,
  name: string,
): boolean {
  const result = spawnSync(docker, [kind, "inspect", name], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
  });
  return result.status !== 0 && /no such|not found/i.test(result.stderr ?? "");
}

/** Finds every secret occurrence in retained files; reports `path:kind` only. */
export async function scanForSecrets(
  root: string,
  secrets: ReadonlyMap<string, string>,
): Promise<string[]> {
  const leaks: string[] = [];
  const visit = async (path: string) => {
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      const child = join(path, entry.name);
      // Private captures hold live secrets by design; their removal is
      // verified separately and they are never read or copied here.
      if (entry.isDirectory() && entry.name.startsWith(CAPTURE_PREFIX))
        continue;
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) {
        const text = await readFile(child, "utf8");
        for (const [secret, kind] of secrets)
          if (
            kind.endsWith("-otp")
              ? new RegExp(`(?<![0-9])${secret}(?![0-9])`).test(text)
              : text.includes(secret)
          )
            leaks.push(
              `${relative(root, child).replaceAll("\\", "/")}:${kind}`,
            );
      }
    }
  };
  await visit(root);
  return leaks;
}

export function capturedSecrets(
  captureText: string,
  seed: string,
): { secrets: Map<string, string>; kinds: Record<string, number> } {
  const secrets = new Map<string, string>();
  const kinds: Record<string, number> = {};
  for (const label of PASSWORD_LABELS)
    secrets.set(derivePassword(seed, label), "password");
  for (const record of parseCaptureRecords(captureText)) {
    if ("overflow" in record) continue;
    kinds[record.kind] = (kinds[record.kind] ?? 0) + 1;
    secrets.set(record.url, `${record.kind}-link`);
    const token = new URL(record.url).searchParams.get("token");
    if (token) secrets.set(token, `${record.kind}-token`);
    if (record.code) secrets.set(record.code, `${record.kind}-otp`);
  }
  return { secrets, kinds };
}

type PlaywrightReport = {
  suites?: PlaywrightReport[];
  specs?: { title: string; tests: { results: { status: string }[] }[] }[];
};

export function resultsOf(report: PlaywrightReport): TestResult[] {
  const tests: TestResult[] = [];
  const walk = (suite: PlaywrightReport) => {
    for (const spec of suite.specs ?? [])
      tests.push({
        title: spec.title,
        status: spec.tests[0]?.results.at(-1)?.status ?? "not-run",
      });
    for (const child of suite.suites ?? []) walk(child);
  };
  walk(report);
  return tests;
}

export type HostOptions = Readonly<{
  repositoryRoot: string;
  runDirectory: string;
  docker: string;
  before: Readonly<{ docker: DockerSnapshot; sourceCopies: readonly string[] }>;
}>;

/** Tails `file` to stdout from `position`; returns the new position. */
function echoNew(file: string, position: number): number {
  if (!existsSync(file)) return position;
  const descriptor = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    let read: number;
    while ((read = readSync(descriptor, buffer, 0, buffer.length, position))) {
      process.stdout.write(buffer.subarray(0, read));
      position += read;
    }
  } finally {
    closeSync(descriptor);
  }
  return position;
}

export function createHostDependencies(options: HostOptions): DemoDependencies {
  const { repositoryRoot, runDirectory, docker } = options;
  const stackDirectory = join(runDirectory, "stack");
  const readyFile = join(stackDirectory, READY_FILE);
  const launcherLog = join(runDirectory, "launcher.log");
  const seed = randomBytes(32).toString("hex");
  let playwrightOutput = "";
  let kinds: Record<string, number> = {};

  const lifecycle = async () =>
    existsSync(launcherLog)
      ? (await readFile(launcherLog, "utf8"))
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) =>
            /^(BROWSER_STACK_READY|CAPTURE_[A-Z_]+:|OWNED_SOURCE_COPY_CLEANUP:)/.test(
              line,
            ),
          )
      : [];

  return {
    startLauncher(): LauncherHandle {
      const configPath = join(runDirectory, "stack-config.json");
      // Synchronous so a failure here is a start failure, not a hidden one.
      const config = JSON.stringify({
        dockerExecutable: docker,
        outputDirectory: stackDirectory,
        runTimeoutMs: 1_800_000,
      });
      writeFileSync(configPath, config, { flag: "wx" });
      // Output goes to a file, not a pipe: the launcher must be able to finish
      // its own cleanup even if this runner dies.
      const log = openSync(launcherLog, "a");
      const child = spawn(
        process.execPath,
        [
          join(repositoryRoot, "tests/e2e/better-auth-d5/browser-stack.mts"),
          configPath,
        ],
        { cwd: repositoryRoot, stdio: ["ignore", log, log], windowsHide: true },
      );
      closeSync(log);
      let code: number | null = null;
      let position = 0;
      const tail = setInterval(() => {
        position = echoNew(launcherLog, position);
      }, 500);
      const exited = new Promise<number>((done) => {
        const finish = (status: number | null) => {
          code ??= status ?? 1;
          clearInterval(tail);
          position = echoNew(launcherLog, position);
          done(code);
        };
        child.once("exit", finish);
        child.once("error", () => finish(1));
      });
      return {
        exitCode: () => code,
        waitForExit: (ms) =>
          Promise.race([
            exited,
            new Promise<null>((done) => setTimeout(() => done(null), ms)),
          ]),
      };
    },
    readyFileExists: () => existsSync(readyFile),
    requestStop: () => writeFile(join(stackDirectory, STOP_FILE), "stop\n"),
    runPlaywright(signal) {
      const child = spawn(
        process.execPath,
        [
          join(repositoryRoot, "node_modules/@playwright/test/cli.js"),
          "test",
          "--config",
          "playwright.demo.config.ts",
        ],
        {
          cwd: repositoryRoot,
          env: {
            ...process.env,
            DEMO_STACK_READY_FILE: readyFile,
            DEMO_SECRET_SEED: seed,
            DEMO_OUTPUT_DIR: runDirectory,
          },
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      const abort = () => child.kill();
      signal.addEventListener("abort", abort, { once: true });
      for (const stream of [child.stdout, child.stderr])
        stream.on("data", (chunk: Buffer) => {
          process.stdout.write(chunk);
          playwrightOutput += chunk.toString("utf8");
        });
      return new Promise<number>((done, fail) => {
        child.once("error", fail);
        child.once("close", (status) => {
          signal.removeEventListener("abort", abort);
          done(status ?? 1);
        });
      });
    },
    persistPlaywrightLog: () =>
      writeFile(join(runDirectory, "playwright.log"), playwrightOutput),
    async collectSecrets() {
      const ready = JSON.parse(await readFile(readyFile, "utf8")) as {
        mailCaptureFile: string;
      };
      const result = capturedSecrets(
        await readFile(ready.mailCaptureFile, "utf8"),
        seed,
      );
      kinds = result.kinds;
      return result.secrets;
    },
    readCapturedKinds: async () => kinds,
    scanOutputs: (secrets) => scanForSecrets(runDirectory, secrets),
    async readResults() {
      return resultsOf(
        JSON.parse(await readFile(join(runDirectory, "results.json"), "utf8")),
      );
    },
    async verifyCleanup(launcherExitCode): Promise<CleanupVerification> {
      const lines = await lifecycle();
      const journal = await readRunnerJournal(
        join(stackDirectory, "runner-journal"),
      );
      const notRemoved = [...journal.acquired.keys()].filter(
        (name) => !journal.removed.has(name),
      );
      const stillPresent = [...journal.acquired].filter(
        ([name, kind]) => !dockerResourceAbsent(docker, kind, name),
      );
      const after = dockerSnapshot(docker);
      const copiesAfter = await sourceCopies(dirname(repositoryRoot));
      const captures = (await readdir(stackDirectory)).filter((name) =>
        name.startsWith(CAPTURE_PREFIX),
      );
      const checks = {
        launcherExitCode: launcherExitCode ?? "NOT_EXITED",
        captureLogScan:
          lines.find((line) => line.startsWith("CAPTURE_LOG_SCAN:")) ??
          "MISSING",
        captureCleanup:
          lines.find((line) => line.startsWith("CAPTURE_CLEANUP:")) ??
          "MISSING",
        sourceCopyCleanup:
          lines.find((line) => line.startsWith("OWNED_SOURCE_COPY_CLEANUP:")) ??
          "MISSING",
        captureDirectoriesRemaining: captures.length,
        journalRuns: journal.runs,
        journalResourcesAcquired: journal.acquired.size,
        journalResourcesNotRemoved: notRemoved.length,
        // Vacuously true when the launcher never reached its database; the
        // Docker diff below still catches anything created without a journal.
        journalRunFinishedComplete:
          journal.finished.length === journal.runs &&
          journal.finished.every((value) => value === "COMPLETE"),
        acquiredDockerResourcesStillPresent: stillPresent.length,
        newDockerContainers: newEntries(
          options.before.docker.containers,
          after.containers,
        ).length,
        newDockerNetworks: newEntries(
          options.before.docker.networks,
          after.networks,
        ).length,
        newDockerVolumes: newEntries(
          options.before.docker.volumes,
          after.volumes,
        ).length,
        newSourceCopies: newEntries(options.before.sourceCopies, copiesAfter)
          .length,
        webPortReleased: await portReleased(WEB_PORT),
        apiPortReleased: await portReleased(API_PORT),
      };
      const verified =
        checks.launcherExitCode !== "NOT_EXITED" &&
        checks.captureLogScan === "CAPTURE_LOG_SCAN:CLEAN" &&
        checks.captureCleanup === "CAPTURE_CLEANUP:COMPLETE" &&
        checks.sourceCopyCleanup === "OWNED_SOURCE_COPY_CLEANUP:COMPLETE" &&
        checks.captureDirectoriesRemaining === 0 &&
        checks.journalRunFinishedComplete &&
        checks.journalResourcesNotRemoved === 0 &&
        checks.acquiredDockerResourcesStillPresent === 0 &&
        checks.newDockerContainers === 0 &&
        checks.newDockerNetworks === 0 &&
        checks.newDockerVolumes === 0 &&
        checks.newSourceCopies === 0 &&
        checks.webPortReleased &&
        checks.apiPortReleased;
      return { verified, checks };
    },
    async writeSummary(summary) {
      await writeFile(
        join(runDirectory, "demo-summary.json"),
        `${JSON.stringify(
          {
            ...summary,
            runDirectory: basename(runDirectory),
            finishedAt: new Date().toISOString(),
          },
          null,
          2,
        )}\n`,
        { flag: "wx" },
      );
    },
    log: (line) => console.log(line),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    now: () => Date.now(),
  };
}
