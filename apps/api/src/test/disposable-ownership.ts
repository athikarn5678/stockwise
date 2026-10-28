// Live-ownership guard for suites that create, mutate or drop PostgreSQL
// databases. A parsed receipt only proves its own shape; authority comes from
// the live cluster. Every destructive step first reads, through the very
// connection that will perform it, the database comment the D5 local runner
// wrote on its own disposable database, and refuses unless it matches exactly.
// Failures carry fixed reason codes only: never markers, URLs or credentials.
//
// Connections that cannot be checked from inside (a Prisma CLI or API child
// process opens its own) are bounded by credential scoping instead: each
// scenario gets a dedicated NOSUPERUSER role, valid only on the cluster that
// created it, owning only that scenario database. The parent verifies the
// exact URL it hands the child, but that read is not the guarantee; the
// role's server-side scope is.
import { randomBytes } from "node:crypto";

export type DisposableOwner = Readonly<{
  runId: string;
  database: string;
  testDatabase: string;
  marker: string;
}>;

export interface OwnershipProbe {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
}

export type OwnershipRefusal =
  | "RECEIPT_SHAPE_INVALID"
  | "SCENARIO_NAME_INVALID"
  | "LOOKUP_FAILED"
  | "ANCHOR_MARKER_MISSING"
  | "ANCHOR_MARKER_MISMATCH"
  | "RESOURCE_IDENTITY_MISMATCH"
  | "TARGET_MISMATCH"
  | "SCENARIO_MARKER_MISSING"
  | "SCENARIO_MARKER_MISMATCH"
  | "ROLE_MISMATCH"
  | "TARGET_URL_REJECTED";

export class DisposableOwnershipError extends Error {
  readonly reason: OwnershipRefusal;
  constructor(reason: OwnershipRefusal) {
    super(`DISPOSABLE_OWNERSHIP_REFUSED:${reason}`);
    this.name = "DisposableOwnershipError";
    this.reason = reason;
  }
}

// The runner pins this image; a different server is not its cluster.
const RUNNER_SERVER_VERSION_PREFIX = "16.15";
const MARKER_SHAPE = /^[A-Za-z0-9_-]{43}$/;
const RUN_ID_SHAPE = /^[a-f0-9-]{36}$/;
const DATABASE_SHAPE = /^[a-z_]+$/;

function assertOwnerShape(owner: DisposableOwner): void {
  if (
    !MARKER_SHAPE.test(owner.marker) ||
    !RUN_ID_SHAPE.test(owner.runId) ||
    !DATABASE_SHAPE.test(owner.database) ||
    !DATABASE_SHAPE.test(owner.testDatabase)
  )
    throw new DisposableOwnershipError("RECEIPT_SHAPE_INVALID");
}

export const anchorMarker = (owner: DisposableOwner) =>
  `stockwise-local:${owner.marker}`;
export const scenarioMarker = (owner: DisposableOwner) =>
  `${anchorMarker(owner)}:operator`;
export const scenarioPrefix = (owner: DisposableOwner) =>
  `stockwise_operator_${owner.runId.replaceAll("-", "").slice(0, 12)}_`;
export const scenarioRoleName = (name: string) => `${name}_r`;

function assertScenarioName(owner: DisposableOwner, name: string): void {
  if (!name.startsWith(scenarioPrefix(owner)) || !/^[a-z0-9_]+$/.test(name))
    throw new DisposableOwnershipError("SCENARIO_NAME_INVALID");
}

type LiveIdentity = {
  currentName: unknown;
  currentMarker: unknown;
  anchorMarker: unknown;
  runnerDatabases: unknown;
  version: unknown;
  actingRole: unknown;
  actingSuper: unknown;
};

