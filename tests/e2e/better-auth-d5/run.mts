import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { captureSource, digest } from "./source-contract.mts";
import { readMigrationRepositoryManifest } from "./migration-contract.mts";
import {
  externalManifestPath,
  writeExternalManifest,
} from "./manifest-path.mts";

// Deliberately no execution switch. Resource execution needs independent review and a later task.
const args = process.argv.slice(2);
const [mode, destination] = args;
if (args.length !== 2 || mode !== "manifest" || !destination) {
  console.error(
    "USAGE: node tests/e2e/better-auth-d5/run.mts manifest <absolute-external-json-path>",
  );
  process.exitCode = 2;
} else {
  try {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    const target = externalManifestPath(root, destination);
    const source = await captureSource(root);
    const migrations = await readMigrationRepositoryManifest({
      repositoryRoot: root,
      environment: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
      },
    });
    await writeExternalManifest(
      root,
      target,
      JSON.stringify(
        {
          task: "BETTER-AUTH-D5-P1-A",
          source,
          migrations,
          migrationSha256: digest(JSON.stringify(migrations)),
          execution: "NOT_RUN",
          resourceExecutionAvailableFromCli: false,
        },
        null,
        2,
      ) + "\n",
    );
    console.log("SOURCE_AND_MIGRATION_MANIFEST_RETAINED");
  } catch (error) {
    const unsupported =
      error instanceof Error &&
      [
        "SAFE_SNAPSHOT_UNSUPPORTED_PLATFORM",
        "SAFE_MANIFEST_UNSUPPORTED_PLATFORM",
      ].includes(error.message);
    console.error(
      unsupported
        ? "BLOCKED:SAFE_FILESYSTEM_BOUNDARY_UNSUPPORTED"
        : "MANIFEST_CAPTURE_FAILED",
    );
    process.exitCode = unsupported ? 3 : 1;
  }
}
