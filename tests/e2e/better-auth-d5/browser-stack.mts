import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import {
  access,
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  createOwnedSourceCopy,
  finalizeOwnedSourceCopy,
} from "../better-auth-integration/source-copy-lifecycle.ts";
import { withLocalPostgres } from "./local-runner.mts";
import {
  cleanupStaleCaptures,
  readRetainedLogs,
  withPrivateCapture,
} from "./browser-capture-store.mts";
import {
  API_ORIGIN,
  API_PORT,
  FIXTURES,
  READY_FILE,
  RESTART_DONE_FILE,
  RESTART_REQUEST_FILE,
  STACK_IMAGE,
  STOP_FILE,
  WEB_ORIGIN,
  WEB_PORT,
  parseStackConfig,
} from "./browser-stack-config.mts";

/**
 * TEST-ONLY launcher: the full StockWise web application and the unmodified
 * `apps/api/src/main.ts` (actual Native API, STOCKWISE_AUTHENTICATION_AUTHORITY
 * =native) on a freshly migrated, seeded and NATIVE-sealed disposable
 * PostgreSQL created by the receipt-bound local runner. Mail is never sent;
 * synthetic `d5br-*@example.invalid` messages are recorded to a JSON-lines
 * file by `browser-mail-capture.mts`. Usage:
 *   node tests/e2e/better-auth-d5/browser-stack.mts <config.json>
 *   node tests/e2e/better-auth-d5/browser-stack.mts --purge-stale <config.json>
 * The capture lives in a private, launcher-created directory that is destroyed
 * when the launcher ends (success, failure, interruption); a hard kill is
 * cleaned by the next start or by --purge-stale.
 * See docs/development/BETTER_AUTH_MIGRATION.md ("Native browser acceptance").
 */
const repositoryRoot = resolve(import.meta.dirname, "../../..");
const excludedNames = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "coverage",
  "test-results",
  "playwright-report",
  ".turbo",
]);
const inheritedVariables = [
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "WINDIR",
  "windir",
  "COMSPEC",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMDATA",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
];

function baseEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of inheritedVariables)
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  return environment;
}

async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function runToCompletion(
  label: string,
  args: string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
) {
  if (interrupted) throw new Error("INTERRUPTED");
  const child = spawn(process.execPath, args, {
    cwd,
    env: environment,
    stdio: "inherit",
    windowsHide: true,
  });
  const code = await new Promise<number>((done, fail) => {
    child.once("error", fail);
    child.once("close", (status) => done(status ?? 1));
  });
  if (code !== 0) throw new Error(`${label} failed with exit code ${code}.`);
}

