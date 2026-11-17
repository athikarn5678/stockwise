import { randomUUID } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { Prisma } from "../../generated/prisma/client.ts";
import { loadTestDatabaseEnvironment } from "../../test/database-environment.ts";
import {
  createTestPrismaClient,
  resetTestDatabase,
} from "../../test/database-harness.ts";
import {
  createPrismaCheckoutRepository,
  type CheckoutInput,
} from "./checkout-repository.ts";

const environment = loadTestDatabaseEnvironment();
const prisma = createTestPrismaClient(environment);
const completedAt = new Date("2026-11-17T10:00:00.000Z");
const repository = createPrismaCheckoutRepository(prisma, {
  now: () => completedAt,
});

type Role = "OWNER" | "BRANCH_MANAGER" | "CASHIER" | "INVENTORY_STAFF";
type Discount = CheckoutInput["discount"];

async function createActor(input: {
  branchId: string;
  organizationId: string;
  role: Role;
}) {
  const user = await prisma.user.create({
    data: {
      displayName: `${input.role} Employee`,
      email: `${randomUUID()}@example.com`,
    },
  });
  await prisma.organizationMembership.create({
    data: {
      organizationId: input.organizationId,
      role: input.role,
      userId: user.id,
    },
  });
  if (input.role !== "OWNER") {
    await prisma.branchAssignment.create({
      data: {
        branchId: input.branchId,
        organizationId: input.organizationId,
        userId: user.id,
      },
    });
  }
  return user;
}

async function createScope(input: {
  prices: readonly string[];
  salesVatStatus: "UNCONFIGURED" | "NOT_REGISTERED" | "REGISTERED";
  stock?: string;
}) {
  const organization = await prisma.organization.create({
    data: {
      name: `PromptPay ${randomUUID().slice(0, 8)}`,
      salesVatRate: input.salesVatStatus === "REGISTERED" ? "7" : null,
      salesVatStatus: input.salesVatStatus,
    },
  });
  const branch = await prisma.branch.create({
    data: {
      code: `BR-${randomUUID().slice(0, 8)}`,
      name: "PromptPay Branch",
      organizationId: organization.id,
    },
  });
  const products = [];
  for (const [index, price] of input.prices.entries()) {
    const product = await prisma.product.create({
      data: {
        basePrice: price,
        name: `PromptPay Product ${index + 1}`,
        organizationId: organization.id,
        sku: `${randomUUID().slice(0, 8)}-P${index + 1}`.toUpperCase(),
        unit: "EA",
      },
    });
    await prisma.inventoryBalance.create({
      data: {
        branchId: branch.id,
        organizationId: organization.id,
        productId: product.id,
        quantity: input.stock ?? "50",
      },
    });
    await prisma.inventoryCostState.create({
      data: {
        averageUnitCost: "2",
        basisState: "KNOWN",
        branchId: branch.id,
        inventoryValue: new Prisma.Decimal(input.stock ?? "50").times(2),
        organizationId: organization.id,
        productId: product.id,
      },
    });
    products.push(product);
  }
  const owner = await createActor({
    branchId: branch.id,
    organizationId: organization.id,
    role: "OWNER",
  });
  return { branch, organization, owner, products };
}

type Scope = Awaited<ReturnType<typeof createScope>>;

function cartOf(
  scope: Scope,
  quantities: readonly string[],
  prices?: readonly string[],
) {
  return scope.products.map((product, index) => ({
    expectedUnitPrice: prices?.[index] ?? product.basePrice.toString(),
    productId: product.id,
    quantity: quantities[index] ?? "1",
  }));
}

const quoteInput = (
  scope: Scope,
  items: ReturnType<typeof cartOf>,
  discount: Discount = null,
  actorUserId = scope.owner.id,
) => ({
  actorUserId,
  branchId: scope.branch.id,
  discount,
  items,
  organizationId: scope.organization.id,
});

const promptPayCheckout = (
  scope: Scope,
  items: ReturnType<typeof cartOf>,
  expectedTotalAmount: string | undefined,
  discount: Discount = null,
  key = `promptpay-${randomUUID()}`,
  actorUserId = scope.owner.id,
): CheckoutInput => ({
  actorUserId,
  branchId: scope.branch.id,
  discount,
  idempotencyKey: key,
  items,
  organizationId: scope.organization.id,
  payment: {
    ...(expectedTotalAmount === undefined ? {} : { expectedTotalAmount }),
    method: "TRANSFER",
    reference: "PromptPay",
  },
});

