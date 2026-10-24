import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  allowedSourcePath,
  assertSourceMatch,
  digest,
  hashSourceFiles,
} from "./source-contract.mts";
import { createRunnerPlan, executeInfrastructure } from "./runner.mts";
import report from "./node-reporter.mts";
import {
  runnerConfiguration,
  canonicalTestManifest,
  type SafetyApproval,
} from "./approval-contract.mts";
import { fingerprintConfiguration } from "./evidence-contract.mts";

const files = [{ path: "package.json", sha256: digest("{}") }];
const image = `stockwise/d5-toolchain@sha256:${"a".repeat(64)}`;

test("rejects mutable toolchain tags and missing source inventory", () => {
  assert.throws(() => createRunnerPlan("node:24", files));
  assert.throws(() => createRunnerPlan(image, []));
});

test("refuses resource execution without matched independent approval before any resource command", async () => {
  const plan = createRunnerPlan(image, files);
  const migrationSha256 = "b".repeat(64);
  const configuration = runnerConfiguration(
    image,
    plan.sourceSha256,
    migrationSha256,
  );
  const testManifest = {
    sourceSha256: plan.sourceSha256,
    migrationSha256,
    configFingerprint: fingerprintConfiguration(configuration),
    requiredTestIds: ["1".repeat(64)],
  };
  const approval: SafetyApproval = {
    version: 1,
    disposition: "ACCEPT",
    executionAuthorization: "D5-P1-B-INFRASTRUCTURE-ONLY",
    owner: plan.owner,
    reviewId: "review-01",
    issuedAt: "2020-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    toolchainImage: image,
    resolvedImageId: `sha256:${"c".repeat(64)}`,
    configuration,
    testManifest,
    testManifestSha256: digest(canonicalTestManifest(testManifest)),
  };
  await assert.rejects(
    executeInfrastructure(
      plan,
      files,
      null,
      approval,
      { reviewedApprovalSha256: "0".repeat(64), now: 0 },
      async () => {
        throw new Error("must not retain resources");
      },
    ),
    /INDEPENDENT_REVIEW_APPROVAL_REJECTED/,
  );
});

test("rejects secret, generated, dependency and escaping paths from source input", () => {
  for (const path of [
    ".env",
    "apps/api/.ENV.local",
    "apps/api/node_modules/pg/package.json",
    "apps/api/src/generated/prisma/client.ts",
    "../package.json",
    "apps/api/../../secret.json",
    "apps\\api\\package.json",
    "apps/api/.d3-owned/config.yaml",
    "-invalid.json",
  ])
    assert.equal(allowedSourcePath(path), false, path);
  assert.equal(
    allowedSourcePath(
      "apps/api/prisma/migrations/20261012050000_native_password_reset_delivery_quota/migration.sql",
    ),
    true,
  );
});

test("detects source tampering, missing files and duplicate paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "d5-source-"));
  try {
    await mkdir(join(root, "apps/api"), { recursive: true });
    await writeFile(join(root, "apps/api/package.json"), "{}");
    const original = await hashSourceFiles(root, ["apps/api/package.json"]);
    const entry = original[0];
    assert.ok(entry);
    await writeFile(join(root, "apps/api/package.json"), '{"changed":true}');
    assert.throws(() =>
      assertSourceMatch(original, [{ ...entry, sha256: "0".repeat(64) }]),
    );
    assert.throws(() => assertSourceMatch(original, []));
    assert.throws(() =>
      assertSourceMatch(original, [
        { ...entry, sha256: digest('{"changed":true}') },
      ]),
    );
    await assert.rejects(hashSourceFiles(root, ["package.json"]));
    await assert.rejects(
      hashSourceFiles(root, ["apps/api/package.json", "apps/api/package.json"]),
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test("sanitized reporter retains missing execution and discards diagnostics and raw output", async () => {
  async function* events() {
    yield {
      type: "test:enqueue",
      data: {
        name: "required",
        file: "/workspace/test.mts",
        line: 1,
        column: 1,
      },
    };
    yield { type: "test:stdout", data: { name: "credential-must-not-escape" } };
    yield {
      type: "test:diagnostic",
      data: { name: "credential-must-not-escape" },
    };
  }
  let text = "";
  for await (const part of report(events())) text += part;
  const output = JSON.parse(text) as { results: { status: string }[] };
  assert.equal(text.includes("credential-must-not-escape"), false);
  assert.deepEqual(
    output.results.map((r) => r.status),
    ["NOT_RUN"],
  );
});
