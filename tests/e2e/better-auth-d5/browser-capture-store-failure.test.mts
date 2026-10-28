import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
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
  CaptureStoreRefusal,
  defaultStoreDeps,
  readRetainedLogs,
  withPrivateCapture,
  type StoreDeps,
} from "./browser-capture-store.mts";

// R6: fail-closed capture scan and safe partial initialization. Deterministic
// fault injection through the store's injectable dependencies; synthetic data.
const SID = "S-1-5-21-1111111111-2222222222-3333333333-1001";
const CANARY = "CANARY-NOT-A-REAL-TOKEN-7f3a91c2d4e8";

async function scratchAsync<T>(operation: (directory: string) => Promise<T>) {
  const directory = mkdtempSync(join(tmpdir(), "stockwise-capture-failure-"));
  try {
    return await operation(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function fakeDeps(overrides: Partial<StoreDeps> = {}): StoreDeps {
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
    ...overrides,
  };
}

const captureDirectories = (parent: string) =>
  readdirSync(parent).filter((name) => name.startsWith("stack-capture-"));

const errnoError = (code: string) =>
  Object.assign(new Error(`cannot read ${CANARY}`), { code });

const reasonsOf = (error: AggregateError) =>
  error.errors.map((item) =>
    item instanceof CaptureStoreRefusal ? item.reason : "other",
  );

test("an empty readable capture is a valid clean scan; a readable one is scanned completely", async () => {
  await scratchAsync(async (parent) => {
    const lines: string[] = [];
    const summaryPath = join(parent, "capture-summary.json");
    await withPrivateCapture(
      {
        parent,
        deps: fakeDeps(),
        summaryPath,
        report: (line) => lines.push(line),
      },
      async () => undefined,
    );
    assert.ok(lines.includes("CAPTURE_LOG_SCAN:CLEAN"));
    assert.deepEqual(JSON.parse(readFileSync(summaryPath, "utf8")), {
      scan: "COMPLETE",
      messages: 0,
      kinds: {},
      overflow: false,
    });
    const filled: string[] = [];
    await assert.rejects(
      withPrivateCapture(
        {
          parent,
          deps: fakeDeps(),
          summaryPath,
          retainedLogs: () => ({ "api.log": "contains 482913 here" }),
          report: (line) => filled.push(line),
        },
        async (capture) =>
          writeFileSync(
            capture.file,
            `${JSON.stringify({
              seq: 1,
              at: "2026-10-27T00:00:00.000Z",
              kind: "verification",
              recipient: "d5br-x@example.invalid",
              url: "http://localhost:3202/verify-email#token=SYNTHETICNOTAREALTOKEN",
              code: "482913",
            })}\n`,
          ),
      ),
      /SECRET_IN_RETAINED_LOG/,
    );
    assert.ok(filled.includes("CAPTURE_LOG_SCAN:LEAK"));
    assert.equal(
      JSON.parse(readFileSync(summaryPath, "utf8")).scan,
      "COMPLETE",
    );
  });
});

test("a capture that cannot be read is never a clean scan, yet is still destroyed", async () => {
  await scratchAsync(async (parent) => {
    for (const code of ["EPERM", "EACCES", "EIO", "ENOENT"]) {
      const lines: string[] = [];
      const summaryPath = join(parent, "capture-summary.json");
      let produced = false;
      const outcome = await withPrivateCapture(
        {
          parent,
          deps: fakeDeps(),
          summaryPath,
          readCapture: () => {
            throw errnoError(code);
          },
          report: (line) => lines.push(line),
        },
        async (capture) => {
          writeFileSync(
            capture.file,
            `{"kind":"password_reset","url":"x#token=${CANARY}"}\n`,
          );
          produced = true;
          return "body-result";
        },
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      assert.ok(produced, code);
      assert.ok(outcome instanceof CaptureStoreRefusal, `${code}: must fail`);
      assert.equal(outcome.reason, "CAPTURE_UNREADABLE", code);
      assert.deepEqual(outcome.detail, [code]);
      assert.equal(lines.includes("CAPTURE_LOG_SCAN:CLEAN"), false, code);
      assert.ok(lines.includes("CAPTURE_LOG_SCAN:INCOMPLETE"), code);
      assert.ok(lines.includes("CAPTURE_CLEANUP:COMPLETE"), code);
      assert.deepEqual(captureDirectories(parent), [], code);
      // No zero-message "success" summary is published for an unverified scan.
      assert.deepEqual(JSON.parse(readFileSync(summaryPath, "utf8")), {
        scan: "INCOMPLETE",
      });
      assert.equal(
        JSON.stringify([outcome.message, outcome.detail]).includes(CANARY),
        false,
      );
    }
  });
});

test("an unreadable capture plus a failed cleanup keeps both failures without secrets", async () => {
  await scratchAsync(async (parent) => {
    const lines: string[] = [];
    const error = await withPrivateCapture(
      {
        parent,
        deps: fakeDeps(),
        readCapture: () => {
          throw errnoError("EPERM");
        },
        report: (line) => lines.push(line),
      },
      async (capture) => {
        writeFileSync(join(capture.directory, "stray.txt"), "keep");
      },
    ).catch((e: unknown) => e);
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(reasonsOf(error).sort(), [
      "CAPTURE_UNREADABLE",
      "UNEXPECTED_ENTRY",
    ]);
    assert.ok(lines.includes("CAPTURE_LOG_SCAN:INCOMPLETE"));
    assert.ok(lines.includes("CAPTURE_CLEANUP:FAILED"));
    assert.equal(lines.includes("CAPTURE_LOG_SCAN:CLEAN"), false);
    assert.equal(
      JSON.stringify(error.errors.map((item) => String(item))).includes(CANARY),
      false,
    );
  });
});

test("an original failure survives an unreadable capture and a successful cleanup", async () => {
  await scratchAsync(async (parent) => {
    const error = await withPrivateCapture(
      {
        parent,
        deps: fakeDeps(),
        readCapture: () => {
          throw errnoError("EACCES");
        },
      },
      async () => {
        throw new Error("journey assertion failed");
      },
    ).catch((e: unknown) => e);
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(
      error.errors.map((item) =>
        item instanceof CaptureStoreRefusal ? item.reason : String(item),
      ),
      ["Error: journey assertion failed", "CAPTURE_UNREADABLE"],
    );
    assert.deepEqual(captureDirectories(parent), []);
  });
});

test("unreadable retained logs are an incomplete scan; only an absent log is ignored", async () => {
  await scratchAsync(async (parent) => {
    const lines: string[] = [];
    const error = await withPrivateCapture(
      {
        parent,
        deps: fakeDeps(),
        retainedLogs: () => {
          throw errnoError("EACCES");
        },
        report: (line) => lines.push(line),
      },
      async () => undefined,
    ).catch((e: unknown) => e);
    assert.ok(error instanceof CaptureStoreRefusal);
    assert.equal(error.reason, "RETAINED_LOG_UNREADABLE");
    assert.equal(lines.includes("CAPTURE_LOG_SCAN:CLEAN"), false);
    assert.deepEqual(captureDirectories(parent), []);

    writeFileSync(join(parent, "api.log"), "present");
    assert.deepEqual(readRetainedLogs(parent, ["api.log", "web.log"]), {
      "api.log": "present",
    });
    assert.throws(
      () =>
        readRetainedLogs(parent, ["api.log"], () => {
          throw errnoError("EPERM");
        }),
      (e: unknown) => (e as NodeJS.ErrnoException).code === "EPERM",
    );
  });
});

test("a failed initialization removes exactly the directory it created, and the next start succeeds", async () => {
  await scratchAsync(async (parent) => {
    writeFileSync(join(parent, "notes.txt"), "keep");
    mkdirSync(join(parent, "keepme"));
    writeFileSync(join(parent, "keepme", "data.txt"), "keep");
    const failures: [string, Partial<StoreDeps>, RegExp][] = [
      [
        "ACL setup",
        {
          protectDirectory: () => {
            throw new Error("INJECTED_ACL_SETUP_FAILURE");
          },
        },
        /INJECTED_ACL_SETUP_FAILURE/,
      ],
      [
        "marker creation",
        {
          now: () => {
            throw new Error("INJECTED_MARKER_FAILURE");
          },
        },
        /INJECTED_MARKER_FAILURE/,
      ],
      [
        "validation read-back",
        { readSddl: () => "D:AI(A;OICI;FA;;;WD)" },
        /ACL_NOT_PRIVATE/,
      ],
    ];
    for (const [label, override, expected] of failures) {
      await assert.rejects(
        withPrivateCapture({ parent, deps: fakeDeps(override) }, async () =>
          assert.fail("body must not run"),
        ),
        expected,
        label,
      );
      assert.deepEqual(captureDirectories(parent), [], label);
      // The next normal start is not blocked by anything left behind.
      await withPrivateCapture(
        { parent, deps: fakeDeps() },
        async () => undefined,
      );
      assert.deepEqual(captureDirectories(parent), [], label);
    }
    assert.equal(readFileSync(join(parent, "notes.txt"), "utf8"), "keep");
    assert.equal(
      readFileSync(join(parent, "keepme", "data.txt"), "utf8"),
      "keep",
    );
  });
});

test("a marker that cannot be written still cleans up, and a file failure after the marker does too", async () => {
  await scratchAsync(async (parent) => {
    // The marker path is taken by something else: creation (wx) fails, and the
    // fresh directory is no longer empty, so it is reported and kept.
    const error = await withPrivateCapture(
      {
        parent,
        deps: fakeDeps({
          protectDirectory: (directory) =>
            mkdirSync(join(directory, "owner.json")),
        }),
      },
      async () => undefined,
    ).catch((e: unknown) => e);
    assert.ok(error instanceof AggregateError);
    assert.ok(reasonsOf(error).includes("CLEANUP_REFUSED_POPULATED"));
    const [kept] = captureDirectories(parent);
    assert.ok(kept);
    assert.equal(
      lstatSync(join(parent, kept, "owner.json")).isDirectory(),
      true,
    );
    rmSync(join(parent, kept), { recursive: true });

    // Marker written, then the file-level read-back fails: both are removed.
    let calls = 0;
    await assert.rejects(
      withPrivateCapture(
        {
          parent,
          deps: fakeDeps({
            readSddl: (path) => {
              calls++;
              if (lstatSync(path).isDirectory())
                return `D:P(A;OICI;FA;;;${SID})`;
              return "D:AI(A;ID;FA;;;WD)";
            },
          }),
        },
        async () => assert.fail("body must not run"),
      ),
      /ACL_NOT_PRIVATE/,
    );
    assert.ok(calls >= 2);
    assert.deepEqual(captureDirectories(parent), []);
  });
});

test("partial-initialization cleanup refuses a populated, replaced or linked directory and reports it", async () => {
  await scratchAsync(async (parent) => {
    const failWith = (
      setup: (directory: string) => void,
    ): Partial<StoreDeps> => ({
      protectDirectory: (directory) => {
        setup(directory);
        throw new Error("INJECTED_ACL_SETUP_FAILURE");
      },
    });
    const refused = (error: unknown, reason: string) => {
      assert.ok(error instanceof AggregateError);
      assert.match(String(error.errors[0]), /INJECTED_ACL_SETUP_FAILURE/);
      assert.ok(reasonsOf(error).includes(reason), reasonsOf(error).join());
    };

    // 1. Another actor put a file in the fresh directory: not ours, kept.
    let error = await withPrivateCapture(
      {
        parent,
        deps: fakeDeps(
          failWith((directory) =>
            writeFileSync(join(directory, "foreign.txt"), "theirs"),
          ),
        ),
      },
      async () => undefined,
    ).catch((e: unknown) => e);
    refused(error, "CLEANUP_REFUSED_POPULATED");
    const [populated] = captureDirectories(parent);
    assert.ok(populated);
    assert.equal(
      readFileSync(join(parent, populated, "foreign.txt"), "utf8"),
      "theirs",
    );
    // Genuinely suspicious leftovers stay strictly refused on the next start.
    const blocked = await withPrivateCapture(
      { parent, deps: fakeDeps() },
      async () => 1,
    ).catch((e: unknown) => e);
    assert.ok(blocked instanceof CaptureStoreRefusal);
    assert.equal(blocked.reason, "STALE_ARTIFACT_PRESENT");
    rmSync(join(parent, populated), { recursive: true });

    // 2. The directory was swapped for a junction to someone else's directory.
    const victim = join(parent, "victim");
    mkdirSync(victim);
    writeFileSync(join(victim, "precious.txt"), "keep");
    error = await withPrivateCapture(
      {
        parent,
        deps: fakeDeps(
          failWith((directory) => {
            rmSync(directory, { recursive: true });
            symlinkSync(victim, directory, "junction");
          }),
        ),
      },
      async () => undefined,
    ).catch((e: unknown) => e);
    refused(error, "CLEANUP_REFUSED_REPLACED");
    assert.equal(readFileSync(join(victim, "precious.txt"), "utf8"), "keep");
    for (const name of captureDirectories(parent))
      rmSync(join(parent, name), { recursive: true });

    // 3. Replaced by a different (empty) directory: identity changed, kept.
    error = await withPrivateCapture(
      {
        parent,
        deps: fakeDeps(
          failWith((directory) => {
            rmSync(directory, { recursive: true });
            mkdirSync(directory);
          }),
        ),
      },
      async () => undefined,
    ).catch((e: unknown) => e);
    refused(error, "CLEANUP_REFUSED_REPLACED");
    assert.equal(captureDirectories(parent).length, 1);
  });
});

// Codex's R5 probes, reproduced with the real Windows ACL tooling (no fakes).
const onWindows = process.platform === "win32";

test(
  "real ACL: a capture whose read really fails with a permission error is never CLEAN",
  { skip: !onWindows },
  async () => {
    await scratchAsync(async (parent) => {
      const sid = defaultStoreDeps.currentUserSid();
      const lines: string[] = [];
      const error = await withPrivateCapture(
        { parent, report: (line) => lines.push(line) },
        async (capture) => {
          writeFileSync(
            capture.file,
            `{"kind":"password_reset","url":"x#token=${CANARY}"}\n`,
          );
          // Write/Delete only: reading now fails, deleting still works.
          execFileSync(
            join(
              process.env.SystemRoot ?? "C:/Windows",
              "System32",
              "icacls.exe",
            ),
            [capture.file, "/inheritance:r", "/grant:r", `*${sid}:(W,D)`],
            { stdio: "ignore", windowsHide: true },
          );
        },
      ).catch((e: unknown) => e);
      assert.ok(error instanceof CaptureStoreRefusal);
      assert.equal(error.reason, "CAPTURE_UNREADABLE");
      assert.match(error.detail[0] ?? "", /^(EPERM|EACCES)$/);
      assert.equal(lines.includes("CAPTURE_LOG_SCAN:CLEAN"), false);
      assert.ok(lines.includes("CAPTURE_LOG_SCAN:INCOMPLETE"));
      assert.ok(lines.includes("CAPTURE_CLEANUP:COMPLETE"));
      assert.deepEqual(captureDirectories(parent), []);
      assert.equal(
        JSON.stringify([error.message, error.detail]).includes(CANARY),
        false,
      );
    });
  },
);

test(
  "real ACL: a failure after real protection but before the marker leaves nothing and does not block the next start",
  { skip: !onWindows },
  async () => {
    await scratchAsync(async (parent) => {
      await assert.rejects(
        withPrivateCapture(
          {
            parent,
            deps: {
              ...defaultStoreDeps,
              protectDirectory(path, sid) {
                defaultStoreDeps.protectDirectory(path, sid);
                throw new Error("INJECTED_SETUP_FAILURE");
              },
            },
          },
          async () => assert.fail("body must not run"),
        ),
        /INJECTED_SETUP_FAILURE/,
      );
      assert.deepEqual(captureDirectories(parent), []);
      await withPrivateCapture({ parent }, async () => undefined);
      assert.deepEqual(captureDirectories(parent), []);
    });
  },
);
