#!/usr/bin/env node
// Logs in as EVERY UAT account over the public HTTP API and probes the real
// authorization boundary (backend status codes, not UI visibility). Marks an
// account READY in the credential CSV only after a real login and an
// authenticated request succeeded. Writes a credential-free report.
//   node infra/learner-lab/uat/uat-verify.mjs --csv <csv> --report <report.json> [--base <url> --origin <origin>] [--scenarios]
import process from "node:process";
import { readFileSync, writeFileSync } from "node:fs";

import { ACCOUNTS, ORG_A, ORG_B } from "./uat-plan.mjs";
import {
  ApiSession,
  arg,
  csvEscape,
  errorCode,
  flag,
  log,
  parseCsv,
  readCredentials,
} from "./uat-lib.mjs";

const baseUrl = arg("base", "https://stockwise.hcn920.com");
const origin = arg("origin", baseUrl);
const csvPath = arg("csv");
const reportPath = arg("report");
const credentials = readCredentials(csvPath);
const data = (r) => r.body?.data;

const results = [];
const record = (entry) => {
  results.push(entry);
  log(`${entry.verdict.padEnd(7)} ${entry.account.padEnd(15)} ${entry.probe}`);
};
const denied = (status) => status === 401 || status === 403 || status === 404;

async function open(account) {
  const session = new ApiSession({ baseUrl, origin, label: account.key });
  const login = await session.login(
    account.email,
    credentials.get(account.email)["Temporary Password"],
  );
  return { session, login };
}

const sessions = new Map();
const failures = [];

// ---- 1. login + authenticated context for every account
let orgAId;
let orgBId;
const branchIds = {};
for (const account of ACCOUNTS) {
  try {
    const { session, login } = await open(account);
    if (login.status !== 200) {
      record({
        account: account.key,
        probe: "login",
        verdict: "FAIL",
        detail: `${login.status} ${errorCode(login)}`,
      });
      failures.push(account.key);
      continue;
    }
    sessions.set(account.key, session);
    const context = await session.get("me/access-context");
    const orgs = data(context)?.organizations ?? [];
    const expected = [
      { name: account.org, role: account.role, branches: account.branches },
      ...(account.extra ?? []).map((e) => ({
        name: e.org,
        role: e.role,
        branches: e.branches,
      })),
    ];
    const problems = [];
    for (const want of expected) {
      const got = orgs.find((o) => o.name === want.name);
      if (!got) problems.push(`missing ${want.name}`);
      else {
        if (got.role !== want.role)
          problems.push(`role ${got.role}!=${want.role}`);
        const codes = (got.branches ?? []).map((b) => b.code).sort();
        const wantCodes =
          want.role === "OWNER" || want.role === "ADMIN"
            ? null
            : [...want.branches].sort();
        if (wantCodes && JSON.stringify(codes) !== JSON.stringify(wantCodes))
          problems.push(`branches ${codes}!=${wantCodes}`);
        if (want.name === ORG_A) {
          orgAId = got.id;
          for (const b of got.branches ?? []) branchIds[b.code] = b.id;
        }
        if (want.name === ORG_B) orgBId = got.id;
      }
    }
    const profile = await session.get("me");
    if (context.status !== 200 || profile.status !== 200 || problems.length) {
      record({
        account: account.key,
        probe: "login + context",
        verdict: "FAIL",
        detail: problems.join("; ") || `${context.status}/${profile.status}`,
      });
      failures.push(account.key);
    } else {
      record({
        account: account.key,
        probe: "login + access-context + profile",
        verdict: "PASS",
        detail: `${account.role} ${account.branches.join("+") || "all branches"}`,
      });
    }
  } catch (error) {
    record({
      account: account.key,
      probe: "login",
      verdict: "FAIL",
      detail: error.message,
    });
    failures.push(account.key);
  }
}

// Owner knows every branch id (assigned-only roles see only their own).
const owner = sessions.get("owner");
if (owner && orgAId) {
  const list = data(await owner.get(`organizations/${orgAId}/branches`)) ?? [];
  for (const b of Array.isArray(list) ? list : (list.branches ?? []))
    branchIds[b.code] = b.id;
}

// ---- 2. RBAC probes (backend decisions)
const ROLE = (a) => a.role;
// Branch-only roles must name an assigned branch for catalog/supplier writes.
const branchContext = (a) =>
  a.branches?.length && !ORG_ROLES_STATIC.includes(a.role)
    ? { branchId: branchIds[a.branches[0]] }
    : {};
