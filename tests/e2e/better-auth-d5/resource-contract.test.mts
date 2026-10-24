import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertD5Topology,
  authorizeResourceCleanup,
  parseDisposableTestDatabaseEnvironment,
  REQUIRED_D5_TOPOLOGY,
  type DatabaseIdentityReceipt,
  type DisposableDatabaseContract,
  type ResourceLease,
  type ResourceSet,
  type TopologyContract,
} from "./resource-contract.mts";

const ownerUuid = "11111111-1111-4111-8111-111111111111";
const ownerKey = ownerUuid.replaceAll("-", "");
const database = `stockwise_d5_${ownerKey}_test`;
const user = `stockwise_d5_${ownerKey}_owner`;
const clusterIdentity = "cluster-id-from-parent-receipt";
const imageIdentity = "postgres-image@sha256:0123456789abcdef";
const validUrl = `postgres://${user}:not-a-real-secret@127.0.0.1:55432/${database}`;

function parse(url: string): DisposableDatabaseContract {
  return parseDisposableTestDatabaseEnvironment(
    { TEST_DATABASE_URL: url },
    ownerUuid,
  );
}

function receipt(
  overrides: Partial<DatabaseIdentityReceipt> = {},
): DatabaseIdentityReceipt {
  return {
    currentDatabase: database,
    currentUser: user,
    serverAddress: "127.0.0.1",
    serverPort: 5432,
    clusterIdentity,
    ownerUuid,
    ...overrides,
  };
}

function resourceLabels(
  role: string,
  resourceOwner = ownerUuid,
): Record<string, string> {
  return {
    "stockwise.d5.owner": resourceOwner,
    "stockwise.d5.role": role,
    "stockwise.d5.creator": "parent",
  };
}

function resources(overrides: Partial<ResourceSet> = {}): ResourceSet {
  return {
    container: {
      id: "container-immutable-id",
      labels: resourceLabels("postgres-container"),
      imageIdentity,
      networkIds: ["network-immutable-id"],
      mounts: [
        {
          type: "volume",
          source: "volume-immutable-id",
          destination: "/var/lib/postgresql/data",
          readOnly: false,
        },
      ],
      bindMounts: [],
      hostSocketMounts: [],
      publishedPorts: [
        { hostAddress: "127.0.0.1", hostPort: 55432, containerPort: 5432 },
      ],
    },
    volume: {
      id: "volume-immutable-id",
      labels: resourceLabels("postgres-volume"),
      attachedContainerIds: ["container-immutable-id"],
    },
    network: {
      id: "network-immutable-id",
      labels: resourceLabels("postgres-network"),
      memberContainerIds: ["container-immutable-id"],
    },
    ...overrides,
  };
}

function lease(): ResourceLease {
  return {
    ownerUuid,
    database: parse(validUrl),
    expectedServerAddress: "127.0.0.1",
    expectedServerPort: 5432,
    expectedClusterIdentity: clusterIdentity,
    expectedImageIdentity: imageIdentity,
    databaseReceipt: receipt(),
    resources: resources(),
  };
}

test("accepts the complete parent-owned baseline lease before negative mutations", () => {
  const baseline = lease();
  assert.equal(baseline.expectedClusterIdentity, clusterIdentity);
  assert.equal(baseline.expectedImageIdentity, imageIdentity);
  assert.equal(
    authorizeResourceCleanup(baseline, {
      ...resources(),
      databaseReceipt: receipt(),
    }),
    true,
  );
});

test("accepts explicit owner-derived loopback database URL without returning its password", () => {
  assert.deepEqual(parse(validUrl), {
    ownerUuid,
    host: "127.0.0.1",
    port: 55432,
    database,
    user,
  });
});

test("rejects missing explicit URL, inherited runtime URL, and unsafe or ambiguous URLs", () => {
  assert.throws(
    () => parseDisposableTestDatabaseEnvironment({}, ownerUuid),
    /Invalid disposable test database contract/,
  );
  assert.throws(
    () =>
      parseDisposableTestDatabaseEnvironment(
        { DATABASE_URL: validUrl },
        ownerUuid,
      ),
    /Invalid disposable test database contract/,
  );
  assert.throws(
    () =>
      parseDisposableTestDatabaseEnvironment(
        { TEST_DATABASE_URL: validUrl, DATABASE_URL: validUrl },
        ownerUuid,
      ),
    /Invalid disposable test database contract/,
  );

  const invalidUrls = [
    validUrl.replace("127.0.0.1", "localhost"),
    validUrl.replace("127.0.0.1", "127.1"),
    validUrl.replace("127.0.0.1", "2130706433"),
    validUrl.replace("127.0.0.1", "192.168.1.1"),
    validUrl.replace(":55432/", "/"),
    validUrl.replace(`/${database}`, "/postgres"),
    `${validUrl}?host=remote.example`,
    validUrl.replace("127.0.0.1:55432", "127.0.0.1,remote.example:55432"),
    validUrl.replace(`/${database}`, `/${database}%2fother`),
    `${validUrl}\n`,
    validUrl.replace(`/${database}`, `/${database};options=unsafe`),
  ];
  for (const url of invalidUrls) {
    assert.throws(
      () => parse(url),
      /Invalid disposable test database contract/,
    );
  }
});