async function writes() {
  const balances = await prisma.inventoryBalance.findMany({
    orderBy: { productId: "asc" },
    select: { productId: true, quantity: true },
  });
  return {
    balances: balances.map((b) => `${b.productId}:${b.quantity.toFixed(4)}`),
    inventoryTransactions: await prisma.inventoryTransaction.count(),
    payments: await prisma.payment.count(),
    saleItems: await prisma.saleItem.count(),
    sales: await prisma.sale.count(),
  };
}

function bump(total: string, cents: number): string {
  return new Prisma.Decimal(total)
    .plus(new Prisma.Decimal(cents).div(100))
    .toFixed(2);
}

describe("PromptPay quote and amount-bound checkout with PostgreSQL", () => {
  beforeEach(async () => resetTestDatabase(environment));
  afterAll(async () => {
    await resetTestDatabase(environment);
    await prisma.$disconnect();
  });

  it.each([
    {
      label: "NOT_REGISTERED without a discount",
      status: "NOT_REGISTERED" as const,
      discount: null,
      prices: ["60.1234", "10"],
      quantities: ["2", "3"],
    },
    {
      label: "REGISTERED VAT with a PERCENT discount",
      status: "REGISTERED" as const,
      discount: { percent: "12.5", reason: "Promo", type: "PERCENT" } as const,
      prices: ["107", "35.50"],
      quantities: ["3", "1"],
    },
    {
      label: "REGISTERED VAT with an AMOUNT discount",
      status: "REGISTERED" as const,
      discount: { amount: "5.00", reason: "Loyalty", type: "AMOUNT" } as const,
      prices: ["19.99", "250"],
      quantities: ["4", "2"],
    },
  ])(
    "quotes exactly what checkout charges: $label",
    async ({ status, discount, prices, quantities }) => {
      const scope = await createScope({ prices, salesVatStatus: status });
      const items = cartOf(scope, quantities);
      const quote = await repository.quote(quoteInput(scope, items, discount));
      expect(quote.kind).toBe("success");
      if (quote.kind !== "success") return;

      const sale = await repository.checkout(
        promptPayCheckout(scope, items, quote.totalAmount, discount),
      );
      expect(sale.kind).toBe("success");
      if (sale.kind !== "success") return;
      expect(sale.sale.totalAmount).toBe(quote.totalAmount);
      expect(sale.sale.payment).toEqual({
        amount: quote.totalAmount,
        amountTendered: null,
        changeAmount: null,
        method: "TRANSFER",
        reference: "PromptPay",
      });
    },
  );

  it("changes nothing when a quote is requested: no sale, payment, ledger row or stock movement before confirm", async () => {
    const scope = await createScope({
      prices: ["60", "15"],
      salesVatStatus: "REGISTERED",
    });
    const before = await writes();
    const quote = await repository.quote(
      quoteInput(scope, cartOf(scope, ["2", "4"])),
    );
    expect(quote.kind).toBe("success");
    // Asking again and again is just as inert.
    await repository.quote(quoteInput(scope, cartOf(scope, ["2", "4"])));
    expect(await writes()).toEqual(before);
    expect(before.sales).toBe(0);
  });

  it.each([
    ["one cent too high", 1],
    ["one cent too low", -1],
    ["ten baht too low", -1000],
  ])(
    "rejects a tampered QR amount (%s) with no sale and no stock change",
    async (_label, cents) => {
      const scope = await createScope({
        prices: ["60", "15"],
        salesVatStatus: "REGISTERED",
      });
      const items = cartOf(scope, ["2", "4"]);
      const quote = await repository.quote(quoteInput(scope, items));
      if (quote.kind !== "success") throw new Error("quote failed");
      const before = await writes();

      const result = await repository.checkout(
        promptPayCheckout(scope, items, bump(quote.totalAmount, cents)),
      );
      expect(result).toEqual({ kind: "total_mismatch" });
      expect(await writes()).toEqual(before);
      expect(before.sales).toBe(0);
    },
  );

  it("rejects an amount the cart no longer matches after the cart changed behind the QR", async () => {
    const scope = await createScope({
      prices: ["60", "15"],
      salesVatStatus: "NOT_REGISTERED",
    });
    const quote = await repository.quote(
      quoteInput(scope, cartOf(scope, ["2", "4"])),
    );
    if (quote.kind !== "success") throw new Error("quote failed");
    const before = await writes();
    // The cashier added one more unit after the QR was shown.
    const result = await repository.checkout(
      promptPayCheckout(scope, cartOf(scope, ["3", "4"]), quote.totalAmount),
    );
    expect(result).toEqual({ kind: "total_mismatch" });
    expect(await writes()).toEqual(before);
  });

  it("recomputes from the authoritative price: a price change after the QR is a price conflict, never a silent new total", async () => {
    const scope = await createScope({
      prices: ["60"],
      salesVatStatus: "NOT_REGISTERED",
    });
    const items = cartOf(scope, ["2"]);
    const quote = await repository.quote(quoteInput(scope, items));
    if (quote.kind !== "success") throw new Error("quote failed");
    await prisma.product.update({
      data: { basePrice: "70" },
      where: { id: scope.products[0]!.id },
    });
    const before = await writes();
    expect(
      await repository.checkout(
        promptPayCheckout(scope, items, quote.totalAmount),
      ),
    ).toEqual({ kind: "price_changed" });
    expect(await repository.quote(quoteInput(scope, items))).toEqual({
      kind: "price_changed",
    });
    // Even a client that refreshed its price but kept the old QR amount is refused.
    expect(
      await repository.checkout(
        promptPayCheckout(
          scope,
          cartOf(scope, ["2"], ["70"]),
          quote.totalAmount,
        ),
      ),
    ).toEqual({ kind: "total_mismatch" });
    expect(await writes()).toEqual(before);
  });

  it("rejects a malformed shown amount without touching data", async () => {
    const scope = await createScope({
      prices: ["60"],
      salesVatStatus: "NOT_REGISTERED",
    });
    const items = cartOf(scope, ["1"]);
    for (const bad of ["abc", "-60.00", "60.001", ""]) {
      expect(
        await repository.checkout(promptPayCheckout(scope, items, bad)),
      ).toEqual({ kind: "invalid_payment" });
    }
    expect((await writes()).sales).toBe(0);
  });

  it("binds the shown amount to the idempotency key: identical retry replays, a different amount conflicts", async () => {
    const scope = await createScope({
      prices: ["60"],
      salesVatStatus: "NOT_REGISTERED",
    });
    const items = cartOf(scope, ["1"]);
    const key = `promptpay-key-${randomUUID()}`;
    const first = await repository.checkout(
      promptPayCheckout(scope, items, "60.00", null, key),
    );
    expect(first.kind).toBe("success");
    const replay = await repository.checkout(
      promptPayCheckout(scope, items, "60.00", null, key),
    );
    expect(replay.kind).toBe("replay");
    expect(
      await repository.checkout(
        promptPayCheckout(scope, items, "61.00", null, key),
      ),
    ).toEqual({ kind: "idempotency_conflict" });
    expect(
      await repository.checkout(
        promptPayCheckout(scope, items, undefined, null, key),
      ),
    ).toEqual({ kind: "idempotency_conflict" });
    expect((await writes()).sales).toBe(1);
  });

  it("applies the checkout authorization, stock, VAT and discount rules to quotes", async () => {
    const scope = await createScope({
      prices: ["60"],
      salesVatStatus: "NOT_REGISTERED",
      stock: "2",
    });
    const items = cartOf(scope, ["1"]);
    const cashier = await createActor({
      branchId: scope.branch.id,
      organizationId: scope.organization.id,
      role: "CASHIER",
    });
    const inventory = await createActor({
      branchId: scope.branch.id,
      organizationId: scope.organization.id,
      role: "INVENTORY_STAFF",
    });
    const stranger = await createScope({
      prices: ["1"],
      salesVatStatus: "NOT_REGISTERED",
    });

    // A cashier may sell and quote, but may not apply a discount.
    expect(
      (await repository.quote(quoteInput(scope, items, null, cashier.id))).kind,
    ).toBe("success");
    expect(
      await repository.quote(
        quoteInput(
          scope,
          items,
          { amount: "1.00", reason: "Nope", type: "AMOUNT" },
          cashier.id,
        ),
      ),
    ).toEqual({ kind: "forbidden" });
    // Roles without checkout permission and other tenants are refused.
    expect(
      await repository.quote(quoteInput(scope, items, null, inventory.id)),
    ).toEqual({ kind: "forbidden" });
    expect(
      await repository.quote(quoteInput(scope, items, null, stranger.owner.id)),
    ).toEqual({ kind: "forbidden" });
    // More than the branch holds cannot be quoted.
    expect(
      await repository.quote(quoteInput(scope, cartOf(scope, ["3"]))),
    ).toEqual({ kind: "insufficient_stock" });
    // Duplicate lines and unknown products fail like checkout does.
    expect(
      (await repository.quote(quoteInput(scope, [...items, ...items]))).kind,
    ).toBe("duplicate_product");
    expect(
      (
        await repository.quote(
          quoteInput(scope, [{ ...items[0]!, productId: randomUUID() }]),
        )
      ).kind,
    ).toBe("not_found");

    await prisma.organization.update({
      data: { salesVatRate: null, salesVatStatus: "UNCONFIGURED" },
      where: { id: scope.organization.id },
    });
    expect(await repository.quote(quoteInput(scope, items))).toEqual({
      kind: "vat_configuration_required",
    });
  });
});
