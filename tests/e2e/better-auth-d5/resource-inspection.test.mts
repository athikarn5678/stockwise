import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AcquisitionLedger,
  type AcquisitionAdapter,
  type AcquisitionObservation,
  type Inspection,
} from "./acquisition-contract.mts";
import type { AcquisitionResource } from "./acquisition-contract.mts";
import { inspectResourceIdentity } from "./resource-inspection.mts";

const ID = "a".repeat(64);
const OTHER = "b".repeat(64);
const resource: AcquisitionResource = {
  kind: "container",
  name: "stockwise-test",
  token: "token",
  state: "CONFIRMED",
  identity: ID,
};

type Container = {
  Id: string;
  Name: string;
  Config: { Labels: Record<string, string> };
};
function container(
  id: string,
  name = "/stockwise-test",
  labels: Record<string, string> = {
    owner: "o",
    "stockwise.d5.acquisition-token": "token",
  },
): Container {
  return { Id: id, Name: name, Config: { Labels: labels } };
}
function dockerHarness(
  options: Readonly<{
    ids?: string[];
    named?: string[];
    tokens?: string[];
    inspect?: Map<string, Container>;
    inspectSequence?: Container[];
    fail?: string;
  }> = {},
) {
  const calls: string[][] = [];
  const ids = options.ids ?? [ID];
  const named = options.named ?? [ID];
  const inspectSequence = options.inspectSequence;
  let inspectedCount = 0;
  const found = options.inspect ?? new Map([[ID, container(ID)]]);
  const tokens = options.tokens ?? [ID];
  const docker = async (args: string[]): Promise<string> => {
    calls.push(args);
    const key =
      args[0] === "ps" && args.at(-1) === "{{.ID}}"
        ? args.includes("--filter") &&
          args.some((arg) => arg.startsWith("label="))
          ? "tokens"
          : args.includes("--filter")
            ? "named"
            : "ids"
        : args[0] === "container" && args[1] === "inspect"
          ? `inspect:${args[2]}`
          : "";
    if (options.fail === key) throw new Error("command failed");
    if (key === "ids") return ids.join("\n");
    if (key === "named") return named.join("\n");
    if (key === "tokens") return tokens.join("\n");
    if (key.startsWith("inspect:")) {
      const value =
        inspectSequence?.[inspectedCount++] ?? found.get(args[2] ?? "");
      if (!value) throw new Error("missing inspect");
      return JSON.stringify([value]);
    }
    throw new Error("unexpected Docker command");
  };
  return { docker, calls };
}

function dockerForRecords(
  records: Container[],
  failOn?: "ids" | "named" | "tokens",
): (args: string[]) => Promise<string> {
  return async (args) => {
    if (args[0] === "ps") {
      const filter = args.find(
        (arg) => arg.startsWith("name=^/") || arg.startsWith("label="),
      );
      const kind = !filter
        ? "ids"
        : filter.startsWith("name=")
          ? "named"
          : "tokens";
      if (failOn === kind) throw new Error("daemon unavailable");
      const matching = !filter
        ? records
        : filter.startsWith("name=")
          ? records.filter(
              (item) => item.Name === filter.slice("name=^".length, -1),
            )
          : records.filter(
              (item) =>
                item.Config.Labels[
                  filter.slice("label=".length).split("=")[0] ?? ""
                ] ===
                filter.slice("label=".length).split("=").slice(1).join("="),
            );
      return matching.map((item) => item.Id).join("\n");
    }
    if (args[0] === "container" && args[1] === "inspect") {
      const item = records.find((record) => record.Id === args[2]);
      if (!item) throw new Error("missing inspect");
      return JSON.stringify([item]);
    }
    throw new Error("unexpected Docker command");
  };
}

function inspectedLabels(raw: Record<string, unknown>): Record<string, string> {
  const config = raw.Config;
  if (!config || typeof config !== "object" || Array.isArray(config))
    throw new Error("invalid container config");
  const labels = "Labels" in config ? config.Labels : undefined;
  if (!labels || typeof labels !== "object" || Array.isArray(labels))
    throw new Error("invalid container labels");
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels)) {
    if (typeof value !== "string") throw new Error("invalid container label");
    output[key] = value;
  }
  return output;
}

