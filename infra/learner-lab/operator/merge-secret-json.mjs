// Adds missing keys to an existing flat Secrets Manager object (ADR-040).
//   <existing JSON on stdin> | node merge-secret-json.mjs NAME...
// For each NAME absent from the stored object, its value is taken from the
// process environment (never from argv). Existing keys are never changed, so
// merging cannot silently rotate a secret. Values are never printed except in
// the merged JSON written to stdout for the caller to store.
// Exit 0: merged JSON on stdout (something was added). Exit 3: nothing to add
// (no output). Any other failure exits 1 with no output, and no input text or
// value is echoed.
import { Buffer } from "node:buffer";
import { readFileSync, realpathSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const NOTHING_TO_ADD = 3;

/** @returns {{status: "merged", json: string} | {status: "nothing"} | {status: "error"}} */
export function mergeSecretJson(text, names, environment) {
  try {
    if (Buffer.byteLength(text, "utf8") > 65_536 || names.length === 0)
      return { status: "error" };
    const stored = JSON.parse(text);
    if (!stored || typeof stored !== "object" || Array.isArray(stored))
      return { status: "error" };
    for (const value of Object.values(stored)) {
      if (typeof value !== "string") return { status: "error" };
    }
    const merged = { ...stored };
    let added = false;
    for (const name of names) {
      if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(name)) return { status: "error" };
      if (Object.hasOwn(stored, name)) continue;
      const value = environment[name];
      if (typeof value !== "string" || value.length === 0)
        return { status: "error" };
      merged[name] = value;
      added = true;
    }
    return added
      ? { status: "merged", json: JSON.stringify(merged) }
      : { status: "nothing" };
  } catch {
    return { status: "error" };
  }
}

if (
  process.argv[1] &&
  realpathSync.native(fileURLToPath(import.meta.url)) ===
    realpathSync.native(process.argv[1])
) {
  try {
    const result = mergeSecretJson(
      readFileSync(0, "utf8"),
      process.argv.slice(2),
      process.env,
    );
    if (result.status === "merged") process.stdout.write(result.json);
    process.exitCode =
      result.status === "merged"
        ? 0
        : result.status === "nothing"
          ? NOTHING_TO_ADD
          : 1;
  } catch {
    process.exitCode = 1;
  }
}
