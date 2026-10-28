// Shared helpers for the owner-authorized UAT tooling (Learner Lab demo).
// Talks to the PUBLIC HTTP API only, with real logins and real RBAC. Secrets
// (passwords) are read from the local CSV and never printed.
import process from "node:process";
import { URL } from "node:url";
import { readFileSync } from "node:fs";

export const DEFAULT_BASE_URL = "https://stockwise.hcn920.com";

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(cell);
      cell = "";
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  const [header, ...body] = rows;
  return body.map((values) =>
    Object.fromEntries(
      header.map((name, index) => [name, values[index] ?? ""]),
    ),
  );
}

export function csvEscape(value) {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function readCredentials(path) {
  const accounts = new Map();
  for (const row of parseCsv(readFileSync(path, "utf8"))) {
    accounts.set(row.Email, row);
  }
  return accounts;
}

/** One authenticated browser-like session (cookie jar, no secrets logged). */
export class ApiSession {
  constructor({ baseUrl = DEFAULT_BASE_URL, origin = baseUrl, label }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.origin = origin;
    this.label = label ?? "anonymous";
    this.cookies = new Map();
  }

  async request(method, path, { json, headers = {}, query } = {}) {
    const url = new URL(`${this.baseUrl}/api/v1/${path.replace(/^\//, "")}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const requestHeaders = {
      accept: "application/json",
      origin: this.origin,
      ...headers,
    };
    if (json !== undefined) requestHeaders["content-type"] = "application/json";
    if (this.cookies.size > 0) {
      requestHeaders.cookie = [...this.cookies]
        .map(([k, v]) => `${k}=${v}`)
        .join("; ");
    }
    const response = await globalThis.fetch(url, {
      body: json === undefined ? undefined : JSON.stringify(json),
      headers: requestHeaders,
      method,
      redirect: "manual",
    });
    for (const setCookie of response.headers.getSetCookie?.() ?? []) {
      const [pair] = setCookie.split(";");
      const index = pair.indexOf("=");
      const name = pair.slice(0, index);
      const value = pair.slice(index + 1);
      if (value === "" || /expires=thu, 01 jan 1970/i.test(setCookie))
        this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const text = await response.text();
    let body;
    try {
      body = text === "" ? null : JSON.parse(text);
    } catch {
      body = null;
    }
    return { status: response.status, body, ok: response.ok };
  }

  get(path, options) {
    return this.request("GET", path, options);
  }
  post(path, json, options = {}) {
    return this.request("POST", path, { ...options, json: json ?? {} });
  }
  patch(path, json, options = {}) {
    return this.request("PATCH", path, { ...options, json });
  }

  async login(email, password) {
    const result = await this.post("auth/login", { email, password });
    this.label = email;
    return result;
  }
}

export function errorCode(result) {
  return result.body?.error?.code ?? `HTTP_${result.status}`;
}

/** Throws a credential-free error when a step did not return the expected status. */
export function expectStatus(result, expected, what) {
  const accepted = Array.isArray(expected) ? expected : [expected];
  if (!accepted.includes(result.status)) {
    throw new Error(
      `${what}: expected ${accepted.join("/")} but got ${result.status} ${errorCode(result)}`,
    );
  }
  return result;
}

export function log(message) {
  process.stdout.write(`${message}\n`);
}

export function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

export function flag(name) {
  return process.argv.includes(`--${name}`);
}
