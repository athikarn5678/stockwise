import { createHash } from "node:crypto";

import { Prisma, type PrismaClient } from "../../generated/prisma/client.ts";
import {
  can,
  createTrustedAuthorizationContext,
  createTrustedBranchScope,
  createTrustedOrganizationScope,
  PERMISSIONS,
} from "../identity/authorization-policy.ts";
import type {
  PosProductSearchQuery,
  SalesHistoryQuery,
  SalesVatProfileUpdateInput,
} from "./sales-schemas.ts";
import {
  refundSelection,
  safeRefund,
  type SafeSaleRefund,
} from "./refund-repository.ts";

type Transaction = Prisma.TransactionClient;

export interface SafeSalesVatProfile {
  salesVatRate: string | null;
  salesVatStatus: "UNCONFIGURED" | "NOT_REGISTERED" | "REGISTERED";
  updatedAt: string;
}

export interface SafePosProduct {
  available: boolean;
  availableQuantity: string;
  barcode: string | null;
  basePrice: string;
  id: string;
  name: string;
  sku: string;
  unit: string;
}

type SafeDiscount =
  | { amount: string; reason: string; type: "AMOUNT" }
  | { percent: string; reason: string; type: "PERCENT" }
  | null;

type SafePayment =
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

export interface SafeSalesHistorySummary {
  actorDisplayName: string;
  createdAt: string;
  currency: "THB";
  discount: SafeDiscount;
  discountAmount: string;
  id: string;
  itemCount: number;
  outputVatAmount: string;
  payment: SafePayment;
  reference: string;
  refundedAmount: string;
  refundState: "NONE" | "PARTIALLY_REFUNDED" | "FULLY_REFUNDED";
  remainingAmount: string;
  salesVatRate: string | null;
  salesVatStatus: "NOT_REGISTERED" | "REGISTERED";
  subtotalAmount: string;
  taxableAmount: string | null;
  totalAmount: string;
}

export interface SafeSalesHistoryDetail extends SafeSalesHistorySummary {
  branchCode: string;
  branchName: string;
  items: Array<{
    cogsAmount?: string | null;
    costBasisState?: "KNOWN" | "UNKNOWN";
    id: string;
    lineDiscount: string;
    lineGross: string;
    lineOutputVat: string;
    lineTaxable: string | null;
    lineNet: string;
    productId: string;
    productName: string;
    productSku: string;
    quantity: string;
    remainingRefundableQuantity: string;
    unit: string;
    unitCost?: string | null;
    unitPrice: string;
  }>;
  organizationName: string;
  refunds: SafeSaleRefund[];
}

type AuthorizationFailure = { kind: "forbidden" };

export type SalesVatProfileOutcome =
  { kind: "success"; profile: SafeSalesVatProfile } | AuthorizationFailure;

export type SalesVatProfileUpdateOutcome =
  SalesVatProfileOutcome | { kind: "invalid_profile" } | { kind: "stale" };

export type PosProductSearchOutcome =
  | {
      kind: "success";
      nextCursor: string | null;
      products: SafePosProduct[];
    }
  | AuthorizationFailure
  | { kind: "branch_inactive" }
  | { kind: "invalid_cursor" };

export type SalesHistoryListOutcome =
  | {
      kind: "success";
      nextCursor: string | null;
      sales: SafeSalesHistorySummary[];
    }
  | AuthorizationFailure
  | { kind: "invalid_cursor" };

export type SalesHistoryDetailOutcome =
  | { kind: "success"; sale: SafeSalesHistoryDetail }
  | AuthorizationFailure
  | { kind: "not_found" };

export interface SalesApiRepository {
  getSalesVatProfile(input: {
    actorUserId: string;
    organizationId: string;
  }): Promise<SalesVatProfileOutcome>;
  getSalesHistoryDetail(input: {
    actorUserId: string;
    branchId: string;
    organizationId: string;
    saleId: string;
  }): Promise<SalesHistoryDetailOutcome>;
  listSalesHistory(input: {
    actorUserId: string;
    branchId: string;
    organizationId: string;
    query: SalesHistoryQuery;
  }): Promise<SalesHistoryListOutcome>;
  searchPosProducts(input: {
    actorUserId: string;
    branchId: string;
    organizationId: string;
    query: PosProductSearchQuery;
  }): Promise<PosProductSearchOutcome>;
  updateSalesVatProfile(input: {
    actorUserId: string;
    organizationId: string;
    profile: SalesVatProfileUpdateInput;
  }): Promise<SalesVatProfileUpdateOutcome>;
}

