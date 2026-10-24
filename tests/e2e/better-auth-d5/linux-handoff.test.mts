import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { digest } from "./source-contract.mts";
import {
  handoffManifestDigest,
  type HandoffManifest,
} from "./handoff-contract.mts";
import {
  validateLinuxFilesystem,
  type LinuxRootPolicy,
  type LinuxFilesystemObservation,
} from "./linux-intake.mts";
import {
  validateLinuxAuthority,
  inspectLinuxExecutionSource,
  receiveLinuxExecutionSource,
  LinuxExecutionSource,
  type LinuxAuthorityAcceptance,
  type HandoffTrust,
} from "./linux-handoff.mts";
import {
  validateWindowsBootstrapDeployment,
  type WindowsBootstrapPin,
  type WindowsBootstrapObservation,
} from "./windows-launch.mts";
import {
  requireDeployedLinuxSeparation,
  validateLinuxSeparationEvidence,
  type LinuxSeparationEvidence,
} from "./linux-separation.mts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const candidateRoot = "D:\\Projects\\stockwise";
const bootstrapPin: WindowsBootstrapPin = {
  root: "C:\\Trusted\\Stockwise",
  nodeExecutable: "C:\\Trusted\\Node\\node.exe",
  nodeExecutableSha256: sha("node"),
  workingDirectory: "C:\\Trusted\\Stockwise",
  entryModule: "boot.mjs",
  invocationMode: "file",
  execArgv: [],
  closure: [
    { path: "boot.mjs", sha256: sha("boot"), imports: ["lib.mjs", "node:fs"] },
    { path: "lib.mjs", sha256: sha("lib"), imports: [] },
  ],
};
const bootstrapObserved = structuredClone({
  root: bootstrapPin.root,
  nodeExecutable: bootstrapPin.nodeExecutable,
  nodeExecutableSha256: bootstrapPin.nodeExecutableSha256,
  workingDirectory: bootstrapPin.workingDirectory,
  entryModule: bootstrapPin.entryModule,
  closure: bootstrapPin.closure,
  invocationMode: bootstrapPin.invocationMode,
  execArgv: bootstrapPin.execArgv,
});
const validateBootstrap = (
  pin: WindowsBootstrapPin | null = bootstrapPin,
  observed: WindowsBootstrapObservation = bootstrapObserved,
  repo = candidateRoot,
) => validateWindowsBootstrapDeployment(pin, observed, repo);

test("independently pinned Windows bootstrap validates exact deployed runtime and complete closure", () => {
  assert.doesNotThrow(() => validateBootstrap());
  assert.throws(() => validateBootstrap(null), /PIN_REQUIRED/);
});

test("bootstrap contract refuses unapproved arguments or inherited loader overrides", () => {
  for (const extra of [
    { arguments: ["--import", "D:\\Projects\\stockwise\\candidate.mts"] },
    { environment: { NODE_OPTIONS: "--import=candidate" } },
  ]) {
    const substituted = { ...bootstrapObserved, ...extra };
    assert.throws(
      () => validateBootstrap(bootstrapPin, substituted),
      /SUBSTITUTED/,
    );
  }
});

