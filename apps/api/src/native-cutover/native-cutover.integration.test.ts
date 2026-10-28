import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { verifyLocalPostgresReceipt } from "../../../../tests/e2e/better-auth-d5/local-runner.mts";

import type { Prisma, PrismaClient } from "../generated/prisma/client.ts";
import {
  assertLegacyAuthorityAllowed,
  assertNativeCutoverReady,
} from "../modules/identity/better-auth-cutover-preflight.ts";
import {
  hashPassword,
  verifyPassword,
} from "../modules/identity/password-hasher.ts";
import { createPrismaClient } from "../prisma/client.ts";
import { loadTestDatabaseEnvironment } from "../test/database-environment.ts";
import {
  assertClusterOwned,
  assertScenarioOwned,
  assertScenarioUrl,
  authorizeChildTarget,
  createOwnedScenario,
  dropOwnedScenarioRole,
  dropOwnedScenarios,
  provisionScenarioRole,
  scenarioConnectionUrl,
  scenarioMarker as ownedScenarioMarker,
  withOwnedScenarioSession,
  type DisposableOwner,
  type OwnedSession,
  type ScenarioCredentials,
} from "../test/disposable-ownership.ts";
import { runNativeCutover } from "./native-cutover-runner.ts";

// Receipt-gated: only the D5 local coordinator's owned, disposable PostgreSQL
// container may run this suite. The receipt's shape alone authorizes nothing:
// every database creation, safety-setting fault injection and drop first
// proves, on the connection performing it, that the live cluster carries the
// receipt-bound marker (see ../test/disposable-ownership.ts). Every scenario
// gets its own freshly migrated LEGACY database in that cluster, marked with
// the receipt marker and dropped at teardown; the receipt's own test database
// is never transitioned here.
const database = loadTestDatabaseEnvironment();
const receiptText = process.env.STOCKWISE_LOCAL_DATABASE_RECEIPT;
if (!receiptText) throw new Error("Disposable operator receipt is required.");
const receipt: unknown = JSON.parse(receiptText);
if (
  !verifyLocalPostgresReceipt(
    receipt,
    process.env.DATABASE_URL ?? "",
    database.TEST_DATABASE_URL,
  )
)
  throw new Error("Disposable operator receipt is invalid.");

