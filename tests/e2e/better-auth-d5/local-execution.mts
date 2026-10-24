import { spawn } from "node:child_process";
import { cp, lstat, mkdir, readdir, rm, symlink } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTestDatabaseEnvironment } from "../../../apps/api/src/test/database-environment.ts";
import { resetTestDatabase } from "../../../apps/api/src/test/database-harness.ts";
import { createOwnedSourceCopy } from "../better-auth-integration/source-copy-lifecycle.ts";
import {
  isLocalPostgresReceipt,
  withLocalPostgres,
  verifyLocalPostgresReceipt,
} from "./local-runner.mts";

const source = fileURLToPath(new URL("../../../", import.meta.url));
const excluded = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "coverage",
  "test-results",
  "playwright-report",
  ".turbo",
]);
type LocalMode = "database" | "browser" | "all" | "cutover";
type Options = {
  dockerExecutable: string;
  image: string;
  evidenceDirectory: string;
  configPath: string;
};
type Database = {
  DATABASE_URL: string;
  TEST_DATABASE_URL: string;
  receipt: Parameters<typeof verifyLocalPostgresReceipt>[0];
  signal: AbortSignal;
};

function childEnvironment(database?: Database) {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of [
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
  ]) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  Object.assign(environment, {
    NEXT_TELEMETRY_DISABLED: "1",
    STOCKWISE_API_ORIGIN: "http://127.0.0.1:3203",
  });
  if (database !== undefined) {
    if (
      !isLocalPostgresReceipt(database.receipt) ||
      !verifyLocalPostgresReceipt(
        database.receipt,
        database.DATABASE_URL,
        database.TEST_DATABASE_URL,
      )
    )
      throw new Error("LOCAL_DATABASE_RECEIPT_INVALID");
    Object.assign(environment, {
      DATABASE_URL: database.DATABASE_URL,
      TEST_DATABASE_URL: database.TEST_DATABASE_URL,
      STOCKWISE_ALLOW_STOCKWISE_TEST: "1",
      STOCKWISE_LOCAL_DATABASE_RECEIPT: JSON.stringify(database.receipt),
    });
  }
  return environment;
}

async function run(
  label: string,
  executable: string,
  args: string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal,
) {
  const child = spawn(executable, args, {
    cwd,
    env: environment,
    stdio: "inherit",
    windowsHide: true,
    signal,
  });
  const code = await new Promise<number>((resolveCode, reject) => {
    child.once("error", () => {
      if (child.pid === undefined)
        reject(new Error(`${label} could not start.`));
    });
    child.once("close", (status) => resolveCode(status ?? 1));
  });
  if (code !== 0) throw new Error(`${label} failed with exit code ${code}.`);
}

async function removeOwnedCopy(
  path: string,
  expected: { dev: bigint; ino: bigint },
) {
  const actual = await lstat(path, { bigint: true });
  if (
    !actual.isDirectory() ||
    actual.isSymbolicLink() ||
    actual.dev !== expected.dev ||
    actual.ino !== expected.ino
  )
    throw new Error("Local source-copy ownership changed; cleanup refused.");
  await rm(path, { recursive: true, force: false });
}

async function isolatedCopy() {
  const owned = await createOwnedSourceCopy(resolve(source, ".."));
  const path = owned.path;
  const identity = { dev: owned.device, ino: owned.inode };
  try {
    for (const entry of await readdir(source, { withFileTypes: true })) {
      if (
        (entry.isDirectory() && ["apps", "tests"].includes(entry.name)) ||
        (entry.isFile() && /\.(?:json|ts|mts|mjs|yaml)$/.test(entry.name))
      ) {
        await cp(join(source, entry.name), join(path, entry.name), {
          recursive: true,
          filter(copyPath) {
            const name = basename(copyPath);
            return (
              !excluded.has(name) &&
              !name.toLowerCase().startsWith(".env") &&
              !name.startsWith(".d3") &&
              !name.startsWith(".d4") &&
              !name.startsWith(".stockwise-")
            );
          },
        });
      }
    }
    for (const relative of ["", "apps/api", "apps/web"])
      await symlink(
        join(source, relative, "node_modules"),
        join(path, relative, "node_modules"),
        "junction",
      );
    return { path, identity };
  } catch (error) {
    await removeOwnedCopy(path, identity);
    throw error;
  }
}

