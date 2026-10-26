import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { PrismaClient } from "../../../apps/api/src/generated/prisma/client.ts";
import type { PrivateIdentityMailbox } from "./mailbox.ts";
import {
  verifyLocalPostgresReceipt,
  type LocalPostgresReceipt,
} from "../better-auth-d5/local-runner.mts";
import { createApp } from "../../../apps/api/src/app.ts";
import { loadApiEnvironment } from "../../../apps/api/src/environment.ts";
import { createBetterAuthApplicationRuntime } from "../../../apps/api/src/modules/identity/better-auth-application-runtime.ts";
import { createPrismaBranchRepository } from "../../../apps/api/src/modules/organizations/branch-repository.ts";
import { createBranchService } from "../../../apps/api/src/modules/organizations/branch-service.ts";
import { createBranchRouter } from "../../../apps/api/src/modules/organizations/branch-router.ts";
import { createPrismaFirstOrganizationOnboardingRepository } from "../../../apps/api/src/modules/identity/first-organization-onboarding-repository.ts";
import { createFirstOrganizationOnboardingService } from "../../../apps/api/src/modules/identity/first-organization-onboarding-service.ts";
import { createFirstOrganizationOnboardingRouter } from "../../../apps/api/src/modules/identity/first-organization-onboarding-router.ts";
import { createPrismaClient } from "../../../apps/api/src/prisma/client.ts";
import { startApiServer } from "../../../apps/api/src/server.ts";
import {
  AUTH_INTEGRATION_APPROVAL,
  createOwnedAuthDatabase,
  requireFreeLoopbackPort,
  validateAuthIntegrationInvocation,
} from "../../../apps/api/src/test/auth-integration-database.ts";
import {
  authBounded,
  createAuthCleanup,
} from "../../../apps/api/src/test/auth-integration-lifecycle.ts";
import { createPrivateIdentityMailbox } from "./mailbox.ts";
export interface IdentityHarness {
  prisma: PrismaClient;
  mailbox: PrivateIdentityMailbox;
  deliveryFailures: string[];
  stop(): Promise<void>;
}
export type LocalPostgresDatabase = {
  DATABASE_URL: string;
  TEST_DATABASE_URL: string;
  receipt: LocalPostgresReceipt;
};
export function localDatabaseFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): LocalPostgresDatabase | undefined {
  const encodedReceipt = environment.STOCKWISE_LOCAL_DATABASE_RECEIPT;
  if (encodedReceipt === undefined) return undefined;
  if (
    environment.DATABASE_URL === undefined ||
    environment.TEST_DATABASE_URL === undefined
  )
    throw new Error("Local disposable database receipt is incomplete.");
  let receipt: LocalPostgresReceipt;
  try {
    receipt = JSON.parse(encodedReceipt) as LocalPostgresReceipt;
  } catch {
    throw new Error("Local disposable database receipt is invalid.");
  }
  if (
    !verifyLocalPostgresReceipt(
      receipt,
      environment.DATABASE_URL,
      environment.TEST_DATABASE_URL,
    )
  )
    throw new Error("Local disposable database receipt is invalid.");
  return {
    DATABASE_URL: environment.DATABASE_URL,
    TEST_DATABASE_URL: environment.TEST_DATABASE_URL,
    receipt,
  };
}

const WEB_PORT = 3202;
const API_PORT = 3203;
const webOrigin = `http://localhost:${WEB_PORT}`;
const apiOrigin = `http://127.0.0.1:${API_PORT}`;
const webRoot = fileURLToPath(new URL("../../../apps/web/", import.meta.url));
const root = fileURLToPath(new URL("../../../", import.meta.url));

export function validateHarnessAuthorization(
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  if (environment.STOCKWISE_D4N3_ISOLATED !== "1")
    throw new Error("D4N3 isolated integration authorization is required.");
  const invokingEnvironment = { ...environment };
  if (invokingEnvironment.PLAYWRIGHT_NO_COPY_PROMPT === "1")
    delete invokingEnvironment.PLAYWRIGHT_NO_COPY_PROMPT;
  validateAuthIntegrationInvocation({
    ...invokingEnvironment,
    STOCKWISE_T02A_INTEGRATION_AUTHORIZE: AUTH_INTEGRATION_APPROVAL,
  });
  return invokingEnvironment;
}

