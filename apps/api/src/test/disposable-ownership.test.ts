import { describe, expect, it } from "vitest";

import {
  anchorMarker,
  assertClusterOwned,
  assertScenarioOwned,
  assertScenarioUrl,
  authorizeChildTarget,
  createOwnedScenario,
  dropOwnedScenarioRole,
  dropOwnedScenarios,
  provisionScenarioRole,
  scenarioConnectionUrl,
  scenarioMarker,
  scenarioPrefix,
  scenarioRoleName,
  withOwnedScenarioSession,
  type DisposableOwner,
  type OwnedSession,
} from "./disposable-ownership.ts";

// Database-free: every probe here is an in-memory fake that records statements,
// so refusals are proven without any PostgreSQL cluster, shared or otherwise.
const owner: DisposableOwner = {
  runId: "11111111-1111-4111-8111-111111111111",
  database: "stockwise_test",
  testDatabase: "stockwise_test_test",
  marker: "A".repeat(43),
};
const forged: DisposableOwner = { ...owner, marker: "B".repeat(43) };
const scenario = `${scenarioPrefix(owner)}alpha`;
const role = scenarioRoleName(scenario);
const adminUrl =
  "postgresql://admin:admin-secret@127.0.0.1:5432/stockwise_test_test";

type FakeCluster = {
  currentName: string;
  currentMarker: string | null;
  anchorMarker: string | null;
  runnerDatabases: number;
  version: string;
  actingRole: string;
  actingSuper: boolean;
  scenarios: Record<string, string | null>;
  roles: Record<string, string | null>;
  lookup: "ok" | "throws" | "empty";
};

function liveCluster(overrides: Partial<FakeCluster> = {}): FakeCluster {
  return {
    currentName: owner.testDatabase,
    currentMarker: anchorMarker(owner),
    anchorMarker: anchorMarker(owner),
    runnerDatabases: 2,
    version: "16.15",
    actingRole: "stockwise_test",
    actingSuper: true,
    scenarios: {},
    roles: {},
    lookup: "ok",
    ...overrides,
  };
}

const MUTATION =
  /^(CREATE|COMMENT|DROP|SET|ALTER|INSERT|DELETE|UPDATE|TRUNCATE|GRANT|REVOKE)/i;

function fakeSession(cluster: FakeCluster) {
  const statements: string[] = [];
  let ended = false;
  const session: OwnedSession = {
    async query(text, values) {
      statements.push(text);
      if (text.includes("current_setting('server_version')")) {
        if (cluster.lookup === "throws") throw new Error("lookup failed");
        if (cluster.lookup === "empty") return { rows: [] };
        return {
          rows: [
            {
              current_name: cluster.currentName,
              current_marker: cluster.currentMarker,
              anchor_marker: cluster.anchorMarker,
              runner_databases: cluster.runnerDatabases,
              version: cluster.version,
              acting_role: cluster.actingRole,
              acting_super: cluster.actingSuper,
            },
          ],
        };
      }
      const name = String(values?.[0]);
      if (text.includes("shobj_description(oid, 'pg_database')"))
        return {
          rows:
            name in cluster.scenarios
              ? [{ marker: cluster.scenarios[name] }]
              : [],
        };
      if (text.startsWith("SELECT 1 AS present FROM pg_database"))
        return { rows: name in cluster.scenarios ? [{ present: 1 }] : [] };
      if (text.includes("shobj_description(oid, 'pg_authid')"))
        return {
          rows: name in cluster.roles ? [{ marker: cluster.roles[name] }] : [],
        };
      const dropped = /^DROP DATABASE "([^"]+)"/.exec(text);
      if (dropped?.[1]) delete cluster.scenarios[dropped[1]];
      return { rows: [] };
    },
    async end() {
      ended = true;
    },
  };
  return {
    session,
    statements,
    ended: () => ended,
    mutations: () => statements.filter((text) => MUTATION.test(text.trim())),
  };
}