// One statement, one snapshot: the connected database, its comment, the
// runner anchor's comment, the runner's database set and the acting role are
// read together, inside a read-only transaction that is always rolled back.
async function readLiveIdentity(
  probe: OwnershipProbe,
  owner: DisposableOwner,
): Promise<LiveIdentity> {
  try {
    await probe.query("BEGIN READ ONLY");
    try {
      const result = await probe.query(
        `SELECT c.datname AS current_name,
                shobj_description(c.oid, 'pg_database') AS current_marker,
                (SELECT shobj_description(a.oid, 'pg_database')
                   FROM pg_database a WHERE a.datname = $1) AS anchor_marker,
                (SELECT count(*)::int FROM pg_database
                  WHERE datname = ANY($2::text[])) AS runner_databases,
                current_setting('server_version') AS version,
                current_user::text AS acting_role,
                (SELECT r.rolsuper FROM pg_roles r
                  WHERE r.rolname = current_user) AS acting_super
           FROM pg_database c WHERE c.datname = current_database()`,
        [owner.testDatabase, [owner.database, owner.testDatabase]],
      );
      const row = result.rows[0];
      if (result.rows.length !== 1 || !row)
        throw new DisposableOwnershipError("LOOKUP_FAILED");
      return {
        currentName: row.current_name,
        currentMarker: row.current_marker,
        anchorMarker: row.anchor_marker,
        runnerDatabases: row.runner_databases,
        version: row.version,
        actingRole: row.acting_role,
        actingSuper: row.acting_super,
      };
    } finally {
      await probe.query("ROLLBACK").catch(() => undefined);
    }
  } catch (error) {
    if (error instanceof DisposableOwnershipError) throw error;
    throw new DisposableOwnershipError("LOOKUP_FAILED");
  }
}

function assertAnchor(live: LiveIdentity, owner: DisposableOwner): void {
  if (typeof live.anchorMarker !== "string" || live.anchorMarker === "")
    throw new DisposableOwnershipError("ANCHOR_MARKER_MISSING");
  if (live.anchorMarker !== anchorMarker(owner))
    throw new DisposableOwnershipError("ANCHOR_MARKER_MISMATCH");
  if (
    live.runnerDatabases !== 2 ||
    typeof live.version !== "string" ||
    !live.version.startsWith(RUNNER_SERVER_VERSION_PREFIX)
  )
    throw new DisposableOwnershipError("RESOURCE_IDENTITY_MISMATCH");
}

/** The connection is on the runner-owned cluster's receipt database. */
export async function assertClusterOwned(
  probe: OwnershipProbe,
  owner: DisposableOwner,
): Promise<void> {
  assertOwnerShape(owner);
  const live = await readLiveIdentity(probe, owner);
  assertAnchor(live, owner);
  if (
    live.currentName !== owner.testDatabase ||
    live.currentMarker !== anchorMarker(owner)
  )
    throw new DisposableOwnershipError("TARGET_MISMATCH");
}

/**
 * The connection is on the named scenario database of this very run and, when
 * `role` is given, authenticated as that non-superuser scenario role.
 */
export async function assertScenarioOwned(
  probe: OwnershipProbe,
  owner: DisposableOwner,
  name: string,
  role?: string,
): Promise<void> {
  assertOwnerShape(owner);
  assertScenarioName(owner, name);
  const live = await readLiveIdentity(probe, owner);
  assertAnchor(live, owner);
  if (live.currentName !== name)
    throw new DisposableOwnershipError("TARGET_MISMATCH");
  if (typeof live.currentMarker !== "string" || live.currentMarker === "")
    throw new DisposableOwnershipError("SCENARIO_MARKER_MISSING");
  if (live.currentMarker !== scenarioMarker(owner))
    throw new DisposableOwnershipError("SCENARIO_MARKER_MISMATCH");
  if (
    role !== undefined &&
    (live.actingRole !== role || live.actingSuper !== false)
  )
    throw new DisposableOwnershipError("ROLE_MISMATCH");
}

/**
 * Creates one marked scenario database through `probe`, which must be the
 * cluster-owned connection that proves ownership immediately before. The name
 * is reported only after CREATE succeeded, so cleanup never targets a
 * database this run failed to create.
 */
