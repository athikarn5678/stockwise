import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { delimiter, join, resolve } from "node:path";

import { assertClusterOwned } from "../../../apps/api/src/test/disposable-ownership.ts";
import { STACK_IMAGE } from "../better-auth-d5/browser-stack-config.mts";
import { withLocalPostgres } from "../better-auth-d5/local-runner.mts";

/**
 * TEST-ONLY verification of `demo:seed` against the accepted migrations, on a
 * receipt-owned disposable PostgreSQL created and destroyed by the local
 * runner (never a shared database). In one run it:
 *   1. creates `*_demo` databases inside the owned cluster after proving
 *      ownership, and applies the committed migrations;
 *   2. runs the seeder's vitest suite (unit + integration) against one of them;
 *   3. runs the real seeder CLI (generate, then exact no-op rerun);
 *   4. runs the operator Native cutover on the seeded database, then proves the
 *      seeder refuses the sealed database;
 *   5. starts the unmodified API with Native authority and signs in as a seeded
 *      demo user, then checks the access context.
 * Output is step names and exit codes only; generated passwords and keys stay
 * in memory.
 *   node tests/e2e/demo-seed/demo-seed-check.mts [--docker <abs docker.exe>]
 */
const repositoryRoot = resolve(import.meta.dirname, "../../..");
const apiRoot = join(repositoryRoot, "apps/api");
const require = createRequire(join(apiRoot, "package.json"));
const { Client } = require("pg") as typeof import("pg");

function findDocker(): string {
  const flag = process.argv.indexOf("--docker");
  if (flag !== -1 && process.argv[flag + 1]) return process.argv[flag + 1]!;
  const name = process.platform === "win32" ? "docker.exe" : "docker";
  for (const directory of (process.env.PATH ?? "").split(delimiter))
    if (directory && existsSync(join(directory, name)))
      return join(directory, name);
  throw new Error("DOCKER_NOT_FOUND");
}

const inherited = [
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
];
function baseEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of inherited)
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  return environment;
}

const results: { step: string; outcome: string }[] = [];
function record(step: string, ok: boolean, detail = "") {
  results.push({
    step,
    outcome: ok ? "PASS" : `FAIL${detail ? `:${detail}` : ""}`,
  });
  console.log(
    `DEMO_SEED_CHECK:${step}:${ok ? "PASS" : "FAIL"}${detail ? `:${detail}` : ""}`,
  );
}

