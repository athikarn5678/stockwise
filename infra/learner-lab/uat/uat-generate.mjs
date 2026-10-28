#!/usr/bin/env node
// Generates the UAT credential CSV (outside the repository) and the hash-only
// provisioning specs. Plaintext passwords stay in the CSV; the specs that go to
// AWS contain Argon2id hashes only.
//   node infra/learner-lab/uat/uat-generate.mjs --csv <path> --spec-dir <dir>
import process from "node:process";
import { randomInt } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { hashPassword } from "../../../apps/api/src/modules/identity/password-hasher.ts";
import { ACCOUNTS, LOGIN_URL, ORG_A, ORG_B, PERMISSIONS } from "./uat-plan.mjs";
import { arg, csvEscape, log, readCredentials } from "./uat-lib.mjs";

const csvPath = arg("csv");
const specDir = arg("spec-dir");
if (!csvPath || !specDir)
  throw new Error("usage: --csv <path> --spec-dir <dir>");

// 28 characters from a comma/quote-free alphabet (no ambiguous glyphs): ~160 bits.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789-_.";
function password() {
  return Array.from(
    { length: 28 },
    () => ALPHABET[randomInt(ALPHABET.length)],
  ).join("");
}

function restrictToCurrentUser(path) {
  if (process.platform !== "win32") return;
  const user =
    `${process.env.USERDOMAIN ?? ""}\\${process.env.USERNAME ?? ""}`.replace(
      /^\\/,
      "",
    );
  execFileSync("icacls", [path, "/inheritance:r", "/grant:r", `${user}:(F)`], {
    stdio: "ignore",
  });
}

const existing = existsSync(csvPath) ? readCredentials(csvPath) : new Map();
const passwords = new Map(
  ACCOUNTS.map((a) => [
    a.email,
    existing.get(a.email)?.["Temporary Password"] ?? password(),
  ]),
);

if (existing.size === 0) {
  mkdirSync(dirname(csvPath), { recursive: true });
  const header = [
    "Role",
    "Email",
    "Temporary Password",
    "Organization",
    "Branch",
    "Account status",
    "Expected permissions",
    "Login URL",
  ];
  const rows = ACCOUNTS.map((a) => {
    const orgs = [a.org, ...(a.extra ?? []).map((e) => e.org)];
    const roles = [a.role, ...(a.extra ?? []).map((e) => e.role)];
    const branches = [
      a.branches,
      ...(a.extra ?? []).map((e) => e.branches),
    ].map((b) => (b.length ? b.join("+") : "all branches"));
    const multi = orgs.length > 1;
    return [
      multi
        ? roles
            .map(
              (r, i) =>
                `${r} (${orgs[i].startsWith("UAT Demo") ? "Org A" : "Org B"})`,
            )
            .join(" + ")
        : a.role,
      a.email,
      passwords.get(a.email),
      multi ? orgs.join(" | ") : a.org,
      multi ? branches.join(" | ") : branches[0],
      "PLANNED",
      multi
        ? roles.map((r) => PERMISSIONS[r]).join(" || ")
        : PERMISSIONS[a.role],
      LOGIN_URL,
    ];
  });
  writeFileSync(
    csvPath,
    `${[header, ...rows].map((row) => row.map(csvEscape).join(",")).join("\r\n")}\r\n`,
    "utf8",
  );
  restrictToCurrentUser(dirname(csvPath));
  restrictToCurrentUser(csvPath);
  log(`UAT_CSV:created ${csvPath} rows=${rows.length}`);
} else {
  log(`UAT_CSV:reused ${csvPath} rows=${existing.size}`);
}

mkdirSync(specDir, { recursive: true });
const hashes = new Map();
for (const account of ACCOUNTS)
  hashes.set(account.email, await hashPassword(passwords.get(account.email)));

const owners = {
  [ORG_A]: ACCOUNTS.find((a) => a.key === "owner"),
  [ORG_B]: ACCOUNTS.find((a) => a.key === "orgb-owner"),
};
const accountsSpec = {
  accounts: ACCOUNTS.map((a) => ({
    displayName: a.name,
    email: a.email,
    passwordHash: hashes.get(a.email),
  })),
  memberships: [],
};
const grants = [];
for (const a of ACCOUNTS) {
  if (!a.creator)
    grants.push({
      actorEmail: owners[a.org].email,
      branchCodes: a.branches,
      email: a.email,
      organizationName: a.org,
      role: a.role,
    });
  for (const e of a.extra ?? [])
    grants.push({
      actorEmail: owners[e.org].email,
      branchCodes: e.branches,
      email: a.email,
      organizationName: e.org,
      role: e.role,
    });
}
// Granting order matters: OWNER first, then ADMIN, then branch roles.
const order = [
  "OWNER",
  "ADMIN",
  "BRANCH_MANAGER",
  "INVENTORY_STAFF",
  "CASHIER",
];
grants.sort((x, y) => order.indexOf(x.role) - order.indexOf(y.role));
writeFileSync(
  `${specDir}/uat-accounts-spec.json`,
  JSON.stringify(accountsSpec),
);
writeFileSync(
  `${specDir}/uat-memberships-spec.json`,
  JSON.stringify({ accounts: [], memberships: grants }),
);
log(
  `UAT_SPEC:written accounts=${accountsSpec.accounts.length} memberships=${grants.length} dir=${specDir}`,
);
