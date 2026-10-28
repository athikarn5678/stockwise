import assert from "node:assert/strict";
import test from "node:test";

import {
  FIXTURES,
  STACK_IMAGE,
  StackConfigError,
  parseStackConfig,
} from "./browser-stack-config.mts";
import { SYNTHETIC_RECIPIENT } from "./browser-mail-capture.mts";

const good = {
  dockerExecutable: "C:\\Docker\\docker.exe",
  outputDirectory: "C:\\Evidence\\stack",
};

function reasonOf(text: string): string {
  try {
    parseStackConfig(text);
  } catch (error) {
    assert.ok(error instanceof StackConfigError);
    return error.reason;
  }
  throw new Error("Expected a configuration refusal.");
}

test("accepts the minimal configuration and applies the bounded default timeout", () => {
  const config = parseStackConfig(JSON.stringify(good));
  assert.equal(config.runTimeoutMs, 7_200_000);
  assert.equal(config.outputDirectory, good.outputDirectory);
});

test("refuses malformed, relative, unknown and out-of-range configuration", () => {
  assert.equal(reasonOf("nope"), "NOT_JSON");
  assert.equal(reasonOf("[]"), "NOT_OBJECT");
  assert.equal(
    reasonOf(JSON.stringify({ ...good, image: "postgres:latest" })),
    "UNKNOWN_KEY",
  );
  assert.equal(
    reasonOf(JSON.stringify({ ...good, dockerExecutable: "docker" })),
    "DOCKER_EXECUTABLE_INVALID",
  );
  assert.equal(
    reasonOf(JSON.stringify({ ...good, outputDirectory: "evidence" })),
    "OUTPUT_DIRECTORY_INVALID",
  );
  for (const runTimeoutMs of [1, 299_999, 14_400_001, 1.5, "1h"])
    assert.equal(
      reasonOf(JSON.stringify({ ...good, runTimeoutMs })),
      "RUN_TIMEOUT_INVALID",
    );
});

test("the image is pinned by digest and fixtures are capturable synthetic recipients", () => {
  assert.match(STACK_IMAGE, /^postgres:16\.15-alpine@sha256:[a-f0-9]{64}$/);
  for (const email of Object.values(FIXTURES))
    assert.equal(SYNTHETIC_RECIPIENT.test(email), true, email);
});
