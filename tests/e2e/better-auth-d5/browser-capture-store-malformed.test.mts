import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CaptureStoreRefusal,
  parseCaptureRecords,
  scanForCapturedSecrets,
  summarizeCapture,
  withPrivateCapture,
  type StoreDeps,
} from "./browser-capture-store.mts";
import {
  MAX_CAPTURED_MESSAGES,
  createCaptureRecorder,
} from "./browser-mail-capture.mts";

// R7: a capture that was read but is damaged (torn, malformed or off-schema)
// can never be a clean scan. Deterministic synthetic data only: every token,
// code and address below is a generated non-live canary.
const SID = "S-1-5-21-1111111111-2222222222-3333333333-1001";
const TOKEN = "R7CANARYTOKEN0123456789abcdefABCDEF";
const CODE = "704913";
const RECIPIENT = "d5br-r7canary@example.invalid";
const URL = `http://localhost:3202/verify-email#token=${TOKEN}`;

const recordFields = (fields: Record<string, unknown> = {}) => ({
  seq: 1,
  at: "2026-10-27T00:00:00.000Z",
  kind: "verification",
  recipient: RECIPIENT,
  url: URL,
  code: CODE,
  ...fields,
});
const line = (fields: Record<string, unknown> = {}) =>
  `${JSON.stringify(recordFields(fields))}\n`;
const resetLine = (seq = 2) =>
  line({
    seq,
    kind: "password_reset",
    url: `http://localhost:3202/reset-password#token=${TOKEN}RESET`,
    code: undefined,
  });

