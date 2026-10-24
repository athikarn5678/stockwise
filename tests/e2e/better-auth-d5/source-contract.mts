import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat as lstatPath, open } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { posix } from "node:path";

export type SourceEntry = { path: string; sha256: string };
export const digest = (bytes: string | Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const O_NOFOLLOW = constants.O_NOFOLLOW;
const O_DIRECTORY = constants.O_DIRECTORY;
const snapshots = new WeakMap<
  VerifiedSnapshot,
  { entries: SourceEntry[]; files: Map<string, Buffer> }
>();

export class VerifiedSnapshot {
  constructor() {}
}

export function allowedSourcePath(path: string): boolean {
  const parts = path.split("/");
  return (
    !parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        part.startsWith("-") ||
        /^(?:node_modules|\.git|\.next|dist|coverage|test-results|playwright-report|\.turbo|generated)$/.test(
          part,
        ) ||
        /^\.env/i.test(part) ||
        /^\.d[34]/.test(part),
    ) &&
    !/[\\\r\n\0:]/.test(path) &&
    (/^(?:apps\/(?:api|web)|tests|test)\//.test(path) || parts.length === 1) &&
    /\.(?:ts|tsx|mts|mjs|json|yaml|yml|prisma|sql|toml|cmd)$/.test(path)
  );
}

function sameStat(a: BigIntStats, b: BigIntStats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}

async function openDirectory(path: string) {
  return open(path, constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
}

async function rootedDirectory(root: string) {
  if (process.platform !== "linux")
    throw new Error("SAFE_SNAPSHOT_UNSUPPORTED_PLATFORM");
  if (!posix.isAbsolute(root) || root.includes("\0"))
    throw new Error("SOURCE_ROOT_INVALID");
  const parts = root.split("/").filter(Boolean);
  if (
    root.includes("//") ||
    parts.some((part) => part === "." || part === "..")
  )
    throw new Error("SOURCE_ROOT_INVALID");
  let handle = await openDirectory("/");
  try {
    for (const part of parts) {
      const next = await openDirectory(`/proc/self/fd/${handle.fd}/${part}`);
      await handle.close();
      handle = next;
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

type SnapshotTestHooks = {
  afterRootOpen?: () => void | Promise<void>;
  afterDirectoryOpen?: (path: string) => void | Promise<void>;
  afterFileOpen?: (path: string) => void | Promise<void>;
};

async function readAnchored(
  root: Awaited<ReturnType<typeof rootedDirectory>>,
  path: string,
  hooks?: SnapshotTestHooks,
): Promise<Buffer> {
  const parts = path.split("/");
  let parent = root;
  const opened: Awaited<ReturnType<typeof open>>[] = [];
  const ancestry: {
    parent: Awaited<ReturnType<typeof open>>;
    part: string;
    directory: Awaited<ReturnType<typeof open>>;
  }[] = [];
  try {
    for (const part of parts.slice(0, -1)) {
      const directory = await openDirectory(
        `/proc/self/fd/${parent.fd}/${part}`,
      );
      ancestry.push({ parent, part, directory });
      opened.push(directory);
      parent = directory;
    }
    if (hooks?.afterDirectoryOpen) await hooks.afterDirectoryOpen(path);
    const file = await open(
      `/proc/self/fd/${parent.fd}/${parts.at(-1)!}`,
      constants.O_RDONLY | O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      if (hooks?.afterFileOpen) await hooks.afterFileOpen(path);
      const before = await file.stat({ bigint: true });
      if (!before.isFile() || before.size > BigInt(MAX_FILE_BYTES))
        throw new Error("SOURCE_FILE_REQUIRED");
      // Bound allocation even if a concurrent writer grows the file after fstat.
      const data = Buffer.alloc(Number(before.size));
      let offset = 0;
      while (offset < data.length) {
        const { bytesRead } = await file.read(
          data,
          offset,
          data.length - offset,
          offset,
        );
        if (bytesRead === 0) throw new Error("SOURCE_CHANGED_DURING_CAPTURE");
        offset += bytesRead;
      }
      const { bytesRead: extra } = await file.read(
        Buffer.alloc(1),
        0,
        1,
        data.length,
      );
      if (extra !== 0) throw new Error("SOURCE_CHANGED_DURING_CAPTURE");
      const after = await file.stat({ bigint: true });
      const anchored = await lstatPath(
        `/proc/self/fd/${parent.fd}/${parts.at(-1)!}`,
        { bigint: true },
      );
      if (
        !sameStat(before, after) ||
        anchored.isSymbolicLink() ||
        before.dev !== anchored.dev ||
        before.ino !== anchored.ino ||
        BigInt(data.length) !== before.size
      )
        throw new Error("SOURCE_CHANGED_DURING_CAPTURE");
      for (const ancestor of ancestry) {
        const anchoredDirectory = await lstatPath(
          `/proc/self/fd/${ancestor.parent.fd}/${ancestor.part}`,
          { bigint: true },
        );
        const openedDirectory = await ancestor.directory.stat({ bigint: true });
        if (
          anchoredDirectory.isSymbolicLink() ||
          anchoredDirectory.dev !== openedDirectory.dev ||
          anchoredDirectory.ino !== openedDirectory.ino
        )
          throw new Error("SOURCE_CHANGED_DURING_CAPTURE");
      }
      return data;
    } finally {
      await file.close();
    }
  } finally {
    for (const directory of opened.reverse()) await directory.close();
  }
}

export async function captureVerifiedSnapshot(
  root: string,
  expected: readonly SourceEntry[],
  hooks?: SnapshotTestHooks,
): Promise<VerifiedSnapshot> {
  if (process.platform !== "linux")
    throw new Error("SAFE_SNAPSHOT_UNSUPPORTED_PLATFORM");
  if (
    !expected.length ||
    expected.length > 10_000 ||
    new Set(expected.map((entry) => entry.path)).size !== expected.length ||
    expected.some(
      (entry, index) =>
        !allowedSourcePath(entry.path) ||
        !/^[a-f0-9]{64}$/.test(entry.sha256) ||
        (index > 0 && expected[index - 1]!.path >= entry.path),
    )
  )
    throw new Error("SOURCE_INVENTORY_INVALID");
  const entries = expected.map((entry) => ({
    path: entry.path,
    sha256: entry.sha256,
  }));
  const directory = await rootedDirectory(root);
  const files = new Map<string, Buffer>();
  try {
    const rootIdentity = await directory.stat({ bigint: true });
    if (hooks?.afterRootOpen) await hooks.afterRootOpen();
    let total = 0;
    for (const entry of entries) {
      const bytes = await readAnchored(directory, entry.path, hooks);
      total += bytes.length;
      if (total > MAX_TOTAL_BYTES) throw new Error("SOURCE_SNAPSHOT_TOO_LARGE");
      if (digest(bytes) !== entry.sha256)
        throw new Error("SOURCE_MANIFEST_MISMATCH");
      files.set(entry.path, bytes);
    }
    let revalidated: Awaited<ReturnType<typeof rootedDirectory>>;
    try {
      revalidated = await rootedDirectory(root);
    } catch {
      throw new Error("SOURCE_CHANGED_DURING_CAPTURE");
    }
    try {
      const anchoredRoot = await revalidated.stat({ bigint: true });
      if (
        anchoredRoot.dev !== rootIdentity.dev ||
        anchoredRoot.ino !== rootIdentity.ino
      )
        throw new Error("SOURCE_CHANGED_DURING_CAPTURE");
    } finally {
      await revalidated.close();
    }
  } finally {
    await directory.close();
  }
  const snapshot = new VerifiedSnapshot();
  snapshots.set(snapshot, { entries, files });
  return snapshot;
}

export function snapshotManifest(snapshot: VerifiedSnapshot): SourceEntry[] {
  const state = snapshots.get(snapshot);
  if (!state) throw new Error("VERIFIED_SNAPSHOT_REQUIRED");
  return state.entries.map((entry) => ({ ...entry }));
}

function octal(value: number, width: number): string {
  const result = value.toString(8);
  if (result.length >= width)
    throw new Error("SNAPSHOT_ARCHIVE_FIELD_TOO_LARGE");
  return `${"0".repeat(width - result.length - 1)}${result}\0`;
}

function tarHeader(path: string, size: number, type: "0" | "5"): Buffer {
  const bytes = Buffer.from(path);
  let name = path;
  let prefix = "";
  if (bytes.length >= 100) {
    const split = path.lastIndexOf("/");
    if (
      split < 1 ||
      Buffer.byteLength(path.slice(split + 1)) >= 100 ||
      Buffer.byteLength(path.slice(0, split)) > 155
    )
      throw new Error("SNAPSHOT_PATH_TOO_LONG");
    prefix = path.slice(0, split);
    name = path.slice(split + 1);
  }
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write(octal(type === "5" ? 0o755 : 0o444, 8), 100, 8, "ascii");
  header.write(octal(0, 8), 108, 8, "ascii");
  header.write(octal(0, 8), 116, 8, "ascii");
  header.write(octal(type === "5" ? 0 : size, 12), 124, 12, "ascii");
  header.write(octal(0, 12), 136, 12, "ascii");
  header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0);
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write("root", 265, 4, "ascii");
  header.write("root", 297, 4, "ascii");
  if (prefix) header.write(prefix, 345, 155, "utf8");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(octal(checksum, 8), 148, 8, "ascii");
  return header;
}

export function snapshotArchive(snapshot: VerifiedSnapshot): Buffer {
  const state = snapshots.get(snapshot);
  if (!state) throw new Error("VERIFIED_SNAPSHOT_REQUIRED");
  const entries = [...state.files.entries()].map(
    ([path, bytes]) => [path, bytes] as const,
  );
  entries.push([
    ".d5-manifest.json",
    Buffer.from(JSON.stringify(state.entries)),
  ] as const);
  const dirs = new Set([
    ".d5-dependencies",
    ".d5-dependencies/root",
    ".d5-dependencies/api",
    ".d5-dependencies/web",
    "node_modules",
  ]);
  for (const entry of state.entries) {
    const parts = entry.path.split("/");
    for (let i = 1; i < parts.length; i++)
      dirs.add(parts.slice(0, i).join("/"));
    if (entry.path.startsWith("apps/"))
      dirs.add(`${parts.slice(0, 2).join("/")}/node_modules`);
  }
  const records: Buffer[] = [];
  for (const path of [...dirs].sort())
    records.push(tarHeader(`${path}/`, 0, "5"));
  for (const [path, bytes] of entries.sort(([a], [b]) => a.localeCompare(b))) {
    records.push(tarHeader(path, bytes.length, "0"), bytes);
    const padding = (512 - (bytes.length % 512)) % 512;
    if (padding) records.push(Buffer.alloc(padding));
  }
  records.push(Buffer.alloc(1024));
  return Buffer.concat(records);
}

// Read-only observation only; execution authority is captureVerifiedSnapshot.
export async function hashSourceFiles(
  root: string,
  paths: string[],
): Promise<SourceEntry[]> {
  if (paths.length === 0 || new Set(paths).size !== paths.length)
    throw new Error("SOURCE_INVENTORY_INVALID");
  if (process.platform !== "linux")
    throw new Error("SAFE_SNAPSHOT_UNSUPPORTED_PLATFORM");
  const sorted = paths.toSorted();
  const directory = await rootedDirectory(root);
  const entries: SourceEntry[] = [];
  try {
    for (const path of sorted) {
      if (!allowedSourcePath(path)) throw new Error("SOURCE_PATH_REJECTED");
      const bytes = await readAnchored(directory, path);
      entries.push({ path, sha256: digest(bytes) });
    }
  } finally {
    await directory.close();
  }
  return entries;
}

export async function captureSource(root: string) {
  const git = (args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        GIT_OPTIONAL_LOCKS: "0",
      },
      stdio: ["ignore", "pipe", "ignore"],
    });
  const paths = [
    ...new Set(
      git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
        .split("\0")
        .filter(allowedSourcePath),
    ),
  ].sort();
  const files = await hashSourceFiles(root, paths);
  return {
    branch: git(["branch", "--show-current"]).trim(),
    head: git(["rev-parse", "HEAD"]).trim(),
    dirtyInventory: git(["status", "--porcelain=v1", "--untracked-files=all"])
      .trimEnd()
      .split("\n"),
    files,
    sha256: digest(JSON.stringify(files)),
  };
}

export function assertSourceMatch(
  expected: SourceEntry[],
  actual: SourceEntry[],
): void {
  if (!expected.length || JSON.stringify(expected) !== JSON.stringify(actual))
    throw new Error("SOURCE_MANIFEST_MISMATCH");
}
