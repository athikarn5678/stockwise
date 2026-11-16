import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Client } from "pg";

import type { Prisma, PrismaClient } from "../generated/prisma/client.ts";
import { createPrismaClient } from "../prisma/client.ts";
import {
  getTestDatabaseAdminUrl,
  getTestDatabaseName,
  type TestDatabaseEnvironment,
} from "./database-environment.ts";

const execFileAsync = promisify(execFile);
const apiRoot = fileURLToPath(new URL("../../", import.meta.url));
const prismaCli = fileURLToPath(
  new URL("../../node_modules/prisma/build/index.js", import.meta.url),
);

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

export function createTestPrismaClient(
  environment: TestDatabaseEnvironment,
): PrismaClient {
  return createPrismaClient({ DATABASE_URL: environment.TEST_DATABASE_URL });
}

export async function provisionTestDatabase(
  environment: TestDatabaseEnvironment,
): Promise<void> {
  const allowStockwiseTest = environment.STOCKWISE_ALLOW_STOCKWISE_TEST === "1";
  const databaseName = getTestDatabaseName(
    environment.TEST_DATABASE_URL,
    allowStockwiseTest,
  );
  const adminClient = new Client({
    connectionString: getTestDatabaseAdminUrl(
      environment.TEST_DATABASE_URL,
      allowStockwiseTest,
    ),
  });

  try {
    await adminClient.connect();
    const result = await adminClient.query<{ exists: boolean }>(
      "SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1) AS exists",
      [databaseName],
    );

    if (result.rows[0]?.exists !== true) {
      await adminClient.query(
        `CREATE DATABASE ${quoteIdentifier(databaseName)}`,
      );
    }
  } finally {
    await adminClient.end();
  }
}

/** Applies committed forward migrations to the guarded disposable test target. */
export async function applyTestDatabaseMigrations(
  environment: TestDatabaseEnvironment,
): Promise<void> {
  getTestDatabaseName(
    environment.TEST_DATABASE_URL,
    environment.STOCKWISE_ALLOW_STOCKWISE_TEST === "1",
  );

  await execFileAsync(
    process.execPath,
    [prismaCli, "migrate", "deploy", "--config", "prisma.config.ts"],
    {
      cwd: apiRoot,
      env: {
        ...process.env,
        DATABASE_URL: environment.TEST_DATABASE_URL,
      },
      windowsHide: true,
    },
  );
}

/**
 * Reset policy for the durable authentication fence singleton. An absent fence
 * (pre-migration target), `LEGACY` and `NATIVE` are resettable; a quiesced or
 * unrecognised state is a target in an undefined transition, so it is refused.
 */
export function assertFenceAllowsReset(state: string | null): void {
  if (state === null || state === "LEGACY" || state === "NATIVE") return;
  if (state === "QUIESCED")
    throw new Error(
      "test reset refused while the authentication transition is quiesced",
    );
  throw new Error("test reset refused for an unknown authentication fence");
}

/**
 * Clears only the disposable test database's public tables and removes the
 * harness-owned scratch schema. The URL guard runs before any destructive
 * statement is issued, while the durable fence singleton and future Prisma
 * migration metadata stay intact.
 */
export async function resetTestDatabase(
  environment: TestDatabaseEnvironment,
): Promise<void> {
  getTestDatabaseName(
    environment.TEST_DATABASE_URL,
    environment.STOCKWISE_ALLOW_STOCKWISE_TEST === "1",
  );
  const testClient = new Client({
    connectionString: environment.TEST_DATABASE_URL,
  });

  try {
    await testClient.connect();
    await testClient.query("BEGIN");
    // Retain the durable fence across ordinary test resets: Legacy and Native
    // targets are both resettable, an undefined transition state is not.
    const fenceTable = await testClient.query<{ exists: boolean }>(
      "SELECT to_regclass('public.native_auth_transition') IS NOT NULL AS exists",
    );
    if (fenceTable.rows[0]?.exists === true) {
      const fence = await testClient.query<{ state: string }>(
        "SELECT state FROM public.native_auth_transition WHERE id = true FOR SHARE",
      );
      assertFenceAllowsReset(fence.rows[0]?.state ?? null);
    }
    await testClient.query(
      "DROP SCHEMA IF EXISTS stockwise_test_harness CASCADE",
    );
    await testClient.query(`
      DO $$
      DECLARE
        tableList text;
      BEGIN
        SELECT string_agg(format('%I.%I', schemaname, tablename), ', ')
        INTO tableList
        FROM pg_tables
        WHERE schemaname = 'public' AND tablename NOT IN ('_prisma_migrations', 'native_auth_transition');

        IF tableList IS NOT NULL THEN
          EXECUTE 'TRUNCATE TABLE ' || tableList || ' RESTART IDENTITY CASCADE';
        END IF;
      END $$;
    `);
    await testClient.query("COMMIT");
  } finally {
    await testClient.end();
  }
}

class RollbackSignal {
  readonly value = undefined;
}

type TestPrismaTransaction = Prisma.TransactionClient;

/** Runs a test callback in a transaction that is always rolled back. */
export async function withRollbackTransaction<T>(
  prisma: PrismaClient,
  callback: (transaction: TestPrismaTransaction) => Promise<T>,
): Promise<T> {
  const rollback = new RollbackSignal();
  let outcome: { value: T } | undefined;

  try {
    await prisma.$transaction(async (transaction) => {
      outcome = { value: await callback(transaction) };
      throw rollback;
    });
  } catch (error: unknown) {
    if (error === rollback && outcome !== undefined) {
      return outcome.value;
    }

    throw error;
  }

  throw new Error("Rollback transaction unexpectedly committed.");
}