const owner: DisposableOwner = {
  runId: receipt.runId,
  database: receipt.database,
  testDatabase: receipt.testDatabase,
  marker: receipt.marker,
};
const scenarioMarker = ownedScenarioMarker(owner);
const apiDirectory = fileURLToPath(new URL("../../", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const prismaCli = fileURLToPath(
  new URL("../../node_modules/prisma/build/index.js", import.meta.url),
);
const cliEntry = fileURLToPath(
  new URL("./native-cutover-main.ts", import.meta.url),
);
const syntheticPassword = "disposable operator synthetic password 🔒";
const created: string[] = [];
let childProcesses = 0;
const clients: PrismaClient[] = [];
const outputs: string[] = [];
const sensitive = new Set<string>();
{
  const url = new URL(database.TEST_DATABASE_URL);
  sensitive.add(decodeURIComponent(url.password));
  sensitive.add(database.TEST_DATABASE_URL);
  sensitive.add(syntheticPassword);
}

function processEnvironment(extra: Record<string, string>) {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["SystemRoot", "WINDIR", "PATH", "Path", "TEMP", "TMP"])
    if (process.env[key] !== undefined) env[key] = process.env[key];
  return { ...env, ...extra };
}

async function runProcess(
  args: string[],
  cwd: string,
  extra: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  childProcesses++;
  const child = spawn(process.execPath, args, {
    cwd,
    env: processEnvironment(extra),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const closed = Promise.withResolvers<number | null>();
  child.once("error", closed.reject);
  child.once("close", closed.resolve);
  // Real process watchdog; fake timers cannot bound a child process.
  const timer = setTimeout(() => child.kill(), 120_000);
  try {
    return { code: await closed.promise, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

// The only holder of the administrative credential. Every use first proves, on
// that same connection, that it is the runner-owned cluster; otherwise the
// operation never runs.
async function admin<T>(operation: (client: Client) => Promise<T>) {
  const client = new Client({ connectionString: database.TEST_DATABASE_URL });
  await client.connect();
  try {
    await assertClusterOwned(client, owner);
    return await operation(client);
  } finally {
    await client.end();
  }
}

async function openScenario(url: string): Promise<OwnedSession> {
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

// Mutation boundary. The administrative credential stays in this process and
// only `admin()` (cluster-ownership proven per use) holds it. Every scenario
// has its own NOSUPERUSER role; its URL is the only database URL any child
// process, Prisma client or fault-injection session receives.
const scenarios = new Map<string, ScenarioCredentials>();
const issuedUrls = new Set<string>();
const inertUrls = new Set<string>();

async function newScenario(
  label: string,
  options: { replicaRole?: boolean } = {},
) {
  // Live ownership is proven on the creating connection before CREATE DATABASE
  // and again before the scenario role is created and granted.
  const { name, credentials } = await admin(async (client) => {
    const name = await createOwnedScenario(client, owner, label, (value) =>
      created.push(value),
    );
    return {
      name,
      credentials: await provisionScenarioRole(client, owner, name, options),
    };
  });
  const url = scenarioConnectionUrl(
    database.TEST_DATABASE_URL,
    name,
    credentials,
  );
  scenarios.set(name, credentials);
  issuedUrls.add(url);
  sensitive.add(url);
  sensitive.add(credentials.password);
  return { name, url, role: credentials.role };
}

// SQL that changes a scenario (safety settings, triggers, functions) runs only
// on a session that proved, on that very connection, the run's scenario
// marker and the scenario role.
function guarded<T>(
  name: string,
  url: string,
  operation: (session: OwnedSession) => Promise<T>,
): Promise<T> {
  const credentials = scenarios.get(name);
  if (!credentials) throw new Error("Unknown scenario.");
  assertScenarioUrl(
    url,
    database.TEST_DATABASE_URL,
    owner,
    name,
    credentials.role,
  );
  return withOwnedScenarioSession(
    () => openScenario(url),
    owner,
    name,
    operation,
    credentials.role,
  );
}

// The Prisma CLI opens its own connections, so a parent-side read cannot be
// atomic with them. The gate refuses substituted or unproven targets before
// the process starts; the role's server-side scope bounds what it can touch.
async function migrateScenario(name: string, url: string, role?: string) {
  const expectedRole = role ?? scenarios.get(name)?.role;
  if (!expectedRole) throw new Error("Unknown scenario.");
  await authorizeChildTarget(openScenario, owner, {
    adminUrl: database.TEST_DATABASE_URL,
    url,
    name,
    role: expectedRole,
  });
  const migrated = await runProcess(
    [prismaCli, "migrate", "deploy", "--config", "prisma.config.ts"],
    apiDirectory,
    { DATABASE_URL: url },
  );
  if (migrated.code !== 0) throw new Error("Scenario migration failed.");
}

async function freshLegacyDatabase(
  label: string,
  options: { replicaRole?: boolean } = {},
) {
  const { name, url } = await newScenario(label, options);
  await migrateScenario(name, url);
  const prisma = createPrismaClient({ DATABASE_URL: url });
  clients.push(prisma);
  return { name, url, prisma };
}

// Synthetic Legacy dataset in the accepted D5-P4 rehearsal pattern: verified,
// onboarded users with real Argon2id credentials across two tenants, several
// roles and branch assignments. `emailVerified` stays at its Legacy default
// (false) so the operator's verification reconciliation is exercised.
async function seedSynthetic(prisma: PrismaClient) {
  const tag = randomBytes(4).toString("hex").toUpperCase();
  const organization = await prisma.organization.create({
    data: { name: `Operator ${tag}`, salesVatStatus: "NOT_REGISTERED" },
  });
  const foreign = await prisma.organization.create({
    data: { name: `Operator foreign ${tag}` },
  });
  const branches = [];
  for (const [index, organizationId] of [
    organization.id,
    organization.id,
    foreign.id,
  ].entries())
    branches.push(
      await prisma.branch.create({
        data: {
          code: `OP${index}-${tag}`,
          name: `Operator branch ${index}`,
          organizationId,
        },
      }),
    );
  const members: {
    role: "OWNER" | "ADMIN" | "BRANCH_MANAGER" | "CASHIER" | "INVENTORY_STAFF";
    organizationId: string;
    branchIds: string[];
  }[] = [
    { role: "OWNER", organizationId: organization.id, branchIds: [] },
    { role: "ADMIN", organizationId: organization.id, branchIds: [] },
    {
      role: "BRANCH_MANAGER",
      organizationId: organization.id,
      branchIds: [branches[0]!.id],
    },
    {
      role: "CASHIER",
      organizationId: organization.id,
      branchIds: [branches[0]!.id, branches[1]!.id],
    },
    {
      role: "INVENTORY_STAFF",
      organizationId: foreign.id,
      branchIds: [branches[2]!.id],
    },
  ];
  for (const [index, member] of members.entries()) {
    const user = await prisma.user.create({
      data: {
        email: `operator-${tag.toLowerCase()}-${index}@example.test`,
        passwordHash: await hashPassword(syntheticPassword),
        status: "ACTIVE",
        displayName: `Operator synthetic ${index}`,
        emailVerifiedAt: new Date(Date.now() - 60_000),
        passwordChangedAt: new Date(Date.now() - 60_000),
      },
    });
    await prisma.organizationMembership.create({
      data: {
        organizationId: member.organizationId,
        role: member.role,
        userId: user.id,
      },
    });
    for (const branchId of member.branchIds)
      await prisma.branchAssignment.create({
        data: {
          branchId,
          organizationId: member.organizationId,
          userId: user.id,
        },
      });
  }
  for (const user of await prisma.user.findMany({
    select: { id: true, email: true, passwordHash: true },
  })) {
    sensitive.add(user.id);
    sensitive.add(user.email);
    sensitive.add(user.passwordHash);
  }
}

type CliEvent = Record<string, unknown> & { event: string };
async function cli(url: string | undefined, args: string[]) {
  // A child process may receive only an issued scenario-role URL, an inert
  // synthetic one, or an unparsable value used to test configuration errors;
  // never the administrative credential or a database the suite did not issue.
  if (url !== undefined && !issuedUrls.has(url) && !inertUrls.has(url)) {
    let parsable = true;
    try {
      new URL(url);
    } catch {
      parsable = false;
    }
    if (parsable) throw new Error("Child target is not an issued URL.");
  }
  const result = await runProcess(
    ["--experimental-strip-types", cliEntry, ...args],
    repositoryRoot,
    url === undefined ? {} : { DATABASE_URL: url },
  );
  outputs.push(result.stdout, result.stderr);
  const events = result.stdout
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as CliEvent);
  return { code: result.code, events, last: events.at(-1) };
}

async function fence(prisma: PrismaClient) {
  const rows = await prisma.$queryRaw<
    {
      state: string;
      run_id: string | null;
      quiesced_at: Date | null;
      sealed_at: Date | null;
    }[]
  >`SELECT state, run_id, quiesced_at, sealed_at FROM native_auth_transition`;
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

async function authorityState(prisma: PrismaClient) {
  return {
    fence: await fence(prisma),
    accounts: await prisma.betterAuthAccount.count(),
    enrollments: await prisma.nativeAuthEnrollment.count(),
    liveLegacySessions: await prisma.session.count({
      where: { revokedAt: null },
    }),
    nativeMarked: await prisma.user.count({
      where: { nativeRegistrationCompletedAt: { not: null } },
    }),
  };
}

async function businessIdentity(prisma: PrismaClient) {
  return {
    users: await prisma.user.findMany({
      select: { id: true, email: true, passwordHash: true },
      orderBy: { id: "asc" },
    }),
    memberships: await prisma.organizationMembership.findMany({
      orderBy: { id: "asc" },
    }),
    assignments: await prisma.branchAssignment.findMany({
      orderBy: [{ userId: "asc" }, { branchId: "asc" }],
    }),
  };
}

// R2 helpers: Legacy identities and pre-existing Native destination records.
// A Better Auth account row can be written while the fence is LEGACY with no
// transition provenance; that is the state the readiness preflight rejects and
// the transition writer can never repair (enrollment exists only during a run).
async function legacyIdentity(
  prisma: PrismaClient,
  label: string,
  extra: Partial<Prisma.UserUncheckedCreateInput> = {},
) {
  const user = await prisma.user.create({
    data: {
      email: `operator-${label}-${randomBytes(4).toString("hex")}@example.test`,
      passwordHash: await hashPassword(syntheticPassword),
      status: "ACTIVE",
      displayName: `Operator ${label}`,
      emailVerified: true,
      emailVerifiedAt: new Date(Date.now() - 120_000),
      passwordChangedAt: new Date(Date.now() - 120_000),
      ...extra,
    },
  });
  sensitive.add(user.id);
  sensitive.add(user.email);
  return user;
}

async function destinationAccount(
  prisma: PrismaClient,
  user: { id: string; passwordHash: string },
  extra: Partial<Prisma.BetterAuthAccountUncheckedCreateInput> = {},
) {
  return prisma.betterAuthAccount.create({
    data: {
      id: randomUUID(),
      userId: user.id,
      providerId: "credential",
      accountId: user.id,
      password: user.passwordHash,
      ...extra,
    },
  });
}

async function onboardedMember(prisma: PrismaClient, userId: string) {
  const organization = await prisma.organization.create({
    data: {
      name: `Operator org ${randomBytes(3).toString("hex")}`,
      salesVatStatus: "NOT_REGISTERED",
    },
  });
  await prisma.organizationMembership.create({
    data: { organizationId: organization.id, role: "OWNER", userId },
  });
}

const disabledFields = {
  status: "DISABLED",
  disabledAt: new Date(Date.now() - 60_000),
} as const;

// Deterministic trigger fault for one user's enrollment. Install and removal
// each open their own session and prove scenario ownership on it first, so a
// reconnected or mismatched session cannot create or drop these objects.
const enrollmentFaultFunction = (userId: string) =>
  `CREATE FUNCTION public.operator_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id = '${userId}'::uuid THEN RAISE EXCEPTION 'synthetic operator fault'; END IF; RETURN NEW; END $$`;
const enrollmentFaultTrigger =
  "CREATE TRIGGER operator_fault BEFORE INSERT ON public.native_auth_enrollments FOR EACH ROW EXECUTE FUNCTION public.operator_fault()";

async function installEnrollmentFault(
  name: string,
  url: string,
  userId: string,
) {
  if (!/^[0-9a-f-]{36}$/.test(userId)) throw new Error("Invalid user id.");
  await guarded(name, url, async (session) => {
    await session.query(enrollmentFaultFunction(userId));
    await session.query(enrollmentFaultTrigger);
  });
}

async function removeEnrollmentFault(name: string, url: string) {
  await guarded(name, url, async (session) => {
    await session.query(
      "DROP TRIGGER IF EXISTS operator_fault ON public.native_auth_enrollments",
    );
    await session.query("DROP FUNCTION IF EXISTS public.operator_fault()");
  });
}

async function addLegacySession(prisma: PrismaClient, userId: string) {
  const now = Date.now();
  await prisma.session.create({
    data: {
      userId,
      tokenHash: randomBytes(32).toString("hex"),
      idleExpiresAt: new Date(now + 86_400_000),
      absoluteExpiresAt: new Date(now + 7 * 86_400_000),
    },
  });
}

afterAll(async () => {
  for (const prisma of clients) await prisma.$disconnect();
  // Drops only databases this suite created and marked, and only after the
  // cluster proved ownership on the dropping connection; a refusal drops nothing.
  await admin((client) => dropOwnedScenarios(client, owner, created));
});

async function databaseNames(client: Client): Promise<string[]> {
  const rows = await client.query<{ datname: string }>(
    "SELECT datname FROM pg_database ORDER BY datname",
  );
  return rows.rows.map((row) => row.datname);
}

async function roleNames(client: Client): Promise<string[]> {
  const rows = await client.query<{ rolname: string }>(
    "SELECT rolname FROM pg_roles ORDER BY rolname",
  );
  return rows.rows.map((row) => row.rolname);
}

async function faultObjects(name: string, url: string) {
  return guarded(name, url, async (session) => {
    const rows = await session.query(
      `SELECT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'operator_fault' AND pronamespace = 'public'::regnamespace) AS fn,
              EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'operator_fault') AS trg`,
    );
    return { fn: rows.rows[0]?.fn, trg: rows.rows[0]?.trg };
  });
}

// Forged receipts and tampered markers are exercised only against this run's
// own runner-owned disposable cluster (the receipt above already authorized
// this process); the database-free matrix lives in
// ../test/disposable-ownership.test.ts.
describe("live ownership guard on the runner-owned cluster", () => {
  const forgedOwner: DisposableOwner = {
    ...owner,
    marker: randomBytes(32).toString("base64url"),
  };
  const tamperedMarker = "stockwise-local:not-this-run";

  it("permits the live receipt marker and refuses a forged receipt before any create, role, injection or drop", async () => {
    const scenario = await newScenario("ownership");
    await admin(async (client) => {
      await expect(assertClusterOwned(client, owner)).resolves.toBeUndefined();
      const databases = await databaseNames(client);
      const roles = await roleNames(client);
      expect(databases).toContain(scenario.name);
      expect(roles).toContain(scenario.role);

      const forgedCreated: string[] = [];
      await expect(
        createOwnedScenario(client, forgedOwner, "forged", (value) =>
          forgedCreated.push(value),
        ),
      ).rejects.toMatchObject({ reason: "ANCHOR_MARKER_MISMATCH" });
      expect(forgedCreated).toEqual([]);
      await expect(
        provisionScenarioRole(client, forgedOwner, scenario.name),
      ).rejects.toMatchObject({ reason: "ANCHOR_MARKER_MISMATCH" });
      // A forged receipt cannot drop an owned scenario database or its role.
      await expect(
        dropOwnedScenarios(client, forgedOwner, [scenario.name]),
      ).rejects.toMatchObject({ reason: "ANCHOR_MARKER_MISMATCH" });
      await expect(
        dropOwnedScenarioRole(client, forgedOwner, scenario.name),
      ).rejects.toMatchObject({ reason: "ANCHOR_MARKER_MISMATCH" });
      expect(await databaseNames(client)).toEqual(databases);
      expect(await roleNames(client)).toEqual(roles);
    });

    // Nor can it reach any session that changes the scenario.
    let injected = false;
    await expect(
      withOwnedScenarioSession(
        () => openScenario(scenario.url),
        forgedOwner,
        scenario.name,
        async () => {
          injected = true;
        },
        scenario.role,
      ),
    ).rejects.toMatchObject({ reason: "ANCHOR_MARKER_MISMATCH" });
    expect(injected).toBe(false);
    await guarded(scenario.name, scenario.url, async (session) => {
      injected = true;
      await session.query("SELECT 1");
    });
    expect(injected).toBe(true);
  }, 60_000);

  it("never lets an administrative or foreign-role session stand in for the scenario role", async () => {
    const scenario = await newScenario("rolecheck");
    // Same scenario database and exact marker, but the superuser credential.
    const administrative = new URL(database.TEST_DATABASE_URL);
    administrative.pathname = `/${scenario.name}`;
    let injected = false;
    await expect(
      withOwnedScenarioSession(
        () => openScenario(administrative.toString()),
        owner,
        scenario.name,
        async () => {
          injected = true;
        },
        scenario.role,
      ),
    ).rejects.toMatchObject({ reason: "ROLE_MISMATCH" });
    expect(injected).toBe(false);
  }, 60_000);

  it("scopes each scenario role to its own database and gives it no administrative power", async () => {
    const first = await newScenario("scopea");
    const second = await newScenario("scopeb");

    // The password is valid only for this role; guessing one fails.
    const wrongPassword = new URL(first.url);
    wrongPassword.password = randomBytes(18).toString("base64url");
    await expect(openScenario(wrongPassword.toString())).rejects.toThrow();

    // Substituting another scenario's database is refused by PostgreSQL.
    const otherDatabase = new URL(first.url);
    otherDatabase.pathname = `/${second.name}`;
    await expect(openScenario(otherDatabase.toString())).rejects.toThrow();

    await guarded(first.name, first.url, async (session) => {
      const flags = await session.query(
        `SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
           FROM pg_roles WHERE rolname = current_user`,
      );
      expect(flags.rows[0]).toEqual({
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
        rolbypassrls: false,
      });
      // Read-only privilege introspection: nothing is attempted or mutated.
      const privileges = await session.query(
        `SELECT has_database_privilege(current_user, $1, 'CONNECT') AS own_connect,
                has_database_privilege(current_user, $2, 'CONNECT') AS sibling_connect,
                has_database_privilege(current_user, $2, 'CREATE') AS sibling_create,
                has_database_privilege(current_user, $3, 'CREATE') AS runner_create,
                has_parameter_privilege(current_user, 'session_replication_role', 'SET') AS replica_set`,
        [first.name, second.name, owner.testDatabase],
      );
      expect(privileges.rows[0]).toEqual({
        own_connect: true,
        sibling_connect: false,
        sibling_create: false,
        runner_create: false,
        replica_set: false,
      });
    });
  }, 60_000);

  it("refuses trigger and function creation and cleanup on a session whose live ownership does not match", async () => {
    const scenario = await newScenario("faultguard");
    // A stand-in table: the guarded helpers target this exact public name.
    await guarded(scenario.name, scenario.url, async (session) => {
      await session.query(
        "CREATE TABLE public.native_auth_enrollments (user_id uuid)",
      );
    });
    const userId = randomUUID();
    const tamper = (marker: string) =>
      admin((client) =>
        client.query(`COMMENT ON DATABASE "${scenario.name}" IS '${marker}'`),
      );

    // Reconnected session with a mismatched scenario marker: nothing is created.
    await tamper(tamperedMarker);
    try {
      await expect(
        installEnrollmentFault(scenario.name, scenario.url, userId),
      ).rejects.toMatchObject({ reason: "SCENARIO_MARKER_MISMATCH" });
    } finally {
      await tamper(scenarioMarker);
    }
    expect(await faultObjects(scenario.name, scenario.url)).toEqual({
      fn: false,
      trg: false,
    });

    // Valid ownership permits the same helper to create both objects...
    await installEnrollmentFault(scenario.name, scenario.url, userId);
    expect(await faultObjects(scenario.name, scenario.url)).toEqual({
      fn: true,
      trg: true,
    });

    // ...and a mismatched session cannot remove them.
    await tamper(tamperedMarker);
    try {
      await expect(
        removeEnrollmentFault(scenario.name, scenario.url),
      ).rejects.toMatchObject({ reason: "SCENARIO_MARKER_MISMATCH" });
    } finally {
      await tamper(scenarioMarker);
    }
    expect(await faultObjects(scenario.name, scenario.url)).toEqual({
      fn: true,
      trg: true,
    });
    await removeEnrollmentFault(scenario.name, scenario.url);
    expect(await faultObjects(scenario.name, scenario.url)).toEqual({
      fn: false,
      trg: false,
    });
  }, 60_000);

  it("gates the migration subprocess on the exact scenario role URL and a verified live target", async () => {
    const scenario = await newScenario("migrategate");
    const base = new URL(scenario.url);
    const withChange = (change: (url: URL) => void) => {
      const url = new URL(base);
      change(url);
      return url.toString();
    };
    const administrative = new URL(database.TEST_DATABASE_URL);
    administrative.pathname = `/${scenario.name}`;
    const substitutions = [
      // Another database, including the runner's own receipt database.
      withChange((url) => (url.pathname = `/${owner.testDatabase}`)),
      withChange((url) => (url.pathname = "/postgres")),
      // Another host or port, the administrative credential, another scheme,
      // and smuggled connection parameters.
      withChange((url) => (url.port = "1")),
      withChange((url) => (url.hostname = "localhost")),
      administrative.toString(),
      withChange((url) => (url.protocol = "postgres:")),
      withChange((url) => url.searchParams.set("options", "-c role=postgres")),
    ];
    const spawned = childProcesses;
    for (const candidate of substitutions)
      await expect(
        migrateScenario(scenario.name, candidate),
      ).rejects.toMatchObject({ reason: "TARGET_URL_REJECTED" });
    expect(childProcesses).toBe(spawned);

    // The URL is right but the live target no longer carries this run's marker:
    // refused before the migration process exists, so no migration ledger.
    const tamper = (marker: string) =>
      admin((client) =>
        client.query(`COMMENT ON DATABASE "${scenario.name}" IS '${marker}'`),
      );
    await tamper(tamperedMarker);
    try {
      await expect(
        migrateScenario(scenario.name, scenario.url),
      ).rejects.toMatchObject({ reason: "SCENARIO_MARKER_MISMATCH" });
    } finally {
      await tamper(scenarioMarker);
    }
    expect(childProcesses).toBe(spawned);
    await guarded(scenario.name, scenario.url, async (session) => {
      const rows = await session.query(
        "SELECT to_regclass('public._prisma_migrations') IS NULL AS untouched",
      );
      expect(rows.rows[0]?.untouched).toBe(true);
    });
  }, 60_000);

  it("never drops a database or role whose marker is not this run's", async () => {
    const tamperedDatabase = await newScenario("keepdatabase");
    const tamperedRole = await newScenario("keeprole");
    await admin(async (client) => {
      await client.query(
        `COMMENT ON DATABASE "${tamperedDatabase.name}" IS '${tamperedMarker}'`,
      );
      await client.query(
        `COMMENT ON ROLE "${tamperedRole.role}" IS '${tamperedMarker}'`,
      );
      try {
        const result = await dropOwnedScenarios(client, owner, [
          tamperedDatabase.name,
          tamperedRole.name,
        ]);
        expect(result.dropped).toEqual([tamperedRole.name]);
        expect(result.skipped).toEqual([tamperedDatabase.name]);
        expect(result.rolesDropped).toEqual([]);
        const databases = await databaseNames(client);
        const roles = await roleNames(client);
        expect(databases).toContain(tamperedDatabase.name);
        expect(databases).not.toContain(tamperedRole.name);
        expect(roles).toContain(tamperedDatabase.role);
        expect(roles).toContain(tamperedRole.role);
      } finally {
        // Restore the exact markers so teardown may remove both scenarios.
        await client.query(
          `COMMENT ON DATABASE "${tamperedDatabase.name}" IS '${scenarioMarker}'`,
        );
        await client.query(
          `COMMENT ON ROLE "${tamperedRole.role}" IS '${scenarioMarker}'`,
        );
      }
      await expect(
        dropOwnedScenarioRole(client, owner, tamperedRole.name),
      ).resolves.toBe(true);
      expect(await roleNames(client)).not.toContain(tamperedRole.role);
      const probe = await openScenario(tamperedDatabase.url);
      try {
        await expect(
          assertScenarioOwned(
            probe,
            owner,
            tamperedDatabase.name,
            tamperedDatabase.role,
          ),
        ).resolves.toBeUndefined();
      } finally {
        await probe.end();
      }
    });
  }, 60_000);
});

describe("operator Native cutover", () => {
  it("seals an empty migrated database and passes the Native startup preflight", async () => {
    const { name, url, prisma } = await freshLegacyDatabase("empty");
    await expect(assertLegacyAuthorityAllowed(prisma)).resolves.toBeUndefined();
    await expect(assertNativeCutoverReady(prisma)).rejects.toThrow();

    const result = await cli(url, ["--confirm-database", name]);
    expect(result.code).toBe(0);
    expect(result.events.map((event) => event.event)).toEqual([
      "preflight",
      "quiesced",
      "enrollment",
      "reconciliation",
      "sealed",
      "native_ready",
      "complete",
    ]);
    expect(result.last).toMatchObject({
      outcome: "SEALED_NATIVE",
      users: 0,
      enrolled: 0,
      replayed: 0,
      ineligible: 0,
    });
    const state = await authorityState(prisma);
    expect(state.fence.state).toBe("NATIVE");
    expect(state.fence.run_id).toBe(result.last?.runId);
    expect(state.enrollments).toBe(0);
    await expect(assertNativeCutoverReady(prisma)).resolves.toBeUndefined();
    // No downgrade: Legacy startup is refused once the fence has left LEGACY.
    await expect(assertLegacyAuthorityAllowed(prisma)).rejects.toThrow(
      "Legacy authentication startup refused.",
    );

    // Already NATIVE: revalidation only, with or without --resume.
    for (const args of [
      ["--confirm-database", name],
      ["--confirm-database", name, "--resume"],
    ]) {
      const again = await cli(url, args);
      expect(again.code).toBe(0);
      expect(again.events.map((event) => event.event)).toEqual([
        "already_native",
        "complete",
      ]);
      expect(again.last).toMatchObject({
        outcome: "ALREADY_NATIVE",
        runId: state.fence.run_id,
        enrolled: 0,
      });
      expect(await authorityState(prisma)).toEqual(state);
    }
  }, 180_000);

  it("enrolls a synthetic Legacy dataset preserving identities, memberships, assignments and credentials", async () => {
    const { name, url, prisma } = await freshLegacyDatabase("synthetic");
    await seedSynthetic(prisma);
    // One unverified identity must stay unenrolled and restricted.
    const unverified = await prisma.user.create({
      data: {
        email: `operator-unverified-${receipt.runId}@example.test`,
        displayName: "Unverified synthetic",
      },
    });
    sensitive.add(unverified.id);
    sensitive.add(unverified.email);
    const legacyUser = await prisma.user.findFirstOrThrow({
      where: { emailVerifiedAt: { not: null } },
      orderBy: { id: "asc" },
    });
    await addLegacySession(prisma, legacyUser.id);
    const before = await businessIdentity(prisma);
    const eligible = before.users.filter((user) => user.id !== unverified.id);
    const mismatched = await prisma.user.count({
      where: { emailVerifiedAt: { not: null }, emailVerified: false },
    });
    expect(mismatched).toBeGreaterThan(0);
    expect((await authorityState(prisma)).liveLegacySessions).toBe(1);

    const result = await cli(url, ["--confirm-database", name]);
    expect(result.code).toBe(0);
    expect(result.last).toMatchObject({
      outcome: "SEALED_NATIVE",
      users: before.users.length,
      verificationReconciled: mismatched,
      enrolled: eligible.length,
      replayed: 0,
      ineligible: 1,
    });

    const after = await businessIdentity(prisma);
    expect(after).toEqual(before);
    const state = await authorityState(prisma);
    expect(state.fence.state).toBe("NATIVE");
    expect(state.liveLegacySessions).toBe(0);
    expect(state.enrollments).toBe(eligible.length);
    expect(state.accounts).toBe(eligible.length);
    for (const user of eligible) {
      const accounts = await prisma.betterAuthAccount.findMany({
        where: { userId: user.id },
      });
      expect(accounts).toHaveLength(1);
      expect(accounts[0]).toMatchObject({
        providerId: "credential",
        accountId: user.id,
        password: user.passwordHash,
      });
      expect(
        await verifyPassword(accounts[0]!.password!, syntheticPassword),
      ).toBe(true);
    }
    expect(
      await prisma.betterAuthAccount.count({
        where: { userId: unverified.id },
      }),
    ).toBe(0);
    await expect(assertNativeCutoverReady(prisma)).resolves.toBeUndefined();
  }, 300_000);

  it("refuses wrong targets and invalid configuration before any mutation, then resumes an interrupted run without duplication", async () => {
    const { name, url, prisma } = await freshLegacyDatabase("resume");
    await seedSynthetic(prisma);
    const firstUser = await prisma.user.findFirstOrThrow({
      orderBy: { id: "asc" },
    });
    await addLegacySession(prisma, firstUser.id);
    const pristine = await authorityState(prisma);
    expect(pristine.fence).toMatchObject({ state: "LEGACY", run_id: null });

    // Wrong target, missing confirmation, invalid URL, unknown flag and a
    // resume request on a LEGACY database all refuse with fixed codes.
    const refusals: [string | undefined, string[], string][] = [
      [
        url,
        ["--confirm-database", `${name}_other`],
        "NATIVE_CUTOVER_TARGET_MISMATCH",
      ],
      [url, [], "NATIVE_CUTOVER_CONFIRMATION_REQUIRED"],
      [
        undefined,
        ["--confirm-database", name],
        "NATIVE_CUTOVER_DATABASE_URL_INVALID",
      ],
      [
        "not-a-url",
        ["--confirm-database", name],
        "NATIVE_CUTOVER_DATABASE_URL_INVALID",
      ],
      [url, ["--confirm-database", name, "--force"], "NATIVE_CUTOVER_FAILED"],
      [
        url,
        ["--confirm-database", name, "--resume"],
        "NATIVE_CUTOVER_NOTHING_TO_RESUME",
      ],
    ];
    for (const [target, args, reason] of refusals) {
      const refused = await cli(target, args);
      expect(refused.code).toBe(1);
      expect(refused.events).toEqual([{ event: "refused", reason }]);
      expect(await authorityState(prisma)).toEqual(pristine);
    }

    // The target is re-verified inside every writer transaction, not only by
    // the first check: a forged first answer cannot reach a write.
    let forged = false;
    const forging = new Proxy(prisma, {
      get(target, property, receiver) {
        if (property === "$queryRaw" && !forged) {
          forged = true;
          return async () => [{ name: `${name}_forged` }];
        }
        return Reflect.get(target, property, receiver);
      },
    }) as PrismaClient;
    await expect(
      runNativeCutover({
        prisma: forging,
        confirmDatabase: `${name}_forged`,
        resume: false,
        report() {},
      }),
    ).rejects.toThrow(
      "TRANSITION_OPERATION_REFUSED:TRANSITION_TARGET_MISMATCH",
    );
    expect(await authorityState(prisma)).toEqual(pristine);

    // Deterministic fault on the disposable target: one user's enrollment
    // fails after earlier users were enrolled, leaving a QUIESCED run.
    const users = await prisma.user.findMany({
      select: { id: true },
      orderBy: { id: "asc" },
    });
    expect(users.length).toBeGreaterThanOrEqual(3);
    const failing = users[Math.floor(users.length / 2)]!.id;
    await installEnrollmentFault(name, url, failing);
    try {
      const interrupted = await cli(url, ["--confirm-database", name]);
      expect(interrupted.code).toBe(1);
      expect(interrupted.last?.event).toBe("refused");
      expect(String(interrupted.last?.reason)).toMatch(
        /^TRANSITION_OPERATION_REFUSED:[A-Z0-9_]+$/,
      );
    } finally {
      await removeEnrollmentFault(name, url);
    }
    const partial = await authorityState(prisma);
    expect(partial.fence.state).toBe("QUIESCED");
    expect(partial.fence.run_id).not.toBeNull();
    expect(partial.liveLegacySessions).toBe(0);
    expect(partial.enrollments).toBeGreaterThan(0);
    expect(partial.enrollments).toBeLessThan(users.length);
    expect(
      await prisma.nativeAuthEnrollment.count({ where: { userId: failing } }),
    ).toBe(0);

    // An ordinary retry of an interrupted run is refused without changes.
    const retry = await cli(url, ["--confirm-database", name]);
    expect(retry.code).toBe(1);
    expect(retry.events).toEqual([
      { event: "refused", reason: "NATIVE_CUTOVER_RESUME_REQUIRED" },
    ]);
    expect(await authorityState(prisma)).toEqual(partial);
    await expect(assertNativeCutoverReady(prisma)).rejects.toThrow();
    await expect(assertLegacyAuthorityAllowed(prisma)).rejects.toThrow();

    // An explicit resume completes under the stored run without duplicates.
    const resumed = await cli(url, ["--confirm-database", name, "--resume"]);
    expect(resumed.code).toBe(0);
    expect(resumed.last).toMatchObject({
      outcome: "SEALED_NATIVE",
      runId: partial.fence.run_id,
      replayed: partial.enrollments,
      enrolled: users.length - partial.enrollments,
      ineligible: 0,
    });
    const sealed = await authorityState(prisma);
    expect(sealed.fence).toMatchObject({
      state: "NATIVE",
      run_id: partial.fence.run_id,
    });
    expect(sealed.enrollments).toBe(users.length);
    expect(sealed.accounts).toBe(users.length);
    for (const { id } of users)
      expect(
        await prisma.betterAuthAccount.count({ where: { userId: id } }),
      ).toBe(1);
    await expect(assertNativeCutoverReady(prisma)).resolves.toBeUndefined();
  }, 300_000);

  it("interrupted after quiesce, resumes from zero enrollments", async () => {
    const { name, url, prisma } = await freshLegacyDatabase("quiesced");
    await seedSynthetic(prisma);
    const userCount = await prisma.user.count();
    await expect(
      runNativeCutover({
        prisma,
        confirmDatabase: name,
        resume: false,
        report(event) {
          if (event.event === "quiesced") throw new Error("SYNTHETIC_STOP");
        },
      }),
    ).rejects.toThrow("SYNTHETIC_STOP");
    const quiesced = await authorityState(prisma);
    expect(quiesced.fence.state).toBe("QUIESCED");
    expect(quiesced.enrollments).toBe(0);

    const resumed = await cli(url, ["--confirm-database", name, "--resume"]);
    expect(resumed.code).toBe(0);
    expect(resumed.last).toMatchObject({
      outcome: "SEALED_NATIVE",
      runId: quiesced.fence.run_id,
      enrolled: userCount,
      replayed: 0,
    });
    await expect(assertNativeCutoverReady(prisma)).resolves.toBeUndefined();
  }, 300_000);

  it("refuses before quiesce when a Legacy identity cannot be reconciled for Native readiness", async () => {
    const { name, url, prisma } = await freshLegacyDatabase("unresolvable");
    const disabled = await prisma.user.create({
      data: {
        email: `operator-disabled-${receipt.runId}@example.test`,
        passwordHash: await hashPassword(syntheticPassword),
        status: "DISABLED",
        disabledAt: new Date(Date.now() - 60_000),
        displayName: "Disabled synthetic",
        emailVerifiedAt: new Date(Date.now() - 120_000),
        passwordChangedAt: new Date(Date.now() - 120_000),
      },
    });
    sensitive.add(disabled.id);
    sensitive.add(disabled.email);
    const pristine = await authorityState(prisma);

    const refused = await cli(url, ["--confirm-database", name]);
    expect(refused.code).toBe(1);
    expect(refused.last).toEqual({
      event: "refused",
      reason: "NATIVE_CUTOVER_UNRESOLVED_IDENTITIES",
    });
    // Still editable Legacy data: nothing quiesced, revoked or enrolled.
    expect(await authorityState(prisma)).toEqual(pristine);
    await expect(assertLegacyAuthorityAllowed(prisma)).resolves.toBeUndefined();

    // Once the Legacy record is consistent the same command completes.
    await prisma.user.update({
      where: { id: disabled.id },
      data: { emailVerified: true },
    });
    const sealed = await cli(url, ["--confirm-database", name]);
    expect(sealed.code).toBe(0);
    expect(sealed.last).toMatchObject({
      outcome: "SEALED_NATIVE",
      enrolled: 0,
      ineligible: 1,
    });
    await expect(assertNativeCutoverReady(prisma)).resolves.toBeUndefined();
  }, 120_000);

  // R2 (Codex D5-P5-REVIEW-02): a destination record that exists while the
  // fence is still LEGACY has no enrollment provenance and never can gain it,
  // because enrollment rows exist only for the active run. Each variant below
  // used to either seal an unusable NATIVE database or strand the run
  // QUIESCED; the operator must now refuse while the data is still editable.
  const unresolvedDestinations: [
    string,
    (prisma: PrismaClient) => Promise<void>,
  ][] = [
    [
      "disabledaccount",
      async (prisma) => {
        const user = await legacyIdentity(prisma, "disabled", disabledFields);
        await destinationAccount(prisma, user);
      },
    ],
    [
      "disabledmarked",
      async (prisma) => {
        const user = await legacyIdentity(prisma, "marked", {
          ...disabledFields,
          nativeRegistrationCompletedAt: new Date(Date.now() - 30_000),
        });
        await destinationAccount(prisma, user);
      },
    ],
    [
      "unverifiedaccount",
      async (prisma) => {
        const user = await legacyIdentity(prisma, "unverified", {
          emailVerified: false,
          emailVerifiedAt: null,
        });
        await destinationAccount(prisma, user);
      },
    ],
    [
      "activeaccount",
      async (prisma) => {
        const user = await legacyIdentity(prisma, "active");
        await onboardedMember(prisma, user.id);
        await destinationAccount(prisma, user);
      },
    ],
    [
      "markedonly",
      async (prisma) => {
        const user = await legacyIdentity(prisma, "markedonly", {
          nativeRegistrationCompletedAt: new Date(Date.now() - 30_000),
        });
        await onboardedMember(prisma, user.id);
      },
    ],
    [
      "foreignprovider",
      async (prisma) => {
        const user = await legacyIdentity(prisma, "provider", disabledFields);
        await destinationAccount(prisma, user, {
          providerId: "other",
          accountId: `external-${randomUUID()}`,
        });
      },
    ],
    [
      "crossedaccount",
      async (prisma) => {
        const owner = await legacyIdentity(prisma, "owner", disabledFields);
        const other = await legacyIdentity(prisma, "other", disabledFields);
        // Credential account of `owner` addressed to `other`'s identity.
        await destinationAccount(prisma, owner, { accountId: other.id });
      },
    ],
  ];

  it.each(unresolvedDestinations)(
    "refuses before quiesce and leaves LEGACY intact: existing destination (%s)",
    async (label, build) => {
      const { name, url, prisma } = await freshLegacyDatabase(label);
      await build(prisma);
      const pristine = await authorityState(prisma);
      expect(pristine.fence).toMatchObject({ state: "LEGACY", run_id: null });

      const refused = await cli(url, ["--confirm-database", name]);
      expect(refused.code).toBe(1);
      expect(refused.last).toEqual({
        event: "refused",
        reason: "NATIVE_CUTOVER_UNRESOLVED_IDENTITIES",
      });
      expect(refused.events.map((event) => event.event)).not.toContain(
        "quiesced",
      );
      // Nothing irreversible happened: still LEGACY, nothing revoked or enrolled.
      expect(await authorityState(prisma)).toEqual(pristine);
      await expect(
        assertLegacyAuthorityAllowed(prisma),
      ).resolves.toBeUndefined();
    },
    120_000,
  );

  it("completes once the unresolved destination record is removed while the data is still LEGACY", async () => {
    const { name, url, prisma } = await freshLegacyDatabase("recoverable");
    const disabled = await legacyIdentity(prisma, "disabled", disabledFields);
    const account = await destinationAccount(prisma, disabled);
    const eligible = await legacyIdentity(prisma, "eligible");
    await onboardedMember(prisma, eligible.id);

    const refused = await cli(url, ["--confirm-database", name]);
    expect(refused.last).toMatchObject({
      reason: "NATIVE_CUTOVER_UNRESOLVED_IDENTITIES",
    });
    // LEGACY is editable: an operator can correct the record and re-run.
    await prisma.betterAuthAccount.delete({ where: { id: account.id } });
    const sealed = await cli(url, ["--confirm-database", name]);
    expect(sealed.code).toBe(0);
    expect(sealed.last).toMatchObject({
      outcome: "SEALED_NATIVE",
      enrolled: 1,
      ineligible: 1,
    });
    await expect(assertNativeCutoverReady(prisma)).resolves.toBeUndefined();
  }, 120_000);

  it("refuses to seal when a destination record without provenance appears after quiesce", async () => {
    const { name, url, prisma } = await freshLegacyDatabase("presealguard", {
      replicaRole: true,
    });
    const disabled = await legacyIdentity(prisma, "late", disabledFields);
    const eligible = await legacyIdentity(prisma, "eligible");
    await onboardedMember(prisma, eligible.id);

    // Fault injection on this disposable scenario database only: after the
    // enrollment pass a provenance-free account row is written for the disabled
    // user, bypassing the fence with session_replication_role (simulating a
    // restored or tampered store). The guard must refuse before the seal.
    const accountId = randomUUID();
    await expect(
      runNativeCutover({
        prisma,
        confirmDatabase: name,
        resume: false,
        async report(event) {
          if (event.event !== "enrollment") return;
          await guarded(name, url, async (injector) => {
            await injector.query("SET session_replication_role = replica");
            await injector.query(
              "INSERT INTO better_auth_accounts (id, user_id, account_id, provider_id, password, created_at, updated_at) VALUES ($1, $2, $3, 'credential', $4, now(), now())",
              [accountId, disabled.id, disabled.id, disabled.passwordHash],
            );
          });
        },
      }),
    ).rejects.toThrow("NATIVE_CUTOVER_UNRESOLVED_IDENTITIES");
    const stranded = await authorityState(prisma);
    expect(stranded.fence.state).toBe("QUIESCED");
    expect(stranded.fence.sealed_at).toBeNull();
    await expect(assertNativeCutoverReady(prisma)).rejects.toThrow();

    // Remove the injected row the same way; the stored run then completes.
    await guarded(name, url, async (cleaner) => {
      await cleaner.query("SET session_replication_role = replica");
      await cleaner.query("DELETE FROM better_auth_accounts WHERE id = $1", [
        accountId,
      ]);
    });
    const resumed = await cli(url, ["--confirm-database", name, "--resume"]);
    expect(resumed.code).toBe(0);
    expect(resumed.last).toMatchObject({
      outcome: "SEALED_NATIVE",
      runId: stranded.fence.run_id,
    });
    await expect(assertNativeCutoverReady(prisma)).resolves.toBeUndefined();
  }, 120_000);

  it("never exposes identifiers, emails, credentials or connection strings, including on failure", async () => {
    // A driver failure path: unreachable server with a credential-bearing URL.
    // Synthetic credentials: no real credential is ever sent to a child.
    const unreachable = new URL("postgresql://nobody@127.0.0.1:1/unreachable");
    unreachable.password = randomBytes(12).toString("base64url");
    inertUrls.add(unreachable.toString());
    sensitive.add(unreachable.toString());
    sensitive.add(unreachable.password);
    const failed = await cli(unreachable.toString(), [
      "--confirm-database",
      "unreachable",
    ]);
    expect(failed.code).toBe(1);
    expect(failed.events).toEqual([
      { event: "refused", reason: "NATIVE_CUTOVER_FAILED" },
    ]);

    expect(outputs.length).toBeGreaterThan(0);
    const combined = outputs.join("\n");
    expect(combined).not.toContain("postgresql://");
    expect(combined).not.toContain("$argon2");
    expect(combined).not.toMatch(/@example\.(?:test|com)/);
    for (const value of sensitive)
      if (value.length >= 6) expect(combined).not.toContain(value);
  }, 60_000);
});
