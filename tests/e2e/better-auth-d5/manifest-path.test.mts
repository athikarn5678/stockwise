import assert from "node:assert/strict";
import { test } from "node:test";
import {
  externalManifestPath,
  writeExternalManifest,
} from "./manifest-path.mts";
import { mkdir, mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("manifest destination containment is segment-aware across Windows drives", () => {
  const root = "C:\\work\\stockwise";
  assert.equal(
    externalManifestPath(root, "C:\\work\\evidence\\result.json", "win32"),
    "C:\\work\\evidence\\result.json",
  );
  assert.equal(
    externalManifestPath(root, "D:\\evidence\\result.json", "win32"),
    "D:\\evidence\\result.json",
  );
  assert.equal(
    externalManifestPath(root, "C:\\work\\stockwise2\\result.json", "win32"),
    "C:\\work\\stockwise2\\result.json",
  );
  assert.throws(
    () =>
      externalManifestPath(root, "C:\\work\\stockwise\\result.json", "win32"),
    /EXTERNAL_EVIDENCE_PATH_REQUIRED/,
  );
  assert.throws(
    () =>
      externalManifestPath(
        root,
        "C:\\work\\stockwise\\..receipt.json",
        "win32",
      ),
    /EXTERNAL_EVIDENCE_PATH_REQUIRED/,
  );
  for (const destination of [
    "relative.json",
    "C:relative.json",
    "\\\\server\\share\\x.json",
    "\\?\\C:\\x.json",
    "C:\\work\\out.json:stream",
    "C:/work/out.json",
    "C:\\work\\..\\stockwise\\x.json",
    "C:\\work\\outside\n.json",
    "C:\\work\\outside.txt",
    "C:\\work\\CON.json",
    "C:\\work\\bad. \\x.json",
    "C:\\work\\.\\x.json",
    "D:\\evidence\\bad?.json",
  ]) {
    assert.throws(
      () => externalManifestPath(root, destination, "win32"),
      /EXTERNAL_EVIDENCE_PATH_REQUIRED/,
      destination,
    );
  }
  for (const invalidRoot of [
    "relative\\repo",
    "C:repo",
    "\\\\server\\share\\repo",
    "C:\\work\\CON\\repo",
    "C:\\work\\repo. ",
  ]) {
    assert.throws(
      () =>
        externalManifestPath(invalidRoot, "D:\\evidence\\result.json", "win32"),
      /EXTERNAL_EVIDENCE_PATH_REQUIRED/,
      invalidRoot,
    );
  }
});

test("POSIX manifest destinations reject internal paths and ambiguous syntax", () => {
  assert.equal(
    externalManifestPath("/work/repo", "/work/evidence/result.json", "posix"),
    "/work/evidence/result.json",
  );
  assert.equal(
    externalManifestPath("/work/repo", "/work/repo2/file.json", "posix"),
    "/work/repo2/file.json",
  );
  assert.throws(
    () =>
      externalManifestPath("/work/repo", "/work/repo/..receipt.json", "posix"),
    /EXTERNAL_EVIDENCE_PATH_REQUIRED/,
  );
  for (const destination of [
    "relative.json",
    "/work/repo/file.json",
    "//server/share/file.json",
    "/work/out.json:stream",
    "/work/out\\file.json",
    "/work/../work/repo/a.json",
    "/work/./outside.json",
  ]) {
    assert.throws(
      () => externalManifestPath("/work/repo", destination, "posix"),
      /EXTERNAL_EVIDENCE_PATH_REQUIRED/,
      destination,
    );
  }
});

test("manifest writes pin a real external parent and reject aliasing or replacement", async () => {
  if (process.platform !== "linux") {
    await assert.rejects(
      writeExternalManifest("/repo", "/evidence/result.json", "{}"),
      /SAFE_MANIFEST_UNSUPPORTED_PLATFORM/,
    );
    return;
  }
  const base = await mkdtemp(join(tmpdir(), "d5-manifest-parent-"));
  try {
    const repository = join(base, "repository");
    const evidence = join(base, "evidence");
    await mkdir(repository);
    await mkdir(evidence);
    const destination = join(evidence, "result.json");
    await writeExternalManifest(repository, destination, "{}");
    assert.equal(await readFile(destination, "utf8"), "{}");
    assert.equal((await stat(destination)).mode & 0o777, 0o600);
    await assert.rejects(
      writeExternalManifest(repository, destination, '{"overwrite":true}'),
    );
    assert.equal(await readFile(destination, "utf8"), "{}");
    const alias = join(base, "alias");
    await symlink(evidence, alias, "dir");
    await assert.rejects(
      writeExternalManifest(repository, join(alias, "via-link.json"), "{}"),
    );
    await assert.rejects(readFile(join(evidence, "via-link.json")), {
      code: "ENOENT",
    });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