async function scratchAsync<T>(operation: (directory: string) => Promise<T>) {
  const directory = mkdtempSync(join(tmpdir(), "stockwise-capture-malformed-"));
  try {
    return await operation(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function fakeDeps(): StoreDeps {
  return {
    platform: "win32",
    currentUserSid: () => SID,
    readSddl: (path) =>
      lstatSync(path).isDirectory()
        ? `D:P(A;OICI;FA;;;${SID})`
        : `D:AI(A;ID;FA;;;${SID})`,
    protectDirectory: () => undefined,
    currentUid: () => undefined,
    isProcessAlive: () => false,
    now: () => new Date("2026-10-27T00:00:00.000Z"),
  };
}

const captureDirectories = (parent: string) =>
  readdirSync(parent).filter((name) => name.startsWith("stack-capture-"));

type Outcome = {
  error: unknown;
  reports: string[];
  summary: Record<string, unknown>;
  parent: string;
};

/** Runs one capture whose body writes `content`; never throws itself. */
async function run(
  parent: string,
  content: string,
  options: { body?: () => void; logs?: Record<string, string> } = {},
): Promise<Outcome> {
  const reports: string[] = [];
  const summaryPath = join(parent, "capture-summary.json");
  let error: unknown;
  try {
    await withPrivateCapture(
      {
        parent,
        deps: fakeDeps(),
        summaryPath,
        retainedLogs: () => options.logs ?? {},
        report: (item) => reports.push(item),
      },
      async (capture) => {
        writeFileSync(capture.file, content);
        options.body?.();
      },
    );
  } catch (caught) {
    error = caught;
  }
  const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
  rmSync(summaryPath);
  return { error, reports, summary, parent };
}

function assertRefused(outcome: Outcome, detail: string) {
  assert.ok(
    outcome.error instanceof CaptureStoreRefusal,
    "the run must be rejected",
  );
  assert.equal(outcome.error.reason, "CAPTURE_RECORD_INVALID");
  assert.deepEqual(outcome.error.detail, [detail]);
  assert.ok(outcome.reports.includes("CAPTURE_LOG_SCAN:INCOMPLETE"));
  assert.equal(outcome.reports.includes("CAPTURE_LOG_SCAN:CLEAN"), false);
  assert.deepEqual(outcome.summary, { scan: "INCOMPLETE" });
  // The capture is destroyed even though the scan failed.
  assert.ok(outcome.reports.includes("CAPTURE_CLEANUP:COMPLETE"));
  assert.deepEqual(captureDirectories(outcome.parent), []);
}

test("empty and blank captures are valid, clean and countable as zero messages", async () => {
  assert.deepEqual(parseCaptureRecords(""), []);
  assert.deepEqual(parseCaptureRecords("\n\n  \n"), []);
  await scratchAsync(async (parent) => {
    for (const content of ["", "\n", "  \n\n"]) {
      const outcome = await run(parent, content);
      assert.equal(outcome.error, undefined);
      assert.ok(outcome.reports.includes("CAPTURE_LOG_SCAN:CLEAN"));
      assert.deepEqual(outcome.summary, {
        scan: "COMPLETE",
        messages: 0,
        kinds: {},
        overflow: false,
      });
    }
  });
});

test("a valid single record is accepted, counted and scanned", async () => {
  assert.equal(parseCaptureRecords(line()).length, 1);
  await scratchAsync(async (parent) => {
    const outcome = await run(parent, line());
    assert.equal(outcome.error, undefined);
    assert.ok(outcome.reports.includes("CAPTURE_LOG_SCAN:CLEAN"));
    assert.deepEqual(outcome.summary, {
      scan: "COMPLETE",
      messages: 1,
      kinds: { verification: 1 },
      overflow: false,
    });
    const leaking = await run(parent, line(), {
      logs: { "api.log": `sent ${CODE}` },
    });
    assert.ok(leaking.error instanceof CaptureStoreRefusal);
    assert.equal(leaking.error.reason, "SECRET_IN_RETAINED_LOG");
    assert.ok(leaking.reports.includes("CAPTURE_LOG_SCAN:LEAK"));
  });
});

test("valid multiple records are all processed, including the overflow marker and CRLF endings", async () => {
  const text = `${line()}${resetLine()}${line({ seq: 3, kind: "invitation", code: undefined })}{"overflow":true}\n`;
  assert.equal(parseCaptureRecords(text).length, 4);
  assert.equal(parseCaptureRecords(text.replaceAll("\n", "\r\n")).length, 4);
  assert.deepEqual(summarizeCapture(text), {
    messages: 3,
    kinds: { verification: 1, password_reset: 1, invitation: 1 },
    overflow: true,
  });
  assert.deepEqual(
    scanForCapturedSecrets(text, { "web.log": `x ${CODE} ${TOKEN}RESET` })
      .map((item) => `${item.log}:${item.kind}`)
      .sort(),
    ["web.log:link-token", "web.log:otp"].sort(),
  );
  // Kind names never collide with object prototype members.
  assert.deepEqual(
    summarizeCapture(line({ kind: "constructor", code: undefined })),
    { messages: 1, kinds: { constructor: 1 }, overflow: false },
  );
});

test("a truncated final record is INCOMPLETE, whether or not the fragment parses", async () => {
  const whole = JSON.stringify(recordFields());
  await scratchAsync(async (parent) => {
    // Cut mid-record, and the same record merely missing its terminator.
    assertRefused(
      await run(parent, whole.slice(0, -1)),
      "line-1:UNTERMINATED_FINAL_RECORD",
    );
    assertRefused(await run(parent, whole), "line-1:UNTERMINATED_FINAL_RECORD");
    assertRefused(
      await run(parent, line() + whole.slice(0, 40)),
      "line-2:UNTERMINATED_FINAL_RECORD",
    );
  });
});

test("malformed JSON between valid records is INCOMPLETE and no message silently disappears", async () => {
  await scratchAsync(async (parent) => {
    assertRefused(
      await run(
        parent,
        `${line()}${JSON.stringify(recordFields()).slice(0, -3)}\n${resetLine(3)}`,
      ),
      "line-2:MALFORMED_JSON",
    );
    for (const damaged of ["not json", "{", "{'a':1}", "nul", "{}}"])
      assertRefused(
        await run(parent, `${line()}${damaged}\n${line({ seq: 3 })}`),
        "line-2:MALFORMED_JSON",
      );
  });
  assert.throws(() => summarizeCapture(`${line()}{broken\n`), /CAPTURE_STORE/);
  assert.throws(
    () => scanForCapturedSecrets(`${line()}{broken\n`, {}),
    CaptureStoreRefusal,
  );
});

test("valid JSON with an invalid shape is refused rather than counted or skipped", async () => {
  const cases: [string, string, string][] = [
    ["array", "[1,2]", "NOT_OBJECT"],
    ["null", "null", "NOT_OBJECT"],
    ["string", '"text"', "NOT_OBJECT"],
    ["number", "7", "NOT_OBJECT"],
    ["empty object", "{}", "INVALID_SCHEMA"],
    [
      "missing url",
      JSON.stringify(recordFields({ url: undefined })),
      "INVALID_SCHEMA",
    ],
    [
      "missing recipient",
      JSON.stringify(recordFields({ recipient: undefined })),
      "INVALID_SCHEMA",
    ],
    [
      "url is a number",
      JSON.stringify(recordFields({ url: 5 })),
      "INVALID_SCHEMA",
    ],
    [
      "url is empty",
      JSON.stringify(recordFields({ url: "" })),
      "INVALID_SCHEMA",
    ],
    [
      "code with five digits",
      JSON.stringify(recordFields({ code: "70491" })),
      "INVALID_SCHEMA",
    ],
    [
      "code is a number",
      JSON.stringify(recordFields({ code: 704913 })),
      "INVALID_SCHEMA",
    ],
    [
      "code is not digits",
      JSON.stringify(recordFields({ code: "70491x" })),
      "INVALID_SCHEMA",
    ],
    ["seq zero", JSON.stringify(recordFields({ seq: 0 })), "INVALID_SCHEMA"],
    [
      "seq fractional",
      JSON.stringify(recordFields({ seq: 1.5 })),
      "INVALID_SCHEMA",
    ],
    [
      "kind uppercase",
      JSON.stringify(recordFields({ kind: "Verification" })),
      "INVALID_SCHEMA",
    ],
    [
      "kind __proto__",
      '{"seq":1,"at":"x","kind":"__proto__","recipient":"r","url":"u"}',
      "INVALID_SCHEMA",
    ],
    [
      "unknown field",
      JSON.stringify(recordFields({ token: TOKEN })),
      "INVALID_SCHEMA",
    ],
    ["overflow false", '{"overflow":false}', "INVALID_SCHEMA"],
    ["overflow string", '{"overflow":"true"}', "INVALID_SCHEMA"],
    [
      "overflow with extra field",
      '{"overflow":true,"seq":1}',
      "INVALID_SCHEMA",
    ],
  ];
  await scratchAsync(async (parent) => {
    for (const [name, record, violation] of cases) {
      const outcome = await run(parent, `${line()}${record}\n`);
      assert.ok(
        outcome.error instanceof CaptureStoreRefusal,
        `${name} must be refused`,
      );
      assertRefused(outcome, `line-2:${violation}`);
    }
  });
});

test("a torn record carrying a credential canary is never clean, even when the logs hold the canary", async () => {
  const whole = JSON.stringify(recordFields());
  await scratchAsync(async (parent) => {
    const outcome = await run(parent, whole.slice(0, -1), {
      logs: { "api.log": `known ${URL} ${CODE} ${TOKEN}` },
    });
    assertRefused(outcome, "line-1:UNTERMINATED_FINAL_RECORD");
    // A torn record in the middle of a file with a valid, leaking neighbour.
    const middle = await run(
      parent,
      `${line()}${whole.slice(0, 60)}\n${resetLine(3)}`,
      { logs: { "api.log": `known ${URL}` } },
    );
    assertRefused(middle, "line-2:MALFORMED_JSON");
    assert.equal(middle.reports.includes("CAPTURE_LOG_SCAN:LEAK"), false);
  });
});

test("a malformed capture fails the run even though cleanup succeeds, and keeps an earlier failure", async () => {
  await scratchAsync(async (parent) => {
    const reports: string[] = [];
    const original = new Error("EXPECTED_BODY_FAILURE");
    const error = await withPrivateCapture(
      { parent, deps: fakeDeps(), report: (item) => reports.push(item) },
      async (capture) => {
        writeFileSync(capture.file, '{"kind":');
        throw original;
      },
    ).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors[0], original);
    const refusal = error.errors[1];
    assert.ok(refusal instanceof CaptureStoreRefusal);
    assert.equal(refusal.reason, "CAPTURE_RECORD_INVALID");
    assert.ok(reports.includes("CAPTURE_LOG_SCAN:INCOMPLETE"));
    assert.ok(reports.includes("CAPTURE_CLEANUP:COMPLETE"));
    assert.deepEqual(captureDirectories(parent), []);
  });
});

test("a malformed capture plus a failed cleanup keeps both failures and leaves foreign files", async () => {
  await scratchAsync(async (parent) => {
    let directory = "";
    const reports: string[] = [];
    const error = await withPrivateCapture(
      { parent, deps: fakeDeps(), report: (item) => reports.push(item) },
      async (capture) => {
        directory = capture.directory;
        writeFileSync(
          capture.file,
          JSON.stringify(recordFields()).slice(0, 30),
        );
        writeFileSync(join(capture.directory, "foreign-canary.txt"), "keep");
      },
    ).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(
      error.errors.map((item) =>
        item instanceof CaptureStoreRefusal ? item.reason : "other",
      ),
      ["CAPTURE_RECORD_INVALID", "UNEXPECTED_ENTRY"],
    );
    assert.ok(reports.includes("CAPTURE_LOG_SCAN:INCOMPLETE"));
    assert.ok(reports.includes("CAPTURE_CLEANUP:FAILED"));
    // The credential file is gone; the file this code never wrote is kept.
    assert.equal(existsSync(join(directory, "mail-capture.jsonl")), false);
    assert.equal(
      readFileSync(join(directory, "foreign-canary.txt"), "utf8"),
      "keep",
    );
    rmSync(directory, { recursive: true, force: true });
  });
});

test("diagnostics never carry record text, tokens, codes, addresses or URLs", async () => {
  const sensitive = [TOKEN, CODE, RECIPIENT, "localhost:3202", "verify-email"];
  const hostile = [
    JSON.stringify(recordFields()).slice(0, -1),
    `${line()}${JSON.stringify(recordFields({ url: 5 }))}\n`,
    `${line()}${JSON.stringify(recordFields({ token: TOKEN }))}\n`,
    `${line()}${JSON.stringify(recordFields()).slice(0, 50)}\n`,
  ];
  await scratchAsync(async (parent) => {
    for (const content of hostile) {
      const outcome = await run(parent, content, {
        logs: { "api.log": `known ${URL} ${CODE}` },
      });
      const surfaced = JSON.stringify([
        outcome.error instanceof CaptureStoreRefusal
          ? [outcome.error.message, outcome.error.detail, outcome.error.reason]
          : String(outcome.error),
        outcome.reports,
        outcome.summary,
      ]);
      for (const secret of sensitive)
        assert.equal(surfaced.includes(secret), false, `leaked ${secret}`);
    }
  });
  for (const content of hostile) {
    try {
      parseCaptureRecords(content);
      assert.fail("must throw");
    } catch (error) {
      assert.ok(error instanceof CaptureStoreRefusal);
      const surfaced = JSON.stringify([error.message, error.detail]);
      for (const secret of sensitive)
        assert.equal(surfaced.includes(secret), false);
      assert.match(error.detail[0] ?? "", /^line-\d+:[A-Z_]+$/);
    }
  }
});

test("everything the real recorder writes is accepted: verification, reset and invitation messages and the overflow marker", async () => {
  await scratchAsync(async (parent) => {
    const file = join(parent, "recorded.jsonl");
    writeFileSync(file, "");
    const recorder = createCaptureRecorder(file, (path, text) =>
      appendFileSync(path, text),
    );
    assert.equal(
      recorder.record({
        kind: "verification",
        recipient: RECIPIENT,
        url: URL,
        code: CODE,
      }),
      true,
    );
    assert.equal(
      recorder.record({
        kind: "password_reset",
        recipient: RECIPIENT,
        url: `http://localhost:3202/reset-password#token=${TOKEN}RESET`,
      }),
      true,
    );
    assert.equal(
      recorder.record({
        kind: "invitation",
        recipient: RECIPIENT,
        url: `http://localhost:3202/accept-invitation#token=${TOKEN}INVITE`,
      }),
      true,
    );
    // A non-synthetic recipient is never recorded, so it cannot be parsed.
    assert.equal(
      recorder.record({
        kind: "verification",
        recipient: "someone@example.com",
        url: URL,
        code: CODE,
      }),
      false,
    );
    for (let index = 3; index < MAX_CAPTURED_MESSAGES + 2; index++)
      recorder.record({
        kind: "invitation",
        recipient: RECIPIENT,
        url: `http://localhost:3202/accept-invitation#token=${TOKEN}${index}`,
      });
    const text = readFileSync(file, "utf8");
    const records = parseCaptureRecords(text);
    assert.equal(records.length, MAX_CAPTURED_MESSAGES + 1);
    const summary = summarizeCapture(text);
    assert.equal(summary.messages, MAX_CAPTURED_MESSAGES);
    assert.equal(summary.overflow, true);
    assert.equal(summary.kinds.verification, 1);
    assert.equal(summary.kinds.password_reset, 1);
    assert.equal(summary.kinds.invitation, MAX_CAPTURED_MESSAGES - 2);

    // The same bytes through the full lifecycle: clean without a leak, caught with one.
    const clean = await run(parent, text, { logs: { "api.log": "ok" } });
    assert.equal(clean.error, undefined);
    assert.ok(clean.reports.includes("CAPTURE_LOG_SCAN:CLEAN"));
    assert.equal(clean.summary.scan, "COMPLETE");
    const leaking = await run(parent, text, {
      logs: { "web.log": `reset ${TOKEN}RESET` },
    });
    assert.ok(leaking.error instanceof CaptureStoreRefusal);
    assert.equal(leaking.error.reason, "SECRET_IN_RETAINED_LOG");
  });
});
