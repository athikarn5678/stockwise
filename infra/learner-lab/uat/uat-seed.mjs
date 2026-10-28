#!/usr/bin/env node
// Seeds realistic, persistent demo data through the PUBLIC business API using
// real logins for each role (so RBAC, ledger, idempotency and non-negative
// stock rules are exercised exactly as in production). Rerunnable: every stage
// looks before it writes, and writes carry deterministic Idempotency-Keys.
//   node infra/learner-lab/uat/uat-seed.mjs --csv <credentials.csv> [--base <url> --origin <origin>]
import process from "node:process";
import {
  ACCOUNTS,
  BRANCHES_A,
  BRANCH_STOCKING,
  CATEGORIES,
  ORG_A,
  ORG_B,
  ORG_B_BRANCH,
  PRODUCTS,
  SUPPLIERS,
  barcodeFor,
  baseQuantity,
} from "./uat-plan.mjs";
import {
  ApiSession,
  arg,
  errorCode,
  expectStatus,
  log,
  readCredentials,
} from "./uat-lib.mjs";

const baseUrl = arg("base", "https://stockwise.hcn920.com");
const origin = arg("origin", baseUrl);
const credentials = readCredentials(arg("csv"));
const sessions = new Map();

async function as(key) {
  if (sessions.has(key)) return sessions.get(key);
  const account = ACCOUNTS.find((a) => a.key === key);
  const row = credentials.get(account.email);
  if (!row) throw new Error(`no credentials for ${key}`);
  const session = new ApiSession({ baseUrl, origin, label: key });
  const result = await session.login(account.email, row["Temporary Password"]);
  expectStatus(result, 200, `login ${key}`);
  sessions.set(key, session);
  return session;
}

const data = (result) => result.body?.data;
// Single-entity responses are wrapped (data.product, data.purchaseOrder, ...).
// Unwraps { purchaseOrder: {...} } style bodies; flat bodies pass through.
const one = (result) => {
  const body = data(result);
  if (body && typeof body === "object" && !("id" in body)) {
    const nested = Object.values(body).filter(
      (v) => v && typeof v === "object" && !Array.isArray(v) && "id" in v,
    );
    if (nested.length === 1) return nested[0];
  }
  return body;
};
const today = new Date();
const isoDate = (offsetDays) =>
  new Date(today.getTime() + offsetDays * 86_400_000)
    .toISOString()
    .slice(0, 10);

async function listAll(session, path, query = {}) {
  const items = [];
  let cursor;
  for (let page = 0; page < 50; page += 1) {
    const result = expectStatus(
      await session.get(path, { query: { ...query, limit: 100, cursor } }),
      200,
      `list ${path}`,
    );
    const body = data(result);
    const rows = Array.isArray(body)
      ? body
      : (body?.items ??
        body?.products ??
        body?.categories ??
        body?.suppliers ??
        body?.purchaseOrders ??
        body?.members ??
        []);
    items.push(...rows);
    cursor = result.body?.meta?.nextCursor ?? undefined;
    if (!cursor) break;
  }
  return items;
}

// ---- Stage 1: onboarding (creates the two organizations through the real flow)
async function ensureOrganization(creatorKey, organizationName, branch) {
  const session = await as(creatorKey);
  let context = data(
    expectStatus(await session.get("me/access-context"), 200, "access-context"),
  );
  let organization = context.organizations.find(
    (o) => o.name === organizationName,
  );
  if (!organization) {
    const account = ACCOUNTS.find((a) => a.key === creatorKey);
    expectStatus(
      await session.post("organizations", {
        displayName: account.name,
        organizationName,
        branchName: branch.name,
        branchPhone: branch.phone,
        branchAddress: branch.address,
      }),
      [200, 201],
      `onboarding ${creatorKey}`,
    );
    context = data(
      expectStatus(
        await session.get("me/access-context"),
        200,
        "access-context",
      ),
    );
    organization = context.organizations.find(
      (o) => o.name === organizationName,
    );
    log(`created organization ${creatorKey} -> ${organization?.id}`);
  } else log(`organization exists ${organizationName} (${organization.id})`);
  return organization.id;
}

