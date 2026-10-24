import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const TEST_STATUSES = ["PASS", "FAIL", "SKIP", "NOT_RUN"] as const;
export type TestStatus = (typeof TEST_STATUSES)[number];

export const SAFE_EVENT_CODES = [
  "STAGE_STARTED",
  "STAGE_FINISHED",
  "TEST_PASS",
  "TEST_FAIL",
  "TEST_SKIP",
  "TEST_NOT_RUN",
  "FAULT_INJECTED",
  "CLEANUP_FINISHED",
  "ARTIFACT_RETAINED",
  "ARTIFACT_REMOVED",
  "PROCESS_START_FAILED",
  "PROCESS_TIMED_OUT",
] as const;
export type SafeEventCode = (typeof SAFE_EVENT_CODES)[number];

const CONFIG_FIELDS = [
  "nodeVersion",
  "pnpmVersion",
  "networkMode",
  "uid",
  "gid",
  "pidsLimit",
  "scratchMb",
  "workspaceMb",
  "readOnlySource",
  "lifecycleScripts",
  "dependencyMode",
  "nodeMajor",
  "platform",
  "architecture",
  "browserEngine",
  "headless",
  "locale",
  "imageDigest",
  "sourceHash",
  "migrationHash",
  "cpuLimit",
  "memoryLimitMb",
  "timeoutSeconds",
] as const;
type ConfigField = (typeof CONFIG_FIELDS)[number];
export interface SafeConfiguration {
  readonly nodeVersion: "24.21.0";
  readonly pnpmVersion: "11.19.0";
  readonly networkMode: "none";
  readonly uid: 1000;
  readonly gid: 1000;
  readonly pidsLimit: 256;
  readonly scratchMb: 1024;
  readonly workspaceMb: 3072;
  readonly readOnlySource: true;
  readonly lifecycleScripts: false;
  readonly dependencyMode: "offline-frozen";
  readonly nodeMajor: 18 | 20 | 22 | 24;
  readonly platform: "linux" | "win32" | "darwin";
  readonly architecture: "x64" | "arm64";
  readonly browserEngine: "chromium" | "firefox" | "webkit";
  readonly headless: boolean;
  readonly locale: "en-US" | "en-GB";
  readonly imageDigest: string;
  readonly sourceHash: string;
  readonly migrationHash: string;
  readonly cpuLimit: 1 | 2;
  readonly memoryLimitMb: 2048 | 4096;
  readonly timeoutSeconds: 120 | 300 | 900;
}

export interface TestResult {
  readonly id: string;
  readonly status: TestStatus;
}

export interface ProcessReceipt {
  readonly stageId: string;
  readonly started: boolean;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
}

export type StageKind = "process" | "tests";

export interface StageReceipt {
  readonly stageId: string;
  readonly kind: StageKind;
  readonly sourceHash: string;
  readonly migrationHash: string;
  readonly configFingerprint: string;
  readonly process: ProcessReceipt;
  readonly discoveredTestIds: readonly string[];
  readonly results: readonly TestResult[];
}

export interface OwnershipReceipt {
  readonly owner: string;
  readonly acquired: boolean;
}

export interface FaultReceipt {
  readonly injected: false;
  readonly owner: string;
  readonly faultCode: "NOT_REQUESTED";
}

export interface CleanupReceipt {
  readonly completed: boolean;
  readonly owner: string;
  readonly retainedArtifactsRemoved: boolean;
}

export interface ArtifactReceipt {
  readonly path: string;
  readonly owner: string;
  readonly retained: boolean;
}
export interface ExpectedStageHashes {
  readonly sourceHash: string;
  readonly migrationHash: string;
}

export interface ExpectedEvidenceConfiguration {
  readonly configFingerprint: string;
  readonly stageHashes: Readonly<Record<string, ExpectedStageHashes>>;
  readonly stageKinds: Readonly<Record<string, StageKind>>;
  readonly requiredTestIdsByStage: Readonly<Record<string, readonly string[]>>;
}

export interface EvidenceInput {
  readonly expectedStageIds: readonly string[];
  readonly stages: readonly StageReceipt[];
  readonly ownership: OwnershipReceipt;
  readonly fault: FaultReceipt;
  readonly cleanup: CleanupReceipt;
  readonly artifacts: readonly ArtifactReceipt[];
  readonly limitations: readonly string[];
}