export async function startHarness(
  options: { localDatabase?: LocalPostgresDatabase } = {},
): Promise<IdentityHarness> {
  // Local runs can use only a URL pair accompanied by the runner receipt.
  const localDatabase = options.localDatabase;
  const invokingEnvironment =
    localDatabase === undefined
      ? validateHarnessAuthorization(process.env)
      : {};
  if (
    localDatabase !== undefined &&
    !verifyLocalPostgresReceipt(
      localDatabase.receipt,
      localDatabase.DATABASE_URL,
      localDatabase.TEST_DATABASE_URL,
    )
  )
    throw new Error("Local disposable database receipt is invalid.");
  // Static imports load the real credential verifier before resources are created.
  for (const directory of [root, `${root}/apps/api`, webRoot])
    for (const name of [
      ".env",
      ".env.development",
      ".env.development.local",
      ".env.local",
      ".env.production",
      ".env.production.local",
      ".env.test",
      ".env.test.local",
    ])
      if (existsSync(`${directory}/${name}`))
        throw new Error(
          "Integration requires an isolated checkout without populated environment files.",
        );
  if (
    !existsSync(`${webRoot}/.next/BUILD_ID`) ||
    !readFileSync(`${webRoot}/.next/routes-manifest.json`, "utf8").includes(
      `${apiOrigin}/api/v1/`,
    )
  )
    throw new Error(
      "Build Next.js for the dedicated integration API origin first.",
    );
  await requireFreeLoopbackPort(WEB_PORT);
  await requireFreeLoopbackPort(API_PORT);
  let stage = "database";

  const cleanup = createAuthCleanup();
  try {
    const database =
      localDatabase === undefined
        ? await createOwnedAuthDatabase({
            ...invokingEnvironment,
            STOCKWISE_T02A_INTEGRATION_AUTHORIZE: AUTH_INTEGRATION_APPROVAL,
          })
        : {
            environment: {
              TEST_DATABASE_URL: localDatabase.TEST_DATABASE_URL,
            },
            cleanup: async () => {},
          };
    cleanup.add(database.cleanup);
    stage = "composition";
    const mailbox = createPrivateIdentityMailbox();
    cleanup.add(() => mailbox.clear());
    const prisma = createPrismaClient({
      DATABASE_URL: database.environment.TEST_DATABASE_URL,
    });
    cleanup.add(() => prisma.$disconnect());
    if (localDatabase !== undefined) {
      const [marker] = await prisma.$queryRaw<
        { marker: string | null }[]
      >`SELECT shobj_description(oid, 'pg_database') AS marker
        FROM pg_database WHERE datname = current_database()`;
      if (marker?.marker !== `stockwise-local:${localDatabase.receipt.marker}`)
        throw new Error("Local disposable database ownership marker mismatch.");
    }

    const environment = loadApiEnvironment({
      DATABASE_URL: database.environment.TEST_DATABASE_URL,
      STOCKWISE_RUNTIME_ENV: "test",
      STOCKWISE_EMAIL_PROVIDER: "non_delivery",
      STOCKWISE_API_PORT: String(API_PORT),
      STOCKWISE_PUBLIC_WEB_ORIGIN: webOrigin,
      STOCKWISE_ANALYTICS_CURSOR_HMAC_KEY:
        randomBytes(32).toString("base64url"),
      STOCKWISE_VERIFICATION_OTP_KEY: randomBytes(32).toString("base64url"),
      STOCKWISE_VERIFICATION_OTP_KEY_ID: "1",
      STOCKWISE_VERIFICATION_PROOF_KEY: randomBytes(32).toString("base64url"),
      STOCKWISE_VERIFICATION_PROOF_KEY_ID: "1",
      STOCKWISE_BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
      STOCKWISE_INVITATION_CONTINUATION_KEY:
        randomBytes(32).toString("base64url"),
      STOCKWISE_SESSION_ABSOLUTE_TIMEOUT_MINUTES: "10080",
      STOCKWISE_SESSION_IDLE_TIMEOUT_MINUTES: "1440",
      STOCKWISE_SESSION_TOUCH_INTERVAL_MINUTES: "15",
    });
    const deliveryFailures: string[] = [];
    const application = createBetterAuthApplicationRuntime({
      environment,
      prisma,
      emailProvider: mailbox.provider,
      onDeliveryFailure: (kind) => deliveryFailures.push(kind),
    });
    cleanup.add(() => application.drain());
    const authenticationMiddleware = application.authenticationMiddleware;
    const apiRouter = application.router;
    apiRouter.use(
      createBranchRouter({
        authenticationMiddleware,
        branchService: createBranchService({
          repository: createPrismaBranchRepository(prisma),
        }),
        publicWebOrigin: webOrigin,
      }),
    );
    apiRouter.use(
      createFirstOrganizationOnboardingRouter({
        authenticationMiddleware,
        onboardingService: createFirstOrganizationOnboardingService({
          repository: createPrismaFirstOrganizationOnboardingRepository(prisma),
        }),
        publicWebOrigin: webOrigin,
      }),
    );

    stage = "database-warmup";
    // Warm adapter pool connections before browser traffic reaches the API.
    await Promise.all(
      Array.from({ length: 8 }, () => prisma.$queryRaw`SELECT 1`),
    );
    stage = "server-startup";
    const nextCli = fileURLToPath(
      new URL(
        "../../../apps/web/node_modules/next/dist/bin/next",
        import.meta.url,
      ),
    );
    const nextEnvironment: NodeJS.ProcessEnv = {};
    for (const key of [
      "PATH",
      "Path",
      "SystemRoot",
      "WINDIR",
      "TEMP",
      "TMP",
      "USERPROFILE",
      "APPDATA",
      "LOCALAPPDATA",
      "HOME",
      "COMSPEC",
      "PATHEXT",
    ]) {
      const value = process.env[key];
      if (value !== undefined) nextEnvironment[key] = value;
    }
    Object.assign(nextEnvironment, {
      STOCKWISE_API_ORIGIN: apiOrigin,
      NEXT_TELEMETRY_DISABLED: "1",
      NODE_ENV: "production",
    });
    const child = spawn(
      process.execPath,
      [nextCli, "start", "--hostname", "127.0.0.1", "--port", String(WEB_PORT)],
      {
        cwd: webRoot,
        env: nextEnvironment,
        stdio: "ignore",
        windowsHide: true,
      },
    );
    let childFailed = false;
    child.once("error", () => {
      childFailed = true;
    });
    const { promise: childExit, resolve: childStopped } =
      Promise.withResolvers<void>();
    child.once("exit", () => childStopped());
    child.once("error", () => childStopped());
    cleanup.add(async () => {
      child.kill();
      try {
        await authBounded(childExit, 2_000);
      } catch {
        child.kill("SIGKILL");
        await authBounded(childExit, 2_000);
      }
    });
    stage = "api-startup";
    const server = await startApiServer(
      createApp({ apiRouter, logger: { info() {}, error() {} } }),
      { host: "127.0.0.1", port: API_PORT },
    );
    cleanup.add(() => server.stop());
    stage = "readiness";
    const deadline = Date.now() + 30_000;
    let ready = false;
    while (Date.now() < deadline && !childFailed && child.exitCode === null) {
      try {
        ready = (
          await fetch(`${webOrigin}/login`, {
            signal: AbortSignal.timeout(1_000),
          })
        ).ok;
      } catch {
        // Bounded startup polling only.
      }
      if (ready) break;
      await delay(100);
    }
    if (!ready)
      throw new Error("Dedicated Next.js server did not become ready.");
    return {
      prisma,
      mailbox,
      deliveryFailures,
      stop: () => cleanup.stop(),
    };
  } catch {
    try {
      await cleanup.stop();
    } catch {
      throw new Error("D4N3_STAGE:cleanup-review");
    }
    throw new Error(`D4N3_STAGE:${stage}`);
  }
}
