import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AcquisitionLedger,
  type AcquisitionAdapter,
  type AcquisitionObservation,
  type AcquisitionFailure,
  type AcquisitionResource,
  AcquisitionCreateFailure,
  type Inspection,
} from "./acquisition-contract.mts";

const OWNER = "owner-1";
const SOURCE = "source-1";
const TOKEN = "random-token-1";
const ID = "immutable-resource-id";

function observation(
  overrides: Partial<AcquisitionObservation> = {},
): AcquisitionObservation {
  return {
    identity: ID,
    labels: {
      "stockwise.d5.owner": OWNER,
      "stockwise.d5.source": SOURCE,
      "stockwise.d5.acquisition-token": TOKEN,
    },
    creationIdentity: "volume-created-at-identity",
    ...overrides,
  };
}

function harness(
  options: Readonly<{
    createError?: boolean;
    initialInspection?: Inspection;
    inspectErrorCount?: number;
    removeErrorCount?: number;
    remainsAfterRemove?: boolean;
    found?: AcquisitionObservation;
    authority?: boolean;
    persistErrorAt?: number;
  }> = {},
) {
  let live: AcquisitionObservation | null = options.found ?? null;
  let inspected = 0;
  let removed = 0;
  let created = 0;
  let saved = 0;
  const removedNames: string[] = [];
  const persistedFailures: AcquisitionFailure[][] = [];
  const adapter: AcquisitionAdapter = {
    async create(): Promise<string | void> {
      created++;
      live = options.found ?? observation();
      if (options.createError) throw new Error("raw lost create response");
      return undefined;
    },
    async inspectByName(): Promise<Inspection> {
      inspected++;
      if (inspected <= (options.inspectErrorCount ?? 0))
        throw new Error("raw inspect failure");
      if (options.initialInspection && inspected === 1)
        return options.initialInspection;
      return live ? { kind: "found", observation: live } : { kind: "absent" };
    },
    async inspectByIdentity(): Promise<Inspection> {
      inspected++;
      if (inspected <= (options.inspectErrorCount ?? 0))
        throw new Error("raw inspect failure");
      return live ? { kind: "found", observation: live } : { kind: "absent" };
    },
    validateIdentity(resource, inspectedResource) {
      return resource.kind === "container"
        ? /^[a-f0-9]{64}$/i.test(inspectedResource.identity)
        : inspectedResource.identity === ID &&
            inspectedResource.creationIdentity === "volume-created-at-identity";
    },
    async removeByIdentity(resource) {
      removedNames.push(resource.name);
      removed++;
      if (removed <= (options.removeErrorCount ?? 0))
        throw new Error("raw remove failure");
      if (!options.remainsAfterRemove) live = null;
    },
    async hasExclusiveManagement() {
      return options.authority !== false;
    },
  };
  const ledger = new AcquisitionLedger(
    {
      owner: OWNER,
      source: SOURCE,
      async persist(_entries, failures) {
        saved++;
        persistedFailures.push(failures.map((failure) => ({ ...failure })));
        if (saved === options.persistErrorAt)
          throw new Error("raw persistence failure");
      },
    },
    adapter,
  );
  return {
    ledger,
    adapter,
    counts: () => ({ created, inspected, removed, saved }),
    removedNames,
    persistedFailures,
    setLive: (next: AcquisitionObservation | null) => {
      live = next;
    },
  };
}

async function acquire(
  h: ReturnType<typeof harness>,
): Promise<AcquisitionResource> {
  return h.ledger.acquire("volume", "db-volume", TOKEN);
}

test("records intent before create and confirms exact observed identity on success", async () => {
  const h = harness();
  const resource = await acquire(h);
  assert.equal(resource.state, "CONFIRMED");
  assert.equal(resource.identity, ID);
  assert.deepEqual(h.counts().created, 1);
  const result = await h.ledger.cleanup();
  assert.equal(result.status, "COMPLETE");
  assert.equal(result.entries[0]?.state, "REMOVED");
  assert.equal(result.entries[0]?.identity, ID);
});

test("retains a sanitized create failure identity after successful reconciliation and cleanup", async () => {
  const h = harness({ createError: true });
  const resource = await acquire(h);
  assert.equal(resource.state, "CONFIRMED");
  assert.deepEqual(h.ledger.failures(), [
    { name: "db-volume", reason: "CREATE_FAILED", identity: ID },
  ]);
  assert.equal(h.ledger.hasAcquisitionFailure(), true);
  const cleanup = await h.ledger.cleanup();
  assert.equal(cleanup.status, "COMPLETE");
  assert.equal(h.ledger.failures()[0]?.identity, ID);
  assert.equal(
    h.persistedFailures[h.persistedFailures.length - 1]?.[0]?.identity,
    ID,
  );
});

