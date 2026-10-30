import { readFile, writeFile, mkdtemp, unlink, rmdir } from "node:fs/promises";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, expect, it } from "vitest";
import { z } from "zod";

import { createPrismaClient } from "../prisma/client.ts";
import { loadTestDatabaseEnvironment } from "../test/database-environment.ts";
import { createTestPrismaClient } from "../test/database-harness.ts";
import { verifyDemoDatabase } from "./demo-local-database.ts";
import { runDemo30d } from "./demo-30d-runner.ts";

const configured =
  !!process.env.TEST_DATABASE_URL && !!process.env.TEST_DISPOSABLE_RECEIPT;
const test = it.skipIf(!configured);
const environment = loadTestDatabaseEnvironment();
const prisma = createTestPrismaClient(environment);
afterAll(() => prisma.$disconnect());

test("accepts only the setup-issued receipt matching the live owned container and database", async () => {
  expect(await verifyDemoDatabase(prisma)).toBe(environment.TEST_DATABASE_URL);
});

test("rejects missing proof, mismatched cluster/OID and missing database marker before business writes", async () => {
  const path = process.env.TEST_DISPOSABLE_RECEIPT!;
  const receipt = z
    .object({
      database: z.string().regex(/^[a-z0-9_]+_test$/),
      marker: z.uuid(),
    })
    .passthrough()
    .parse(JSON.parse(await readFile(path, "utf8")));
  const directory = await mkdtemp(join(tmpdir(), "stockwise-proof-"));
  const before = await prisma.sale.count();
  try {
    const previousHost = process.env.DOCKER_HOST;
    try {
      for (const host of [
        "tcp://127.0.0.1:2375",
        "npipe:////remote-host/pipe/docker_engine",
        "unix://remote-host/docker.sock",
      ]) {
        process.env.DOCKER_HOST = host;
        await expect(verifyDemoDatabase(prisma)).rejects.toThrow(/ownership/);
      }
    } finally {
      if (previousHost === undefined) delete process.env.DOCKER_HOST;
      else process.env.DOCKER_HOST = previousHost;
    }
    await expect(
      verifyDemoDatabase(
        prisma,
        environment.TEST_DATABASE_URL,
        join(directory, "missing.json"),
      ),
    ).rejects.toThrow(/ownership/);
    for (const difference of [
      { systemId: "1" },
      { containerId: "0".repeat(64) },
      { owner: "00000000-0000-4000-8000-000000000001" },
      { oid: "1" },
      { marker: "00000000-0000-4000-8000-000000000001" },
    ]) {
      const invalid = join(directory, "invalid.json");
      await writeFile(invalid, JSON.stringify({ ...receipt, ...difference }));
      await expect(
        verifyDemoDatabase(prisma, environment.TEST_DATABASE_URL, invalid),
      ).rejects.toThrow(/ownership/);
    }
    await prisma.$executeRawUnsafe(
      `COMMENT ON DATABASE "${receipt.database}" IS NULL`,
    );
    await expect(
      runDemo30d(prisma, {
        organizationId: "00000000-0000-4000-8000-000000000001",
        referenceDate: "2026-10-30",
        seed: 30,
        apply: true,
      }),
    ).rejects.toThrow(/ownership/);
    expect(await prisma.sale.count()).toBe(before);
  } finally {
    await prisma.$executeRawUnsafe(
      `COMMENT ON DATABASE "${receipt.database}" IS 'stockwise-disposable:${receipt.marker}'`,
    );
    await unlink(join(directory, "invalid.json"));
    await rmdir(directory);
  }
});

test("rejects a loopback tunnel even when the forwarded database has a copied valid marker", async () => {
  const url = new URL(environment.TEST_DATABASE_URL);
  const upstreamPort = Number(url.port);
  const sockets = new Set<import("node:net").Socket>();
  const tunnel = createServer((socket) => {
    const upstream = connect({ host: "127.0.0.1", port: upstreamPort });
    sockets.add(socket);
    sockets.add(upstream);
    socket.on("error", () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
    socket.pipe(upstream).pipe(socket);
  });
  await new Promise<void>((resolve) => tunnel.listen(0, "127.0.0.1", resolve));
  const address = tunnel.address();
  if (!address || typeof address === "string")
    throw new Error("tunnel address");
  url.port = String(address.port);
  const forwarded = createPrismaClient({ DATABASE_URL: url.toString() });
  try {
    expect(
      await forwarded.$queryRaw`SELECT current_database() AS name`,
    ).toEqual([
      { name: new URL(environment.TEST_DATABASE_URL).pathname.slice(1) },
    ]);
    await expect(
      verifyDemoDatabase(
        forwarded,
        url.toString(),
        process.env.TEST_DISPOSABLE_RECEIPT,
      ),
    ).rejects.toThrow(/ownership/);
  } finally {
    for (const socket of sockets) socket.destroy();
    await forwarded.$disconnect();
    await new Promise<void>((resolve) => tunnel.close(() => resolve()));
  }
}, 15_000);
