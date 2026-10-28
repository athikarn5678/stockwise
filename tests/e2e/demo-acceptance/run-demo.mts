import { dirname, join, resolve } from "node:path";

import {
  createHostDependencies,
  createRunDirectory,
  dockerSnapshot,
  findDocker,
  sourceCopies,
} from "./demo-runner-host.mts";
import { failureCode, runDemo } from "./demo-runner.mts";

/**
 * TEST-ONLY runner for STOCKWISE-DEMO-E2E-01. It starts the accepted Native
 * browser stack (`browser-stack.mts`: full Next.js + unmodified Native API on
 * a receipt-owned disposable PostgreSQL with controlled non-delivery mail
 * capture), runs `playwright.demo.config.ts` against it, scans every retained
 * output for the run's synthetic passwords and captured OTPs/links, then always
 * stops the stack and independently verifies its cleanup.
 *   node tests/e2e/demo-acceptance/run-demo.mts [--docker <abs docker.exe>]
 * Each run writes only to a fresh test-results/demo-acceptance/run-* directory.
 * Exit code 0 only when the journeys pass and every cleanup check passes.
 */
const repositoryRoot = resolve(import.meta.dirname, "../../..");

const interrupt = new AbortController();
for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"] as const)
  process.on(signal, () => interrupt.abort());

let options: Parameters<typeof createHostDependencies>[0];
try {
  // Nothing is acquired before the launcher starts; a failure here owns nothing.
  const docker = findDocker(process.argv, process.env.PATH);
  const runDirectory = await createRunDirectory(
    join(repositoryRoot, "test-results/demo-acceptance"),
  );
  options = {
    repositoryRoot,
    runDirectory,
    docker,
    before: {
      docker: dockerSnapshot(docker),
      sourceCopies: await sourceCopies(dirname(repositoryRoot)),
    },
  };
  console.log(`DEMO_RUN_DIRECTORY:${runDirectory}`);
} catch (error) {
  console.log(`DEMO_FAILURE:${failureCode("SETUP", error)}`);
  console.log("DEMO_GATE:FAIL");
  process.exit(1);
}

const { exitCode, summary } = await runDemo(
  createHostDependencies(options),
  undefined,
  interrupt.signal,
);
if (summary.cleanupFailures.includes("LAUNCHER_STOP:DID_NOT_EXIT"))
  console.log(
    "DEMO_CLEANUP_ACTION: the launcher is still running and will clean up at its own run deadline; afterwards run browser-stack.mts --purge-stale <run>/stack-config.json",
  );
process.exit(exitCode);
