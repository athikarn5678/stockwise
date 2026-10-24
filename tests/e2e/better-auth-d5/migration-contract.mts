import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { promisify } from "node:util";
import { join, resolve } from "node:path";

const execFileAsync = promisify(execFile);
const MIGRATIONS_RELATIVE_PATH = "apps/api/prisma/migrations";
const MIGRATION_NAME = /^(\d{14})_[a-z0-9]+(?:_[a-z0-9]+)*$/;
const SHA256 = /^[a-f0-9]{64}$/;

export interface MigrationEntry {
  name: string;
  timestamp: string;
  sha256: string;
}

export interface MigrationLedgerEntry extends MigrationEntry {
  status: "finished" | "failed" | "unfinished" | "rolledBack";
}

export interface MigrationSourceManifest {
  migrations: MigrationEntry[];
  lockSha256: string;
}

export interface MigrationAddition extends MigrationEntry {
  tracking: "index" | "untracked";
}

export interface MigrationRepositoryManifest extends MigrationSourceManifest {
  historical: MigrationEntry[];
  additions: MigrationAddition[];
}

function safeError(message: string): Error {
  return new Error(message);
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function validateName(name: string): string {
  const match = MIGRATION_NAME.exec(name);
  const timestamp = match?.[1];
  if (!timestamp)
    throw safeError(
      "Migration inventory contains a malformed timestamp or name.",
    );
  const date = new Date(0);
  date.setUTCFullYear(
    Number(timestamp.slice(0, 4)),
    Number(timestamp.slice(4, 6)) - 1,
    Number(timestamp.slice(6, 8)),
  );
  date.setUTCHours(
    Number(timestamp.slice(8, 10)),
    Number(timestamp.slice(10, 12)),
    Number(timestamp.slice(12, 14)),
    0,
  );
  if (
    Number.isNaN(date.getTime()) ||
    date.getUTCFullYear() !== Number(timestamp.slice(0, 4)) ||
    date.getUTCMonth() + 1 !== Number(timestamp.slice(4, 6)) ||
    date.getUTCDate() !== Number(timestamp.slice(6, 8)) ||
    date.getUTCHours() !== Number(timestamp.slice(8, 10)) ||
    date.getUTCMinutes() !== Number(timestamp.slice(10, 12)) ||
    date.getUTCSeconds() !== Number(timestamp.slice(12, 14))
  )
    throw safeError(
      "Migration inventory contains a malformed timestamp or name.",
    );
  return timestamp;
}

function compareEntry(left: MigrationEntry, right: MigrationEntry): boolean {
  return (
    left.name === right.name &&
    left.timestamp === right.timestamp &&
    left.sha256 === right.sha256
  );
}

function ordered(entries: MigrationEntry[]): MigrationEntry[] {
  return [...entries].sort(
    (a, b) =>
      a.timestamp.localeCompare(b.timestamp) || a.name.localeCompare(b.name),
  );
}

function assertValidEntries(entries: readonly MigrationEntry[]): void {
  if (entries.length === 0)
    throw safeError("Migration manifest must contain at least one migration.");
  const names = new Set<string>();
  const timestamps = new Set<string>();
  let previousTimestamp = "";
  for (const entry of entries) {
    const timestamp = validateName(entry.name);
    if (
      names.has(entry.name) ||
      timestamps.has(timestamp) ||
      timestamp !== entry.timestamp ||
      !SHA256.test(entry.sha256) ||
      timestamp < previousTimestamp
    )
      throw safeError("Migration manifest is not a clean ordered inventory.");
    names.add(entry.name);
    timestamps.add(timestamp);
    previousTimestamp = timestamp;
  }
}

/** Read only the current checkout's migration bytes; no subprocesses or environment access. */
export async function readMigrationSourceManifest(
  migrationsDirectory: string,
): Promise<MigrationSourceManifest> {
  try {
    const root = resolve(migrationsDirectory);
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
      throw safeError("Migration inventory root is not a regular directory.");

    const members = await readdir(root, { withFileTypes: true });
    if (members.length === 0) throw safeError("Migration inventory is empty.");
    const lock = members.find(
      (member) => member.name === "migration_lock.toml",
    );
    if (!lock || !lock.isFile() || lock.isSymbolicLink())
      throw safeError("Migration lock metadata is missing or invalid.");
    const migrations: MigrationEntry[] = [];
    const timestamps = new Set<string>();

    for (const member of members) {
      if (member.name === "migration_lock.toml") continue;
      if (member.isSymbolicLink() || !member.isDirectory())
        throw safeError("Migration inventory contains an unexpected member.");
      const timestamp = validateName(member.name);
      if (timestamps.has(timestamp))
        throw safeError("Migration inventory contains a duplicate timestamp.");
      timestamps.add(timestamp);
      const directory = join(root, member.name);
      const contents = await readdir(directory, { withFileTypes: true });
      if (contents.length !== 1)
        throw safeError("Migration directory contains unexpected members.");
      const onlyFile = contents[0];
      if (
        !onlyFile ||
        onlyFile.name !== "migration.sql" ||
        !onlyFile.isFile() ||
        onlyFile.isSymbolicLink()
      )
        throw safeError("Migration directory contains unexpected members.");
      const sqlPath = join(directory, "migration.sql");
      const sqlStat = await lstat(sqlPath);
      if (!sqlStat.isFile() || sqlStat.isSymbolicLink())
        throw safeError("Migration SQL is not a regular file.");
      const bytes = await readFile(sqlPath);
      if (bytes.length === 0) throw safeError("Migration SQL is empty.");
      migrations.push({ name: member.name, timestamp, sha256: digest(bytes) });
    }
    if (migrations.length === 0)
      throw safeError("Migration inventory is empty.");
    const lockPath = join(root, "migration_lock.toml");
    const lockStat = await lstat(lockPath);
    if (!lockStat.isFile() || lockStat.isSymbolicLink())
      throw safeError("Migration lock metadata is invalid.");
    const lockBytes = await readFile(lockPath);
    if (lockBytes.length === 0)
      throw safeError("Migration lock metadata is empty.");
    return { migrations: ordered(migrations), lockSha256: digest(lockBytes) };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Migration "))
      throw error;
    throw safeError("Unable to read migration source inventory.");
  }
}

/** Exact byte-manifest equality, including ordering and lock metadata hash. */
export function assertExactMigrationManifests(
  source: MigrationSourceManifest,
  execution: MigrationSourceManifest,
): void {
  if (!SHA256.test(source.lockSha256) || !SHA256.test(execution.lockSha256))
    throw safeError("Source and execution migration manifests are invalid.");
  assertValidEntries(source.migrations);
  assertValidEntries(execution.migrations);
  if (
    source.lockSha256 !== execution.lockSha256 ||
    source.migrations.length !== execution.migrations.length ||
    source.migrations.some((entry, index) => {
      const executionEntry = execution.migrations[index];
      return !executionEntry || !compareEntry(entry, executionEntry);
    })
  )
    throw safeError("Source and execution migration manifests differ.");
}

/** Check that completed ledger rows are a clean, unchanged prefix of execution. */
export function assertCleanForwardMigrationPrefix(
  execution: readonly MigrationEntry[],
  ledger: readonly MigrationLedgerEntry[],
): void {
  assertValidEntries(execution);
  if (ledger.length > execution.length)
    throw safeError("Migration ledger is not a forward prefix.");
  for (let index = 0; index < ledger.length; index += 1) {
    const entry = ledger[index];
    const expected = execution[index];
    if (
      !entry ||
      !expected ||
      entry.status !== "finished" ||
      !SHA256.test(entry.sha256) ||
      !compareEntry(entry, expected)
    )
      throw safeError(
        "Migration ledger is not a clean completed forward prefix.",
      );
  }
}

function parseGitLines(output: Buffer): string[] {
  return output.toString("utf8").split(/\r?\n/).filter(Boolean);
}

/**
 * Read HEAD's historical migration SQL and classify current additions against the index.
 * Git is invoked only by this explicit function, with the caller-supplied environment.
 */
export async function readMigrationRepositoryManifest(options: {
  repositoryRoot: string;
  environment: NodeJS.ProcessEnv;
}): Promise<MigrationRepositoryManifest> {
  try {
    const repositoryRoot = resolve(options.repositoryRoot);
    const source = await readMigrationSourceManifest(
      join(repositoryRoot, MIGRATIONS_RELATIVE_PATH),
    );
    const git = async (args: string[]) => {
      const result = await execFileAsync(
        "git",
        ["--no-optional-locks", "-C", repositoryRoot, ...args],
        {
          encoding: "buffer",
          env: options.environment,
          windowsHide: true,
          timeout: 15_000,
          maxBuffer: 16 * 1024 * 1024,
        },
      );
      return result.stdout;
    };
    const headTree = parseGitLines(
      await git([
        "ls-tree",
        "-r",
        "--name-only",
        "HEAD",
        "--",
        MIGRATIONS_RELATIVE_PATH,
      ]),
    );
    const headSql = headTree.filter((path) => path.endsWith("/migration.sql"));
    const historical: MigrationEntry[] = [];
    for (const path of headSql) {
      const parts = path.split("/");
      const name = parts.at(-2) ?? "";
      const timestamp = validateName(name);
      const bytes = await git(["show", `HEAD:${path}`]);
      historical.push({ name, timestamp, sha256: digest(bytes) });
    }
    const historicalLock = await git([
      "show",
      `HEAD:${MIGRATIONS_RELATIVE_PATH}/migration_lock.toml`,
    ]);
    if (digest(historicalLock) !== source.lockSha256)
      throw safeError("Migration lock metadata differs from HEAD.");
    const headNames = new Set(historical.map((entry) => entry.name));
    const currentByName = new Map(
      source.migrations.map((entry) => [entry.name, entry]),
    );
    for (const entry of historical) {
      const current = currentByName.get(entry.name);
      if (!current)
        throw safeError(
          "A historical migration is missing from the current checkout.",
        );
      if (!compareEntry(entry, current))
        throw safeError("A historical migration differs from HEAD.");
    }
    const stagedPaths = new Set(
      parseGitLines(await git(["ls-files", "--", MIGRATIONS_RELATIVE_PATH])),
    );
    const historicalLastTimestamp = historical.reduce(
      (latest, entry) => (entry.timestamp > latest ? entry.timestamp : latest),
      "",
    );
    const additions = ordered(
      source.migrations.filter((entry) => !headNames.has(entry.name)),
    );
    if (
      historicalLastTimestamp &&
      additions.some((entry) => entry.timestamp <= historicalLastTimestamp)
    )
      throw safeError(
        "An additive migration does not follow historical migrations.",
      );
    const classifiedAdditions: MigrationAddition[] = additions.map((entry) => ({
      ...entry,
      tracking: stagedPaths.has(
        `${MIGRATIONS_RELATIVE_PATH}/${entry.name}/migration.sql`,
      )
        ? "index"
        : "untracked",
    }));
    const historicalSorted = ordered(historical);
    const migrations = [...historicalSorted, ...classifiedAdditions];
    return {
      migrations,
      historical: historicalSorted,
      additions: classifiedAdditions,
      lockSha256: source.lockSha256,
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Migration "))
      throw error;
    throw safeError(
      "Unable to compare migration inventory with repository history.",
    );
  }
}