test("cleans resources in reverse acquisition order", async () => {
  const live = new Map<string, AcquisitionObservation>();
  const removed: string[] = [];
  const adapter: AcquisitionAdapter = {
    async create(resource): Promise<string | void> {
      const identity =
        resource.kind === "container" ? "c".repeat(64) : `id-${resource.name}`;
      live.set(
        resource.name,
        observation({
          identity,
          creationIdentity:
            resource.kind === "volume" ? `created-${resource.name}` : null,
          labels: {
            "stockwise.d5.owner": OWNER,
            "stockwise.d5.source": SOURCE,
            "stockwise.d5.acquisition-token": resource.token,
          },
        }),
      );
      return resource.kind === "container" ? identity : undefined;
    },
    async inspectByName(resource) {
      const found = live.get(resource.name);
      return found ? { kind: "found", observation: found } : { kind: "absent" };
    },
    async inspectByIdentity(resource, identity) {
      const found = live.get(resource.name);
      return found?.identity === identity
        ? { kind: "found", observation: found }
        : { kind: "absent" };
    },
    validateIdentity(resource, found) {
      return (
        found.identity ===
        (resource.kind === "container" ? "c".repeat(64) : `id-${resource.name}`)
      );
    },
    async removeByIdentity(resource, identity) {
      assert.equal(
        identity,
        resource.kind === "container" ? "c".repeat(64) : `id-${resource.name}`,
      );
      removed.push(resource.name);
      live.delete(resource.name);
    },
    async hasExclusiveManagement() {
      return true;
    },
  };
  const ledger = new AcquisitionLedger(
    { owner: OWNER, source: SOURCE, async persist() {} },
    adapter,
  );
  await ledger.acquire("volume", "volume", "volume-token");
  await ledger.acquire("container", "container", "container-token");
  assert.equal((await ledger.cleanup()).status, "COMPLETE");
  assert.deepEqual(removed, ["container", "volume"]);
});

test("keeps unresolved create uncertain on inspection failure and retries cleanup only boundedly", async () => {
  const h = harness({ inspectErrorCount: 8 });
  const resource = await acquire(h);
  assert.equal(resource.state, "UNCERTAIN");
  const result = await h.ledger.cleanup();
  assert.equal(result.status, "INCOMPLETE");
  assert.equal(h.counts().created, 1);
  assert.ok(h.counts().inspected <= 6);
  assert.equal(
    result.reasons.some(({ reason }) => reason === "INSPECTION_FAILED"),
    true,
  );
});

test("does not adopt foreign labels or delete by name", async () => {
  const foreign = observation({
    labels: { ...observation().labels, "stockwise.d5.owner": "other-owner" },
  });
  const h = harness({ found: foreign });
  const resource = await acquire(h);
  assert.equal(resource.state, "UNCERTAIN");
  const result = await h.ledger.cleanup();
  assert.equal(result.status, "INCOMPLETE");
  assert.equal(result.entries[0]?.state, "RETAINED");
  assert.equal(h.counts().removed, 0);
});

test("does not downgrade a confirmed identity when an inspection reports a replacement", async () => {
  const h = harness();
  assert.equal((await acquire(h)).state, "CONFIRMED");
  h.setLive(observation({ identity: "replacement-id" }));
  const result = await h.ledger.cleanup();
  assert.equal(result.status, "INCOMPLETE");
  assert.equal(result.entries[0]?.state, "CONFIRMED");
  assert.equal(result.entries[0]?.identity, ID);
  assert.equal(h.counts().removed, 0);
  assert.equal(
    result.reasons.some(({ reason }) => reason === "IDENTITY_MISMATCH"),
    true,
  );
});

test("retains an unremoved resource after bounded cleanup failure", async () => {
  const h = harness({ removeErrorCount: 2 });
  await acquire(h);
  const result = await h.ledger.cleanup();
  assert.equal(result.status, "INCOMPLETE");
  assert.equal(result.entries[0]?.state, "CONFIRMED");
  assert.equal(h.counts().removed, 2);
  assert.equal(
    result.reasons.some(({ reason }) => reason === "REMOVE_FAILED"),
    true,
  );
});

test("requires successful positive absence after idempotent removal", async () => {
  const h = harness({ remainsAfterRemove: true });
  await acquire(h);
  const result = await h.ledger.cleanup();
  assert.equal(result.status, "INCOMPLETE");
  assert.equal(result.entries[0]?.state, "CONFIRMED");
  assert.equal(
    result.reasons.some(({ reason }) => reason === "REMOVE_FAILED"),
    true,
  );
});

