import { createPrismaClient } from "../../../apps/api/src/prisma/client.ts";
import type { PrismaClient } from "../../../apps/api/src/generated/prisma/client.ts";
import { createDisposableNativeTransition } from "./native-transition.mts";

// Test-only child protocol. Connection credentials arrive on stdin, never argv,
// environment, stdout or evidence. The live runner receipt is checked by the tool.
let prisma: PrismaClient | undefined;
try {
  let input = "";
  for await (const chunk of process.stdin) input += String(chunk);
  const data: unknown = JSON.parse(input);
  if (
    typeof data !== "object" ||
    data === null ||
    !("databaseUrl" in data) ||
    !("testDatabaseUrl" in data) ||
    !("receipt" in data) ||
    !("userId" in data) ||
    !("expected" in data) ||
    !("mode" in data)
  )
    throw new Error("INVALID_WORKER_INPUT");
  if (
    typeof data.databaseUrl !== "string" ||
    typeof data.testDatabaseUrl !== "string" ||
    typeof data.userId !== "string" ||
    typeof data.expected !== "object" ||
    data.expected === null ||
    !("credentialVersion" in data.expected) ||
    !("passwordChangedAt" in data.expected) ||
    !("updatedAt" in data.expected) ||
    typeof data.expected.credentialVersion !== "string" ||
    typeof data.expected.passwordChangedAt !== "string" ||
    typeof data.expected.updatedAt !== "string"
  )
    throw new Error("INVALID_WORKER_INPUT");
  prisma = createPrismaClient({ DATABASE_URL: data.testDatabaseUrl });
  const mode = data.mode;
  if (mode !== "interrupt" && mode !== "replay")
    throw new Error("INVALID_WORKER_MODE");
  const transition = await createDisposableNativeTransition({
    prisma,
    databaseUrl: data.databaseUrl,
    testDatabaseUrl: data.testDatabaseUrl,
    receipt: data.receipt,
  });
  if (mode === "interrupt") process.stdout.write("TRANSITION_STARTED\n");
  const result = await transition.transitionUser(data.userId, {
    credentialVersion: BigInt(data.expected.credentialVersion),
    passwordChangedAt: new Date(data.expected.passwordChangedAt),
    updatedAt: new Date(data.expected.updatedAt),
  });
  process.stdout.write(JSON.stringify(result) + "\n");
} catch {
  process.stderr.write("TRANSITION_WORKER_REFUSED\n");
  process.exitCode = 1;
} finally {
  await prisma?.$disconnect();
}
