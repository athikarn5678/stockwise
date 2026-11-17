import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { mergeSecretJson } from "./merge-secret-json.mjs";

const stored = JSON.stringify({ A_KEY_1: "stored-one", B_KEY_2: "stored-two" });
const environment = { C_KEY_3: "env-three", A_KEY_1: "env-must-not-win" };

test("adds only missing keys and never overwrites a stored one", () => {
  const result = mergeSecretJson(stored, ["A_KEY_1", "C_KEY_3"], environment);
  assert.equal(result.status, "merged");
  assert.deepEqual(JSON.parse(result.json), {
    A_KEY_1: "stored-one",
    B_KEY_2: "stored-two",
    C_KEY_3: "env-three",
  });
});

test("reports nothing to add when every name is already stored", () => {
  assert.equal(
    mergeSecretJson(stored, ["A_KEY_1", "B_KEY_2"], {}).status,
    "nothing",
  );
});

test("fails closed on a missing or empty environment value", () => {
  assert.equal(mergeSecretJson(stored, ["C_KEY_3"], {}).status, "error");
  assert.equal(
    mergeSecretJson(stored, ["C_KEY_3"], { C_KEY_3: "" }).status,
    "error",
  );
});

test("fails closed on non-object, non-string and oversized input", () => {
  for (const text of [
    "[]",
    "null",
    "not json",
    '{"A":1}',
    '{"A":{"B":"c"}}',
    "",
  ])
    assert.equal(
      mergeSecretJson(text, ["C_KEY_3"], environment).status,
      "error",
    );
  assert.equal(
    mergeSecretJson(
      JSON.stringify({ A_KEY_1: "x".repeat(70_000) }),
      ["C_KEY_3"],
      environment,
    ).status,
    "error",
  );
});

test("rejects unsafe names and an empty name list", () => {
  assert.equal(mergeSecretJson(stored, [], environment).status, "error");
  assert.equal(
    mergeSecretJson(stored, ["__proto__"], { __proto__: "x" }).status,
    "error",
  );
  assert.equal(
    mergeSecretJson(stored, ["lower"], { lower: "x" }).status,
    "error",
  );
});

test("CLI: exit codes, stdout only on merge, no input echoed on failure", () => {
  const script = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "merge-secret-json.mjs",
  );
  const run = (input, names, env) =>
    spawnSync(process.execPath, [script, ...names], {
      input,
      env: { ...process.env, ...env },
      encoding: "utf8",
    });
  const merged = run(stored, ["C_KEY_3"], { C_KEY_3: "env-three" });
  assert.equal(merged.status, 0);
  assert.equal(JSON.parse(merged.stdout).C_KEY_3, "env-three");
  const nothing = run(stored, ["A_KEY_1"], {});
  assert.equal(nothing.status, 3);
  assert.equal(nothing.stdout, "");
  const failed = run("SECRET-LOOKING-GARBAGE", ["C_KEY_3"], { C_KEY_3: "v" });
  assert.equal(failed.status, 1);
  assert.equal(failed.stdout + failed.stderr, "");
});
