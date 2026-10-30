import { parseArgs } from "node:util";

import { z } from "zod";

import { loadDemoDatabaseEnvironment } from "./demo-environment.ts";
import { issueDemoDatabaseReceipt } from "./demo-local-database.ts";

async function main() {
  const { values } = parseArgs({
    options: {
      "container-id": { type: "string" },
      "receipt-file": { type: "string" },
    },
  });
  const containerId = z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(values["container-id"]);
  const path = z.string().min(1).parse(values["receipt-file"]);
  const { databaseUrl } = loadDemoDatabaseEnvironment();
  await issueDemoDatabaseReceipt({ databaseUrl, containerId, path });
  process.stdout.write(
    "Demo database disposable receipt issued; keep the receipt local.\n",
  );
}
main().catch(() => {
  process.stderr.write(
    "Demo database setup refused; an empty database on an owned local Docker instance is required.\n",
  );
  process.exitCode = 1;
});
