import { createHash, randomUUID } from "node:crypto";

import { Prisma, type PrismaClient } from "../../generated/prisma/client.ts";
import {
  can,
  createTrustedAuthorizationContext,
  createTrustedBranchScope,
  PERMISSIONS,
} from "../identity/authorization-policy.ts";
import { inventoryBalanceAdvisoryLockKey } from "../inventory/inventory-repository.ts";
import {
  canonicalQuantity,
  inventoryQuantityFitsStorage,
} from "../inventory/inventory-values.ts";
import {
  calculateCheckoutAmounts,
  canonicalizeCheckoutIntent,
  checkoutCanonicalRequestHash,
  checkoutIdempotencyKeyHash,
  documentMoneyFitsStorage,
  exactCheckoutDecimal,
  validCheckoutIdempotencyKey,
  type CheckoutIntentInput,
} from "./checkout-values.ts";

type Transaction = Prisma.TransactionClient;

export interface CheckoutInput extends CheckoutIntentInput {
  actorUserId: string;
  branchId: string;
  idempotencyKey: string;
  organizationId: string;
}

export interface SafeCheckoutSaleItem {
  id: string;
  lineDiscount: string;
  lineGross: string;
  lineNet: string;
  lineOutputVat: string;
  lineTaxable: string | null;
  nameSnapshot: string;
  productId: string;
  quantity: string;
  skuSnapshot: string;
  unitPrice: string;
  unitSnapshot: string;
}

export type SafeCheckoutDiscount =
  | { amount: string; reason: string; type: "AMOUNT" }
  | { percent: string; reason: string; type: "PERCENT" }
  | null;

export type SafeCheckoutPayment =
  | {
      amount: string;
      amountTendered: string;
      changeAmount: string;
      method: "CASH";
      reference: null;
    }
  | {
      amount: string;
      amountTendered: null;
      changeAmount: null;
      method: "TRANSFER";
      reference: string | null;
    };

export interface SafeCheckoutSale {
  actorDisplayNameSnapshot: string;
  branchCodeSnapshot: string;
  branchId: string;
  branchNameSnapshot: string;
  currency: "THB";
  discount: SafeCheckoutDiscount;
  discountAmount: string;
  id: string;
  items: SafeCheckoutSaleItem[];
  occurredAt: string;
  organizationId: string;
  organizationNameSnapshot: string;
  outputVatAmount: string;
  payment: SafeCheckoutPayment;
  reference: string;
  salesVatStatusSnapshot: "NOT_REGISTERED" | "REGISTERED";
  subtotalAmount: string;
  taxableAmount: string | null;
  totalAmount: string;
  vatRateSnapshot: string | null;
}

export type CheckoutOutcome =
  | { kind: "success"; sale: SafeCheckoutSale }
  | { kind: "replay"; sale: SafeCheckoutSale }
  | { kind: "forbidden" }
  | { kind: "not_found" }
  | { kind: "branch_inactive" }
  | { kind: "product_inactive" }
  | { kind: "duplicate_product" }
  | { kind: "invalid_idempotency_key" }
  | { kind: "invalid_quantity" }
  | { kind: "invalid_price" }
  | { kind: "price_changed" }
  | { kind: "invalid_discount" }
  | { kind: "invalid_payment" }
  | { kind: "invalid_amounts" }
  | { kind: "total_mismatch" }
  | { kind: "vat_configuration_required" }
  | { kind: "insufficient_stock" }
  | { kind: "idempotency_conflict" };

/** Read-only quote of what `checkout` would charge for the same cart. */
export interface CheckoutQuoteInput {
  actorUserId: string;
  branchId: string;
  discount: CheckoutIntentInput["discount"];
  items: CheckoutIntentInput["items"];
  organizationId: string;
}

export type CheckoutQuoteOutcome =
  | { kind: "success"; totalAmount: string }
  | Exclude<
      CheckoutOutcome,
      | { kind: "success" }
      | { kind: "replay" }
      | { kind: "idempotency_conflict" }
      | { kind: "invalid_idempotency_key" }
      | { kind: "invalid_payment" }
      | { kind: "total_mismatch" }
    >;

