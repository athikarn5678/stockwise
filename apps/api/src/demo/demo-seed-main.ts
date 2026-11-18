import { parseArgs } from "node:util";

import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";

import { createPrismaClient } from "../prisma/client.ts";
import {
  bootstrapDemo90d,
  demo90dCatalog,
  resolveDemoPassword,
} from "./demo-90d-bootstrap.ts";
import {
  buildDemo30dPlan,
  demoWindowShape,
  type Demo30dPlanData,
} from "./demo-30d-plan.ts";
import { readDemoProvenance } from "./demo-30d-provenance.ts";
import { runDemo30d } from "./demo-30d-runner.ts";
import { seedStoredReports } from "./demo-seed-reports.ts";
import { loadDemoDatabaseEnvironment } from "./demo-environment.ts";
import { verifyDemoSeedTarget } from "./demo-local-database.ts";

/** Bootstrap instant is well before the plan window (up to 122 days back). */
const BOOTSTRAP_DAYS_BEFORE_WINDOW_START = 14;

function localToday(timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function bootstrapInstant(referenceDate: string): Date {
  const date = Temporal.PlainDate.from(referenceDate).subtract({
    days:
      demoWindowShape(referenceDate).days + BOOTSTRAP_DAYS_BEFORE_WINDOW_START,
  });
  return new Date(`${date.toString()}T00:00:00.000Z`);
}

function previewPlan(referenceDate: string, seed: number): Demo30dPlanData {
  const catalog = demo90dCatalog();
  const owner = catalog.users.find((user) => user.role === "OWNER")!;
  const supplierId = [...catalog.suppliers].sort((a, b) =>
    a.id.localeCompare(b.id),
  )[0]!.id;
  return buildDemo30dPlan({
    referenceDate,
    seed,
    shape: demoWindowShape(referenceDate),
    reportingTimezone: catalog.organization.timezone,
    organizationId: catalog.organization.id,
    branches: catalog.branches.map(({ id, code }) => ({ id, code })),
    products: catalog.products.map(({ id, name, sku, unit, basePrice }) => ({
      id,
      name,
      sku,
      unit,
      basePrice,
    })),
    settings: {
      actorUserId: owner.id,
      supplierId,
      salesVatStatus: catalog.organization.salesVatStatus,
      salesVatRate: catalog.organization.salesVatRate,
    },
  });
}

async function main() {
  const { values } = parseArgs({
    options: {
      "reference-date": { type: "string" },
      seed: { type: "string", default: "90" },
      preview: { type: "boolean", default: false },
    },
  });
  const options = z
    .object({
      referenceDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
      seed: z.coerce.number().int().min(0).max(4_294_967_295),
      preview: z.boolean(),
    })
    .parse({
      referenceDate: values["reference-date"],
      seed: values.seed,
      preview: values.preview,
    });
  const { databaseUrl } = loadDemoDatabaseEnvironment();
  const prisma = createPrismaClient({ DATABASE_URL: databaseUrl });
  try {
    const catalog = demo90dCatalog();
    // Attest the target before reading or writing anything.
    await verifyDemoSeedTarget(prisma);
    // A rerun on a later day must remain the same idempotent plan.
    const referenceDate =
      options.referenceDate ??
      (await readDemoProvenance(prisma, catalog.organization.id))?.plan
        .referenceDate ??
      localToday(catalog.organization.timezone);

    if (options.preview) {
      const plan = previewPlan(referenceDate, options.seed);
      process.stdout.write(
        `${JSON.stringify(
          {
            status: "PREVIEW",
            signature: plan.signature,
            from: plan.from,
            to: plan.to,
            saleCount: plan.sales.length,
            orderCount: plan.orders.length,
            refundCount: plan.sales.filter((sale) => sale.refund).length,
            adjustmentCount: plan.adjustments?.length ?? 0,
          },
          null,
          2,
        )}\n`,
      );
      return;
    }

    const { password, source } = resolveDemoPassword(process.env);
    const bootstrap = await bootstrapDemo90d(prisma, {
      password,
      createdAt: bootstrapInstant(referenceDate),
    });
    const result = await runDemo30d(prisma, {
      organizationId: bootstrap.organizationId,
      referenceDate,
      seed: options.seed,
      shape: demoWindowShape(referenceDate),
      apply: true,
    });
    // Stored weekly/monthly reports are derived from the applied history, so they
    // run only after the plan is complete and never in preview mode.
    const reports = await seedStoredReports(prisma, {
      from: result.from,
      organizationId: bootstrap.organizationId,
      reportingTimezone: catalog.organization.timezone,
      to: result.to,
    });
    process.stdout.write(
      `${JSON.stringify(
        {
          status: result.status,
          signature: result.signature,
          from: result.from,
          to: result.to,
          saleCount: result.saleCount,
          orderCount: result.orderCount,
          refundCount: result.refundCount,
          adjustmentCount: result.adjustmentCount ?? 0,
          reports,
          organizationName: catalog.organization.name,
          accounts: catalog.users.map(({ role, email }) => ({ role, email })),
          passwordSource: source,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  const safeMessage =
    error instanceof Error &&
    /^(?:Demo90d |Demo30d |Demo generation |Demo database |DEMO_DATABASE_URL |DATABASE_URL |TEST_DATABASE_URL |Root \.env |root \.env )/.test(
      error.message,
    )
      ? error.message
      : "Demo90d refused or failed. Check the disposable target, arguments and database state.";
  process.stderr.write(`${safeMessage}\n`);
  process.exitCode = 1;
});