test("positive absence reconciles uncertain resources and restored untouched intents complete safely", async () => {
  const h = harness({ inspectErrorCount: 2 });
  const resource = await acquire(h);
  assert.equal(resource.state, "UNCERTAIN");
  const interrupted = new AcquisitionLedger(
    { owner: OWNER, source: SOURCE, async persist() {} },
    h.adapter,
  );
  interrupted.restore([resource]);
  assert.equal((await interrupted.cleanup()).status, "COMPLETE");
  assert.equal(interrupted.snapshot()[0]?.state, "REMOVED");

  const untouched = new AcquisitionLedger(
    { owner: OWNER, source: SOURCE, async persist() {} },
    h.adapter,
  );
  untouched.restore([
    {
      kind: "volume",
      name: "unused-volume",
      token: TOKEN,
      state: "INTENT",
      identity: null,
    },
  ]);
  assert.equal((await untouched.cleanup()).status, "COMPLETE");
});

test("persistence failure preserves in-memory uncertainty and prevents complete cleanup", async () => {
  const h = harness({ persistErrorAt: 2 });
  const resource = await acquire(h);
  assert.equal(resource.state, "UNCERTAIN");
  assert.equal(h.counts().created, 0);

  const result = await h.ledger.cleanup();
  assert.equal(result.status, "INCOMPLETE");
  assert.equal(result.entries[0]?.state, "REMOVED");
  assert.equal(
    result.reasons.some(({ reason }) => reason === "PERSISTENCE_FAILED"),
    true,
  );
});

test("unknown container ID keeps a token candidate as an uncertain hint, never a deletion identity", async () => {
  const candidate = observation({ identity: "a".repeat(64) });
  const h = harness({ found: candidate });
  const resource = await h.ledger.acquire("container", "db-container", TOKEN);
  assert.equal(resource.state, "UNCERTAIN");
  assert.equal(resource.identity, null);
  assert.deepEqual(resource.candidateIdentities, [candidate.identity]);
  const cleanup = await h.ledger.cleanup();
  assert.equal(cleanup.status, "INCOMPLETE");
  assert.equal(cleanup.entries[0]?.state, "UNCERTAIN");
  assert.deepEqual(cleanup.entries[0]?.candidateIdentities, [
    candidate.identity,
  ]);
  assert.equal(h.counts().removed, 0);
});

test("create stdout full immutable ID is persisted before inspection", async () => {
  const createId = "c".repeat(64);
  const order: string[] = [];
  const found = observation({ identity: createId });
  const adapter: AcquisitionAdapter = {
    async create() {
      order.push("create");
      return ` ${createId} \n`;
    },
    async inspectByName() {
      order.push("inspect");
      return { kind: "found", observation: found };
    },
    async inspectByIdentity(_resource, identity) {
      order.push("inspect-id");
      assert.equal(identity, createId);
      return { kind: "found", observation: found };
    },
    validateIdentity(_resource, observed) {
      return observed.identity === createId;
    },
    async hasExclusiveManagement() {
      return false;
    },
    async removeByIdentity() {
      assert.fail("must not remove without authority");
    },
  };
  const ledger = new AcquisitionLedger(
    {
      owner: OWNER,
      source: SOURCE,
      async persist(entries) {
        const entry = entries[0];
        if (entry?.identity === createId) order.push("persist-id");
      },
    },
    adapter,
  );
  const resource = await ledger.acquire("container", "db-container", TOKEN);
  assert.equal(resource.state, "CONFIRMED");
  assert.equal(resource.identity, createId);
  assert.ok(order.indexOf("persist-id") < order.indexOf("inspect-id"));
});

test("lost create response preserves its validated immutable ID as a separate failure", async () => {
  const createId = "d".repeat(64);
  const adapter: AcquisitionAdapter = {
    async create() {
      throw new AcquisitionCreateFailure("create command failed", createId);
    },
    async inspectByName() {
      return {
        kind: "found",
        observation: observation({ identity: createId }),
      };
    },
    async inspectByIdentity(_resource, identity) {
      return identity === createId
        ? { kind: "found", observation: observation({ identity: createId }) }
        : { kind: "absent" };
    },
    validateIdentity(_resource, observed) {
      return observed.identity === createId;
    },
    async hasExclusiveManagement() {
      return false;
    },
    async removeByIdentity() {
      assert.fail("must not remove without authority");
    },
  };
  const ledger = new AcquisitionLedger(
    { owner: OWNER, source: SOURCE, async persist() {} },
    adapter,
  );
  const resource = await ledger.acquire("container", "db-container", TOKEN);
  assert.equal(resource.identity, createId);
  assert.equal(resource.state, "CONFIRMED");
  assert.deepEqual(ledger.failures(), [
    { name: "db-container", reason: "CREATE_FAILED", identity: createId },
  ]);
});

