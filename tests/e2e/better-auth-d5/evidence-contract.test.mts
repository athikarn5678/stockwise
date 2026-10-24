import assert from "node:assert/strict";
import test from "node:test";
import {
  accountTests,
  fingerprintConfiguration,
  isSafeArtifactPath,
  isSafeLogEvent,
  preservePrimaryFailure,
  validateEvidence,
  validateProcessReceipt,
  type EvidenceInput,
  type StageReceipt,
} from "./evidence-contract.mts";

const hash = "a".repeat(64);
const migrationHash = "b".repeat(64);
const fingerprint = fingerprintConfiguration({
  nodeVersion: "24.21.0",
  pnpmVersion: "11.19.0",
  networkMode: "none",
  uid: 1000,
  gid: 1000,
  pidsLimit: 256,
  scratchMb: 1024,
  workspaceMb: 3072,
  readOnlySource: true,
  lifecycleScripts: false,
  dependencyMode: "offline-frozen",
  nodeMajor: 24,
  platform: "linux",
  architecture: "x64",
  browserEngine: "chromium",
  headless: true,
  locale: "en-US",
  imageDigest: "c".repeat(64),
  sourceHash: hash,
  migrationHash,
  cpuLimit: 2,
  memoryLimitMb: 4096,
  timeoutSeconds: 300,
});
const expected = {
  configFingerprint: fingerprint,
  stageHashes: { "auth-flow": { sourceHash: hash, migrationHash } },
  stageKinds: { "auth-flow": "tests" as const },
  requiredTestIdsByStage: { "auth-flow": ["login-valid", "login-invalid"] },
};
const stage: StageReceipt = {
  stageId: "auth-flow",
  kind: "tests",
  sourceHash: hash,
  migrationHash,
  configFingerprint: fingerprint,
  process: {
    stageId: "auth-flow",
    started: true,
    exitCode: 0,
    signal: null,
    timedOut: false,
  },
  discoveredTestIds: ["login-valid", "login-invalid"],
  results: [
    { id: "login-valid", status: "PASS" },
    { id: "login-invalid", status: "PASS" },
  ],
};
const validEvidence: EvidenceInput = {
  expectedStageIds: ["auth-flow"],
  stages: [stage],
  ownership: { owner: "worker-1", acquired: true },
  fault: { injected: false, owner: "worker-1", faultCode: "NOT_REQUESTED" },
  cleanup: {
    completed: true,
    owner: "worker-1",
    retainedArtifactsRemoved: true,
  },
  artifacts: [
    {
      path: "receipts/stage-auth-flow.json",
      owner: "worker-1",
      retained: true,
    },
  ],
  limitations: ["NO_LIVE_DATABASE", "NO_AUTHORITY_CHANGE"],
};

test("configuration fingerprint ignores unallowlisted secret fields", () => {
  const configuration = {
    nodeVersion: "24.21.0" as const,
    pnpmVersion: "11.19.0" as const,
    networkMode: "none" as const,
    uid: 1000 as const,
    gid: 1000 as const,
    pidsLimit: 256 as const,
    scratchMb: 1024 as const,
    workspaceMb: 3072 as const,
    readOnlySource: true as const,
    lifecycleScripts: false as const,
    dependencyMode: "offline-frozen" as const,
    nodeMajor: 24 as const,
    platform: "linux" as const,
    architecture: "x64" as const,
    browserEngine: "chromium" as const,
    headless: true,
    locale: "en-US" as const,
    imageDigest: "c".repeat(64),
    sourceHash: hash,
    migrationHash,
    cpuLimit: 2 as const,
    memoryLimitMb: 4096 as const,
    timeoutSeconds: 300 as const,
  };
  const extendedConfiguration = { ...configuration, token: "never-hash-this" };
  assert.equal(
    fingerprintConfiguration(extendedConfiguration),
    fingerprintConfiguration(configuration),
  );
});

