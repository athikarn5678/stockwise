import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

/**
 * TEST-ONLY private storage for the controlled-mail capture of the Native
 * browser acceptance stack. Captured OTPs and bearer links are live (synthetic)
 * credentials, so they live only in a freshly created directory that is
 * private to the current user before any credential can be written, is
 * re-verified by the API preload on every start, and is destroyed when the
 * launcher ends, however it ends. A hard kill is covered by an ownership-marked
 * stale-artifact cleanup on the next start. Nothing outside directories this
 * module created and marked is ever deleted.
 */
export const CAPTURE_DIRECTORY_PATTERN = /^stack-capture-([a-f0-9]{32})$/;
export const CAPTURE_FILE_NAME = "mail-capture.jsonl";
export const OWNER_FILE_NAME = "owner.json";
const ALLOWED_ENTRIES: ReadonlySet<string> = new Set([
  CAPTURE_FILE_NAME,
  OWNER_FILE_NAME,
]);

export class CaptureStoreRefusal extends Error {
  readonly reason: string;
  readonly detail: readonly string[];
  constructor(reason: string, detail: readonly string[] = []) {
    super(`BROWSER_CAPTURE_STORE_REFUSED:${reason}`);
    this.name = "CaptureStoreRefusal";
    this.reason = reason;
    this.detail = detail;
  }
}

export type StoreDeps = Readonly<{
  platform: NodeJS.Platform;
  currentUserSid: () => string;
  readSddl: (path: string) => string;
  protectDirectory: (path: string, sid: string) => void;
  currentUid: () => number | undefined;
  isProcessAlive: (pid: number) => boolean;
  now: () => Date;
}>;

function systemTool(name: string): string {
  const root =
    process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
  return join(root, "System32", name);
}

function toolEnvironment(extra: Record<string, string> = {}) {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of [
    "SystemRoot",
    "SYSTEMROOT",
    "windir",
    "WINDIR",
    "PATH",
    "Path",
  ])
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  return { ...environment, ...extra };
}

