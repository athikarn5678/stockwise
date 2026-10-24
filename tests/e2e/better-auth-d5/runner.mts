import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import {
  digest,
  snapshotArchive,
  type SourceEntry,
} from "./source-contract.mts";
import {
  inspectLinuxExecutionSource,
  type LinuxExecutionSource,
} from "./linux-handoff.mts";
import { inspectResourceIdentity } from "./resource-inspection.mts";
import {
  validateEvidence,
  isSafeArtifactPath,
  type ArtifactReceipt,
  type EvidenceInput,
  type StageReceipt,
  type TestResult,
} from "./evidence-contract.mts";
import {
  validateSafetyApproval,
  type ApprovalTrust,
  type SafetyApproval,
} from "./approval-contract.mts";
import {
  AcquisitionLedger,
  AcquisitionCreateFailure,
  type AcquisitionResource,
  type AcquisitionObservation,
  type AcquisitionCleanupResult,
  type AcquisitionFailure,
  type Inspection,
} from "./acquisition-contract.mts";

const exec = promisify(execFile);
const ENDPOINT = "unix:///var/run/docker.sock";
const CLEAN_ENV = { PATH: process.env.PATH ?? "" };
const environment = [
  "PATH=/usr/local/bin:/usr/bin:/bin",
  "HOME=/scratch/home",
  "TMPDIR=/scratch/tmp",
  "XDG_CACHE_HOME=/scratch/cache",
  "CI=1",
  "NEXT_TELEMETRY_DISABLED=1",
  "COREPACK_ENABLE_NETWORK=0",
  "PNPM_HOME=/scratch/pnpm",
];
const SOURCE_LABEL = "stockwise.d5.source";
const OWNER_LABEL = "stockwise.d5.owner";
const TOKEN_LABEL = "stockwise.d5.acquisition-token";
const DEPENDENCIES = [
  [".d5-dependencies/root", "/workspace/node_modules"],
  [".d5-dependencies/api", "/workspace/apps/api/node_modules"],
  [".d5-dependencies/web", "/workspace/apps/web/node_modules"],
] as const;

type Stage = "seed" | "preparation" | "runtime";
export type RunnerPlan = {
  owner: string;
  image: string;
  sourceSha256: string;
  volume: string;
  seed: string;
  preparation: string;
  runtime: string;
};
export type RunnerReceipt = {
  owner: string;
  sourceSha256: string;
  stages: StageReceipt[];
  cleanup: "COMPLETE" | "INCOMPLETE";
  acquisitions: AcquisitionCleanupResult;
  acquisitionFailures: readonly AcquisitionFailure[];
  exitCode: number;
  failureStage: string | null;
  evidenceErrors: readonly string[];
};
export type LifecycleJournal = {
  owner: string;
  sourceSha256: string;
  acquisitions: readonly AcquisitionResource[];
  acquisitionFailures: readonly AcquisitionFailure[];
  state: "ACQUIRING" | "VALIDATING" | "FINISHED";
  receipt?: RunnerReceipt;
};
export type RetainJournal = (
  journal: LifecycleJournal,
) => Promise<ArtifactReceipt>;

export function createRunnerPlan(
  image: string,
  files: readonly SourceEntry[],
): RunnerPlan {
  if (
    !/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(image) ||
    !files.length
  )
    throw new Error("PINNED_TOOLCHAIN_AND_SOURCE_REQUIRED");
  const owner = randomUUID();
  const prefix = `stockwise-d5-${owner}`;
  return {
    owner,
    image,
    sourceSha256: digest(JSON.stringify(files)),
    volume: `${prefix}-workspace`,
    seed: `${prefix}-seed`,
    preparation: `${prefix}-prep`,
    runtime: `${prefix}-runtime`,
  };
}

