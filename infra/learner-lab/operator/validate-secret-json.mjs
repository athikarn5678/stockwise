// Strict, flat Secrets Manager object validation. Values arrive only on stdin.
import { Buffer } from "node:buffer";
import { readFileSync, realpathSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

export function validateSecretJson(text, fields) {
  try {
    if (Buffer.byteLength(text, "utf8") > 65_536) return false;
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value))
      return false;
    if (Object.keys(value).length !== Object.keys(fields).length) return false;
    for (const [name, pattern] of Object.entries(fields)) {
      if (
        typeof value[name] !== "string" ||
        pattern.exec(value[name])?.[0] !== value[name]
      )
        return false;
    }

    // JSON.parse discards duplicate keys. Scan whole string tokens separately,
    // decoding names so app_password and \u0061pp_password are the same key.
    const names = new Set();
    for (const token of text.matchAll(/"(?:\\.|[^"\\])*"/g)) {
      if (!/^\s*:/.test(text.slice(token.index + token[0].length))) continue;
      const name = JSON.parse(token[0]);
      if (names.has(name)) return false;
      names.add(name);
    }
    return true;
  } catch {
    return false;
  }
}

if (
  process.argv[1] &&
  realpathSync.native(fileURLToPath(import.meta.url)) ===
    realpathSync.native(process.argv[1])
) {
  // Arguments contain field names and patterns only, never secret values.
  try {
    const fields = Object.fromEntries(
      process.argv.slice(2).map((spec) => {
        const separator = spec.indexOf("=");
        if (separator < 1) throw new Error("INVALID_SCHEMA");
        return [
          spec.slice(0, separator),
          new RegExp(`^(?:${spec.slice(separator + 1)})$`),
        ];
      }),
    );
    process.exitCode =
      Object.keys(fields).length > 0 &&
      validateSecretJson(readFileSync(0, "utf8"), fields)
        ? 0
        : 1;
    if (process.exitCode === 0)
      process.stdout.write("STOCKWISE_SECRET_JSON:VALID\n");
  } catch {
    // Parser and I/O exceptions may contain input; never forward them.
    process.exitCode = 1;
  }
}