interface PosCursorValue {
  filterHash: string;
  id: string;
  name: string;
  version: 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function filterHash(value: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function encodeCursor(value: PosCursorValue): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor(
  cursor: string,
  expectedFilterHash: string,
): PosCursorValue | null {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return null;
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.toString("base64url") !== cursor) return null;
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (
      !isRecord(value) ||
      value.version !== 1 ||
      typeof value.filterHash !== "string" ||
      value.filterHash !== expectedFilterHash ||
      typeof value.id !== "string" ||
      typeof value.name !== "string"
    ) {
      return null;
    }
    return {
      filterHash: value.filterHash,
      id: value.id,
      name: value.name,
      version: 1,
    };
  } catch {
    return null;
  }
}

interface SalesHistoryCursorValue {
  createdAt: string;
  filterHash: string;
  id: string;
  version: 1;
}

function decodeSalesHistoryCursor(
  cursor: string,
  expectedFilterHash: string,
): SalesHistoryCursorValue | null {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return null;
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.toString("base64url") !== cursor) return null;
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (
      !isRecord(value) ||
      value.version !== 1 ||
      value.filterHash !== expectedFilterHash ||
      typeof value.createdAt !== "string" ||
      Number.isNaN(Date.parse(value.createdAt)) ||
      typeof value.id !== "string"
    ) {
      return null;
    }
    return {
      createdAt: value.createdAt,
      filterHash: expectedFilterHash,
      id: value.id,
      version: 1,
    };
  } catch {
    return null;
  }
}

function encodeSalesHistoryCursor(value: SalesHistoryCursorValue): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

const historyItemSelection = {
  cogsAmount: true,
  costBasisState: true,
  createdAt: true,
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
  refundItems: { select: { refundQuantity: true } },
  unitCost: true,
  unitPrice: true,
} satisfies Prisma.SaleItemSelect;

const historyPaymentSelection = {
  amount: true,
  amountTendered: true,
  changeAmount: true,
  method: true,
  transferReference: true,
} satisfies Prisma.PaymentSelect;

const historySaleSelection = {
  actorDisplayNameSnapshot: true,
  branchCodeSnapshot: true,
  branchNameSnapshot: true,
  completedAt: true,
  createdAt: true,
  currency: true,
  discountAmount: true,
  discountAmountInput: true,
  discountPercentInput: true,
  discountReason: true,
  discountType: true,
  id: true,
  items: {
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: historyItemSelection,
  },
  organizationNameSnapshot: true,
  outputVatAmount: true,
  payment: { select: historyPaymentSelection },
  reference: true,
  refunds: {
    orderBy: [{ completedAt: "asc" }, { id: "asc" }],
    select: refundSelection,
  },
  salesVatRateSnapshot: true,
  salesVatStatusSnapshot: true,
  subtotalAmount: true,
  taxableAmount: true,
  totalAmount: true,
} satisfies Prisma.SaleSelect;

const historySummarySelection = {
  actorDisplayNameSnapshot: true,
  completedAt: true,
  createdAt: true,
  currency: true,
  discountAmount: true,
  discountAmountInput: true,
  discountPercentInput: true,
  discountReason: true,
  discountType: true,
  id: true,
  items: {
    select: {
      quantity: true,
      refundItems: { select: { refundQuantity: true } },
    },
  },
  outputVatAmount: true,
  payment: { select: historyPaymentSelection },
  reference: true,
  refunds: { select: { totalAmount: true } },
  salesVatRateSnapshot: true,
  salesVatStatusSnapshot: true,
  subtotalAmount: true,
  taxableAmount: true,
  totalAmount: true,
} satisfies Prisma.SaleSelect;

type SelectedHistorySale = Prisma.SaleGetPayload<{
  select: typeof historySaleSelection;
}>;
type SelectedHistorySummary = Prisma.SaleGetPayload<{
  select: typeof historySummarySelection;
}>;

