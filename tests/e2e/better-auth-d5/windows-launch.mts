import { builtinModules } from "node:module";
import { win32 } from "node:path";

export interface BootstrapClosureFile {
  path: string;
  sha256: string;
  imports: string[];
}
export interface WindowsBootstrapPin {
  root: string;
  nodeExecutable: string;
  nodeExecutableSha256: string;
  workingDirectory: string;
  entryModule: string;
  invocationMode: "file";
  execArgv: string[];
  closure: BootstrapClosureFile[];
}
export interface WindowsBootstrapObservation {
  root: string;
  nodeExecutable: string;
  nodeExecutableSha256: string;
  workingDirectory: string;
  entryModule: string;
  invocationMode: "file";
  execArgv: string[];
  closure: BootstrapClosureFile[];
}

const nodeBuiltins = new Set(
  builtinModules.map((name) =>
    name.startsWith("node:") ? name : `node:${name}`,
  ),
);

function hasAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index++)
    if (value.charCodeAt(index) < 32 || value.charCodeAt(index) === 127)
      return true;
  return false;
}
function canonicalAbsolute(path: string): boolean {
  return (
    typeof path === "string" &&
    /^[A-Za-z]:\\/.test(path) &&
    !path.includes("/") &&
    !/[<>"|?*:]/.test(path.slice(2)) &&
    !hasAsciiControl(path.slice(2)) &&
    !path
      .split(/[\\/]/)
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          /[. ]$/.test(part) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      ) &&
    win32.resolve(path).toLowerCase() === win32.normalize(path).toLowerCase()
  );
}
function contained(root: string, path: string): boolean {
  const relative = win32.relative(win32.resolve(root), win32.resolve(path));
  return (
    relative === "" ||
    (!win32.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..\\`))
  );
}

/** Exact local launch policy: file entry, no Node flags, preloads, loaders or script arguments. */
export function validateWindowsNodeLaunch(
  execArgv: readonly string[],
  invocationMode: string,
  environment: NodeJS.ProcessEnv,
): void {
  if (
    invocationMode !== "file" ||
    !Array.isArray(execArgv) ||
    execArgv.length !== 0 ||
    Object.keys(environment).some((key) =>
      /^(?:NODE|TSX)[A-Z0-9_]*$/i.test(key),
    )
  )
    throw new Error("WINDOWS_NODE_LAUNCH_POLICY_REJECTED");
}

/** Verify a separately supplied immutable deployment pin against the actual deployed closure. */
export function validateWindowsBootstrapDeployment(
  pin: WindowsBootstrapPin | null,
  observed: WindowsBootstrapObservation,
  candidateRoot: string,
): void {
  if (!pin) throw new Error("INDEPENDENT_WINDOWS_BOOTSTRAP_PIN_REQUIRED");
  const fields = [
    "closure",
    "entryModule",
    "execArgv",
    "invocationMode",
    "nodeExecutable",
    "nodeExecutableSha256",
    "root",
    "workingDirectory",
  ].join("\0");
  if (
    Object.keys(pin).sort().join("\0") !== fields ||
    !observed ||
    Object.keys(observed).sort().join("\0") !== fields
  )
    throw new Error("WINDOWS_BOOTSTRAP_DEPLOYMENT_SUBSTITUTED");
  validateWindowsNodeLaunch(pin.execArgv, pin.invocationMode, {});
  validateWindowsNodeLaunch(observed.execArgv, observed.invocationMode, {});
  const validClosure = (files: BootstrapClosureFile[]) =>
    Array.isArray(files) &&
    files.length > 0 &&
    files.every(
      (file) =>
        file &&
        Object.keys(file).sort().join("\0") === "imports\0path\0sha256" &&
        typeof file.path === "string" &&
        !file.path.startsWith("/") &&
        !file.path.includes("\\") &&
        !file.path.includes(":") &&
        file.path
          .split("/")
          .every(
            (part) =>
              part &&
              part !== "." &&
              part !== ".." &&
              !/[<>"|?*]/.test(part) &&
              !hasAsciiControl(part) &&
              !/[. ]$/.test(part) &&
              !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
          ) &&
        /^[a-f0-9]{64}$/.test(file.sha256) &&
        Array.isArray(file.imports) &&
        file.imports.every(
          (value) =>
            typeof value === "string" &&
            (nodeBuiltins.has(value) ||
              files.some((candidate) => candidate.path === value)),
        ),
    ) &&
    new Set(files.map((file) => file.path.toLowerCase())).size === files.length;
  if (
    !canonicalAbsolute(candidateRoot) ||
    !canonicalAbsolute(pin.root) ||
    !canonicalAbsolute(pin.nodeExecutable) ||
    !canonicalAbsolute(pin.workingDirectory) ||
    !canonicalAbsolute(observed.root) ||
    !canonicalAbsolute(observed.nodeExecutable) ||
    !canonicalAbsolute(observed.workingDirectory) ||
    !/^[a-f0-9]{64}$/.test(pin.nodeExecutableSha256) ||
    !/^[a-f0-9]{64}$/.test(observed.nodeExecutableSha256) ||
    !contained(pin.root, pin.workingDirectory) ||
    contained(pin.root, candidateRoot) ||
    contained(candidateRoot, pin.root) ||
    contained(candidateRoot, pin.nodeExecutable) ||
    contained(candidateRoot, pin.workingDirectory) ||
    contained(candidateRoot, observed.root) ||
    contained(candidateRoot, observed.nodeExecutable) ||
    contained(candidateRoot, observed.workingDirectory) ||
    win32.resolve(observed.root).toLowerCase() !==
      win32.resolve(pin.root).toLowerCase() ||
    win32.resolve(observed.nodeExecutable).toLowerCase() !==
      win32.resolve(pin.nodeExecutable).toLowerCase() ||
    observed.nodeExecutableSha256 !== pin.nodeExecutableSha256 ||
    win32.resolve(observed.workingDirectory).toLowerCase() !==
      win32.resolve(pin.workingDirectory).toLowerCase() ||
    !validClosure(pin.closure) ||
    !validClosure(observed.closure) ||
    !pin.closure.some((file) => file.path === pin.entryModule) ||
    observed.entryModule !== pin.entryModule ||
    JSON.stringify(observed.closure) !== JSON.stringify(pin.closure)
  )
    throw new Error("WINDOWS_BOOTSTRAP_DEPLOYMENT_SUBSTITUTED");
  for (const file of pin.closure) {
    const filePath = win32.resolve(pin.root, file.path);
    if (!contained(pin.root, filePath) || contained(candidateRoot, filePath))
      throw new Error("WINDOWS_BOOTSTRAP_CLOSURE_ESCAPES_PINNED_ROOT");
  }
}

export const INDEPENDENT_WINDOWS_BOOTSTRAP_PIN: WindowsBootstrapPin | null =
  null;
