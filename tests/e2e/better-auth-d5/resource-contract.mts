import { isIP } from "node:net";

const OWNER_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDENTIFIER = /^[a-z][a-z0-9_-]{0,62}$/;
type ResourceRole =
  "postgres-container" | "postgres-volume" | "postgres-network";
const OWNER_LABEL = "stockwise.d5.owner";
const ROLE_LABEL = "stockwise.d5.role";
const CREATOR_LABEL = "stockwise.d5.creator";
const DOMAIN_AREAS = [
  "onboarding",
  "org",
  "membership",
  "branch",
  "catalog",
  "inventory",
  "sales",
] as const;

export type DisposableDatabaseContract = Readonly<{
  ownerUuid: string;
  host: "127.0.0.1" | "::1";
  port: number;
  database: string;
  user: string;
}>;

export type ExplicitEnvironment = Readonly<{
  TEST_DATABASE_URL?: string;
  DATABASE_URL?: string;
}>;

export type DatabaseIdentityReceipt = Readonly<{
  currentDatabase: string;
  currentUser: string;
  serverAddress: string;
  serverPort: number;
  clusterIdentity: string;
  ownerUuid: string;
}>;

export type OwnedResource = Readonly<{
  id: string;
  labels: Readonly<Record<string, string>>;
}>;

export type ContainerMountReceipt = Readonly<{
  type: "volume" | "bind";
  source: string;
  destination: string;
  readOnly: boolean;
}>;

export type PublishedPortReceipt = Readonly<{
  hostAddress: string;
  hostPort: number;
  containerPort: number;
}>;

export type ContainerResource = OwnedResource &
  Readonly<{
    imageIdentity: string;
    networkIds: readonly string[];
    mounts: readonly ContainerMountReceipt[];
    bindMounts: readonly string[];
    hostSocketMounts: readonly string[];
    publishedPorts: readonly PublishedPortReceipt[];
  }>;

export type VolumeResource = OwnedResource &
  Readonly<{
    attachedContainerIds: readonly string[];
  }>;

export type NetworkResource = OwnedResource &
  Readonly<{
    memberContainerIds: readonly string[];
  }>;

export type ResourceSet = Readonly<{
  container: ContainerResource;
  volume: VolumeResource;
  network: NetworkResource;
}>;

export type ResourceLease = Readonly<{
  ownerUuid: string;
  database: DisposableDatabaseContract;
  expectedClusterIdentity: string;
  expectedServerAddress: "127.0.0.1" | "::1";
  expectedServerPort: 5432;
  expectedImageIdentity: string;
  databaseReceipt: DatabaseIdentityReceipt;
  resources: ResourceSet;
}>;

export type TopologyContract = Readonly<{
  path: readonly string[];
  databaseResolvers: readonly string[];
  permitsLoopbackOnly: boolean;
  networkNamespace: "loopback-only" | "other";
  permitsBypass: boolean;
  permitsLegacyFallback: boolean;
  domainAreas: readonly string[];
}>;

function invalid(): never {
  throw new Error("Invalid disposable test database contract.");
}

function assertOwnerUuid(ownerUuid: string): void {
  if (typeof ownerUuid !== "string" || !OWNER_UUID.test(ownerUuid)) invalid();
}

