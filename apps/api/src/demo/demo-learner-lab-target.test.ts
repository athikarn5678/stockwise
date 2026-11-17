import { afterEach, describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "../generated/prisma/client.ts";
import { DEMO_30D_ORGANIZATION } from "./demo-30d-plan.ts";
import {
  verifyDemoSeedTarget,
  verifyLearnerLabSeedTarget,
} from "./demo-local-database.ts";
import { demoId } from "./demo-values.ts";

const REFUSED = "Demo database disposable ownership verification failed.";
const DEMO_ORGANIZATION_ID = demoId("organization", DEMO_30D_ORGANIZATION);
const URL_OK = "postgresql://migrator:secret@127.0.0.1:41234/stockwise_demo";

interface FakeDatabase {
  currentDatabase: string;
  users: bigint;
  organizations: Array<{ id: string; name: string }>;
  products: bigint;
  sales: bigint;
}

const emptyDatabase = (): FakeDatabase => ({
  currentDatabase: "stockwise_demo",
  users: 0n,
  organizations: [],
  products: 0n,
  sales: 0n,
});

/** Structural fake of the three tagged-template queries the guard issues. */
function fakePrisma(database: FakeDatabase): PrismaClient {
  const queryRaw = (strings: TemplateStringsArray) => {
    const sql = strings.join("?");
    if (sql.includes("current_database()"))
      return Promise.resolve([{ name: database.currentDatabase }]);
    if (sql.includes("count(*) FROM users"))
      return Promise.resolve([
        {
          users: database.users,
          organizations: BigInt(database.organizations.length),
          products: database.products,
          sales: database.sales,
        },
      ]);
    if (sql.includes("FROM organizations"))
      return Promise.resolve(database.organizations);
    return Promise.reject(new Error(`unexpected query: ${sql}`));
  };
  // The guard only uses `$queryRaw`; nothing else of the client is reachable.
  return { $queryRaw: queryRaw } as unknown as PrismaClient;
}

function learnerLabEnvironment(overrides: Record<string, string | undefined>) {
  vi.stubEnv("DEMO_DATABASE_URL", URL_OK);
  vi.stubEnv("STOCKWISE_OPS_ROLE", "ops");
  vi.stubEnv("STOCKWISE_DEMO_SEED_TARGET", "learner-lab-ops");
  vi.stubEnv("STOCKWISE_RUNTIME_ENV", undefined);
  for (const [name, value] of Object.entries(overrides))
    vi.stubEnv(name, value);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Learner Lab seed target proof (no Docker receipt)", () => {
  it("accepts an empty *_demo database behind the loopback forwarder", async () => {
    learnerLabEnvironment({});
    await expect(
      verifyLearnerLabSeedTarget(fakePrisma(emptyDatabase())),
    ).resolves.toBe(URL_OK);
  });

  it("accepts a database that holds only the deterministic demo organization", async () => {
    learnerLabEnvironment({});
    const database = {
      ...emptyDatabase(),
      users: 5n,
      products: 12n,
      sales: 957n,
      organizations: [
        { id: DEMO_ORGANIZATION_ID, name: DEMO_30D_ORGANIZATION },
      ],
    };
    await expect(
      verifyLearnerLabSeedTarget(fakePrisma(database)),
    ).resolves.toBe(URL_OK);
  });

  it.each([
    ["the ops role is missing", { STOCKWISE_OPS_ROLE: undefined }],
    ["the role is not ops", { STOCKWISE_OPS_ROLE: "bootstrap" }],
    [
      "the seed target flag is missing",
      { STOCKWISE_DEMO_SEED_TARGET: undefined },
    ],
    [
      "the seed target flag has another value",
      { STOCKWISE_DEMO_SEED_TARGET: "local" },
    ],
    ["the runtime is production", { STOCKWISE_RUNTIME_ENV: "production" }],
    ["the URL is missing", { DEMO_DATABASE_URL: undefined }],
    [
      "the host is not 127.0.0.1",
      {
        DEMO_DATABASE_URL:
          "postgresql://u:p@db.example.com:5432/stockwise_demo",
      },
    ],
    [
      "the host is localhost",
      { DEMO_DATABASE_URL: "postgresql://u:p@localhost:5432/stockwise_demo" },
    ],
    [
      "the database name has no _demo suffix",
      { DEMO_DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/stockwise" },
    ],
    [
      "the database name looks like production",
      {
        DEMO_DATABASE_URL:
          "postgresql://u:p@127.0.0.1:5432/stockwise_prod_demo",
      },
    ],
    [
      "the database name looks like staging",
      { DEMO_DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/staging_demo" },
    ],
    [
      "the database name looks like a test database",
      { DEMO_DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/app_test_demo" },
    ],
    [
      "the URL carries a query string other than schema=public",
      { DEMO_DATABASE_URL: `${URL_OK}?sslmode=disable` },
    ],
    [
      "the URL is not PostgreSQL",
      { DEMO_DATABASE_URL: "mysql://u:p@127.0.0.1:3306/stockwise_demo" },
    ],
  ] as const)("refuses when %s", async (_label, overrides) => {
    learnerLabEnvironment(overrides);
    await expect(
      verifyLearnerLabSeedTarget(fakePrisma(emptyDatabase())),
    ).rejects.toThrow(REFUSED);
  });

  it("refuses when the connected database differs from the URL", async () => {
    learnerLabEnvironment({});
    await expect(
      verifyLearnerLabSeedTarget(
        fakePrisma({ ...emptyDatabase(), currentDatabase: "other_demo" }),
      ),
    ).rejects.toThrow(REFUSED);
  });

  it.each([
    [
      "a foreign organization with the demo name",
      [
        {
          id: "11111111-1111-4111-8111-111111111111",
          name: DEMO_30D_ORGANIZATION,
        },
      ],
    ],
    [
      "the deterministic id under another name",
      [{ id: DEMO_ORGANIZATION_ID, name: "Someone Else Ltd" }],
    ],
    [
      "the demo organization plus a second organization",
      [
        { id: DEMO_ORGANIZATION_ID, name: DEMO_30D_ORGANIZATION },
        { id: "22222222-2222-4222-8222-222222222222", name: "Real Tenant" },
      ],
    ],
  ] as const)("refuses %s", async (_label, organizations) => {
    learnerLabEnvironment({});
    await expect(
      verifyLearnerLabSeedTarget(
        fakePrisma({
          ...emptyDatabase(),
          users: 3n,
          products: 1n,
          organizations: [...organizations],
        }),
      ),
    ).rejects.toThrow(REFUSED);
  });

  it.each([
    ["users without any organization", { users: 1n }],
    ["products without any organization", { products: 1n }],
    ["sales without any organization", { sales: 1n }],
  ] as const)("refuses %s", async (_label, rows) => {
    learnerLabEnvironment({});
    await expect(
      verifyLearnerLabSeedTarget(fakePrisma({ ...emptyDatabase(), ...rows })),
    ).rejects.toThrow(REFUSED);
  });

  it("routes to the Learner Lab proof when the flag is set, with or without schema=public", async () => {
    learnerLabEnvironment({});
    await expect(
      verifyDemoSeedTarget(fakePrisma(emptyDatabase())),
    ).resolves.toBe(URL_OK);
    learnerLabEnvironment({ DEMO_DATABASE_URL: `${URL_OK}?schema=public` });
    await expect(
      verifyDemoSeedTarget(fakePrisma(emptyDatabase())),
    ).resolves.toBe(`${URL_OK}?schema=public`);
  });

  it("keeps the Docker receipt for every run that does not ask for the Learner Lab target", async () => {
    learnerLabEnvironment({
      STOCKWISE_DEMO_SEED_TARGET: undefined,
      DEMO_DISPOSABLE_RECEIPT: undefined,
      TEST_DISPOSABLE_RECEIPT: undefined,
    });
    // Ops role, an empty *_demo database and no receipt are not enough without the flag.
    await expect(
      verifyDemoSeedTarget(fakePrisma(emptyDatabase())),
    ).rejects.toThrow(REFUSED);
  });
});
