import { loadTestDatabaseEnvironment } from "../../apps/api/src/test/database-environment.ts";
import {
  applyTestDatabaseMigrations,
  provisionTestDatabase,
} from "../../apps/api/src/test/database-harness.ts";

/**
 * Prepares the guarded disposable e2e database before Playwright starts its
 * web servers (Playwright starts them before globalSetup, and the API refuses
 * to start against an unmigrated database). A database is Native directly from
 * its migrations, so there is nothing to seal. Only fixed status lines are
 * printed: never the database URL, credentials or user data.
 */
try {
  const environment = loadTestDatabaseEnvironment();
  await provisionTestDatabase(environment);
  await applyTestDatabaseMigrations(environment);
  process.stdout.write("e2e database ready\n");
} catch {
  process.stdout.write("e2e database prepare failed\n");
  process.exitCode = 1;
}
