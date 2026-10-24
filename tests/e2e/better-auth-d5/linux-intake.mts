import { constants } from "node:fs";
import { mkdir, open, readFile, statfs } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { posix } from "node:path";
import { randomUUID } from "node:crypto";
import {
  allowedSourcePath,
  captureVerifiedSnapshot,
  digest,
  type SourceEntry,
  type VerifiedSnapshot,
} from "./source-contract.mts";

export interface LinuxFilesystemIdentity {
  filesystem: "ext4";
  mountId: string;
  device: string;
  source: string;
}
export interface LinuxFilesystemObservation extends Omit<
  LinuxFilesystemIdentity,
  "filesystem"
> {
  filesystem: string;
  filesystemMagic: string;
  mountRoot: string;
  mountPoint: string;
  uid: number;
  mode: number;
  directoryDevice: string;
}
export interface LinuxRootPolicy {
  identity: LinuxFilesystemIdentity;
  uid: number;
}
/** Filesystem identity does not establish Windows administrator exclusion. */
export function validateLinuxFilesystem(
  observed: LinuxFilesystemObservation,
  policy: LinuxRootPolicy,
): void {
  if (
    !observed ||
    !policy ||
    policy.uid <= 0 ||
    !Number.isSafeInteger(policy.uid) ||
    observed.uid !== policy.uid ||
    observed.mode !== 0o700 ||
    observed.filesystem !== "ext4" ||
    observed.filesystemMagic !== "ef53" ||
    observed.mountRoot !== "/" ||
    observed.mountPoint.startsWith("/mnt/") ||
    !/^\/dev\/[A-Za-z0-9/_-]+$/.test(observed.source) ||
    !/^[1-9][0-9]*$/.test(observed.mountId) ||
    !/^[0-9]+:[0-9]+$/.test(observed.device) ||
    observed.filesystem !== policy.identity.filesystem ||
    observed.mountId !== policy.identity.mountId ||
    observed.device !== policy.identity.device ||
    observed.source !== policy.identity.source ||
    observed.directoryDevice !== observed.device
  )
    throw new Error("LINUX_NATIVE_FILESYSTEM_UNSUPPORTED");
}

