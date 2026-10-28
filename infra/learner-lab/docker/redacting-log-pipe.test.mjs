// Regression tests for finding R2-F1 (query credentials in container logs).
//   node --test infra/learner-lab/docker/redacting-log-pipe.test.mjs
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  MAX_LINE,
  createLineRedactor,
  redactLine,
} from "./redacting-log-pipe.mjs";

const pipe = join(
  dirname(fileURLToPath(import.meta.url)),
  "redacting-log-pipe.mjs",
);
const MARKER = /synthetic[-_]r2[-_]?marker|SYNTHETIC-R2-MARKER/i;

// Lines exactly as Next.js 16.3.8 logged them when the API was unavailable.
const nextProxyFailures = [
  "Failed to proxy http://127.0.0.1:3001/api/v1/me/access-context?token=synthetic-r2-marker-a Error: connect ECONNREFUSED 127.0.0.1:3001",
  "Failed to proxy http://127.0.0.1:3001/api/v1/me/access-context?a=1&token=synthetic-r2-marker-b&c=3 Error: connect ECONNREFUSED 127.0.0.1:3001",
  "Failed to proxy http://127.0.0.1:3001/api/v1/me/access-context?code=synthetic-r2-marker-c Error: connect ECONNREFUSED 127.0.0.1:3001",
  "Failed to proxy http://127.0.0.1:3001/api/v1/me/access-context?x=%3Ftoken%3Dsynthetic-r2-marker-d Error: connect ECONNREFUSED 127.0.0.1:3001",
  "Failed to proxy http://127.0.0.1:3001/api/v1/auth/verify-email?token=synthetic-r2-marker-e Error: connect ECONNREFUSED 127.0.0.1:3001",
  "Failed to proxy http://127.0.0.1:3001/health?probe=synthetic-r2-marker-f Error: connect ECONNREFUSED 127.0.0.1:3001",
];

test("Next.js proxy failures keep the path and error but lose every query", () => {
  for (const line of nextProxyFailures) {
    const redacted = redactLine(line);
    assert.doesNotMatch(redacted, MARKER, line);
    assert.match(
      redacted,
      /^Failed to proxy http:\/\/127\.0\.0\.1:3001\/[a-z0-9/-]+\?\[redacted\] Error: connect ECONNREFUSED 127\.0\.0\.1:3001$/,
    );
  }
});

test("other credential-carrying shapes are redacted, whatever the parameter name", () => {
  const cases = [
    "GET /reset-password?invite=synthetic-r2-marker-1",
    "url %3Ftoken%3Dsynthetic-r2-marker-2 end",
    "double %253Fcode%253Dsynthetic-r2-marker-3",
    'json {"url":"/x\\u003ftoken=synthetic-r2-marker-4"}',
    "searchParams: URLSearchParams { 'token' => 'synthetic-r2-marker-5', 'other' => 'synthetic-r2-marker-6' }",
    "    'invite' => 'synthetic-r2-marker-7',",
    "body a=1&reset=synthetic-r2-marker-8&b=2",
    "{ token: 'synthetic-r2-marker-9', otp: \"synthetic-r2-marker-10\" }",
    "authorization: Bearer synthetic-r2-marker-11",
    "malformed http://[::1?token=synthetic-r2-marker-12 and http://host:99999/p?k=synthetic-r2-marker-13",
    "relative only ?session=synthetic-r2-marker-14",
    "password=synthetic-r2-marker-15",
  ];
  for (const line of cases) assert.doesNotMatch(redactLine(line), MARKER, line);
});

test("ordinary diagnostics survive redaction", () => {
  const lines = [
    "  code: 'ECONNREFUSED',",
    "  syscall: 'connect',",
    "  port: 3001",
    "✓ Ready in 168ms",
    "Error: connect ECONNREFUSED 127.0.0.1:3001",
    "    at <unknown> (Error: connect ECONNREFUSED 127.0.0.1:3001) {",
    "Is the API up? Retrying in 5s",
  ];
  for (const line of lines) assert.equal(redactLine(line), line);
});