async function ensureBranches(session, organizationId) {
  const existing = data(
    expectStatus(
      await session.get(`organizations/${organizationId}/branches`, {
        query: { includeInactive: "true" },
      }),
      200,
      "list branches",
    ),
  );
  const rows = Array.isArray(existing) ? existing : (existing?.branches ?? []);
  const byCode = new Map(rows.map((b) => [b.code, b]));
  for (const wanted of BRANCHES_A) {
    if (byCode.has(wanted.code)) continue;
    if (wanted.code === "MAIN")
      throw new Error("MAIN branch missing after onboarding");
    // Code intentionally omitted: BRANCH-01 generates BR-001, BR-002, ...
    const created = one(
      expectStatus(
        await session.post(`organizations/${organizationId}/branches`, {
          name: wanted.name,
          phone: wanted.phone,
          address: wanted.address,
        }),
        201,
        `create branch ${wanted.name}`,
      ),
    );
    byCode.set(created.code, created);
    log(`branch created ${created.code} (generated)`);
    if (created.code !== wanted.code)
      throw new Error(
        `generated branch code ${created.code} differs from plan ${wanted.code}`,
      );
  }
  // Align MAIN's display data with the plan (idempotent PATCH only when different).
  return Object.fromEntries([...byCode].map(([code, b]) => [code, b.id]));
}

async function ensureVat(session, organizationId, status, rate) {
  const profile = data(
    expectStatus(
      await session.get(`organizations/${organizationId}/sales-vat-profile`),
      200,
      "get vat",
    ),
  ).salesVatProfile;
  if (profile.salesVatStatus !== "UNCONFIGURED")
    return log(`vat already ${profile.salesVatStatus}`);
  expectStatus(
    await session.patch(`organizations/${organizationId}/sales-vat-profile`, {
      expectedUpdatedAt: profile.updatedAt,
      salesVatStatus: status,
      salesVatRate: rate,
    }),
    200,
    "set vat",
  );
  log(`vat set ${status}`);
}

async function ensureCatalog(
  session,
  organizationId,
  products,
  categories,
  suppliers,
) {
  const catRows = await listAll(
    session,
    `organizations/${organizationId}/categories`,
    { includeInactive: "true" },
  );
  const categoryId = new Map(catRows.map((c) => [c.name, c.id]));
  for (const name of categories) {
    if (categoryId.has(name)) continue;
    const created = one(
      expectStatus(
        await session.post(`organizations/${organizationId}/categories`, {
          name,
        }),
        201,
        `category ${name}`,
      ),
    );
    categoryId.set(name, created.id);
  }
  const productRows = await listAll(
    session,
    `organizations/${organizationId}/products`,
    { includeInactive: "true" },
  );
  const productId = new Map(productRows.map((p) => [p.sku, p.id]));
  for (const [index, product] of products.entries()) {
    if (productId.has(product.sku)) continue;
    const created = one(
      expectStatus(
        await session.post(`organizations/${organizationId}/products`, {
          sku: product.sku,
          name: product.name,
          barcode: barcodeFor(product.index ?? index),
          basePrice: product.price,
          unit: product.unit,
          categoryId: categoryId.get(categories[product.category]),
          description: "ข้อมูลทดสอบ UAT (สมมติ)",
        }),
        201,
        `product ${product.sku}`,
      ),
    );
    productId.set(product.sku, created.id);
  }
  const supplierRows = await listAll(
    session,
    `organizations/${organizationId}/suppliers`,
    { status: "all" },
  );
  const supplierId = new Map(supplierRows.map((s) => [s.name, s.id]));
  for (const supplier of suppliers) {
    if (supplierId.has(supplier.name)) continue;
    const created = one(
      expectStatus(
        await session.post(`organizations/${organizationId}/suppliers`, {
          name: supplier.name,
          contactName: supplier.contactName,
          phone: supplier.phone,
          address: supplier.address,
          email: null,
        }),
        201,
        `supplier ${supplier.name}`,
      ),
    );
    supplierId.set(supplier.name, created.id);
  }
  return { productId, supplierId };
}

// ---- Stage 3: purchasing + receiving through role accounts
function itemsFor(branchCode, supplierKey, scale = 1) {
  const stocking = BRANCH_STOCKING[branchCode];
  return PRODUCTS.filter(
    (p) => p.supplier === supplierKey && !stocking.skip.includes(p.sku),
  ).map((p) => ({
    sku: p.sku,
    quantity: String(
      Math.max(2, Math.round(baseQuantity(p) * stocking.factor * scale)),
    ),
    cost: p.cost,
  }));
}

async function createPo(
  session,
  organizationId,
  branchId,
  supplierId,
  productId,
  items,
  orderOffset,
) {
  const created = one(
    expectStatus(
      await session.post(
        `organizations/${organizationId}/branches/${branchId}/purchase-orders`,
        {
          supplierId,
          orderDate: isoDate(orderOffset),
          expectedDate: isoDate(orderOffset + 3),
          items: items.map((i) => ({
            productId: productId.get(i.sku),
            quantity: i.quantity,
            expectedUnitCost: i.cost,
          })),
        },
      ),
      201,
      "create PO",
    ),
  );
  return created;
}

