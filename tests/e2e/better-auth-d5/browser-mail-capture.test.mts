import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createPrivateCaptureDirectory,
  destroyCaptureDirectory,
} from "./browser-capture-store.mts";
import {
  MAX_CAPTURED_MESSAGES,
  MailCaptureRefusal,
  SYNTHETIC_RECIPIENT,
  admitCapture,
  createCaptureRecorder,
  installCapture,
} from "./browser-mail-capture.mts";

const receipt = {
  owner: "11111111-1111-4111-8111-111111111111",
  runId: "22222222-2222-4222-8222-222222222222",
  database: "stockwise_test",
  testDatabase: "stockwise_test_test",
  host: "127.0.0.1",
  port: "5432",
  marker: "A".repeat(43),
};

async function withDirectory<T>(operation: (directory: string) => Promise<T>) {
  const directory = await mkdtemp(join(tmpdir(), "stockwise-mail-capture-"));
  try {
    return await operation(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const admitted = (file: string) => ({
  STOCKWISE_BROWSER_MAIL_CAPTURE: "synthetic-only",
  STOCKWISE_RUNTIME_ENV: "test",
  STOCKWISE_EMAIL_PROVIDER: "non_delivery",
  DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/stockwise_test_test",
  STOCKWISE_LOCAL_DATABASE_RECEIPT: JSON.stringify(receipt),
  STOCKWISE_BROWSER_MAIL_CAPTURE_FILE: file,
});

function reasonOf(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof MailCaptureRefusal);
    return error.reason;
  }
  throw new Error("Expected a capture refusal.");
}

test("admits only an opted-in, receipt-bound, test-runtime non-delivery API", async () => {
  await withDirectory(async (directory) => {
    const capture = createPrivateCaptureDirectory(directory);
    const good = admitted(capture.file);
    assert.deepEqual(admitCapture(good), {
      file: good.STOCKWISE_BROWSER_MAIL_CAPTURE_FILE,
    });
    const refusals: [Record<string, string | undefined>, string][] = [
      [{ STOCKWISE_BROWSER_MAIL_CAPTURE: undefined }, "OPT_IN_REQUIRED"],
      [{ STOCKWISE_BROWSER_MAIL_CAPTURE: "all" }, "OPT_IN_REQUIRED"],
      [{ STOCKWISE_RUNTIME_ENV: "production" }, "RUNTIME_NOT_TEST"],
      [{ STOCKWISE_RUNTIME_ENV: "development" }, "RUNTIME_NOT_TEST"],
      [{ STOCKWISE_EMAIL_PROVIDER: "resend" }, "PROVIDER_NOT_NON_DELIVERY"],
      [{ RESEND_API_KEY: "re_synthetic" }, "DELIVERY_CREDENTIAL_PRESENT"],
      [{ STOCKWISE_LOCAL_DATABASE_RECEIPT: undefined }, "RECEIPT_MISSING"],
      [{ STOCKWISE_LOCAL_DATABASE_RECEIPT: "not json" }, "RECEIPT_MISSING"],
      [{ DATABASE_URL: undefined }, "DATABASE_URL_MISSING"],
      [{ DATABASE_URL: "not a url" }, "DATABASE_URL_INVALID"],
      // Right shape, wrong host/port/database: never a receipt-owned target.
      [
        { DATABASE_URL: "postgresql://u:p@10.0.0.4:5432/stockwise_test_test" },
        "RECEIPT_MISMATCH",
      ],
      [
        { DATABASE_URL: "postgresql://u:p@127.0.0.1:5433/stockwise_test_test" },
        "RECEIPT_MISMATCH",
      ],
      [
        { DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/production" },
        "RECEIPT_MISMATCH",
      ],
      [
        {
          STOCKWISE_LOCAL_DATABASE_RECEIPT: JSON.stringify({
            ...receipt,
            host: "10.0.0.4",
          }),
        },
        "RECEIPT_MISMATCH",
      ],
      [
        { STOCKWISE_BROWSER_MAIL_CAPTURE_FILE: undefined },
        "CAPTURE_FILE_INVALID",
      ],
      [
        { STOCKWISE_BROWSER_MAIL_CAPTURE_FILE: "mail.jsonl" },
        "CAPTURE_STORE_CAPTURE_FILE_INVALID",
      ],
      // Not inside a launcher-created private capture directory.
      [
        { STOCKWISE_BROWSER_MAIL_CAPTURE_FILE: join(directory, "mail.jsonl") },
        "CAPTURE_STORE_CAPTURE_FILE_INVALID",
      ],
      [
        {
          STOCKWISE_BROWSER_MAIL_CAPTURE_FILE: join(
            directory,
            "mail-capture.jsonl",
          ),
        },
        "CAPTURE_STORE_LOCATION_NOT_CAPTURE_DIRECTORY",
      ],
      [
        {
          STOCKWISE_BROWSER_MAIL_CAPTURE_FILE: join(
            directory,
            "stack-capture-" + "0".repeat(32),
            "mail-capture.jsonl",
          ),
        },
        "CAPTURE_STORE_LOCATION_MISSING",
      ],
    ];
    for (const [override, reason] of refusals)
      assert.equal(
        reasonOf(() => admitCapture({ ...good, ...override })),
        reason,
      );
    destroyCaptureDirectory(capture.directory);
  });
});

test("records synthetic recipients with exact fields and silently ignores everything else", async () => {
  await withDirectory(async (directory) => {
    const file = join(directory, "mail.jsonl");
    await writeFile(file, "");
    const recorder = createCaptureRecorder(
      file,
      undefined,
      () => new Date("2026-10-27T00:00:00.000Z"),
    );
    assert.equal(
      recorder.record({
        kind: "verification",
        recipient: "d5br-one@example.invalid",
        url: "http://localhost:3202/verify-email#token=abc",
        code: "123456",
      }),
      true,
    );
    assert.equal(
      recorder.record({
        kind: "password_reset",
        recipient: "d5br-one@example.invalid",
        url: "http://localhost:3202/reset-password#token=def",
      }),
      true,
    );
    for (const recipient of [
      "person@example.com",
      "d5br-one@example.com",
      "D5BR-one@example.invalid",
      "d5br-one@example.invalid.attacker.test",
      "x@d5br-one@example.invalid",
      "d5br-@example.invalid",
      "d5br-one@example.invalid\nBcc:real@example.com",
      "t02a-one@example.invalid",
    ])
      assert.equal(
        recorder.record({ kind: "invitation", recipient, url: "http://x" }),
        false,
        recipient,
      );
    const lines = (await readFile(file, "utf8")).trim().split("\n");
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[0]!), {
      seq: 1,
      at: "2026-10-27T00:00:00.000Z",
      kind: "verification",
      recipient: "d5br-one@example.invalid",
      url: "http://localhost:3202/verify-email#token=abc",
      code: "123456",
    });
    assert.equal("code" in JSON.parse(lines[1]!), false);
    const text = await readFile(file, "utf8");
    assert.equal(text.includes("example.com"), false);
    assert.equal(text.includes("attacker"), false);
  });
});

