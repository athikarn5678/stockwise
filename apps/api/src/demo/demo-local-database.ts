import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

import { Client } from "pg";
import { z } from "zod";

import type { PrismaClient } from "../generated/prisma/client.ts";

const exec = promisify(execFile);
const localDockerEndpoint =
  /^(?:npipe:\/{4}\.\/pipe\/[\w.-]+|unix:\/\/\/(?!\/)[^\\\r\n\0]+)$/;
const receiptSchema = z
  .object({
    version: z.literal(1),
    endpoint: z.string().regex(localDockerEndpoint),
    containerId: z.string().regex(/^[a-f0-9]{64}$/),
    owner: z.uuid(),
    database: z.string().regex(/^[a-z0-9_]+_(?:demo|test)$/),
    oid: z.string().regex(/^\d+$/),
    systemId: z.string().regex(/^\d+$/),
    marker: z.uuid(),
  })
  .strict();
type Receipt = z.infer<typeof receiptSchema>;
const identitySql = `SELECT current_database() AS database,
  (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,
  (SELECT system_identifier::text FROM pg_control_system()) AS "systemId",
  shobj_description((SELECT oid FROM pg_database WHERE datname=current_database()), 'pg_database') AS marker`;

async function docker(args: string[]) {
  const result = await exec("docker", args, {
    timeout: 10_000,
    windowsHide: true,
    maxBuffer: 1_048_576,
  });
  return result.stdout.trim();
}

async function localEndpoint() {
  const endpoint =
    process.env.DOCKER_HOST ??
    (await docker([
      "context",
      "inspect",
      "--format",
      "{{.Endpoints.docker.Host}}",
    ]));
  if (!localDockerEndpoint.test(endpoint))
    throw new Error("Demo database requires a local Docker daemon.");
  return endpoint;
}

async function inspectTarget(
  endpoint: string,
  container: string,
  databaseUrl: string,
) {
  const url = new URL(databaseUrl);
  if (
    process.env.STOCKWISE_RUNTIME_ENV === "production" ||
    url.protocol !== "postgresql:" ||
    url.hostname !== "127.0.0.1" ||
    !/^[a-z0-9_]+_(?:demo|test)$/.test(url.pathname.slice(1)) ||
    /(^|_)(prod|production|stage|staging|live)(_|$)/.test(
      url.pathname.slice(1),
    ) ||
    url.hash ||
    [...url.searchParams].some(([k, v]) => k !== "schema" || v !== "public")
  )
    throw new Error(
      "Demo database requires an owned disposable loopback target.",
    );
  if (endpoint !== (await localEndpoint()))
    throw new Error("Demo database Docker endpoint differs.");
  const value = z
    .array(
      z.object({
        Id: z.string(),
        State: z.object({ Running: z.boolean() }),
        Config: z.object({
          Labels: z.record(z.string(), z.string()).nullable(),
          Env: z.array(z.string()),
        }),
        NetworkSettings: z.object({
          Ports: z.record(
            z.string(),
            z
              .array(z.object({ HostIp: z.string(), HostPort: z.string() }))
              .nullable(),
          ),
        }),
      }),
    )
    .length(1)
    .parse(
      JSON.parse(
        await docker(["--host", endpoint, "container", "inspect", container]),
      ),
    )[0]!;
  const owner =
    value.Config.Labels?.["stockwise.disposable"] ??
    value.Config.Labels?.["stockwise.local.owner"];
  if (
    !value.State.Running ||
    !owner ||
    !z.uuid().safeParse(owner).success ||
    !value.NetworkSettings.Ports["5432/tcp"]?.some(
      (p) => p.HostIp === "127.0.0.1" && p.HostPort === (url.port || "5432"),
    )
  )
    throw new Error(
      "Demo database has no matching owned local container binding.",
    );
  const user = z
    .string()
    .regex(/^[a-z0-9_]+$/)
    .parse(
      value.Config.Env.find((e) => e.startsWith("POSTGRES_USER="))?.slice(14) ??
        "postgres",
    );
  const systemId = await docker([
    "--host",
    endpoint,
    "exec",
    value.Id,
    "psql",
    "-U",
    user,
    "-d",
    "postgres",
    "-Atc",
    "SELECT system_identifier::text FROM pg_control_system()",
  ]);
  return { containerId: value.Id, owner, systemId };
}

