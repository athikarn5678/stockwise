import { createHash } from "node:crypto";
import { allowedSourcePath, type SourceEntry } from "./source-contract.mts";

export type { SourceEntry } from "./source-contract.mts";
export type HandoffManifest = {
  version: 1;
  sourceFiles: SourceEntry[];
  sizes: Record<string, number>;
};
export type VerifiedCandidate = object;

type CandidateState = { files: Map<string, Buffer> };
const candidates = new WeakMap<VerifiedCandidate, CandidateState>();
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_COUNT = 10_000;
const MAX_WIRE_BYTES = 800 * 1024 * 1024;
const MAX_LINE_BYTES = Math.ceil(MAX_FILE_BYTES / 3) * 4 + 2048;
const digestBytes = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
function fail(): never {
  throw new Error("CANDIDATE_HANDOFF_INVALID");
}

function record(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}
function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === keys.length &&
    actual.every((key, index) => key === keys[index])
  );
}
function validateManifestShape(
  manifest: unknown,
): asserts manifest is HandoffManifest {
  if (
    !record(manifest) ||
    !exactKeys(manifest, ["sizes", "sourceFiles", "version"]) ||
    manifest.version !== 1 ||
    !Array.isArray(manifest.sourceFiles) ||
    !record(manifest.sizes) ||
    manifest.sourceFiles.length === 0 ||
    manifest.sourceFiles.length > MAX_COUNT
  )
    fail();
  const sizes = manifest.sizes;
  let total = 0;
  let previous = "";
  for (const entry of manifest.sourceFiles) {
    if (
      !record(entry) ||
      !exactKeys(entry, ["path", "sha256"]) ||
      typeof entry.path !== "string" ||
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      !allowedSourcePath(entry.path) ||
      entry.path <= previous
    )
      fail();
    previous = entry.path;
    const size = sizes[entry.path];
    if (
      !Number.isSafeInteger(size) ||
      (size as number) < 0 ||
      (size as number) > MAX_FILE_BYTES
    )
      fail();
    total += size as number;
    if (total > MAX_TOTAL_BYTES) fail();
  }
  const names = Object.keys(sizes).sort();
  const sourceFiles = manifest.sourceFiles;
  if (
    names.length !== sourceFiles.length ||
    names.some((name, index) => name !== sourceFiles[index]!.path)
  )
    fail();
}

export function handoffManifestDigest(manifest: HandoffManifest): string {
  validateManifestShape(manifest);
  const stable = {
    version: manifest.version,
    sourceFiles: manifest.sourceFiles.map((entry) => ({
      path: entry.path,
      sha256: entry.sha256,
    })),
    sizes: Object.fromEntries(
      Object.keys(manifest.sizes)
        .sort()
        .map((path) => [path, manifest.sizes[path]]),
    ),
  };
  return digestBytes(JSON.stringify(stable));
}
export function validateHandoffManifest(
  manifest: HandoffManifest,
  pinnedDigest: string,
): void {
  validateManifestShape(manifest);
  if (
    typeof pinnedDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(pinnedDigest) ||
    handoffManifestDigest(manifest) !== pinnedDigest
  )
    throw new Error("CANDIDATE_MANIFEST_PIN_MISMATCH");
}

function sourceHash(manifest: HandoffManifest): string {
  return digestBytes(JSON.stringify(manifest.sourceFiles));
}
function makeCandidate(files: Map<string, Buffer>): VerifiedCandidate {
  const candidate = Object.freeze({});
  candidates.set(candidate, { files });
  return candidate;
}
export function candidateFiles(
  candidate: VerifiedCandidate,
): readonly { path: string; bytes: Buffer }[] {
  const state = candidates.get(candidate);
  if (!state) throw new Error("VERIFIED_CANDIDATE_REQUIRED");
  return [...state.files].map(([path, bytes]) => ({
    path,
    bytes: Buffer.from(bytes),
  }));
}

function parsed(line: Buffer): unknown {
  try {
    return JSON.parse(line.toString("utf8")) as unknown;
  } catch {
    return fail();
  }
}
function decodeBase64(text: unknown, size: number): Buffer {
  if (
    typeof text !== "string" ||
    text.length !== Math.ceil(size / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      text,
    )
  )
    fail();
  const bytes = Buffer.from(text, "base64");
  if (bytes.length !== size || bytes.toString("base64") !== text) fail();
  return bytes;
}