test("caps captured messages and marks the overflow once", async () => {
  const lines: string[] = [];
  const recorder = createCaptureRecorder("unused.jsonl", (_file, line) =>
    lines.push(line),
  );
  for (let index = 0; index < MAX_CAPTURED_MESSAGES + 25; index++)
    recorder.record({
      kind: "invitation",
      recipient: "d5br-cap@example.invalid",
      url: `http://localhost:3202/accept#${index}`,
    });
  assert.equal(lines.length, MAX_CAPTURED_MESSAGES + 1);
  assert.deepEqual(JSON.parse(lines.at(-1)!), { overflow: true });
});

test("installCapture replaces only send and resolves like non-delivery", async () => {
  const lines: string[] = [];
  const provider = {
    marker: "kept",
    send: async (message: { kind: string; recipient: string; url: string }) => {
      throw new Error(`original send must be replaced: ${message.kind}`);
    },
  };
  installCapture(
    provider,
    createCaptureRecorder("unused.jsonl", (_file, line) => lines.push(line)),
  );
  assert.equal(provider.marker, "kept");
  await provider.send({
    kind: "invitation",
    recipient: "d5br-a@example.invalid",
    url: "http://localhost:3202/a",
  });
  await provider.send({
    kind: "invitation",
    recipient: "real@example.com",
    url: "http://localhost:3202/b",
  });
  assert.equal(lines.length, 1);
});

test("the synthetic recipient pattern is anchored and bounded", () => {
  assert.equal(SYNTHETIC_RECIPIENT.test("d5br-a@example.invalid"), true);
  assert.equal(
    SYNTHETIC_RECIPIENT.test(`d5br-${"a".repeat(41)}@example.invalid`),
    true,
  );
  assert.equal(
    SYNTHETIC_RECIPIENT.test(`d5br-${"a".repeat(42)}@example.invalid`),
    false,
  );
});
