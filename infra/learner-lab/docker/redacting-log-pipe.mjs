// Container log boundary (ADR-040 amendment R2, finding R2-F1).
//   node redacting-log-pipe.mjs <command> [args...]
// Runs <command> with its stdout and stderr piped through a redactor before
// they reach the container's own stdout/stderr, which ECS ships to
// CloudWatch. Next.js proxy failures log the full upstream URL, and emailed
// links carry single-use credentials in the query string, so every query
// string and credential-shaped value is removed before ingestion, whatever
// the parameter is called.
//
// - Works on complete lines across arbitrary chunking (incremental UTF-8
//   decoding, buffering until newline).
// - A line longer than MAX_LINE is redacted, cut, and the rest of it is
//   discarded up to the next newline, so a URL split by the cut cannot leak
//   its remainder.
// - Signals are forwarded and the child's exit status is preserved.
import { spawn } from "node:child_process";
import process from "node:process";
import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";

export const MAX_LINE = 16_384;
const REDACTED = "[redacted]";

const rules = [
  // Query punctuation is data, not a delimiter; serialized URL whitespace is escaped.
  [/(\?|%(?:25)*3f|\\u003f|\\x3f)\S+/gi, `?${REDACTED}`],
  // Map/URLSearchParams inspection: 'name' => 'value'.
  [/('[^']*'\s*=>\s*)'[^']*'/g, `$1'${REDACTED}'`],
  // name=value pairs joined by "&" without a leading "?".
  [/[\w.~%+-]+=[^\s&"'<>]*(?:&[\w.~%+-]+=[^\s&"'<>]*)+/g, REDACTED],
  // Bearer and Basic credentials (before the name rule, which would otherwise
  // consume the scheme word and leave the credential).
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`],
  // Credential-shaped names in key=value, key: value or "key":"value" form.
  // "code" is deliberately absent: Node error objects print code: 'ECONNREFUSED',
  // and query-borne codes are already removed by the query-string rule.
  [
    /((?:token|otp|secret|password|passwd|signature|sig|session|cookie|key|credential|authorization|auth)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&)}\]]+)/gi,
    `$1${REDACTED}`,
  ],
];

export function redactLine(line) {
  // CR is a continuation, so it cannot separate a credential from its context.
  let result = line.replace(/\r/g, "");
  for (const [pattern, replacement] of rules)
    result = result.replace(pattern, replacement);
  return result;
}

// Turns arbitrary chunks into redacted complete lines written with write().
export function createLineRedactor(write, { maxLine = MAX_LINE } = {}) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let discarding = false;
  const continued = (line) => /(?:^|[^\\])(?:\\\\)*\\$/.test(line);
  // A complete line is redacted as a whole first (so rules see the full URL),
  // then capped.
  const emit = (line) => {
    const redacted = redactLine(line);
    write(
      redacted.length > maxLine
        ? `${redacted.slice(0, maxLine)} [line truncated by log redactor]\n`
        : `${redacted}\n`,
    );
  };
  const consume = (text) => {
    pending += text.replace(/\r/g, "");
    let newline;
    while ((newline = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      const hasContinuation = continued(line);
      if (discarding) {
        discarding = hasContinuation;
        continue;
      }
      if (hasContinuation) {
        pending = line.slice(0, -1) + pending;
        continue;
      }
      emit(line);
    }
    // An unterminated line beyond the cap: redact the head, then discard
    // everything up to the next newline (its tail may hold a split query).
    if (!discarding && pending.length > maxLine) {
      write(
        `${redactLine(pending.slice(0, maxLine))} [line truncated by log redactor]\n`,
      );
      pending = continued(pending) ? "\\" : "";
      discarding = true;
    } else if (discarding) {
      // Keep only slash parity when a continuation and its newline split chunks.
      pending = continued(pending) ? "\\" : "";
    }
  };
  return {
    push: (chunk) =>
      consume(typeof chunk === "string" ? chunk : decoder.write(chunk)),
    end: () => {
      consume(decoder.end());
      if (pending && !discarding) emit(pending);
      pending = "";
    },
  };
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    process.stderr.write("usage: redacting-log-pipe.mjs <command> [args...]\n");
    process.exit(64);
  }
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  const streams = [
    [child.stdout, process.stdout],
    [child.stderr, process.stderr],
  ].map(([source, target]) => {
    const redactor = createLineRedactor((text) => target.write(text));
    source.on("data", redactor.push);
    return new Promise((done) =>
      source.on("end", () => {
        redactor.end();
        done();
      }),
    );
  });
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("error", (error) => {
    process.stderr.write(
      `redacting-log-pipe: cannot start ${command}: ${error.code ?? "error"}\n`,
    );
    process.exit(127);
  });
  child.on("close", async (code, signal) => {
    await Promise.all(streams);
    const constants = { SIGTERM: 15, SIGINT: 2, SIGHUP: 1, SIGKILL: 9 };
    process.exitCode = code ?? 128 + (constants[signal] ?? 1);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
