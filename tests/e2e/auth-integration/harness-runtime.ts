import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createApp } from "../../../apps/api/src/app.ts";
import { loadApiEnvironment } from "../../../apps/api/src/environment.ts";
import { createPrismaBranchRepository } from "../../../apps/api/src/modules/organizations/branch-repository.ts";
import { createBranchService } from "../../../apps/api/src/modules/organizations/branch-service.ts";
import { createBranchRouter } from "../../../apps/api/src/modules/organizations/branch-router.ts";
import { createPrismaClient } from "../../../apps/api/src/prisma/client.ts";
import { startApiServer } from "../../../apps/api/src/server.ts";
import {
  createOwnedAuthDatabase,
  requireFreeLoopbackPort,
} from "../../../apps/api/src/test/auth-integration-database.ts";
import { createPrivateVerificationMailbox } from "../../../apps/api/src/test/auth-integration-mailbox.ts";
import {
  authBounded,
  createAuthCleanup,
} from "../../../apps/api/src/test/auth-integration-lifecycle.ts";
const webOrigin = "http://localhost:3102";
const apiOrigin = "http://127.0.0.1:3103";
const webRoot = fileURLToPath(new URL("../../../apps/web/", import.meta.url));
const root = fileURLToPath(new URL("../../../", import.meta.url));

export async function startHarness() {
  // Load the real native password verifier before creating any disposable resource.
  const { createAuthenticationRuntime } =
    await import("../../../apps/api/src/modules/identity/authentication-runtime.ts");
  // Next loads environment files itself. Require a checkout without local secrets.
  for (const directory of [root, webRoot])
    for (const name of [
      ".env",
      ".env.local",
      ".env.production",
      ".env.production.local",
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
  await requireFreeLoopbackPort(3102);
  await requireFreeLoopbackPort(3103);
  const invokingEnvironment = { ...process.env };
  delete invokingEnvironment.PLAYWRIGHT_NO_COPY_PROMPT;
  const cleanup = createAuthCleanup();
  try {
    const database = await createOwnedAuthDatabase(invokingEnvironment);
    cleanup.add(database.cleanup);
    const mailbox = createPrivateVerificationMailbox();
    cleanup.add(() => mailbox.clear());
    const prisma = createPrismaClient({
      DATABASE_URL: database.environment.TEST_DATABASE_URL,
    });
    cleanup.add(() => prisma.$disconnect());
    const environment = loadApiEnvironment({
      DATABASE_URL: database.environment.TEST_DATABASE_URL,
      STOCKWISE_RUNTIME_ENV: "test",
      STOCKWISE_EMAIL_PROVIDER: "non_delivery",
      STOCKWISE_API_PORT: "3103",
      STOCKWISE_PUBLIC_WEB_ORIGIN: webOrigin,
      STOCKWISE_ANALYTICS_CURSOR_HMAC_KEY:
        randomBytes(32).toString("base64url"),
      STOCKWISE_VERIFICATION_OTP_KEY: randomBytes(32).toString("base64url"),
      STOCKWISE_VERIFICATION_OTP_KEY_ID: "1",
      STOCKWISE_VERIFICATION_PROOF_KEY: randomBytes(32).toString("base64url"),
      STOCKWISE_VERIFICATION_PROOF_KEY_ID: "1",
      STOCKWISE_INVITATION_CONTINUATION_KEY:
        randomBytes(32).toString("base64url"),
    });
    const runtime = createAuthenticationRuntime({
      environment,
      prisma,
      emailProvider: mailbox.provider,
      onDeliveryFailure() {},
    });
    cleanup.add(() => runtime.drain());
    runtime.router.use(
      createBranchRouter({
        authenticationMiddleware: runtime.authenticationMiddleware,
        branchService: createBranchService({
          repository: createPrismaBranchRepository(prisma),
        }),
        publicWebOrigin: webOrigin,
      }),
    );
    const nextCli = fileURLToPath(
      new URL(
        "../../../apps/web/node_modules/next/dist/bin/next",
        import.meta.url,
      ),
    );
    const child = spawn(
      process.execPath,
      [nextCli, "start", "--hostname", "127.0.0.1", "--port", "3102"],
      {
        cwd: webRoot,
        env: {
          ...process.env,
          STOCKWISE_API_ORIGIN: apiOrigin,
          NEXT_TELEMETRY_DISABLED: "1",
          NODE_ENV: "production",
        },
        stdio: "ignore",
        windowsHide: true,
      },
    );
    let childFailed = false;
    child.once("error", () => {
      childFailed = true;
    });
    const childExit = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
    });
    cleanup.add(async () => {
      child.kill();
      try {
        await authBounded(childExit, 2_000);
      } catch {
        child.kill("SIGKILL");
        await authBounded(childExit, 2_000);
      }
    });
    const server = await startApiServer(
      createApp({
        apiRouter: runtime.router,
        logger: { info() {}, error() {} },
      }),
      { host: "127.0.0.1", port: 3103 },
    );
    cleanup.add(() => server.stop());
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
        /* bounded startup polling */
      }
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!ready)
      throw new Error("Dedicated Next.js server did not become ready.");
    return {
      prisma,
      mailbox,
      stop: () => cleanup.stop(),
    };
  } catch {
    try {
      await cleanup.stop();
    } catch {
      throw new Error(
        "Authentication harness startup and cleanup failed; review owned resources.",
      );
    }
    throw new Error("Authentication harness startup failed.");
  }
}