export type EvidenceErrorCode =
  | "INVALID_INPUT"
  | "DUPLICATE_STAGE"
  | "UNEXPECTED_STAGE"
  | "MISSING_STAGE"
  | "INVALID_PROCESS_RECEIPT"
  | "CHILD_FAILURE"
  | "ZERO_DISCOVERED_TESTS"
  | "DUPLICATE_TEST"
  | "UNEXPECTED_TEST"
  | "MISSING_TEST_RESULT"
  | "REQUIRED_TEST_NOT_PASSED"
  | "MISSING_REQUIRED_TESTS"
  | "TEST_DISCOVERY_MISMATCH"
  | "MISSING_HASH"
  | "HASH_MISMATCH"
  | "CONFIG_FINGERPRINT_MISMATCH"
  | "OWNERSHIP_FAILURE"
  | "FAULT_RECEIPT_FAILURE"
  | "CLEANUP_FAILURE"
  | "ARTIFACT_PATH_UNSAFE"
  | "ARTIFACT_OWNERSHIP_FAILURE"
  | "LIMITATIONS_REQUIRED";

export interface EvidenceValidation {
  readonly success: boolean;
  readonly errors: readonly EvidenceErrorCode[];
}

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LIMITATION_CODES = new Set([
  "NO_LIVE_DATABASE",
  "NO_AUTHORITY_CHANGE",
  "NO_BROWSER_STATE_EXPORT",
  "NO_SCREENSHOT_OR_TRACE",
]);
const SAFE_ARTIFACT_PATH =
  /^receipts\/(?:stage-[A-Za-z0-9._-]+\.json|summary\.json|events\.jsonl|manifest\.sha256)$/;
const CONFIG_VALUES: Readonly<
  Partial<Record<ConfigField, ReadonlySet<string | number | boolean>>>
> = {
  nodeVersion: new Set(["24.21.0"]),
  pnpmVersion: new Set(["11.19.0"]),
  networkMode: new Set(["none"]),
  uid: new Set([1000]),
  gid: new Set([1000]),
  pidsLimit: new Set([256]),
  scratchMb: new Set([1024]),
  workspaceMb: new Set([3072]),
  readOnlySource: new Set([true]),
  lifecycleScripts: new Set([false]),
  dependencyMode: new Set(["offline-frozen"]),
  nodeMajor: new Set([18, 20, 22, 24]),
  platform: new Set(["linux", "win32", "darwin"]),
  architecture: new Set(["x64", "arm64"]),
  browserEngine: new Set(["chromium", "firefox", "webkit"]),
  headless: new Set([true, false]),
  locale: new Set(["en-US", "en-GB"]),
  cpuLimit: new Set([1, 2]),
  memoryLimitMb: new Set([2048, 4096]),
  timeoutSeconds: new Set([120, 300, 900]),
};

/** Fingerprints only the fixed, non-secret execution settings and pinned content hashes. */
export function fingerprintConfiguration(
  configuration: SafeConfiguration,
): string {
  if (
    configuration === null ||
    typeof configuration !== "object" ||
    Array.isArray(configuration)
  ) {
    throw new TypeError("Invalid evidence configuration");
  }
  const safe: Partial<Record<ConfigField, string | number | boolean>> = {};
  for (const key of CONFIG_FIELDS) {
    const value = configuration[key];
    const allowed = CONFIG_VALUES[key];
    if (
      value === undefined ||
      (key === "imageDigest" || key === "sourceHash" || key === "migrationHash"
        ? typeof value !== "string" || !SHA256.test(value)
        : !allowed?.has(value))
    )
      throw new TypeError("Invalid evidence configuration");
    safe[key] = value;
  }
  return createHash("sha256").update(JSON.stringify(safe)).digest("hex");
}

/** Validates the exact process receipt required for a successful stage. */
export function validateProcessReceipt(
  receipt: unknown,
  expectedStageId: string,
): EvidenceValidation {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    return { success: false, errors: ["INVALID_PROCESS_RECEIPT"] };
  }
  const process = receipt as Record<string, unknown>;
  const fields = ["stageId", "started", "exitCode", "signal", "timedOut"];
  const prototype = Object.getPrototypeOf(process);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    Reflect.ownKeys(process).length !== fields.length ||
    fields.some(
      (field) => !Object.prototype.hasOwnProperty.call(process, field),
    ) ||
    typeof process.stageId !== "string" ||
    typeof process.started !== "boolean" ||
    (process.exitCode !== null && typeof process.exitCode !== "number") ||
    (process.signal !== null && typeof process.signal !== "string") ||
    typeof process.timedOut !== "boolean"
  ) {
    return { success: false, errors: ["INVALID_PROCESS_RECEIPT"] };
  }
  if (
    process.stageId !== expectedStageId ||
    process.started !== true ||
    process.exitCode !== 0 ||
    process.signal !== null ||
    process.timedOut !== false
  ) {
    return { success: false, errors: ["CHILD_FAILURE"] };
  }
  return { success: true, errors: [] };
}

