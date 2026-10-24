import assert from "node:assert/strict";
import { test } from "node:test";
import {
  candidateFiles,
  encodeCandidate,
  handoffManifestDigest,
  receiveCandidate,
  type HandoffManifest,
} from "./handoff-contract.mts";
import { digest } from "./source-contract.mts";

const payload = Buffer.from([0, 13, 10, 255, 42]);
const manifest: HandoffManifest = {
  version: 1,
  sourceFiles: [{ path: "apps/api/source.ts", sha256: digest(payload) }],
  sizes: { "apps/api/source.ts": payload.length },
};
const pin = handoffManifestDigest(manifest);
async function* chunks(parts: Uint8Array[]): AsyncIterable<Uint8Array> {
  yield* parts;
}
async function wire(
  files = [{ path: "apps/api/source.ts", bytes: payload }],
): Promise<Buffer[]> {
  const output: Buffer[] = [];
  for await (const part of encodeCandidate(files, manifest, pin))
    output.push(Buffer.from(part));
  return output;
}

test("handoff transports exact bytes and candidateFiles returns defensive copies", async () => {
  const candidate = await receiveCandidate(chunks(await wire()), manifest, pin);
  const first = candidateFiles(candidate);
  assert.equal(first[0]!.bytes.equals(payload), true);
  first[0]!.bytes.fill(0);
  assert.equal(candidateFiles(candidate)[0]!.bytes.equals(payload), true);
  assert.throws(() => candidateFiles({}), /VERIFIED_CANDIDATE_REQUIRED/);
});

test("handoff rejects pin mismatch and malformed or reordered inventories", async () => {
  await assert.rejects(
    receiveCandidate(chunks(await wire()), manifest, "0".repeat(64)),
    /PIN_MISMATCH/,
  );
  const bad = {
    ...manifest,
    sourceFiles: [{ ...manifest.sourceFiles[0]!, path: "../source.ts" }],
  } as HandoffManifest;
  await assert.rejects(receiveCandidate(chunks([]), bad, pin));
});

test("handoff rejects unexpected fields, duplicate, missing, extra, and changed files", async () => {
  const good = await wire();
  const begin = good[0]!;
  const file = good[1]!;
  const end = good[2]!;
  const duplicate = Buffer.from(file);
  await assert.rejects(
    receiveCandidate(chunks([begin, file, duplicate, end]), manifest, pin),
  );
  await assert.rejects(receiveCandidate(chunks([begin, end]), manifest, pin));
  await assert.rejects(
    receiveCandidate(
      chunks([
        begin,
        file,
        Buffer.from(
          JSON.stringify({ type: "file", path: "extra.ts", bytes: "" }) + "\n",
        ),
        end,
      ]),
      manifest,
      pin,
    ),
  );
  await assert.rejects(
    receiveCandidate(
      chunks([
        begin,
        Buffer.from(file.toString().replace("source.ts", "other.ts")),
        end,
      ]),
      manifest,
      pin,
    ),
  );
  const tampered = Buffer.from(
    JSON.stringify({
      type: "file",
      path: "apps/api/source.ts",
      bytes: Buffer.from([1, 13, 10, 255, 42]).toString("base64"),
    }) + "\n",
  );
  await assert.rejects(
    receiveCandidate(chunks([begin, tampered, end]), manifest, pin),
    /CANDIDATE_SOURCE_MISMATCH/,
  );
  const extraBegin = Buffer.from(
    JSON.stringify({
      type: "begin",
      manifest: pin,
      sourceHash: digest(JSON.stringify(manifest.sourceFiles)),
      extra: true,
    }) + "\n",
  );
  await assert.rejects(
    receiveCandidate(chunks([extraBegin, file, end]), manifest, pin),
  );
});

test("handoff rejects unsupported paths, interruption, and trailing records", async () => {
  for (const path of [
    "apps/api/../secret.ts",
    "apps/api/.env.local",
    "node_modules/pkg/index.ts",
    "apps/api/source\\x.ts",
    "/absolute.ts",
  ]) {
    const bad = {
      ...manifest,
      sourceFiles: [{ ...manifest.sourceFiles[0]!, path }],
      sizes: { [path]: payload.length },
    } as HandoffManifest;
    await assert.rejects(receiveCandidate(chunks([]), bad, "0".repeat(64)));
  }
  const good = await wire();
  await assert.rejects(
    receiveCandidate(chunks(good.slice(0, 2)), manifest, pin),
  );
  await assert.rejects(
    receiveCandidate(chunks([...good, Buffer.from("{}\n")]), manifest, pin),
  );
  await assert.rejects(
    receiveCandidate(
      chunks([Buffer.concat(good).subarray(0, -1)]),
      manifest,
      pin,
    ),
  );
});

test("handoff encoder refuses substituted bytes and manifest shape extras", async () => {
  await assert.rejects(
    wire([{ path: "apps/api/source.ts", bytes: Buffer.from("changed") }]),
    /CANDIDATE_HANDOFF_INVALID/,
  );
  const invalid = { ...manifest, extra: true };
  const encoded = encodeCandidate(
    [{ path: "apps/api/source.ts", bytes: payload }],
    invalid,
    pin,
  );
  await assert.rejects(
    encoded[Symbol.asyncIterator]().next(),
    /CANDIDATE_HANDOFF_INVALID/,
  );
});

test("intake refuses symlink and special-file records instead of interpreting their targets", async () => {
  const good = await wire();
  for (const type of ["symlink", "fifo", "device", "directory"]) {
    const special = Buffer.from(
      JSON.stringify({
        type,
        path: "apps/api/source.ts",
        bytes: payload.toString("base64"),
      }) + "\n",
    );
    await assert.rejects(
      receiveCandidate(chunks([good[0]!, special, good[2]!]), manifest, pin),
    );
  }
});

test("historical handoff rejects unknown manifest shapes before file access", () => {
  for (const value of [
    null,
    [],
    {},
    { version: 1, sourceFiles: null, sizes: {} },
    { ...manifest, sourceFiles: [{ path: "apps/api/source.ts", sha256: 123 }] },
    { ...manifest, sizes: { "apps/api/source.ts": "5" } },
  ]) {
    assert.throws(
      () => Reflect.apply(handoffManifestDigest, undefined, [value]),
      /CANDIDATE_HANDOFF_INVALID/,
    );
  }
});

test("historical handoff rejects noncanonical payloads and sparse encoder input", async () => {
  const good = await wire();
  for (const bytes of [null, {}, "????", "AA0K/yp="]) {
    const file = Buffer.from(
      JSON.stringify({ type: "file", path: "apps/api/source.ts", bytes }) +
        "\n",
    );
    await assert.rejects(
      receiveCandidate(chunks([good[0]!, file, good[2]!]), manifest, pin),
      /CANDIDATE_HANDOFF_INVALID/,
    );
  }
  const missing = new Array<{ path: string; bytes: Uint8Array }>(1);
  await assert.rejects(
    encodeCandidate(missing, manifest, pin)[Symbol.asyncIterator]().next(),
    /CANDIDATE_HANDOFF_INVALID/,
  );
});
