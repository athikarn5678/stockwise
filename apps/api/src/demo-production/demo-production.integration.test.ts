import { createHash, randomUUID } from "node:crypto";

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { Prisma } from "../generated/prisma/client.ts";
import { createPrismaInventoryRepository } from "../modules/inventory/inventory-repository.ts";
import { inventoryAdjustmentBodySchema } from "../modules/inventory/inventory-schemas.ts";
import {
  composeDemoInsightReaders,
  createProductionDemoInsightReader,
} from "../modules/ai-insights/demo-production-insight.ts";
import { createPrismaCheckoutRepository } from "../modules/sales/checkout-repository.ts";
import { createPrismaRefundRepository } from "../modules/sales/refund-repository.ts";
import { loadTestDatabaseEnvironment } from "../test/database-environment.ts";
import {
  createTestPrismaClient,
  resetTestDatabase,
} from "../test/database-harness.ts";
import { runProvision } from "./demo-production-provision.ts";
import { parseDemoProductionSpec } from "./demo-production-spec.ts";

// Runs in the default CI shape: plain PostgreSQL, no Docker receipt. The
// Production importer deliberately has no dependency on the local-only
// attestation used by the disposable-database seeder.
const environment = loadTestDatabaseEnvironment();
const prisma = createTestPrismaClient(environment);
const database = decodeURIComponent(
  new URL(environment.TEST_DATABASE_URL).pathname.slice(1),
);
const roles = [
  "OWNER",
  "ADMIN",
  "BRANCH_MANAGER",
  "INVENTORY_STAFF",
  "CASHIER",
] as const;

interface Loose {
  members: Array<{ role: string; branchCodes: string[] }>;
  products: Array<{ basePrice: string }>;
  extra?: boolean;
}
interface Insight {
  label: string;
  providerCalls: number;
  provider: unknown;
  content: string;
  explanation: string;
  metrics: {
    saleCount: number;
    netRevenue: string;
    growthPercent: string | null;
    topProducts: unknown[];
    lowStock: Array<{ onHand: string }>;
    replenishment: Array<{ quantity: string }>;
  };
}

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

interface World {
  specRaw: string;
  digest: string;
  retireDigest: string;
  spec: ReturnType<typeof parseDemoProductionSpec>["spec"];
  users: Record<(typeof roles)[number], string>;
  other: { organizationId: string; branchId: string };
}
let world: World;

const lines = () => {
  const output: string[] = [];
  return { output, write: (line: string) => output.push(line) };
};
const provision = (input: Parameters<typeof runProvision>[1], sink = lines()) =>
  runProvision(prisma, input, sink.write).then(() => sink.output);

