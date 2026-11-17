import { fileURLToPath } from "node:url";

import { configDefaults, defineConfig } from "vitest/config";

const repositoryRoot = fileURLToPath(new URL(".", import.meta.url));
const databaseTestSetup = fileURLToPath(
  new URL("./apps/api/src/test/database-global-setup.ts", import.meta.url),
);

export default defineConfig({
  oxc: {
    jsx: {
      runtime: "automatic",
    },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./apps/web/src", import.meta.url)),
    },
  },
  root: repositoryRoot,
  test: {
    exclude: [
      ...configDefaults.exclude,
      "tests/e2e/**",
      // Operator cutover runs only inside the receipt-bound D5-P4 coordinator.
      "apps/api/src/native-cutover/native-cutover.integration.test.ts",
    ],
    fileParallelism: false,
    globalSetup: [databaseTestSetup],
    include: ["**/*.test.{ts,tsx}"],
  },
});
