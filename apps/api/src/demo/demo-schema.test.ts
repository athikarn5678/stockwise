import { readFileSync, readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  DEMO_AUTHENTICATION_TABLES,
  DEMO_FIXTURE_TABLES,
  DEMO_TRANSITION_TABLE,
  assertDemoSchema,
  expectedDemoSchemaTables,
  type DemoSchemaState,
} from "./demo-schema.ts";

const migrationsDirectory = new URL(
  "../../prisma/migrations/",
  import.meta.url,
);
const committedMigrations = readdirSync(migrationsDirectory, {
  withFileTypes: true,
})
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

/** Replays CREATE/RENAME/DROP TABLE statements of the committed migrations in order. */
function tablesFromMigrations(): string[] {
  const tables = new Set<string>(["_prisma_migrations"]);
  for (const name of committedMigrations) {
    const sql = readFileSync(
      new URL(`${name}/migration.sql`, migrationsDirectory),
      "utf8",
    );
    const statements =
      /CREATE TABLE "([a-z_]+)"|ALTER TABLE "([a-z_]+)" RENAME TO "([a-z_]+)"|DROP TABLE (?:IF EXISTS )?"([a-z_]+)"/g;
    for (const match of sql.matchAll(statements)) {
      if (match[1]) tables.add(match[1]);
      if (match[2] && match[3]) {
        tables.delete(match[2]);
        tables.add(match[3]);
      }
      if (match[4]) tables.delete(match[4]);
    }
  }
  return [...tables].sort();
}

function current(overrides: Partial<DemoSchemaState> = {}): DemoSchemaState {
  return {
    tables: expectedDemoSchemaTables(),
    migrations: committedMigrations.map((name) => ({
      name,
      finished: true,
      rolledBack: false,
    })),
    localMigrations: committedMigrations,
    transitionStates: ["LEGACY"],
    ...overrides,
  };
}

describe("stockwise-demo-v1 schema manifest", () => {
  it("equals the tables produced by the committed migrations", () => {
    expect(expectedDemoSchemaTables()).toEqual(tablesFromMigrations());
  });

  it("classifies each table exactly once", () => {
    const all = [
      ...DEMO_FIXTURE_TABLES,
      ...DEMO_AUTHENTICATION_TABLES,
      DEMO_TRANSITION_TABLE,
    ];
    expect(new Set(all).size).toBe(all.length);
  });

  it("accepts the fully migrated LEGACY schema", () => {
    expect(() => assertDemoSchema(current())).not.toThrow();
  });

  it("refuses the pre-Better-Auth manifest shape (missing authentication tables)", () => {
    const legacyOnly = expectedDemoSchemaTables().filter(
      (table) =>
        !(DEMO_AUTHENTICATION_TABLES as readonly string[]).includes(table) &&
        table !== DEMO_TRANSITION_TABLE,
    );
    expect(() => assertDemoSchema(current({ tables: legacyOnly }))).toThrow(
      /Database schema differs/,
    );
  });

  it("refuses unknown, missing or renamed tables", () => {
    for (const tables of [
      [...expectedDemoSchemaTables(), "unexpected_table"],
      expectedDemoSchemaTables().filter((table) => table !== "users"),
      expectedDemoSchemaTables().map((table) =>
        table === "email_verification_challenges"
          ? "email_verification_tokens"
          : table,
      ),
    ])
      expect(() => assertDemoSchema(current({ tables }))).toThrow(
        /Database schema differs/,
      );
  });

  it("refuses partially migrated, unknown, unfinished or rolled-back migration state", () => {
    const partial = committedMigrations.slice(0, -1);
    expect(() =>
      assertDemoSchema(
        current({
          migrations: partial.map((name) => ({
            name,
            finished: true,
            rolledBack: false,
          })),
        }),
      ),
    ).toThrow(/Migration state differs/);
    expect(() =>
      assertDemoSchema(
        current({
          migrations: [
            ...current().migrations,
            {
              name: "29990101000000_unknown",
              finished: true,
              rolledBack: false,
            },
          ],
        }),
      ),
    ).toThrow(/Migration state differs/);
    for (const change of [{ finished: false }, { rolledBack: true }])
      expect(() =>
        assertDemoSchema(
          current({
            migrations: current().migrations.map((row, index) =>
              index === 0 ? { ...row, ...change } : row,
            ),
          }),
        ),
      ).toThrow(/incomplete or rolled-back/);
  });

  it("refuses any authentication state other than one LEGACY fence row", () => {
    for (const transitionStates of [
      ["QUIESCED"],
      ["NATIVE"],
      [],
      ["LEGACY", "LEGACY"],
    ])
      expect(() => assertDemoSchema(current({ transitionStates }))).toThrow(
        /pre-cutover LEGACY/,
      );
  });
});
