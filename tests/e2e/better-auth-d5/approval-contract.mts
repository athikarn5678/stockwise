import { digest, type SourceEntry } from "./source-contract.mts";
import {
  fingerprintConfiguration,
  type SafeConfiguration,
} from "./evidence-contract.mts";

export interface ApprovedTestManifest {
  sourceSha256: string;
  migrationSha256: string;
  configFingerprint: string;
  requiredTestIds: readonly string[];
}

export interface SafetyApproval {
  version: 1;
  disposition: "ACCEPT";
  executionAuthorization: "D5-P1-B-INFRASTRUCTURE-ONLY";
  owner: string;
  reviewId: string;
  issuedAt: string;
  expiresAt: string;
  toolchainImage: string;
  resolvedImageId: string;
  configuration: SafeConfiguration;
  testManifest: ApprovedTestManifest;
  testManifestSha256: string;
}

// Supplied by the trusted operator from the independent review record, NOT from the candidate bundle.
export interface ApprovalTrust {
  reviewedApprovalSha256: string;
  now: number;
}

export function runnerConfiguration(
  image: string,
  sourceHash: string,
  migrationHash: string,
): SafeConfiguration {
  const imageDigest = image.split("@sha256:")[1];
  if (!imageDigest || !/^[a-f0-9]{64}$/.test(imageDigest))
    throw new Error("PINNED_IMAGE_REQUIRED");
  return {
    nodeMajor: 24,
    platform: "linux",
    architecture: "x64",
    browserEngine: "chromium",
    headless: true,
    locale: "en-US",
    imageDigest,
    sourceHash,
    migrationHash,
    cpuLimit: 2,
    memoryLimitMb: 4096,
    timeoutSeconds: 900,
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
  };
}

export function canonicalTestManifest(manifest: ApprovedTestManifest): string {
  return JSON.stringify({
    sourceSha256: manifest.sourceSha256,
    migrationSha256: manifest.migrationSha256,
    configFingerprint: manifest.configFingerprint,
    requiredTestIds: manifest.requiredTestIds,
  });
}

export function approvalDigest(approval: SafetyApproval): string {
  // The operator pins the exact serialized approval, including configuration, required tests and validity interval.
  return digest(JSON.stringify(approval));
}

export function validateSafetyApproval(
  plan: { owner: string; image: string; sourceSha256: string },
  files: readonly SourceEntry[],
  migrationSha256: string,
  approval: SafetyApproval,
  trust: ApprovalTrust,
): {
  configuration: SafeConfiguration;
  configFingerprint: string;
  requiredTestIds: readonly string[];
} {
  const reject = (): never => {
    throw new Error("INDEPENDENT_REVIEW_APPROVAL_REJECTED");
  };
  if (
    !approval ||
    !trust ||
    !/^[a-f0-9]{64}$/.test(trust.reviewedApprovalSha256) ||
    !Number.isFinite(trust.now) ||
    !files.length ||
    digest(JSON.stringify(files)) !== plan.sourceSha256 ||
    approvalDigest(approval) !== trust.reviewedApprovalSha256 ||
    approval.version !== 1 ||
    approval.disposition !== "ACCEPT" ||
    approval.executionAuthorization !== "D5-P1-B-INFRASTRUCTURE-ONLY" ||
    approval.owner !== plan.owner ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(approval.reviewId) ||
    approval.toolchainImage !== plan.image ||
    !/^sha256:[a-f0-9]{64}$/.test(approval.resolvedImageId)
  )
    reject();
  const issued = Date.parse(approval.issuedAt);
  const expires = Date.parse(approval.expiresAt);
  if (
    !Number.isFinite(issued) ||
    !Number.isFinite(expires) ||
    issued > trust.now ||
    expires <= trust.now ||
    expires <= issued ||
    new Date(issued).toISOString() !== approval.issuedAt ||
    new Date(expires).toISOString() !== approval.expiresAt
  )
    reject();
  const configuration = runnerConfiguration(
    plan.image,
    plan.sourceSha256,
    migrationSha256,
  );
  const configFingerprint = fingerprintConfiguration(configuration);
  // Compare exact settings as well as their safe fingerprint: unknown injected options are not accepted.
  if (
    JSON.stringify(approval.configuration) !== JSON.stringify(configuration) ||
    fingerprintConfiguration(approval.configuration) !== configFingerprint
  )
    reject();
  const manifest = approval.testManifest;
  if (
    !manifest ||
    manifest.sourceSha256 !== plan.sourceSha256 ||
    manifest.migrationSha256 !== migrationSha256 ||
    manifest.configFingerprint !== configFingerprint ||
    !Array.isArray(manifest.requiredTestIds) ||
    manifest.requiredTestIds.length === 0 ||
    manifest.requiredTestIds.length > 10_000 ||
    manifest.requiredTestIds.some(
      (id) => typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id),
    ) ||
    new Set(manifest.requiredTestIds).size !==
      manifest.requiredTestIds.length ||
    JSON.stringify(manifest.requiredTestIds) !==
      JSON.stringify([...manifest.requiredTestIds].sort()) ||
    digest(canonicalTestManifest(manifest)) !== approval.testManifestSha256
  )
    reject();
  return {
    configuration,
    configFingerprint,
    requiredTestIds: Object.freeze([...manifest.requiredTestIds]),
  };
}