function safeHistoryDiscount(
  sale: SelectedHistorySale | SelectedHistorySummary,
): SafeDiscount {
  if (sale.discountType === null || sale.discountReason === null) return null;
  if (sale.discountType === "AMOUNT" && sale.discountAmountInput !== null) {
    return {
      amount: sale.discountAmountInput.toFixed(2),
      reason: sale.discountReason,
      type: "AMOUNT",
    };
  }
  if (sale.discountType === "PERCENT" && sale.discountPercentInput !== null) {
    return {
      percent: sale.discountPercentInput.toString(),
      reason: sale.discountReason,
      type: "PERCENT",
    };
  }
  throw new Error("Sale has an invalid discount snapshot.");
}

function safeHistoryPayment(
  sale: SelectedHistorySale | SelectedHistorySummary,
): SafePayment {
  if (sale.payment === null) throw new Error("Sale is missing its Payment.");
  if (sale.payment.method === "CASH") {
    if (
      sale.payment.amountTendered === null ||
      sale.payment.changeAmount === null
    ) {
      throw new Error("Cash Sale is missing tender or change.");
    }
    return {
      amount: sale.payment.amount.toFixed(2),
      amountTendered: sale.payment.amountTendered.toFixed(2),
      changeAmount: sale.payment.changeAmount.toFixed(2),
      method: "CASH",
      reference: null,
    };
  }
  return {
    amount: sale.payment.amount.toFixed(2),
    amountTendered: null,
    changeAmount: null,
    method: "TRANSFER",
    reference: sale.payment.transferReference,
  };
}

function safeHistorySummary(
  sale: SelectedHistorySale | SelectedHistorySummary,
): SafeSalesHistorySummary {
  if (
    sale.currency !== "THB" ||
    sale.salesVatStatusSnapshot === "UNCONFIGURED"
  ) {
    throw new Error("Sale has an unsupported historical snapshot.");
  }
  const refundedAmount = sale.refunds.reduce(
    (total, refund) => total.plus(refund.totalAmount),
    new Prisma.Decimal(0),
  );
  const fullyRefunded =
    sale.refunds.length > 0 &&
    sale.items.every((item) =>
      item.refundItems
        .reduce(
          (total, refund) => total.plus(refund.refundQuantity),
          new Prisma.Decimal(0),
        )
        .equals(item.quantity),
    );
  return {
    actorDisplayName: sale.actorDisplayNameSnapshot,
    createdAt: sale.createdAt.toISOString(),
    currency: "THB",
    discount: safeHistoryDiscount(sale),
    discountAmount: sale.discountAmount.toFixed(2),
    id: sale.id,
    itemCount: sale.items.length,
    outputVatAmount: sale.outputVatAmount.toFixed(2),
    payment: safeHistoryPayment(sale),
    reference: sale.reference,
    refundedAmount: refundedAmount.toFixed(2),
    refundState:
      sale.refunds.length === 0
        ? "NONE"
        : fullyRefunded
          ? "FULLY_REFUNDED"
          : "PARTIALLY_REFUNDED",
    remainingAmount: sale.totalAmount.minus(refundedAmount).toFixed(2),
    salesVatRate: sale.salesVatRateSnapshot?.toString() ?? null,
    salesVatStatus: sale.salesVatStatusSnapshot,
    subtotalAmount: sale.subtotalAmount.toFixed(2),
    taxableAmount: sale.taxableAmount?.toFixed(2) ?? null,
    totalAmount: sale.totalAmount.toFixed(2),
  };
}

function safeHistoryDetail(
  sale: SelectedHistorySale,
  includeCosts: boolean,
): SafeSalesHistoryDetail {
  return {
    ...safeHistorySummary(sale),
    branchCode: sale.branchCodeSnapshot,
    branchName: sale.branchNameSnapshot,
    items: sale.items.map((item) => ({
      ...(includeCosts
        ? {
            cogsAmount: item.cogsAmount?.toFixed(10) ?? null,
            costBasisState: item.costBasisState,
            unitCost: item.unitCost?.toFixed(6) ?? null,
          }
        : {}),
      id: item.id,
      lineDiscount: item.lineDiscount.toFixed(2),
      lineGross: item.lineGross.toFixed(2),
      lineNet: item.lineNet.toFixed(2),
      lineOutputVat: item.lineOutputVat.toFixed(2),
      lineTaxable: item.lineTaxable?.toFixed(2) ?? null,
      productId: item.productId,
      productName: item.productNameSnapshot,
      productSku: item.productSkuSnapshot,
      quantity: item.quantity.toFixed(4),
      remainingRefundableQuantity: item.quantity
        .minus(
          item.refundItems.reduce(
            (total, refund) => total.plus(refund.refundQuantity),
            new Prisma.Decimal(0),
          ),
        )
        .toFixed(4),
      unit: item.productUnitSnapshot,
      unitPrice: item.unitPrice.toFixed(4),
    })),
    organizationName: sale.organizationNameSnapshot,
    refunds: sale.refunds.map((refund) => {
      const safe = safeRefund(refund, includeCosts);
      const order = new Map(
        sale.items.map((item, index) => [item.id, index] as const),
      );
      return {
        ...safe,
        items: [...safe.items].sort(
          (left, right) =>
            (order.get(left.saleItemId) ?? Number.MAX_SAFE_INTEGER) -
            (order.get(right.saleItemId) ?? Number.MAX_SAFE_INTEGER),
        ),
      };
    }),
  };
}

