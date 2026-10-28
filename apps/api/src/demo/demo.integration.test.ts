import { expect, it } from "vitest";

import { createPrismaClient } from "../prisma/client.ts";
import { loadDemoEnvironment } from "./demo-environment.ts";
import { assertDemoTargetSchema, runDemoFixture } from "./demo-runner.ts";
import { DEMO_AUTHENTICATION_TABLES } from "./demo-schema.ts";
import { validateDemoGoldens } from "./demo-validation.ts";

const configured =
  !!process.env.DEMO_DATABASE_URL && !!process.env.DEMO_USER_PASSWORD;

// Runs first, on the freshly migrated empty *_demo database. Each probe mutates
// inside a transaction that the refusal rolls back.
it.skipIf(!configured)(
  "accepts the migrated schema and refuses real drift before seeding",
  async () => {
    const { databaseUrl } = loadDemoEnvironment();
    const prisma = createPrismaClient({ DATABASE_URL: databaseUrl });
    try {
      await prisma.$transaction((tx) => assertDemoTargetSchema(tx));
      await expect(
        prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            'CREATE TABLE "unexpected_demo_probe" ("id" integer)',
          );
          await assertDemoTargetSchema(tx);
        }),
      ).rejects.toThrow(/Database schema differs/);
      await expect(
        prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            'ALTER TABLE "pending_registrations" RENAME TO "pending_registrations_probe"',
          );
          await assertDemoTargetSchema(tx);
        }),
      ).rejects.toThrow(/Database schema differs/);
      await expect(
        prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            'DELETE FROM "_prisma_migrations" WHERE "migration_name" = (SELECT max("migration_name") FROM "_prisma_migrations")',
          );
          await assertDemoTargetSchema(tx);
        }),
      ).rejects.toThrow(/Migration state differs/);
      // Probes rolled back: the exact schema is accepted again.
      await prisma.$transaction((tx) => assertDemoTargetSchema(tx));
    } finally {
      await prisma.$disconnect();
    }
  },
  60_000,
);

it.skipIf(!configured)(
  "generates the complete fixture once and preserves an exact no-op rerun",
  async () => {
    const { databaseUrl, password } = loadDemoEnvironment();
    const prisma = createPrismaClient({ DATABASE_URL: databaseUrl });
    try {
      expect(await runDemoFixture(prisma, password)).toBe("generated");
      await validateDemoGoldens(prisma);
      const before = await prisma.user.findMany({
        select: { id: true, passwordHash: true },
        orderBy: { id: "asc" },
      });
      expect(await runDemoFixture(prisma, password)).toBe("no-op");
      await validateDemoGoldens(prisma);
      const after = await prisma.user.findMany({
        select: { id: true, passwordHash: true },
        orderBy: { id: "asc" },
      });
      expect(after).toEqual(before);
      expect(await prisma.sale.count()).toBe(1266);
      expect(await prisma.saleItem.count()).toBe(2488);
      expect(await prisma.inventoryTransaction.count()).toBe(2599);
      // Seeding never touches Native tables or the LEGACY fence.
      for (const table of DEMO_AUTHENTICATION_TABLES) {
        const rows = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
          `SELECT count(*)::integer AS count FROM "${table}"`,
        );
        expect(rows[0]!.count).toBe(0);
      }
      expect(
        await prisma.$queryRawUnsafe(
          `SELECT state FROM native_auth_transition`,
        ),
      ).toEqual([{ state: "LEGACY" }]);
      await expect(runDemoFixture(prisma, `${password}!`)).rejects.toThrow(
        /A demo user credential differs/,
      );
      expect(
        await prisma.user.findMany({
          select: { id: true, passwordHash: true },
          orderBy: { id: "asc" },
        }),
      ).toEqual(before);
    } finally {
      await prisma.$disconnect();
    }
  },
  60_000,
);
