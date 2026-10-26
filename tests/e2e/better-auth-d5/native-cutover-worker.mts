import { randomBytes } from "node:crypto";
import { createPrismaClient } from "../../../apps/api/src/prisma/client.ts";
import { createApp } from "../../../apps/api/src/app.ts";
import { startApiServer } from "../../../apps/api/src/server.ts";
import { loadApiEnvironment } from "../../../apps/api/src/environment.ts";
import { createBetterAuthApplicationRuntime } from "../../../apps/api/src/modules/identity/better-auth-application-runtime.ts";
import { createBranchRouter } from "../../../apps/api/src/modules/organizations/branch-router.ts";
import { createBranchService } from "../../../apps/api/src/modules/organizations/branch-service.ts";
import { createPrismaBranchRepository } from "../../../apps/api/src/modules/organizations/branch-repository.ts";
import { nonDeliveryEmailProvider } from "../../../apps/api/src/modules/identity/email-provider.ts";
import { assertNativeCutoverReady } from "../../../apps/api/src/modules/identity/better-auth-cutover-preflight.ts";
import { loadTestDatabaseEnvironment } from "../../../apps/api/src/test/database-environment.ts";
import { verifyLocalPostgresReceipt } from "./local-runner.mts";

let prisma: ReturnType<typeof createPrismaClient> | undefined;
let runtime: ReturnType<typeof createBetterAuthApplicationRuntime> | undefined;
let server: Awaited<ReturnType<typeof startApiServer>> | undefined;
try {
  const database = loadTestDatabaseEnvironment({
    DATABASE_URL: process.env.DATABASE_URL,
    TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
    STOCKWISE_ALLOW_STOCKWISE_TEST: process.env.STOCKWISE_ALLOW_STOCKWISE_TEST,
  });
  const receipt: unknown = JSON.parse(
    process.env.STOCKWISE_LOCAL_DATABASE_RECEIPT ?? "null",
  );
  if (
    !verifyLocalPostgresReceipt(
      receipt,
      process.env.DATABASE_URL ?? "",
      database.TEST_DATABASE_URL,
    )
  )
    throw new Error("DISPOSABLE_RECEIPT_REQUIRED");
  const environment = loadApiEnvironment({
    ...process.env,
    DATABASE_URL: database.TEST_DATABASE_URL,
    STOCKWISE_API_PORT: "3103",
    STOCKWISE_INVITATION_CONTINUATION_KEY:
      randomBytes(32).toString("base64url"),
  });
  prisma = createPrismaClient({ DATABASE_URL: environment.DATABASE_URL });
  const marker = await prisma.$queryRaw<
    { name: string; marker: string | null }[]
  >`
    SELECT current_database() AS name, shobj_description(oid, 'pg_database') AS marker
    FROM pg_database WHERE datname = current_database()`;
  if (
    marker[0]?.name !== receipt.testDatabase ||
    marker[0]?.marker !== `stockwise-local:${receipt.marker}`
  )
    throw new Error("DISPOSABLE_TARGET_REQUIRED");
  await assertNativeCutoverReady(prisma);
  runtime = createBetterAuthApplicationRuntime({
    environment,
    prisma,
    emailProvider: nonDeliveryEmailProvider,
    onDeliveryFailure() {},
  });
  const apiRouter = runtime.router;
  apiRouter.use(
    createBranchRouter({
      authenticationMiddleware: runtime.authenticationMiddleware,
      branchService: createBranchService({
        repository: createPrismaBranchRepository(prisma),
      }),
      publicWebOrigin: environment.STOCKWISE_PUBLIC_WEB_ORIGIN,
    }),
  );
  server = await startApiServer(
    createApp({ apiRouter, logger: { error() {}, info() {} } }),
    { host: "127.0.0.1", port: 0 },
  );
  process.stdout.write(`READY ${server.address.port}\n`);
  let input = "";
  for await (const chunk of process.stdin) {
    input += String(chunk);
    if (input.split(/\r?\n/).includes("STOP")) break;
  }
} catch {
  process.stdout.write("REFUSED\n");
  process.exitCode = 1;
} finally {
  await server?.stop();
  await runtime?.drain();
  await prisma?.$disconnect();
}
