import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  readdir,
  readFile,
  symlink,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createOwnedSourceCopy,
  finalizeOwnedSourceCopy,
} from "./source-copy-lifecycle.ts";

const source = fileURLToPath(new URL("../../../", import.meta.url));
const mode = process.argv[2];
if (
  !["browser", "database", "legacy", "quality", "surface"].includes(mode ?? "")
) {
  throw new Error(
    "Select browser, database, legacy, quality or surface verification.",
  );
}
if (process.env.STOCKWISE_D4N3_ISOLATED !== "1") {
  throw new Error(
    "Explicit D4-N3 isolated execution authorization is required.",
  );
}
const journeyId = process.argv[3];
if (
  journeyId !== undefined &&
  (mode !== "browser" ||
    !/^(?:0[1-9]|1[0-9]|gaps|cache-control)$/.test(journeyId))
)
  throw new Error("Select a numbered journey, gaps, or cache-control.");

// Never let Next, Prisma or a test runner load the regular checkout's local secrets.
const environment: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (
    value !== undefined &&
    /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE)$/i.test(
      key,
    )
  ) {
    environment[key] = value;
  }
}
environment.STOCKWISE_D4N3_ISOLATED = "1";
environment.STOCKWISE_T02A_INTEGRATION_AUTHORIZE =
  "create-new-disposable-t02a-auth-database";
environment.STOCKWISE_API_ORIGIN = "http://127.0.0.1:3203";
environment.NEXT_TELEMETRY_DISABLED = "1";
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, environment);

// Webpack's Windows relative module paths cannot cross a drive boundary.
const ownedSource = await createOwnedSourceCopy(resolve(source, ".."));
const checkout = ownedSource.path;
const exitCodes: Record<string, number> = {};
let executionFailure: unknown;
let retainedEvidence: string | undefined;
let sourceManifest: string | undefined;
const excluded: Record<string, true> = {
  node_modules: true,
  ".git": true,
  ".next": true,
  dist: true,
  coverage: true,
  "test-results": true,
  "playwright-report": true,
  ".turbo": true,
};
async function command(
  label: string,
  executable: string,
  args: string[],
  extra = {},
  directory = checkout,
) {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const child = spawn(executable, args, {
    cwd: directory,
    env: { ...environment, ...extra },
    stdio: "inherit",
    windowsHide: true,
  });
  child.once("error", () => reject(new Error(`${label} could not start.`)));
  child.once("exit", (code) => resolve(code ?? 1));
  const status = await promise;
  exitCodes[label] = status;
  console.log(`${label}_EXIT_CODE:${status}`);
  if (status !== 0) throw new Error(`${label} failed.`);
}
const cli = (name: string, path: string) =>
  join(checkout, "node_modules", name, path);
