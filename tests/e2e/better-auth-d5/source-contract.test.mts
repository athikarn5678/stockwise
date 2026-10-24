import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  captureVerifiedSnapshot,
  digest,
  hashSourceFiles,
  snapshotArchive,
  snapshotManifest,
} from "./source-contract.mts";

test("verified snapshot owns immutable bytes and copied manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "d5-snapshot-"));
  try {
    await mkdir(join(root, "apps/api"), { recursive: true });
    const file = join(root, "apps/api/source.ts");
    const original = Buffer.from("approved source\n");
    await writeFile(file, original);
    const expected = [{ path: "apps/api/source.ts", sha256: digest(original) }];
    if (process.platform !== "linux") {
      await assert.rejects(
        captureVerifiedSnapshot(root, expected),
        /SAFE_SNAPSHOT_UNSUPPORTED_PLATFORM/,
      );
      await assert.rejects(
        hashSourceFiles(root, [expected[0]!.path]),
        /SAFE_SNAPSHOT_UNSUPPORTED_PLATFORM/,
      );
      return;
    }
    const snapshot = await captureVerifiedSnapshot(root, expected);
    const archive = snapshotArchive(snapshot);
    const manifest = snapshotManifest(snapshot);
    manifest[0]!.sha256 = "0".repeat(64);
    archive.fill(0);
    await writeFile(file, "changed after snapshot\n");
    const stableArchive = snapshotArchive(snapshot);
    assert.notDeepEqual(stableArchive, archive);
    assert.deepEqual(snapshotManifest(snapshot), expected);
    assert.ok(stableArchive.includes(original));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verified snapshot rejects a source symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "d5-snapshot-link-"));
  try {
    const expected = [
      { path: "apps/api/source.ts", sha256: digest("not approved") },
    ];
    if (process.platform !== "linux") {
      await assert.rejects(
        captureVerifiedSnapshot(root, expected),
        /SAFE_SNAPSHOT_UNSUPPORTED_PLATFORM/,
      );
      return;
    }
    await mkdir(join(root, "apps/api"), { recursive: true });
    await writeFile(join(root, "outside.ts"), "not approved");
    await symlink(join(root, "outside.ts"), join(root, "apps/api/source.ts"));
    await assert.rejects(captureVerifiedSnapshot(root, expected));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verified snapshot rejects a substituted regular source", async () => {
  const root = await mkdtemp(join(tmpdir(), "d5-snapshot-substitute-"));
  try {
    await mkdir(join(root, "apps/api"), { recursive: true });
    const file = join(root, "apps/api/source.ts");
    await writeFile(file, "approved version\n");
    const expected = [
      { path: "apps/api/source.ts", sha256: digest("approved version\n") },
    ];
    await writeFile(file, "substituted version\n");
    if (process.platform !== "linux") {
      await assert.rejects(
        captureVerifiedSnapshot(root, expected),
        /SAFE_SNAPSHOT_UNSUPPORTED_PLATFORM/,
      );
      return;
    }
    await assert.rejects(
      captureVerifiedSnapshot(root, expected),
      /SOURCE_MANIFEST_MISMATCH/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verified snapshot detects substitution after opening the anchored file", async () => {
  const root = await mkdtemp(join(tmpdir(), "d5-snapshot-race-"));
  try {
    const expected = [
      { path: "apps/api/source.ts", sha256: digest("approved version\n") },
    ];
    if (process.platform !== "linux") {
      await assert.rejects(
        captureVerifiedSnapshot(root, expected),
        /SAFE_SNAPSHOT_UNSUPPORTED_PLATFORM/,
      );
      return;
    }
    await mkdir(join(root, "apps/api"), { recursive: true });
    const file = join(root, "apps/api/source.ts");
    await writeFile(file, "approved version\n");
    await assert.rejects(
      captureVerifiedSnapshot(root, expected, {
        afterFileOpen: async () => {
          await rename(file, `${file}.original`);
          await writeFile(file, "substituted version\n");
        },
      }),
      /SOURCE_CHANGED_DURING_CAPTURE/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verified snapshot stays rooted when the source directory is substituted", async () => {
  const parent = await mkdtemp(join(tmpdir(), "d5-snapshot-root-race-"));
  const root = join(parent, "repository");
  const moved = join(parent, "repository-original");
  const alternate = join(parent, "alternate");
  try {
    const expected = [
      { path: "apps/api/source.ts", sha256: digest("approved version\n") },
    ];
    if (process.platform !== "linux") {
      await assert.rejects(
        captureVerifiedSnapshot(root, expected),
        /SAFE_SNAPSHOT_UNSUPPORTED_PLATFORM/,
      );
      return;
    }
    await mkdir(join(root, "apps/api"), { recursive: true });
    await mkdir(join(alternate, "apps/api"), { recursive: true });
    await writeFile(join(root, "apps/api/source.ts"), "approved version\n");
    await writeFile(
      join(alternate, "apps/api/source.ts"),
      "redirected version\n",
    );
    await assert.rejects(
      captureVerifiedSnapshot(root, expected, {
        afterRootOpen: async () => {
          await rename(root, moved);
          await symlink(alternate, root);
        },
      }),
      /SOURCE_CHANGED_DURING_CAPTURE/,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("verified snapshot rejects a substituted nested source directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "d5-snapshot-ancestor-race-"));
  const api = join(root, "apps/api");
  const original = join(root, "apps/api-original");
  const alternate = join(root, "alternate-api");
  try {
    const expected = [
      { path: "apps/api/source.ts", sha256: digest("approved version\n") },
    ];
    if (process.platform !== "linux") {
      await assert.rejects(
        captureVerifiedSnapshot(root, expected),
        /SAFE_SNAPSHOT_UNSUPPORTED_PLATFORM/,
      );
      return;
    }
    await mkdir(api, { recursive: true });
    await mkdir(alternate, { recursive: true });
    await writeFile(join(api, "source.ts"), "approved version\n");
    await writeFile(join(alternate, "source.ts"), "redirected version\n");
    await assert.rejects(
      captureVerifiedSnapshot(root, expected, {
        afterDirectoryOpen: async () => {
          await rename(api, original);
          await symlink(alternate, api);
        },
      }),
      /SOURCE_CHANGED_DURING_CAPTURE/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