async function reasonOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    expect(message).not.toContain(owner.marker);
    expect(message).not.toContain(forged.marker);
    expect(message).not.toContain("admin-secret");
    expect(message).toMatch(/^DISPOSABLE_OWNERSHIP_REFUSED:[A-Z_]+$/);
    return message.replace("DISPOSABLE_OWNERSHIP_REFUSED:", "");
  }
  throw new Error("Expected an ownership refusal.");
}

describe("live disposable ownership guard", () => {
  it("permits a valid receipt whose marker matches the live cluster", async () => {
    const fake = fakeSession(liveCluster());
    await expect(
      assertClusterOwned(fake.session, owner),
    ).resolves.toBeUndefined();
    // Read-only: a read-only transaction around a single SELECT, then rollback.
    expect(fake.statements[0]).toBe("BEGIN READ ONLY");
    expect(fake.statements.at(-1)).toBe("ROLLBACK");
    expect(fake.mutations()).toEqual([]);

    const created: string[] = [];
    const creator = fakeSession(liveCluster());
    const name = await createOwnedScenario(
      creator.session,
      owner,
      "alpha",
      (value) => created.push(value),
    );
    expect(name).toBe(scenario);
    expect(created).toEqual([scenario]);
    const order = creator.statements.map((text) => text.split(/\s/)[0]);
    expect(order.indexOf("SELECT")).toBeLessThan(order.indexOf("CREATE"));
    expect(creator.mutations()).toEqual([
      `CREATE DATABASE "${scenario}"`,
      `COMMENT ON DATABASE "${scenario}" IS '${scenarioMarker(owner)}'`,
    ]);
  });

  it("refuses a forged receipt when the live cluster carries no matching marker", async () => {
    // Fabricated but well-formed receipt against a cluster nobody marked.
    const foreign = fakeSession(
      liveCluster({ currentMarker: null, anchorMarker: null }),
    );
    const created: string[] = [];
    expect(
      await reasonOf(
        createOwnedScenario(foreign.session, forged, "alpha", (value) =>
          created.push(value),
        ),
      ),
    ).toBe("ANCHOR_MARKER_MISSING");
    expect(created).toEqual([]);
    expect(foreign.mutations()).toEqual([]);
  });

  it("refuses a correctly shaped receipt whose marker differs from the live marker", async () => {
    const fake = fakeSession(liveCluster());
    const created: string[] = [];
    expect(
      await reasonOf(
        createOwnedScenario(fake.session, forged, "alpha", (value) =>
          created.push(value),
        ),
      ),
    ).toBe("ANCHOR_MARKER_MISMATCH");
    expect(created).toEqual([]);
    expect(fake.mutations()).toEqual([]);
  });

  it("refuses a missing or empty live marker", async () => {
    for (const anchor of [null, ""]) {
      const fake = fakeSession(
        liveCluster({ anchorMarker: anchor, currentMarker: anchor }),
      );
      expect(await reasonOf(assertClusterOwned(fake.session, owner))).toBe(
        "ANCHOR_MARKER_MISSING",
      );
      expect(fake.mutations()).toEqual([]);
    }
  });

  it("refuses when the marker lookup fails or is inaccessible", async () => {
    for (const lookup of ["throws", "empty"] as const) {
      const fake = fakeSession(liveCluster({ lookup }));
      const created: string[] = [];
      expect(
        await reasonOf(
          createOwnedScenario(fake.session, owner, "alpha", (value) =>
            created.push(value),
          ),
        ),
      ).toBe("LOOKUP_FAILED");
      expect(created).toEqual([]);
      expect(fake.mutations()).toEqual([]);
      // The read-only transaction is still closed after the failure.
      expect(fake.statements.at(-1)).toBe("ROLLBACK");
    }
  });

  it("refuses the same loopback address and database name with incorrect ownership", async () => {
    // Same receipt database name, but the live marker belongs to someone else.
    const imposter = fakeSession(
      liveCluster({
        currentName: owner.testDatabase,
        currentMarker: anchorMarker(forged),
        anchorMarker: anchorMarker(forged),
      }),
    );
    expect(await reasonOf(assertClusterOwned(imposter.session, owner))).toBe(
      "ANCHOR_MARKER_MISMATCH",
    );
    // Right marker on the cluster, but this connection is on another database.
    const other = fakeSession(liveCluster({ currentName: "postgres" }));
    expect(await reasonOf(assertClusterOwned(other.session, owner))).toBe(
      "TARGET_MISMATCH",
    );
    // Marker copied onto a cluster missing the runner's resource set or image.
    for (const drift of [
      { runnerDatabases: 1 },
      { version: "17.2" },
    ] as const) {
      const fake = fakeSession(liveCluster(drift));
      expect(await reasonOf(assertClusterOwned(fake.session, owner))).toBe(
        "RESOURCE_IDENTITY_MISMATCH",
      );
    }
  });

  it("refuses malformed receipts and scenario names before touching the database", async () => {
    const fake = fakeSession(liveCluster());
    const malformed = { ...owner, marker: "short" };
    expect(await reasonOf(assertClusterOwned(fake.session, malformed))).toBe(
      "RECEIPT_SHAPE_INVALID",
    );
    expect(
      await reasonOf(
        createOwnedScenario(
          fake.session,
          owner,
          'x"; DROP DATABASE y;--',
          () => undefined,
        ),
      ),
    ).toBe("SCENARIO_NAME_INVALID");
    expect(
      await reasonOf(
        assertScenarioOwned(fake.session, owner, "stockwise_operator_other_x"),
      ),
    ).toBe("SCENARIO_NAME_INVALID");
    expect(
      await reasonOf(provisionScenarioRole(fake.session, owner, "postgres")),
    ).toBe("SCENARIO_NAME_INVALID");
    expect(fake.statements).toEqual([]);
  });

  it("blocks fault injection unless the scenario connection proves ownership", async () => {
    let operations = 0;
    const attempt = async (cluster: FakeCluster, who: DisposableOwner) => {
      const fake = fakeSession(cluster);
      const outcome = await reasonOf(
        withOwnedScenarioSession(
          async () => fake.session,
          who,
          scenario,
          async (session) => {
            operations++;
            await session.query("SET session_replication_role = replica");
          },
        ),
      );
      expect(fake.mutations()).toEqual([]);
      expect(fake.ended()).toBe(true);
      return outcome;
    };
    const owned = {
      currentName: scenario,
      currentMarker: scenarioMarker(owner),
    };
    // Forged receipt, missing scenario marker, wrong scenario marker, other
    // database, and a failed lookup each stop before the safety setting moves.
    expect(await attempt(liveCluster(owned), forged)).toBe(
      "ANCHOR_MARKER_MISMATCH",
    );
    expect(
      await attempt(liveCluster({ ...owned, currentMarker: null }), owner),
    ).toBe("SCENARIO_MARKER_MISSING");
    expect(
      await attempt(
        liveCluster({ ...owned, currentMarker: scenarioMarker(forged) }),
        owner,
      ),
    ).toBe("SCENARIO_MARKER_MISMATCH");
    expect(
      await attempt(liveCluster({ ...owned, currentName: "postgres" }), owner),
    ).toBe("TARGET_MISMATCH");
    expect(await attempt(liveCluster({ lookup: "throws" }), owner)).toBe(
      "LOOKUP_FAILED",
    );
    expect(operations).toBe(0);

    // Positive control: the same operation runs once ownership is proven, and
    // the ownership read happens first, on the same session.
    const fake = fakeSession(liveCluster(owned));
    await withOwnedScenarioSession(
      async () => fake.session,
      owner,
      scenario,
      async (session) => {
        operations++;
        await session.query("SET session_replication_role = replica");
      },
    );
    expect(operations).toBe(1);
    expect(
      fake.statements.indexOf("SET session_replication_role = replica"),
    ).toBeGreaterThan(
      fake.statements.findIndex((text) => text.includes("server_version")),
    );
    expect(fake.ended()).toBe(true);
  });

  it("blocks trigger and function creation and cleanup on a mismatched or unreadable session", async () => {
    const createFunction =
      "CREATE FUNCTION public.operator_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$";
    const createTrigger =
      "CREATE TRIGGER operator_fault BEFORE INSERT ON public.native_auth_enrollments FOR EACH ROW EXECUTE FUNCTION public.operator_fault()";
    const dropTrigger =
      "DROP TRIGGER IF EXISTS operator_fault ON public.native_auth_enrollments";
    const dropFunction = "DROP FUNCTION IF EXISTS public.operator_fault()";
    const owned = {
      currentName: scenario,
      currentMarker: scenarioMarker(owner),
      actingRole: role,
      actingSuper: false,
    };
    const broken: [string, FakeCluster, DisposableOwner][] = [
      ["forged", liveCluster(owned), forged],
      ["marker", liveCluster({ ...owned, currentMarker: "other" }), owner],
      ["role", liveCluster({ ...owned, actingRole: "postgres" }), owner],
      ["super", liveCluster({ ...owned, actingSuper: true }), owner],
      ["lookup", liveCluster({ ...owned, lookup: "throws" }), owner],
    ];
    for (const [, cluster, who] of broken) {
      for (const statements of [
        [createFunction, createTrigger],
        [dropTrigger, dropFunction],
      ]) {
        const fake = fakeSession(cluster);
        await reasonOf(
          withOwnedScenarioSession(
            async () => fake.session,
            who,
            scenario,
            async (session) => {
              for (const statement of statements)
                await session.query(statement);
            },
            role,
          ),
        );
        expect(fake.mutations()).toEqual([]);
        expect(fake.ended()).toBe(true);
      }
    }
    // Owned scenario role: both create and cleanup run, after the proof.
    const fake = fakeSession(liveCluster(owned));
    await withOwnedScenarioSession(
      async () => fake.session,
      owner,
      scenario,
      async (session) => {
        for (const statement of [createFunction, createTrigger])
          await session.query(statement);
      },
      role,
    );
    expect(fake.mutations()).toEqual([createFunction, createTrigger]);
  });

  it("provisions a scoped scenario role only after cluster and scenario ownership are proven", async () => {
    const fake = fakeSession(
      liveCluster({ scenarios: { [scenario]: scenarioMarker(owner) } }),
    );
    const credentials = await provisionScenarioRole(
      fake.session,
      owner,
      scenario,
      { replicaRole: true },
    );
    expect(credentials.role).toBe(role);
    expect(credentials.password).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const mutations = fake.mutations();
    expect(mutations[0]).toMatch(
      /^CREATE ROLE ".+" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '/,
    );
    expect(mutations.slice(1)).toEqual([
      `COMMENT ON ROLE "${role}" IS '${scenarioMarker(owner)}'`,
      `ALTER DATABASE "${scenario}" OWNER TO "${role}"`,
      `REVOKE ALL ON DATABASE "${scenario}" FROM PUBLIC`,
      `GRANT SET ON PARAMETER session_replication_role TO "${role}"`,
    ]);
    const firstWrite = fake.statements.findIndex((text) => MUTATION.test(text));
    expect(firstWrite).toBeGreaterThan(
      fake.statements.findIndex((text) => text.includes("server_version")),
    );

    // The replica-role grant is opt-in.
    const plain = fakeSession(
      liveCluster({ scenarios: { [scenario]: scenarioMarker(owner) } }),
    );
    await provisionScenarioRole(plain.session, owner, scenario);
    expect(plain.mutations().some((text) => text.startsWith("GRANT"))).toBe(
      false,
    );
  });

  it("refuses to provision a role for a forged receipt or an unmarked scenario", async () => {
    const foreign = fakeSession(
      liveCluster({ scenarios: { [scenario]: scenarioMarker(owner) } }),
    );
    expect(
      await reasonOf(provisionScenarioRole(foreign.session, forged, scenario)),
    ).toBe("ANCHOR_MARKER_MISMATCH");
    expect(foreign.mutations()).toEqual([]);
    for (const marker of [null, scenarioMarker(forged)]) {
      const fake = fakeSession(
        liveCluster({ scenarios: { [scenario]: marker } }),
      );
      expect(
        await reasonOf(provisionScenarioRole(fake.session, owner, scenario)),
      ).toBe("SCENARIO_MARKER_MISMATCH");
      expect(fake.mutations()).toEqual([]);
    }
    const missing = fakeSession(liveCluster());
    expect(
      await reasonOf(provisionScenarioRole(missing.session, owner, scenario)),
    ).toBe("SCENARIO_MARKER_MISMATCH");
    expect(missing.mutations()).toEqual([]);
  });

  it("rejects substituted migration and child targets before any connection is opened", async () => {
    const credentials = { role, password: "p".repeat(32) };
    const good = scenarioConnectionUrl(adminUrl, scenario, credentials);
    expect(() =>
      assertScenarioUrl(good, adminUrl, owner, scenario, role),
    ).not.toThrow();
    const change = (edit: (url: URL) => void) => {
      const url = new URL(good);
      edit(url);
      return url.toString();
    };
    const substitutions = [
      change((url) => (url.pathname = `/${owner.testDatabase}`)),
      change((url) => (url.pathname = "/postgres")),
      change((url) => (url.pathname = `/${scenarioPrefix(owner)}beta`)),
      change((url) => (url.port = "1")),
      change((url) => (url.hostname = "localhost")),
      change((url) => (url.username = "admin")),
      change((url) => (url.protocol = "postgres:")),
      change((url) => url.searchParams.set("options", "-c role=postgres")),
      change((url) => (url.hash = "#x")),
      "not-a-url",
      adminUrl,
    ];
    let opened = 0;
    for (const candidate of substitutions) {
      expect(
        await reasonOf(
          authorizeChildTarget(
            async () => {
              opened++;
              return fakeSession(liveCluster()).session;
            },
            owner,
            { adminUrl, url: candidate, name: scenario, role },
          ),
        ),
      ).toBe("TARGET_URL_REJECTED");
    }
    expect(opened).toBe(0);
    // A role that is not this scenario's derived role is rejected as well.
    expect(
      await reasonOf(
        authorizeChildTarget(
          async () => fakeSession(liveCluster()).session,
          owner,
          { adminUrl, url: good, name: scenario, role: "other_r" },
        ),
      ),
    ).toBe("TARGET_URL_REJECTED");
  });

  it("authorizes a child target only when the live target and role match", async () => {
    const credentials = { role, password: "p".repeat(32) };
    const url = scenarioConnectionUrl(adminUrl, scenario, credentials);
    const owned = {
      currentName: scenario,
      currentMarker: scenarioMarker(owner),
      actingRole: role,
      actingSuper: false,
    };
    const run = (cluster: FakeCluster, who: DisposableOwner = owner) => {
      const fake = fakeSession(cluster);
      return {
        fake,
        outcome: authorizeChildTarget(
          async (opened) => {
            expect(opened).toBe(url);
            return fake.session;
          },
          who,
          { adminUrl, url, name: scenario, role },
        ),
      };
    };
    const ok = run(liveCluster(owned));
    await expect(ok.outcome).resolves.toBeUndefined();
    expect(ok.fake.mutations()).toEqual([]);
    expect(ok.fake.ended()).toBe(true);

    const cases: [string, FakeCluster, DisposableOwner][] = [
      [
        "SCENARIO_MARKER_MISMATCH",
        liveCluster({ ...owned, currentMarker: "x" }),
        owner,
      ],
      [
        "SCENARIO_MARKER_MISSING",
        liveCluster({ ...owned, currentMarker: null }),
        owner,
      ],
      [
        "TARGET_MISMATCH",
        liveCluster({ ...owned, currentName: "postgres" }),
        owner,
      ],
      [
        "ROLE_MISMATCH",
        liveCluster({ ...owned, actingRole: "stockwise_test" }),
        owner,
      ],
      ["ROLE_MISMATCH", liveCluster({ ...owned, actingSuper: true }), owner],
      ["ANCHOR_MARKER_MISMATCH", liveCluster(owned), forged],
      ["LOOKUP_FAILED", liveCluster({ ...owned, lookup: "empty" }), owner],
    ];
    for (const [reason, cluster, who] of cases) {
      const attempt = run(cluster, who);
      expect(await reasonOf(attempt.outcome)).toBe(reason);
      expect(attempt.fake.mutations()).toEqual([]);
    }
  });

  it("drops nothing when ownership fails and never drops unowned databases or roles when it holds", async () => {
    const unowned = `${scenarioPrefix(owner)}unowned`;
    const foreignRun = "stockwise_operator_ffffffffffff_alpha";
    const keepRole = `${scenarioPrefix(owner)}keeprole`;
    const sentinel = fakeSession(
      liveCluster({ scenarios: { [scenario]: scenarioMarker(owner) } }),
    );
    expect(
      await reasonOf(dropOwnedScenarios(sentinel.session, forged, [scenario])),
    ).toBe("ANCHOR_MARKER_MISMATCH");
    expect(sentinel.mutations()).toEqual([]);

    const fake = fakeSession(
      liveCluster({
        scenarios: {
          [scenario]: scenarioMarker(owner),
          [unowned]: scenarioMarker(forged),
          [foreignRun]: scenarioMarker(owner),
          [keepRole]: scenarioMarker(owner),
        },
        roles: {
          [role]: scenarioMarker(owner),
          [scenarioRoleName(unowned)]: scenarioMarker(owner),
          [scenarioRoleName(keepRole)]: scenarioMarker(forged),
        },
      }),
    );
    const result = await dropOwnedScenarios(fake.session, owner, [
      scenario,
      unowned,
      foreignRun,
      `${scenarioPrefix(owner)}missing`,
      "postgres",
      keepRole,
    ]);
    expect(result.dropped).toEqual([scenario, keepRole]);
    expect(result.skipped).toEqual([
      unowned,
      foreignRun,
      `${scenarioPrefix(owner)}missing`,
      "postgres",
    ]);
    // Only the role carrying this run's marker, and only after its database.
    expect(result.rolesDropped).toEqual([scenario]);
    expect(fake.mutations()).toEqual([
      `DROP DATABASE "${scenario}" WITH (FORCE)`,
      `REVOKE SET ON PARAMETER session_replication_role FROM "${role}"`,
      `DROP ROLE "${role}"`,
      `DROP DATABASE "${keepRole}" WITH (FORCE)`,
    ]);
  });

  it("removes a lone scenario role only after cluster proof, an absent database and a matching role marker", async () => {
    const forgedProbe = fakeSession(
      liveCluster({ roles: { [role]: scenarioMarker(owner) } }),
    );
    expect(
      await reasonOf(
        dropOwnedScenarioRole(forgedProbe.session, forged, scenario),
      ),
    ).toBe("ANCHOR_MARKER_MISMATCH");
    expect(forgedProbe.mutations()).toEqual([]);

    const stillPresent = fakeSession(
      liveCluster({
        scenarios: { [scenario]: scenarioMarker(owner) },
        roles: { [role]: scenarioMarker(owner) },
      }),
    );
    await expect(
      dropOwnedScenarioRole(stillPresent.session, owner, scenario),
    ).resolves.toBe(false);
    expect(stillPresent.mutations()).toEqual([]);

    const foreignRole = fakeSession(
      liveCluster({ roles: { [role]: scenarioMarker(forged) } }),
    );
    await expect(
      dropOwnedScenarioRole(foreignRole.session, owner, scenario),
    ).resolves.toBe(false);
    expect(foreignRole.mutations()).toEqual([]);

    const owned = fakeSession(
      liveCluster({ roles: { [role]: scenarioMarker(owner) } }),
    );
    await expect(
      dropOwnedScenarioRole(owned.session, owner, scenario),
    ).resolves.toBe(true);
    expect(owned.mutations()).toEqual([
      `REVOKE SET ON PARAMETER session_replication_role FROM "${role}"`,
      `DROP ROLE "${role}"`,
    ]);
  });
});
