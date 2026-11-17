import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  getTestDatabaseName,
  loadTestDatabaseEnvironment,
} from "./database-environment.ts";
import {
  createTestPrismaClient,
  resetTestDatabase,
  withRollbackTransaction,
} from "./database-harness.ts";

const environment = loadTestDatabaseEnvironment();
const prisma = createTestPrismaClient(environment);

describe("database test harness", () => {
  beforeAll(async () => {
    await resetTestDatabase(environment);
  });

  beforeEach(async () => {
    await resetTestDatabase(environment);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await resetTestDatabase(environment);
  });

  it("connects only to the configured isolated test database", async () => {
    const result = await prisma.$queryRaw<{ databaseName: string }[]>`
      SELECT current_database() AS "databaseName"
    `;

    expect(result[0]?.databaseName).toBe(
      getTestDatabaseName(
        environment.TEST_DATABASE_URL,
        environment.STOCKWISE_ALLOW_STOCKWISE_TEST === "1",
      ),
    );
  });

  it("rejects development and non-loopback targets before a reset", async () => {
    expect(() =>
      loadTestDatabaseEnvironment({
        TEST_DATABASE_URL:
          "postgresql://local-user:local-password@127.0.0.1:5432/stockwise_dev",
      }),
    ).toThrow("ending in _test");
    expect(() =>
      loadTestDatabaseEnvironment({
        TEST_DATABASE_URL:
          "postgresql://local-user:local-password@example.com:5432/stockwise_test",
      }),
    ).toThrow("loopback");
    expect(() =>
      loadTestDatabaseEnvironment({
        DATABASE_URL:
          "postgresql://local-user:local-password@127.0.0.1:5432/harness_equal_test",
        TEST_DATABASE_URL:
          "postgresql://local-user:local-password@127.0.0.1:5432/harness_equal_test",
      }),
    ).toThrow("must not equal");
    await expect(
      resetTestDatabase({
        TEST_DATABASE_URL:
          "postgresql://local-user:local-password@127.0.0.1:5432/stockwise_dev",
      }),
    ).rejects.toThrow("ending in _test");
    await expect(
      resetTestDatabase({
        TEST_DATABASE_URL:
          "postgresql://local-user:local-password@127.0.0.1:5432/stockwise_test",
      }),
    ).rejects.toThrow("stockwise_test is refused by default");
    await expect(
      resetTestDatabase({
        TEST_DATABASE_URL:
          "postgresql://local-user:local-password@127.0.0.1:5432/harness_safe_test?host=remote.example.com",
      }),
    ).rejects.toThrow("query parameters");
  });

  it("cleans non-domain probe objects between test runs", async () => {
    await prisma.$executeRawUnsafe("CREATE SCHEMA stockwise_test_harness");
    await prisma.$executeRawUnsafe(
      'CREATE TABLE stockwise_test_harness."__stockwise_test_probe" ("id" integer PRIMARY KEY)',
    );
    await resetTestDatabase(environment);

    const result = await prisma.$queryRaw<{ relation: string | null }[]>`
      SELECT to_regclass('stockwise_test_harness.__stockwise_test_probe')::text AS relation
    `;

    expect(result[0]?.relation).toBeNull();
  });

  it("rolls back isolated test transactions", async () => {
    await withRollbackTransaction(prisma, async (transaction) => {
      await transaction.$executeRawUnsafe(
        "CREATE SCHEMA stockwise_test_harness",
      );
      await transaction.$executeRawUnsafe(
        'CREATE TABLE stockwise_test_harness."__stockwise_transaction_probe" ("id" integer PRIMARY KEY)',
      );
    });

    const result = await prisma.$queryRaw<{ relation: string | null }[]>`
      SELECT to_regclass('stockwise_test_harness.__stockwise_transaction_probe')::text AS relation
    `;

    expect(result[0]?.relation).toBeNull();
  });
});