async function createWorld(
  mutate: (spec: Record<string, unknown>) => void = () => {},
  usable = true,
): Promise<World> {
  const users = {} as World["users"];
  for (const role of roles) {
    const user = await prisma.user.create({
      data: {
        email: `dp-${role.toLowerCase()}@example.invalid`,
        emailVerifiedAt: new Date("2026-01-01T00:00:00Z"),
        emailVerified: true,
        displayName: role,
      },
    });
    if (usable || role !== "CASHIER")
      await prisma.betterAuthAccount.create({
        data: {
          accountId: user.id,
          providerId: "credential",
          userId: user.id,
          password: "synthetic-test-verifier",
        },
      });
    users[role] = user.id;
  }
  const other = await prisma.organization.create({
    data: { name: "Existing Production Org", salesVatStatus: "NOT_REGISTERED" },
  });
  const otherBranch = await prisma.branch.create({
    data: { organizationId: other.id, code: "MAIN", name: "Existing main" },
  });
  await prisma.organizationMembership.create({
    data: { organizationId: other.id, userId: users.OWNER, role: "OWNER" },
  });
  await prisma.organizationMembership.create({
    data: { organizationId: other.id, userId: users.CASHIER, role: "CASHIER" },
  });
  await prisma.branchAssignment.create({
    data: {
      organizationId: other.id,
      userId: users.CASHIER,
      branchId: otherBranch.id,
    },
  });
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
  }).format(new Date());
  const id = () => randomUUID();
  const spec: Record<string, unknown> = {
    version: 1,
    database,
    organization: { id: id(), name: "UAT Demo Siam Mart 30D" },
    referenceDate: today,
    seed: 30,
    reportingTimezone: "Asia/Bangkok",
    branches: [
      { id: id(), code: "MAIN", name: "Siam Main" },
      { id: id(), code: "NORTH", name: "Siam North" },
    ],
    supplier: { id: id(), name: "Synthetic Demo Supplier" },
    products: [
      "Daily Rice",
      "Tea",
      "Milk",
      "Noodles",
      "Soap",
      "Seasonal Gift",
    ].map((name, index) => ({
      id: id(),
      sku: `D30-${index}`,
      name,
      unit: "EA",
      basePrice: String(20 + index * 10),
    })),
    members: roles.map((role) => ({
      emailSha256: sha(`dp-${role.toLowerCase()}@example.invalid`),
      role,
      branchCodes: role === "OWNER" || role === "ADMIN" ? [] : ["MAIN"],
    })),
  };
  mutate(spec);
  const specRaw = JSON.stringify(spec);
  const parsed = parseDemoProductionSpec(specRaw);
  let digest = "";
  if (usable) {
    const sink = lines();
    await runProvision(
      prisma,
      { mode: "dry-run", rawSpec: specRaw },
      sink.write,
    );
    digest = /SPEC digest=([0-9a-f]{16})/.exec(sink.output.join("\n"))![1]!;
  }
  return {
    specRaw,
    digest,
    retireDigest: parsed.retireDigest,
    spec: parsed.spec,
    users,
    other: { organizationId: other.id, branchId: otherBranch.id },
  };
}

async function unrelatedSnapshot() {
  return JSON.stringify(
    await prisma.$queryRaw`SELECT
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM organizations t WHERE t.id = ${world.other.organizationId}::uuid) o,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.user_id) FROM organization_memberships t WHERE t.organization_id = ${world.other.organizationId}::uuid) m,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM branches t WHERE t.organization_id = ${world.other.organizationId}::uuid) b,
      (SELECT count(*)::int FROM users) u`,
  );
}

afterAll(async () => {
  await resetTestDatabase(environment);
  await prisma.$disconnect();
});