const ORG_ROLES_STATIC = ["OWNER", "ADMIN"];
const ORG_ROLES = ["OWNER", "ADMIN"];
const probes = [
  {
    id: "members.list",
    method: "GET",
    path: () => `organizations/${orgAId}/members`,
    allow: (a) => ORG_ROLES.includes(ROLE(a)),
  },
  {
    id: "invitations.list",
    method: "GET",
    path: () => `organizations/${orgAId}/invitations`,
    allow: (a) => ORG_ROLES.includes(ROLE(a)),
  },
  {
    id: "organization.settings.read",
    method: "GET",
    path: () => `organizations/${orgAId}`,
    allow: (a) => ORG_ROLES.includes(ROLE(a)),
  },
  {
    id: "sales-vat-profile.read",
    method: "GET",
    path: () => `organizations/${orgAId}/sales-vat-profile`,
    allow: (a) => ORG_ROLES.includes(ROLE(a)),
  },
  {
    id: "branches.create (deny only)",
    method: "POST",
    path: () => `organizations/${orgAId}/branches`,
    body: () => ({ name: "UAT RBAC probe" }),
    allow: (a) => ORG_ROLES.includes(ROLE(a)),
    mutating: true,
  },
  {
    id: "categories.create (deny only)",
    method: "POST",
    path: () => `organizations/${orgAId}/categories`,
    query: (a) => branchContext(a),
    body: () => ({ name: "UAT RBAC probe" }),
    allow: (a) => ROLE(a) !== "CASHIER",
    mutating: true,
  },
  {
    id: "suppliers.create (deny only)",
    method: "POST",
    path: () => `organizations/${orgAId}/suppliers`,
    query: (a) => branchContext(a),
    body: () => ({ name: "UAT RBAC probe" }),
    allow: (a) => ROLE(a) !== "CASHIER",
    mutating: true,
  },
  {
    id: "analytics.sales",
    method: "GET",
    path: () => `organizations/${orgAId}/analytics/sales`,
    query: () => ({
      scope: "organization",
      from: "2026-10-01",
      to: "2026-11-01",
      granularity: "day",
    }),
    // Organization scope is filtered server-side to the manager's assigned branches.
    allow: (a) => [...ORG_ROLES, "BRANCH_MANAGER"].includes(ROLE(a)),
  },
  {
    id: "ai-insights.latest",
    method: "GET",
    path: () => `organizations/${orgAId}/ai-insights/latest`,
    query: () => ({ scope: "organization", cadence: "WEEKLY" }),
    allow: (a) => ORG_ROLES.includes(ROLE(a)),
  },
];

// Branch-scoped probes run against each branch a role may / may not use.
const branchProbes = [
  {
    id: "inventory.read",
    method: "GET",
    path: (b) => `organizations/${orgAId}/branches/${b}/inventory`,
    allow: () => true,
  },
  {
    id: "pos.products",
    method: "GET",
    path: (b) => `organizations/${orgAId}/branches/${b}/pos/products`,
    allow: (a) => ROLE(a) !== "INVENTORY_STAFF",
  },
  {
    id: "sales.history",
    method: "GET",
    path: (b) => `organizations/${orgAId}/branches/${b}/sales`,
    allow: (a) => ROLE(a) !== "INVENTORY_STAFF",
  },
  {
    id: "purchase-orders.read",
    method: "GET",
    path: (b) => `organizations/${orgAId}/branches/${b}/purchase-orders`,
    allow: (a) => ROLE(a) !== "CASHIER",
  },
  {
    id: "stock.adjust (deny only)",
    method: "POST",
    path: (b) => `organizations/${orgAId}/branches/${b}/inventory/adjustments`,
    body: (ctx) => ({
      productId: ctx.productId,
      delta: "1",
      reason: "OTHER",
      note: "UAT RBAC probe",
    }),
    headers: () => ({
      "idempotency-key": `uat-rbac-${Math.random().toString(36).slice(2)}`,
    }),
    allow: (a) => ROLE(a) !== "CASHIER",
    mutating: true,
  },
  {
    id: "checkout (deny only)",
    method: "POST",
    path: (b) => `organizations/${orgAId}/branches/${b}/sales`,
    body: (ctx) => ({
      items: [
        {
          productId: ctx.productId,
          quantity: "1",
          expectedUnitPrice: "7.0000",
        },
      ],
      payment: { method: "CASH", amountTendered: "100.00" },
    }),
    headers: () => ({
      "idempotency-key": `uat-rbac-${Math.random().toString(36).slice(2)}`,
    }),
    allow: (a) => ROLE(a) !== "INVENTORY_STAFF",
    mutating: true,
  },
];