export const defaultStoreDeps: StoreDeps = Object.freeze({
  platform: process.platform,
  currentUserSid() {
    const output = execFileSync(
      systemTool("whoami.exe"),
      ["/user", "/fo", "csv", "/nh"],
      { encoding: "utf8", windowsHide: true, timeout: 20_000 },
    );
    const sid = /"(S-1-[0-9-]+)"\s*$/.exec(output.trim())?.[1];
    if (!sid) throw new CaptureStoreRefusal("IDENTITY_UNAVAILABLE");
    return sid;
  },
  readSddl(path: string) {
    return execFileSync(
      join(
        process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "(Get-Acl -LiteralPath $env:STOCKWISE_ACL_TARGET).GetSecurityDescriptorSddlForm('Access')",
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 30_000,
        env: toolEnvironment({ STOCKWISE_ACL_TARGET: path }),
      },
    ).trim();
  },
  protectDirectory(path: string, sid: string) {
    // Remove inheritance, then grant only the current user (this and below).
    execFileSync(
      systemTool("icacls.exe"),
      [path, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`],
      { stdio: "ignore", windowsHide: true, timeout: 30_000 },
    );
  },
  currentUid: () => process.getuid?.(),
  isProcessAlive(pid: number) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  },
  now: () => new Date(),
});

// ---- privacy verification ---------------------------------------------------

type Ace = { type: string; flags: string; rights: string; sid: string };

export function parseSddl(sddl: string): {
  protectedDacl: boolean;
  aces: Ace[];
} {
  const match =
    /^D:(P?)(?:AI|AR|NO_ACCESS_CONTROL)*((?:\([^()]*\))*)(?:S:.*)?$/.exec(
      sddl.trim(),
    );
  if (!match) throw new CaptureStoreRefusal("ACL_UNREADABLE");
  const aces: Ace[] = [];
  for (const entry of (match[2] ?? "").matchAll(/\(([^()]*)\)/g)) {
    const fields = (entry[1] ?? "").split(";");
    aces.push({
      type: fields[0] ?? "",
      flags: fields[1] ?? "",
      rights: fields[2] ?? "",
      sid: fields[5] ?? "",
    });
  }
  return { protectedDacl: match[1] === "P", aces };
}

/** Exactly one allow entry, for the current user; directories must not inherit. */
export function assertWindowsPrivate(
  sddl: string,
  currentSid: string,
  kind: "directory" | "file",
): void {
  const { protectedDacl, aces } = parseSddl(sddl);
  if (kind === "directory" && !protectedDacl)
    throw new CaptureStoreRefusal("ACL_NOT_PRIVATE");
  const only = aces.length === 1 ? aces[0] : undefined;
  if (!only || only.type !== "A" || only.sid !== currentSid)
    throw new CaptureStoreRefusal("ACL_NOT_PRIVATE");
  if (kind === "directory" && only.flags.includes("ID"))
    throw new CaptureStoreRefusal("ACL_NOT_PRIVATE");
}

export function assertPosixPrivate(
  stat: Pick<Stats, "mode" | "uid">,
  uid: number | undefined,
  kind: "directory" | "file",
): void {
  if (uid === undefined || stat.uid !== uid)
    throw new CaptureStoreRefusal("OWNER_NOT_CURRENT_USER");
  const forbidden = kind === "directory" ? 0o077 : 0o077;
  if ((stat.mode & forbidden) !== 0)
    throw new CaptureStoreRefusal("MODE_NOT_PRIVATE");
}

function assertPrivate(
  path: string,
  kind: "directory" | "file",
  deps: StoreDeps,
): void {
  if (deps.platform === "win32") {
    assertWindowsPrivate(deps.readSddl(path), deps.currentUserSid(), kind);
    return;
  }
  assertPosixPrivate(lstatSync(path), deps.currentUid(), kind);
}

// ---- ownership marker -------------------------------------------------------

type Owner = { schema: 1; pid: number; nonce: string; startedAt: string };

function readOwner(directory: string): Owner | undefined {
  const suffix = CAPTURE_DIRECTORY_PATTERN.exec(basename(directory))?.[1];
  try {
    const value: unknown = JSON.parse(
      readFileSync(join(directory, OWNER_FILE_NAME), "utf8"),
    );
    if (!value || typeof value !== "object") return undefined;
    const owner = value as Record<string, unknown>;
    if (
      owner.schema === 1 &&
      Number.isInteger(owner.pid) &&
      (owner.pid as number) > 0 &&
      typeof owner.nonce === "string" &&
      owner.nonce === suffix &&
      typeof owner.startedAt === "string" &&
      !Number.isNaN(Date.parse(owner.startedAt))
    )
      return owner as Owner;
  } catch {
    // unreadable or missing marker: not ours
  }
  return undefined;
}

function assertRealDirectory(path: string): void {
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch {
    throw new CaptureStoreRefusal("LOCATION_MISSING");
  }
  // lstat reports symbolic links and junctions without following them.
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new CaptureStoreRefusal("LOCATION_NOT_PLAIN_DIRECTORY");
}

// ---- create / verify / destroy ---------------------------------------------

export type PrivateCapture = Readonly<{ directory: string; file: string }>;

/**
 * Creates `<parent>/stack-capture-<128-bit hex>` (never reusing a name), makes
 * it private to the current user and verifies that before the owner marker and
 * the empty capture file exist. Any failure destroys what was created.
 */
export function createPrivateCaptureDirectory(
  parent: string,
  deps: StoreDeps = defaultStoreDeps,
): PrivateCapture {
  if (!isAbsolute(parent))
    throw new CaptureStoreRefusal("LOCATION_NOT_ABSOLUTE");
  assertRealDirectory(parent);
  const nonce = randomBytes(16).toString("hex");
  const directory = join(parent, `stack-capture-${nonce}`);
  mkdirSync(directory, { mode: 0o700 }); // not recursive: an existing name fails
  // From here on this invocation created exactly this directory; remember its
  // identity so a failed initialization can only ever remove that same object.
  const created = lstatSync(directory, { bigint: true });
  try {
    if (deps.platform === "win32")
      deps.protectDirectory(directory, deps.currentUserSid());
    else chmodSync(directory, 0o700);
    assertRealDirectory(directory);
    assertPrivate(directory, "directory", deps);
    const owner: Owner = {
      schema: 1,
      pid: process.pid,
      nonce,
      startedAt: deps.now().toISOString(),
    };
    writeFileSync(
      join(directory, OWNER_FILE_NAME),
      `${JSON.stringify(owner)}\n`,
      {
        flag: "wx",
        mode: 0o600,
      },
    );
    const file = join(directory, CAPTURE_FILE_NAME);
    closeSync(openSync(file, "wx", 0o600));
    assertPrivate(file, "file", deps);
    return Object.freeze({ directory, file });
  } catch (error) {
    let cleanup: unknown;
    try {
      removeFreshDirectory(directory, nonce, created, deps);
    } catch (failure) {
      cleanup = failure;
    }
    // A cleanup refusal is reported next to the initialization error, never
    // instead of it and never silently.
    if (cleanup === undefined) throw error;
    throw new AggregateError(
      [error, cleanup],
      "Capture initialization failed and its cleanup was refused.",
      { cause: error },
    );
  }
}

/**
 * Removes the directory this invocation just created after a failed
 * initialization. It must still be the same plain directory (same device and
 * inode, not a link). Without our marker it must be empty and is removed
 * non-recursively; with our marker the normal verified destruction applies.
 * Anything else was put there by someone else and is left alone.
 */
function removeFreshDirectory(
  directory: string,
  nonce: string,
  created: { dev: bigint; ino: bigint },
  deps: StoreDeps,
): void {
  let stat;
  try {
    stat = lstatSync(directory, { bigint: true });
  } catch {
    throw new CaptureStoreRefusal("CLEANUP_REFUSED_REPLACED");
  }
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    stat.dev !== created.dev ||
    stat.ino !== created.ino
  )
    throw new CaptureStoreRefusal("CLEANUP_REFUSED_REPLACED");
  const entries = readdirSync(directory);
  if (entries.length === 0) {
    try {
      rmdirSync(directory);
    } catch (error) {
      if (deps.platform !== "win32") throw error;
      // The directory ACL may be half-applied; the creator can restore its grant.
      deps.protectDirectory(directory, deps.currentUserSid());
      rmdirSync(directory);
    }
    return;
  }
  if (readOwner(directory)?.nonce !== nonce)
    throw new CaptureStoreRefusal("CLEANUP_REFUSED_POPULATED", entries);
  destroyCaptureDirectory(directory, deps);
}

/**
 * Re-verifies, from any process (the API preload), that `file` is the capture
 * file of a private, marked, launcher-created directory.
 */
export function assertPrivateCaptureFile(
  file: string,
  deps: StoreDeps = defaultStoreDeps,
): { directory: string } {
  if (!isAbsolute(file) || basename(file) !== CAPTURE_FILE_NAME)
    throw new CaptureStoreRefusal("CAPTURE_FILE_INVALID");
  const directory = dirname(file);
  if (!CAPTURE_DIRECTORY_PATTERN.test(basename(directory)))
    throw new CaptureStoreRefusal("LOCATION_NOT_CAPTURE_DIRECTORY");
  assertRealDirectory(directory);
  let stat: Stats;
  try {
    stat = lstatSync(file);
  } catch {
    throw new CaptureStoreRefusal("CAPTURE_FILE_MISSING");
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1)
    throw new CaptureStoreRefusal("CAPTURE_FILE_NOT_PLAIN");
  if (readOwner(directory) === undefined)
    throw new CaptureStoreRefusal("NOT_OWNED");
  for (const entry of readdirSync(directory))
    if (!ALLOWED_ENTRIES.has(entry))
      throw new CaptureStoreRefusal("UNEXPECTED_ENTRY");
  assertPrivate(directory, "directory", deps);
  assertPrivate(file, "file", deps);
  return { directory };
}

/** Deletes only a verified launcher-created capture directory; reports failure. */
export function destroyCaptureDirectory(
  directory: string,
  deps: StoreDeps = defaultStoreDeps,
): void {
  if (
    !isAbsolute(directory) ||
    !CAPTURE_DIRECTORY_PATTERN.test(basename(directory))
  )
    throw new CaptureStoreRefusal("LOCATION_NOT_CAPTURE_DIRECTORY");
  assertRealDirectory(directory);
  if (readOwner(directory) === undefined)
    throw new CaptureStoreRefusal("NOT_OWNED");
  const entries = readdirSync(directory);
  const unexpected: string[] = [];
  for (const entry of entries) {
    const stat = lstatSync(join(directory, entry));
    const plain = !stat.isSymbolicLink() && stat.isFile();
    if (!ALLOWED_ENTRIES.has(entry) || !plain) unexpected.push(entry);
  }
  const retrying = (action: () => void) => {
    try {
      action();
    } catch (error) {
      if (deps.platform !== "win32") throw error;
      // The directory ACL may have been narrowed to nobody; the creator can restore it.
      deps.protectDirectory(directory, deps.currentUserSid());
      action();
    }
  };
  // The credentials go first and unconditionally; anything this module did not
  // create is left alone, and the marker stays so the next start reports it.
  if (
    entries.includes(CAPTURE_FILE_NAME) &&
    !unexpected.includes(CAPTURE_FILE_NAME)
  )
    retrying(() =>
      rmSync(join(directory, CAPTURE_FILE_NAME), { force: false }),
    );
  if (unexpected.length > 0)
    throw new CaptureStoreRefusal("UNEXPECTED_ENTRY", unexpected);
  retrying(() => {
    if (entries.includes(OWNER_FILE_NAME))
      rmSync(join(directory, OWNER_FILE_NAME), { force: false });
    rmdirSync(directory);
  });
  if (existsSync(directory))
    throw new CaptureStoreRefusal("REMOVAL_INCOMPLETE");
}

export type StaleReport = ReadonlyArray<{
  name: string;
  status: "REMOVED" | "ACTIVE" | "UNOWNED" | "FAILED";
}>;

/**
 * Next-start cleanup after a hard kill. Considers only entries of `parent`
 * that look like capture directories; removes one only when its marker is
 * valid and the marking process is gone. Everything else is reported, never
 * touched.
 */
export function cleanupStaleCaptures(
  parent: string,
  deps: StoreDeps = defaultStoreDeps,
): StaleReport {
  assertRealDirectory(parent);
  const report: { name: string; status: StaleReport[number]["status"] }[] = [];
  for (const name of readdirSync(parent)) {
    if (!CAPTURE_DIRECTORY_PATTERN.test(name)) continue;
    const directory = join(parent, name);
    let status: StaleReport[number]["status"];
    try {
      assertRealDirectory(directory);
      const owner = readOwner(directory);
      if (owner === undefined) status = "UNOWNED";
      else if (deps.isProcessAlive(owner.pid)) status = "ACTIVE";
      else {
        destroyCaptureDirectory(directory, deps);
        status = "REMOVED";
      }
    } catch {
      status = "FAILED";
    }
    report.push({ name, status });
  }
  return report;
}

// ---- summary and leak scan --------------------------------------------------

export type CaptureSummary = Readonly<{
  messages: number;
  kinds: Readonly<Record<string, number>>;
  overflow: boolean;
}>;

/** One captured message, exactly as `createCaptureRecorder` writes it. */
export type CaptureMessageRecord = Readonly<{
  seq: number;
  at: string;
  kind: string;
  recipient: string;
  url: string;
  code?: string;
}>;
export type CaptureRecord = Readonly<{ overflow: true }> | CaptureMessageRecord;

const MESSAGE_KEYS: ReadonlySet<string> = new Set([
  "seq",
  "at",
  "kind",
  "recipient",
  "url",
  "code",
]);
const REQUIRED_MESSAGE_KEYS = ["seq", "at", "kind", "recipient", "url"];

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Fixed reason code for a parsed JSON value, or undefined when it is valid. */
function recordViolation(
  value: unknown,
): "NOT_OBJECT" | "INVALID_SCHEMA" | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return "NOT_OBJECT";
  const keys = Object.keys(value);
  const record = value as Record<string, unknown>;
  if (keys.includes("overflow"))
    return keys.length === 1 && record.overflow === true
      ? undefined
      : "INVALID_SCHEMA";
  if (keys.some((key) => !MESSAGE_KEYS.has(key))) return "INVALID_SCHEMA";
  if (REQUIRED_MESSAGE_KEYS.some((key) => !(key in record)))
    return "INVALID_SCHEMA";
  if (
    !Number.isSafeInteger(record.seq) ||
    (record.seq as number) < 1 ||
    !nonEmptyString(record.at) ||
    typeof record.kind !== "string" ||
    !/^[a-z][a-z_]{0,31}$/.test(record.kind) ||
    !nonEmptyString(record.recipient) ||
    !nonEmptyString(record.url) ||
    // The leak scan only understands six-digit codes: any other shape could
    // hide a secret from it, so it is refused rather than skipped.
    ("code" in record &&
      (typeof record.code !== "string" || !/^\d{6}$/.test(record.code)))
  )
    return "INVALID_SCHEMA";
  return undefined;
}

/**
 * The single strict reader of capture contents; the summary, the leak scan and
 * the lifecycle all consume its output. Every nonblank line must be a complete,
 * newline-terminated JSON record of the exact shape the recorder writes. The
 * first violation throws a refusal naming only the 1-based line number and a
 * fixed reason code: never any record text. A damaged capture cannot prove
 * that credentials are absent from the retained logs, so it is never skipped.
 */
export function parseCaptureRecords(text: string): CaptureRecord[] {
  const records: CaptureRecord[] = [];
  const lines = text.split("\n");
  // The recorder terminates every record, so a nonblank last segment is a
  // write that was cut short, even if the fragment happens to parse.
  const unterminated = lines.length - 1;
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    const place = `line-${index + 1}`;
    if (index === unterminated)
      throw new CaptureStoreRefusal("CAPTURE_RECORD_INVALID", [
        `${place}:UNTERMINATED_FINAL_RECORD`,
      ]);
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new CaptureStoreRefusal("CAPTURE_RECORD_INVALID", [
        `${place}:MALFORMED_JSON`,
      ]);
    }
    const violation = recordViolation(value);
    if (violation !== undefined)
      throw new CaptureStoreRefusal("CAPTURE_RECORD_INVALID", [
        `${place}:${violation}`,
      ]);
    records.push(value as CaptureRecord);
  }
  return records;
}

function summarizeRecords(records: readonly CaptureRecord[]): CaptureSummary {
  // A Map keeps names like "constructor" from colliding with prototype members.
  const kinds = new Map<string, number>();
  let messages = 0;
  let overflow = false;
  for (const record of records) {
    if ("overflow" in record) {
      overflow = true;
      continue;
    }
    messages++;
    kinds.set(record.kind, (kinds.get(record.kind) ?? 0) + 1);
  }
  return Object.freeze({
    messages,
    kinds: Object.freeze(Object.fromEntries(kinds)),
    overflow,
  });
}

/** Counts only: no recipients, links or codes. Throws on a damaged capture. */
export function summarizeCapture(text: string): CaptureSummary {
  return summarizeRecords(parseCaptureRecords(text));
}

export type LeakFinding = Readonly<{
  log: string;
  kind: "otp" | "link" | "link-token";
}>;

function scanRecords(
  records: readonly CaptureRecord[],
  logs: Readonly<Record<string, string>>,
): LeakFinding[] {
  const secrets: { kind: LeakFinding["kind"]; needle: string | RegExp }[] = [];
  for (const record of records) {
    if ("overflow" in record) continue;
    if (record.code !== undefined)
      secrets.push({
        kind: "otp",
        needle: new RegExp(`(?<!\\d)${record.code}(?!\\d)`),
      });
    secrets.push({ kind: "link", needle: record.url });
    try {
      const url = new URL(record.url);
      const hash = new URLSearchParams(url.hash.replace(/^#/, ""));
      for (const value of [url.searchParams.get("token"), hash.get("token")])
        if (value && value.length >= 16)
          secrets.push({ kind: "link-token", needle: value });
    } catch {
      // The whole string was already added as a link needle.
    }
  }
  const findings: LeakFinding[] = [];
  for (const [log, text] of Object.entries(logs))
    for (const { kind, needle } of secrets) {
      const found =
        typeof needle === "string" ? text.includes(needle) : needle.test(text);
      if (
        found &&
        !findings.some((item) => item.log === log && item.kind === kind)
      )
        findings.push({ log, kind });
    }
  return findings;
}

/**
 * Reports which retained text holds a captured secret; never the secret.
 * Throws on a damaged capture instead of scanning what remains of it.
 */
export function scanForCapturedSecrets(
  captureText: string,
  logs: Readonly<Record<string, string>>,
): LeakFinding[] {
  return scanRecords(parseCaptureRecords(captureText), logs);
}

// ---- lifecycle --------------------------------------------------------------

export type CaptureSession = Readonly<{
  parent: string;
  /** Called after the body ends and its processes are stopped. */
  retainedLogs?: () => Record<string, string>;
  /** Non-sensitive counts are written here before the capture is destroyed. */
  summaryPath?: string;
  /** Reads the capture for the scan; injectable for fault-injection tests. */
  readCapture?: (file: string) => string;
  report?: (line: string) => void;
  deps?: StoreDeps;
}>;

/** Only a sanitized error code ever leaves a failed read: never message text. */
function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,24}$/.test(code)
    ? code
    : "UNKNOWN";
}

/**
 * Reads retained logs for the leak scan. A log that was never created (startup
 * failed before its process) is skipped; every other read failure propagates,
 * because an unreadable log cannot be called clean.
 */
export function readRetainedLogs(
  directory: string,
  names: readonly string[],
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): Record<string, string> {
  const logs: Record<string, string> = {};
  for (const name of names) {
    try {
      logs[name] = read(join(directory, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return logs;
}

/**
 * Runs `body` with a private capture and, however `body` ends (success, test
 * failure, startup failure, interruption surfaced as an error), scans the
 * retained logs for captured secrets, writes counts only, and destroys the
 * capture. Stale artifacts of a killed earlier run are removed first, or the
 * start is refused naming them. A leak or cleanup failure is an error.
 */
export async function withPrivateCapture<T>(
  session: CaptureSession,
  body: (capture: PrivateCapture) => Promise<T>,
): Promise<T> {
  const deps = session.deps ?? defaultStoreDeps;
  const report = session.report ?? (() => undefined);
  const stale = cleanupStaleCaptures(session.parent, deps);
  for (const item of stale) report(`CAPTURE_STALE:${item.status}:${item.name}`);
  const blocking = stale.filter((item) => item.status !== "REMOVED");
  if (blocking.length > 0)
    throw new CaptureStoreRefusal(
      "STALE_ARTIFACT_PRESENT",
      blocking.map((item) => `${item.status}:${item.name}`),
    );

  const capture = createPrivateCaptureDirectory(session.parent, deps);
  const failures: unknown[] = [];
  let result: T | undefined;
  try {
    result = await body(capture);
  } catch (error) {
    failures.push(error);
  }
  // The scan is only ever CLEAN when both inputs were actually read. A capture
  // or log that cannot be read is an incomplete (failed) scan; the capture is
  // still destroyed below, and the failure is kept next to any other.
  const writeSummary = (value: unknown) => {
    if (session.summaryPath !== undefined)
      writeFileSync(session.summaryPath, `${JSON.stringify(value, null, 2)}\n`);
  };
  let text: string | undefined;
  try {
    text = (session.readCapture ?? ((file) => readFileSync(file, "utf8")))(
      capture.file,
    );
  } catch (error) {
    failures.push(
      new CaptureStoreRefusal("CAPTURE_UNREADABLE", [errorCode(error)]),
    );
  }
  // A capture that was read but is damaged is as unverifiable as one that
  // could not be read; the refusal names a line number and reason code only.
  let records: CaptureRecord[] | undefined;
  if (text !== undefined)
    try {
      records = parseCaptureRecords(text);
    } catch (error) {
      failures.push(error);
    }
  let logs: Record<string, string> | undefined;
  try {
    logs = session.retainedLogs?.() ?? {};
  } catch (error) {
    failures.push(
      new CaptureStoreRefusal("RETAINED_LOG_UNREADABLE", [errorCode(error)]),
    );
  }
  try {
    if (records === undefined || logs === undefined) {
      report("CAPTURE_LOG_SCAN:INCOMPLETE");
      writeSummary({ scan: "INCOMPLETE" });
    } else {
      writeSummary({ scan: "COMPLETE", ...summarizeRecords(records) });
      const leaks = scanRecords(records, logs);
      if (leaks.length > 0) {
        report("CAPTURE_LOG_SCAN:LEAK");
        failures.push(
          new CaptureStoreRefusal(
            "SECRET_IN_RETAINED_LOG",
            leaks.map((item) => `${item.kind}:${item.log}`),
          ),
        );
      } else report("CAPTURE_LOG_SCAN:CLEAN");
    }
  } catch (error) {
    report("CAPTURE_LOG_SCAN:INCOMPLETE");
    failures.push(error);
  }
  try {
    destroyCaptureDirectory(capture.directory, deps);
    report("CAPTURE_CLEANUP:COMPLETE");
  } catch (error) {
    report("CAPTURE_CLEANUP:FAILED");
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, "Browser capture run failed.");
  return result as T;
}