test("test accounting rejects zero discovery, missing results, duplicates and unexpected results", () => {
  assert.equal(accountTests([], []).success, false);
  assert.equal(
    accountTests(["known"], []).errors.includes("MISSING_TEST_RESULT"),
    true,
  );
  assert.equal(
    accountTests(
      ["known"],
      [
        { id: "known", status: "PASS" },
        { id: "known", status: "PASS" },
      ],
    ).errors.includes("DUPLICATE_TEST"),
    true,
  );
  assert.equal(
    accountTests(["known"], [{ id: "other", status: "PASS" }]).errors.includes(
      "UNEXPECTED_TEST",
    ),
    true,
  );
});

test("required skipped or unrun test results can never succeed", () => {
  for (const status of ["SKIP", "NOT_RUN"] as const) {
    assert.equal(
      accountTests(["required"], [{ id: "required", status }]).success,
      false,
    );
    assert.equal(
      accountTests(["required"], [{ id: "required", status }]).errors.includes(
        "REQUIRED_TEST_NOT_PASSED",
      ),
      true,
    );
  }
});
test("omitting a required test from both discovery and results fails independent expectations", () => {
  assert.equal(
    validateEvidence(validEvidence, "artifacts", expected).success,
    true,
  );
  const omitted = {
    ...stage,
    discoveredTestIds: ["login-valid"],
    results: [{ id: "login-valid", status: "PASS" }] as const,
  };
  const result = validateEvidence(
    { ...validEvidence, stages: [omitted] },
    "artifacts",
    expected,
  );
  assert.equal(result.success, false);
  assert.equal(result.errors.includes("TEST_DISCOVERY_MISMATCH"), true);
});

test("missing exact stage receipts and incomplete process receipts fail", () => {
  const missing = validateEvidence(
    { ...validEvidence, stages: [] },
    "artifacts",
    expected,
  );
  assert.equal(missing.success, false);
  assert.equal(missing.errors.includes("MISSING_STAGE"), true);
  const failedStage = { ...stage, process: { ...stage.process, exitCode: 1 } };
  const childFailure = validateEvidence(
    { ...validEvidence, stages: [failedStage] },
    "artifacts",
    expected,
  );
  assert.equal(childFailure.errors.includes("CHILD_FAILURE"), true);
  const wrongHash = validateEvidence(
    { ...validEvidence, stages: [{ ...stage, sourceHash: "d".repeat(64) }] },
    "artifacts",
    expected,
  );
  assert.equal(wrongHash.errors.includes("HASH_MISMATCH"), true);
  assert.equal(
    validateEvidence(validEvidence, "artifacts", expected).success,
    true,
  );
});