// This is trusted, fixed tool code. Transferred source is checked before the installer sees it.
const VERIFY_SOURCE = `
import {readFile,lstat} from "node:fs/promises";
import {createHash} from "node:crypto";
const sha=b=>createHash("sha256").update(b).digest("hex");
const raw=await readFile("/workspace/.d5-manifest.json","utf8");
if(sha(raw)!==process.env.D5_SOURCE_SHA256)process.exit(13);
const entries=JSON.parse(raw);
for(const entry of entries){
 let current="/workspace";
 for(const part of entry.path.split("/")){current+="/"+part;if((await lstat(current)).isSymbolicLink())process.exit(14);}
 if(!(await lstat(current)).isFile()||sha(await readFile(current))!==entry.sha256)process.exit(15);
}
`;
const RUNTIME_SCRIPT = `
mkdir -p /scratch/home /scratch/tmp /scratch/cache
node --input-type=module -e '${VERIFY_SOURCE}'
node --input-type=module -e '
import {access,writeFile} from "node:fs/promises";
import {constants} from "node:fs";
import {createConnection} from "node:net";
if(process.getuid()!==1000)process.exit(11);
for(const p of ["/workspace","/workspace/package.json","/workspace/node_modules","/usr/local/bin/node"]){
 try{await access(p,constants.W_OK);process.exit(12);}catch{}
}
await writeFile("/scratch/tmp/probe","owned");
for(const [host,port] of [["192.0.2.1",443],["127.0.0.1",5432],["127.0.0.1",3001]]){
 await new Promise((resolve,reject)=>{const s=createConnection({host,port});s.setTimeout(1000);
 s.once("connect",()=>{s.destroy();reject(new Error("NETWORK_PROBE_FAILED"));});
 s.once("error",()=>{s.destroy();resolve();});s.once("timeout",()=>{s.destroy();resolve();});});
}'
node --test --test-concurrency=1 --test-name-pattern="(?!)" --test-reporter=./tests/e2e/better-auth-d5/node-reporter.mts tests/e2e/better-auth-d5/*.test.mts
node --test --test-concurrency=1 --test-reporter=./tests/e2e/better-auth-d5/node-reporter.mts tests/e2e/better-auth-d5/*.test.mts
`;

export function containerArguments(
  plan: RunnerPlan,
  stage: Stage,
  token: string,
): string[] {
  const mounts = [
    "--mount",
    `type=volume,src=${plan.volume},dst=/workspace${stage === "seed" ? "" : ",readonly"}`,
  ];
  if (stage !== "seed")
    for (const [subpath, destination] of DEPENDENCIES)
      mounts.push(
        "--mount",
        `type=volume,src=${plan.volume},volume-subpath=${subpath},dst=${destination}${stage === "runtime" ? ",readonly" : ""}`,
      );
  return [
    "create",
    "--pull=never",
    "--name",
    plan[stage],
    "--label",
    `${OWNER_LABEL}=${plan.owner}`,
    "--label",
    `${SOURCE_LABEL}=${plan.sourceSha256}`,
    "--label",
    `${TOKEN_LABEL}=${token}`,
    "--read-only",
    "--user=1000:1000",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--network=none",
    "--ipc=private",
    "--init",
    "--cpus=2",
    "--memory=4g",
    "--memory-swap=4g",
    "--pids-limit=256",
    "--ulimit=nofile=1024:1024",
    "--ulimit=fsize=268435456:268435456",
    "--stop-timeout=5",
    "--log-driver=local",
    "--log-opt=max-size=1m",
    "--log-opt=max-file=1",
    "--tmpfs",
    "/scratch:rw,nosuid,nodev,noexec,size=1g,uid=1000,gid=1000,mode=0700",
    ...mounts,
    "--workdir=/workspace",
    plan.image,
    "/usr/bin/env",
    "-i",
    ...environment,
    `D5_SOURCE_SHA256=${plan.sourceSha256}`,
    "/usr/bin/timeout",
    "--signal=TERM",
    "--kill-after=5",
    "900",
    "/bin/sh",
    "-ceu",
    stage === "runtime"
      ? RUNTIME_SCRIPT
      : "mkdir -p /scratch/home /scratch/tmp; sleep 890",
  ];
}