describe("Production demo import refusals", () => {
  beforeAll(async () => {
    await resetTestDatabase(environment);
    world = await createWorld();
  }, 60_000);

  it("dry-run writes nothing and prints the approval digest and expected totals", async () => {
    const before = await unrelatedSnapshot();
    const output = await provision({ mode: "dry-run", rawSpec: world.specRaw });
    expect(output.join("\n")).toContain(`digest=${world.digest}`);
    expect(output.join("\n")).toContain(
      "sales=436 orders=4 refunds=3 sales_amount=38690.00 refund_amount=60.00 net_revenue=38630.00",
    );
    expect(await unrelatedSnapshot()).toBe(before);
    expect(await prisma.demoDatasetRun.count()).toBe(0);
    expect(await prisma.organization.count()).toBe(1);
  });

  it("refuses apply without the exact digest, on another database, and for unusable or reused identities", async () => {
    await expect(
      provision({ mode: "apply", rawSpec: world.specRaw }),
    ).rejects.toThrow(/DIGEST_MISMATCH/);
    await expect(
      provision({
        mode: "apply",
        rawSpec: world.specRaw,
        confirmDigest: "0000000000000000",
      }),
    ).rejects.toThrow(/DIGEST_MISMATCH/);
    const wrongDatabase = JSON.stringify({
      ...JSON.parse(world.specRaw),
      database: "some_other_demo",
    });
    await expect(
      provision({ mode: "dry-run", rawSpec: wrongDatabase }),
    ).rejects.toThrow(/DATABASE_MISMATCH/);
    const reused = JSON.stringify({
      ...JSON.parse(world.specRaw),
      organization: { id: randomUUID(), name: "UAT Demo Siam Mart" },
    });
    await expect(
      provision({ mode: "dry-run", rawSpec: reused }),
    ).rejects.toThrow(/SPEC_INVALID/);
    const collision = JSON.stringify({
      ...JSON.parse(world.specRaw),
      organization: { id: randomUUID(), name: "existing production org" },
    });
    await expect(
      provision({ mode: "dry-run", rawSpec: collision }),
    ).rejects.toThrow(/ORGANIZATION_NAME_IN_USE/);
    const unknownMember = JSON.parse(world.specRaw);
    unknownMember.members[4].emailSha256 = sha("nobody@example.invalid");
    await expect(
      provision({ mode: "dry-run", rawSpec: JSON.stringify(unknownMember) }),
    ).rejects.toThrow(/MEMBER_ACCOUNT_NOT_USABLE/);
    const future = JSON.parse(world.specRaw);
    future.referenceDate = "2099-01-01";
    await expect(
      provision({ mode: "dry-run", rawSpec: JSON.stringify(future) }),
    ).rejects.toThrow(/INCOMPLETE_OR_FUTURE_DAY/);
    for (const bad of [
      (s: Loose) => (s.members[0]!.role = "ADMIN"),
      (s: Loose) => (s.members[1]!.branchCodes = ["MAIN"]),
      (s: Loose) => (s.products[0]!.basePrice = "0"),
      (s: Loose) => (s.extra = true),
    ]) {
      const broken = JSON.parse(world.specRaw);
      bad(broken);
      await expect(
        provision({ mode: "dry-run", rawSpec: JSON.stringify(broken) }),
      ).rejects.toThrow(/SPEC_INVALID/);
    }
    expect(await prisma.demoDatasetRun.count()).toBe(0);
  });

  it("refuses an account without a usable credential", async () => {
    await resetTestDatabase(environment);
    world = await createWorld(() => {}, false);
    await expect(
      provision({ mode: "dry-run", rawSpec: world.specRaw }),
    ).rejects.toThrow(/MEMBER_ACCOUNT_NOT_USABLE/);
  });
});