test("bootstrap rejects candidate path redirection and malformed Windows paths", () => {
  for (const observed of [
    { ...bootstrapObserved, root: candidateRoot },
    { ...bootstrapObserved, nodeExecutable: `${candidateRoot}\\node.exe` },
    { ...bootstrapObserved, workingDirectory: candidateRoot },
    { ...bootstrapObserved, root: "C:\\Trusted\\Other" },
    { ...bootstrapObserved, nodeExecutable: "\\\\server\\share\\node.exe" },
    { ...bootstrapObserved, nodeExecutable: "C:\\Trusted\\node.exe:stream" },
    { ...bootstrapObserved, workingDirectory: "C:\\Trusted\\..\\Candidate" },
  ])
    assert.throws(
      () => validateBootstrap(bootstrapPin, observed),
      /SUBSTITUTED/,
    );
  const candidatePinned = {
    ...bootstrapPin,
    root: candidateRoot,
    workingDirectory: candidateRoot,
  };
  const candidateObserved = {
    ...bootstrapObserved,
    root: candidateRoot,
    workingDirectory: candidateRoot,
  };
  assert.throws(
    () => validateBootstrap(candidatePinned, candidateObserved),
    /SUBSTITUTED/,
  );
  assert.throws(
    () =>
      validateBootstrap(
        { ...bootstrapPin, workingDirectory: "C:\\Unprotected" },
        { ...bootstrapObserved, workingDirectory: "C:\\Unprotected" },
      ),
    /SUBSTITUTED/,
  );
  assert.throws(
    () =>
      validateBootstrap(
        { ...bootstrapPin, root: "D:\\Projects" },
        { ...bootstrapObserved, root: "D:\\Projects" },
      ),
    /SUBSTITUTED/,
  );
});

test("bootstrap rejects closure substitution, missing/extra files, import aliases, and redirects", () => {
  for (const observed of [
    { ...bootstrapObserved, entryModule: "candidate.mjs" },
    { ...bootstrapObserved, closure: bootstrapObserved.closure.slice(0, 1) },
    {
      ...bootstrapObserved,
      closure: [
        ...bootstrapObserved.closure,
        { path: "extra.mjs", sha256: sha("extra"), imports: [] },
      ],
    },
    {
      ...bootstrapObserved,
      closure: [
        { ...bootstrapObserved.closure[0]!, sha256: sha("changed") },
        bootstrapObserved.closure[1]!,
      ],
    },
    {
      ...bootstrapObserved,
      closure: [
        { ...bootstrapObserved.closure[0]!, imports: ["lib.mjs"] },
        bootstrapObserved.closure[1]!,
      ],
    },
    {
      ...bootstrapObserved,
      closure: [
        { ...bootstrapObserved.closure[0]!, imports: ["./lib.mjs"] },
        bootstrapObserved.closure[1]!,
      ],
    },
    {
      ...bootstrapObserved,
      closure: [
        { ...bootstrapObserved.closure[0]!, imports: ["missing.mjs"] },
        bootstrapObserved.closure[1]!,
      ],
    },
    {
      ...bootstrapObserved,
      closure: [
        { ...bootstrapObserved.closure[0]!, path: "repo:stream" },
        bootstrapObserved.closure[1]!,
      ],
    },
    {
      ...bootstrapObserved,
      closure: [
        { ...bootstrapObserved.closure[0]!, path: "../candidate.mjs" },
        bootstrapObserved.closure[1]!,
      ],
    },
    { ...bootstrapObserved, workingDirectory: "C:\\Candidate" },
    { ...bootstrapObserved, nodeExecutable: "C:\\Candidate\\node.exe" },
    { ...bootstrapObserved, nodeExecutableSha256: sha("candidate-node") },
  ])
    assert.throws(
      () => validateBootstrap(bootstrapPin, observed),
      /SUBSTITUTED/,
    );
});

const filesystem: LinuxRootPolicy = {
  uid: 1001,
  identity: {
    filesystem: "ext4",
    mountId: "31",
    device: "8:32",
    source: "/dev/sdc",
  },
};
const observation: LinuxFilesystemObservation = {
  ...filesystem.identity,
  filesystemMagic: "ef53",
  mountRoot: "/",
  mountPoint: "/",
  uid: 1001,
  mode: 0o700,
  directoryDevice: "8:32",
};
const manifest: HandoffManifest = {
  version: 1,
  sourceFiles: [{ path: "package.json", sha256: digest("{}\r\n") }],
  sizes: { "package.json": 4 },
};
const authority: LinuxAuthorityAcceptance = {
  version: 1,
  decision: "ACCEPT",
  reference: "TEST-ONLY-OWNER-RECEIPT",
  executionAuthority: "VERIFIED_LINUX_RECEIVED_SNAPSHOT_ONLY",
  windowsRepositoryIsSourceOfTruth: true,
  windowsPathProvenanceClaimed: false,
  separateHostId: "linux-host-01",
  linuxUser: "stockwise",
  nativeRoot: "/home/stockwise/rehearsal",
  filesystem,
  sourceSha256: digest(JSON.stringify(manifest.sourceFiles)),
  handoffManifestSha256: handoffManifestDigest(manifest),
  configFingerprint: "a".repeat(64),
  issuedAt: "2026-10-16T00:00:00.000Z",
  expiresAt: "2026-10-17T00:00:00.000Z",
};
const trust: HandoffTrust = {
  ...authority,
  authoritySha256: digest(JSON.stringify(authority)),
  now: Date.parse("2026-10-16T12:00:00.000Z"),
};