export interface CheckoutRepository {
  checkout(input: CheckoutInput): Promise<CheckoutOutcome>;
  quote(input: CheckoutQuoteInput): Promise<CheckoutQuoteOutcome>;
}

export interface CheckoutRepositoryOptions {
  afterLineCommitted?: (lineIndex: number) => Promise<void> | void;
  now?: () => Date;
}

const saleItemSelection = {
  id: true,
  lineDiscount: true,
  lineGross: true,
  lineNet: true,
  lineOutputVat: true,
  lineTaxable: true,
  productId: true,
  productNameSnapshot: true,
  productSkuSnapshot: true,
  productUnitSnapshot: true,
  quantity: true,
  unitPrice: true,
} satisfies Prisma.SaleItemSelect;

const paymentSelection = {
  amount: true,
  amountTendered: true,
  changeAmount: true,
  method: true,
  transferReference: true,
} satisfies Prisma.PaymentSelect;

const saleSelection = {
  actorDisplayNameSnapshot: true,
  branchCodeSnapshot: true,
  branchId: true,
  branchNameSnapshot: true,
  canonicalRequestHash: true,
  completedAt: true,
  currency: true,
  discountAmount: true,
  discountAmountInput: true,
  discountPercentInput: true,
  discountReason: true,
  discountType: true,
  id: true,
  items: {
    orderBy: [{ productId: "asc" }],
    select: saleItemSelection,
  },
  organizationId: true,
  organizationNameSnapshot: true,
  outputVatAmount: true,
  payment: { select: paymentSelection },
  reference: true,
  salesVatRateSnapshot: true,
  salesVatStatusSnapshot: true,
  subtotalAmount: true,
  taxableAmount: true,
  totalAmount: true,
} satisfies Prisma.SaleSelect;

type SelectedSale = Prisma.SaleGetPayload<{ select: typeof saleSelection }>;

function safeDiscount(sale: SelectedSale): SafeCheckoutDiscount {
  if (sale.discountType === null) return null;
  if (sale.discountReason === null) {
    throw new Error("Discounted Sale is missing its reason snapshot.");
  }
  if (sale.discountType === "AMOUNT") {
    if (sale.discountAmountInput === null) {
      throw new Error("Amount discount is missing its entered amount.");
    }
    return {
      amount: sale.discountAmountInput.toFixed(2),
      reason: sale.discountReason,
      type: "AMOUNT",
    };
  }
  if (sale.discountPercentInput === null) {
    throw new Error("Percent discount is missing its entered percentage.");
  }
  return {
    percent: sale.discountPercentInput.toString(),
    reason: sale.discountReason,
    type: "PERCENT",
  };
}

function safePayment(sale: SelectedSale): SafeCheckoutPayment {
  const payment = sale.payment;
  if (payment === null) {
    throw new Error("Completed Sale is missing its Payment.");
  }
  if (payment.method === "CASH") {
    if (payment.amountTendered === null || payment.changeAmount === null) {
      throw new Error("Cash Payment is missing tender or change.");
    }
    return {
      amount: payment.amount.toFixed(2),
      amountTendered: payment.amountTendered.toFixed(2),
      changeAmount: payment.changeAmount.toFixed(2),
      method: "CASH",
      reference: null,
    };
  }
  return {
    amount: payment.amount.toFixed(2),
    amountTendered: null,
    changeAmount: null,
    method: "TRANSFER",
    reference: payment.transferReference,
  };
}