function dockerAdapter(
  records: Container[],
  create: () => Promise<void | string>,
  failOn?: "ids" | "named" | "tokens",
  hasAuthority = false,
) {
  const docker = dockerForRecords(records, failOn);
  const inspect = async (
    entry: AcquisitionResource,
    identity?: string,
  ): Promise<Inspection> => {
    const found = await inspectResourceIdentity(entry, identity, docker);
    if (!found) return { kind: "absent" };
    return {
      kind: "found",
      observation: {
        identity: String(found.Id),
        labels: inspectedLabels(found),
        creationIdentity: null,
      },
    };
  };
  const adapter: AcquisitionAdapter = {
    create,
    async inspectByName(entry) {
      return inspect(entry);
    },
    async inspectByIdentity(entry, identity) {
      return inspect(entry, identity);
    },
    validateIdentity(_entry, observed) {
      return /^[a-f0-9]{64}$/i.test(observed.identity);
    },
    async hasExclusiveManagement() {
      return hasAuthority;
    },
    async removeByIdentity() {
      assert.fail("Docker helper fixture must not remove resources");
    },
  };
  return adapter;
}

test("independently inspects recorded ID and expected-name ID when both agree", async () => {
  const h = dockerHarness();
  const result = await inspectResourceIdentity(resource, ID, h.docker);
  assert.equal(result?.Id, ID);
  assert.ok(h.calls.some((args) => args[0] === "container" && args[2] === ID));
  assert.deepEqual(
    h.calls.slice(0, 3).map((args) => args[0]),
    ["ps", "container", "ps"],
  );
});

test("new uncertain resource discovers and returns actual immutable ID by expected name", async () => {
  const h = dockerHarness();
  const result = await inspectResourceIdentity(
    { ...resource, identity: null, state: "UNCERTAIN" },
    undefined,
    h.docker,
  );
  assert.equal(result?.Id, ID);
  assert.equal(h.calls.filter((args) => args[0] === "container").length, 2);
});
test("recorded ID present while expected name is absent is a conflict", async () => {
  const h = dockerHarness({ named: [] });
  await assert.rejects(
    inspectResourceIdentity(resource, ID, h.docker),
    /RESOURCE_IDENTITY_CONFLICT/,
  );
});

test("renamed recorded ID is a conflict", async () => {
  const h = dockerHarness({
    inspect: new Map([[ID, container(ID, "/renamed")]]),
  });
  await assert.rejects(
    inspectResourceIdentity(resource, ID, h.docker),
    /RESOURCE_IDENTITY_CONFLICT/,
  );
});

test("replacement occupying expected name conflicts with positively inventoried missing ID", async () => {
  const h = dockerHarness({
    ids: [OTHER],
    named: [OTHER],
    inspect: new Map([[OTHER, container(OTHER)]]),
  });
  await assert.rejects(
    inspectResourceIdentity(resource, ID, h.docker),
    /RESOURCE_IDENTITY_CONFLICT/,
  );
});

test("replacement name cannot authorize deletion while recorded immutable ID still exists", async () => {
  const h = dockerHarness({
    ids: [ID, OTHER],
    named: [OTHER],
    inspect: new Map([
      [ID, container(ID)],
      [OTHER, container(OTHER)],
    ]),
  });
  await assert.rejects(
    inspectResourceIdentity(resource, ID, h.docker),
    /RESOURCE_IDENTITY_CONFLICT/,
  );
});

test("ID, name, and token inventory errors propagate rather than imply absence", async () => {
  const failedId = dockerHarness({ fail: `inspect:${ID}` });
  await assert.rejects(
    inspectResourceIdentity(resource, ID, failedId.docker),
    /command failed/,
  );
  const failedName = dockerHarness({ fail: "named" });
  await assert.rejects(
    inspectResourceIdentity(resource, ID, failedName.docker),
    /command failed/,
  );
  const failedToken = dockerHarness({ fail: "tokens" });
  await assert.rejects(
    inspectResourceIdentity(resource, ID, failedToken.docker),
    /command failed/,
  );
});

test("independent token inventory must also be clear to report recorded absence", async () => {
  const h = dockerHarness({ ids: [], named: [], tokens: [] });
  assert.equal(await inspectResourceIdentity(resource, ID, h.docker), null);
  assert.equal(
    h.calls.some((args) => args[0] === "container"),
    false,
  );
});

test("unknown identity with no name or token candidate is not reported absent", async () => {
  const h = dockerHarness({ ids: [], named: [], tokens: [] });
  await assert.rejects(
    inspectResourceIdentity(
      { ...resource, identity: null, state: "UNCERTAIN" },
      undefined,
      h.docker,
    ),
    /RESOURCE_UNKNOWN_ID_ABSENCE/,
  );
});

test("token candidate is independently inspected even when exact name inventory is empty", async () => {
  const h = dockerHarness({ named: [], tokens: [ID] });
  await assert.rejects(
    inspectResourceIdentity(
      { ...resource, identity: null },
      undefined,
      h.docker,
    ),
    /RESOURCE_IDENTITY_CONFLICT/,
  );
  assert.ok(
    h.calls.some((args) =>
      args.some((arg) => arg === "label=stockwise.d5.acquisition-token=token"),
    ),
  );
  assert.ok(
    h.calls.some(
      (args) =>
        args[0] === "container" && args[1] === "inspect" && args[2] === ID,
    ),
  );
});