export async function receiveCandidate(
  stream: AsyncIterable<Uint8Array>,
  manifest: HandoffManifest,
  pinnedDigest: string,
): Promise<VerifiedCandidate> {
  validateHandoffManifest(manifest, pinnedDigest);
  const expectedHash = sourceHash(manifest);
  const iterator = stream[Symbol.asyncIterator]();
  let wireBytes = 0;
  let ended = false;
  let index = 0;
  const files = new Map<string, Buffer>();
  const consume = (line: Buffer) => {
    if (ended) fail();
    const value = parsed(line);
    if (index === 0) {
      if (
        !record(value) ||
        !exactKeys(value, ["manifest", "sourceHash", "type"]) ||
        value.type !== "begin" ||
        value.manifest !== pinnedDigest ||
        value.sourceHash !== expectedHash
      )
        fail();
      index++;
      return;
    }
    if (index <= manifest.sourceFiles.length) {
      const entry = manifest.sourceFiles[index - 1]!;
      if (
        !record(value) ||
        !exactKeys(value, ["bytes", "path", "type"]) ||
        value.type !== "file" ||
        value.path !== entry.path
      )
        fail();
      const bytes = decodeBase64(value.bytes, manifest.sizes[entry.path]!);
      if (digestBytes(bytes) !== entry.sha256)
        throw new Error("CANDIDATE_SOURCE_MISMATCH");
      files.set(entry.path, bytes);
      index++;
      return;
    }
    if (
      !record(value) ||
      !exactKeys(value, ["count", "manifest", "sourceHash", "type"]) ||
      value.type !== "end" ||
      value.count !== manifest.sourceFiles.length ||
      value.manifest !== pinnedDigest ||
      value.sourceHash !== expectedHash
    )
      fail();
    ended = true;
    index++;
  };
  let current: Buffer[] = [];
  let currentLength = 0;
  const deadline = Date.now() + 300_000;
  for (;;) {
    const remaining = Math.min(30_000, deadline - Date.now());
    if (remaining <= 0) throw new Error("CANDIDATE_HANDOFF_TIMED_OUT");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const { value, done } = await Promise.race([
      iterator.next(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("CANDIDATE_HANDOFF_TIMED_OUT")),
          remaining,
        );
      }),
    ]).finally(() => {
      clearTimeout(timer);
    });
    if (done) break;
    if (!(value instanceof Uint8Array)) fail();
    wireBytes += value.byteLength;
    if (wireBytes > MAX_WIRE_BYTES) throw new Error("CANDIDATE_WIRE_TOO_LARGE");
    let start = 0;
    for (let i = 0; i < value.length; i++) {
      if (value[i] !== 10) continue;
      const part = value.subarray(start, i);
      currentLength += part.length;
      if (currentLength > MAX_LINE_BYTES)
        throw new Error("CANDIDATE_LINE_TOO_LARGE");
      if (part.length) current.push(Buffer.from(part));
      consume(
        current.length === 1
          ? current[0]!
          : Buffer.concat(current, currentLength),
      );
      current = [];
      currentLength = 0;
      start = i + 1;
    }
    const tail = value.subarray(start);
    currentLength += tail.length;
    if (currentLength > MAX_LINE_BYTES)
      throw new Error("CANDIDATE_LINE_TOO_LARGE");
    if (tail.length) current.push(Buffer.from(tail));
  }
  if (
    currentLength !== 0 ||
    !ended ||
    files.size !== manifest.sourceFiles.length
  )
    fail();
  return makeCandidate(files);
}

export async function* encodeCandidate(
  files: readonly { path: string; bytes: Uint8Array }[],
  manifest: HandoffManifest,
  pinnedDigest: string,
): AsyncIterable<Uint8Array> {
  validateHandoffManifest(manifest, pinnedDigest);
  if (!Array.isArray(files) || files.length !== manifest.sourceFiles.length)
    fail();
  const fileLines: Buffer[] = [];
  let total = 0;
  for (let i = 0; i < manifest.sourceFiles.length; i++) {
    const expected = manifest.sourceFiles[i]!;
    const file = files[i];
    if (
      !file ||
      file.path !== expected.path ||
      !(file.bytes instanceof Uint8Array) ||
      file.bytes.length !== manifest.sizes[expected.path]
    )
      fail();
    total += file.bytes.length;
    if (total > MAX_TOTAL_BYTES || digestBytes(file.bytes) !== expected.sha256)
      throw new Error("CANDIDATE_SOURCE_MISMATCH");
    fileLines.push(
      Buffer.from(
        JSON.stringify({
          type: "file",
          path: file.path,
          bytes: Buffer.from(file.bytes).toString("base64"),
        }) + "\n",
      ),
    );
  }
  const hash = sourceHash(manifest);
  yield Buffer.from(
    JSON.stringify({
      type: "begin",
      manifest: pinnedDigest,
      sourceHash: hash,
    }) + "\n",
  );
  for (const line of fileLines) yield line;
  yield Buffer.from(
    JSON.stringify({
      type: "end",
      manifest: pinnedDigest,
      sourceHash: hash,
      count: files.length,
    }) + "\n",
  );
}