function safeSale(sale: SelectedSale): SafeCheckoutSale {
  if (sale.currency !== "THB") {
    throw new Error("Completed Sale has an unsupported currency.");
  }
  if (sale.salesVatStatusSnapshot === "UNCONFIGURED") {
    throw new Error("Completed Sale has an unconfigured VAT snapshot.");
  }
  return {
    actorDisplayNameSnapshot: sale.actorDisplayNameSnapshot,
    branchCodeSnapshot: sale.branchCodeSnapshot,
    branchId: sale.branchId,
    branchNameSnapshot: sale.branchNameSnapshot,
    currency: "THB",
    discount: safeDiscount(sale),
    discountAmount: sale.discountAmount.toFixed(2),
    id: sale.id,
    items: sale.items.map((item) => ({
      id: item.id,
      lineDiscount: item.lineDiscount.toFixed(2),
      lineGross: item.lineGross.toFixed(2),
      lineNet: item.lineNet.toFixed(2),
      lineOutputVat: item.lineOutputVat.toFixed(2),
      lineTaxable: item.lineTaxable?.toFixed(2) ?? null,
      nameSnapshot: item.productNameSnapshot,
      productId: item.productId,
      quantity: canonicalQuantity(item.quantity),
      skuSnapshot: item.productSkuSnapshot,
      unitPrice: item.unitPrice.toFixed(4),
      unitSnapshot: item.productUnitSnapshot,
    })),
    occurredAt: sale.completedAt.toISOString(),
    organizationId: sale.organizationId,
    organizationNameSnapshot: sale.organizationNameSnapshot,
    outputVatAmount: sale.outputVatAmount.toFixed(2),
    payment: safePayment(sale),
    reference: sale.reference,
    salesVatStatusSnapshot: sale.salesVatStatusSnapshot,
    subtotalAmount: sale.subtotalAmount.toFixed(2),
    taxableAmount: sale.taxableAmount?.toFixed(2) ?? null,
    totalAmount: sale.totalAmount.toFixed(2),
    vatRateSnapshot: sale.salesVatRateSnapshot?.toString() ?? null,
  };
}

const ADVISORY_LOCK_MAGNITUDE_MASK = (1n << 63n) - 1n;

function checkoutIdempotencyAdvisoryLockKey(identity: string): bigint {
  const digest = createHash("sha256")
    .update(`stockwise-sales-checkout\0${identity}`, "utf8")
    .digest();
  return digest.readBigUInt64BE(0) & ADVISORY_LOCK_MAGNITUDE_MASK;
}

async function advisoryLock(
  transaction: Transaction,
  key: bigint,
): Promise<void> {
  await transaction.$queryRaw<Array<{ locked: number }>>(Prisma.sql`
    SELECT 1::integer AS "locked"
    FROM (SELECT pg_advisory_xact_lock(${key.toString()}::bigint)) AS "checkout_lock"
  `);
}

type CheckoutAuthorization = {
  actorDisplayName: string;
  actorMembershipId: string;
  actorUserId: string;
  branchId: string;
  branchCode: string;
  branchName: string;
  discountAllowed: boolean;
  organizationId: string;
  organizationName: string;
  salesVatRate: Prisma.Decimal | null;
  salesVatStatus: "UNCONFIGURED" | "NOT_REGISTERED" | "REGISTERED";
};

async function authorizeCheckout(
  transaction: Transaction,
  input: { actorUserId: string; branchId: string; organizationId: string },
): Promise<
  | { authorization: CheckoutAuthorization; kind: "allowed" }
  | { kind: "forbidden" }
  | { kind: "branch_inactive" }
