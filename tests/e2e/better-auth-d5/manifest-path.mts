import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { posix, win32 } from "node:path";

function hasForbiddenControl(path: string): boolean {
  for (let index = 0; index < path.length; index++) {
    const code = path.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}
const WINDOWS_DEVICE = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;

function invalidWindowsComponents(
  path: string,
  allowTrailingSeparator: boolean,
): boolean {
  const parts = path.slice(3).split("\\");
  if (allowTrailingSeparator && parts.at(-1) === "") parts.pop();
  return parts.some(
    (part) =>
      !part ||
      part === "." ||
      part === ".." ||
      /[. ]$/.test(part) ||
      /[<>:"|?*]/.test(part) ||
      WINDOWS_DEVICE.test(part),
  );
}

export function externalManifestPath(
  root: string,
  destination: string,
  platform: "win32" | "posix" = process.platform === "win32"
    ? "win32"
    : "posix",
): string {
  if (
    hasForbiddenControl(root) ||
    hasForbiddenControl(destination) ||
    !destination.toLowerCase().endsWith(".json")
  )
    throw new Error("EXTERNAL_EVIDENCE_PATH_REQUIRED");
  if (platform === "win32") {
    if (
      !/^[A-Za-z]:\\/.test(root) ||
      root.includes("/") ||
      root.includes(":", 2) ||
      invalidWindowsComponents(root, true) ||
      destination.includes("/") ||
      destination.includes(":", 2) ||
      destination.startsWith("\\\\") ||
      destination.slice(3).includes("\\\\") ||
      invalidWindowsComponents(destination, false) ||
      !/^[A-Za-z]:\\/.test(destination)
    )
      throw new Error("EXTERNAL_EVIDENCE_PATH_REQUIRED");
    const target = win32.resolve(destination);
    const rel = win32.relative(win32.resolve(root), target);
    if (
      rel === "" ||
      (!win32.isAbsolute(rel) &&
        rel !== ".." &&
        !rel.startsWith(`..${win32.sep}`))
    )
      throw new Error("EXTERNAL_EVIDENCE_PATH_REQUIRED");
    return target;
  }
  const hasDotComponent = (value: string) =>
    value.split("/").some((part) => part === "." || part === "..");
  if (
    !posix.isAbsolute(root) ||
    root.includes("//") ||
    hasDotComponent(root) ||
    destination.includes("\\") ||
    destination.includes(":") ||
    !posix.isAbsolute(destination) ||
    destination.startsWith("//") ||
    destination.includes("//") ||
    hasDotComponent(destination)
  )
    throw new Error("EXTERNAL_EVIDENCE_PATH_REQUIRED");
  const target = posix.resolve(destination);
  const rel = posix.relative(posix.resolve(root), target);
  if (
    rel === "" ||
    (!posix.isAbsolute(rel) && rel !== ".." && !rel.startsWith("../"))
  )
    throw new Error("EXTERNAL_EVIDENCE_PATH_REQUIRED");
  return target;
}
async function openDirectoryPath(path: string) {
  let handle = await open(
    "/",
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    for (const part of path.split("/").filter(Boolean)) {
      const next = await open(
        `/proc/self/fd/${handle.fd}/${part}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      await handle.close();
      handle = next;
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function writeExternalManifest(
  root: string,
  destination: string,
  bytes: string,
): Promise<void> {
  if (process.platform !== "linux")
    throw new Error("SAFE_MANIFEST_UNSUPPORTED_PLATFORM");
  const target = externalManifestPath(root, destination, "posix");
  const parentPath = posix.dirname(target);
  const parts = parentPath.split("/").filter(Boolean);
  let parent = await open(
    "/",
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    for (const part of parts) {
      const next = await open(
        `/proc/self/fd/${parent.fd}/${part}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      await parent.close();
      parent = next;
    }
    const initial = await parent.stat({ bigint: true });
    const name = posix.basename(target);
    const procPath = `/proc/self/fd/${parent.fd}/${name}`;
    const file = await open(
      procPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.writeFile(bytes, { encoding: "utf8" });
      const final = await parent.stat({ bigint: true });
      const revalidatedParent = await openDirectoryPath(parentPath);
      try {
        const atPath = await revalidatedParent.stat({ bigint: true });
        if (
          initial.dev !== final.dev ||
          initial.ino !== final.ino ||
          atPath.dev !== final.dev ||
          atPath.ino !== final.ino
        )
          throw new Error("SAFE_MANIFEST_PARENT_CHANGED");
      } finally {
        await revalidatedParent.close();
      }
      const fileStat = await file.stat({ bigint: true });
      const anchored = await lstat(procPath, { bigint: true });
      if (
        anchored.isSymbolicLink() ||
        anchored.dev !== fileStat.dev ||
        anchored.ino !== fileStat.ino
      )
        throw new Error("SAFE_MANIFEST_PARENT_CHANGED");
    } finally {
      await file.close();
    }
  } finally {
    await parent.close();
  }
}