class IsolationFailure extends AcquisitionCreateFailure {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly terminationSignal: string | null;
  readonly started: boolean;
  constructor(
    exitCode: number | null,
    timedOut: boolean,
    terminationSignal: string | null,
    createdIdentity: string | null = null,
  ) {
    super("ISOLATION_COMMAND_FAILED", createdIdentity);
    this.exitCode = exitCode;
    this.timedOut = timedOut;
    this.terminationSignal = terminationSignal;
    this.started = exitCode !== null || terminationSignal !== null;
  }
}
async function docker(
  args: string[],
  timeout = 30_000,
  signal?: AbortSignal,
): Promise<string> {
  try {
    const { stdout } = await exec("docker", ["--host", ENDPOINT, ...args], {
      env: CLEAN_ENV,
      timeout,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      signal,
    });
    return stdout.trim();
  } catch (error) {
    const failure = error as {
      code?: unknown;
      killed?: boolean;
      signal?: unknown;
      stdout?: unknown;
    };
    const createOutput =
      args[0] === "create" && typeof failure.stdout === "string"
        ? failure.stdout.trim()
        : "";
    const createdIdentity = /^[a-f0-9]{64}$/.test(createOutput)
      ? createOutput
      : null;
    throw new IsolationFailure(
      typeof failure.code === "number" ? failure.code : null,
      failure.killed === true && signal?.aborted !== true,
      typeof failure.signal === "string" ? failure.signal : null,
      createdIdentity,
    );
  }
}
function oneObject(json: string): Record<string, unknown> {
  const list: unknown = JSON.parse(json);
  if (
    !Array.isArray(list) ||
    list.length !== 1 ||
    !list[0] ||
    typeof list[0] !== "object"
  )
    throw new Error("RESOURCE_INSPECTION_INVALID");
  return list[0] as Record<string, unknown>;
}
function observation(
  raw: Record<string, unknown>,
  resource: AcquisitionResource,
): AcquisitionObservation {
  const config = raw.Config as { Labels?: Record<string, string> } | undefined;
  const labels = resource.kind === "container" ? config?.Labels : raw.Labels;
  const identity = resource.kind === "container" ? raw.Id : raw.CreatedAt;
  if (
    typeof identity !== "string" ||
    !identity ||
    !labels ||
    typeof labels !== "object"
  )
    throw new Error("RESOURCE_RECEIPT_INVALID");
  return {
    identity,
    labels: labels as Record<string, string>,
    creationIdentity: resource.kind === "volume" ? identity : null,
  };
}
function validateObservedResource(
  plan: RunnerPlan,
  approval: SafetyApproval,
  resource: AcquisitionResource,
  value: Record<string, unknown>,
): boolean {
  if (resource.kind === "volume") {
    const options = value.Options as Record<string, string> | undefined;
    return (
      value.Name === resource.name &&
      value.Driver === "local" &&
      options?.type === "tmpfs" &&
      options.device === "tmpfs" &&
      options.o === "size=3g,uid=1000,gid=1000,mode=0700"
    );
  }
  const stage = (["seed", "preparation", "runtime"] as const).find(
    (key) => plan[key] === resource.name,
  );
  if (
    !stage ||
    value.Name !== `/${resource.name}` ||
    value.Image !== approval.resolvedImageId
  )
    return false;
  const config = value.Config as { User?: string; Image?: string } | undefined;
  const host = value.HostConfig as
    | {
        ReadonlyRootfs?: boolean;
        NetworkMode?: string;
        CapDrop?: string[];
        SecurityOpt?: string[];
        Privileged?: boolean;
        PidMode?: string;
        Memory?: number;
        MemorySwap?: number;
        NanoCpus?: number;
        PidsLimit?: number;
        PortBindings?: Record<string, unknown>;
        RestartPolicy?: { Name: string };
        Mounts?: {
          Type: string;
          Source: string;
          Target: string;
          ReadOnly?: boolean;
          VolumeOptions?: { Subpath?: string };
        }[];
      }
    | undefined;
  if (
    config?.User !== "1000:1000" ||
    config.Image !== plan.image ||
    !host ||
    !host.ReadonlyRootfs ||
    host.NetworkMode !== "none" ||
    host.Privileged ||
    host.PidMode === "host" ||
    !host.CapDrop?.includes("ALL") ||
    !host.SecurityOpt?.includes("no-new-privileges") ||
    host.Memory !== 4 * 1024 ** 3 ||
    host.MemorySwap !== host.Memory ||
    host.NanoCpus !== 2_000_000_000 ||
    host.PidsLimit !== 256 ||
    Object.keys(host.PortBindings ?? {}).length ||
    host.RestartPolicy?.Name !== "no"
  )
    return false;
  const mounts = host.Mounts;
  if (
    !Array.isArray(mounts) ||
    mounts.length !== (stage === "seed" ? 1 : 4) ||
    mounts.some((m) => m.Type !== "volume" || m.Source !== plan.volume)
  )
    return false;
  const source = mounts.find((m) => m.Target === "/workspace");
  if (
    !source ||
    !!source.ReadOnly !== (stage !== "seed") ||
    source.VolumeOptions?.Subpath
  )
    return false;
  if (stage !== "seed")
    for (const [subpath, destination] of DEPENDENCIES) {
      const mount = mounts.find((m) => m.Target === destination);
      if (
        !mount ||
        mount.VolumeOptions?.Subpath !== subpath ||
        !!mount.ReadOnly !== (stage === "runtime")
      )
        return false;
    }
  return true;
}

