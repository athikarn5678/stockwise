import {
  digest,
  snapshotManifest,
  type SourceEntry,
  type VerifiedSnapshot,
} from "./source-contract.mts";
import {
  candidateFiles,
  receiveCandidate,
  validateHandoffManifest,
  type HandoffManifest,
} from "./handoff-contract.mts";
import {
  openProtectedLinuxRoot,
  closeProtectedLinuxRoot,
  materializeLinuxSnapshot,
  verifyProtectedLinuxRoot,
  type LinuxRootPolicy,
  type ProtectedLinuxRoot,
} from "./linux-intake.mts";
import {
  assertExactMigrationManifests,
  readMigrationSourceManifest,
  type MigrationRepositoryManifest,
} from "./migration-contract.mts";
import {
  requireDeployedLinuxSeparation,
  type LinuxSeparationEvidence,
} from "./linux-separation.mts";

export interface LinuxAuthorityAcceptance {
  version: 1;
  decision: "ACCEPT";
  reference: string;
  executionAuthority: "VERIFIED_LINUX_RECEIVED_SNAPSHOT_ONLY";
  windowsRepositoryIsSourceOfTruth: true;
  windowsPathProvenanceClaimed: false;
  separateHostId: string;
  linuxUser: string;
  nativeRoot: string;
  filesystem: LinuxRootPolicy;
  sourceSha256: string;
  handoffManifestSha256: string;
  configFingerprint: string;
  issuedAt: string;
  expiresAt: string;
}
export interface HandoffTrust {
  authoritySha256: string;
  handoffManifestSha256: string;
  configFingerprint: string;
  separateHostId: string;
  linuxUser: string;
  nativeRoot: string;
  filesystem: LinuxRootPolicy;
  now: number;
}
export function validateLinuxAuthority(
  acceptance: LinuxAuthorityAcceptance | null,
  manifest: HandoffManifest,
  trust: HandoffTrust,
): void {
  validateHandoffManifest(manifest, trust.handoffManifestSha256);
  if (!acceptance) throw new Error("LINUX_AUTHORITY_OWNER_ACCEPTANCE_OPEN");
  const issued = Date.parse(acceptance.issuedAt);
  const expires = Date.parse(acceptance.expiresAt);
  if (
    !/^[a-f0-9]{64}$/.test(trust.authoritySha256) ||
    digest(JSON.stringify(acceptance)) !== trust.authoritySha256 ||
    acceptance.version !== 1 ||
    acceptance.decision !== "ACCEPT" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(acceptance.reference) ||
    acceptance.executionAuthority !== "VERIFIED_LINUX_RECEIVED_SNAPSHOT_ONLY" ||
    acceptance.windowsRepositoryIsSourceOfTruth !== true ||
    acceptance.windowsPathProvenanceClaimed !== false ||
    acceptance.sourceSha256 !== digest(JSON.stringify(manifest.sourceFiles)) ||
    acceptance.handoffManifestSha256 !== trust.handoffManifestSha256 ||
    acceptance.configFingerprint !== trust.configFingerprint ||
    acceptance.separateHostId !== trust.separateHostId ||
    typeof acceptance.separateHostId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(acceptance.separateHostId) ||
    acceptance.linuxUser !== trust.linuxUser ||
    acceptance.nativeRoot !== trust.nativeRoot ||
    JSON.stringify(acceptance.filesystem) !==
      JSON.stringify(trust.filesystem) ||
    !Number.isFinite(trust.now) ||
    !Number.isFinite(issued) ||
    !Number.isFinite(expires) ||
    issued > trust.now ||
    expires <= trust.now ||
    expires <= issued ||
    new Date(issued).toISOString() !== acceptance.issuedAt ||
    new Date(expires).toISOString() !== acceptance.expiresAt
  )
    throw new Error("LINUX_SOURCE_AUTHORITY_REJECTED");
}

export class LinuxExecutionSource {}
type ExecutionState = {
  snapshot: VerifiedSnapshot;
  migrations: MigrationRepositoryManifest;
  root: ProtectedLinuxRoot;
  acceptance: LinuxAuthorityAcceptance;
  manifest: HandoffManifest;
  trust: HandoffTrust;
  path: string;
  released: boolean;
};
const executions = new WeakMap<LinuxExecutionSource, ExecutionState>();