async function run(
  args: string[],
  environment: NodeJS.ProcessEnv,
  cwd = repositoryRoot,
  log?: string,
): Promise<{ code: number; output: string }> {
  const child = spawn(process.execPath, args, {
    cwd,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  const code = await new Promise<number>((done) =>
    child.once("close", (status) => done(status ?? 1)),
  );
  if (log) await writeFile(log, output);
  return { code, output };
}

const evidence = join(
  repositoryRoot,
  "test-results/demo-seed",
  `run-${new Date().toISOString().replace(/[:.]/g, "-")}`,
);
await mkdir(join(evidence, "journal"), { recursive: true });
console.log(`DEMO_SEED_CHECK_EVIDENCE:${evidence}`);

const password = randomBytes(24).toString("base64url");
const generated: string[] = [password];
const key = () => {
  const value = randomBytes(32).toString("base64url");
  generated.push(value);
  return value;
};
const API_PORT = 3213;
const WEB_ORIGIN = "http://localhost:3212";

await withLocalPostgres(
  {
    dockerExecutable: findDocker(),
    image: STACK_IMAGE,
    evidenceDirectory: join(evidence, "journal"),
    runTimeoutMs: 1_800_000,
  },
  async (database) => {
    // Prove the cluster is the runner's before creating anything in it.
    const admin = new Client({ connectionString: database.TEST_DATABASE_URL });
    await admin.connect();
    try {
      await assertClusterOwned(admin, database.receipt);
      for (const name of ["stockwise_demo", "stockwise_check_demo"])
        await admin.query(`CREATE DATABASE ${name}`);
    } finally {
      await admin.end();
    }
    const urlFor = (name: string) => {
      const url = new URL(database.TEST_DATABASE_URL);
      url.pathname = `/${name}`;
      return url.toString();
    };
    const base = baseEnvironment();
    const prismaCli = join(apiRoot, "node_modules/prisma/build/index.js");
    for (const name of ["stockwise_demo", "stockwise_check_demo"]) {
      const migrated = await run(
        [prismaCli, "migrate", "deploy", "--config", "prisma.config.ts"],
        { ...base, DATABASE_URL: urlFor(name) },
        apiRoot,
        join(evidence, `migrate-${name}.log`),
      );
      record(`MIGRATE_${name}`, migrated.code === 0, String(migrated.code));
      if (migrated.code !== 0) throw new Error("MIGRATION_FAILED");
    }

    // 2. Seeder unit + integration suite against a fresh migrated *_demo DB.
    const vitest = await run(
      [
        join(repositoryRoot, "node_modules/vitest/vitest.mjs"),
        "run",
        "apps/api/src/demo/",
      ],
      {
        ...base,
        TEST_DATABASE_URL: database.TEST_DATABASE_URL,
        FORCE_COLOR: "0",
        NO_COLOR: "1",
        DEMO_DATABASE_URL: urlFor("stockwise_check_demo"),
        DEMO_USER_PASSWORD: password,
      },
      repositoryRoot,
      join(evidence, "vitest-demo.log"),
    );
    const summary = vitest.output.match(/Tests\s+([^\n]+)/)?.[1]?.trim() ?? "";
    record("SEEDER_VITEST", vitest.code === 0, summary.replace(/\s+/g, "_"));

    // 3. Real seeder CLI: generate, then exact no-op.
    const seedEnvironment = {
      ...base,
      DEMO_DATABASE_URL: urlFor("stockwise_demo"),
      DEMO_USER_PASSWORD: password,
    };
    const seed = [join(apiRoot, "src/demo/demo-main.ts")];
    const first = await run(
      seed,
      seedEnvironment,
      apiRoot,
      join(evidence, "seed-1.log"),
    );
    record(
      "SEED_GENERATE",
      first.code === 0 && / generated on /.test(first.output),
      String(first.code),
    );
    const second = await run(
      seed,
      seedEnvironment,
      apiRoot,
      join(evidence, "seed-2.log"),
    );
    record(
      "SEED_NOOP_RERUN",
      second.code === 0 && / no-op on /.test(second.output),
      String(second.code),
    );

    // 4. Operator Native cutover of the seeded database, then refusal.
    const cutover = await run(
      [
        join(apiRoot, "src/native-cutover/native-cutover-main.ts"),
        "--confirm-database",
        "stockwise_demo",
      ],
      { ...base, DATABASE_URL: urlFor("stockwise_demo") },
      apiRoot,
      join(evidence, "native-cutover.log"),
    );
    const complete = cutover.output
      .split("\n")
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return {};
        }
      })
      .find((event) => event.event === "complete");
    record(
      "NATIVE_CUTOVER",
      cutover.code === 0 && complete !== undefined,
      complete ? `users_${String(complete.users)}` : String(cutover.code),
    );
    const sealed = await run(
      seed,
      seedEnvironment,
      apiRoot,
      join(evidence, "seed-after-native.log"),
    );
    record(
      "SEED_REFUSES_NATIVE_DATABASE",
      sealed.code === 1 && /LEGACY/.test(sealed.output),
      String(sealed.code),
    );

    // 5. Unmodified API, Native authority: a seeded demo user signs in.
    const apiLog = openSync(join(evidence, "api.log"), "a");
    const api = spawn(process.execPath, [join(apiRoot, "src/main.ts")], {
      cwd: apiRoot,
      env: {
        ...base,
        DATABASE_URL: urlFor("stockwise_demo"),
        STOCKWISE_RUNTIME_ENV: "test",
        STOCKWISE_EMAIL_PROVIDER: "non_delivery",
        STOCKWISE_AUTHENTICATION_AUTHORITY: "native",
        STOCKWISE_API_PORT: String(API_PORT),
        STOCKWISE_PUBLIC_WEB_ORIGIN: WEB_ORIGIN,
        STOCKWISE_ANALYTICS_CURSOR_HMAC_KEY: key(),
        STOCKWISE_VERIFICATION_OTP_KEY: key(),
        STOCKWISE_VERIFICATION_OTP_KEY_ID: "1",
        STOCKWISE_VERIFICATION_PROOF_KEY: key(),
        STOCKWISE_VERIFICATION_PROOF_KEY_ID: "1",
        STOCKWISE_BETTER_AUTH_SECRET: key(),
        STOCKWISE_INVITATION_CONTINUATION_KEY: key(),
      },
      stdio: ["ignore", apiLog, apiLog],
      windowsHide: true,
    });
    closeSync(apiLog);
    try {
      const origin = `http://127.0.0.1:${API_PORT}`;
      let healthy = false;
      for (let attempt = 0; attempt < 60 && !healthy; attempt++) {
        if (api.exitCode !== null) break;
        healthy = await fetch(`${origin}/health`)
          .then((response) => response.ok)
          .catch(() => false);
        if (!healthy) await new Promise((done) => setTimeout(done, 500));
      }
      record("NATIVE_API_HEALTH", healthy);
      const login = await fetch(`${origin}/api/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: WEB_ORIGIN },
        body: JSON.stringify({ email: "demo-owner@example.invalid", password }),
      });
      const cookie = (login.headers.getSetCookie?.() ?? [])
        .map((value) => value.split(";")[0])
        .join("; ");
      record(
        "NATIVE_LOGIN_SEEDED_OWNER",
        login.status === 200 && cookie.includes("stockwise_native"),
        String(login.status),
      );
      const context = await fetch(`${origin}/api/v1/me/access-context`, {
        headers: { cookie },
      });
      const body = (await context.json().catch(() => ({}))) as {
        data?: { organizations?: { role?: string }[] };
      };
      record(
        "NATIVE_ACCESS_CONTEXT_SEEDED_OWNER",
        context.status === 200 &&
          body.data?.organizations?.[0]?.role === "OWNER",
        String(context.status),
      );
      const wrong = await fetch(`${origin}/api/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: WEB_ORIGIN },
        body: JSON.stringify({
          email: "demo-owner@example.invalid",
          password: `${password}x`,
        }),
      });
      record(
        "NATIVE_LOGIN_WRONG_PASSWORD_REFUSED",
        wrong.status === 401,
        String(wrong.status),
      );
    } finally {
      if (api.exitCode === null) {
        const closed = new Promise((done) => api.once("close", done));
        api.kill();
        await closed;
      }
    }
  },
);

// Retained evidence must not contain the generated password or any key.
const leaked: string[] = [];
const scan = async (directory: string) => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await scan(path);
    else if (entry.isFile()) {
      const text = await readFile(path, "utf8");
      if (generated.some((value) => text.includes(value)))
        leaked.push(entry.name);
    }
  }
};
await scan(evidence);
record("EVIDENCE_SECRET_SCAN", leaked.length === 0, leaked.join(","));

const failed = results.filter((result) => result.outcome !== "PASS");
await writeFile(
  join(evidence, "summary.json"),
  `${JSON.stringify({ results }, null, 2)}\n`,
);
console.log(`DEMO_SEED_CHECK:${failed.length ? "FAIL" : "PASS"}`);
process.exitCode = failed.length ? 1 : 0;
