import { Router } from "express";

import { createAuthenticationRuntime } from "./modules/identity/authentication-runtime.ts";
import { selectAuthenticationAuthority } from "./modules/identity/authentication-authority-selection.ts";
import { createBetterAuthApplicationRuntime } from "./modules/identity/better-auth-application-runtime.ts";
import { BETTER_AUTH_NATIVE_ENABLED } from "./modules/identity/better-auth-native.ts";
import { assertNativeCutoverReady } from "./modules/identity/better-auth-cutover-preflight.ts";
import { createApp } from "./app.ts";
import { loadApiEnvironment } from "./environment.ts";
import { createPrismaAnalyticsBranchRepository } from "./modules/analytics/analytics-branch-repository.ts";
import { createAnalyticsBranchService } from "./modules/analytics/analytics-branch-service.ts";
import { createPrismaAnalyticsCategoryRepository } from "./modules/analytics/analytics-category-repository.ts";
import { createAnalyticsCategoryService } from "./modules/analytics/analytics-category-service.ts";
import { createAnalyticsContextEngine } from "./modules/analytics/analytics-context.ts";
import { createAnalyticsDimensionCursorCodec } from "./modules/analytics/analytics-dimension-cursor.ts";
import { createPrismaAnalyticsInventoryRepository } from "./modules/analytics/analytics-inventory-repository.ts";
import { createPrismaForecastRepository } from "./modules/analytics/analytics-forecast-repository.ts";
import { createForecastService } from "./modules/analytics/analytics-forecast-service.ts";
import { createPrismaReorderRepository } from "./modules/analytics/analytics-reorder-repository.ts";
import { createReorderService } from "./modules/analytics/analytics-reorder-service.ts";
import { createAnalyticsInventoryService } from "./modules/analytics/analytics-inventory-service.ts";
import { createAnalyticsRouter } from "./modules/analytics/analytics-router.ts";
import { createAiInsightRouter } from "./modules/ai-insights/ai-insight-router.ts";
import { createPrismaAiInsightReader } from "./modules/ai-insights/ai-insight-store.ts";
import { createPrismaAnalyticsSalesRepository } from "./modules/analytics/analytics-sales-repository.ts";
import { createAnalyticsSalesService } from "./modules/analytics/analytics-sales-service.ts";
import { createPrismaAnalyticsScopeRepository } from "./modules/analytics/analytics-scope-repository.ts";
import { createApiLogger } from "./logger.ts";
import { createPrismaCatalogRepository } from "./modules/catalog/catalog-repository.ts";
import { createCatalogRouter } from "./modules/catalog/catalog-router.ts";
import { createCatalogService } from "./modules/catalog/catalog-service.ts";
import { createPrismaSupplierRepository } from "./modules/suppliers/supplier-repository.ts";
import { createSupplierRouter } from "./modules/suppliers/supplier-router.ts";
import { createSupplierService } from "./modules/suppliers/supplier-service.ts";
import { createPrismaPurchaseOrderRepository } from "./modules/purchasing/purchase-order-repository.ts";
import { createPurchaseOrderRouter } from "./modules/purchasing/purchase-order-router.ts";
import { createPurchaseOrderService } from "./modules/purchasing/purchase-order-service.ts";
import { createPrismaReceivingRepository } from "./modules/purchasing/receiving-repository.ts";
import { createReceivingRouter } from "./modules/purchasing/receiving-router.ts";
import { createReceivingService } from "./modules/purchasing/receiving-service.ts";
import { createPrismaInventoryRepository } from "./modules/inventory/inventory-repository.ts";
import { createInventoryRouter } from "./modules/inventory/inventory-router.ts";
import { createInventoryService } from "./modules/inventory/inventory-service.ts";
import { createPrismaCheckoutRepository } from "./modules/sales/checkout-repository.ts";
import { createCheckoutService } from "./modules/sales/checkout-service.ts";
import { createPrismaSalesApiRepository } from "./modules/sales/sales-api-repository.ts";
import { createSalesApiService } from "./modules/sales/sales-api-service.ts";
import { createSalesRouter } from "./modules/sales/sales-router.ts";
import { createPrismaRefundRepository } from "./modules/sales/refund-repository.ts";
import { createRefundService } from "./modules/sales/refund-service.ts";
import { createIdentityEmailProvider } from "./modules/identity/email-provider-configuration.ts";
import { createPrismaFirstOrganizationOnboardingRepository } from "./modules/identity/first-organization-onboarding-repository.ts";
import { createFirstOrganizationOnboardingRouter } from "./modules/identity/first-organization-onboarding-router.ts";
import { createFirstOrganizationOnboardingService } from "./modules/identity/first-organization-onboarding-service.ts";
import { createMembershipAccessRouter } from "./modules/identity/membership-access-router.ts";
import { createPrismaMembershipAccessRepository } from "./modules/identity/membership-access-repository.ts";
import { createMembershipAccessService } from "./modules/identity/membership-access-service.ts";
import { secureOneTimeTokenProvider } from "./modules/identity/one-time-token.ts";
import { createPrismaBranchRepository } from "./modules/organizations/branch-repository.ts";
import { createBranchRouter } from "./modules/organizations/branch-router.ts";
import { createBranchService } from "./modules/organizations/branch-service.ts";
import { getPrismaClient } from "./prisma/client.ts";
import { createShutdownHandler, startApiServer } from "./server.ts";