let probeProductId;
if (owner && orgAId) {
  const products = data(
    await owner.get(`organizations/${orgAId}/products`, {
      query: { limit: 1 },
    }),
  );
  probeProductId = (products?.products ?? products)?.[0]?.id;
}

function inScope(account, orgId, code) {
  // Whether the backend should treat (account, branch) as inside the account's scope.
  const entries = [
    { org: account.org, role: account.role, branches: account.branches },
    ...(account.extra ?? []),
  ];
  const orgName = orgId === orgAId ? ORG_A : ORG_B;
  const entry = entries.find((e) => (e.org ?? e.name) === orgName);
  if (!entry) return false;
  return ORG_ROLES.includes(entry.role) || entry.branches.includes(code);
}

for (const account of ACCOUNTS) {
  const session = sessions.get(account.key);
  if (!session || !orgAId) continue;
  const inA = [
    account.org,
    ...(account.extra ?? []).map((e) => e.org),
  ].includes(ORG_A);
  for (const probe of probes) {
    const effectiveRole = inA ? account : { ...account, role: "NONE" };
    const shouldAllow = inA && probe.allow(effectiveRole);
    if (shouldAllow && (probe.mutating || probe.skipAllowedIf?.(account))) {
      record({
        account: account.key,
        probe: probe.id,
        verdict: "SKIP",
        detail: "allowed path not exercised (mutating or data-dependent)",
      });
      continue;
    }
    const result = await session.request(probe.method, probe.path(), {
      json: probe.body?.(),
      query: probe.query?.(account),
    });
    const ok = shouldAllow
      ? result.status >= 200 && result.status < 300
      : denied(result.status);
    record({
      account: account.key,
      probe: probe.id,
      verdict: ok ? "PASS" : "FAIL",
      detail: `expected ${shouldAllow ? "allow" : "deny"} got ${result.status}${result.ok ? "" : ` ${errorCode(result)}`}`,
    });
    if (!ok) failures.push(`${account.key}:${probe.id}`);
  }
  for (const code of Object.keys(branchIds)) {
    if (!inA) continue;
    const reachable = inScope(account, orgAId, code);
    for (const probe of branchProbes) {
      const shouldAllow = reachable && probe.allow(account);
      if (shouldAllow && probe.mutating) {
        record({
          account: account.key,
          probe: `${probe.id} @${code}`,
          verdict: "SKIP",
          detail: "allowed path covered by seed",
        });
        continue;
      }
      const result = await session.request(
        probe.method,
        probe.path(branchIds[code]),
        {
          json: probe.body?.({ productId: probeProductId }),
          headers: probe.headers?.(),
        },
      );
      const ok = shouldAllow
        ? result.status >= 200 && result.status < 300
        : denied(result.status);
      record({
        account: account.key,
        probe: `${probe.id} @${code}`,
        verdict: ok ? "PASS" : "FAIL",
        detail: `expected ${shouldAllow ? "allow" : "deny"} got ${result.status}${result.ok ? "" : ` ${errorCode(result)}`}`,
      });
      if (!ok) failures.push(`${account.key}:${probe.id}@${code}`);
    }
  }
  // Cross-organization isolation: nothing of the other organization is reachable
  // unless the account holds a membership there.
  if (orgBId) {
    const inB = [
      account.org,
      ...(account.extra ?? []).map((e) => e.org),
    ].includes(ORG_B);
    const entryB =
      account.org === ORG_B
        ? account
        : (account.extra ?? []).find((e) => e.org === ORG_B);
    const mayReadBranchesB = inB;
    const result = await session.get(`organizations/${orgBId}/branches`);
    const ok = mayReadBranchesB ? result.status === 200 : denied(result.status);
    record({
      account: account.key,
      probe: "cross-organization: list Org B branches",
      verdict: ok ? "PASS" : "FAIL",
      detail: `expected ${mayReadBranchesB ? "allow" : "deny"} got ${result.status}`,
    });
    if (!ok) failures.push(`${account.key}:cross-org`);
    void entryB;
  }
}