test("sanitizes URL validation errors", () => {
  const secretBearingUrl = validUrl.replace(
    "not-a-real-secret",
    "sensitive-value-123",
  );
  assert.throws(
    () => parse(secretBearingUrl.replace("127.0.0.1", "remote.example")),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes("sensitive-value-123"), false);
      assert.equal(error.message.includes("remote.example"), false);
      return true;
    },
  );
});

test("rejects database identity and parent-recorded cluster identity mismatches", () => {
  const resourceSnapshot = resources();
  assert.equal(
    authorizeResourceCleanup(lease(), {
      ...resourceSnapshot,
      databaseReceipt: receipt(),
    }),
    true,
  );
  for (const mismatch of [
    receipt({ currentDatabase: "other_database" }),
    receipt({ currentUser: "other_user" }),
    receipt({ serverAddress: "10.0.0.2" }),
    receipt({ serverPort: 5433 }),
    receipt({ ownerUuid: "22222222-2222-4222-8222-222222222222" }),
    receipt({ clusterIdentity: "different-cluster" }),
    receipt({ clusterIdentity: "" }),
  ]) {
    assert.throws(
      () =>
        authorizeResourceCleanup(lease(), {
          ...resourceSnapshot,
          databaseReceipt: mismatch,
        }),
      /Invalid disposable test database contract/,
    );
  }
  assert.throws(
    () =>
      authorizeResourceCleanup(
        { ...lease(), expectedClusterIdentity: "unrecorded-cluster" },
        { ...resourceSnapshot, databaseReceipt: receipt() },
      ),
    /Invalid disposable test database contract/,
  );
});

test("rejects unowned, replaced, or topologically attached foreign resources", () => {
  const current = resources();
  assert.equal(
    authorizeResourceCleanup(lease(), {
      ...current,
      databaseReceipt: receipt(),
    }),
    true,
  );

  const replacementId = "replacement-container-id";
  const replacement = resources({
    container: { ...current.container, id: replacementId },
    volume: { ...current.volume, attachedContainerIds: [replacementId] },
    network: { ...current.network, memberContainerIds: [replacementId] },
  });
  assert.throws(
    () =>
      authorizeResourceCleanup(lease(), {
        ...replacement,
        databaseReceipt: receipt(),
      }),
    /Invalid disposable test database contract/,
  );

  const unowned = resources({
    volume: {
      ...current.volume,
      labels: resourceLabels(
        "postgres-volume",
        "22222222-2222-4222-8222-222222222222",
      ),
    },
  });
  assert.throws(
    () =>
      authorizeResourceCleanup(lease(), {
        ...unowned,
        databaseReceipt: receipt(),
      }),
    /Invalid disposable test database contract/,
  );

  const foreignAttachment = resources({
    volume: {
      ...current.volume,
      attachedContainerIds: ["container-immutable-id", "foreign-container-id"],
    },
  });
  assert.throws(
    () =>
      authorizeResourceCleanup(lease(), {
        ...foreignAttachment,
        databaseReceipt: receipt(),
      }),
    /Invalid disposable test database contract/,
  );

  const remotePublication = resources({
    container: {
      ...current.container,
      publishedPorts: [
        { hostAddress: "0.0.0.0", hostPort: 55432, containerPort: 5432 },
      ],
    },
  });
  assert.throws(
    () =>
      authorizeResourceCleanup(lease(), {
        ...remotePublication,
        databaseReceipt: receipt(),
      }),
    /Invalid disposable test database contract/,
  );

  const bindMount = resources({
    container: { ...current.container, bindMounts: ["/host/path"] },
  });
  assert.throws(
    () =>
      authorizeResourceCleanup(lease(), {
        ...bindMount,
        databaseReceipt: receipt(),
      }),
    /Invalid disposable test database contract/,
  );

  const changedImage = resources({
    container: { ...current.container, imageIdentity: "untrusted-image" },
  });
  assert.throws(
    () =>
      authorizeResourceCleanup(lease(), {
        ...changedImage,
        databaseReceipt: receipt(),
      }),
    /Invalid disposable test database contract/,
  );
});

test("requires browser to Next to Express to one native resolver to PostgreSQL with no authority bypass", () => {
  assert.equal(assertD5Topology(REQUIRED_D5_TOPOLOGY), true);
  const violations: TopologyContract[] = [
    {
      ...REQUIRED_D5_TOPOLOGY,
      databaseResolvers: ["native resolver", "legacy resolver"],
    },
    { ...REQUIRED_D5_TOPOLOGY, permitsBypass: true },
    { ...REQUIRED_D5_TOPOLOGY, permitsLegacyFallback: true },
    { ...REQUIRED_D5_TOPOLOGY, networkNamespace: "other" },
    { ...REQUIRED_D5_TOPOLOGY, permitsLoopbackOnly: false },
    {
      ...REQUIRED_D5_TOPOLOGY,
      path: ["browser", "Next.js", "Express", "legacy resolver", "PostgreSQL"],
    },
    {
      ...REQUIRED_D5_TOPOLOGY,
      domainAreas: REQUIRED_D5_TOPOLOGY.domainAreas.filter(
        (area) => area !== "branch",
      ),
    },
    {} as unknown as TopologyContract,
  ];
  for (const violation of violations) {
    assert.throws(
      () => assertD5Topology(violation),
      /Invalid disposable test database contract/,
    );
  }
});