export async function createOwnedScenario(
  probe: OwnershipProbe,
  owner: DisposableOwner,
  label: string,
  created: (name: string) => void,
): Promise<string> {
  assertOwnerShape(owner);
  if (!/^[a-z]+$/.test(label))
    throw new DisposableOwnershipError("SCENARIO_NAME_INVALID");
  await assertClusterOwned(probe, owner);
  const name = `${scenarioPrefix(owner)}${label}`;
  await probe.query(`CREATE DATABASE "${name}"`);
  created(name);
  await probe.query(
    `COMMENT ON DATABASE "${name}" IS '${scenarioMarker(owner)}'`,
  );
  return name;
}

export type ScenarioCredentials = Readonly<{ role: string; password: string }>;

/**
 * Gives one marked scenario database a dedicated login role: NOSUPERUSER, no
 * CREATEDB/CREATEROLE/REPLICATION, a random password, owner of that database
 * only, with PUBLIC access to it revoked. Every child process and client that
 * works on the scenario uses this role, so no administrative credential leaves
 * the parent, and a substituted target neither accepts the password nor is
 * writable by the role. `replicaRole` additionally grants SET on
 * session_replication_role, needed only by deliberate fault injection.
 * Ownership is proven on `probe` first and the database must already carry
 * this run's exact scenario marker.
 */
export async function provisionScenarioRole(
  probe: OwnershipProbe,
  owner: DisposableOwner,
  name: string,
  options: { replicaRole?: boolean } = {},
): Promise<ScenarioCredentials> {
  assertOwnerShape(owner);
  assertScenarioName(owner, name);
  await assertClusterOwned(probe, owner);
  const marker = await probe.query(
    "SELECT shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname = $1",
    [name],
  );
  if (marker.rows[0]?.marker !== scenarioMarker(owner))
    throw new DisposableOwnershipError("SCENARIO_MARKER_MISMATCH");
  const role = scenarioRoleName(name);
  const password = randomBytes(24).toString("base64url");
  await probe.query(
    `CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`,
  );
  await probe.query(`COMMENT ON ROLE "${role}" IS '${scenarioMarker(owner)}'`);
  await probe.query(`ALTER DATABASE "${name}" OWNER TO "${role}"`);
  await probe.query(`REVOKE ALL ON DATABASE "${name}" FROM PUBLIC`);
  if (options.replicaRole)
    await probe.query(
      `GRANT SET ON PARAMETER session_replication_role TO "${role}"`,
    );
  return { role, password };
}