test("native ext4 intake accepts pinned identity and rejects wrong device, mount, owner, or permissions", () => {
  assert.doesNotThrow(() => validateLinuxFilesystem(observation, filesystem));
  for (const change of [
    { filesystem: "9p" },
    { mountPoint: "/mnt/d" },
    { mountRoot: "/subtree" },
    { mountId: "32" },
    { device: "8:33" },
    { directoryDevice: "8:33" },
    { mode: 0o777 },
    { uid: 1000 },
    { filesystemMagic: "1234" },
  ])
    assert.throws(
      () => validateLinuxFilesystem({ ...observation, ...change }, filesystem),
      /LINUX_NATIVE_FILESYSTEM_UNSUPPORTED/,
    );
});

test("owner acceptance validates target, identity, hashes, and expiry; missing acceptance stays open", () => {
  assert.doesNotThrow(() => validateLinuxAuthority(authority, manifest, trust));
  assert.throws(
    () => validateLinuxAuthority(null, manifest, trust),
    /LINUX_AUTHORITY_OWNER_ACCEPTANCE_OPEN/,
  );
  for (const change of [
    { authoritySha256: "0".repeat(64) },
    { handoffManifestSha256: "0".repeat(64) },
    { configFingerprint: "b".repeat(64) },
    { now: Date.parse(authority.expiresAt) },
    { now: Date.parse(authority.issuedAt) - 1 },
    { separateHostId: "other-host" },
    { linuxUser: "other-user" },
    { nativeRoot: "/home/other-user/root" },
    { filesystem: { ...filesystem, uid: 1002 } },
  ])
    assert.throws(() =>
      validateLinuxAuthority(authority, manifest, { ...trust, ...change }),
    );
});

test("forged Linux source objects cannot pass WeakMap capability inspection", async () => {
  for (const value of [null, new LinuxExecutionSource()])
    await assert.rejects(
      inspectLinuxExecutionSource(
        value,
        manifest.sourceFiles,
        "a".repeat(64),
        trust.configFingerprint,
      ),
      /VERIFIED_LINUX_EXECUTION_SOURCE_REQUIRED/,
    );
});

const separationEvidence: LinuxSeparationEvidence = {
  version: 1,
  separateHostId: "linux-host-01",
  administrativeBoundary: "INDEPENDENTLY_ADMINISTERED",
  producerIdentity: "WINDOWS\\stockwise-producer",
  protectedHostPrincipals: ["LINUX\\host-owner"],
  producerCapabilities: [],
  producerMayAccessRootOrSudo: false,
  producerMayManageShell: false,
  producerMayAccessDockerOrSocket: false,
  windowsProducerCanManageHost: false,
  producerMayUseWslIdentity: false,
  producerCanManageHypervisor: false,
  producerCanReadPolicy: false,
  producerCanReadOrWriteSnapshots: false,
  producerHasWritableAlias: false,
  transferOnly: true,
  aclEvidenceSha256: sha("ACL evidence"),
};
const separationPin = sha(JSON.stringify(separationEvidence));
test("separation ACL evidence has a positive control but cannot authorize without deployment pin", () => {
  assert.doesNotThrow(() =>
    validateLinuxSeparationEvidence(
      separationEvidence,
      separationPin,
      "linux-host-01",
      "WINDOWS\\stockwise-producer",
    ),
  );
  assert.throws(
    () =>
      validateLinuxSeparationEvidence(
        separationEvidence,
        sha("wrong"),
        "linux-host-01",
        "WINDOWS\\stockwise-producer",
      ),
    /REJECTED/,
  );
  assert.throws(
    () =>
      requireDeployedLinuxSeparation(
        null,
        "linux-host-01",
        "WINDOWS\\stockwise-producer",
      ),
    /SEPARATE_HOST_APPROVAL_MISSING/,
  );
  assert.throws(
    () =>
      requireDeployedLinuxSeparation(
        separationEvidence,
        "linux-host-01",
        "WINDOWS\\stockwise-producer",
      ),
    /NOT_INDEPENDENTLY_PINNED/,
  );
});

