import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const environmentFile = fileURLToPath(
  new URL("../../../../.env", import.meta.url),
);
const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

function target(value: string, label: string, demo: boolean): string {
  let url: URL;
  let database: string;
  try {
    url = new URL(value);
    database = decodeURIComponent(url.pathname.slice(1));
  } catch {
    throw new Error(`${label} cannot be safely compared.`);
  }
  if (
    url.protocol !== "postgresql:" ||
    !loopbackHosts.has(url.hostname.toLowerCase()) ||
    value.includes("#") ||
    (url.searchParams.size !== 0 &&
      !(
        url.searchParams.size === 1 &&
        url.searchParams.get("schema") === "public"
      )) ||
    !/^[a-z0-9_]+$/.test(database)
  ) {
    throw new Error(
      `${label} must be a safely comparable loopback PostgreSQL URL.`,
    );
  }
  if (demo && !database.endsWith("_demo")) {
    throw new Error("DEMO_DATABASE_URL must name a disposable _demo database.");
  }
  if (
    demo &&
    (database.includes("_test") ||
      /(^|_)(prod|production|stage|staging|live)(_|$)/.test(database))
  ) {
    throw new Error(
      "DEMO_DATABASE_URL must not name a test or production-looking database.",
    );
  }
  // Credentials and schema do not distinguish database targets. All loopback
  // aliases identify the same local server for collision checks.
  return `loopback:${url.port || "5432"}/${database}`;
}

export function loadDemoDatabaseEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  runtimeEnvironmentFile = environmentFile,
): { databaseUrl: string; databaseName: string } {
  if (environment.STOCKWISE_RUNTIME_ENV === "production") {
    throw new Error("Demo generation is disabled in production mode.");
  }
  const databaseUrl = environment.DEMO_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DEMO_DATABASE_URL must be supplied by the process.");
  }
  const demoTarget = target(databaseUrl, "DEMO_DATABASE_URL", true);
  const comparisonUrls: Array<[string, string | undefined]> = [
    ["DATABASE_URL", environment.DATABASE_URL],
    ["TEST_DATABASE_URL", environment.TEST_DATABASE_URL],
  ];
  if (existsSync(runtimeEnvironmentFile)) {
    let runtimeUrl: string | undefined;
    try {
      runtimeUrl = parseEnv(
        readFileSync(runtimeEnvironmentFile, "utf8"),
      ).DATABASE_URL;
    } catch {
      throw new Error("Root .env DATABASE_URL cannot be safely compared.");
    }
    comparisonUrls.push(["root .env DATABASE_URL", runtimeUrl]);
  }
  for (const [label, value] of comparisonUrls) {
    if (value !== undefined && target(value, label, false) === demoTarget) {
      throw new Error(`DEMO_DATABASE_URL collides with ${label}.`);
    }
  }
  return { databaseUrl, databaseName: demoTarget.split("/")[1]! };
}

export function loadDemoEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  runtimeEnvironmentFile = environmentFile,
): { databaseUrl: string; databaseName: string; password: string } {
  const target = loadDemoDatabaseEnvironment(
    environment,
    runtimeEnvironmentFile,
  );
  const password = environment.DEMO_USER_PASSWORD;
  if (!password || [...password].length < 15 || [...password].length > 128)
    throw new Error(
      "DEMO_USER_PASSWORD must contain 15 to 128 Unicode code points.",
    );
  return { ...target, password };
}
