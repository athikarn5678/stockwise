import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  lstatSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CAPTURE_FILE_NAME,
  CaptureStoreRefusal,
  OWNER_FILE_NAME,
  assertPosixPrivate,
  assertPrivateCaptureFile,
  assertWindowsPrivate,
  cleanupStaleCaptures,
  createPrivateCaptureDirectory,
  defaultStoreDeps,
  destroyCaptureDirectory,
  parseSddl,
  scanForCapturedSecrets,
  summarizeCapture,
  withPrivateCapture,
  type StoreDeps,
} from "./browser-capture-store.mts";

const SID = "S-1-5-21-1111111111-2222222222-3333333333-1001";

// A capture line in exactly the shape the recorder writes (strict parser).
const captureLine = (fields: Record<string, unknown> = {}) =>
  `${JSON.stringify({
    seq: 1,
    at: "2026-10-27T00:00:00.000Z",
    kind: "verification",
    recipient: "d5br-x@example.invalid",
    url: "http://localhost:3202/verify-email#token=SYNTHETICNOTAREALTOKEN",
    ...fields,
  })}\n`;
const OTHER_SID = "S-1-5-21-1111111111-2222222222-3333333333-1002";

function scratch<T>(operation: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "stockwise-capture-store-"));
  try {
    return operation(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function scratchAsync<T>(operation: (directory: string) => Promise<T>) {
  const directory = mkdtempSync(join(tmpdir(), "stockwise-capture-store-"));
  try {
    return await operation(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

// Deterministic Windows-shaped dependencies: exercises the real create, verify,
// stale and destroy code without spawning PowerShell or icacls.
function fakeDeps(overrides: Partial<StoreDeps> = {}): StoreDeps {
  return {
    platform: "win32",
    currentUserSid: () => SID,
    readSddl: (path) =>
      lstatSync(path).isDirectory()
        ? `D:PAI(A;OICI;FA;;;${SID})`.replace("D:PAI", "D:P")
        : `D:AI(A;ID;FA;;;${SID})`,
    protectDirectory: () => undefined,
    currentUid: () => undefined,
    isProcessAlive: () => false,
    now: () => new Date("2026-10-27T00:00:00.000Z"),
    ...overrides,
  };
}

function refusal(action: () => unknown): CaptureStoreRefusal {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof CaptureStoreRefusal, String(error));
    return error;
  }
  throw new Error("Expected a capture-store refusal.");
}

const captureDirectories = (parent: string) =>
  readdirSync(parent).filter((name) => name.startsWith("stack-capture-"));

test("the real directory and file are private to the current user (Windows ACL / POSIX mode)", () => {
  scratch((parent) => {
    const capture = createPrivateCaptureDirectory(parent);
    if (process.platform === "win32") {
      const sid = defaultStoreDeps.currentUserSid();
      const directory = parseSddl(defaultStoreDeps.readSddl(capture.directory));
      assert.equal(directory.protectedDacl, true);
      assert.equal(directory.aces.length, 1);
      assert.equal(directory.aces[0]?.sid, sid);
      assert.equal(directory.aces[0]?.type, "A");
      const file = parseSddl(defaultStoreDeps.readSddl(capture.file));
      assert.equal(file.aces.length, 1);
      assert.equal(file.aces[0]?.sid, sid);
    } else {
      assert.equal(lstatSync(capture.directory).mode & 0o077, 0);
      assert.equal(lstatSync(capture.file).mode & 0o077, 0);
    }
    assert.deepEqual(
      readdirSync(capture.directory).sort(),
      [CAPTURE_FILE_NAME, OWNER_FILE_NAME].sort(),
    );
    assert.doesNotThrow(() => assertPrivateCaptureFile(capture.file));
    destroyCaptureDirectory(capture.directory);
    assert.equal(existsSync(capture.directory), false);
  });
});

test("permissions that are not private are refused (shared, extra, inherited, denied, other user)", () => {
  const good = `D:P(A;OICI;FA;;;${SID})`;
  assert.doesNotThrow(() => assertWindowsPrivate(good, SID, "directory"));
  assert.doesNotThrow(() =>
    assertWindowsPrivate(`D:AI(A;ID;FA;;;${SID})`, SID, "file"),
  );
  for (const sddl of [
    `D:P(A;OICI;FA;;;WD)`, // Everyone
    `D:P(A;OICI;FA;;;${OTHER_SID})`,
    `D:P(A;OICI;FA;;;${SID})(A;OICI;0x1200a9;;;BU)`, // extra reader
    `D:P(A;OICI;FA;;;${SID})(A;OICI;FA;;;SY)`,
    `D:AI(A;OICI;FA;;;${SID})`, // inheritance not blocked
    `D:P(D;OICI;FA;;;${SID})`, // deny only
    `D:P(A;OICIID;FA;;;${SID})`, // inherited entry on the directory
    `D:P`, // empty DACL
  ])
    assert.equal(
      refusal(() => assertWindowsPrivate(sddl, SID, "directory")).reason,
      "ACL_NOT_PRIVATE",
      sddl,
    );
  assert.equal(
    refusal(() => assertWindowsPrivate(`D:AI(A;ID;FA;;;WD)`, SID, "file"))
      .reason,
    "ACL_NOT_PRIVATE",
  );
  assert.equal(refusal(() => parseSddl("garbage")).reason, "ACL_UNREADABLE");
  // POSIX equivalents.
  assert.doesNotThrow(() =>
    assertPosixPrivate({ mode: 0o40700, uid: 1000 }, 1000, "directory"),
  );
  assert.equal(
    refusal(() =>
      assertPosixPrivate({ mode: 0o40755, uid: 1000 }, 1000, "directory"),
    ).reason,
    "MODE_NOT_PRIVATE",
  );
  assert.equal(
    refusal(() =>
      assertPosixPrivate({ mode: 0o100600, uid: 1001 }, 1000, "file"),
    ).reason,
    "OWNER_NOT_CURRENT_USER",
  );
});

test("unsafe capture locations are refused, including links to shared directories", () => {
  scratch((parent) => {
    const deps = fakeDeps();
    assert.equal(
      refusal(() => createPrivateCaptureDirectory("relative/path", deps))
        .reason,
      "LOCATION_NOT_ABSOLUTE",
    );
    assert.equal(
      refusal(() =>
        createPrivateCaptureDirectory(join(parent, "missing"), deps),
      ).reason,
      "LOCATION_MISSING",
    );
    const plainFile = join(parent, "a-file");
    writeFileSync(plainFile, "x");
    assert.equal(
      refusal(() => createPrivateCaptureDirectory(plainFile, deps)).reason,
      "LOCATION_NOT_PLAIN_DIRECTORY",
    );
    // A junction/symlink as the parent could redirect storage to a shared place.
    const shared = join(parent, "shared");
    mkdirSync(shared);
    const link = join(parent, "link-to-shared");
    symlinkSync(shared, link, "junction");
    assert.equal(
      refusal(() => createPrivateCaptureDirectory(link, deps)).reason,
      "LOCATION_NOT_PLAIN_DIRECTORY",
    );
    assert.deepEqual(readdirSync(shared), []);
    // A capture file outside a launcher-created capture directory.
    writeFileSync(join(parent, CAPTURE_FILE_NAME), "");
    assert.equal(
      refusal(() =>
        assertPrivateCaptureFile(join(parent, CAPTURE_FILE_NAME), deps),
      ).reason,
      "LOCATION_NOT_CAPTURE_DIRECTORY",
    );
    assert.equal(
      refusal(() => assertPrivateCaptureFile(join(parent, "mail.jsonl"), deps))
        .reason,
      "CAPTURE_FILE_INVALID",
    );
    // A capture directory that is itself a link to someone else's directory.
    const victim = join(parent, "victim");
    mkdirSync(victim);
    writeFileSync(join(victim, CAPTURE_FILE_NAME), "owned by someone else");
    const disguised = join(parent, `stack-capture-${"a".repeat(32)}`);
    symlinkSync(victim, disguised, "junction");
    assert.equal(
      refusal(() =>
        assertPrivateCaptureFile(join(disguised, CAPTURE_FILE_NAME), deps),
      ).reason,
      "LOCATION_NOT_PLAIN_DIRECTORY",
    );
    assert.equal(
      refusal(() => destroyCaptureDirectory(disguised, deps)).reason,
      "LOCATION_NOT_PLAIN_DIRECTORY",
    );
    assert.equal(
      readFileSync(join(victim, CAPTURE_FILE_NAME), "utf8"),
      "owned by someone else",
    );
    // The permission check runs on a directory that is not private.
    const open = createPrivateCaptureDirectory(parent, deps);
    assert.equal(
      refusal(() =>
        assertPrivateCaptureFile(
          open.file,
          fakeDeps({ readSddl: () => "D:AI(A;OICI;FA;;;WD)" }),
        ),
      ).reason,
      "ACL_NOT_PRIVATE",
    );
    destroyCaptureDirectory(open.directory, deps);
  });
});

test("captured messages are removed after a normal run, leaving counts only", async () => {
  await scratchAsync(async (parent) => {
    const lines: string[] = [];
    const summaryPath = join(parent, "capture-summary.json");
    let captured = "";
    await withPrivateCapture(
      {
        parent,
        deps: fakeDeps(),
        summaryPath,
        report: (line) => lines.push(line),
      },
      async (capture) => {
        captured = capture.file;
        writeFileSync(
          capture.file,
          `${captureLine({ recipient: "d5br-a@example.invalid", url: "http://localhost:3202/verify-email?token=ABCDEFGHIJKLMNOPQRSTUV", code: "482913" })}${captureLine({ seq: 2, kind: "password_reset", recipient: "d5br-a@example.invalid", url: "http://localhost:3202/reset-password#token=ZYXWVUTSRQPONMLKJIHGFE" })}`,
        );
      },
    );
    assert.equal(existsSync(captured), false);
    assert.deepEqual(captureDirectories(parent), []);
    assert.deepEqual(lines, [
      "CAPTURE_LOG_SCAN:CLEAN",
      "CAPTURE_CLEANUP:COMPLETE",
    ]);
    const summary = readFileSync(summaryPath, "utf8");
    assert.deepEqual(JSON.parse(summary), {
      scan: "COMPLETE",
      messages: 2,
      kinds: { verification: 1, password_reset: 1 },
      overflow: false,
    });
    for (const secret of [
      "482913",
      "ABCDEFGH",
      "ZYXWVUTS",
      "example.invalid",
      "token",
    ])
      assert.equal(summary.includes(secret), false, secret);
  });
});

test("cleanup runs after a startup failure, a test failure and a controlled interruption", async () => {
  await scratchAsync(async (parent) => {
    const deps = fakeDeps();
    for (const [label, body] of [
      [
        "startup failure",
        async () => {
          throw new Error("startup failed before any mail");
        },
      ],
      [
        "test failure after credentials were written",
        async (capture: { file: string }) => {
          writeFileSync(
            capture.file,
            captureLine({
              kind: "password_reset",
              recipient: "d5br-b@example.invalid",
              url: "http://localhost:3202/reset-password#token=QQQQWWWWEEEERRRR1234",
            }),
          );
          throw new Error("assertion failed in a journey");
        },
      ],
      [
        "interruption",
        async (capture: { file: string }) => {
          const controller = new AbortController();
          setImmediate(() => controller.abort());
          await new Promise((_resolve, reject) =>
            controller.signal.addEventListener("abort", () => {
              writeFileSync(capture.file, captureLine({ kind: "invitation" }));
              reject(new Error("INTERRUPTED"));
            }),
          );
        },
      ],
    ] as const) {
      const lines: string[] = [];
      await assert.rejects(
        withPrivateCapture(
          { parent, deps, report: (line) => lines.push(line) },
          body,
        ),
        /startup failed|assertion failed|INTERRUPTED/,
        label,
      );
      assert.deepEqual(captureDirectories(parent), [], label);
      assert.ok(lines.includes("CAPTURE_CLEANUP:COMPLETE"), label);
    }
  });
});

test("stale artifacts of an interrupted owned run are removed, or the start is refused without deleting anything else", async () => {
  await scratchAsync(async (parent) => {
    const dead = fakeDeps({ isProcessAlive: () => false });
    // An earlier run was hard-killed after it recorded a credential.
    const killed = createPrivateCaptureDirectory(parent, dead);
    writeFileSync(killed.file, '{"seq":1,"kind":"password_reset"}\n');
    // Unrelated neighbours that must survive everything below.
    writeFileSync(join(parent, "notes.txt"), "keep");
    mkdirSync(join(parent, "keepme"));
    writeFileSync(join(parent, "keepme", "data.txt"), "keep");
    mkdirSync(join(parent, "stack-capture-not-ours"));
    writeFileSync(join(parent, "stack-capture-not-ours", "x"), "keep");
    const survivors = () =>
      assert.deepEqual(
        [
          readFileSync(join(parent, "notes.txt"), "utf8"),
          readFileSync(join(parent, "keepme", "data.txt"), "utf8"),
          readFileSync(join(parent, "stack-capture-not-ours", "x"), "utf8"),
        ],
        ["keep", "keep", "keep"],
      );

    assert.deepEqual(
      cleanupStaleCaptures(parent, dead).map((item) => item.status),
      ["REMOVED"],
    );
    assert.equal(existsSync(killed.directory), false);
    survivors();

    // The owning process is still alive: reported, never deleted, start refused.
    const alive = createPrivateCaptureDirectory(parent, dead);
    const aliveDeps = fakeDeps({ isProcessAlive: () => true });
    let error = await withPrivateCapture(
      { parent, deps: aliveDeps },
      async () => 1,
    ).catch((e: unknown) => e);
    assert.ok(error instanceof CaptureStoreRefusal);
    assert.equal(error.reason, "STALE_ARTIFACT_PRESENT");
    assert.equal(existsSync(alive.file), true);
    destroyCaptureDirectory(alive.directory, dead);

    // A capture-shaped directory without a valid marker is not ours: left alone.
    const unowned = join(parent, `stack-capture-${"b".repeat(32)}`);
    mkdirSync(unowned);
    writeFileSync(join(unowned, CAPTURE_FILE_NAME), "someone else's file");
    error = await withPrivateCapture(
      { parent, deps: dead },
      async () => 1,
    ).catch((e: unknown) => e);
    assert.ok(error instanceof CaptureStoreRefusal);
    assert.deepEqual(error.detail, [`UNOWNED:stack-capture-${"b".repeat(32)}`]);
    assert.equal(
      readFileSync(join(unowned, CAPTURE_FILE_NAME), "utf8"),
      "someone else's file",
    );
    rmSync(unowned, { recursive: true });

    // A marked directory holding a file we never wrote: credentials go, the file stays.
    const mixed = createPrivateCaptureDirectory(parent, dead);
    writeFileSync(
      mixed.file,
      '{"seq":1,"kind":"verification","code":"111111"}\n',
    );
    writeFileSync(join(mixed.directory, "user-notes.txt"), "mine");
    assert.deepEqual(
      cleanupStaleCaptures(parent, dead).map((item) => item.status),
      ["FAILED"],
    );
    assert.equal(existsSync(mixed.file), false);
    assert.equal(
      readFileSync(join(mixed.directory, "user-notes.txt"), "utf8"),
      "mine",
    );
    assert.equal(existsSync(join(mixed.directory, OWNER_FILE_NAME)), true);
    survivors();
  });
});

test("unowned or unexpected paths are never deleted by destruction, and failures are explicit", async () => {
  await scratchAsync(async (parent) => {
    const deps = fakeDeps();
    const victim = join(parent, "important");
    mkdirSync(victim);
    writeFileSync(join(victim, "file.txt"), "keep");
    assert.equal(
      refusal(() => destroyCaptureDirectory(victim, deps)).reason,
      "LOCATION_NOT_CAPTURE_DIRECTORY",
    );
    const shaped = join(parent, `stack-capture-${"c".repeat(32)}`);
    mkdirSync(shaped);
    writeFileSync(join(shaped, "file.txt"), "keep");
    assert.equal(
      refusal(() => destroyCaptureDirectory(shaped, deps)).reason,
      "NOT_OWNED",
    );
    assert.equal(readFileSync(join(shaped, "file.txt"), "utf8"), "keep");
    assert.equal(readFileSync(join(victim, "file.txt"), "utf8"), "keep");
    rmSync(shaped, { recursive: true });
    // A cleanup that cannot finish is reported, never mistaken for success.
    const lines: string[] = [];
    await assert.rejects(
      withPrivateCapture(
        { parent, deps, report: (line) => lines.push(line) },
        async (capture) => {
          writeFileSync(join(capture.directory, "stray.txt"), "keep");
        },
      ),
      (error: unknown) =>
        error instanceof CaptureStoreRefusal &&
        error.reason === "UNEXPECTED_ENTRY",
    );
    assert.ok(lines.includes("CAPTURE_CLEANUP:FAILED"));
    assert.equal(lines.includes("CAPTURE_CLEANUP:COMPLETE"), false);
    const [leftover] = captureDirectories(parent).filter(
      (name) =>
        /^stack-capture-[a-f0-9]{32}$/.test(name) &&
        existsSync(join(parent, name, "stray.txt")),
    );
    assert.ok(leftover);
    assert.equal(existsSync(join(parent, leftover, CAPTURE_FILE_NAME)), false);
    assert.equal(
      readFileSync(join(parent, leftover, "stray.txt"), "utf8"),
      "keep",
    );
  });
});

test("captured secrets in retained logs are detected without printing them, and the capture is still destroyed", async () => {
  const token = "TOKENVALUE0123456789abcd";
  const capture = captureLine({
    code: "482913",
    url: `http://localhost:3202/verify-email?token=${token}`,
  });
  assert.deepEqual(
    scanForCapturedSecrets(capture, {
      "api.log": '{"time":1748291300000,"msg":"ok"}',
      "web.log": "ready",
    }),
    [],
  );
  const findings = scanForCapturedSecrets(capture, {
    "api.log": `GET http://localhost:3202/verify-email?token=${token}`,
    "web.log": "code 482913 sent",
  });
  assert.deepEqual(
    findings.map((item) => `${item.log}:${item.kind}`).sort(),
    ["api.log:link", "api.log:link-token", "web.log:otp"].sort(),
  );
  assert.equal(JSON.stringify(findings).includes(token), false);
  assert.equal(JSON.stringify(findings).includes("482913"), false);
  // Digits that merely contain the code (timestamps, ids) are not a leak.
  assert.deepEqual(
    scanForCapturedSecrets(capture, { "api.log": "1748291300000 x4829137" }),
    [],
  );

  await scratchAsync(async (parent) => {
    const lines: string[] = [];
    await assert.rejects(
      withPrivateCapture(
        {
          parent,
          deps: fakeDeps(),
          retainedLogs: () => ({ "api.log": `leaked ${token}` }),
          report: (line) => lines.push(line),
        },
        async (store) => writeFileSync(store.file, capture),
      ),
      (error: unknown) => {
        assert.ok(error instanceof CaptureStoreRefusal);
        assert.equal(error.reason, "SECRET_IN_RETAINED_LOG");
        assert.equal(
          JSON.stringify([error.message, error.detail]).includes(token),
          false,
        );
        return true;
      },
    );
    assert.deepEqual(captureDirectories(parent), []);
    assert.ok(lines.includes("CAPTURE_LOG_SCAN:LEAK"));
    assert.ok(lines.includes("CAPTURE_CLEANUP:COMPLETE"));
  });
});

test("summaries count kinds only", () => {
  assert.deepEqual(
    summarizeCapture(
      `${captureLine({ kind: "invitation" })}{"overflow":true}\n`,
    ),
    { messages: 1, kinds: { invitation: 1 }, overflow: true },
  );
});