const logger = createApiLogger();

async function main(): Promise<void> {
  const environment = loadApiEnvironment();
  const prisma = getPrismaClient(environment);
  const emailProvider = createIdentityEmailProvider(environment);
  const onDeliveryFailure: Parameters<
    typeof createAuthenticationRuntime
  >[0]["onDeliveryFailure"] = (kind, failure) => {
    logger.error(
      {
        deliveryType: kind,
        ...(failure === undefined ? {} : { failureStage: failure.stage }),
        ...(failure?.providerHttpStatus === undefined
          ? {}
          : { providerHttpStatus: failure.providerHttpStatus }),
      },
      "identity email delivery failed",
    );
  };
  // Only one auth authority may be constructed per process. Live Native stays
  // compile-time disabled until route parity and cutover review are accepted.
  if (BETTER_AUTH_NATIVE_ENABLED) {
    await assertNativeCutoverReady(prisma);
  }
  const authentication = selectAuthenticationAuthority({
    nativeEnabled: BETTER_AUTH_NATIVE_ENABLED,
    legacy: () =>
      createAuthenticationRuntime({
        environment,
        prisma,
        emailProvider,
        onDeliveryFailure,
      }),
    native: () =>
      createBetterAuthApplicationRuntime({
        environment,
        prisma,
        emailProvider,
        onDeliveryFailure,
      }),
  });
  const { authenticationMiddleware } = authentication;
  const firstOrganizationOnboardingService =
    createFirstOrganizationOnboardingService({
      repository: createPrismaFirstOrganizationOnboardingRepository(prisma),
    });
  const branchService = createBranchService({
    repository: createPrismaBranchRepository(prisma),
  });
  const membershipAccessService = createMembershipAccessService({
    emailProvider,
    onDeliveryFailure(kind) {
      logger.error({ deliveryType: kind }, "invitation email delivery failed");
    },
    publicWebOrigin: environment.STOCKWISE_PUBLIC_WEB_ORIGIN,
    repository: createPrismaMembershipAccessRepository(prisma),
    tokenProvider: secureOneTimeTokenProvider,
  });
  const catalogService = createCatalogService({
    repository: createPrismaCatalogRepository(prisma),
  });
  const inventoryService = createInventoryService({
    repository: createPrismaInventoryRepository(prisma),
  });
  const supplierService = createSupplierService({
    repository: createPrismaSupplierRepository(prisma),
  });
  const purchaseOrderService = createPurchaseOrderService({
    repository: createPrismaPurchaseOrderRepository(prisma),
  });
  const receivingService = createReceivingService({
    repository: createPrismaReceivingRepository(prisma),
  });
  const checkoutService = createCheckoutService({
    repository: createPrismaCheckoutRepository(prisma),
  });
  const salesApiService = createSalesApiService({
    repository: createPrismaSalesApiRepository(prisma),
  });
  const refundService = createRefundService({
    repository: createPrismaRefundRepository(prisma),
  });
  const analyticsCursorCodec = createAnalyticsDimensionCursorCodec(
    Buffer.from(environment.STOCKWISE_ANALYTICS_CURSOR_HMAC_KEY, "base64url"),
  );
  const analyticsContextEngine = createAnalyticsContextEngine({
    scopeRepository: createPrismaAnalyticsScopeRepository(prisma),
  });
  const analyticsSalesService = createAnalyticsSalesService({
    contextEngine: analyticsContextEngine,
    repository: createPrismaAnalyticsSalesRepository(prisma),
  });
  const analyticsCategoryService = createAnalyticsCategoryService({
    contextEngine: analyticsContextEngine,
    cursorCodec: analyticsCursorCodec,
    repository: createPrismaAnalyticsCategoryRepository(
      prisma,
      analyticsCursorCodec,
    ),
  });
  const analyticsBranchService = createAnalyticsBranchService({
    contextEngine: analyticsContextEngine,
    cursorCodec: analyticsCursorCodec,
    repository: createPrismaAnalyticsBranchRepository(
      prisma,
      analyticsCursorCodec,
    ),
  });
  const analyticsInventoryService = createAnalyticsInventoryService({
    contextEngine: analyticsContextEngine,
    cursorCodec: analyticsCursorCodec,
    repository: createPrismaAnalyticsInventoryRepository(
      prisma,
      analyticsCursorCodec,
    ),
  });
  const apiRouter = Router();
  apiRouter.use(authentication.router);
  apiRouter.use(
    createFirstOrganizationOnboardingRouter({
      authenticationMiddleware,
      onboardingService: firstOrganizationOnboardingService,
      publicWebOrigin: environment.STOCKWISE_PUBLIC_WEB_ORIGIN,
    }),
  );
  apiRouter.use(
    createBranchRouter({
      authenticationMiddleware,
      branchService,
      publicWebOrigin: environment.STOCKWISE_PUBLIC_WEB_ORIGIN,
    }),
  );
  apiRouter.use(
    createMembershipAccessRouter({
      authenticationMiddleware,
      membershipAccessService,
      publicWebOrigin: environment.STOCKWISE_PUBLIC_WEB_ORIGIN,
    }),
  );
  apiRouter.use(
    createCatalogRouter({
      authenticationMiddleware,
      catalogService,
      publicWebOrigin: environment.STOCKWISE_PUBLIC_WEB_ORIGIN,
    }),
  );
  apiRouter.use(
    createSupplierRouter({
      authenticationMiddleware,
      publicWebOrigin: environment.STOCKWISE_PUBLIC_WEB_ORIGIN,
      supplierService,
    }),
  );
  apiRouter.use(
    createPurchaseOrderRouter({
      authenticationMiddleware,
      publicWebOrigin: environment.STOCKWISE_PUBLIC_WEB_ORIGIN,
      purchaseOrderService,
    }),
  );
  apiRouter.use(
    createReceivingRouter({
      authenticationMiddleware,
      publicWebOrigin: environment.STOCKWISE_PUBLIC_WEB_ORIGIN,
      receivingService,
    }),
  );
  apiRouter.use(
    createInventoryRouter({
      authenticationMiddleware,
      inventoryService,
      publicWebOrigin: environment.STOCKWISE_PUBLIC_WEB_ORIGIN,
    }),
  );
  apiRouter.use(
    createSalesRouter({
      authenticationMiddleware,
      checkoutService,
      publicWebOrigin: environment.STOCKWISE_PUBLIC_WEB_ORIGIN,
      refundService,
      salesApiService,
    }),
  );
  apiRouter.use(
    createAnalyticsRouter({
      authenticationMiddleware,
      branchService: analyticsBranchService,
      categoryService: analyticsCategoryService,
      inventoryService: analyticsInventoryService,
      forecastService: createForecastService(
        createPrismaForecastRepository(prisma),
      ),
      reorderService: createReorderService(
        createPrismaReorderRepository(prisma),
      ),
      salesService: analyticsSalesService,
    }),
  );
  apiRouter.use(
    createAiInsightRouter({
      authenticationMiddleware,
      reader: createPrismaAiInsightReader(prisma),
    }),
  );

  const app = createApp({ apiRouter, logger });
  const runningServer = await startApiServer(app, {
    host: "127.0.0.1",
    port: environment.STOCKWISE_API_PORT,
  });
  const shutdown = createShutdownHandler(runningServer, logger, async () => {
    await authentication.drain();
    await prisma.$disconnect();
  });

  logger.info(
    {
      host: runningServer.address.host,
      port: runningServer.address.port,
    },
    "API server started",
  );

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void shutdown(signal).catch(() => {
        process.exitCode = 1;
      });
    });
  }
}

void main().catch((error: unknown) => {
  logger.error(
    { errorName: error instanceof Error ? error.name : "UnknownError" },
    "API server failed to start",
  );
  process.exitCode = 1;
});