function deviceNumbers(value: bigint): string {
  const major =
    ((value & 0xfff00n) >> 8n) | ((value & 0xfffff00000000000n) >> 32n);
  const minor = (value & 0xffn) | ((value & 0x00000ffffff00000n) >> 12n);
  return `${major}:${minor}`;
}
function linuxPath(path: string): void {
  for (let index = 0; index < path.length; index++) {
    const code = path.charCodeAt(index);
    if (code <= 31 || code === 127) throw new Error("LINUX_ROOT_PATH_REJECTED");
  }
  if (
    !posix.isAbsolute(path) ||
    path.includes("\\") ||
    path.includes("//") ||
    path === "/" ||
    path.startsWith("/mnt/") ||
    path.split("/").some((part) => part === "." || part === "..")
  )
    throw new Error("LINUX_ROOT_PATH_REJECTED");
}
async function openRoot(path: string, uid: number): Promise<FileHandle> {
  linuxPath(path);
  let current = await open(
    "/",
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    for (const part of path.split("/").filter(Boolean)) {
      const next = await open(
        `/proc/self/fd/${current.fd}/${part}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      await current.close();
      current = next;
      const identity = await current.stat();
      if (
        !identity.isDirectory() ||
        (identity.mode & 0o022) !== 0 ||
        (identity.uid !== 0 && identity.uid !== uid)
      )
        throw new Error("LINUX_ANCESTRY_UNPROTECTED");
    }
    return current;
  } catch (error) {
    await current.close();
    throw error;
  }
}

export class ProtectedLinuxRoot {}
type RootState = {
  path: string;
  handle: FileHandle;
  policy: LinuxRootPolicy;
  dev: bigint;
  ino: bigint;
};
const roots = new WeakMap<ProtectedLinuxRoot, RootState>();

async function observe(
  handle: FileHandle,
): Promise<LinuxFilesystemObservation> {
  const identity = await handle.stat({ bigint: true });
  const fdinfo = await readFile(`/proc/self/fdinfo/${handle.fd}`, "utf8");
  const mountId = /^mnt_id:\s*([0-9]+)$/m.exec(fdinfo)?.[1];
  if (!mountId) throw new Error("LINUX_MOUNT_IDENTITY_AMBIGUOUS");
  const lines = (await readFile("/proc/self/mountinfo", "utf8"))
    .trim()
    .split("\n");
  const matches = lines.filter((line) => line.split(" ")[0] === mountId);
  if (matches.length !== 1) throw new Error("LINUX_MOUNT_IDENTITY_AMBIGUOUS");
  const line = matches[0];
  if (!line) throw new Error("LINUX_MOUNT_IDENTITY_AMBIGUOUS");
  const [before, after] = line.split(" - ");
  const fields = before?.split(" ");
  const details = after?.split(" ");
  const device = fields?.[2];
  const mountRoot = fields?.[3];
  const mountPoint = fields?.[4];
  const filesystem = details?.[0];
  const source = details?.[1];
  if (
    !device ||
    !mountRoot ||
    !mountPoint ||
    filesystem !== "ext4" ||
    !source ||
    /\\/.test(mountRoot + mountPoint + source)
  )
    throw new Error("LINUX_NATIVE_FILESYSTEM_UNSUPPORTED");
  const fs = await statfs(`/proc/self/fd/${handle.fd}`, { bigint: true });
  return {
    filesystem,
    mountId,
    device,
    source,
    mountRoot,
    mountPoint,
    filesystemMagic: fs.type.toString(16),
    uid: Number(identity.uid),
    mode: Number(identity.mode & 0o777n),
    directoryDevice: deviceNumbers(identity.dev),
  };
}

export async function openProtectedLinuxRoot(
  path: string,
  policy: LinuxRootPolicy,
): Promise<ProtectedLinuxRoot> {
  if (
    process.platform !== "linux" ||
    process.getuid?.() !== policy.uid ||
    !constants.O_NOFOLLOW ||
    !constants.O_DIRECTORY
  )
    throw new Error("PROTECTED_LINUX_COORDINATOR_REQUIRED");
  const copied = structuredClone(policy);
  const handle = await openRoot(path, copied.uid);
  try {
    validateLinuxFilesystem(await observe(handle), copied);
    const identity = await handle.stat({ bigint: true });
    const root = new ProtectedLinuxRoot();
    roots.set(root, {
      path,
      handle,
      policy: copied,
      dev: identity.dev,
      ino: identity.ino,
    });
    return root;
  } catch (error) {
    await handle.close();
    throw error;
  }
}
export async function verifyProtectedLinuxRoot(
  root: ProtectedLinuxRoot,
): Promise<void> {
  const state = roots.get(root);
  if (!state) throw new Error("PROTECTED_LINUX_ROOT_REQUIRED");
  validateLinuxFilesystem(await observe(state.handle), state.policy);
  const current = await openRoot(state.path, state.policy.uid);
  try {
    validateLinuxFilesystem(await observe(current), state.policy);
    const identity = await current.stat({ bigint: true });
    if (identity.dev !== state.dev || identity.ino !== state.ino)
      throw new Error("LINUX_ROOT_REPLACED");
  } finally {
    await current.close();
  }
}
export async function closeProtectedLinuxRoot(
  root: ProtectedLinuxRoot,
): Promise<void> {
  const state = roots.get(root);
  roots.delete(root);
  if (state) await state.handle.close();
}

/** Reads provisioned owner policy, never an approval carried inside the candidate stream. */
export async function readLinuxPolicyFile(
  root: ProtectedLinuxRoot,
  name: "owner-acceptance.json" | "execution-approval.json",
): Promise<Buffer> {
  const state = roots.get(root);
  if (!state) throw new Error("PROTECTED_LINUX_ROOT_REQUIRED");
  await verifyProtectedLinuxRoot(root);
  const file = await open(
    `/proc/self/fd/${state.handle.fd}/${name}`,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await file.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.uid !== BigInt(state.policy.uid) ||
      (before.mode & 0o077n) !== 0n ||
      before.size <= 0n ||
      before.size > 8n * 1024n * 1024n
    )
      throw new Error("LINUX_POLICY_FILE_UNPROTECTED");
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const result = await file.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (!result.bytesRead) throw new Error("LINUX_POLICY_CHANGED");
      offset += result.bytesRead;
    }
    const after = await file.stat({ bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw new Error("LINUX_POLICY_CHANGED");
    return bytes;
  } finally {
    await file.close();
  }
}

/** Candidate entries have already passed exact independent inventory/hash verification. No source execution occurs here. */
export async function materializeLinuxSnapshot(
  root: ProtectedLinuxRoot,
  entries: readonly { path: string; bytes: Buffer }[],
  expected: readonly SourceEntry[],
): Promise<{ snapshot: VerifiedSnapshot; path: string }> {
  const state = roots.get(root);
  if (!state) throw new Error("PROTECTED_LINUX_ROOT_REQUIRED");
  const copied = entries.map((entry) => ({
    path: entry.path,
    bytes: Buffer.from(entry.bytes),
  }));
  if (
    !expected.length ||
    expected.length > 10_000 ||
    copied.length !== expected.length ||
    new Set(copied.map((entry) => entry.path)).size !== copied.length ||
    copied.reduce((sum, entry) => sum + entry.bytes.length, 0) >
      512 * 1024 * 1024
  )
    throw new Error("INTAKE_INVENTORY_REJECTED");
  for (let index = 0; index < copied.length; index++) {
    const entry = copied[index];
    const approved = expected[index];
    if (
      !entry ||
      !approved ||
      !allowedSourcePath(entry.path) ||
      entry.path !== approved.path ||
      entry.bytes.length > 64 * 1024 * 1024 ||
      digest(entry.bytes) !== approved.sha256
    )
      throw new Error("INTAKE_INTEGRITY_REJECTED");
  }
  await verifyProtectedLinuxRoot(root);
  const name = `intake-${randomUUID()}`;
  const destination = `${state.path}/${name}`;
  await mkdir(`/proc/self/fd/${state.handle.fd}/${name}`, { mode: 0o700 });
  const base = await open(
    `/proc/self/fd/${state.handle.fd}/${name}`,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const directories = new Map<string, FileHandle>([["", base]]);
  try {
    for (const entry of copied) {
      if (!allowedSourcePath(entry.path))
        throw new Error("INTAKE_PATH_REJECTED");
      const parts = entry.path.split("/");
      let relative = "";
      let parent = base;
      for (const part of parts.slice(0, -1)) {
        const nextPath = relative ? `${relative}/${part}` : part;
        let child = directories.get(nextPath);
        if (!child) {
          await mkdir(`/proc/self/fd/${parent.fd}/${part}`, { mode: 0o700 });
          child = await open(
            `/proc/self/fd/${parent.fd}/${part}`,
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
          );
          directories.set(nextPath, child);
        }
        relative = nextPath;
        parent = child;
      }
      const leaf = parts.at(-1);
      if (!leaf) throw new Error("INTAKE_PATH_REJECTED");
      const file = await open(
        `/proc/self/fd/${parent.fd}/${leaf}`,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o400,
      );
      try {
        await file.writeFile(entry.bytes);
        await file.sync();
      } finally {
        await file.close();
      }
    }
    for (const directory of [...directories.values()].reverse())
      await directory.chmod(0o500);
    await verifyProtectedLinuxRoot(root);
    const snapshot = await captureVerifiedSnapshot(destination, expected);
    return { snapshot, path: destination };
  } finally {
    // Incomplete, private trees are retained for exact-owner inspection; never racy broad deletion.
    for (const directory of [...directories.values()].reverse())
      await directory.close();
  }
}