test("start failure, signal and timeout receipts are failures", () => {
  for (const process of [
    { ...stage.process, started: false, exitCode: null },
    { ...stage.process, exitCode: null, signal: "SIGTERM" },
    { ...stage.process, timedOut: true },
  ]) {
    const result = validateEvidence(
      { ...validEvidence, stages: [{ ...stage, process }] },
      "artifacts",
      expected,
    );
    assert.equal(result.success, false);
    assert.equal(result.errors.includes("CHILD_FAILURE"), true);
  }
});
test("process receipt validation requires the exact successful stage receipt shape", () => {
  const receipt = stage.process;
  assert.deepEqual(validateProcessReceipt(receipt, "auth-flow"), {
    success: true,
    errors: [],
  });

  const without = (field: keyof typeof receipt): unknown =>
    Object.fromEntries(
      Object.entries(receipt).filter(([key]) => key !== field),
    );
  const invalidReceipts: readonly unknown[] = [
    undefined,
    null,
    {},
    [],
    without("stageId"),
    without("started"),
    without("exitCode"),
    without("signal"),
    without("timedOut"),
    { ...receipt, stageId: 1 },
    { ...receipt, started: "true" },
    { ...receipt, exitCode: "0" },
    { ...receipt, signal: 0 },
    { ...receipt, timedOut: 0 },
    { ...receipt, stageId: "other-stage" },
    { ...receipt, started: false },
    { ...receipt, exitCode: 1 },
    { ...receipt, exitCode: 0.5 },
    { ...receipt, exitCode: Number.NaN },
    { ...receipt, exitCode: Number.POSITIVE_INFINITY },
    { ...receipt, exitCode: -1 },
    { ...receipt, exitCode: null },
    { ...receipt, signal: "SIGTERM" },
    { ...receipt, timedOut: true },
    { ...receipt, extra: "unexpected" },
  ];
  for (const invalid of invalidReceipts) {
    assert.equal(validateProcessReceipt(invalid, "auth-flow").success, false);
  }
  const failedEvidence = validateEvidence(
    {
      ...validEvidence,
      stages: [{ ...stage, process: { ...receipt, exitCode: 1 } }],
    },
    "artifacts",
    expected,
  );
  assert.equal(failedEvidence.success, false);
  assert.equal(failedEvidence.errors.includes("CHILD_FAILURE"), true);
});
test("process-only stages accept no test accounting and reject fabricated tests", () => {
  const processStage: StageReceipt = {
    ...stage,
    kind: "process",
    discoveredTestIds: [],
    results: [],
  };
  const processExpected = {
    ...expected,
    stageKinds: { "auth-flow": "process" as const },
    requiredTestIdsByStage: { "auth-flow": [] },
  };
  assert.equal(
    validateEvidence(
      { ...validEvidence, stages: [processStage] },
      "artifacts",
      processExpected,
    ).success,
    true,
  );
  const fabricatedTests = validateEvidence(
    {
      ...validEvidence,
      stages: [{ ...processStage, discoveredTestIds: ["login-valid"] }],
    },
    "artifacts",
    processExpected,
  );
  assert.equal(fabricatedTests.success, false);
  assert.equal(
    fabricatedTests.errors.includes("TEST_DISCOVERY_MISMATCH"),
    true,
  );
});

test("cleanup and artifact retention ownership failures are reported", () => {
  const cleanupFailure = validateEvidence(
    {
      ...validEvidence,
      cleanup: {
        ...validEvidence.cleanup,
        completed: false,
        retainedArtifactsRemoved: false,
      },
    },
    "artifacts",
    expected,
  );
  assert.equal(cleanupFailure.errors.includes("CLEANUP_FAILURE"), true);
  const retentionFailure = validateEvidence(
    {
      ...validEvidence,
      artifacts: [{ ...validEvidence.artifacts[0]!, retained: false }],
    },
    "artifacts",
    expected,
  );
  assert.equal(
    retentionFailure.errors.includes("ARTIFACT_OWNERSHIP_FAILURE"),
    true,
  );
});

test("artifact paths reject traversal, absolute paths, URLs, screenshots, traces and storage exports", () => {
  for (const path of [
    "../outside.txt",
    "/tmp/outside.txt",
    "C:/secret.txt",
    "https://host/path",
    "screenshots/login.png",
    "trace.zip",
    "storage.json",
    "receipts/unfiltered.txt",
  ]) {
    assert.equal(isSafeArtifactPath("artifacts", path), false, path);
  }
  assert.equal(
    isSafeArtifactPath("artifacts", "receipts/stage-auth-flow.json"),
    true,
  );
});

test("safe logs accept enumerated codes only and primary failures survive secondary failures", () => {
  assert.equal(isSafeLogEvent({ code: "STAGE_STARTED" }), true);
  assert.equal(
    isSafeLogEvent({ code: "STAGE_STARTED", message: "raw URL" }),
    false,
  );
  assert.deepEqual(
    preservePrimaryFailure("CHILD_FAILURE", [
      "CLEANUP_FAILURE",
      "ARTIFACT_PATH_UNSAFE",
    ]),
    {
      primaryFailure: "CHILD_FAILURE",
      secondaryFailures: ["CLEANUP_FAILURE", "ARTIFACT_PATH_UNSAFE"],
    },
  );
});