/** Checks results against discovered IDs; empty discovery and any required non-PASS status fail. */
export function accountTests(
  discoveredIds: readonly string[],
  results: readonly TestResult[],
): EvidenceValidation {
  const errors: EvidenceErrorCode[] = [];
  if (!Array.isArray(discoveredIds) || !Array.isArray(results))
    return { success: false, errors: ["INVALID_INPUT"] };
  if (discoveredIds.length === 0) errors.push("ZERO_DISCOVERED_TESTS");
  const required = new Set<string>();
  for (const id of discoveredIds) {
    if (typeof id !== "string" || !SAFE_ID.test(id) || required.has(id))
      errors.push("DUPLICATE_TEST");
    required.add(id);
  }
  const seen = new Set<string>();
  for (const result of results) {
    if (!result || typeof result.id !== "string" || !required.has(result.id)) {
      errors.push("UNEXPECTED_TEST");
      continue;
    }
    if (seen.has(result.id)) errors.push("DUPLICATE_TEST");
    seen.add(result.id);
    if (!(TEST_STATUSES as readonly string[]).includes(result.status)) {
      errors.push("INVALID_INPUT");
    } else if (result.status !== "PASS") {
      errors.push("REQUIRED_TEST_NOT_PASSED");
    }
  }
  for (const id of required)
    if (!seen.has(id)) errors.push("MISSING_TEST_RESULT");
  return { success: errors.length === 0, errors: [...new Set(errors)] };
}

/** Validates a strict allowlisted event record. Never accepts caller-supplied free-text fields. */
export function isSafeLogEvent(
  value: unknown,
): value is { readonly code: SafeEventCode } {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "code" in value &&
    Object.keys(value).length === 1 &&
    (SAFE_EVENT_CODES as readonly unknown[]).includes(value.code)
  );
}

/** Rejects paths escaping the artifact root, absolute paths, and export-prone artifact formats. */
export function isSafeArtifactPath(
  root: string,
  artifactPath: string,
): boolean {
  if (
    !root ||
    !artifactPath ||
    isAbsolute(artifactPath) ||
    artifactPath.includes("\\") ||
    artifactPath.includes(":")
  )
    return false;
  const normalized = resolve(root, artifactPath);
  const rel = relative(resolve(root), normalized);
  return (
    !!rel &&
    rel !== "." &&
    rel !== ".." &&
    !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel) &&
    SAFE_ARTIFACT_PATH.test(artifactPath)
  );
}