async function waitFor(url: string, child: ChildProcess, label: string) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${label} exited early.`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_500) });
      if (response.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error(`${label} did not become ready.`);
}

async function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null) return;
  const closed = new Promise((done) => child.once("close", done));
  child.kill();
  await closed;
}

const purgeOnly = process.argv[2] === "--purge-stale";
const configPath = purgeOnly ? process.argv[3] : process.argv[2];
if (!configPath)
  throw new Error("Usage: browser-stack.mts [--purge-stale] <config.json>");
const config = parseStackConfig(await readFile(configPath, "utf8"));
await mkdir(config.outputDirectory, { recursive: true });
if (purgeOnly) {
  const report = cleanupStaleCaptures(config.outputDirectory);
  for (const item of report)
    console.log(`CAPTURE_STALE:${item.status}:${item.name}`);
  if (report.some((item) => item.status !== "REMOVED")) process.exitCode = 1;
  else console.log("CAPTURE_STALE:NONE_OR_REMOVED");
  process.exit();
}
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"] as const)
  process.on(signal, () => {
    interrupted = true;
  });
for (const name of [
  READY_FILE,
  STOP_FILE,
  RESTART_REQUEST_FILE,
  RESTART_DONE_FILE,
])
  await rm(join(config.outputDirectory, name), { force: true });

// Only an absent log (never created) is skipped; any other read error fails the scan.
const retainedLogs = () =>
  readRetainedLogs(config.outputDirectory, ["api.log", "web.log"]);

await withPrivateCapture(
  {
    parent: config.outputDirectory,
    retainedLogs,
    summaryPath: join(config.outputDirectory, "capture-summary.json"),
    report: (line) => console.log(line),
  },
  async (capture) => {
    const captureFile = capture.file;
    const owned = await createOwnedSourceCopy(dirname(repositoryRoot));
    const copy = owned.path;
    let failure: unknown;
    try {
      for (const entry of await readdir(repositoryRoot, {
        withFileTypes: true,
      })) {
        const copyable =
          (entry.isDirectory() && ["apps", "tests"].includes(entry.name)) ||
          (entry.isFile() && /\.(?:json|ts|mts|mjs|yaml)$/.test(entry.name));
        if (!copyable) continue;
        await cp(join(repositoryRoot, entry.name), join(copy, entry.name), {
          recursive: true,
          filter(path) {
            const name = basename(path);
            return (
              !excludedNames.has(name) &&
              !name.toLowerCase().startsWith(".env") &&
              !name.startsWith(".stockwise-")
            );
          },
        });
      }
      for (const directory of ["", "apps/api", "apps/web"])
        await symlink(
          join(repositoryRoot, directory, "node_modules"),
          join(copy, directory, "node_modules"),
          "junction",
        );
      const base = baseEnvironment();
      await runToCompletion(
        "WEB_BUILD",
        [
          join(copy, "apps/web/node_modules/next/dist/bin/next"),
          "build",
          "--webpack",
        ],
        join(copy, "apps/web"),
        {
          ...base,
          STOCKWISE_API_ORIGIN: API_ORIGIN,
          NEXT_TELEMETRY_DISABLED: "1",
        },
      );

      const journal = join(config.outputDirectory, "runner-journal");
      await mkdir(journal, { recursive: true });
      await withLocalPostgres(
        {
          dockerExecutable: config.dockerExecutable,
          image: STACK_IMAGE,
          evidenceDirectory: journal,
          runTimeoutMs: config.runTimeoutMs,
        },
        async (database) => {
          const databaseEnvironment = {
            ...base,
            DATABASE_URL: database.TEST_DATABASE_URL,
            STOCKWISE_ALLOW_STOCKWISE_TEST: "1",
            STOCKWISE_LOCAL_DATABASE_RECEIPT: JSON.stringify(database.receipt),
          };
          await runToCompletion(
            "MIGRATIONS",
            [
              join(copy, "apps/api/node_modules/prisma/build/index.js"),
              "migrate",
              "deploy",
              "--config",
              "prisma.config.ts",
            ],
            join(copy, "apps/api"),
            databaseEnvironment,
          );
          await runToCompletion(
            "SEED_AND_SEAL",
            [join(copy, "tests/e2e/better-auth-d5/browser-stack-seed.mts")],
            copy,
            databaseEnvironment,
          );

          const key = () => randomBytes(32).toString("base64url");
          const apiEnvironment: NodeJS.ProcessEnv = {
            ...databaseEnvironment,
            STOCKWISE_RUNTIME_ENV: "test",
            STOCKWISE_EMAIL_PROVIDER: "non_delivery",
            STOCKWISE_AUTHENTICATION_AUTHORITY: "native",
            STOCKWISE_API_PORT: String(API_PORT),
            STOCKWISE_PUBLIC_WEB_ORIGIN: WEB_ORIGIN,
            STOCKWISE_ANALYTICS_CURSOR_HMAC_KEY: key(),
            STOCKWISE_VERIFICATION_OTP_KEY: key(),
            STOCKWISE_VERIFICATION_OTP_KEY_ID: "1",
            STOCKWISE_VERIFICATION_PROOF_KEY: key(),
            STOCKWISE_VERIFICATION_PROOF_KEY_ID: "1",
            STOCKWISE_BETTER_AUTH_SECRET: key(),
            STOCKWISE_INVITATION_CONTINUATION_KEY: key(),
            STOCKWISE_BROWSER_MAIL_CAPTURE: "synthetic-only",
            STOCKWISE_BROWSER_MAIL_CAPTURE_PRELOAD: "1",
            STOCKWISE_BROWSER_MAIL_CAPTURE_FILE: captureFile,
          };
          const preload = pathToFileURL(
            join(copy, "tests/e2e/better-auth-d5/browser-mail-capture.mts"),
          ).href;
          const logDescriptors: number[] = [];
          const logOf = (name: string) => {
            const descriptor = openSync(
              join(config.outputDirectory, name),
              "a",
            );
            logDescriptors.push(descriptor);
            return descriptor;
          };
          const startApi = () => {
            const log = logOf("api.log");
            return spawn(
              process.execPath,
              ["--import", preload, join(copy, "apps/api/src/main.ts")],
              {
                cwd: join(copy, "apps/api"),
                env: apiEnvironment,
                stdio: ["ignore", log, log],
                windowsHide: true,
              },
            );
          };
          let api: ChildProcess | undefined;
          let web: ChildProcess | undefined;
          try {
            api = startApi();
            await waitFor(`${API_ORIGIN}/health`, api, "API");
            const webLog = logOf("web.log");
            web = spawn(
              process.execPath,
              [
                join(copy, "apps/web/node_modules/next/dist/bin/next"),
                "start",
                "--hostname",
                "127.0.0.1",
                "--port",
                String(WEB_PORT),
              ],
              {
                cwd: join(copy, "apps/web"),
                env: {
                  ...base,
                  STOCKWISE_API_ORIGIN: API_ORIGIN,
                  NEXT_TELEMETRY_DISABLED: "1",
                  NODE_ENV: "production",
                },
                stdio: ["ignore", webLog, webLog],
                windowsHide: true,
              },
            );
            await waitFor(`${WEB_ORIGIN}/login`, web, "Web");
            await writeFile(
              join(config.outputDirectory, READY_FILE),
              `${JSON.stringify(
                {
                  webOrigin: WEB_ORIGIN,
                  apiOrigin: API_ORIGIN,
                  mailCaptureFile: captureFile,
                  fixtures: FIXTURES,
                  authority: "native",
                  mail: "recorded locally for d5br-*@example.invalid only; never delivered; the capture directory is private and is deleted when the stack stops",
                },
                null,
                2,
              )}\n`,
            );
            console.log(`BROWSER_STACK_READY ${WEB_ORIGIN}`);
            const deadline = Date.now() + config.runTimeoutMs - 120_000;
            while (Date.now() < deadline) {
              if (database.signal.aborted) throw new Error("ABORTED");
              if (interrupted) break;
              if (await exists(join(config.outputDirectory, STOP_FILE))) break;
              if (
                await exists(join(config.outputDirectory, RESTART_REQUEST_FILE))
              ) {
                // Same database, keys and capture file; sessions must survive.
                await rm(join(config.outputDirectory, RESTART_REQUEST_FILE));
                await stop(api);
                api = startApi();
                await waitFor(`${API_ORIGIN}/health`, api, "API");
                await writeFile(
                  join(config.outputDirectory, RESTART_DONE_FILE),
                  "API restarted with the same database and keys.\n",
                );
              }
              await new Promise((done) => setTimeout(done, 1_000));
            }
          } finally {
            await stop(web);
            await stop(api);
            for (const descriptor of logDescriptors) closeSync(descriptor);
          }
        },
      );
    } catch (error) {
      failure = error;
    }
    await finalizeOwnedSourceCopy(owned, async () => {}, failure);
  },
);
