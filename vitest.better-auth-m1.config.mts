import { defineConfig } from "vitest/config";

// Explicit allowlist: never loads the root database migration/reset setup.
export default defineConfig({
  test: {
    fileParallelism: false,
    exclude: ["apps/api/src/modules/identity/*.integration.test.ts"],
    include: [
      "apps/api/src/modules/identity/better-auth-*.test.ts",
      "apps/api/src/modules/identity/authorization-policy.test.ts",
      "apps/api/src/modules/identity/credential-lifecycle-router.test.ts",
      "apps/api/src/modules/identity/credential-lifecycle-service.test.ts",
      "apps/api/src/modules/identity/verification-security.test.ts",
      "apps/api/src/modules/identity/login-limiter.test.ts",
      "apps/api/src/modules/catalog/catalog-router.test.ts",
      "apps/api/src/modules/organizations/branch-router.test.ts",
      "apps/api/src/modules/identity/membership-access-router.test.ts",
      "apps/api/src/modules/identity/first-organization-onboarding-router.test.ts",
      "apps/api/src/modules/inventory/inventory-router.test.ts",
      "apps/api/src/modules/purchasing/purchase-order-router.test.ts",
      "apps/api/src/modules/purchasing/receiving-router.test.ts",
      "apps/api/src/modules/sales/sales-router.test.ts",
    ],
  },
});
