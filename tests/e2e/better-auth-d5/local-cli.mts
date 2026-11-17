import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { cleanupPreviousRun } from "./local-cleanup.mts";
import { withLocalPostgres } from "./local-runner.mts";

const inheritedAllowlist = new Set([
  "path",
  "systemroot",
  "windir",
  "temp",
  "tmp",
  "userprofile",
]);
if (
  Object.keys(process.env).some(
    (key) => !inheritedAllowlist.has(key.toLowerCase()),
  )
)
  throw new Error("LOCAL_CHILD_ENVIRONMENT_INVALID");
const path = process.argv[2];
if (!path || !isAbsolute(path)) throw new Error("LOCAL_CONFIG_PATH_REQUIRED");
const config: unknown = JSON.parse(await readFile(path, "utf8"));
if (!config || typeof config !== "object" || Array.isArray(config))
  throw new Error("LOCAL_CONFIG_INVALID");
const values = config as Record<string, unknown>;
const allowed = new Set([
  "mode",
  "dockerExecutable",
  "image",
  "evidenceDirectory",
]);
if (
  Object.keys(values).some((key) => !allowed.has(key)) ||
  typeof values.mode !== "string" ||
  !["database", "browser", "all", "cleanup-previous", "smoke"].includes(
    values.mode,
  ) ||
  typeof values.dockerExecutable !== "string" ||
  !isAbsolute(values.dockerExecutable)
)
  throw new Error("LOCAL_CONFIG_INVALID");
const mode = values.mode as
  "database" | "browser" | "all" | "cleanup-previous" | "smoke";
if (
  typeof values.evidenceDirectory !== "string" ||
  !isAbsolute(values.evidenceDirectory)
)
  throw new Error("LOCAL_CONFIG_INVALID");
if (mode === "cleanup-previous") {
  await cleanupPreviousRun({
    dockerExecutable: values.dockerExecutable,
    evidenceDirectory: values.evidenceDirectory,
  });
  process.stdout.write("Previous disposable PostgreSQL resources removed.\n");
} else {
  if (
    typeof values.image !== "string" ||
    typeof values.evidenceDirectory !== "string" ||
    !isAbsolute(values.evidenceDirectory)
  )
    throw new Error("LOCAL_CONFIG_INVALID");
  if (mode === "smoke") {
    const passed = await withLocalPostgres(
      {
        image: values.image,
        dockerExecutable: values.dockerExecutable,
        evidenceDirectory: values.evidenceDirectory,
      },
      async ({ smoke }) => {
        await smoke();
        return true;
      },
    );
    if (!passed) throw new Error("LOCAL_SMOKE_FAILED");
    process.stdout.write(
      "Local disposable PostgreSQL smoke passed and resources were removed.\n",
    );
  } else {
    const { executeLocalNative } = await import("./local-execution.mts");
    await executeLocalNative(mode, {
      image: values.image,
      dockerExecutable: values.dockerExecutable,
      evidenceDirectory: values.evidenceDirectory,
      configPath: path,
    });
  }
}