/** Validates receipts against independently supplied expected hashes and a pinned config fingerprint. */
export function validateEvidence(
  input: EvidenceInput,
  artifactRoot: string,
  expected: ExpectedEvidenceConfiguration,
): EvidenceValidation {
  const errors: EvidenceErrorCode[] = [];
  if (
    !input ||
    !Array.isArray(input.expectedStageIds) ||
    !Array.isArray(input.stages) ||
    !Array.isArray(input.artifacts) ||
    !Array.isArray(input.limitations) ||
    !expected ||
    !expected.stageHashes ||
    !expected.stageKinds ||
    !expected.requiredTestIdsByStage ||
    typeof expected.configFingerprint !== "string"
  ) {
    return { success: false, errors: ["INVALID_INPUT"] };
  }
  if (!SHA256.test(expected.configFingerprint)) errors.push("INVALID_INPUT");
  if (input.expectedStageIds.length === 0) errors.push("MISSING_STAGE");
  const expectedStages = new Set<string>();
  for (const stageId of input.expectedStageIds) {
    if (typeof stageId !== "string" || !SAFE_ID.test(stageId))
      errors.push("INVALID_INPUT");
    if (expectedStages.has(stageId)) errors.push("DUPLICATE_STAGE");
    expectedStages.add(stageId);
  }
  const hashStageIds = Object.keys(expected.stageHashes);
  if (
    hashStageIds.length !== expectedStages.size ||
    hashStageIds.some((id) => !expectedStages.has(id))
  )
    errors.push("MISSING_HASH");
  const kindStageIds = Object.keys(expected.stageKinds);
  if (
    kindStageIds.length !== expectedStages.size ||
    kindStageIds.some((id) => !expectedStages.has(id))
  )
    errors.push("INVALID_INPUT");
  const testStageIds = Object.keys(expected.requiredTestIdsByStage);
  if (
    testStageIds.length !== expectedStages.size ||
    testStageIds.some((id) => !expectedStages.has(id))
  )
    errors.push("MISSING_REQUIRED_TESTS");
  const stages = new Set<string>();
  for (const stage of input.stages) {
    if (!stage || typeof stage.stageId !== "string") {
      errors.push("INVALID_INPUT");
      continue;
    }
    if (stages.has(stage.stageId)) errors.push("DUPLICATE_STAGE");
    stages.add(stage.stageId);
    if (!expectedStages.has(stage.stageId)) errors.push("UNEXPECTED_STAGE");

    errors.push(...validateProcessReceipt(stage.process, stage.stageId).errors);
    const expectedHashes = expected.stageHashes[stage.stageId];
    if (
      typeof stage.sourceHash !== "string" ||
      !SHA256.test(stage.sourceHash) ||
      typeof stage.migrationHash !== "string" ||
      !SHA256.test(stage.migrationHash)
    )
      errors.push("MISSING_HASH");
    else if (
      !expectedHashes ||
      stage.sourceHash !== expectedHashes.sourceHash ||
      stage.migrationHash !== expectedHashes.migrationHash
    )
      errors.push("HASH_MISMATCH");
    if (stage.configFingerprint !== expected.configFingerprint)
      errors.push("CONFIG_FINGERPRINT_MISMATCH");
    const expectedKind = expected.stageKinds[stage.stageId];
    if (
      (expectedKind !== "process" && expectedKind !== "tests") ||
      stage.kind !== expectedKind
    )
      errors.push("INVALID_INPUT");
    const expectedTestIds = expected.requiredTestIdsByStage[stage.stageId];
    if (!Array.isArray(expectedTestIds)) {
      errors.push("MISSING_REQUIRED_TESTS");
    } else if (expectedKind === "process") {
      if (expectedTestIds.length !== 0) errors.push("TEST_DISCOVERY_MISMATCH");
      if (
        !Array.isArray(stage.discoveredTestIds) ||
        !Array.isArray(stage.results)
      ) {
        errors.push("INVALID_INPUT");
      } else if (
        stage.discoveredTestIds.length !== 0 ||
        stage.results.length !== 0
      ) {
        errors.push("TEST_DISCOVERY_MISMATCH");
      }
    } else if (expectedTestIds.length === 0) {
      errors.push("MISSING_REQUIRED_TESTS");
    } else if (!Array.isArray(stage.discoveredTestIds)) {
      errors.push("INVALID_INPUT");
    } else {
      const expectedTestSet = new Set(expectedTestIds);
      const discoveredTestSet = new Set(stage.discoveredTestIds);
      if (
        expectedTestSet.size !== expectedTestIds.length ||
        discoveredTestSet.size !== stage.discoveredTestIds.length ||
        expectedTestSet.size !== discoveredTestSet.size ||
        [...expectedTestSet].some((id) => !discoveredTestSet.has(id))
      )
        errors.push("TEST_DISCOVERY_MISMATCH");
      const accounting = accountTests(expectedTestIds, stage.results);
      errors.push(...accounting.errors);
    }
  }
  for (const stageId of expectedStages)
    if (!stages.has(stageId)) errors.push("MISSING_STAGE");
  if (
    !input.ownership?.acquired ||
    !input.ownership.owner ||
    input.ownership.owner !== input.fault?.owner ||
    input.ownership.owner !== input.cleanup?.owner
  )
    errors.push("OWNERSHIP_FAILURE");
  if (
    input.fault?.injected !== false ||
    input.fault.faultCode !== "NOT_REQUESTED"
  )
    errors.push("FAULT_RECEIPT_FAILURE");
  if (!input.cleanup?.completed || !input.cleanup.retainedArtifactsRemoved)
    errors.push("CLEANUP_FAILURE");
  if (input.artifacts.length === 0) errors.push("ARTIFACT_OWNERSHIP_FAILURE");
  for (const artifact of input.artifacts) {
    if (!artifact || !isSafeArtifactPath(artifactRoot, artifact.path))
      errors.push("ARTIFACT_PATH_UNSAFE");
    if (
      !artifact?.owner ||
      artifact.owner !== input.ownership?.owner ||
      !artifact.retained
    )
      errors.push("ARTIFACT_OWNERSHIP_FAILURE");
  }
  if (
    input.limitations.length === 0 ||
    input.limitations.some(
      (code) => typeof code !== "string" || !LIMITATION_CODES.has(code),
    )
  ) {
    errors.push("LIMITATIONS_REQUIRED");
  }
  return { success: errors.length === 0, errors: [...new Set(errors)] };
}

/** First operational failure remains primary; cleanup/evidence errors are supplementary. */
export function preservePrimaryFailure(
  primaryFailure: EvidenceErrorCode | null,
  secondaryFailures: readonly EvidenceErrorCode[],
): {
  readonly primaryFailure: EvidenceErrorCode | null;
  readonly secondaryFailures: readonly EvidenceErrorCode[];
} {
  return { primaryFailure, secondaryFailures: [...secondaryFailures] };
}