export async function executeInfrastructure(
  requestedPlan: RunnerPlan,
  requestedFiles: readonly SourceEntry[],
  source: LinuxExecutionSource | null,
  requestedApproval: SafetyApproval,
  requestedTrust: ApprovalTrust,
  retain: RetainJournal,
): Promise<RunnerReceipt> {
  // Freeze the candidate boundary before any await; callers cannot substitute it during capture/preparation.
  const plan = structuredClone(requestedPlan);
  const files = structuredClone(requestedFiles);
  const approval = structuredClone(requestedApproval);
  const trust = {
    reviewedApprovalSha256: requestedTrust.reviewedApprovalSha256,
    now: Date.now(),
  };
  const retainChecked: RetainJournal = async (journal) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const artifact = await Promise.race([
      retain(journal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("EVIDENCE_RETENTION_TIMED_OUT")),
          30_000,
        );
      }),
    ]).finally(() => {
      clearTimeout(timer);
    });
    if (
      !artifact ||
      artifact.owner !== plan.owner ||
      artifact.retained !== true ||
      !isSafeArtifactPath("/parent-evidence", artifact.path)
    )
      throw new Error("EVIDENCE_RETENTION_UNCONFIRMED");
    return artifact;
  };
  // A pinned approval is verified before any filesystem acquisition, preparation or Docker call.
  const preApproved = validateSafetyApproval(
    plan,
    files,
    approval?.testManifest?.migrationSha256 ?? "",
    approval,
    trust,
  );
  const prefix = `stockwise-d5-${plan.owner}`;
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      plan.owner,
    ) ||
    plan.volume !== `${prefix}-workspace` ||
    plan.seed !== `${prefix}-seed` ||
    plan.preparation !== `${prefix}-prep` ||
    plan.runtime !== `${prefix}-runtime`
  )
    throw new Error("RUNNER_PLAN_INVALID");
  if (process.platform !== "linux")
    throw new Error("SEPARATE_LINUX_COORDINATOR_REQUIRED");
  if (
    [
      "DATABASE_URL",
      "TEST_DATABASE_URL",
      "DOCKER_HOST",
      "DOCKER_CONTEXT",
      "NODE_OPTIONS",
    ].some((key) => process.env[key] !== undefined)
  )
    throw new Error("INHERITED_EXECUTION_CONFIGURATION_REJECTED");
  // Only an independently approved, protected Linux receive capability can authorize execution bytes.
  const { snapshot, migrations } = await inspectLinuxExecutionSource(
    source,
    files,
    approval.testManifest.migrationSha256,
    preApproved.configFingerprint,
  );
  const archive = snapshotArchive(snapshot);
  const migrationHash = digest(JSON.stringify(migrations));
  const approved = validateSafetyApproval(
    plan,
    files,
    migrationHash,
    approval,
    { ...trust, now: Date.now() },
  );
  const stages: StageReceipt[] = [];
  let activeStage: Stage | "PREFLIGHT" = "PREFLIGHT";
  let failureStage: string | null = null;
  let interrupted = false;
  const abort = new AbortController();
  const onSignal = () => {
    interrupted = true;
    abort.abort();
  };
  const runDocker = (args: string[], timeout?: number) =>
    docker(args, timeout, abort.signal);
  const rawReceipts = new Map<string, Record<string, unknown>>();
  const inspectResource = async (
    resource: AcquisitionResource,
    identity?: string,
  ): Promise<Inspection> => {
    const raw = await inspectResourceIdentity(resource, identity, docker);
    if (!raw) return { kind: "absent" };
    const observed = observation(raw, resource);
    if (identity !== undefined && observed.identity !== identity)
      throw new Error("RESOURCE_IDENTITY_MISMATCH");
    rawReceipts.set(resource.token, raw);
    return { kind: "found", observation: observed };
  };
  const ledger = new AcquisitionLedger(
    {
      owner: plan.owner,
      source: plan.sourceSha256,
      persist: async (entries, failures) => {
        await retainChecked({
          owner: plan.owner,
          sourceSha256: plan.sourceSha256,
          acquisitions: entries,
          acquisitionFailures: failures,
          state: "ACQUIRING",
        });
      },
    },
    {
      create: async (resource) => {
        // Vacancy before create is not proof of absence after an attempted acquisition.
        // Docker create itself arbitrates a concurrent name collision.
        const occupied = await runDocker(
          resource.kind === "container"
            ? [
                "ps",
                "--all",
                "--no-trunc",
                "--filter",
                `name=^/${resource.name}$`,
                "--format",
                "{{.ID}}",
              ]
            : [
                "volume",
                "ls",
                "--filter",
                `name=^${resource.name}$`,
                "--format",
                "{{.Name}}",
              ],
        );
        if (occupied.trim()) throw new Error("RESOURCE_ALREADY_EXISTS");
        if (resource.kind === "volume")
          await runDocker([
            "volume",
            "create",
            "--label",
            `${OWNER_LABEL}=${plan.owner}`,
            "--label",
            `${SOURCE_LABEL}=${plan.sourceSha256}`,
            "--label",
            `${TOKEN_LABEL}=${resource.token}`,
            "--driver=local",
            "--opt=type=tmpfs",
            "--opt=device=tmpfs",
            "--opt=o=size=3g,uid=1000,gid=1000,mode=0700",
            resource.name,
          ]);
        else {
          const stage = (["seed", "preparation", "runtime"] as const).find(
            (key) => plan[key] === resource.name,
          );
          if (!stage) throw new Error("RESOURCE_STAGE_INVALID");
          return (
            await runDocker(containerArguments(plan, stage, resource.token))
          ).trim();
        }
        return undefined;
      },
      inspectByName: (resource) => inspectResource(resource),
      inspectByIdentity: (resource, identity) =>
        inspectResource(resource, identity),
      validateIdentity: (resource, observed) => {
        const raw = rawReceipts.get(resource.token);
        return (
          !!raw &&
          observation(raw, resource).identity === observed.identity &&
          validateObservedResource(plan, approval, resource, raw)
        );
      },
      // No exclusive daemon manager has been independently established. Candidate flags/receipts cannot enable cleanup.
      hasExclusiveManagement: async () => false,
      removeByIdentity: async (resource, identity) => {
        if (resource.kind === "volume")
          throw new Error("EXCLUSIVE_VOLUME_MANAGEMENT_NOT_ESTABLISHED");
        const checked = await inspectResource(resource, identity);
        if (
          checked.kind !== "found" ||
          checked.observation.labels[OWNER_LABEL] !== plan.owner ||
          checked.observation.labels[SOURCE_LABEL] !== plan.sourceSha256 ||
          checked.observation.labels[TOKEN_LABEL] !== resource.token ||
          !validateObservedResource(
            plan,
            approval,
            resource,
            rawReceipts.get(resource.token) ?? {},
          )
        )
          throw new Error("RESOURCE_CLEANUP_UNVERIFIED");
        await docker(["rm", "--force", identity]);
      },
    },
  );
  let acquisitions: AcquisitionCleanupResult;
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const addStage = (
    stage: Stage,
    exitCode: number | null,
    timedOut: boolean,
    discovery: string[] = [],
    results: TestResult[] = [],
    failure?: IsolationFailure,
  ) =>
    stages.push({
      stageId: stage,
      kind: stage === "runtime" ? "tests" : "process",
      sourceHash: plan.sourceSha256,
      migrationHash,
      configFingerprint: approved.configFingerprint,
      process: {
        stageId: stage,
        started: failure?.started ?? true,
        exitCode,
        signal: failure?.terminationSignal ?? null,
        timedOut,
      },
      discoveredTestIds: discovery,
      results,
    });
  try {
    const image = oneObject(await runDocker(["image", "inspect", plan.image]));
    if (
      image.Id !== approval.resolvedImageId ||
      image.Os !== "linux" ||
      image.Architecture !== "amd64" ||
      !Array.isArray(image.RepoDigests) ||
      !image.RepoDigests.includes(plan.image)
    )
      throw new Error("EXECUTED_TOOLCHAIN_MISMATCH");
    const volume = await ledger.acquire("volume", plan.volume, randomUUID());
    if (volume.state !== "CONFIRMED" || ledger.hasAcquisitionFailure())
      throw new Error("RESOURCE_ACQUISITION_UNCERTAIN");
    let seedId: string | null = null;
    for (const stage of ["seed", "preparation", "runtime"] as const) {
      activeStage = stage;
      validateSafetyApproval(plan, files, migrationHash, approval, {
        ...trust,
        now: Date.now(),
      });
      if (interrupted) throw new Error("COORDINATOR_INTERRUPTED");
      const attachmentIds = (
        await runDocker([
          "ps",
          "--all",
          "--no-trunc",
          "--filter",
          `volume=${plan.volume}`,
          "--format",
          "{{.ID}}",
        ])
      )
        .split("\n")
        .filter(Boolean)
        .sort();
      const ownedIds = ledger
        .snapshot()
        .filter((r) => r.kind === "container" && r.identity !== null)
        .map((r) => r.identity)
        .sort();
      if (JSON.stringify(attachmentIds) !== JSON.stringify(ownedIds))
        throw new Error("FOREIGN_VOLUME_ATTACHMENT");
      const child = await ledger.acquire(
        "container",
        plan[stage],
        randomUUID(),
      );
      if (
        child.state !== "CONFIRMED" ||
        child.identity === null ||
        ledger.hasAcquisitionFailure()
      )
        throw new Error("RESOURCE_ACQUISITION_UNCERTAIN");
      await runDocker(["start", child.identity]);
      if (stage === "seed") {
        seedId = child.identity;
        await transferSnapshot(archive, child.identity, abort.signal);
        await runDocker([
          "exec",
          child.identity,
          "/usr/bin/env",
          "-i",
          ...environment,
          `D5_SOURCE_SHA256=${plan.sourceSha256}`,
          "node",
          "--input-type=module",
          "-e",
          VERIFY_SOURCE,
        ]);
        addStage(stage, 0, false);
      } else if (stage === "preparation") {
        // Source is kernel read-only; only the three explicitly mounted dependency subpaths are writable.
        await runDocker(
          [
            "exec",
            child.identity,
            "/usr/bin/env",
            "-i",
            ...environment,
            `D5_SOURCE_SHA256=${plan.sourceSha256}`,
            "/usr/bin/timeout",
            "--kill-after=5",
            "600",
            "/bin/sh",
            "-ceu",
            `node --input-type=module -e '${VERIFY_SOURCE}'; ` +
              'test "$(node --version)" = v24.21.0; test "$(pnpm --version)" = 11.19.0; ' +
              "cp -R /opt/pnpm-store /scratch/store; pnpm install --offline --frozen-lockfile --ignore-scripts --store-dir /scratch/store",
          ],
          620_000,
        );
        addStage(stage, 0, false);
        await runDocker(["stop", child.identity]);
      } else {
        if (!seedId) throw new Error("SEED_RECEIPT_MISSING");
        await runDocker(["stop", seedId]);
        const exit = await runDocker(["wait", child.identity], 920_000);
        const exitCode = /^\d+$/.test(exit) ? Number(exit) : null;
        const stageIndex = stages.length;
        addStage(stage, exitCode, exitCode === 124);
        const records = (await runDocker(["logs", child.identity]))
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as unknown);
        if (records.length !== 2)
          throw new Error("TEST_EXECUTION_RECEIPT_MISSING");
        const discovery = parseTestReceipt(records[0]);
        const actual = parseTestReceipt(records[1]);
        if (
          JSON.stringify(discovery.discoveredTestIds) !==
          JSON.stringify(actual.discoveredTestIds)
        )
          throw new Error("TEST_DISCOVERY_MISMATCH");
        const observedStage = stages[stageIndex];
        if (!observedStage) throw new Error("PROCESS_RECEIPT_MISSING");
        stages[stageIndex] = {
          ...observedStage,
          discoveredTestIds: actual.discoveredTestIds,
          results: actual.results,
        };
        if (exitCode !== 0) throw new Error("CHILD_PROCESS_FAILED");
      }
    }
  } catch (error) {
    failureStage = activeStage;
    if (
      error instanceof IsolationFailure &&
      activeStage !== "PREFLIGHT" &&
      !stages.some((stage) => stage.stageId === activeStage)
    )
      addStage(activeStage, error.exitCode, error.timedOut, [], [], error);
  } finally {
    acquisitions = await ledger.cleanup();
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
  const receipt: RunnerReceipt = {
    owner: plan.owner,
    sourceSha256: plan.sourceSha256,
    stages,
    cleanup: acquisitions.status,
    acquisitions,
    acquisitionFailures: ledger.failures(),
    exitCode: 1,
    failureStage,
    evidenceErrors: [],
  };
  try {
    const artifact = await retainChecked({
      owner: plan.owner,
      sourceSha256: plan.sourceSha256,
      acquisitions: acquisitions.entries,
      acquisitionFailures: ledger.failures(),
      state: "VALIDATING",
      receipt,
    });
    const bundle: EvidenceInput = {
      expectedStageIds: ["seed", "preparation", "runtime"],
      stages,
      ownership: {
        owner: plan.owner,
        acquired: acquisitions.entries.some((entry) => entry.identity !== null),
      },
      cleanup: {
        owner: plan.owner,
        completed: acquisitions.status === "COMPLETE",
        retainedArtifactsRemoved: acquisitions.status === "COMPLETE",
      },
      fault: { owner: plan.owner, injected: false, faultCode: "NOT_REQUESTED" },
      artifacts: [artifact],
      limitations: [
        "NO_LIVE_DATABASE",
        "NO_AUTHORITY_CHANGE",
        "NO_BROWSER_STATE_EXPORT",
        "NO_SCREENSHOT_OR_TRACE",
      ],
    };
    const validation = validateEvidence(bundle, "/parent-evidence", {
      configFingerprint: approved.configFingerprint,
      stageHashes: Object.fromEntries(
        ["seed", "preparation", "runtime"].map((id) => [
          id,
          { sourceHash: plan.sourceSha256, migrationHash },
        ]),
      ),
      stageKinds: { seed: "process", preparation: "process", runtime: "tests" },
      requiredTestIdsByStage: {
        seed: [],
        preparation: [],
        runtime: approved.requiredTestIds,
      },
    });
    receipt.evidenceErrors = validation.errors;
    receipt.exitCode =
      validation.success &&
      failureStage === null &&
      !interrupted &&
      !ledger.hasAcquisitionFailure()
        ? 0
        : 1;
    await retainChecked({
      owner: plan.owner,
      sourceSha256: plan.sourceSha256,
      acquisitions: acquisitions.entries,
      acquisitionFailures: ledger.failures(),
      state: "FINISHED",
      receipt,
    });
  } catch {
    receipt.exitCode = 1;
    receipt.failureStage ??= "EVIDENCE_RETENTION";
  }
  return receipt;
}