> {
  const organizations = await transaction.$queryRaw<
    Array<{
      id: string;
      name: string;
      salesVatRate: Prisma.Decimal | null;
      salesVatStatus: "UNCONFIGURED" | "NOT_REGISTERED" | "REGISTERED";
    }>
  >(Prisma.sql`
    SELECT
      "id",
      "name",
      "sales_vat_status"::text AS "salesVatStatus",
      "sales_vat_rate" AS "salesVatRate"
    FROM "organizations"
    WHERE "id" = ${input.organizationId}::uuid
      AND "status" = 'ACTIVE'
    FOR SHARE
  `);
  const organization = organizations[0];
  if (organization === undefined) return { kind: "forbidden" };

  const users = await transaction.$queryRaw<
    Array<{ displayName: string | null; id: string }>
  >(Prisma.sql`
    SELECT "id", "display_name" AS "displayName"
    FROM "users"
    WHERE "id" = ${input.actorUserId}::uuid
      AND "status" = 'ACTIVE'
    FOR SHARE
  `);
  const user = users[0];
  if (user === undefined) return { kind: "forbidden" };

  const branches = await transaction.$queryRaw<
    Array<{
      code: string;
      id: string;
      name: string;
      organizationId: string;
      status: "ACTIVE" | "INACTIVE";
    }>
  >(Prisma.sql`
    SELECT
      "id",
      "organization_id" AS "organizationId",
      "code",
      "name",
      "status"::text AS "status"
    FROM "branches"
    WHERE "id" = ${input.branchId}::uuid
      AND "organization_id" = ${input.organizationId}::uuid
    FOR SHARE
  `);
  const branch = branches[0];
  if (branch === undefined) return { kind: "forbidden" };

  const membership = await transaction.organizationMembership.findUnique({
    where: {
      organizationId_userId: {
        organizationId: input.organizationId,
        userId: input.actorUserId,
      },
    },
    select: {
      branchAssignments: {
        select: {
          branchId: true,
          organizationId: true,
          status: true,
          userId: true,
        },
      },
      id: true,
      organizationId: true,
      role: true,
      status: true,
      userId: true,
    },
  });
  if (membership === null) return { kind: "forbidden" };
  const context = createTrustedAuthorizationContext({
    actor: { id: user.id, status: "ACTIVE" },
    branchAssignments: membership.branchAssignments,
    membership: {
      organizationId: membership.organizationId,
      role: membership.role,
      status: membership.status,
      userId: membership.userId,
    },
  });
  const scope = createTrustedBranchScope({
    branchId: branch.id,
    branchOrganizationId: branch.organizationId,
    organizationId: input.organizationId,
  });
  if (!can(context, PERMISSIONS.CHECKOUT_PERFORM, scope)) {
    return { kind: "forbidden" };
  }
  if (branch.status !== "ACTIVE") return { kind: "branch_inactive" };

  const displayName = user.displayName?.trim();
  return {
    authorization: {
      actorDisplayName:
        displayName === undefined || displayName.length === 0
          ? user.id
          : displayName,
      actorMembershipId: membership.id,
      actorUserId: user.id,
      branchId: branch.id,
      branchCode: branch.code,
      branchName: branch.name,
      discountAllowed: can(context, PERMISSIONS.CHECKOUT_DISCOUNT_APPLY, scope),
      organizationName: organization.name,
      organizationId: organization.id,
      salesVatRate: organization.salesVatRate,
      salesVatStatus: organization.salesVatStatus,
    },
    kind: "allowed",
  };
}

type LockedProduct = {
  basePrice: Prisma.Decimal;
  id: string;
  name: string;
  sku: string;
  status: "ACTIVE" | "INACTIVE";
  unit: "EA" | "PACK" | "BOX" | "KG" | "G" | "L" | "ML" | "M" | "CM";
};

type LockedInventory = {
  balanceId: string;
  costState:
    | {
        averageUnitCost: Prisma.Decimal;
        basisState: "KNOWN";
        id: string;
      }
    | { averageUnitCost: null; basisState: "UNKNOWN"; id: string }
    | null;
  quantity: Prisma.Decimal;
};

function integerDigitsFit(value: Prisma.Decimal, maximum: number): boolean {
  const [integerDigits = ""] = value.abs().toFixed().split(".");
  return (integerDigits.replace(/^0+/, "") || "0").length <= maximum;
}

function retryableTransactionConflict(error: unknown): boolean {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2034"
  ) {
    return true;
  }
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  return error.code === "40P01" || error.code === "40001";
}