test("volume without independent management authority remains retained and is never removed", async () => {
  const h = harness({ authority: false });
  await acquire(h);
  const result = await h.ledger.cleanup();
  assert.equal(result.status, "INCOMPLETE");
  assert.equal(result.entries[0]?.state, "CONFIRMED");
  assert.equal(
    result.reasons.some(
      ({ reason }) => reason === "EXCLUSIVE_AUTHORITY_MISSING",
    ),
    true,
  );
  assert.equal(h.counts().removed, 0);
});

test("restored stale removed receipt without identity is reopened as uncertain", async () => {
  const h = harness();
  const restored = new AcquisitionLedger(
    { owner: OWNER, source: SOURCE, async persist() {} },
    h.adapter,
  );
  restored.restore([
    {
      kind: "container",
      name: "db-container",
      token: TOKEN,
      state: "REMOVED",
      identity: null,
    },
  ]);
  const result = await restored.cleanup();
  assert.equal(result.status, "INCOMPLETE");
  assert.equal(result.entries[0]?.state, "UNCERTAIN");
  assert.equal(result.entries[0]?.identity, null);
});

test("restored removed receipt with immutable ID still needs exclusive authority", async () => {
  const h = harness({ authority: false });
  h.setLive(null);
  const restored = new AcquisitionLedger(
    { owner: OWNER, source: SOURCE, async persist() {} },
    h.adapter,
  );
  restored.restore([
    {
      kind: "container",
      name: "db-container",
      token: TOKEN,
      state: "REMOVED",
      identity: "f".repeat(64),
    },
  ]);
  const result = await restored.cleanup();
  assert.equal(result.status, "INCOMPLETE");
  assert.equal(result.entries[0]?.state, "UNCERTAIN");
  assert.equal(result.entries[0]?.identity, "f".repeat(64));
  assert.equal(h.counts().removed, 0);
});

test("delayed container visibility after create is not treated as positive absence", async () => {
  const createId = "e".repeat(64);
  let probes = 0;
  let removed = 0;
  const observed = observation({ identity: createId });
  const adapter: AcquisitionAdapter = {
    async create() {
      return createId;
    },
    async inspectByName(): Promise<Inspection> {
      return probes > 2
        ? { kind: "found", observation: observed }
        : { kind: "absent" };
    },
    async inspectByIdentity(): Promise<Inspection> {
      probes++;
      return probes > 2
        ? { kind: "found", observation: observed }
        : { kind: "absent" };
    },
    validateIdentity(_resource, item) {
      return item.identity === createId;
    },
    async hasExclusiveManagement() {
      return false;
    },
    async removeByIdentity() {
      removed++;
    },
  };
  const ledger = new AcquisitionLedger(
    { owner: OWNER, source: SOURCE, async persist() {} },
    adapter,
  );
  const acquired = await ledger.acquire(
    "container",
    "delayed-container",
    TOKEN,
  );
  assert.equal(acquired.state, "UNCERTAIN");
  assert.equal(acquired.identity, createId);
  assert.equal(ledger.snapshot()[0]?.state, "UNCERTAIN");
  const cleanup = await ledger.cleanup();
  assert.equal(cleanup.status, "INCOMPLETE");
  assert.equal(cleanup.entries[0]?.state, "CONFIRMED");
  assert.equal(removed, 0);
});

test("candidate identity hints are copied across restore and snapshot boundaries", () => {
  const candidates = ["a".repeat(64)];
  const ledger = new AcquisitionLedger(
    { owner: OWNER, source: SOURCE, async persist() {} },
    harness().adapter,
  );
  ledger.restore([
    {
      kind: "container",
      name: "db-container",
      token: TOKEN,
      state: "UNCERTAIN",
      identity: null,
      candidateIdentities: candidates,
    },
  ]);
  candidates[0] = "b".repeat(64);
  assert.equal(ledger.snapshot()[0]?.candidateIdentities?.[0], "a".repeat(64));
  const exported = ledger.snapshot()[0]?.candidateIdentities;
  assert.ok(exported);
  Reflect.set(exported, 0, "c".repeat(64));
  assert.equal(ledger.snapshot()[0]?.candidateIdentities?.[0], "a".repeat(64));
});