async function transferSnapshot(
  archive: Buffer,
  container: string,
  signal: AbortSignal,
): Promise<void> {
  // Only captured approved bytes enter this process; the original checkout is never reopened by tar.
  const child = spawn(
    "docker",
    [
      "--host",
      ENDPOINT,
      "exec",
      "-i",
      container,
      "tar",
      "--no-same-owner",
      "-xf",
      "-",
      "-C",
      "/workspace",
    ],
    { env: CLEAN_ENV, stdio: ["pipe", "ignore", "ignore"], signal },
  );
  const timer = setTimeout(() => child.kill(), 30_000);
  try {
    const closed = new Promise<number>((resolve) => {
      child.once("error", () => resolve(1));
      child.once("close", (code) => resolve(code ?? 1));
    });
    child.stdin.on("error", () => child.kill());
    child.stdin.end(archive);
    if ((await closed) !== 0)
      throw new Error("SOURCE_SNAPSHOT_TRANSFER_FAILED");
  } finally {
    clearTimeout(timer);
    child.kill();
  }
}
function parseTestReceipt(value: unknown): {
  discoveredTestIds: string[];
  results: TestResult[];
} {
  if (
    !value ||
    typeof value !== "object" ||
    !("discoveredTestIds" in value) ||
    !("results" in value) ||
    !Array.isArray(value.discoveredTestIds) ||
    !Array.isArray(value.results) ||
    Object.keys(value).length !== 2 ||
    !value.discoveredTestIds.every(
      (id) => typeof id === "string" && /^[a-f0-9]{64}$/.test(id),
    ) ||
    !value.results.every(
      (result) =>
        result &&
        typeof result === "object" &&
        Object.keys(result).length === 2 &&
        typeof result.id === "string" &&
        /^[a-f0-9]{64}$/.test(result.id) &&
        ["PASS", "FAIL", "SKIP", "NOT_RUN"].includes(result.status),
    )
  )
    throw new Error("TEST_EXECUTION_RECEIPT_INVALID");
  return { discoveredTestIds: value.discoveredTestIds, results: value.results };
}
