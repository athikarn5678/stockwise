import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertCleanForwardMigrationPrefix,
  assertExactMigrationManifests,
  readMigrationSourceManifest,
  type MigrationEntry,
  type MigrationLedgerEntry,
} from "./migration-contract.mts";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

async function fixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "stockwise-d5-migrations-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function addMigration(
  root: string,
  name: string,
  sql = "SELECT 1;\n",
): Promise<void> {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "migration.sql"), sql);
}

const entry = (name: string, sql: string): MigrationEntry => ({
  name,
  timestamp: name.slice(0, 14),
  sha256: hash(sql),
});

const ledgerEntry = (
  migration: MigrationEntry,
  status: MigrationLedgerEntry["status"] = "finished",
): MigrationLedgerEntry => ({ ...migration, status });

test("reads exact SQL and lock bytes into a deterministic source manifest", async () =>
  fixture(async (root) => {
    const lock = 'provider = "postgresql"\n';
    const sql = "-- bytes matter\r\nSELECT 1;\r\n";
    await writeFile(join(root, "migration_lock.toml"), lock);
    await addMigration(root, "20260101000000_alpha", sql);
    await addMigration(root, "20260102000000_beta", "SELECT 2;\n");

    const manifest = await readMigrationSourceManifest(root);
    assert.deepEqual(manifest.migrations, [
      entry("20260101000000_alpha", sql),
      entry("20260102000000_beta", "SELECT 2;\n"),
    ]);
    assert.equal(manifest.lockSha256, hash(lock));
  }));

test("rejects missing or empty migration inventories and lock metadata", async () =>
  fixture(async (root) => {
    await writeFile(
      join(root, "migration_lock.toml"),
      "provider = 'postgresql'\n",
    );
    await assert.rejects(
      readMigrationSourceManifest(root),
      /inventory is empty/,
    );
    await addMigration(root, "20260101000000_alpha", "");
    await assert.rejects(
      readMigrationSourceManifest(root),
      /Migration SQL is empty/,
    );
    await writeFile(
      join(root, "20260101000000_alpha", "migration.sql"),
      "SELECT 1;\n",
    );
    await writeFile(join(root, "migration_lock.toml"), "");
    await assert.rejects(
      readMigrationSourceManifest(root),
      /lock metadata is empty/,
    );
  }));

test("rejects malformed and duplicate migration timestamps", async () =>
  fixture(async (root) => {
    await writeFile(
      join(root, "migration_lock.toml"),
      "provider = 'postgresql'\n",
    );
    await addMigration(root, "2026010100000_bad");
    await assert.rejects(
      readMigrationSourceManifest(root),
      /malformed timestamp/,
    );
    await rm(join(root, "2026010100000_bad"), { recursive: true });
    await addMigration(root, "20260230000000_invalid_date");
    await assert.rejects(
      readMigrationSourceManifest(root),
      /malformed timestamp/,
    );
    await rm(join(root, "20260230000000_invalid_date"), { recursive: true });
    await addMigration(root, "20260101000000_alpha");
    await addMigration(root, "20260101000000_beta");
    await assert.rejects(
      readMigrationSourceManifest(root),
      /duplicate timestamp/,
    );
  }));

test("rejects unexpected root and per-migration members", async () =>
  fixture(async (root) => {
    await writeFile(
      join(root, "migration_lock.toml"),
      "provider = 'postgresql'\n",
    );
    await addMigration(root, "20260101000000_alpha");
    await writeFile(join(root, "notes.txt"), "unexpected");
    await assert.rejects(
      readMigrationSourceManifest(root),
      /unexpected member/,
    );
    await rm(join(root, "notes.txt"));
    await writeFile(
      join(root, "20260101000000_alpha", "extra.sql"),
      "SELECT 2;",
    );
    await assert.rejects(
      readMigrationSourceManifest(root),
      /unexpected members/,
    );
  }));

test("rejects symbolic-link migration directories", async (context) =>
  fixture(async (root) => {
    await writeFile(
      join(root, "migration_lock.toml"),
      "provider = 'postgresql'\n",
    );
    await addMigration(root, "20260101000000_alpha");
    try {
      await symlink(
        join(root, "20260101000000_alpha"),
        join(root, "20260102000000_link"),
        "dir",
      );
    } catch {
      context.skip("Directory symlinks are unavailable on this platform.");
      return;
    }
    await assert.rejects(
      readMigrationSourceManifest(root),
      /unexpected member/,
    );
  }));

test("requires exact nonempty source and execution manifests including the lock hash", () => {
  const source: { lockSha256: string; migrations: [MigrationEntry] } = {
    lockSha256: hash("lock"),
    migrations: [entry("20260101000000_alpha", "SELECT 1;\n")],
  };
  assert.doesNotThrow(() =>
    assertExactMigrationManifests(source, structuredClone(source)),
  );
  assert.throws(
    () =>
      assertExactMigrationManifests(source, {
        ...source,
        lockSha256: hash("other"),
      }),
    /manifests differ/,
  );
  assert.throws(
    () => assertExactMigrationManifests(source, { ...source, migrations: [] }),
    /Migration manifest must contain/,
  );
  assert.throws(
    () =>
      assertExactMigrationManifests(source, {
        ...source,
        migrations: [
          source.migrations[0],
          entry("20260101000000_beta", "SELECT 2;\n"),
        ],
      }),
    /clean ordered inventory/,
  );
  assert.throws(
    () =>
      assertExactMigrationManifests(
        { ...source, migrations: [] },
        { ...source, migrations: [] },
      ),
    /Migration manifest must contain/,
  );
});

test("accepts only finished unchanged forward ledger prefixes", () => {
  const execution: [MigrationEntry, MigrationEntry] = [
    entry("20260101000000_alpha", "SELECT 1;\n"),
    entry("20260102000000_beta", "SELECT 2;\n"),
  ];
  const ledger: [MigrationLedgerEntry, MigrationLedgerEntry] = [
    ledgerEntry(execution[0]),
    ledgerEntry(execution[1]),
  ];
  assert.doesNotThrow(() => assertCleanForwardMigrationPrefix(execution, []));
  assert.doesNotThrow(() =>
    assertCleanForwardMigrationPrefix(execution, ledger.slice(0, 1)),
  );
  assert.doesNotThrow(() =>
    assertCleanForwardMigrationPrefix(execution, ledger),
  );
  assert.throws(
    () => assertCleanForwardMigrationPrefix(execution, [ledger[1]]),
    /forward prefix/,
  );
  assert.throws(
    () =>
      assertCleanForwardMigrationPrefix(execution, [
        ledgerEntry({ ...execution[0], sha256: hash("changed") }),
      ]),
    /completed forward prefix/,
  );
  assert.throws(
    () =>
      assertCleanForwardMigrationPrefix(execution, [
        ledgerEntry(execution[0], "failed"),
      ]),
    /completed forward prefix/,
  );
  assert.throws(
    () =>
      assertCleanForwardMigrationPrefix(execution, [
        ledgerEntry(execution[0], "rolledBack"),
      ]),
    /completed forward prefix/,
  );
  assert.throws(
    () => assertCleanForwardMigrationPrefix(execution, [...ledger, ledger[1]]),
    /forward prefix/,
  );
  assert.throws(
    () =>
      assertCleanForwardMigrationPrefix(
        [execution[0], entry("20260101000000_duplicate", "SELECT 3;\n")],
        [],
      ),
    /clean ordered inventory/,
  );
});