/** Builds the only URL a child process may receive for a scenario. */
export function scenarioConnectionUrl(
  adminUrl: string,
  name: string,
  credentials: ScenarioCredentials,
): string {
  const url = new URL(adminUrl);
  url.username = credentials.role;
  url.password = credentials.password;
  url.pathname = `/${name}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

/**
 * Refuses any scenario URL that is not exactly the scenario role on the
 * scenario database of the administrative URL's own host and port.
 */
export function assertScenarioUrl(
  candidate: string,
  adminUrl: string,
  owner: DisposableOwner,
  name: string,
  role: string,
): void {
  assertOwnerShape(owner);
  assertScenarioName(owner, name);
  let accepted: boolean;
  try {
    const url = new URL(candidate);
    const admin = new URL(adminUrl);
    accepted =
      url.protocol === "postgresql:" &&
      url.hostname === admin.hostname &&
      url.port === admin.port &&
      url.pathname === `/${name}` &&
      decodeURIComponent(url.username) === role &&
      role === scenarioRoleName(name) &&
      url.search === "" &&
      url.hash === "";
  } catch {
    accepted = false;
  }
  if (!accepted) throw new DisposableOwnershipError("TARGET_URL_REJECTED");
}

export interface OwnedSession extends OwnershipProbe {
  end(): Promise<void>;
}

/**
 * Opens a connection to a scenario database and proves, on that connection,
 * that it is this run's scenario (and, when given, the scenario role) before
 * `operation` may change anything such as a PostgreSQL safety setting or a
 * trigger. The session always ends.
 */
export async function withOwnedScenarioSession<T>(
  open: () => Promise<OwnedSession>,
  owner: DisposableOwner,
  name: string,
  operation: (session: OwnedSession) => Promise<T>,
  role?: string,
): Promise<T> {
  const session = await open();
  try {
    await assertScenarioOwned(session, owner, name, role);
    return await operation(session);
  } finally {
    await session.end().catch(() => undefined);
  }
}

/**
 * Gate before any child process (Prisma CLI, operator CLI) receives `url`:
 * the URL must be exactly the scenario role's, and a fresh connection made
 * with that very URL must prove the run's scenario marker and non-superuser
 * role. The child opens its own connections, so this read is not atomic with
 * them; the role's server-side scope is the boundary it relies on.
 */
export async function authorizeChildTarget(
  open: (url: string) => Promise<OwnedSession>,
  owner: DisposableOwner,
  target: { adminUrl: string; url: string; name: string; role: string },
): Promise<void> {
  assertScenarioUrl(
    target.url,
    target.adminUrl,
    owner,
    target.name,
    target.role,
  );
  await withOwnedScenarioSession(
    () => open(target.url),
    owner,
    target.name,
    async () => undefined,
    target.role,
  );
}

async function dropScenarioRole(
  probe: OwnershipProbe,
  owner: DisposableOwner,
  name: string,
): Promise<boolean> {
  const database = await probe.query(
    "SELECT 1 AS present FROM pg_database WHERE datname = $1",
    [name],
  );
  // The role owns its database; remove it only once the database is gone.
  if (database.rows.length !== 0) return false;
  const role = scenarioRoleName(name);
  const found = await probe.query(
    "SELECT shobj_description(oid, 'pg_authid') AS marker FROM pg_roles WHERE rolname = $1",
    [role],
  );
  if (found.rows[0]?.marker !== scenarioMarker(owner)) return false;
  await probe.query(
    `REVOKE SET ON PARAMETER session_replication_role FROM "${role}"`,
  );
  await probe.query(`DROP ROLE "${role}"`);
  return true;
}

/**
 * Drops only databases that carry this run's prefix and exact scenario marker,
 * then their dedicated roles when the role carries the same marker, after the
 * cluster itself proved ownership on the same connection. A failed cluster
 * proof drops nothing.
 */
export async function dropOwnedScenarios(
  probe: OwnershipProbe,
  owner: DisposableOwner,
  names: readonly string[],
): Promise<{ dropped: string[]; skipped: string[]; rolesDropped: string[] }> {
  await assertClusterOwned(probe, owner);
  const dropped: string[] = [];
  const skipped: string[] = [];
  const rolesDropped: string[] = [];
  for (const name of names) {
    if (!name.startsWith(scenarioPrefix(owner)) || !/^[a-z0-9_]+$/.test(name)) {
      skipped.push(name);
      continue;
    }
    const result = await probe.query(
      "SELECT shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname = $1",
      [name],
    );
    if (result.rows.length === 1) {
      if (result.rows[0]?.marker !== scenarioMarker(owner)) {
        skipped.push(name);
        continue;
      }
      await probe.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      dropped.push(name);
    } else {
      skipped.push(name);
    }
    if (await dropScenarioRole(probe, owner, name)) rolesDropped.push(name);
  }
  return { dropped, skipped, rolesDropped };
}

/** Removes one scenario's role (database already gone), after cluster proof. */
export async function dropOwnedScenarioRole(
  probe: OwnershipProbe,
  owner: DisposableOwner,
  name: string,
): Promise<boolean> {
  assertOwnerShape(owner);
  assertScenarioName(owner, name);
  await assertClusterOwned(probe, owner);
  return dropScenarioRole(probe, owner, name);
}