function collect(chunks, options) {
  let output = "";
  const redactor = createLineRedactor((text) => (output += text), options);
  for (const chunk of chunks) redactor.push(chunk);
  redactor.end();
  return output;
}

test("arbitrary chunking, including split multi-byte characters, cannot bypass redaction", () => {
  const text = `${nextProxyFailures.join("\n")}\nnaïve café ✓ /x?token=synthetic-r2-marker-split\n`;
  const bytes = Buffer.from(text, "utf8");
  for (const size of [1, 2, 3, 7, 64]) {
    const chunks = [];
    for (let offset = 0; offset < bytes.length; offset += size)
      chunks.push(bytes.subarray(offset, offset + size));
    const output = collect(chunks);
    assert.doesNotMatch(output, MARKER, `chunk size ${size}`);
    assert.match(output, /naïve café ✓/, `utf-8 intact at chunk size ${size}`);
    assert.equal(output.split("\n").length, nextProxyFailures.length + 2);
  }
});

test("an unterminated overlong line is cut and its remainder discarded, so a split query cannot leak", () => {
  // The buffer overflows before any newline arrives; the cut falls inside the query.
  const head = "x".repeat(MAX_LINE + 10);
  const output = collect([
    `${head}/p?q`,
    "uery=1&tail=synthetic-r2-marker-split-tail more\n",
    "next line\n",
  ]);
  assert.doesNotMatch(output, MARKER);
  assert.match(output, /\[line truncated by log redactor\]\nnext line\n$/);
  assert.ok(output.split("\n").every((line) => line.length <= MAX_LINE + 40));
});

test("a complete overlong line is redacted as a whole, then capped", () => {
  const head = "x".repeat(MAX_LINE - 5);
  const output = collect([
    `${head}/p?q`,
    "uery=1&token=synthetic-r2-marker-long more\n",
    "next line\n",
  ]);
  assert.doesNotMatch(output, MARKER);
  assert.match(output, /\[line truncated by log redactor\]\nnext line\n$/);
});

test("a final line without newline is still redacted and flushed", () => {
  assert.equal(
    collect(["tail /p?token=synthetic-r2-marker-eof"]),
    "tail /p?[redacted]\n",
  );
});

test("R3 query punctuation, escaped representations and authorization schemes cannot leak", () => {
  const lines = [
    "Failed to proxy http://127.0.0.1:3001/x?other=(synthetic-r2-marker-parens) Error: connect ECONNREFUSED 127.0.0.1:3001",
    "Failed to proxy /x?other='synthetic-r2-marker-quote' Error: ECONNREFUSED",
    "Failed to proxy /x?arbitrary=[{synthetic-r2-marker-punctuation}]&second=synthetic-r2-marker-second Error: ECONNREFUSED",
    "url /x%25253fother%253d(synthetic-r2-marker-encoded) Error: ECONNREFUSED",
    'json {"url":"/x\\u003fother=(synthetic-r2-marker-escaped)"}',
    "escaped /x\\x3Fother=synthetic-r2-marker-hex",
    "authorization: bearer synthetic-r2-marker-lowercase",
    "Authorization: bEaReR synthetic-r2-marker-mixed",
    "AUTHORIZATION: bAsIc synthetic-r2-marker-basic",
    "Failed to proxy /x?other=synthetic-r2-marker-before\rsynthetic-r2-marker-after Error: ECONNREFUSED",
    "Failed to proxy /x?other=(\\\r\nsynthetic-r2-marker-continued) Error: ECONNREFUSED",
  ];
  const text = `${lines.join("\n")}\n`;
  for (const size of [1, 7, 4096]) {
    const bytes = Buffer.from(text);
    const chunks = [];
    for (let offset = 0; offset < bytes.length; offset += size)
      chunks.push(bytes.subarray(offset, offset + size));
    const output = collect(chunks);
    assert.doesNotMatch(output, MARKER, `chunk size ${size}`);
    assert.match(output, /Failed to proxy http:\/\/127\.0\.0\.1:3001\/x/);
    assert.match(output, /ECONNREFUSED/);
  }
});

