import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { fileURLToPath, URL } from "node:url";

import { validateSecretJson } from "./validate-secret-json.mjs";

const fields = {
  app_password: /^[A-Za-z0-9_-]{24,128}$/,
  migrator_password: /^[A-Za-z0-9_-]{24,128}$/,
  demo_user_password: /^[A-Za-z0-9_-]{24,128}$/,
};
const value = {
  app_password: "SYNTHETIC_APP_PASSWORD_0123456789",
  migrator_password: "SYNTHETIC_MIGRATOR_PASSWORD_0123456789",
  demo_user_password: "SYNTHETIC_DEMO_PASSWORD_0123456789",
};
const valid = JSON.stringify(value);
const append = (tail) => `${valid.slice(0, -1)},${tail}}`;

for (const [name, text] of [
  ["compact", valid],
  ["ordinary whitespace", JSON.stringify(value, null, 2)],
  ["CRLF whitespace", JSON.stringify(value, null, 2).replaceAll("\n", "\r\n")],
  ["escaped key", valid.replace("app_password", "\\u0061pp_password")],
]) {
  test(`accepts valid flat secret JSON: ${name}`, () => {
    assert.equal(validateSecretJson(text, fields), true);
  });
}

for (const [name, text] of [
  ["empty response", ""],
  ["whitespace response", " \t\r\n"],
  ["invalid syntax", append("BROKEN")],
  ["trailing comma", `${valid.slice(0, -1)},}`],
  ["truncated JSON", valid.slice(0, -1)],
  ["trailing data", `${valid} null`],
  ["duplicate identical key", append(`"app_password":"${value.app_password}"`)],
  [
    "duplicate conflicting key",
    append('"app_password":"CONFLICTING_PASSWORD_0123456789"'),
  ],
  ["duplicate followed by null", append('"app_password":null')],
  ["escaped duplicate", append(`"\\u0061pp_password":"${value.app_password}"`)],
  ["wrong root type", JSON.stringify([value])],
  ["null root", "null"],
  ["missing credential", JSON.stringify({ app_password: value.app_password })],
  ["empty credential", JSON.stringify({ ...value, app_password: "" })],
  [
    "trailing credential newline",
    JSON.stringify({ ...value, app_password: `${value.app_password}\n` }),
  ],
  [
    "trailing credential CRLF",
    JSON.stringify({ ...value, app_password: `${value.app_password}\r\n` }),
  ],
  [
    "trailing credential line separator",
    JSON.stringify({ ...value, app_password: `${value.app_password}\u2028` }),
  ],
  ["null credential", JSON.stringify({ ...value, app_password: null })],
  ["numeric credential", JSON.stringify({ ...value, app_password: 123 })],
  [
    "nested credential",
    JSON.stringify({ ...value, app_password: { value: value.app_password } }),
  ],
  ["nested root", JSON.stringify({ nested: value })],
  ["unexpected field", JSON.stringify({ ...value, extra: "unexpected" })],
  ["oversized response", `${" ".repeat(65_536)}${valid}`],
]) {
  test(`rejects malformed or ambiguous secret JSON: ${name}`, () => {
    assert.equal(validateSecretJson(text, fields), false);
  });
}

test("string contents cannot spoof a key and parser failures print no input", () => {
  const permissive = { field: /^.*$/ };
  assert.equal(
    validateSecretJson(
      JSON.stringify({ field: '\\"field\\":\\"value\\"' }),
      permissive,
    ),
    true,
  );
  for (const input of [
    valid,
    append("BROKEN"),
    append('"app_password":null'),
  ]) {
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("./validate-secret-json.mjs", import.meta.url)),
        ...Object.keys(fields).map((name) => `${name}=[A-Za-z0-9_-]{24,128}`),
      ],
      { input, encoding: "utf8" },
    );
    assert.equal(result.status, input === valid ? 0 : 1);
    assert.equal(
      result.stdout,
      input === valid ? "STOCKWISE_SECRET_JSON:VALID\n" : "",
    );
    assert.equal(result.stderr, "");
  }
});

for (const kind of [
  "real",
  "directory alias",
  "macOS-style var alias",
  ...(process.platform === "win32"
    ? ["Windows temporary path spelling"]
    : ["file symlink"]),
]) {
  test(`CLI requires actual validation through ${kind}`, () => {
    const temp = realpathSync.native(tmpdir());
    const root = mkdtempSync(path.join(temp, "stockwise-secret-cli-"));
    const cli = realpathSync(
      fileURLToPath(new URL("./validate-secret-json.mjs", import.meta.url)),
    );
    const linkType = process.platform === "win32" ? "junction" : "dir";
    let entry = cli;
    try {
      if (kind === "directory alias") {
        symlinkSync(path.dirname(cli), path.join(root, "operator"), linkType);
        entry = path.join(root, "operator", path.basename(cli));
      } else if (kind === "macOS-style var alias") {
        mkdirSync(path.join(root, "private"));
        symlinkSync(
          path.dirname(cli),
          path.join(root, "private", "var"),
          linkType,
        );
        symlinkSync(
          path.join(root, "private", "var"),
          path.join(root, "var"),
          linkType,
        );
        entry = path.join(root, "var", path.basename(cli));
      } else if (kind === "file symlink") {
        entry = path.join(root, "validator.mjs");
        symlinkSync(cli, entry, "file");
      } else if (kind === "Windows temporary path spelling") {
        copyFileSync(cli, path.join(root, "validator.mjs"));
        entry = path.join(tmpdir(), path.basename(root), "validator.mjs");
      }
      for (const input of [
        valid,
        "",
        " ",
        append("BROKEN"),
        append(`"app_password":"${value.app_password}"`),
        append('"\\u0061pp_password":null'),
      ]) {
        const result = spawnSync(
          process.execPath,
          [
            entry,
            ...Object.keys(fields).map(
              (name) => `${name}=[A-Za-z0-9_-]{24,128}`,
            ),
          ],
          { input, encoding: "utf8" },
        );
        assert.equal(result.status, input === valid ? 0 : 1);
        assert.equal(
          result.stdout,
          input === valid ? "STOCKWISE_SECRET_JSON:VALID\n" : "",
        );
        assert.equal(result.stderr, "");
      }
    } finally {
      assert.equal(path.dirname(realpathSync.native(root)), temp);
      rmSync(root, { recursive: true, force: true });
    }
  });
}