export async function receiveLinuxExecutionSource(options: {
  stream: AsyncIterable<Uint8Array>;
  manifest: HandoffManifest;
  acceptance: LinuxAuthorityAcceptance | null;
  trust: HandoffTrust;
  migrations: MigrationRepositoryManifest;
  migrationSha256: string;
  separationEvidence: LinuxSeparationEvidence | null;
  independentlyProvisionedProducerIdentity: string;
}): Promise<LinuxExecutionSource> {
  const manifest = structuredClone(options.manifest);
  const acceptance = structuredClone(options.acceptance);
  const trust = structuredClone(options.trust);
  const migrations = structuredClone(options.migrations);
  validateLinuxAuthority(acceptance, manifest, { ...trust, now: Date.now() });
  requireDeployedLinuxSeparation(
    options.separationEvidence,
    trust.separateHostId,
    options.independentlyProvisionedProducerIdentity,
  );
  if (digest(JSON.stringify(migrations)) !== options.migrationSha256)
    throw new Error("HANDOFF_MIGRATION_APPROVAL_MISMATCH");
  const root = await openProtectedLinuxRoot(trust.nativeRoot, trust.filesystem);
  try {
    const candidate = await receiveCandidate(
      options.stream,
      manifest,
      trust.handoffManifestSha256,
    );
    await verifyProtectedLinuxRoot(root);
    validateLinuxAuthority(acceptance, manifest, { ...trust, now: Date.now() });
    const materialized = await materializeLinuxSnapshot(
      root,
      candidateFiles(candidate),
      manifest.sourceFiles,
    );
    const actualMigrations = await readMigrationSourceManifest(
      `${materialized.path}/apps/api/prisma/migrations`,
    );
    assertExactMigrationManifests(migrations, actualMigrations);
    if (!acceptance) throw new Error("LINUX_AUTHORITY_OWNER_ACCEPTANCE_OPEN");
    const source = new LinuxExecutionSource();
    executions.set(source, {
      snapshot: materialized.snapshot,
      migrations,
      root,
      acceptance,
      manifest,
      trust,
      path: materialized.path,
      released: false,
    });
    return source;
  } catch (error) {
    await closeProtectedLinuxRoot(root);
    throw error;
  }
}

export async function inspectLinuxExecutionSource(
  source: LinuxExecutionSource | null,
  expectedFiles: readonly SourceEntry[],
  migrationSha256: string,
  configFingerprint: string,
): Promise<{
  snapshot: VerifiedSnapshot;
  migrations: MigrationRepositoryManifest;
  retainedIntake: string;
}> {
  const state = source ? executions.get(source) : undefined;
  if (!state || state.released)
    throw new Error("VERIFIED_LINUX_EXECUTION_SOURCE_REQUIRED");
  validateLinuxAuthority(state.acceptance, state.manifest, {
    ...state.trust,
    now: Date.now(),
  });
  await verifyProtectedLinuxRoot(state.root);
  if (
    configFingerprint !== state.trust.configFingerprint ||
    digest(JSON.stringify(state.migrations)) !== migrationSha256 ||
    JSON.stringify(snapshotManifest(state.snapshot)) !==
      JSON.stringify(expectedFiles)
  )
    throw new Error("LINUX_EXECUTION_SNAPSHOT_SUBSTITUTED");
  const retainedIntake = state.path.split("/").at(-1);
  if (!retainedIntake || !/^intake-[a-f0-9-]{36}$/.test(retainedIntake))
    throw new Error("LINUX_INTAKE_IDENTITY_INVALID");
  return {
    snapshot: state.snapshot,
    migrations: structuredClone(state.migrations),
    retainedIntake,
  };
}
export async function releaseLinuxExecutionSource(
  source: LinuxExecutionSource,
): Promise<void> {
  const state = executions.get(source);
  if (!state) return;
  state.released = true;
  executions.delete(source);
  await closeProtectedLinuxRoot(state.root);
}