test("R3 oversized continued records discard every continuation and preserve the next record", () => {
  const fragments = [
    `${"x".repeat(MAX_LINE + 1)}\\\n`,
    "synthetic-r2-marker-overflow\\\r\n",
    "synthetic-r2-marker-tail\n",
    "Error: connect ECONNREFUSED 127.0.0.1:3001\n",
  ];
  const bytes = Buffer.from(fragments.join(""));
  for (const size of [1, 7, 4096]) {
    const chunks = [];
    for (let offset = 0; offset < bytes.length; offset += size)
      chunks.push(bytes.subarray(offset, offset + size));
    const output = collect(chunks);
    assert.doesNotMatch(output, MARKER, `chunk size ${size}`);
    assert.match(output, /\[line truncated by log redactor\]/);
    assert.match(output, /Error: connect ECONNREFUSED 127\.0\.0\.1:3001\n$/);
  }
});

function runPipe(script, { signalAfterMs } = {}) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [pipe, process.execPath, "-e", script],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => (stdout += data));
    child.stderr.on("data", (data) => (stderr += data));
    if (signalAfterMs) setTimeout(() => child.kill("SIGTERM"), signalAfterMs);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("the pipe redacts both streams of a real child and preserves its exit status", async () => {
  const script = `
    const write = (stream, text) => new Promise((done) => stream.write(text, done));
    (async () => {
      await write(process.stdout, "Failed to proxy http://127.0.0.1:3001/a?tok");
      await write(process.stdout, "en=synthetic-r2-marker-out Error\\n");
      await write(process.stderr, "Failed to proxy http://127.0.0.1:3001/b?token=synthetic-r2-marker-err\\n");
      process.exit(7);
    })();`;
  const { code, stdout, stderr } = await runPipe(script);
  assert.equal(code, 7);
  assert.doesNotMatch(stdout + stderr, MARKER);
  assert.match(
    stdout,
    /Failed to proxy http:\/\/127\.0\.0\.1:3001\/a\?\[redacted\] Error/,
  );
  assert.match(
    stderr,
    /Failed to proxy http:\/\/127\.0\.0\.1:3001\/b\?\[redacted\]/,
  );
});

test("R3 real child stdout and stderr filter continued punctuation records at every chunk size", async () => {
  const text = [
    "Failed to proxy /x?arbitrary=(synthetic-r2-marker-child) Error: ECONNREFUSED\n",
    "authorization: bEaReR synthetic-r2-marker-authorization\n",
    "url /x?other=synthetic-r2-marker-head\rsynthetic-r2-marker-cr\n",
    "url /x?other=(\\\nsynthetic-r2-marker-newline) Error: ECONNREFUSED\n",
    `${"x".repeat(MAX_LINE + 1)}\\\nsynthetic-r2-marker-discarded\n`,
    "Error: connect ECONNREFUSED 127.0.0.1:3001\n",
  ].join("");
  for (const size of [1, 7, 4096]) {
    const script = `
      (async () => {
        const bytes = Buffer.from(${JSON.stringify(text)});
        for (const stream of [process.stdout, process.stderr]) {
          for (let i = 0; i < bytes.length; i += ${size})
            await new Promise(done => stream.write(bytes.subarray(i, i + ${size}), done));
        }
        process.exitCode = 7;
      })();`;
    const { code, stdout, stderr } = await runPipe(script);
    assert.equal(code, 7);
    for (const output of [stdout, stderr]) {
      assert.doesNotMatch(output, MARKER, `chunk size ${size}`);
      assert.match(output, /Failed to proxy \/x/);
      assert.match(output, /Error: connect ECONNREFUSED 127\.0\.0\.1:3001/);
    }
  }
});

test(
  "SIGTERM is forwarded to the child",
  {
    skip:
      process.platform === "win32" && "POSIX signals (run in the Linux image)",
  },
  async () => {
    const script = `
    process.on("SIGTERM", () => { process.stdout.write("child got SIGTERM\\n"); process.exit(0); });
    process.stdout.write("ready\\n");
    setInterval(() => {}, 1000);`;
    const { code, stdout } = await runPipe(script, { signalAfterMs: 800 });
    assert.equal(code, 0);
    assert.match(stdout, /child got SIGTERM/);
  },
);
