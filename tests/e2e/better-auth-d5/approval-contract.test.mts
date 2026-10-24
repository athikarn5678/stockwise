import assert from "node:assert/strict";
import test from "node:test";
import { digest } from "./source-contract.mts";
import {
  approvalDigest,
  canonicalTestManifest,
  runnerConfiguration,
  validateSafetyApproval,
  type SafetyApproval,
} from "./approval-contract.mts";
import { fingerprintConfiguration } from "./evidence-contract.mts";

const files = [{ path: "package.json", sha256: digest("{}") }];
const owner = "11111111-1111-4111-8111-111111111111";
const image = `stockwise/d5@sha256:${"a".repeat(64)}`;
const sourceSha256 = digest(JSON.stringify(files));
const migrationSha256 = "b".repeat(64);
const plan = { owner, image, sourceSha256 };
const now = Date.parse("2026-10-16T12:00:00.000Z");

function validApproval(): SafetyApproval {
  const configuration = runnerConfiguration(
    image,
    sourceSha256,
    migrationSha256,
  );
  const testManifest = {
    sourceSha256,
    migrationSha256,
    configFingerprint: fingerprintConfiguration(configuration),
    requiredTestIds: ["1".repeat(64), "2".repeat(64)],
  };
  return {
    version: 1,
    disposition: "ACCEPT",
    executionAuthorization: "D5-P1-B-INFRASTRUCTURE-ONLY",
    owner,
    reviewId: "review-01",
    issuedAt: "2026-10-16T11:00:00.000Z",
    expiresAt: "2026-10-16T13:00:00.000Z",
    toolchainImage: image,
    resolvedImageId: `sha256:${"c".repeat(64)}`,
    configuration,
    testManifest,
    testManifestSha256: digest(canonicalTestManifest(testManifest)),
  };
}

function verify(
  approval: SafetyApproval,
  reviewedApprovalSha256 = approvalDigest(approval),
) {
  return validateSafetyApproval(plan, files, migrationSha256, approval, {
    reviewedApprovalSha256,
    now,
  });
}

test("accepts a complete independently pinned source/configuration/test approval", () => {
  const approval = validApproval();
  assert.deepEqual(
    verify(approval).requiredTestIds,
    approval.testManifest.requiredTestIds,
  );
});

test("rejects substituted approval and a reduced required test set despite agreeing execution candidates", () => {
  const approval = validApproval();
  const pin = approvalDigest(approval);
  const reduced = {
    ...approval,
    testManifest: {
      ...approval.testManifest,
      requiredTestIds: ["1".repeat(64)],
    },
  };
  reduced.testManifestSha256 = digest(
    canonicalTestManifest(reduced.testManifest),
  );
  assert.throws(() => verify(reduced, pin), /APPROVAL_REJECTED/);
});

test("rejects expired, future, wrong owner, toolchain and source approvals", () => {
  for (const approval of [
    { ...validApproval(), expiresAt: "2026-10-16T12:00:00.000Z" },
    { ...validApproval(), issuedAt: "2026-10-16T12:01:00.000Z" },
    { ...validApproval(), owner: "22222222-2222-4222-8222-222222222222" },
    {
      ...validApproval(),
      toolchainImage: `stockwise/d5@sha256:${"d".repeat(64)}`,
    },
    { ...validApproval(), resolvedImageId: "mutable-image-tag" },
    {
      ...validApproval(),
      testManifest: {
        ...validApproval().testManifest,
        sourceSha256: "0".repeat(64),
      },
    },
  ])
    assert.throws(() => verify(approval), /APPROVAL_REJECTED/);
});

test("rejects empty duplicate incomplete and configuration-changed reviewed requirements", () => {
  for (const ids of [[], ["1".repeat(64), "1".repeat(64)], [""]]) {
    const approval = validApproval();
    approval.testManifest.requiredTestIds = ids;
    approval.testManifestSha256 = digest(
      canonicalTestManifest(approval.testManifest),
    );
    assert.throws(() => verify(approval), /APPROVAL_REJECTED/);
  }
  const altered = validApproval();
  altered.configuration = { ...altered.configuration, timeoutSeconds: 300 };
  altered.testManifest.configFingerprint = fingerprintConfiguration(
    altered.configuration,
  );
  altered.testManifestSha256 = digest(
    canonicalTestManifest(altered.testManifest),
  );
  assert.throws(() => verify(altered), /APPROVAL_REJECTED/);
});
