import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// Disabled source-tree entrypoint, not a coordinator service or deployment bootstrap.
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  console.error("BLOCKED:SEPARATELY_ADMINISTERED_LINUX_HOST_REQUIRED");
  process.exitCode = 1;
}