try {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (
      (entry.isDirectory() && ["apps", "tests"].includes(entry.name)) ||
      (entry.isFile() && /\.(?:json|ts|mts|mjs|yaml)$/.test(entry.name))
    ) {
      await cp(join(source, entry.name), join(checkout, entry.name), {
        recursive: true,
        filter(path) {
          const name = basename(path);
          return (
            !excluded[name] &&
            !name.toLowerCase().startsWith(".env") &&
            !name.startsWith(".d3") &&
            !name.startsWith(".d4")
          );
        },
      });
    }
  }
  for (const relative of ["", "apps/api", "apps/web"]) {
    await symlink(
      join(source, relative, "node_modules"),
      join(checkout, relative, "node_modules"),
      "junction",
    );
  }
  console.log("ISOLATED_SOURCE_COPY:READY NO_ENV_FILES NO_DEPENDENCY_INSTALL");
  if (journeyId === "cache-control") {
    // Deliberately break cache eviction only in the owned, environment-free copy.
    // A failing Journey 16 is required evidence that stale private data is detected.
    const path = join(checkout, "apps/web/src/session-lifecycle.ts");
    const original = await readFile(path, "utf8");
    if (original.split("client.clear();").length !== 2)
      throw new Error("Cache sensitivity control no longer matches source.");
    await writeFile(
      path,
      original.replace(
        "client.clear();",
        "/* sensitivity control: retain stale cache */",
      ),
    );
    console.log("D4_GAPS_CONTROL:OWNED_COPY_CACHE_EVICTION_DISABLED");
  }
  if (mode === "browser" || mode === "surface") {
    if (mode === "browser") {
      const manifestFiles = [
        ...(await readdir(join(checkout, "tests/e2e/better-auth-integration")))
          .filter((name) => /\.(?:ts|mts|json)$/.test(name))
          .map((name) => `tests/e2e/better-auth-integration/${name}`),
        "apps/web/src/api-client.ts",
        "apps/web/src/session-lifecycle.ts",
        "apps/web/src/providers/session-lifecycle-provider.tsx",
        "apps/web/src/components/app-shell.tsx",
        "apps/web/src/components/auth/auth-card.tsx",
        "apps/web/src/components/auth/auth-card-localized.tsx",
        "apps/web/src/components/auth/registration-form.tsx",
        "apps/web/src/components/auth/login-form.tsx",
        "apps/web/src/components/auth/verification-form.tsx",
        "apps/web/src/components/auth/email-request-form.tsx",
        "apps/web/src/components/auth/reset-password-form.tsx",
        "apps/api/src/modules/identity/better-auth-session-repository.ts",
        "apps/api/package.json",
        "apps/web/package.json",
        "package.json",
        "pnpm-lock.yaml",
        "apps/api/prisma/schema.prisma",
        "playwright.better-auth-integration.config.ts",
        "tsconfig.better-auth-integration.json",
        "vitest.better-auth-integration.config.mts",
      ].sort();
      const files = await Promise.all(
        manifestFiles.map(async (path) => ({
          path,
          sha256: createHash("sha256")
            .update(await readFile(join(checkout, path)))
            .digest("hex"),
        })),
      );
      const sha256 = createHash("sha256")
        .update(JSON.stringify(files))
        .digest("hex");
      const evidenceDirectory = join(
        checkout,
        "test-results/better-auth-integration/operator",
      );
      await mkdir(evidenceDirectory, { recursive: true });
      // Playwright clears outputDir before tests; keep the tested-byte snapshot
      // in memory and write it during evidence retention, not before launch.
      sourceManifest = JSON.stringify({ sha256, files }, null, 2);
      console.log(`D4N3_SOURCE_SHA256:${sha256}`);
    }
    await command(
      "WEB_BUILD",
      process.execPath,
      [
        join(checkout, "apps/web/node_modules/next/dist/bin/next"),
        "build",
        "--webpack",
      ],
      {},
      join(checkout, "apps/web"),
    );
    if (mode === "browser") {
      await command("BROWSER", process.execPath, [
        cli("@playwright/test", "cli.js"),
        "test",
        "--config",
        "playwright.better-auth-integration.config.ts",
        ...(journeyId === undefined
          ? []
          : [
              "--grep",
              journeyId === "gaps"
                ? "(?:^| )(?:1[1-6] |a11y )"
                : `(?:^| )${journeyId === "cache-control" ? "16" : journeyId} `,
            ]),
      ]);
    } else {
      const { startHarness } = await import(
        pathToFileURL(
          join(checkout, "tests/e2e/better-auth-integration/runtime.ts"),
        ).href
      );
      const harness = await startHarness();
      try {
        console.log("D4N3_SURFACE_READY");
        const { promise, resolve } = Promise.withResolvers<void>();
        process.stdin.once("data", () => resolve());
        process.stdin.resume();
        await promise;
      } finally {
        process.stdin.pause();
        await harness.stop();
        console.log("OWNED_DATABASE_CLEANUP:COMPLETE");
      }
    }
  } else if (mode === "quality") {
    await command("API_TYPECHECK", process.execPath, [
      cli("typescript", "bin/tsc"),
      "--project",
      "apps/api/tsconfig.json",
      "--noEmit",
    ]);
    await command(
      "WEB_TYPEGEN",
      process.execPath,
      [join(checkout, "apps/web/node_modules/next/dist/bin/next"), "typegen"],
      {},
      join(checkout, "apps/web"),
    );
    await command("WEB_TYPECHECK", process.execPath, [
      cli("typescript", "bin/tsc"),
      "--project",
      "apps/web/tsconfig.json",
      "--noEmit",
    ]);
    await command("HARNESS_TYPECHECK", process.execPath, [
      cli("typescript", "bin/tsc"),
      "--project",
      "tsconfig.better-auth-integration.json",
      "--noEmit",
    ]);
    await command("ESLINT", process.execPath, [
      cli("eslint", "bin/eslint.js"),
      "apps/api",
      "apps/web",
      "tests/e2e/better-auth-integration",
      "playwright.better-auth-integration.config.ts",
      "vitest.better-auth-integration-db.config.mts",
      "vitest.better-auth-integration-legacy.config.mts",
    ]);
    await command("WEB_TESTS", process.execPath, [
      cli("vitest", "vitest.mjs"),
      "run",
      "--config",
      "apps/web/vitest.config.mts",
    ]);
    await command("BETTER_AUTH_DB_FREE", process.execPath, [
      cli("vitest", "vitest.mjs"),
      "run",
      "--config",
      "vitest.better-auth-m1.config.mts",
    ]);
    await command("D3_DB_FREE", process.execPath, [
      cli("vitest", "vitest.mjs"),
      "run",
      "--config",
      "vitest.pending-registration.config.mts",
    ]);
    await command("HARNESS_DB_FREE", process.execPath, [
      cli("vitest", "vitest.mjs"),
      "run",
      "--config",
      "vitest.better-auth-integration.config.mts",
    ]);
  } else {
    const { createOwnedAuthDatabase } = await import(
      pathToFileURL(
        join(checkout, "apps/api/src/test/auth-integration-database.ts"),
      ).href
    );
    const owned = await createOwnedAuthDatabase(environment);
    try {
      await command(
        mode === "database" ? "NATIVE_DATABASE" : "LEGACY_DATABASE",
        process.execPath,
        [
          cli("vitest", "vitest.mjs"),
          "run",
          "--config",
          mode === "database"
            ? "vitest.better-auth-integration-db.config.mts"
            : "vitest.better-auth-integration-legacy.config.mts",
        ],
        owned.environment,
      );
    } finally {
      await owned.cleanup();
      console.log("OWNED_DATABASE_CLEANUP:COMPLETE");
    }
  }
} catch (error) {
  executionFailure = error;
} finally {
  try {
    await finalizeOwnedSourceCopy(
      ownedSource,
      async () => {
        const operatorEvidence = join(
          checkout,
          "test-results/better-auth-integration/operator",
        );
        if (mode === "browser") {
          // Required browser evidence must not be silently treated as absent.
          await stat(operatorEvidence);
          if (sourceManifest === undefined)
            throw new Error("Tested source manifest missing.");
          await writeFile(
            join(operatorEvidence, "tested-source-manifest.json"),
            sourceManifest,
          );
          await writeFile(
            join(operatorEvidence, "execution-result.json"),
            JSON.stringify(
              {
                mode,
                journey: journeyId ?? "all",
                exitCodes,
                executionFailed: executionFailure !== undefined,
              },
              null,
              2,
            ),
          );
          const retained = join(
            "D:/Documents/Notes/10 Projects/StockWise/Implementation Records/Phase 7/Post Phase 7",
            "D4-N3-operator-evidence",
            basename(checkout),
          );
          await mkdir(retained, { recursive: true });
          await cp(operatorEvidence, retained, { recursive: true });
          retainedEvidence = retained;
          console.log(`D4N3_OPERATOR_EVIDENCE:${retained}`);
        }
      },
      executionFailure,
    );
  } catch {
    // Original errors remain in the lifecycle aggregate, but must not expose
    // auth payloads through an unhandled-error stack or stderr.
    process.exitCode = 1;
    console.log("D4N3_RUN:FAILED");
  }
  if (retainedEvidence !== undefined) {
    try {
      await writeFile(
        join(retainedEvidence, "coordinator-exit.json"),
        JSON.stringify(
          {
            exitCode: process.exitCode ?? 0,
          },
          null,
          2,
        ),
      );
    } catch {
      process.exitCode = 1;
      console.log("D4N3_EVIDENCE_RETENTION:FAILED");
    }
  }
}