function safeProfile(input: {
  salesVatRate: Prisma.Decimal | null;
  salesVatStatus: "UNCONFIGURED" | "NOT_REGISTERED" | "REGISTERED";
  updatedAt: Date;
}): SafeSalesVatProfile {
  return {
    salesVatRate: input.salesVatRate?.toString() ?? null,
    salesVatStatus: input.salesVatStatus,
    updatedAt: input.updatedAt.toISOString(),
  };
}

function parseSalesVatRate(
  input: SalesVatProfileUpdateInput,
): Prisma.Decimal | null | undefined {
  if (input.salesVatStatus !== "REGISTERED") {
    return input.salesVatRate === null ? null : undefined;
  }
  if (input.salesVatRate === null) return undefined;
  const match = /^(\d+)(?:\.(\d+))?$/.exec(input.salesVatRate);
  if (match === null) return undefined;
  const integerDigits = (match[1] ?? "").replace(/^0+/, "") || "0";
  const fractionalDigits = match[2] ?? "";
  if (integerDigits.length > 2 || fractionalDigits.length > 6) return undefined;
  try {
    const rate = new Prisma.Decimal(input.salesVatRate);
    return rate.isPositive() && rate.lessThan(100) ? rate : undefined;
  } catch {
    return undefined;
  }
}

async function trustedContext(
  transaction: Transaction,
  input: { actorUserId: string; organizationId: string },
) {
  const [user, membership] = await Promise.all([
    transaction.user.findFirst({
      select: { id: true, status: true },
      where: { id: input.actorUserId, status: "ACTIVE" },
    }),
    transaction.organizationMembership.findUnique({
      select: {
        branchAssignments: {
          select: {
            branchId: true,
            organizationId: true,
            status: true,
            userId: true,
          },
        },
        organizationId: true,
        role: true,
        status: true,
        userId: true,
      },
      where: {
        organizationId_userId: {
          organizationId: input.organizationId,
          userId: input.actorUserId,
        },
      },
    }),
  ]);
  if (user === null || membership === null) return null;
  return createTrustedAuthorizationContext({
    actor: user,
    branchAssignments: membership.branchAssignments,
    membership,
  });
}

async function authorizedOrganization(
  transaction: Transaction,
  input: { actorUserId: string; organizationId: string },
) {
  const organization = await transaction.organization.findFirst({
    select: {
      id: true,
      salesVatRate: true,
      salesVatStatus: true,
      updatedAt: true,
    },
    where: { id: input.organizationId, status: "ACTIVE" },
  });
  if (organization === null) return null;
  const context = await trustedContext(transaction, input);
  const scope = createTrustedOrganizationScope(organization.id);
  return can(context, PERMISSIONS.ORGANIZATION_SETTINGS_MANAGE, scope)
    ? organization
    : null;
}