export async function executeLocalNative(
  mode: LocalMode,
  options: Options,
): Promise<void> {
  console.log(`LOCAL_NATIVE_RUNTIME_MODE:${mode}`);
  if (mode === "browser" || mode === "all")
    console.log(
      "LOCAL_BROWSER_OPERATOR_FOCUS:NOT_RUN (Journey 08 requires a human Alt+Tab interaction; all other journeys remain enabled.)",
    );
  const checkout = await isolatedCopy();
  try {
    await withLocalPostgres(options, async (database) => {
      const environment = childEnvironment(database);
      const prisma = join(
        checkout.path,
        "apps/api/node_modules/prisma/build/index.js",
      );
      await run(
        "NATIVE_DATABASE_MIGRATIONS",
        process.execPath,
        [prisma, "migrate", "deploy", "--config", "prisma.config.ts"],
        join(checkout.path, "apps/api"),
        { ...environment, DATABASE_URL: database.TEST_DATABASE_URL },
        database.signal,
      );
      if (mode === "cutover") {
        // One-way rehearsal owns this fresh target; never reset it to Legacy.
        try {
          await run(
            "NATIVE_CUTOVER_INTEGRATIONS",
            process.execPath,
            [
              join(checkout.path, "node_modules/vitest/vitest.mjs"),
              "run",
              "--config",
              "vitest.d5-p4-integration-db.config.mts",
            ],
            checkout.path,
            environment,
            database.signal,
          );
        } finally {
          for (const name of [
            "native-cutover-results.json",
            "native-cutover-reconciliation.json",
          ])
            await cp(
              join(checkout.path, "test-results", name),
              join(options.evidenceDirectory, name),
              { errorOnExist: true, force: false },
            );
        }
      }
      if (mode === "database" || mode === "all") {
        try {
          await run(
            "NATIVE_DATABASE_INTEGRATIONS",
            process.execPath,
            [
              join(checkout.path, "node_modules/vitest/vitest.mjs"),
              "run",
              "--config",
              "vitest.better-auth-integration-db.config.mts",
            ],
            checkout.path,
            environment,
            database.signal,
          );
        } finally {
          await mkdir(options.evidenceDirectory, { recursive: true });
          await cp(
            join(checkout.path, "test-results/native-database-results.json"),
            join(options.evidenceDirectory, "native-database-results.json"),
            { errorOnExist: true, force: false },
          );
        }
      }
      if (mode === "all") {
        await resetTestDatabase(
          loadTestDatabaseEnvironment({
            DATABASE_URL: database.DATABASE_URL,
            TEST_DATABASE_URL: database.TEST_DATABASE_URL,
            STOCKWISE_ALLOW_STOCKWISE_TEST: "1",
          }),
        );
        console.log("LOCAL_TEST_DATABASE_RESET:COMPLETE");
      }
      if (mode === "browser" || mode === "all") {
        await run(
          "WEB_BUILD",
          process.execPath,
          [
            join(checkout.path, "apps/web/node_modules/next/dist/bin/next"),
            "build",
            "--webpack",
          ],
          join(checkout.path, "apps/web"),
          childEnvironment(),
          database.signal,
        );
        try {
          await run(
            "NATIVE_BROWSER_JOURNEYS",
            process.execPath,
            [
              join(checkout.path, "node_modules/@playwright/test/cli.js"),
              "test",
              "--config",
              "playwright.better-auth-integration.config.ts",
              "--grep-invert",
              "08 refresh history",
            ],
            checkout.path,
            environment,
            database.signal,
          );
        } finally {
          const report = join(
            checkout.path,
            "test-results/better-auth-integration/operator",
          );
          await mkdir(options.evidenceDirectory, { recursive: true });
          await cp(report, join(options.evidenceDirectory, "native-browser"), {
            recursive: true,
            errorOnExist: true,
            force: false,
          });
        }
      }
      if (mode === "database" || mode === "all") {
        // The irreversible database fence is rehearsed LAST. The owned cluster
        // is destroyed afterward; no trigger disabling or fence reset is used.
        try {
          await run(
            "NATIVE_TRANSITION_INTEGRATIONS",
            process.execPath,
            [
              join(checkout.path, "node_modules/vitest/vitest.mjs"),
              "run",
              "--config",
              "vitest.d5-p3-integration-db.config.mts",
            ],
            checkout.path,
            environment,
            database.signal,
          );
        } finally {
          await cp(
            join(checkout.path, "test-results/native-transition-results.json"),
            join(options.evidenceDirectory, "native-transition-results.json"),
            { errorOnExist: true, force: false },
          );
          await cp(
            join(
              checkout.path,
              "test-results/native-transition-reconciliation.json",
            ),
            join(
              options.evidenceDirectory,
              "native-transition-reconciliation.json",
            ),
            { errorOnExist: true, force: false },
          );
        }
      }
    });
  } finally {
    await removeOwnedCopy(checkout.path, checkout.identity);
  }
}