async function poDetail(session, organizationId, branchId, id) {
  return one(
    expectStatus(
      await session.get(
        `organizations/${organizationId}/branches/${branchId}/purchase-orders/${id}`,
      ),
      200,
      "PO detail",
    ),
  );
}

async function advance(session, organizationId, branchId, po, status) {
  return one(
    expectStatus(
      await session.patch(
        `organizations/${organizationId}/branches/${branchId}/purchase-orders/${po.id}`,
        { status, expectedUpdatedAt: po.updatedAt },
      ),
      200,
      `PO -> ${status}`,
    ),
  );
}

async function receive(
  session,
  organizationId,
  branchId,
  po,
  key,
  vatRegistered,
) {
  const detail = await poDetail(session, organizationId, branchId, po.id);
  const lines = detail.items ?? [];
  const costBySku = new Map(PRODUCTS.map((p) => [p.sku, p.cost]));
  expectStatus(
    await session.post(
      `organizations/${organizationId}/branches/${branchId}/purchase-orders/${po.id}/receipts`,
      {
        actualCosts: lines.map((l) => ({
          purchaseOrderItemId: l.id,
          actualUnitCost:
            costBySku.get(l.skuSnapshot ?? l.sku) ?? l.expectedUnitCost,
        })),
        vat: {
          organizationVatRegistered: vatRegistered,
          inputVatRate: null,
          inputVatAmount: null,
          supplierTaxDocumentNumber: null,
          supplierTaxDocumentDate: null,
        },
      },
      { headers: { "idempotency-key": key } },
    ),
    [200, 201],
    "receive PO",
  );
}

async function purchasingStage(organizationId, branchIds, ids) {
  const plan = [
    // [branch, actor, [supplier, final status, order offset]]
    [
      "MAIN",
      "inventory-main",
      [
        ["S1", "RECEIVED", -9],
        ["S2", "RECEIVED", -8],
        ["S3", "RECEIVED", -8],
        ["S4", "RECEIVED", -7],
        ["S5", "ORDERED", -1],
        ["S3", "DRAFT", 0],
        ["S2", "CANCELLED", -3],
      ],
    ],
    [
      "BR-001",
      "inventory-cm",
      [
        ["S1", "RECEIVED", -6],
        ["S2", "RECEIVED", -6],
        ["S3", "RECEIVED", -5],
        ["S4", "ORDERED", -1],
        ["S5", "DRAFT", 0],
      ],
    ],
    [
      "BR-002",
      "manager-multi",
      [
        ["S1", "RECEIVED", -4],
        ["S2", "RECEIVED", -4],
        ["S3", "RECEIVED", -3],
        ["S5", "CANCELLED", -2],
      ],
    ],
  ];
  for (const [code, actor, orders] of plan) {
    const session = await as(actor);
    const branchId = branchIds[code];
    const existing = await listAll(
      session,
      `organizations/${organizationId}/branches/${branchId}/purchase-orders`,
      { status: "all" },
    );
    if (existing.length > 0) {
      log(
        `purchasing ${code}: ${existing.length} purchase orders exist, skipped`,
      );
      continue;
    }
    for (const [
      index,
      [supplierKey, finalStatus, offset],
    ] of orders.entries()) {
      const supplier = SUPPLIERS.find((s) => s.key === supplierKey);
      const items = itemsFor(
        code,
        supplierKey,
        finalStatus === "CANCELLED" || finalStatus === "DRAFT" ? 0.5 : 1,
      );
      if (items.length === 0) continue;
      let po = await createPo(
        session,
        organizationId,
        branchId,
        ids.supplierId.get(supplier.name),
        ids.productId,
        items,
        offset,
      );
      if (finalStatus !== "DRAFT")
        po = await advance(
          session,
          organizationId,
          branchId,
          po,
          finalStatus === "CANCELLED" ? "CANCELLED" : "ORDERED",
        );
      if (finalStatus === "RECEIVED")
        await receive(
          session,
          organizationId,
          branchId,
          po,
          `uat-seed-receipt-${code}-${index}`,
          true,
        );
      log(`PO ${code} #${index} ${supplierKey} -> ${finalStatus}`);
    }
  }
}

const RECEIVED_SUPPLIERS = {
  MAIN: ["S1", "S2", "S3", "S4"],
  "BR-001": ["S1", "S2", "S3"],
  "BR-002": ["S1", "S2", "S3"],
};