async function authorizedHistoryBranch(
  transaction: Transaction,
  input: { actorUserId: string; branchId: string; organizationId: string },
) {
  const [branch, organization, context] = await Promise.all([
    transaction.branch.findFirst({
      select: { id: true, organizationId: true, status: true },
      where: { id: input.branchId, organizationId: input.organizationId },
    }),
    transaction.organization.findFirst({
      select: { id: true },
      where: { id: input.organizationId, status: "ACTIVE" },
    }),
    trustedContext(transaction, input),
  ]);
  if (branch === null || organization === null || branch.status !== "ACTIVE") {
    return null;
  }
  const scope = createTrustedBranchScope({
    branchId: branch.id,
    branchOrganizationId: branch.organizationId,
    organizationId: input.organizationId,
  });
  if (
    !can(context, PERMISSIONS.SALES_HISTORY_VIEW, scope) ||
    !can(context, PERMISSIONS.SALES_REFUND_VIEW, scope)
  ) {
    return null;
  }
  return {
    includeCosts:
      can(context, PERMISSIONS.SALES_COST_VIEW, scope) &&
      can(context, PERMISSIONS.SALES_REFUND_COST_VIEW, scope),
  };
}

function nextUpdatedAt(expectedUpdatedAt: Date, currentTime: Date): Date {
  return new Date(
    Math.max(expectedUpdatedAt.getTime() + 1, currentTime.getTime()),
  );
}