describe("Production demo import, frozen Demo Insight and live POS", () => {
  const request = (
    role: (typeof roles)[number],
    language: "en" | "th" = "en",
    scope: { kind: "organization" } | { kind: "branch"; branchId: string } = {
      kind: "organization",
    },
  ) => ({
    actorUserId: world.users[role],
    organizationId: world.spec.organization.id,
    scope,
    language,
  });
  const reader = () => createProductionDemoInsightReader({ prisma });

  beforeAll(async () => {
    await resetTestDatabase(environment);
    world = await createWorld();
  }, 60_000);

  it("applies, reconciles and leaves unrelated data and accounts untouched", async () => {
    const before = await unrelatedSnapshot();
    const output = await provision({
      mode: "apply",
      rawSpec: world.specRaw,
      confirmDigest: world.digest,
    });
    expect(output.join("\n")).toContain("CENSUS tables=20 changed=none");
    expect(output.join("\n")).toContain(
      "RECONCILED sales=436 net_revenue=38630.00 refunds=3 ledger_net=38630.00",
    );
    expect(await unrelatedSnapshot()).toBe(before);
    const organizationId = world.spec.organization.id;
    expect(await prisma.sale.count({ where: { organizationId } })).toBe(436);
    expect(await prisma.payment.count({ where: { organizationId } })).toBe(436);
    expect(
      await prisma.purchaseReceipt.count({ where: { organizationId } }),
    ).toBe(4);
    expect(await prisma.saleRefund.count({ where: { organizationId } })).toBe(
      3,
    );
    expect(
      await prisma.inventoryTransaction.count({ where: { organizationId } }),
    ).toBe(899);
    expect(
      await prisma.organizationMembership.count({
        where: { organizationId, role: "OWNER", status: "ACTIVE" },
      }),
    ).toBe(1);
    expect(
      await prisma.organizationMembership.count({
        where: { organizationId, status: "ACTIVE" },
      }),
    ).toBe(5);
    const balances = await prisma.$queryRaw<Array<{ bad: bigint }>>`
      SELECT count(*) AS bad FROM inventory_balances b
      WHERE b.organization_id = ${organizationId}::uuid
        AND (b.quantity < 0 OR b.quantity <> coalesce((SELECT sum(delta) FROM inventory_transactions t
             WHERE t.branch_id = b.branch_id AND t.product_id = b.product_id), 0))`;
    expect(Number(balances[0]!.bad)).toBe(0);
    // Memberships of the shared presenter accounts elsewhere are unchanged.
    expect(
      await prisma.organizationMembership.count({
        where: { userId: world.users.OWNER },
      }),
    ).toBe(2);
  }, 180_000);

  it("rejects mutation of COMPLETE provenance and deletion, even for a privileged writer", async () => {
    const organizationId = world.spec.organization.id;
    await expect(
      prisma.demoDatasetRun.update({
        where: { organizationId },
        data: { name: "Renamed" },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.$executeRaw`UPDATE demo_dataset_runs SET history_digest = repeat('0', 64) WHERE organization_id = ${organizationId}::uuid`,
    ).rejects.toThrow();
    await expect(
      prisma.$executeRaw`DELETE FROM demo_dataset_runs WHERE organization_id = ${organizationId}::uuid`,
    ).rejects.toThrow();
    // A forged COMPLETE row cannot be inserted directly either.
    await expect(
      prisma.demoDatasetRun.create({
        data: {
          organizationId: world.other.organizationId,
          name: "Existing Production Org",
          signature: "0".repeat(64),
          plan: {},
          state: "COMPLETE",
          baseline: {},
          historyDigest: "0".repeat(64),
          completedAt: new Date(),
        },
      }),
    ).rejects.toThrow();
    expect(
      await prisma.demoDatasetRun.count({
        where: { organizationId: world.other.organizationId },
      }),
    ).toBe(0);
    const run = await prisma.demoDatasetRun.findUniqueOrThrow({
      where: { organizationId },
    });
    expect(run.state).toBe("COMPLETE");
  });

  it("serves the verified baseline in English and Thai for every authorized scope, with no provider call or AI rows", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Outbound provider forbidden"));
    try {
      const en = await reader().read(request("OWNER"));
      expect(en.kind).toBe("success");
      if (en.kind !== "success") return;
      const insight = en.insight as Insight;
      expect(insight.label).toBe("Demo Insight");
      expect(insight.providerCalls).toBe(0);
      expect(insight.provider).toBeNull();
      expect(insight.metrics.saleCount).toBe(436);
      expect(insight.metrics.netRevenue).toBe("38630.00");
      expect(insight.metrics.growthPercent).toBe("-0.57");
      expect(insight.metrics.topProducts).toEqual([
        { name: "Daily Rice", unit: "EA", quantity: "879.0000" },
      ]);
      expect(insight.metrics.lowStock.map((p) => p.onHand).sort()).toEqual([
        "2.0000",
        "5.0000",
      ]);
      expect(
        insight.metrics.replenishment.map((p) => p.quantity).sort(),
      ).toEqual(["104.0000", "95.0000"]);
      expect(insight.content).toContain(
        "Net revenue 38630.00 THB from 436 sales.",
      );
      expect(insight.explanation).toContain(
        "fixed, verified historical baseline",
      );
      expect(insight.explanation).toContain("Not generated by OpenRouter");
      const th = (await reader().read(request("OWNER", "th"))) as unknown as {
        insight: Insight;
      };
      expect(th.insight.label).toBe("ข้อมูลตัวอย่าง");
      expect(th.insight.metrics).toEqual(insight.metrics);
      expect(th.insight.content).toContain(
        "รายได้สุทธิ 38630.00 THB จาก 436 รายการขาย",
      );
      for (const role of ["ADMIN", "BRANCH_MANAGER"] as const)
        expect((await reader().read(request(role))).kind).toBe(
          role === "BRANCH_MANAGER" ? "forbidden" : "success",
        );
      const main = world.spec.branches[0]!.id;
      const north = world.spec.branches[1]!.id;
      const mainInsight = await reader().read(
        request("BRANCH_MANAGER", "en", { kind: "branch", branchId: main }),
      );
      expect(mainInsight.kind).toBe("success");
      if (mainInsight.kind === "success")
        expect((mainInsight.insight as Insight).metrics.saleCount).toBeLessThan(
          436,
        );
      expect(
        (
          await reader().read(
            request("BRANCH_MANAGER", "en", {
              kind: "branch",
              branchId: north,
            }),
          )
        ).kind,
      ).toBe("forbidden");
      expect((await reader().read(request("CASHIER"))).kind).toBe("forbidden");
      expect((await reader().read(request("INVENTORY_STAFF"))).kind).toBe(
        "forbidden",
      );
      // An unrelated organization (even for its own OWNER) has no provenance.
      expect(
        (
          await reader().read({
            actorUserId: world.users.OWNER,
            organizationId: world.other.organizationId,
            scope: { kind: "organization" },
            language: "en",
          })
        ).kind,
      ).toBe("not_found");
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(await prisma.aiInsightReport.count()).toBe(0);
      expect(await prisma.aiInsightAttempt.count()).toBe(0);
      expect(await prisma.analyticsSnapshot.count()).toBe(0);
      // The composed reader answers from the Production reader when the local one has no match.
      const composed = composeDemoInsightReaders(
        { read: async () => ({ kind: "not_found" as const }) },
        reader(),
      );
      expect((await composed.read(request("OWNER"))).kind).toBe("success");
    } finally {
      fetchSpy.mockRestore();
    }
  }, 120_000);

  it("keeps the historical Demo Insight stable after live POS, adjustment, price edit and refund", async () => {
    const organizationId = world.spec.organization.id;
    const before = JSON.stringify(await reader().read(request("OWNER")));
    const branchId = world.spec.branches[0]!.id;
    const tea = world.spec.products[1]!;
    const checkout = await createPrismaCheckoutRepository(prisma).checkout({
      actorUserId: world.users.CASHIER,
      organizationId,
      branchId,
      idempotencyKey: `live-pos-${randomUUID()}`,
      discount: null,
      items: [
        {
          productId: tea.id,
          quantity: "1",
          expectedUnitPrice: new Prisma.Decimal(tea.basePrice).toFixed(4),
        },
      ],
      payment: { method: "CASH", amountTendered: "30.00" },
    });
    expect(checkout.kind).toBe("success");
    const adjusted = await createPrismaInventoryRepository(prisma).adjust({
      actorUserId: world.users.OWNER,
      branchId,
      organizationId,
      idempotencyKey: `live-adjust-${randomUUID()}`,
      adjustment: inventoryAdjustmentBodySchema.parse({
        delta: "3",
        productId: tea.id,
        reason: "FOUND",
      }),
    });
    expect(adjusted.kind).toBe("success");
    await prisma.product.update({
      where: { id: tea.id },
      data: { basePrice: "99" },
    });
    const historical = await prisma.sale.findFirstOrThrow({
      where: {
        organizationId,
        branchId,
        completedAt: { lt: new Date() },
        payment: { is: { method: "CASH" } },
        refunds: { none: {} },
        items: { some: { productId: tea.id } },
      },
      include: { items: true },
    });
    const refunded = await createPrismaRefundRepository(prisma).createRefund({
      actorUserId: world.users.OWNER,
      organizationId,
      branchId,
      idempotencyKey: `live-refund-${randomUUID()}`,
      saleId: historical.id,
      reason: "Live demonstration return",
      transferReference: null,
      items: [
        {
          saleItemId: historical.items.find((i) => i.productId === tea.id)!.id,
          quantity: "1",
          restockQuantity: "0",
        },
      ],
    });
    expect(refunded.kind).toBe("success");
    // New activity is real and visible to normal data, distinct from the baseline.
    expect(await prisma.sale.count({ where: { organizationId } })).toBe(437);
    expect(await prisma.saleRefund.count({ where: { organizationId } })).toBe(
      4,
    );
    expect(JSON.stringify(await reader().read(request("OWNER")))).toBe(before);
    expect(
      JSON.stringify(await reader().read(request("OWNER", "th"))),
    ).toContain("38630.00");
    // An operator rerun after live trading verifies the immutable window and is a no-op.
    expect(
      (
        await provision({
          mode: "apply",
          rawSpec: world.specRaw,
          confirmDigest: world.digest,
        })
      ).join("\n"),
    ).toContain("ALREADY_COMPLETE");
  }, 120_000);

  it("fails closed when any historical event changes", async () => {
    const organizationId = world.spec.organization.id;
    await prisma.$executeRaw`ALTER TABLE purchase_orders DISABLE TRIGGER USER`;
    try {
      await prisma.$executeRaw`UPDATE purchase_orders SET updated_at = updated_at + interval '1 second' WHERE organization_id = ${organizationId}::uuid AND id = (SELECT id FROM purchase_orders WHERE organization_id = ${organizationId}::uuid ORDER BY id LIMIT 1)`;
      expect((await reader().read(request("OWNER"))).kind).toBe("not_found");
    } finally {
      await prisma.$executeRaw`ALTER TABLE purchase_orders ENABLE TRIGGER USER`;
    }
  });
});

describe("Production demo import recovery", () => {
  beforeEach(async () => {
    await resetTestDatabase(environment);
    world = await createWorld();
  }, 60_000);

  it("resumes an interrupted import to the identical result and then reruns as a no-op", async () => {
    await expect(
      provision({
        mode: "apply",
        rawSpec: world.specRaw,
        confirmDigest: world.digest,
        maximumRunMilliseconds: 3_000,
      }),
    ).rejects.toThrow();
    const organizationId = world.spec.organization.id;
    const partial = await prisma.sale.count({ where: { organizationId } });
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(436);
    const run = await prisma.demoDatasetRun.findUniqueOrThrow({
      where: { organizationId },
    });
    expect(run.state).toBe("IN_PROGRESS");
    // Until completion only the OWNER (the import actor) is live.
    expect(
      await prisma.organizationMembership.count({
        where: { organizationId, status: "ACTIVE" },
      }),
    ).toBe(1);
    await provision({
      mode: "apply",
      rawSpec: world.specRaw,
      confirmDigest: world.digest,
    });
    expect(await prisma.sale.count({ where: { organizationId } })).toBe(436);
    expect(
      await prisma.inventoryTransaction.count({ where: { organizationId } }),
    ).toBe(899);
    const fingerprint = JSON.stringify(
      await prisma.$queryRaw`SELECT (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM sales t WHERE t.organization_id = ${organizationId}::uuid) s`,
    );
    const output = await provision({
      mode: "apply",
      rawSpec: world.specRaw,
      confirmDigest: world.digest,
    });
    expect(output.join("\n")).toContain("ALREADY_COMPLETE");
    expect(
      JSON.stringify(
        await prisma.$queryRaw`SELECT (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM sales t WHERE t.organization_id = ${organizationId}::uuid) s`,
      ),
    ).toBe(fingerprint);
  }, 180_000);

  it("keeps two concurrent applies from duplicating any fact", async () => {
    const input = {
      mode: "apply" as const,
      rawSpec: world.specRaw,
      confirmDigest: world.digest,
    };
    await Promise.all([provision(input), provision(input)]);
    const organizationId = world.spec.organization.id;
    expect(await prisma.sale.count({ where: { organizationId } })).toBe(436);
    expect(
      await prisma.purchaseReceipt.count({ where: { organizationId } }),
    ).toBe(4);
    expect(await prisma.saleRefund.count({ where: { organizationId } })).toBe(
      3,
    );
    expect(
      await prisma.inventoryTransaction.count({ where: { organizationId } }),
    ).toBe(899);
  }, 240_000);

  it("refuses to adopt an existing organization without provenance", async () => {
    await prisma.organization.create({
      data: {
        id: world.spec.organization.id,
        name: world.spec.organization.name,
        salesVatStatus: "NOT_REGISTERED",
      },
    });
    await expect(
      provision({ mode: "dry-run", rawSpec: world.specRaw }),
    ).rejects.toThrow(/ORGANIZATION_EXISTS_WITHOUT_PROVENANCE/);
  });

  it("retires only the demo organization, keeps its OWNER and works without the presenter accounts", async () => {
    await provision({
      mode: "apply",
      rawSpec: world.specRaw,
      confirmDigest: world.digest,
    });
    const before = await unrelatedSnapshot();
    // The presenter credentials may be gone by the time an operator must retire.
    await prisma.betterAuthAccount.deleteMany({
      where: { userId: world.users.CASHIER },
    });
    await expect(
      provision({
        mode: "retire",
        rawSpec: world.specRaw,
        confirmDigest: world.digest,
      }),
    ).rejects.toThrow(/DIGEST_MISMATCH/);
    await provision({
      mode: "retire",
      rawSpec: world.specRaw,
      confirmDigest: world.retireDigest,
    });
    const organizationId = world.spec.organization.id;
    expect(
      (
        await prisma.organization.findUniqueOrThrow({
          where: { id: organizationId },
        })
      ).status,
    ).toBe("INACTIVE");
    expect(
      await prisma.organizationMembership.count({
        where: { organizationId, status: "ACTIVE" },
      }),
    ).toBe(1);
    expect(
      await prisma.organizationMembership.count({
        where: { organizationId, role: "OWNER", status: "ACTIVE" },
      }),
    ).toBe(1);
    expect(await prisma.sale.count({ where: { organizationId } })).toBe(436);
    expect(await unrelatedSnapshot()).toBe(before);
    expect(
      (
        await createProductionDemoInsightReader({ prisma }).read({
          actorUserId: world.users.OWNER,
          organizationId,
          scope: { kind: "organization" },
          language: "en",
        })
      ).kind,
    ).toBe("forbidden");
  }, 180_000);

  it("refuses to resume when staged master data or members differ from the approved spec", async () => {
    await expect(
      provision({
        mode: "apply",
        rawSpec: world.specRaw,
        confirmDigest: world.digest,
        maximumRunMilliseconds: 3_000,
      }),
    ).rejects.toThrow();
    const changed = JSON.parse(world.specRaw);
    changed.branches[0].name = "Renamed branch";
    const sink = lines();
    await runProvision(
      prisma,
      { mode: "dry-run", rawSpec: JSON.stringify(changed) },
      sink.write,
    );
    const digest = /SPEC digest=([0-9a-f]{16})/.exec(
      sink.output.join("\n"),
    )![1]!;
    await expect(
      provision({
        mode: "apply",
        rawSpec: JSON.stringify(changed),
        confirmDigest: digest,
      }),
    ).rejects.toThrow(/STAGED_DATA_DIFFERS_FROM_SPEC/);
    expect(
      await prisma.organizationMembership.count({
        where: { organizationId: world.spec.organization.id, status: "ACTIVE" },
      }),
    ).toBe(1);
  }, 120_000);
});