// ---- 3. P0 governance probes (direct API calls, denial only; no state change)
async function memberRows() {
  const rows = [];
  let cursor;
  for (let i = 0; i < 10; i += 1) {
    const result = await owner.get(`organizations/${orgAId}/members`, {
      query: { includeInactive: "true", limit: 100, cursor },
    });
    const body = data(result);
    rows.push(...(body?.members ?? body ?? []));
    cursor = result.body?.meta?.nextCursor ?? undefined;
    if (!cursor) break;
  }
  return rows;
}
if (owner && orgAId) {
  const members = await memberRows();
  const byEmail = new Map(members.map((m) => [m.user?.email ?? m.email, m]));
  const admin = sessions.get("admin");
  const cashier = sessions.get("cashier-main");
  const adminSelf = byEmail.get("uat-admin@hcn920.com");
  const ownerRow = byEmail.get("uat-owner@hcn920.com");
  const cashierRow = byEmail.get("uat-cashier-main@hcn920.com");
  const check = (account, probe, expectation, result, accepted) => {
    const ok = accepted(result);
    record({
      account,
      probe,
      verdict: ok ? "PASS" : "FAIL",
      detail: `${expectation}; got ${result.status} ${errorCode(result)}`,
    });
    if (!ok) failures.push(`${account}:${probe}`);
  };
  if (admin && adminSelf) {
    check(
      "admin",
      "OWNER-ADM-01: admin demotes self -> rejected",
      "403 SELF_MODIFICATION_FORBIDDEN",
      await admin.patch(`organizations/${orgAId}/members/${adminSelf.id}`, {
        role: "BRANCH_MANAGER",
        branchIds: [branchIds.MAIN],
        expectedUpdatedAt: adminSelf.updatedAt,
      }),
      (r) => r.status === 403,
    );
    check(
      "admin",
      "ADMIN-01: admin deactivates self -> rejected",
      "403",
      await admin.post(
        `organizations/${orgAId}/members/${adminSelf.id}/deactivate`,
        { expectedUpdatedAt: adminSelf.updatedAt },
      ),
      (r) => r.status === 403,
    );
    if (cashierRow)
      check(
        "admin",
        "OWNER-01: admin promotes a member to OWNER -> rejected",
        "403",
        await admin.patch(`organizations/${orgAId}/members/${cashierRow.id}`, {
          role: "OWNER",
          branchIds: [],
          expectedUpdatedAt: cashierRow.updatedAt,
        }),
        (r) => r.status === 403,
      );
    if (ownerRow)
      check(
        "admin",
        "OWNER-02: admin deactivates the creator OWNER -> rejected",
        "403",
        await admin.post(
          `organizations/${orgAId}/members/${ownerRow.id}/deactivate`,
          { expectedUpdatedAt: ownerRow.updatedAt },
        ),
        (r) => r.status === 403,
      );
  }
  if (cashier && cashierRow)
    check(
      "cashier-main",
      "cashier changes own role -> rejected",
      "403",
      await cashier.patch(`organizations/${orgAId}/members/${cashierRow.id}`, {
        role: "ADMIN",
        branchIds: [],
        expectedUpdatedAt: cashierRow.updatedAt,
      }),
      (r) => denied(r.status),
    );
  // Active member invite is a conflict, never an email.
  check(
    "owner",
    "MEMBERS-01: invite an existing active member -> 409",
    "409 MEMBERSHIP_ALREADY_EXISTS",
    await owner.post(`organizations/${orgAId}/invitations`, {
      email: "uat-cashier-main@hcn920.com",
      role: "CASHIER",
      branchIds: [branchIds.MAIN],
    }),
    (r) => r.status === 409 && errorCode(r) === "MEMBERSHIP_ALREADY_EXISTS",
  );
}

// ---- 4. session lifecycle: logout invalidates the session; unauthenticated requests are rejected
{
  const account = ACCOUNTS.find((a) => a.key === "cashier-main");
  const { session, login } = await open(account);
  if (login.status === 200) {
    const before = await session.get("me");
    const logout = await session.post("auth/logout");
    const after = await session.get("me");
    const anonymous = new ApiSession({ baseUrl, origin });
    const unauth = await anonymous.get(`organizations/${orgAId}/branches`);
    const ok =
      before.status === 200 &&
      (logout.status === 204 || logout.status === 200) &&
      after.status === 401 &&
      unauth.status === 401;
    record({
      account: "cashier-main",
      probe: "logout revokes session; anonymous API call rejected",
      verdict: ok ? "PASS" : "FAIL",
      detail: `me ${before.status} -> logout ${logout.status} -> me ${after.status}; anonymous ${unauth.status}`,
    });
    if (!ok) failures.push("session-lifecycle");
  }
}