test("multiple token candidates cannot establish one identity", async () => {
  const h = dockerHarness({
    ids: [ID, OTHER],
    named: [ID],
    tokens: [ID, OTHER],
    inspect: new Map([
      [ID, container(ID)],
      [OTHER, container(OTHER)],
    ]),
  });
  await assert.rejects(
    inspectResourceIdentity(
      { ...resource, identity: null },
      undefined,
      h.docker,
    ),
    /RESOURCE_IDENTITY_CONFLICT/,
  );
});

test("mismatched labels across independent probes are a conflict", async () => {
  const h = dockerHarness({
    inspectSequence: [
      container(ID),
      container(ID, "/stockwise-test", { owner: "different" }),
    ],
  });
  await assert.rejects(
    inspectResourceIdentity(resource, ID, h.docker),
    /RESOURCE_IDENTITY_CONFLICT/,
  );
});
test("ledger keeps renamed resource and never removes by stale identity", async () => {
  const labels = {
    "stockwise.d5.owner": "owner",
    "stockwise.d5.source": "source",
    "stockwise.d5.acquisition-token": "token",
  };
  let live: Container | null = null;
  let removes = 0;
  const calls: string[][] = [];
  const docker = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "ps") {
      if (!live) return "";
      if (!args.includes("--filter")) return live.Id;
      const filter = args.find(
        (arg) => arg.startsWith("name=^/") || arg.startsWith("label="),
      );
      if (filter?.startsWith("name="))
        return live.Name === "/stockwise-test" ? live.Id : "";
      if (filter?.startsWith("label=")) {
        const [name, ...value] = filter.slice("label=".length).split("=");
        return live.Config.Labels[name ?? ""] === value.join("=")
          ? live.Id
          : "";
      }
      return "";
    }
    if (
      args[0] === "container" &&
      args[1] === "inspect" &&
      live?.Id === args[2]
    )
      return JSON.stringify([live]);
    throw new Error("unexpected Docker command");
  };
  const adapter: AcquisitionAdapter = {
    async create() {
      live = container(ID, "/stockwise-test", labels);
      return ID;
    },
    async inspectByName(entry): Promise<Inspection> {
      const found = await inspectResourceIdentity(entry, undefined, docker);
      if (!found) return { kind: "absent" };
      return {
        kind: "found",
        observation: {
          identity: String(found.Id),
          labels: labels,
          creationIdentity: null,
        },
      };
    },
    async inspectByIdentity(entry, identity): Promise<Inspection> {
      const found = await inspectResourceIdentity(entry, identity, docker);
      if (!found) return { kind: "absent" };
      return {
        kind: "found",
        observation: {
          identity: String(found.Id),
          labels,
          creationIdentity: null,
        },
      };
    },
    validateIdentity(_entry, observed: AcquisitionObservation) {
      return observed.identity === ID;
    },
    async removeByIdentity() {
      removes++;
      live = null;
    },
  };
  const ledger = new AcquisitionLedger(
    { owner: "owner", source: "source", async persist() {} },
    adapter,
  );
  const acquired = await ledger.acquire("container", "stockwise-test", "token");
  assert.equal(acquired.state, "CONFIRMED");
  live = container(ID, "/renamed", labels);
  const result = await ledger.cleanup();
  assert.equal(result.status, "INCOMPLETE");
  assert.equal(result.entries[0]?.identity, ID);
  assert.equal(removes, 0);
  assert.ok(
    calls.some((args) =>
      args.some((arg) => arg === "label=stockwise.d5.acquisition-token=token"),
    ),
  );
});

test("unknown token candidate with foreign ownership labels is not adopted by the ledger", async () => {
  const labels = {
    "stockwise.d5.owner": "other-owner",
    "stockwise.d5.source": "source",
    "stockwise.d5.acquisition-token": "token",
  };
  const candidate = { identity: ID, labels, creationIdentity: null };
  let removed = 0;
  const adapter: AcquisitionAdapter = {
    async create() {},
    async inspectByName(): Promise<Inspection> {
      return { kind: "found", observation: candidate };
    },
    async inspectByIdentity(): Promise<Inspection> {
      return { kind: "found", observation: candidate };
    },
    validateIdentity() {
      return true;
    },
    async hasExclusiveManagement() {
      return true;
    },
    async removeByIdentity() {
      removed++;
    },
  };
  const ledger = new AcquisitionLedger(
    { owner: "owner", source: "source", async persist() {} },
    adapter,
  );
  const acquired = await ledger.acquire("container", "stockwise-test", "token");
  assert.equal(acquired.state, "UNCERTAIN");
  assert.equal(acquired.identity, null);
  assert.deepEqual(acquired.candidateIdentities, undefined);
  const result = await ledger.cleanup();
  assert.equal(result.status, "INCOMPLETE");
  assert.equal(result.entries[0]?.state, "RETAINED");
  assert.equal(removed, 0);
});

