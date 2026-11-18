import { databaseUrlSchema } from "../environment.ts";
import { createPrismaBillingRepository } from "../modules/billing/billing-repository.ts";
import { createPrismaClient } from "../prisma/client.ts";
import {
  ExpireRefusal,
  expireRehearsalSubscription,
  REHEARSAL_ORGANIZATION_ID,
} from "./expire-subscription.ts";

async function main(): Promise<void> {
  const prisma = createPrismaClient({
    DATABASE_URL: databaseUrlSchema.parse(process.env.DATABASE_URL),
  });
  try {
    const previous = await expireRehearsalSubscription(
      createPrismaBillingRepository(prisma),
    );
    process.stdout.write(
      `STOCKWISE_SUBSCRIPTION:EXPIRED organization=${REHEARSAL_ORGANIZATION_ID} previous=${previous}\n`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  // Driver errors can echo connection details; only fixed codes pass through.
  const message =
    error instanceof ExpireRefusal
      ? error.message
      : "EXPIRE_SUBSCRIPTION_FAILED";
  process.stderr.write(`STOCKWISE_REFUSED: ${message}\n`);
  process.exitCode = 1;
});
