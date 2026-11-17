import { createHash } from "node:crypto";

import { Temporal } from "@js-temporal/polyfill";

import { Prisma } from "../generated/prisma/client.ts";
import { localDateToUtcBoundary } from "../modules/analytics/analytics-period.ts";
import { hashFirstOrganizationOnboardingRequest } from "../modules/identity/first-organization-onboarding-schema.ts";
import { hashPassword } from "../modules/identity/password-hasher.ts";
import {
  canonicalQuantity,
  parseInventoryDelta,
} from "../modules/inventory/inventory-values.ts";
import { adjustmentRequestHash } from "../modules/inventory/inventory-repository.ts";
import { expectedPurchaseOrderTotal } from "../modules/purchasing/purchase-order-values.ts";
import {
  receivingCanonicalRequestHash,
  receivingIdempotencyKeyHash,
} from "../modules/purchasing/receiving-values.ts";
import {
  calculateCheckoutAmounts,
  canonicalizeCheckoutIntent,
  checkoutCanonicalRequestHash,
  checkoutIdempotencyKeyHash,
} from "../modules/sales/checkout-values.ts";
import {
  calculateRefundLineAmounts,
  canonicalizeRefundIntent,
  refundCanonicalRequestHash,
  refundIdempotencyKeyHash,
} from "../modules/sales/refund-values.ts";
import { demoDemand, demoId } from "./demo-values.ts";

const decimal = (value: string | number) => new Prisma.Decimal(value);
const zero = decimal(0);
const hour = 3_600_000;
const timezone = "Asia/Bangkok";
const bootstrap = at("2024-12-30", 10);
const organizationId = demoId("organization", "DEMO-ORGANIZATION");
const supplierId = demoId("supplier", "DEMO-SUPPLIER");
const branches = ["DEMO-A", "DEMO-B"] as const;
const products = [
  {
    sku: "DEMO-STABLE",
    name: "Demo Standard Item",
    category: "DEMO-STAPLES",
    unit: "EA",
    price: "20.0000",
    cost: "10.0000",
  },
  {
    sku: "DEMO-WEEKLY",
    name: "Demo Weekend Item",
    category: "DEMO-MATERIALS",
    unit: "EA",
    price: "30.0000",
    cost: "15.0000",
  },
  {
    sku: "DEMO-WEIGHT",
    name: "Demo Measured Item",
    category: "DEMO-MATERIALS",
    unit: "KG",
    price: "100.0000",
    cost: "40.0000",
  },
  {
    sku: "DEMO-SPARSE",
    name: "Demo Sparse Item",
    category: null,
    unit: "EA",
    price: "12.0000",
    cost: "6.0000",
  },
  {
    sku: "DEMO-NEW",
    name: "Demo New Item",
    category: "DEMO-MATERIALS",
    unit: "EA",
    price: "25.0000",
    cost: "12.0000",
  },
  {
    sku: "DEMO-ARCHIVED",
    name: "Demo Archived Item",
    category: "DEMO-MATERIALS",
    unit: "EA",
    price: "15.0000",
    cost: "7.0000",
  },
] as const;
type Product = (typeof products)[number];
type Branch = (typeof branches)[number];
type Stock = {
  quantity: Prisma.Decimal;
  average: Prisma.Decimal;
  value: Prisma.Decimal;
  createdAt: Date;
  updatedAt: Date;
};

const users = [
  {
    email: "demo-owner@example.invalid",
    role: "OWNER",
    name: "Demo Owner",
    branch: null,
  },
  {
    email: "demo-manager-a@example.invalid",
    role: "BRANCH_MANAGER",
    name: "Demo Manager A",
    branch: "DEMO-A",
  },
  {
    email: "demo-inventory-b@example.invalid",
    role: "INVENTORY_STAFF",
    name: "Demo Inventory B",
    branch: "DEMO-B",
  },
  {
    email: "demo-cashier-a@example.invalid",
    role: "CASHIER",
    name: "Demo Cashier A",
    branch: "DEMO-A",
  },
] as const;
const userId = (email: string) => demoId("user", email);
const membershipId = (email: string) =>
  demoId("membership", `DEMO-ORGANIZATION|${email}`);