function ownedContainer(id: string, name = "/stockwise-test"): Container {
  return container(id, name, {
    "stockwise.d5.owner": "owner",
    "stockwise.d5.source": "source",
    "stockwise.d5.acquisition-token": "token",
  });
}

test("ledger keeps token-only candidate identity as a hint, not its primary ID", async () => {
  const records: Container[] = [];
  const adapter = dockerAdapter(
    records,
    async () => {
      records.push(ownedContainer(ID));
    },
    undefined,
    true,
  );
  const ledger = new AcquisitionLedger(
    { owner: "owner", source: "source", async persist() {} },
    adapter,
  );
  const acquired = await ledger.acquire("container", "stockwise-test", "token");
  assert.equal(acquired.state, "UNCERTAIN");
  assert.equal(acquired.identity, null);
  assert.deepEqual(acquired.candidateIdentities, [ID]);
  const cleanup = await ledger.cleanup();
  assert.equal(cleanup.status, "INCOMPLETE");
  assert.equal(cleanup.entries[0]?.identity, null);
  assert.equal(cleanup.entries[0]?.candidateIdentities?.[0], ID);
});

test("delayed Docker visibility after create does not prove absence", async () => {
  const records: Container[] = [];
  const adapter = dockerAdapter(records, async () => ID);
  const ledger = new AcquisitionLedger(
    { owner: "owner", source: "source", async persist() {} },
    adapter,
  );
  const acquired = await ledger.acquire("container", "stockwise-test", "token");
  assert.equal(acquired.state, "UNCERTAIN");
  assert.equal(acquired.identity, ID);
  records.push(ownedContainer(ID));
  const cleanup = await ledger.cleanup();
  assert.equal(cleanup.status, "INCOMPLETE");
  assert.equal(cleanup.entries[0]?.state, "CONFIRMED");
});

test("lost create response followed by rename remains uncertain without removal", async () => {
  const records: Container[] = [];
  const adapter = dockerAdapter(
    records,
    async () => {
      records.push(ownedContainer(ID));
    },
    undefined,
    true,
  );
  const ledger = new AcquisitionLedger(
    { owner: "owner", source: "source", async persist() {} },
    adapter,
  );
  const acquired = await ledger.acquire("container", "stockwise-test", "token");
  assert.equal(acquired.state, "UNCERTAIN");
  assert.deepEqual(acquired.candidateIdentities, [ID]);
  records[0] = ownedContainer(ID, "/renamed");
  const cleanup = await ledger.cleanup();
  assert.equal(cleanup.status, "INCOMPLETE");
  assert.equal(cleanup.entries[0]?.identity, null);
});

test("daemon inventory failure through ledger is incomplete, never absence", async () => {
  const adapter = dockerAdapter([], async () => undefined, "tokens");
  const ledger = new AcquisitionLedger(
    { owner: "owner", source: "source", async persist() {} },
    adapter,
  );
  const acquired = await ledger.acquire("container", "stockwise-test", "token");
  assert.equal(acquired.state, "UNCERTAIN");
  const cleanup = await ledger.cleanup();
  assert.equal(cleanup.status, "INCOMPLETE");
  assert.equal(
    cleanup.reasons.some(({ reason }) => reason === "INSPECTION_FAILED"),
    true,
  );
});

test("integrated token inventory does not adopt foreign ownership labels", async () => {
  const foreign = container(ID, "/stockwise-test", {
    "stockwise.d5.owner": "other-owner",
    "stockwise.d5.source": "source",
    "stockwise.d5.acquisition-token": "token",
  });
  const adapter = dockerAdapter(
    [foreign],
    async () => undefined,
    undefined,
    true,
  );
  const ledger = new AcquisitionLedger(
    { owner: "owner", source: "source", async persist() {} },
    adapter,
  );
  const acquired = await ledger.acquire("container", "stockwise-test", "token");
  assert.equal(acquired.state, "UNCERTAIN");
  assert.equal(acquired.identity, null);
  assert.equal(acquired.candidateIdentities, undefined);
  const cleanup = await ledger.cleanup();
  assert.equal(cleanup.status, "INCOMPLETE");
  assert.equal(cleanup.entries[0]?.state, "RETAINED");
});