test("repinned but unsafe separation claims reject WSL, producer admin, and host access", () => {
  for (const change of [
    { producerMayUseWslIdentity: true },
    { producerIdentity: "LINUX\\host-owner" },
    { windowsProducerCanManageHost: true },
    { producerCanManageHypervisor: true },
    { producerCanReadPolicy: true },
    { producerCanReadOrWriteSnapshots: true },
    { producerHasWritableAlias: true },
    { producerCapabilities: ["docker-socket"] },
    { administrativeBoundary: "WSL_SAME_USER" },
    { protectedHostPrincipals: ["WINDOWS\\stockwise-producer"] },
    { producerMayAccessRootOrSudo: true },
    { producerMayManageShell: true },
    { producerMayAccessDockerOrSocket: true },
  ]) {
    const invalid = {
      ...separationEvidence,
      ...change,
    } as LinuxSeparationEvidence;
    assert.throws(
      () =>
        validateLinuxSeparationEvidence(
          invalid,
          sha(JSON.stringify(invalid)),
          "linux-host-01",
          "WINDOWS\\stockwise-producer",
        ),
      /REJECTED/,
    );
  }
});

test("direct receive rejects absent separation before filesystem acquisition or candidate consumption", async () => {
  const accepted = {
    ...authority,
    issuedAt: "2020-01-01T00:00:00.000Z",
    expiresAt: "2100-01-01T00:00:00.000Z",
  };
  const currentTrust = {
    ...trust,
    authoritySha256: digest(JSON.stringify(accepted)),
  };
  const entry = {
    name: "20260101000000_fixture",
    timestamp: "20260101000000",
    sha256: sha("fixture migration"),
  };
  const migrations = {
    migrations: [entry],
    historical: [entry],
    additions: [],
    lockSha256: sha("fixture lock"),
  };
  function candidate(): AsyncIterable<Uint8Array> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          throw new Error("candidate must not be consumed");
        },
      }),
    };
  }
  await assert.rejects(
    receiveLinuxExecutionSource({
      stream: candidate(),
      manifest,
      acceptance: accepted,
      trust: currentTrust,
      migrations,
      migrationSha256: digest(JSON.stringify(migrations)),
      separationEvidence: null,
      independentlyProvisionedProducerIdentity: "WINDOWS\\stockwise-producer",
    }),
    /SEPARATE_HOST_APPROVAL_MISSING/,
  );
});

test("repinning a blank host identity cannot substitute for an independently selected host", () => {
  const invalidAuthority = { ...authority, separateHostId: "" };
  assert.throws(
    () =>
      validateLinuxAuthority(invalidAuthority, manifest, {
        ...trust,
        separateHostId: "",
        authoritySha256: digest(JSON.stringify(invalidAuthority)),
      }),
    /LINUX_SOURCE_AUTHORITY_REJECTED/,
  );
  const invalidSeparation = { ...separationEvidence, separateHostId: "" };
  assert.throws(
    () =>
      validateLinuxSeparationEvidence(
        invalidSeparation,
        sha(JSON.stringify(invalidSeparation)),
        "",
        separationEvidence.producerIdentity,
      ),
    /LINUX_SEPARATION_EVIDENCE_REJECTED/,
  );
});