const branchId = (branch: Branch) => demoId("branch", branch);
const productId = (sku: string) => demoId("product", sku);
const hash = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

function at(date: string, localHour: number, minute = 0): Date {
  return new Date(
    localDateToUtcBoundary(date, timezone).getTime() +
      localHour * hour +
      minute * 60_000,
  );
}

function dateOnly(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

function previous(date: string): string {
  return Temporal.PlainDate.from(date).subtract({ days: 1 }).toString();
}

function nextMonth(date: string): string {
  return Temporal.PlainDate.from(date)
    .add({ months: 1 })
    .with({ day: 1 })
    .toString();
}

function dates(from: string, to: string): string[] {
  const result: string[] = [];
  for (
    let day = Temporal.PlainDate.from(from);
    day.toString() < to;
    day = day.add({ days: 1 })
  )
    result.push(day.toString());
  return result;
}

function product(sku: string): Product {
  const found = products.find((candidate) => candidate.sku === sku);
  if (!found) throw new Error(`Unknown demo SKU ${sku}.`);
  return found;
}

function same(left: Prisma.Decimal, right: Prisma.Decimal): void {
  if (!left.equals(right))
    throw new Error(`Fixture reconciliation failed: ${left} != ${right}.`);
}

// Fixture-only historical construction. The public write services assign live
// timestamps; this builder reproduces their calculations and persists all
// linked rows together, without offering a backdating application path.
export async function buildDemoFixture(password: string) {
  const passwordHashes = await Promise.all(
    users.map(() => hashPassword(password)),
  );
  const organization: Prisma.OrganizationCreateManyInput[] = [
    {
      id: organizationId,
      name: "DEMO-ORGANIZATION",
      status: "ACTIVE",
      salesVatStatus: "REGISTERED",
      salesVatRate: decimal("7.000000"),
      reportingTimezone: timezone,
      deactivatedAt: null,
      createdAt: bootstrap,
      updatedAt: bootstrap,
    },
  ];
  const branchRows: Prisma.BranchCreateManyInput[] = branches.map((code) => ({
    id: branchId(code),
    organizationId,
    code,
    name: code,
    phone: null,
    address: null,
    status: "ACTIVE",
    deactivatedAt: null,
    createdAt: bootstrap,
    updatedAt: bootstrap,
  }));
  const userRows: Prisma.UserCreateManyInput[] = users.map((user) => ({
    id: userId(user.email),
    email: user.email,
    status: "ACTIVE",
    displayName: user.name,
    phone: null,
    emailVerifiedAt: bootstrap,
    passwordChangedAt: bootstrap,
    disabledAt: null,
    createdAt: bootstrap,
    updatedAt: bootstrap,
  }));
  const memberships: Prisma.OrganizationMembershipCreateManyInput[] = users.map(
    (user) => ({
      id: membershipId(user.email),
      organizationId,
      userId: userId(user.email),
      role: user.role,
      status: "ACTIVE",
      deactivatedAt: null,
      sourceInvitationId: null,
      createdAt: bootstrap,
      updatedAt: bootstrap,
    }),
  );
  const assignments: Prisma.BranchAssignmentCreateManyInput[] = users
    .filter((user) => user.branch !== null)
    .map((user) => ({
      organizationId,
      userId: userId(user.email),
      branchId: branchId(user.branch),
      status: "ACTIVE",
      deactivatedAt: null,
      createdAt: bootstrap,
      updatedAt: bootstrap,
    }));
  const onboardingInput = {
    displayName: users[0].name,
    phone: null,
    organizationName: organization[0]!.name,
    branchName: branchRows[0]!.name,
    branchPhone: null,
    branchAddress: null,
  };
  const onboarding: Prisma.FirstOrganizationOnboardingCreateManyInput[] = [
    {
      userId: userId(users[0].email),
      organizationId,
      branchId: branchId("DEMO-A"),
      requestHash: hashFirstOrganizationOnboardingRequest(onboardingInput),
      completedAt: bootstrap,
    },
  ];
  const categories: Prisma.CategoryCreateManyInput[] = [
    "DEMO-STAPLES",
    "DEMO-MATERIALS",
  ].map((name) => ({
    id: demoId("category", name),
    organizationId,
    name,
    normalizedName: name.toLocaleLowerCase("en-US"),
    description: null,
    status: "ACTIVE",
    createdAt: bootstrap,
    updatedAt: bootstrap,
  }));
  const productRows: Prisma.ProductCreateManyInput[] = products.map((item) => ({
    id: productId(item.sku),
    organizationId,
    categoryId:
      item.category === null ? null : demoId("category", item.category),
    name: item.name,
    description: null,
    sku: item.sku,
    barcode: null,
    basePrice: decimal(item.price),
    unit: item.unit,
    status: item.sku === "DEMO-ARCHIVED" ? "INACTIVE" : "ACTIVE",
    createdAt: bootstrap,
    updatedAt: item.sku === "DEMO-ARCHIVED" ? at("2025-01-02", 9) : bootstrap,
  }));
  const suppliers: Prisma.SupplierCreateManyInput[] = [
    {
      id: supplierId,
      organizationId,
      name: "DEMO-SUPPLIER",
      contactName: null,
      email: null,
      phone: null,
      address: null,
      status: "ACTIVE",
      createdAt: bootstrap,
      updatedAt: bootstrap,
    },
  ];
  const orders: Prisma.PurchaseOrderCreateManyInput[] = [];
  const orderItems: Prisma.PurchaseOrderItemCreateManyInput[] = [];
  const receipts: Prisma.PurchaseReceiptCreateManyInput[] = [];
  const receiptItems: Prisma.PurchaseReceiptItemCreateManyInput[] = [];
  const sales: Prisma.SaleCreateManyInput[] = [];
  const saleItems: Prisma.SaleItemCreateManyInput[] = [];
  const payments: Prisma.PaymentCreateManyInput[] = [];
  const refunds: Prisma.SaleRefundCreateManyInput[] = [];
  const refundItems: Prisma.SaleRefundItemCreateManyInput[] = [];
  const refundPayments: Prisma.RefundPaymentCreateManyInput[] = [];
  const movements: Prisma.InventoryTransactionCreateManyInput[] = [];
  const stock = new Map<string, Stock>();

  function stockKey(branch: Branch, sku: string): string {
    return `${branch}|${sku}`;
  }
  function current(branch: Branch, sku: string): Stock | undefined {
    return stock.get(stockKey(branch, sku));
  }
  function move(
    branch: Branch,
    sku: string,
    delta: Prisma.Decimal,
    occurredAt: Date,
    data: Omit<
      Prisma.InventoryTransactionCreateManyInput,
      | "id"
      | "organizationId"
      | "branchId"
      | "productId"
      | "delta"
      | "occurredAt"
    > & { id: string },
  ): Stock {
    const prior = current(branch, sku);
    const quantity = (prior?.quantity ?? zero).plus(delta);
    if (
      quantity.isNegative() ||
      (product(sku).unit === "EA" && !quantity.isInteger())
    ) {
      throw new Error(
        `Negative or fractional stock at ${branch}/${sku}/${occurredAt.toISOString()}.`,
      );
    }
    movements.push({
      ...data,
      organizationId,
      branchId: branchId(branch),
      productId: productId(sku),
      delta,
      occurredAt,
    });
    const result: Stock = {
      quantity,
      average: prior?.average ?? zero,
      value: prior?.value ?? zero,
      createdAt: prior?.createdAt ?? occurredAt,
      updatedAt: occurredAt,
    };
    stock.set(stockKey(branch, sku), result);
    return result;
  }

  // Events are built in local-date order. Persistence below is dependency
  // ordered, while occurredAt and source IDs preserve historical chronology.
  for (const date of dates("2025-01-01", "2026-09-26")) {
    if (date.endsWith("-01")) {
      for (const branch of branches) receipt(branch, date, false);
    }
    if (date === "2026-09-12") receipt("DEMO-A", date, true);
    if (date === "2026-07-15" || date === "2026-07-16") adjustment(date);
    for (const branch of branches) sale(branch, date);
    if (date === "2026-09-21") refund();
  }

  function receipt(branch: Branch, date: string, isNew: boolean): void {
    const orderId = demoId("purchase-order", `${branch}|${date}`);
    const receiptId = demoId("purchase-receipt", `${branch}|${date}`);
    const receiptAt = at(date, 8);
    const orderedAt = at(previous(date), 10, 1);
    const lines = isNew
      ? ["DEMO-NEW"]
      : branch === "DEMO-A"
        ? ["DEMO-STABLE", "DEMO-WEEKLY", "DEMO-WEIGHT", "DEMO-SPARSE"]
        : ["DEMO-STABLE"];
    if (date === "2025-01-01")
      lines.push(branch === "DEMO-A" ? "DEMO-ARCHIVED" : "DEMO-SPARSE");
    const quantities = lines.map((sku) => {
      if (sku === "DEMO-ARCHIVED") return decimal(1);
      if (branch === "DEMO-B" && sku === "DEMO-SPARSE") return decimal(5);
      if (sku === "DEMO-NEW") return decimal(15);
      const end =
        nextMonth(date) < "2026-09-26" ? nextMonth(date) : "2026-09-26";
      const demand = dates(date, end).reduce(
        (total, day) => total.plus(demoDemand(day, branch, sku)),
        zero,
      );
      const buffer =
        date === "2025-01-01"
          ? {
              "DEMO-A|DEMO-STABLE": "3",
              "DEMO-A|DEMO-WEEKLY": "110",
              "DEMO-A|DEMO-WEIGHT": "0.7500",
              "DEMO-A|DEMO-SPARSE": "1",
              "DEMO-B|DEMO-STABLE": "10",
            }[stockKey(branch, sku)]
          : undefined;
      return demand.plus(buffer ?? "0");
    });
    orders.push({
      id: orderId,
      organizationId,
      branchId: branchId(branch),
      supplierId,
      reference: `PO-${orderId}`,
      status: "RECEIVED",
      orderDate: dateOnly(previous(date)),
      expectedDate: null,
      currency: "THB",
      expectedTotal: expectedPurchaseOrderTotal(
        lines.map((sku, index) => ({
          expectedUnitCost: decimal(product(sku).cost),
          quantity: quantities[index]!,
        })),
      ),
      createdByUserId: userId(users[0].email),
      createdByMembershipId: membershipId(users[0].email),
      orderedAt,
      cancelledAt: null,
      receivedAt: receiptAt,
      createdAt: at(previous(date), 10),
      updatedAt: receiptAt,
    });
    const costs: Array<{
      actualUnitCost: string;
      purchaseOrderItemId: string;
    }> = [];
    for (const [index, sku] of lines.entries()) {
      const item = product(sku);
      const quantity = quantities[index]!;
      if (
        !quantity.greaterThan(0) ||
        (item.unit === "EA" && !quantity.isInteger())
      )
        throw new Error("Invalid receipt quantity.");
      const orderItemId = demoId(
        "purchase-order-item",
        `${branch}|${date}|${sku}`,
      );
      const receiptItemId = demoId(
        "purchase-receipt-item",
        `${branch}|${date}|${sku}`,
      );
      const actualUnitCost = decimal(item.cost);
      orderItems.push({
        id: orderItemId,
        purchaseOrderId: orderId,
        organizationId,
        productId: productId(sku),
        productSkuSnapshot: sku,
        productNameSnapshot: item.name,
        quantity,
        expectedUnitCost: actualUnitCost,
        createdAt: at(previous(date), 10),
        updatedAt: orderedAt,
      });
      receiptItems.push({
        id: receiptItemId,
        receiptId,
        purchaseOrderId: orderId,
        purchaseOrderItemId: orderItemId,
        organizationId,
        branchId: branchId(branch),
        productId: productId(sku),
        productSkuSnapshot: sku,
        productNameSnapshot: item.name,
        receivedQuantity: quantity,
        actualUnitCost,
        createdAt: receiptAt,
      });
      costs.push({
        purchaseOrderItemId: orderItemId,
        actualUnitCost: actualUnitCost.toFixed(4),
      });
      const old = current(branch, sku);
      const oldQuantity = old?.quantity ?? zero;
      const updated = move(branch, sku, quantity, receiptAt, {
        id: demoId("inventory-transaction", `receipt|${branch}|${date}|${sku}`),
        source: "PURCHASE_RECEIVE",
        adjustmentReason: null,
        note: null,
        actorUserId: userId(users[0].email),
        actorMembershipId: membershipId(users[0].email),
        idempotencyKeyHash: null,
        canonicalRequestHash: null,
        purchaseReceiptItemId: receiptItemId,
        saleItemId: null,
        saleRefundItemId: null,
      });
      if (old === undefined || oldQuantity.isZero())
        updated.average = actualUnitCost.toDecimalPlaces(6);
      else
        updated.average = oldQuantity
          .times(old.average)
          .plus(quantity.times(actualUnitCost))
          .dividedBy(updated.quantity)
          .toDecimalPlaces(6, Prisma.Decimal.ROUND_HALF_UP);
      updated.value = updated.quantity
        .times(updated.average)
        .toDecimalPlaces(10, Prisma.Decimal.ROUND_HALF_UP);
    }
    const vat = {
      inputVatAmount: null,
      inputVatRate: null,
      organizationVatRegistered: true,
      supplierTaxDocumentDate: null,
      supplierTaxDocumentNumber: null,
    };
    receipts.push({
      id: receiptId,
      organizationId,
      branchId: branchId(branch),
      supplierId,
      purchaseOrderId: orderId,
      reference: `RCPT-${receiptId}`,
      receivedAt: receiptAt,
      receivedByUserId: userId(users[0].email),
      receivedByMembershipId: membershipId(users[0].email),
      idempotencyKeyHash: receivingIdempotencyKeyHash(
        `stockwise-demo-v1|receipt|${branch}|${date}`,
      ),
      canonicalRequestHash: receivingCanonicalRequestHash({
        actualCosts: costs,
        purchaseOrderId: orderId,
        vat,
      }),
      organizationVatRegisteredSnapshot: true,
      inputVatRate: null,
      inputVatAmount: null,
      supplierTaxDocumentNumber: null,
      supplierTaxDocumentDate: null,
      createdAt: receiptAt,
      updatedAt: receiptAt,
    });
  }

  function sale(branch: Branch, date: string): void {
    const actor = branch === "DEMO-A" ? users[3] : users[0];
    const actorUserId = userId(actor.email);
    const actorMembershipId = membershipId(actor.email);
    const saleId = demoId("sale", `${branch}|${date}`);
    const completedAt = at(date, 12);
    const requested = products
      .filter((item) => item.sku !== "DEMO-ARCHIVED")
      .map((item) => ({
        item,
        quantity: decimal(demoDemand(date, branch, item.sku)),
      }))
      .filter((line) => line.quantity.greaterThan(0))
      .sort((left, right) =>
        productId(left.item.sku).localeCompare(productId(right.item.sku)),
      );
    if (requested.length === 0)
      throw new Error("A completed demo Sale cannot be empty.");
    const discount =
      branch === "DEMO-B" && date === "2026-09-10"
        ? { type: "AMOUNT" as const, amount: "5.00", reason: "Demo adjustment" }
        : null;
    const amounts = calculateCheckoutAmounts({
      discount:
        discount === null
          ? null
          : { ...discount, amount: decimal(discount.amount) },
      lines: requested.map(({ item, quantity }) => ({
        productId: productId(item.sku),
        quantity,
        unitPrice: decimal(item.price),
      })),
      salesVatStatus: "REGISTERED",
      salesVatRate: decimal("7.000000"),
    });
    if (amounts === null) throw new Error("Invalid demo Sale amount.");
    const canonical = canonicalizeCheckoutIntent({
      discount,
      items: requested.map(({ item, quantity }) => ({
        productId: productId(item.sku),
        expectedUnitPrice: item.price,
        quantity: canonicalQuantity(quantity),
      })),
      payment: {
        method: "CASH",
        amountTendered: amounts.totalAmount.toFixed(2),
      },
    });
    if (canonical.kind !== "valid")
      throw new Error("Invalid demo checkout intent.");
    sales.push({
      id: saleId,
      organizationId,
      branchId: branchId(branch),
      actorUserId,
      actorMembershipId,
      reference: `SALE-${saleId}`,
      currency: "THB",
      organizationNameSnapshot: organization[0]!.name,
      branchNameSnapshot: branch,
      branchCodeSnapshot: branch,
      actorDisplayNameSnapshot: actor.name,
      subtotalAmount: amounts.subtotalAmount,
      discountType: discount?.type ?? null,
      discountAmountInput: discount === null ? null : decimal(discount.amount),
      discountPercentInput: null,
      discountReason: discount?.reason ?? null,
      discountAmount: amounts.discountAmount,
      salesVatStatusSnapshot: "REGISTERED",
      salesVatRateSnapshot: decimal("7.000000"),
      taxableAmount: amounts.taxableAmount,
      outputVatAmount: amounts.outputVatAmount,
      totalAmount: amounts.totalAmount,
      idempotencyOperation: "SALE_CHECKOUT",
      idempotencyKeyHash: checkoutIdempotencyKeyHash(
        `stockwise-demo-v1|sale|${branch}|${date}`,
      ),
      canonicalRequestHash: checkoutCanonicalRequestHash({
        actorUserId,
        branchId: branchId(branch),
        intent: canonical.intent,
        organizationId,
      }),
      completedAt,
      createdAt: completedAt,
    });
    for (const [index, { item, quantity }] of requested.entries()) {
      const prior = current(branch, item.sku);
      if (!prior || prior.quantity.lessThan(quantity))
        throw new Error(
          `Insufficient demo stock: ${branch}/${item.sku}/${date}.`,
        );
      const unitCost = prior.average;
      const cogsAmount = quantity
        .times(unitCost)
        .toDecimalPlaces(10, Prisma.Decimal.ROUND_HALF_UP);
      const allocation = amounts.lines[index]!;
      const saleItemId = demoId("sale-item", `${branch}|${date}|${item.sku}`);
      saleItems.push({
        id: saleItemId,
        saleId,
        organizationId,
        branchId: branchId(branch),
        productId: productId(item.sku),
        productSkuSnapshot: item.sku,
        productNameSnapshot: item.name,
        productUnitSnapshot: item.unit,
        quantity,
        unitPrice: decimal(item.price),
        lineGross: allocation.lineGross,
        lineDiscount: allocation.lineDiscount,
        lineNet: allocation.lineNet,
        lineTaxable: allocation.lineTaxable,
        lineOutputVat: allocation.lineOutputVat,
        costBasisState: "KNOWN",
        unitCost,
        cogsAmount,
        createdAt: completedAt,
      });
      const updated = move(branch, item.sku, quantity.negated(), completedAt, {
        id: demoId(
          "inventory-transaction",
          `sale|${branch}|${date}|${item.sku}`,
        ),
        source: "SALE",
        adjustmentReason: null,
        note: null,
        actorUserId,
        actorMembershipId,
        idempotencyKeyHash: null,
        canonicalRequestHash: null,
        purchaseReceiptItemId: null,
        saleItemId,
        saleRefundItemId: null,
      });
      updated.value = updated.quantity
        .times(updated.average)
        .toDecimalPlaces(10, Prisma.Decimal.ROUND_HALF_UP);
    }
    payments.push({
      id: demoId("payment", `${branch}|${date}`),
      saleId,
      organizationId,
      branchId: branchId(branch),
      method: "CASH",
      amount: amounts.totalAmount,
      amountTendered: amounts.totalAmount,
      changeAmount: zero,
      transferReference: null,
      confirmedAt: completedAt,
      createdAt: completedAt,
    });
  }

  function adjustment(date: string): void {
    const reason = date === "2026-07-15" ? "FOUND" : "DAMAGE";
    const parsed = parseInventoryDelta(reason === "FOUND" ? "+1" : "-1", "EA");
    if (parsed === null) throw new Error("Invalid demo adjustment.");
    const occurredAt = at(date, 9);
    const actorUserId = userId(users[0].email);
    const key = `stockwise-demo-v1|adjustment|DEMO-A|${date}|${reason}|DEMO-STABLE`;
    const updated = move("DEMO-A", "DEMO-STABLE", parsed, occurredAt, {
      id: demoId(
        "inventory-transaction",
        `adjustment|DEMO-A|${date}|${reason}|DEMO-STABLE`,
      ),
      source: "MANUAL_ADJUSTMENT",
      adjustmentReason: reason,
      note: "Demo adjustment",
      actorUserId,
      actorMembershipId: membershipId(users[0].email),
      idempotencyKeyHash: hash(key),
      canonicalRequestHash: adjustmentRequestHash({
        actorUserId,
        branchId: branchId("DEMO-A"),
        delta: canonicalQuantity(parsed),
        note: "Demo adjustment",
        organizationId,
        productId: productId("DEMO-STABLE"),
        reason,
      }),
      purchaseReceiptItemId: null,
      saleItemId: null,
      saleRefundItemId: null,
    });
    updated.value = updated.quantity
      .times(updated.average)
      .toDecimalPlaces(10, Prisma.Decimal.ROUND_HALF_UP);
  }

  function refund(): void {
    const branch = "DEMO-A";
    const completedAt = at("2026-09-21", 14);
    const originalSaleId = demoId("sale", "DEMO-A|2026-09-20");
    const originalItemId = demoId("sale-item", "DEMO-A|2026-09-20|DEMO-WEIGHT");
    const original = saleItems.find((item) => item.id === originalItemId);
    if (!original) throw new Error("Refund SaleItem is missing.");
    const originalQuantity = decimal(String(original.quantity));
    const originalCost = original.unitCost;
    if (originalCost === null || originalCost === undefined)
      throw new Error("Refund cost snapshot is missing.");
    const canonical = canonicalizeRefundIntent({
      items: [
        {
          saleItemId: originalItemId,
          quantity: "0.5000",
          restockQuantity: "0.2500",
        },
      ],
      reason: "Demo return",
      transferReference: null,
    });
    if (canonical.kind !== "valid")
      throw new Error("Invalid demo refund intent.");
    const amounts = calculateRefundLineAmounts({
      cumulativeQuantity: decimal("0.5000"),
      cumulativeRestockQuantity: decimal("0.2500"),
      originalCogsAmount: decimal(String(original.cogsAmount)),
      originalLineDiscount: decimal(String(original.lineDiscount)),
      originalLineNet: decimal(String(original.lineNet)),
      originalLineOutputVat: decimal(String(original.lineOutputVat)),
      originalQuantity,
      priorCogsReversal: zero,
      priorLineDiscount: zero,
      priorLineNet: zero,
      priorLineOutputVat: zero,
      salesVatStatus: "REGISTERED",
    });
    same(amounts.reversedLineNet, decimal("50.00"));
    same(amounts.cogsReversalAmount!, decimal("10.0000000000"));
    const refundId = demoId("refund", "DEMO-A|2026-09-21|2026-09-20");
    const refundItemId = demoId(
      "refund-item",
      "DEMO-A|2026-09-21|2026-09-20|DEMO-WEIGHT",
    );
    const actorUserId = userId(users[0].email);
    refunds.push({
      id: refundId,
      organizationId,
      branchId: branchId(branch),
      saleId: originalSaleId,
      actorUserId,
      actorMembershipId: membershipId(users[0].email),
      reference: `REFUND-${refundId}`,
      currency: "THB",
      actorDisplayNameSnapshot: users[0].name,
      reason: "Demo return",
      grossAmount: amounts.reversedLineGross,
      discountAmount: amounts.reversedLineDiscount,
      salesVatStatusSnapshot: "REGISTERED",
      salesVatRateSnapshot: decimal("7.000000"),
      taxableAmount: amounts.reversedLineTaxable,
      outputVatAmount: amounts.reversedLineOutputVat,
      totalAmount: amounts.reversedLineNet,
      idempotencyOperation: "SALE_REFUND",
      idempotencyKeyHash: refundIdempotencyKeyHash(
        "stockwise-demo-v1|refund|DEMO-A|2026-09-21|2026-09-20",
      ),
      canonicalRequestHash: refundCanonicalRequestHash({
        actorUserId,
        branchId: branchId(branch),
        intent: canonical.intent,
        organizationId,
        paymentMethod: "CASH",
        saleId: originalSaleId,
      }),
      completedAt,
      createdAt: completedAt,
    });
    refundItems.push({
      id: refundItemId,
      saleRefundId: refundId,
      saleId: originalSaleId,
      saleItemId: originalItemId,
      organizationId,
      branchId: branchId(branch),
      productId: productId("DEMO-WEIGHT"),
      refundQuantity: decimal("0.5000"),
      restockQuantity: decimal("0.2500"),
      reversedLineGross: amounts.reversedLineGross,
      reversedLineDiscount: amounts.reversedLineDiscount,
      reversedLineNet: amounts.reversedLineNet,
      reversedLineTaxable: amounts.reversedLineTaxable,
      reversedLineOutputVat: amounts.reversedLineOutputVat,
      originalCostBasisState: "KNOWN",
      originalUnitCost: originalCost,
      cogsReversalAmount: amounts.cogsReversalAmount,
      createdAt: completedAt,
    });
    const prior = current(branch, "DEMO-WEIGHT");
    if (!prior) throw new Error("Refund stock cost is missing.");
    const updated = move(
      branch,
      "DEMO-WEIGHT",
      decimal("0.2500"),
      completedAt,
      {
        id: demoId(
          "inventory-transaction",
          "refund|DEMO-A|2026-09-21|2026-09-20|DEMO-WEIGHT",
        ),
        source: "SALE_REFUND_RETURN",
        adjustmentReason: null,
        note: null,
        actorUserId,
        actorMembershipId: membershipId(users[0].email),
        idempotencyKeyHash: null,
        canonicalRequestHash: null,
        purchaseReceiptItemId: null,
        saleItemId: null,
        saleRefundItemId: refundItemId,
      },
    );
    updated.average = prior.quantity
      .times(prior.average)
      .plus(decimal("0.2500").times(decimal(String(originalCost))))
      .dividedBy(updated.quantity)
      .toDecimalPlaces(6, Prisma.Decimal.ROUND_HALF_UP);
    updated.value = updated.quantity
      .times(updated.average)
      .toDecimalPlaces(10, Prisma.Decimal.ROUND_HALF_UP);
    refundPayments.push({
      id: demoId("refund-payment", "DEMO-A|2026-09-21|2026-09-20"),
      saleRefundId: refundId,
      saleId: originalSaleId,
      organizationId,
      branchId: branchId(branch),
      method: "CASH",
      amount: amounts.reversedLineNet,
      transferReference: null,
      confirmedAt: completedAt,
      createdAt: completedAt,
    });
  }

  const balances: Prisma.InventoryBalanceCreateManyInput[] = [];
  const costs: Prisma.InventoryCostStateCreateManyInput[] = [];
  for (const [key, state] of stock) {
    const [branch, sku] = key.split("|") as [Branch, string];
    const identity = {
      organizationId,
      branchId: branchId(branch),
      productId: productId(sku),
    };
    balances.push({
      id: demoId("inventory-balance", `${branch}|${sku}`),
      ...identity,
      quantity: state.quantity,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
    });
    costs.push({
      id: demoId("inventory-cost-state", `${branch}|${sku}`),
      ...identity,
      basisState: "KNOWN",
      inventoryValue: state.value,
      averageUnitCost: state.average,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
    });
  }
  if (
    sales.length !== 1266 ||
    payments.length !== 1266 ||
    saleItems.length !== 2488 ||
    orders.length !== 43 ||
    receipts.length !== 43 ||
    receiptItems.length !== 108 ||
    movements.length !== 2599 ||
    refunds.length !== 1 ||
    refundItems.length !== 1 ||
    refundPayments.length !== 1
  )
    throw new Error("Demo fixture counts drifted from stockwise-demo-v1.");

  // One Argon2id verifier per demo user: stored only as the Better Auth
  // credential account password (users has no hash column).
  const credentials = users.map((user, index) => ({
    userId: userId(user.email),
    passwordHash: passwordHashes[index]!,
  }));
  return {
    organization,
    branchRows,
    userRows,
    credentials,
    memberships,
    assignments,
    onboarding,
    categories,
    productRows,
    suppliers,
    orders,
    orderItems,
    receipts,
    receiptItems,
    sales,
    saleItems,
    payments,
    refunds,
    refundItems,
    refundPayments,
    balances,
    costs,
    movements,
  };
}
