import type { AcquisitionResource } from "./acquisition-contract.mts";

export type DockerCommand = (args: string[]) => Promise<string>;

function listedIds(output: string): string[] {
  if (typeof output !== "string") throw new Error("RESOURCE_INVENTORY_INVALID");
  const lines = output.split(/\r?\n/).filter((line) => line.length > 0);
  if (
    lines.some((line) => !/^[a-f0-9]{64}$/i.test(line)) ||
    new Set(lines).size !== lines.length
  )
    throw new Error("RESOURCE_INVENTORY_INVALID");
  return lines;
}

function inspected(output: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(output);
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 1 ||
    !parsed[0] ||
    typeof parsed[0] !== "object" ||
    Array.isArray(parsed[0])
  )
    throw new Error("RESOURCE_INSPECTION_INVALID");
  return parsed[0] as Record<string, unknown>;
}

function containerIdentity(
  raw: Record<string, unknown>,
  expectedName?: string,
  expectedId?: string,
): string {
  const id = raw.Id;
  if (
    typeof id !== "string" ||
    !/^[a-f0-9]{64}$/i.test(id) ||
    (expectedId !== undefined && id !== expectedId) ||
    (expectedName !== undefined && raw.Name !== `/${expectedName}`)
  )
    throw new Error("RESOURCE_IDENTITY_CONFLICT");
  const config = raw.Config;
  if (!config || typeof config !== "object" || Array.isArray(config))
    throw new Error("RESOURCE_INSPECTION_INVALID");
  const labels = (config as Record<string, unknown>).Labels;
  if (
    labels !== undefined &&
    (!labels || typeof labels !== "object" || Array.isArray(labels))
  )
    throw new Error("RESOURCE_INSPECTION_INVALID");
  return id;
}

function sameIdentity(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  const aConfig = a.Config as Record<string, unknown>;
  const bConfig = b.Config as Record<string, unknown>;
  const aLabels = aConfig.Labels as Record<string, unknown> | undefined;
  const bLabels = bConfig.Labels as Record<string, unknown> | undefined;
  const keys = new Set([
    ...Object.keys(aLabels ?? {}),
    ...Object.keys(bLabels ?? {}),
  ]);
  return (
    a.Id === b.Id &&
    a.Name === b.Name &&
    [...keys].every((key) => aLabels?.[key] === bLabels?.[key])
  );
}

function fullIdSet(ids: string[]): Set<string> {
  return new Set(ids.map((id) => id.toLowerCase()));
}

export async function inspectResourceIdentity(
  resource: AcquisitionResource,
  recordedIdentity: string | undefined,
  docker: DockerCommand,
): Promise<Record<string, unknown> | null> {
  if (resource.kind === "volume") {
    const names = (
      await docker([
        "volume",
        "ls",
        "--filter",
        `name=^${resource.name}$`,
        "--format",
        "{{.Name}}",
      ])
    )
      .split(/\r?\n/)
      .filter(Boolean);
    if (!names.length) return null;
    if (names.length !== 1 || names[0] !== resource.name)
      throw new Error("RESOURCE_IDENTITY_CONFLICT");
    return inspected(await docker(["volume", "inspect", resource.name]));
  }

  const identity = recordedIdentity ?? resource.identity ?? undefined;
  if (identity !== undefined && !/^[a-f0-9]{64}$/i.test(identity))
    throw new Error("RESOURCE_IDENTITY_INVALID");
  const allIds = listedIds(
    await docker(["ps", "--all", "--no-trunc", "--format", "{{.ID}}"]),
  );
  const allIdSet = fullIdSet(allIds);
  const recordedPresent =
    identity !== undefined && allIdSet.has(identity.toLowerCase());
  let byId: Record<string, unknown> | null = null;
  if (identity !== undefined && recordedPresent) {
    byId = inspected(await docker(["container", "inspect", identity]));
    containerIdentity(byId, undefined, identity);
  }
  const namedIds = listedIds(
    await docker([
      "ps",
      "--all",
      "--no-trunc",
      "--filter",
      `name=^/${resource.name}$`,
      "--format",
      "{{.ID}}",
    ]),
  );
  const tokenIds = listedIds(
    await docker([
      "ps",
      "--all",
      "--no-trunc",
      "--filter",
      `label=stockwise.d5.acquisition-token=${resource.token}`,
      "--format",
      "{{.ID}}",
    ]),
  );
  if (namedIds.length > 1 || tokenIds.length > 1)
    throw new Error("RESOURCE_IDENTITY_CONFLICT");
  const namedId = namedIds[0];
  const tokenId = tokenIds[0];
  if (
    (namedId !== undefined && !allIdSet.has(namedId.toLowerCase())) ||
    (tokenId !== undefined && !allIdSet.has(tokenId.toLowerCase()))
  )
    throw new Error("RESOURCE_IDENTITY_CONFLICT");
  let byName: Record<string, unknown> | null = null;
  if (namedId !== undefined) {
    byName = inspected(await docker(["container", "inspect", namedId]));
    containerIdentity(byName, resource.name, namedId);
    const config = byName.Config as Record<string, unknown>;
    const labels = config.Labels as Record<string, unknown> | undefined;
    if (
      labels?.["stockwise.d5.acquisition-token"] === resource.token &&
      tokenId === undefined
    )
      throw new Error("RESOURCE_IDENTITY_CONFLICT");
  }
  let byToken: Record<string, unknown> | null = null;
  if (tokenId !== undefined) {
    byToken = inspected(await docker(["container", "inspect", tokenId]));
    containerIdentity(byToken, undefined, tokenId);
    const config = byToken.Config as Record<string, unknown>;
    const labels = config.Labels as Record<string, unknown> | undefined;
    if (labels?.["stockwise.d5.acquisition-token"] !== resource.token)
      throw new Error("RESOURCE_IDENTITY_CONFLICT");
  }
  if (tokenId !== undefined && namedId === undefined)
    throw new Error("RESOURCE_IDENTITY_CONFLICT");
  const candidates = [byId, byName, byToken].filter(
    (value): value is Record<string, unknown> => value !== null,
  );
  if (candidates.some((candidate) => candidate.Name !== `/${resource.name}`))
    throw new Error("RESOURCE_IDENTITY_CONFLICT");
  for (let index = 1; index < candidates.length; index++) {
    if (!sameIdentity(candidates[0]!, candidates[index]!))
      throw new Error("RESOURCE_IDENTITY_CONFLICT");
  }
  if (identity !== undefined && !recordedPresent && candidates.length > 0)
    throw new Error("RESOURCE_IDENTITY_CONFLICT");
  if (identity !== undefined && recordedPresent && namedId === undefined)
    throw new Error("RESOURCE_IDENTITY_CONFLICT");
  if (identity === undefined && candidates.length === 0)
    throw new Error("RESOURCE_UNKNOWN_ID_ABSENCE");
  return candidates[0] ?? null;
}