export function createPrismaCheckoutRepository(
  prisma: PrismaClient,
  options: CheckoutRepositoryOptions = {},
): CheckoutRepository {
  const now = options.now ?? (() => new Date());
  return {
    async checkout(input) {
      if (!validCheckoutIdempotencyKey(input.idempotencyKey)) {
        return { kind: "invalid_idempotency_key" };
      }
      const canonical = canonicalizeCheckoutIntent(input);
      if (canonical.kind !== "valid") return canonical;
      const keyHash = checkoutIdempotencyKeyHash(input.idempotencyKey);
      const requestHash = checkoutCanonicalRequestHash({
        actorUserId: input.actorUserId,
        branchId: input.branchId,
        intent: canonical.intent,
        organizationId: input.organizationId,
      });

      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          return await prisma.$transaction(async (transaction) => {
            await advisoryLock(
              transaction,
              checkoutIdempotencyAdvisoryLockKey(
                `${input.organizationId.toLowerCase()}:SALE_CHECKOUT:${keyHash}`,
              ),
            );
            const prior = await transaction.sale.findUnique({
              where: {
                organizationId_idempotencyOperation_idempotencyKeyHash: {
                  idempotencyKeyHash: keyHash,
                  idempotencyOperation: "SALE_CHECKOUT",
                  organizationId: input.organizationId,
                },
              },
              select: saleSelection,
            });

            const access = await authorizeCheckout(transaction, input);
            if (access.kind !== "allowed") return access;
            if (prior !== null) {
              if (prior.canonicalRequestHash !== requestHash) {
                return { kind: "idempotency_conflict" } as const;
              }
              return { kind: "replay", sale: safeSale(prior) } as const;
            }
            if (access.authorization.salesVatStatus === "UNCONFIGURED") {
              return { kind: "vat_configuration_required" } as const;
            }
            if (
              canonical.intent.discount !== null &&
              !access.authorization.discountAllowed
            ) {
              return { kind: "forbidden" } as const;
            }

            const products: LockedProduct[] = [];
            for (const line of canonical.intent.items) {
              const rows = await transaction.$queryRaw<LockedProduct[]>(
                Prisma.sql`
                  SELECT
                    "id",
                    "name",
                    "sku",
                    "unit"::text AS "unit",
                    "status"::text AS "status",
                    "base_price" AS "basePrice"
                  FROM "products"
                  WHERE "id" = ${line.productId}::uuid
                    AND "organization_id" = ${access.authorization.organizationId}::uuid
                  FOR SHARE
                `,
              );
              const product = rows[0];
              if (product === undefined) return { kind: "not_found" } as const;
              if (product.status !== "ACTIVE") {
                return { kind: "product_inactive" } as const;
              }
              if (!product.basePrice.equals(line.expectedUnitPrice)) {
                return { kind: "price_changed" } as const;
              }
              if (
                (product.unit === "EA" ||
                  product.unit === "PACK" ||
                  product.unit === "BOX") &&
                !line.quantity.isInteger()
              ) {
                return { kind: "invalid_quantity" } as const;
              }
              products.push(product);
            }

            const amounts = calculateCheckoutAmounts({
              discount: canonical.intent.discount,
              lines: canonical.intent.items.map((line, index) => ({
                productId: line.productId,
                quantity: line.quantity,
                unitPrice: products[index]!.basePrice,
              })),
              salesVatRate: access.authorization.salesVatRate,
              salesVatStatus: access.authorization.salesVatStatus,
            });
            if (amounts === null) return { kind: "invalid_amounts" } as const;
            // A payer-facing amount (PromptPay QR) must equal the server total exactly.
            if (
              canonical.intent.payment.method === "TRANSFER" &&
              canonical.intent.payment.expectedTotalAmount !== undefined &&
              !canonical.intent.payment.expectedTotalAmount.equals(
                amounts.totalAmount,
              )
            ) {
              return { kind: "total_mismatch" } as const;
            }

            let amountTendered: Prisma.Decimal | null = null;
            let changeAmount: Prisma.Decimal | null = null;
            let transferReference: string | null = null;
            if (canonical.intent.payment.method === "CASH") {
              amountTendered = canonical.intent.payment.amountTendered;
              if (amountTendered.lessThan(amounts.totalAmount)) {
                return { kind: "invalid_payment" } as const;
              }
              changeAmount = amountTendered.minus(amounts.totalAmount);
              if (!documentMoneyFitsStorage(changeAmount)) {
                return { kind: "invalid_payment" } as const;
              }
            } else {
              transferReference = canonical.intent.payment.reference;
            }

            for (const product of products) {
              await advisoryLock(
                transaction,
                inventoryBalanceAdvisoryLockKey(
                  access.authorization.branchId,
                  product.id,
                ),
              );
            }

            const inventory: LockedInventory[] = [];
            for (const [index, product] of products.entries()) {
              const balances = await transaction.$queryRaw<
                Array<{ id: string; quantity: Prisma.Decimal }>
              >(Prisma.sql`
                SELECT "id", "quantity"
                FROM "inventory_balances"
                WHERE "branch_id" = ${access.authorization.branchId}::uuid
                  AND "product_id" = ${product.id}::uuid
                  AND "organization_id" = ${access.authorization.organizationId}::uuid
                FOR UPDATE
              `);
              const balance = balances[0];
              const requestedQuantity = canonical.intent.items[index]!.quantity;
              if (
                balance === undefined ||
                balance.quantity.lessThan(requestedQuantity)
              ) {
                return { kind: "insufficient_stock" } as const;
              }
              const costRows = await transaction.$queryRaw<
                Array<{
                  averageUnitCost: Prisma.Decimal | null;
                  basisState: "UNKNOWN" | "KNOWN";
                  id: string;
                  inventoryValue: Prisma.Decimal | null;
                }>
              >(Prisma.sql`
                SELECT
                  "id",
                  "basis_state"::text AS "basisState",
                  "inventory_value" AS "inventoryValue",
                  "average_unit_cost" AS "averageUnitCost"
                FROM "inventory_cost_states"
                WHERE "branch_id" = ${access.authorization.branchId}::uuid
                  AND "product_id" = ${product.id}::uuid
                  AND "organization_id" = ${access.authorization.organizationId}::uuid
                FOR UPDATE
              `);
              const cost = costRows[0];
              if (cost?.basisState === "KNOWN") {
                if (
                  cost.averageUnitCost === null ||
                  cost.inventoryValue === null
                ) {
                  throw new Error(
                    "Known inventory cost state is missing numeric values.",
                  );
                }
                inventory.push({
                  balanceId: balance.id,
                  costState: {
                    averageUnitCost: cost.averageUnitCost,
                    basisState: "KNOWN",
                    id: cost.id,
                  },
                  quantity: balance.quantity,
                });
              } else {
                if (
                  cost !== undefined &&
                  (cost.averageUnitCost !== null ||
                    cost.inventoryValue !== null)
                ) {
                  throw new Error(
                    "Unknown inventory cost state contains numeric values.",
                  );
                }
                inventory.push({
                  balanceId: balance.id,
                  costState:
                    cost === undefined
                      ? null
                      : {
                          averageUnitCost: null,
                          basisState: "UNKNOWN",
                          id: cost.id,
                        },
                  quantity: balance.quantity,
                });
              }
            }

            const completedAt = now();
            const saleId = randomUUID();
            await transaction.sale.create({
              data: {
                actorDisplayNameSnapshot: access.authorization.actorDisplayName,
                actorMembershipId: access.authorization.actorMembershipId,
                actorUserId: access.authorization.actorUserId,
                branchCodeSnapshot: access.authorization.branchCode,
                branchId: access.authorization.branchId,
                branchNameSnapshot: access.authorization.branchName,
                canonicalRequestHash: requestHash,
                completedAt,
                discountAmount: amounts.discountAmount,
                discountAmountInput:
                  canonical.intent.discount?.type === "AMOUNT"
                    ? canonical.intent.discount.amount
                    : null,
                discountPercentInput:
                  canonical.intent.discount?.type === "PERCENT"
                    ? canonical.intent.discount.percent
                    : null,
                discountReason: canonical.intent.discount?.reason ?? null,
                discountType: canonical.intent.discount?.type ?? null,
                id: saleId,
                idempotencyKeyHash: keyHash,
                organizationId: access.authorization.organizationId,
                organizationNameSnapshot: access.authorization.organizationName,
                outputVatAmount: amounts.outputVatAmount,
                reference: `SALE-${saleId}`,
                salesVatRateSnapshot: access.authorization.salesVatRate,
                salesVatStatusSnapshot: access.authorization.salesVatStatus,
                subtotalAmount: amounts.subtotalAmount,
                taxableAmount: amounts.taxableAmount,
                totalAmount: amounts.totalAmount,
              },
            });

            for (const [lineIndex, line] of canonical.intent.items.entries()) {
              const product = products[lineIndex]!;
              const allocation = amounts.lines[lineIndex]!;
              const state = inventory[lineIndex]!;
              const resultingQuantity = exactCheckoutDecimal(
                state.quantity,
              ).minus(line.quantity);
              if (
                resultingQuantity.isNegative() ||
                !inventoryQuantityFitsStorage(resultingQuantity)
              ) {
                throw new Error("Locked checkout quantity became invalid.");
              }

              let cogsAmount: Prisma.Decimal | null = null;
              let unitCost: Prisma.Decimal | null = null;
              if (state.costState?.basisState === "KNOWN") {
                unitCost = state.costState.averageUnitCost;
                cogsAmount = line.quantity
                  .times(unitCost)
                  .toDecimalPlaces(10, Prisma.Decimal.ROUND_HALF_UP);
                const remainingValue = resultingQuantity
                  .times(unitCost)
                  .toDecimalPlaces(10, Prisma.Decimal.ROUND_HALF_UP);
                if (
                  !integerDigitsFit(cogsAmount, 28) ||
                  !integerDigitsFit(remainingValue, 28)
                ) {
                  throw new Error("Checkout cost exceeds accepted storage.");
                }
                await transaction.inventoryCostState.update({
                  data: { inventoryValue: remainingValue },
                  where: { id: state.costState.id },
                });
              }

              const saleItem = await transaction.saleItem.create({
                data: {
                  branchId: access.authorization.branchId,
                  cogsAmount,
                  costBasisState:
                    state.costState?.basisState === "KNOWN"
                      ? "KNOWN"
                      : "UNKNOWN",
                  lineDiscount: allocation.lineDiscount,
                  lineGross: allocation.lineGross,
                  lineNet: allocation.lineNet,
                  lineOutputVat: allocation.lineOutputVat,
                  lineTaxable: allocation.lineTaxable,
                  organizationId: access.authorization.organizationId,
                  productId: product.id,
                  productNameSnapshot: product.name,
                  productSkuSnapshot: product.sku,
                  productUnitSnapshot: product.unit,
                  quantity: line.quantity,
                  saleId,
                  unitCost,
                  unitPrice: product.basePrice,
                },
              });
              await transaction.inventoryBalance.update({
                data: { quantity: resultingQuantity },
                where: { id: state.balanceId },
              });
              await transaction.inventoryTransaction.create({
                data: {
                  actorMembershipId: access.authorization.actorMembershipId,
                  actorUserId: access.authorization.actorUserId,
                  branchId: access.authorization.branchId,
                  delta: line.quantity.negated(),
                  occurredAt: completedAt,
                  organizationId: access.authorization.organizationId,
                  productId: product.id,
                  saleItemId: saleItem.id,
                  source: "SALE",
                },
              });
              await options.afterLineCommitted?.(lineIndex);
            }

            await transaction.payment.create({
              data: {
                amount: amounts.totalAmount,
                amountTendered,
                branchId: access.authorization.branchId,
                changeAmount,
                confirmedAt: completedAt,
                method: canonical.intent.payment.method,
                organizationId: access.authorization.organizationId,
                saleId,
                transferReference,
              },
            });
            const completed = await transaction.sale.findUniqueOrThrow({
              where: { id: saleId },
              select: saleSelection,
            });
            return { kind: "success", sale: safeSale(completed) } as const;
          });
        } catch (error: unknown) {
          if (retryableTransactionConflict(error) && attempt < 2) continue;
          throw error;
        }
      }
      throw new Error("Checkout retry loop exhausted unexpectedly.");
    },

    /**
     * Same authorization, product, price, quantity, discount, VAT and amount rules as
     * `checkout`, but it writes nothing and locks no stock: a quote must never create a
     * sale or move inventory. A later `checkout` recomputes everything authoritatively.
     */
    async quote(input) {
      const canonical = canonicalizeCheckoutIntent({
        discount: input.discount,
        items: input.items,
        payment: { method: "TRANSFER", reference: null },
      });
      // The placeholder payment is always valid; any other failure is a cart problem.
      if (canonical.kind !== "valid") {
        switch (canonical.kind) {
          case "duplicate_product":
            return { kind: "duplicate_product" } as const;
          case "invalid_discount":
            return { kind: "invalid_discount" } as const;
          case "invalid_price":
            return { kind: "invalid_price" } as const;
          case "invalid_quantity":
            return { kind: "invalid_quantity" } as const;
          case "invalid_payment":
            return { kind: "invalid_amounts" } as const;
        }
      }
      return prisma.$transaction(async (transaction) => {
        const access = await authorizeCheckout(transaction, input);
        if (access.kind !== "allowed") return access;
        if (access.authorization.salesVatStatus === "UNCONFIGURED") {
          return { kind: "vat_configuration_required" } as const;
        }
        if (
          canonical.intent.discount !== null &&
          !access.authorization.discountAllowed
        ) {
          return { kind: "forbidden" } as const;
        }
        const products: LockedProduct[] = [];
        for (const line of canonical.intent.items) {
          const rows = await transaction.$queryRaw<LockedProduct[]>(Prisma.sql`
            SELECT
              "id",
              "name",
              "sku",
              "unit"::text AS "unit",
              "status"::text AS "status",
              "base_price" AS "basePrice"
            FROM "products"
            WHERE "id" = ${line.productId}::uuid
              AND "organization_id" = ${access.authorization.organizationId}::uuid
          `);
          const product = rows[0];
          if (product === undefined) return { kind: "not_found" } as const;
          if (product.status !== "ACTIVE") {
            return { kind: "product_inactive" } as const;
          }
          if (!product.basePrice.equals(line.expectedUnitPrice)) {
            return { kind: "price_changed" } as const;
          }
          if (
            (product.unit === "EA" ||
              product.unit === "PACK" ||
              product.unit === "BOX") &&
            !line.quantity.isInteger()
          ) {
            return { kind: "invalid_quantity" } as const;
          }
          const balances = await transaction.$queryRaw<
            Array<{ quantity: Prisma.Decimal }>
          >(Prisma.sql`
            SELECT "quantity"
            FROM "inventory_balances"
            WHERE "branch_id" = ${access.authorization.branchId}::uuid
              AND "product_id" = ${product.id}::uuid
              AND "organization_id" = ${access.authorization.organizationId}::uuid
          `);
          if (
            balances[0] === undefined ||
            balances[0].quantity.lessThan(line.quantity)
          ) {
            return { kind: "insufficient_stock" } as const;
          }
          products.push(product);
        }
        const amounts = calculateCheckoutAmounts({
          discount: canonical.intent.discount,
          lines: canonical.intent.items.map((line, index) => ({
            productId: line.productId,
            quantity: line.quantity,
            unitPrice: products[index]!.basePrice,
          })),
          salesVatRate: access.authorization.salesVatRate,
          salesVatStatus: access.authorization.salesVatStatus,
        });
        if (amounts === null) return { kind: "invalid_amounts" } as const;
        return {
          kind: "success",
          totalAmount: amounts.totalAmount.toFixed(2),
        } as const;
      });
    },
  };
}