/** Setup only: attest a fresh database after checking both Docker and the live SQL identity. */
export async function issueDemoDatabaseReceipt(input: {
  databaseUrl: string;
  containerId: string;
  path: string;
}) {
  const endpoint = await localEndpoint();
  const container = await inspectTarget(
    endpoint,
    input.containerId,
    input.databaseUrl,
  );
  const client = new Client({
    connectionString: input.databaseUrl,
    connectionTimeoutMillis: 5000,
    query_timeout: 5000,
  });
  await client.connect();
  try {
    const actual = (await client.query(identitySql)).rows[0];
    if (actual.systemId !== container.systemId)
      throw new Error("Demo database live instance differs from Docker.");
    const tables = await client.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations' AND tablename <> 'native_auth_transition'",
    );
    for (const row of tables.rows) {
      const name = z
        .string()
        .regex(/^[a-z_]+$/)
        .parse(row.tablename);
      if (
        (await client.query(`SELECT 1 FROM public."${name}" LIMIT 1`)).rowCount
      )
        throw new Error(
          "Demo database receipt can only be issued to an empty disposable database.",
        );
    }
    const receipt = receiptSchema.parse({
      version: 1,
      endpoint,
      ...container,
      database: actual.database,
      oid: actual.oid,
      marker: randomUUID(),
    });
    // All interpolated values are validated identifiers/UUIDs, never URLs or user text.
    await client.query(
      `COMMENT ON DATABASE "${receipt.database}" IS 'stockwise-disposable:${receipt.marker}'`,
    );
    await writeFile(input.path, JSON.stringify(receipt), {
      flag: "wx",
      mode: 0o600,
    });
  } finally {
    await client.end();
  }
}

/** A copied database marker alone cannot pass the independent local-container check. */
export async function verifyDemoDatabase(
  prisma: PrismaClient,
  databaseUrl?: string,
  path?: string,
) {
  try {
    const database = (
      await prisma.$queryRaw<
        Array<{ name: string }>
      >`SELECT current_database() AS name`
    )[0]!.name;
    databaseUrl ??= [
      process.env.DEMO_DATABASE_URL,
      process.env.TEST_DATABASE_URL,
    ].find((url) => url && new URL(url).pathname === `/${database}`);
    if (!databaseUrl) throw new Error("missing URL");
    path ??=
      databaseUrl === process.env.TEST_DATABASE_URL
        ? process.env.TEST_DISPOSABLE_RECEIPT
        : process.env.DEMO_DISPOSABLE_RECEIPT;
    if (!path) throw new Error("missing receipt");
    const receipt: Receipt = receiptSchema.parse(
      JSON.parse(await readFile(path, "utf8")),
    );
    const container = await inspectTarget(
      receipt.endpoint,
      receipt.containerId,
      databaseUrl,
    );
    const actual = (
      await prisma.$queryRawUnsafe<
        Array<{
          database: string;
          oid: string;
          systemId: string;
          marker: string;
        }>
      >(identitySql)
    )[0];
    if (
      !actual ||
      actual.database !== receipt.database ||
      actual.oid !== receipt.oid ||
      actual.systemId !== receipt.systemId ||
      container.systemId !== receipt.systemId ||
      container.owner !== receipt.owner ||
      container.containerId !== receipt.containerId ||
      actual.marker !== `stockwise-disposable:${receipt.marker}`
    )
      throw new Error("identity mismatch");
    return databaseUrl;
  } catch {
    throw new Error("Demo database disposable ownership verification failed.");
  }
}