// ---- Stage 4: sales (POS) by cashiers/managers, plus adjustments and refunds
function* saleTemplates(code, skus, count) {
  for (let i = 0; i < count; i += 1) {
    const lines = [];
    const lineCount = 1 + (i % 4);
    for (let l = 0; l < lineCount; l += 1) {
      const sku = skus[(i * 7 + l * 3) % skus.length];
      const product = PRODUCTS.find((p) => p.sku === sku);
      const quantity =
        product.unit === "KG"
          ? l % 2 === 0
            ? "1.5000"
            : "2.0000"
          : String(1 + ((i + l) % 3));
      if (!lines.some((x) => x.sku === sku)) lines.push({ sku, quantity });
    }
    yield { key: `uat-seed-sale-${code}-${i}`, lines, transfer: i % 3 === 1 };
  }
}

async function salesStage(organizationId, branchIds, ids) {
  const plan = [
    ["MAIN", "cashier-main", 12, "manager-main"],
    ["BR-001", "cashier-cm", 8, "manager-cm"],
    ["BR-002", "cashier-kk", 5, "manager-multi"],
  ];
  const results = [];
  for (const [code, cashierKey, count, managerKey] of plan) {
    const cashier = await as(cashierKey);
    const manager = await as(managerKey);
    // Only suppliers whose purchase orders were RECEIVED at this branch have stock.
    const received = RECEIVED_SUPPLIERS[code];
    const stocked = PRODUCTS.filter(
      (p) =>
        received.includes(p.supplier) &&
        !BRANCH_STOCKING[code].skip.includes(p.sku),
    ).map((p) => p.sku);
    for (const sale of saleTemplates(code, stocked, count)) {
      const withDiscount = sale.key.endsWith("-4") || sale.key.endsWith("-9");
      const actor = withDiscount ? manager : cashier;
      const body = {
        items: sale.lines.map((l) => ({
          productId: ids.productId.get(l.sku),
          quantity: l.quantity,
          expectedUnitPrice: `${PRODUCTS.find((p) => p.sku === l.sku).price}00`,
        })),
        payment: sale.transfer
          ? {
              method: "TRANSFER",
              reference: `UAT-TRF-${sale.key.slice(-6).toUpperCase()}`,
            }
          : { method: "CASH", amountTendered: "2000.00" },
        ...(withDiscount
          ? {
              discount: {
                type: "PERCENT",
                percent: "10",
                reason: "ส่วนลดลูกค้าประจำ (ทดสอบ UAT)",
              },
            }
          : {}),
      };
      const result = await actor.post(
        `organizations/${organizationId}/branches/${branchIds[code]}/sales`,
        body,
        { headers: { "idempotency-key": sale.key } },
      );
      expectStatus(result, [200, 201], `sale ${sale.key}`);
      results.push({
        code,
        key: sale.key,
        id: one(result)?.id,
        replay: result.status === 200,
      });
    }
    log(`sales ${code}: ${count} requested (HTTP replays are no-ops)`);
  }
  return results;
}

async function adjustmentsAndRefunds(organizationId, branchIds, ids, sales) {
  // Damage / stock-count / found: real ledger movements with reasons.
  const adjustments = [
    [
      "MAIN",
      "inventory-main",
      "UAT-SNK-005",
      "-4",
      "DAMAGE",
      "uat-seed-adj-main-1",
    ],
    [
      "MAIN",
      "inventory-main",
      "UAT-BEV-003",
      "-6",
      "LOSS",
      "uat-seed-adj-main-2",
    ],
    ["BR-001", "manager-cm", "UAT-DAI-002", "5", "FOUND", "uat-seed-adj-cm-1"],
    [
      "BR-001",
      "inventory-cm",
      "UAT-SNK-001",
      "-3",
      "STOCK_COUNT",
      "uat-seed-adj-cm-2",
    ],
  ];
  for (const [code, actorKey, sku, delta, reason, key] of adjustments) {
    const session = await as(actorKey);
    expectStatus(
      await session.post(
        `organizations/${organizationId}/branches/${branchIds[code]}/inventory/adjustments`,
        {
          productId: ids.productId.get(sku),
          delta,
          reason,
          note: "ปรับปรุงสต็อกทดสอบ UAT",
        },
        { headers: { "idempotency-key": key } },
      ),
      [200, 201],
      `adjustment ${key}`,
    );
  }
  log(`adjustments applied: ${adjustments.length}`);
  // One partial refund with restock at MAIN by the branch manager.
  const first = sales.find((s) => s.code === "MAIN" && s.id);
  if (first) {
    const manager = await as("manager-main");
    const detail = one(
      expectStatus(
        await manager.get(
          `organizations/${organizationId}/branches/${branchIds.MAIN}/sales/${first.id}`,
        ),
        200,
        "sale detail",
      ),
    );
    const line = (detail.items ?? [])[0];
    if (line) {
      const result = await manager.post(
        `organizations/${organizationId}/branches/${branchIds.MAIN}/sales/${first.id}/refunds`,
        {
          items: [{ saleItemId: line.id, quantity: "1", restockQuantity: "1" }],
          reason: "สินค้าชำรุดจากลูกค้า (ทดสอบ UAT)",
          transferReference:
            detail.payment?.method === "TRANSFER" ? "UAT-RF-001" : null,
        },
        { headers: { "idempotency-key": "uat-seed-refund-main-1" } },
      );
      log(
        `refund MAIN -> HTTP ${result.status} ${result.ok ? "" : errorCode(result)}`,
      );
    }
  }
}