/** Validate only the explicit task environment; this function never reads process.env. */
export function parseDisposableTestDatabaseEnvironment(
  environment: ExplicitEnvironment,
  ownerUuid: string,
): DisposableDatabaseContract {
  assertOwnerUuid(ownerUuid);
  if (
    !environment ||
    environment.DATABASE_URL !== undefined ||
    typeof environment.TEST_DATABASE_URL !== "string"
  )
    invalid();

  const source = environment.TEST_DATABASE_URL;
  for (let index = 0; index < source.length; index++) {
    const code = source.charCodeAt(index);
    if (code <= 32 || code === 127) invalid();
  }
  if (source.length === 0 || /[?#]/.test(source) || /[,;]/.test(source))
    invalid();

  // Require a literal, canonical authority rather than URL's permissive IPv4 normalization.
  const match =
    /^postgres(?:ql)?:\/\/([^:@/]+):([^@/]+)@([^/:?#]+|\[[^\]]+\]):([0-9]+)\/([^/?#]+)$/.exec(
      source,
    );
  if (!match) invalid();
  const [, rawUsername, , rawHost, rawPort, rawDatabase] = match;
  if (
    !rawUsername ||
    !rawHost ||
    !rawPort ||
    !rawDatabase ||
    rawUsername.includes("%")
  )
    invalid();

  let host: "127.0.0.1" | "::1";
  let username: string;
  try {
    const parsed = new URL(source);
    const candidate = parsed.hostname;
    if (
      rawHost === "127.0.0.1" &&
      candidate === "127.0.0.1" &&
      isIP(candidate) === 4
    )
      host = candidate;
    else if (
      rawHost === "[::1]" &&
      candidate === "[::1]" &&
      isIP(candidate.slice(1, -1)) === 6
    )
      host = "::1";
    else invalid();
    username = decodeURIComponent(parsed.username);
  } catch {
    return invalid();
  }

  const port = Number(rawPort);
  const ownerKey = ownerUuid.replaceAll("-", "");
  const expectedDatabase = `stockwise_d5_${ownerKey}_test`;
  const expectedUser = `stockwise_d5_${ownerKey}_owner`;
  if (
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65535 ||
    String(port) !== rawPort
  )
    invalid();
  if (
    rawDatabase !== expectedDatabase ||
    username !== expectedUser ||
    !IDENTIFIER.test(rawDatabase) ||
    !IDENTIFIER.test(username)
  )
    invalid();

  return Object.freeze({
    ownerUuid,
    host,
    port,
    database: expectedDatabase,
    user: expectedUser,
  });
}

function sameDatabaseIdentity(
  expected: DisposableDatabaseContract,
  receipt: DatabaseIdentityReceipt,
  serverAddress: "127.0.0.1" | "::1",
  serverPort: number,
): boolean {
  if (
    !expected ||
    typeof expected.ownerUuid !== "string" ||
    !OWNER_UUID.test(expected.ownerUuid)
  )
    return false;
  const ownerKey = expected.ownerUuid.replaceAll("-", "");
  return (
    expected.database === `stockwise_d5_${ownerKey}_test` &&
    expected.user === `stockwise_d5_${ownerKey}_owner` &&
    (expected.host === "127.0.0.1" || expected.host === "::1") &&
    Number.isSafeInteger(expected.port) &&
    expected.port >= 1 &&
    expected.port <= 65535 &&
    (serverAddress === "127.0.0.1" || serverAddress === "::1") &&
    serverPort === 5432 &&
    !!receipt &&
    receipt.currentDatabase === expected.database &&
    receipt.currentUser === expected.user &&
    receipt.ownerUuid === expected.ownerUuid &&
    receipt.serverAddress === serverAddress &&
    receipt.serverPort === serverPort &&
    typeof receipt.clusterIdentity === "string" &&
    receipt.clusterIdentity.length > 0
  );
}

function assertResource(
  resource: OwnedResource | undefined,
  ownerUuid: string,
  role: ResourceRole,
): void {
  if (
    !resource ||
    typeof resource.id !== "string" ||
    resource.id.length === 0 ||
    !resource.labels
  )
    invalid();
  if (
    resource.labels[OWNER_LABEL] !== ownerUuid ||
    resource.labels[ROLE_LABEL] !== role ||
    resource.labels[CREATOR_LABEL] !== "parent"
  )
    invalid();
}

function assertResourceTopology(
  resources: ResourceSet,
  ownerUuid: string,
  database: DisposableDatabaseContract,
  expectedImageIdentity: string,
): void {
  if (!resources) invalid();
  const { container, volume, network } = resources;
  assertResource(container, ownerUuid, "postgres-container");
  assertResource(volume, ownerUuid, "postgres-volume");
  assertResource(network, ownerUuid, "postgres-network");
  if (
    !Array.isArray(container.networkIds) ||
    !Array.isArray(container.mounts) ||
    !Array.isArray(container.bindMounts) ||
    !Array.isArray(container.hostSocketMounts) ||
    !Array.isArray(container.publishedPorts) ||
    !Array.isArray(volume.attachedContainerIds) ||
    !Array.isArray(network.memberContainerIds)
  )
    invalid();
  if (new Set([container.id, volume.id, network.id]).size !== 3) invalid();
  if (
    typeof expectedImageIdentity !== "string" ||
    expectedImageIdentity.length === 0 ||
    container.imageIdentity !== expectedImageIdentity
  )
    invalid();
  if (
    container.networkIds.length !== 1 ||
    container.networkIds[0] !== network.id ||
    network.memberContainerIds.length !== 1 ||
    network.memberContainerIds[0] !== container.id
  )
    invalid();
  if (
    volume.attachedContainerIds.length !== 1 ||
    volume.attachedContainerIds[0] !== container.id
  )
    invalid();
  const mount = container.mounts[0];
  if (
    container.mounts.length !== 1 ||
    !mount ||
    mount.type !== "volume" ||
    mount.source !== volume.id ||
    mount.destination !== "/var/lib/postgresql/data" ||
    mount.readOnly !== false ||
    container.bindMounts.length !== 0 ||
    container.hostSocketMounts.length !== 0
  )
    invalid();
  const publishedPort = container.publishedPorts[0];
  if (
    container.publishedPorts.length !== 1 ||
    !publishedPort ||
    publishedPort.hostAddress !== database.host ||
    publishedPort.hostPort !== database.port ||
    publishedPort.containerPort !== 5432
  )
    invalid();
}

/** Pure exact-identity guard; callers compare the lease against the current parent-owned snapshot. */
export function authorizeResourceCleanup(
  lease: ResourceLease,
  current: ResourceSet & Readonly<{ databaseReceipt: DatabaseIdentityReceipt }>,
): true {
  if (
    !lease ||
    !current ||
    !lease.database ||
    !lease.databaseReceipt ||
    !current.databaseReceipt ||
    !lease.resources
  )
    invalid();
  assertOwnerUuid(lease.ownerUuid);
  if (
    lease.database.ownerUuid !== lease.ownerUuid ||
    typeof lease.expectedClusterIdentity !== "string" ||
    lease.expectedClusterIdentity.length === 0 ||
    lease.databaseReceipt.clusterIdentity !== lease.expectedClusterIdentity ||
    current.databaseReceipt.clusterIdentity !== lease.expectedClusterIdentity ||
    !sameDatabaseIdentity(
      lease.database,
      lease.databaseReceipt,
      lease.expectedServerAddress,
      lease.expectedServerPort,
    ) ||
    !sameDatabaseIdentity(
      lease.database,
      current.databaseReceipt,
      lease.expectedServerAddress,
      lease.expectedServerPort,
    )
  )
    invalid();

  assertResourceTopology(
    lease.resources,
    lease.ownerUuid,
    lease.database,
    lease.expectedImageIdentity,
  );
  assertResourceTopology(
    current,
    lease.ownerUuid,
    lease.database,
    lease.expectedImageIdentity,
  );
  if (
    current.container.id !== lease.resources.container.id ||
    current.volume.id !== lease.resources.volume.id ||
    current.network.id !== lease.resources.network.id
  )
    invalid();
  return true;
}

export const REQUIRED_D5_TOPOLOGY: TopologyContract = Object.freeze({
  path: Object.freeze([
    "browser",
    "Next.js",
    "Express",
    "native resolver",
    "PostgreSQL",
  ]),
  databaseResolvers: Object.freeze(["native resolver"]),
  permitsLoopbackOnly: true,
  networkNamespace: "loopback-only",
  permitsBypass: false,
  permitsLegacyFallback: false,
  domainAreas: Object.freeze(DOMAIN_AREAS),
});

/** Accept only the specified single-resolver, loopback-only future topology. */
export function assertD5Topology(contract: TopologyContract): true {
  if (
    !contract ||
    !Array.isArray(contract.path) ||
    !Array.isArray(contract.databaseResolvers) ||
    !Array.isArray(contract.domainAreas) ||
    contract.path.length !== REQUIRED_D5_TOPOLOGY.path.length ||
    contract.path.some(
      (node, index) => node !== REQUIRED_D5_TOPOLOGY.path[index],
    ) ||
    contract.databaseResolvers.length !== 1 ||
    contract.databaseResolvers[0] !== "native resolver" ||
    contract.permitsLoopbackOnly !== true ||
    contract.permitsBypass !== false ||
    contract.networkNamespace !== "loopback-only" ||
    contract.permitsLegacyFallback !== false ||
    contract.domainAreas.length !== DOMAIN_AREAS.length ||
    DOMAIN_AREAS.some((area, index) => contract.domainAreas[index] !== area)
  )
    invalid();
  return true;
}