// ---- 5. optional state-changing scenario: removal, stale session, re-invitation, reactivation
if (flag("scenarios") && owner && orgAId) {
  const account = ACCOUNTS.find((a) => a.key === "removed");
  const { session, login } = await open(account);
  const members = await memberRows();
  const row = members.find((m) => (m.user?.email ?? m.email) === account.email);
  const step = (name, ok, detail) => {
    record({
      account: "removed",
      probe: `scenario: ${name}`,
      verdict: ok ? "PASS" : "FAIL",
      detail,
    });
    if (!ok) failures.push(`scenario:${name}`);
  };
  if (login.status === 200 && row) {
    const before = await session.get(
      `organizations/${orgAId}/branches/${branchIds.MAIN}/inventory`,
    );
    const deactivated = await owner.post(
      `organizations/${orgAId}/members/${row.id}/deactivate`,
      { expectedUpdatedAt: row.updatedAt },
    );
    const stale = await session.get(
      `organizations/${orgAId}/branches/${branchIds.MAIN}/inventory`,
    );
    const invite = await owner.post(`organizations/${orgAId}/invitations`, {
      email: account.email,
      role: "INVENTORY_STAFF",
      branchIds: [branchIds.MAIN],
    });
    const refreshed = (await memberRows()).find((m) => m.id === row.id);
    const reactivated = await owner.post(
      `organizations/${orgAId}/members/${row.id}/reactivate`,
      {
        role: "INVENTORY_STAFF",
        branchIds: [branchIds.MAIN],
        expectedUpdatedAt: refreshed.updatedAt,
      },
    );
    const after = await session.get(
      `organizations/${orgAId}/branches/${branchIds.MAIN}/inventory`,
    );
    const duplicates = (await memberRows()).filter(
      (m) => (m.user?.email ?? m.email) === account.email,
    ).length;
    step(
      "member could read inventory before removal",
      before.status === 200,
      `${before.status}`,
    );
    step("removal succeeds", deactivated.ok, `${deactivated.status}`);
    step(
      "existing session loses access immediately",
      denied(stale.status),
      `${stale.status}`,
    );
    step(
      "re-invite of removed member -> 409 MEMBERSHIP_INACTIVE_EXISTS, no email",
      invite.status === 409 &&
        errorCode(invite) === "MEMBERSHIP_INACTIVE_EXISTS",
      `${invite.status} ${errorCode(invite)}`,
    );
    step(
      "reactivation succeeds",
      reactivated.ok,
      `${reactivated.status} ${errorCode(reactivated)}`,
    );
    step(
      "same session works again after reactivation",
      after.status === 200,
      `${after.status}`,
    );
    step("no duplicate membership", duplicates === 1, `${duplicates}`);
  } else step("setup", false, `login ${login.status}`);
}

// ---- report + CSV status
const summary = {
  base: baseUrl,
  generatedAt: new Date().toISOString(),
  pass: results.filter((r) => r.verdict === "PASS").length,
  fail: results.filter((r) => r.verdict === "FAIL").length,
  skip: results.filter((r) => r.verdict === "SKIP").length,
};
writeFileSync(reportPath, JSON.stringify({ summary, results }, null, 2));

const failedAccounts = new Set(
  results
    .filter((r) => r.verdict === "FAIL" && r.probe.startsWith("login"))
    .map((r) => r.account),
);
const rows = parseCsv(readFileSync(csvPath, "utf8"));
const header = Object.keys(rows[0]);
for (const row of rows) {
  const key = ACCOUNTS.find((a) => a.email === row.Email)?.key;
  row["Account status"] =
    failedAccounts.has(key) || !sessions.has(key)
      ? "FAILED"
      : `READY (real login + authenticated request verified ${summary.generatedAt.slice(0, 16)}Z)`;
}
writeFileSync(
  csvPath,
  `${[header, ...rows.map((r) => header.map((h) => r[h]))].map((r) => r.map(csvEscape).join(",")).join("\r\n")}\r\n`,
  "utf8",
);
log(
  `UAT_VERIFY: pass=${summary.pass} fail=${summary.fail} skip=${summary.skip}`,
);
process.exitCode = summary.fail === 0 ? 0 : 1;