// ---- Organization B (isolation fixture)
async function orgB() {
  const organizationId = await ensureOrganization(
    "orgb-owner",
    ORG_B,
    ORG_B_BRANCH,
  );
  const owner = await as("orgb-owner");
  await ensureVat(owner, organizationId, "NOT_REGISTERED", null);
  const products = PRODUCTS.slice(0, 3).map((p, i) => ({
    ...p,
    sku: p.sku.replace("UAT-", "UATB-"),
    category: 0,
    index: 900 + i,
  }));
  const suppliers = [
    { ...SUPPLIERS[0], name: "UAT B ซัพพลายเออร์ทดสอบ (องค์กร B)" },
  ];
  const ids = await ensureCatalog(
    owner,
    organizationId,
    products,
    [CATEGORIES[0]],
    suppliers,
  );
  const branches = data(
    await owner.get(`organizations/${organizationId}/branches`),
  );
  const mainId = (Array.isArray(branches) ? branches : branches.branches).find(
    (b) => b.code === "MAIN",
  ).id;
  const existing = await listAll(
    owner,
    `organizations/${organizationId}/branches/${mainId}/purchase-orders`,
    { status: "all" },
  );
  if (existing.length === 0) {
    const items = products.map((p) => ({
      sku: p.sku,
      quantity: "20",
      cost: p.cost,
    }));
    let po = await createPo(
      owner,
      organizationId,
      mainId,
      ids.supplierId.get(suppliers[0].name),
      ids.productId,
      items,
      -2,
    );
    po = await advance(owner, organizationId, mainId, po, "ORDERED");
    const detail = await poDetail(owner, organizationId, mainId, po.id);
    expectStatus(
      await owner.post(
        `organizations/${organizationId}/branches/${mainId}/purchase-orders/${po.id}/receipts`,
        {
          actualCosts: detail.items.map((l) => ({
            purchaseOrderItemId: l.id,
            actualUnitCost: l.expectedUnitCost,
          })),
          vat: {
            organizationVatRegistered: false,
            inputVatRate: null,
            inputVatAmount: null,
            supplierTaxDocumentNumber: null,
            supplierTaxDocumentDate: null,
          },
        },
        { headers: { "idempotency-key": "uat-seed-receipt-orgb-1" } },
      ),
      [200, 201],
      "receive org B PO",
    );
    log("org B stocked");
  }
  return { organizationId, mainId, ids };
}

async function main() {
  // stage=structure: organizations + branches only (before memberships are granted)
  // stage=data: catalog, purchasing, sales (needs memberships); stage=all: both.
  const stage = arg("stage", "all");
  const organizationId = await ensureOrganization(
    "owner",
    ORG_A,
    BRANCHES_A[0],
  );
  const owner = await as("owner");
  const branchIds = await ensureBranches(owner, organizationId);
  if (stage === "structure") {
    await ensureOrganization("orgb-owner", ORG_B, ORG_B_BRANCH);
    log("UAT_SEED:STRUCTURE_COMPLETE");
    return;
  }
  await ensureVat(owner, organizationId, "REGISTERED", "7");
  const ids = await ensureCatalog(
    owner,
    organizationId,
    PRODUCTS.map((p) => ({ ...p })),
    CATEGORIES,
    SUPPLIERS,
  );
  log(
    `catalog: ${ids.productId.size} products, ${ids.supplierId.size} suppliers`,
  );
  if (process.argv.includes("--catalog-only")) return;
  await purchasingStage(organizationId, branchIds, ids);
  const sales = await salesStage(organizationId, branchIds, ids);
  await adjustmentsAndRefunds(organizationId, branchIds, ids, sales);
  await orgB();
  log(`UAT_SEED:COMPLETE organization=${organizationId}`);
}

main().catch((error) => {
  process.stderr.write(`UAT_SEED:FAILED ${error.message}\n`);
  process.exitCode = 1;
});