export function createPrismaSalesApiRepository(
  prisma: PrismaClient,
  { now = () => new Date() }: { now?: () => Date } = {},
): SalesApiRepository {
  return {
    async getSalesVatProfile(input) {
      return prisma.$transaction(async (transaction) => {
        const organization = await authorizedOrganization(transaction, input);
        return organization === null
          ? { kind: "forbidden" as const }
          : { kind: "success" as const, profile: safeProfile(organization) };
      });
    },

    async getSalesHistoryDetail(input) {
      return prisma.$transaction(async (transaction) => {
        const access = await authorizedHistoryBranch(transaction, input);
        if (access === null) return { kind: "forbidden" as const };
        const sale = await transaction.sale.findFirst({
          select: historySaleSelection,
          where: {
            branchId: input.branchId,
            id: input.saleId,
            organizationId: input.organizationId,
          },
        });
        return sale === null
          ? { kind: "not_found" as const }
          : {
              kind: "success" as const,
              sale: safeHistoryDetail(sale, access.includeCosts),
            };
      });
    },

    async listSalesHistory(input) {
      return prisma.$transaction(async (transaction) => {
        const access = await authorizedHistoryBranch(transaction, input);
        if (access === null) return { kind: "forbidden" as const };
        const hash = filterHash({
          actorUserId: input.query.actorUserId ?? null,
          branchId: input.branchId,
          createdAtFrom: input.query.createdAtFrom?.toISOString() ?? null,
          createdAtTo: input.query.createdAtTo?.toISOString() ?? null,
          organizationId: input.organizationId,
        });
        const cursor =
          input.query.cursor === undefined
            ? null
            : decodeSalesHistoryCursor(input.query.cursor, hash);
        if (input.query.cursor !== undefined && cursor === null) {
          return { kind: "invalid_cursor" as const };
        }
        const filters: Prisma.SaleWhereInput[] = [
          { branchId: input.branchId, organizationId: input.organizationId },
        ];
        if (input.query.actorUserId !== undefined) {
          filters.push({ actorUserId: input.query.actorUserId });
        }
        if (input.query.createdAtFrom !== undefined) {
          filters.push({ createdAt: { gte: input.query.createdAtFrom } });
        }
        if (input.query.createdAtTo !== undefined) {
          filters.push({ createdAt: { lt: input.query.createdAtTo } });
        }
        if (cursor !== null) {
          const createdAt = new Date(cursor.createdAt);
          filters.push({
            OR: [
              { createdAt: { lt: createdAt } },
              { createdAt, id: { lt: cursor.id } },
            ],
          });
        }
        const rows = await transaction.sale.findMany({
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: historySummarySelection,
          take: input.query.limit + 1,
          where: { AND: filters },
        });
        const hasMore = rows.length > input.query.limit;
        const page = hasMore ? rows.slice(0, input.query.limit) : rows;
        const last = page.at(-1);
        return {
          kind: "success" as const,
          nextCursor:
            hasMore && last !== undefined
              ? encodeSalesHistoryCursor({
                  createdAt: last.createdAt.toISOString(),
                  filterHash: hash,
                  id: last.id,
                  version: 1,
                })
              : null,
          sales: page.map(safeHistorySummary),
        };
      });
    },

    async searchPosProducts(input) {
      return prisma.$transaction(async (transaction) => {
        const [context, branch, organization] = await Promise.all([
          trustedContext(transaction, input),
          transaction.branch.findFirst({
            select: { id: true, organizationId: true, status: true },
            where: {
              id: input.branchId,
              organizationId: input.organizationId,
            },
          }),
          transaction.organization.findFirst({
            select: { id: true },
            where: { id: input.organizationId, status: "ACTIVE" },
          }),
        ]);
        if (branch === null || organization === null) {
          return { kind: "forbidden" as const };
        }
        const scope = createTrustedBranchScope({
          branchId: branch.id,
          branchOrganizationId: branch.organizationId,
          organizationId: input.organizationId,
        });
        if (!can(context, PERMISSIONS.CHECKOUT_PERFORM, scope)) {
          return { kind: "forbidden" as const };
        }
        if (branch.status !== "ACTIVE") {
          return { kind: "branch_inactive" as const };
        }

        const hash = filterHash({
          barcode: input.query.barcode ?? null,
          branchId: input.branchId,
          organizationId: input.organizationId,
          q: input.query.q,
        });
        const cursor =
          input.query.cursor === undefined
            ? null
            : decodeCursor(input.query.cursor, hash);
        if (input.query.cursor !== undefined && cursor === null) {
          return { kind: "invalid_cursor" as const };
        }
        const skuQuery = input.query.q.normalize("NFKC").toUpperCase();
        const filters: Prisma.ProductWhereInput[] = [
          { organizationId: input.organizationId },
          { status: "ACTIVE" },
        ];
        if (input.query.barcode !== undefined) {
          filters.push({ barcode: input.query.barcode });
        }
        if (input.query.q !== "") {
          filters.push({
            OR: [
              {
                name: {
                  contains: input.query.q,
                  mode: "insensitive" as const,
                },
              },
              { sku: { contains: skuQuery } },
              { barcode: { contains: input.query.q } },
            ],
          });
        }
        if (cursor !== null) {
          filters.push({
            OR: [
              { name: { gt: cursor.name } },
              { name: cursor.name, id: { gt: cursor.id } },
            ],
          });
        }
        const rows = await transaction.product.findMany({
          orderBy: [{ name: "asc" }, { id: "asc" }],
          select: {
            barcode: true,
            basePrice: true,
            id: true,
            inventoryBalances: {
              select: { quantity: true },
              where: { branchId: input.branchId },
            },
            name: true,
            sku: true,
            unit: true,
          },
          take: input.query.limit + 1,
          where: { AND: filters },
        });
        const hasMore = rows.length > input.query.limit;
        const page = hasMore ? rows.slice(0, input.query.limit) : rows;
        const last = page.at(-1);
        return {
          kind: "success" as const,
          nextCursor:
            hasMore && last !== undefined
              ? encodeCursor({
                  filterHash: hash,
                  id: last.id,
                  name: last.name,
                  version: 1,
                })
              : null,
          products: page.map((product) => ({
            available:
              product.inventoryBalances[0]?.quantity.greaterThan(0) ?? false,
            availableQuantity: (
              product.inventoryBalances[0]?.quantity ?? new Prisma.Decimal(0)
            ).toFixed(4),
            barcode: product.barcode,
            basePrice: product.basePrice.toFixed(4),
            id: product.id,
            name: product.name,
            sku: product.sku,
            unit: product.unit,
          })),
        };
      });
    },

    async updateSalesVatProfile(input) {
      const salesVatRate = parseSalesVatRate(input.profile);
      if (salesVatRate === undefined) return { kind: "invalid_profile" };
      return prisma.$transaction(async (transaction) => {
        await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT "id"
          FROM "organizations"
          WHERE "id" = ${input.organizationId}::uuid
          FOR UPDATE
        `);
        const organization = await authorizedOrganization(transaction, input);
        if (organization === null) return { kind: "forbidden" as const };
        if (
          organization.updatedAt.getTime() !==
          input.profile.expectedUpdatedAt.getTime()
        ) {
          return { kind: "stale" as const };
        }
        const updated = await transaction.organization.update({
          data: {
            salesVatRate,
            salesVatStatus: input.profile.salesVatStatus,
            updatedAt: nextUpdatedAt(input.profile.expectedUpdatedAt, now()),
          },
          select: {
            salesVatRate: true,
            salesVatStatus: true,
            updatedAt: true,
          },
          where: { id: organization.id },
        });
        return { kind: "success" as const, profile: safeProfile(updated) };
      });
    },
  };
}
