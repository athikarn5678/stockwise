import { Router, type RequestHandler, type Response } from "express";

import { getTrustedAuthenticationContext } from "../identity/authentication-context.ts";
import { createCrossSiteRequestProtection } from "../identity/credential-lifecycle-router.ts";
import { idempotencyKeySchema } from "../inventory/inventory-schemas.ts";
import type {
  CheckoutOutcome,
  CheckoutQuoteOutcome,
} from "./checkout-repository.ts";
import type { CheckoutService } from "./checkout-service.ts";
import { buildPromptPayPayload } from "./promptpay-payload.ts";
import type { RefundOutcome } from "./refund-repository.ts";
import type { RefundService } from "./refund-service.ts";
import type {
  PosProductSearchOutcome,
  SalesHistoryDetailOutcome,
  SalesHistoryListOutcome,
  SalesVatProfileOutcome,
  SalesVatProfileUpdateOutcome,
} from "./sales-api-repository.ts";
import type { SalesApiService } from "./sales-api-service.ts";
import {
  branchSalesParamsSchema,
  checkoutRequestSchema,
  organizationSalesParamsSchema,
  posProductSearchQuerySchema,
  promptPayQuoteRequestSchema,
  refundRequestSchema,
  saleDetailParamsSchema,
  salesHistoryQuerySchema,
  salesVatProfileUpdateSchema,
} from "./sales-schemas.ts";

function requestId(response: Response): string {
  const value = response.getHeader("X-Request-Id");
  return typeof value === "string" ? value : "unavailable";
}

function sendSalesHistoryList(
  response: Response,
  outcome: SalesHistoryListOutcome,
): void {
  if (outcome.kind === "success") {
    response.status(200).json({
      data: { sales: outcome.sales },
      meta: { nextCursor: outcome.nextCursor, requestId: requestId(response) },
    });
    return;
  }
  if (outcome.kind === "forbidden") {
    error(response, 403, "FORBIDDEN", "The operation is not permitted.");
    return;
  }
  error(response, 400, "INVALID_CURSOR", "The cursor is invalid.");
}

function sendSalesHistoryDetail(
  response: Response,
  outcome: SalesHistoryDetailOutcome,
): void {
  if (outcome.kind === "success") {
    response.status(200).json({
      data: { sale: outcome.sale },
      meta: { requestId: requestId(response) },
    });
    return;
  }
  if (outcome.kind === "forbidden") {
    error(response, 403, "FORBIDDEN", "The operation is not permitted.");
    return;
  }
  error(response, 404, "SALE_NOT_FOUND", "The sale was not found.");
}

function error(
  response: Response,
  status: number,
  code: string,
  message: string,
): void {
  response.status(status).json({
    error: { code, message, requestId: requestId(response) },
  });
}

function actorId(response: Response): string | null {
  return getTrustedAuthenticationContext(response)?.actor.id ?? null;
}

function authenticationRequired(response: Response): void {
  error(
    response,
    401,
    "AUTHENTICATION_REQUIRED",
    "Authentication is required.",
  );
}

function invalidRequest(response: Response): void {
  error(response, 400, "VALIDATION_ERROR", "The request is invalid.");
}

function sendSalesVatProfile(
  response: Response,
  outcome: SalesVatProfileOutcome | SalesVatProfileUpdateOutcome,
): void {
  if (outcome.kind === "success") {
    response.status(200).json({
      data: { salesVatProfile: outcome.profile },
      meta: { requestId: requestId(response) },
    });
    return;
  }
  if (outcome.kind === "forbidden") {
    error(response, 403, "FORBIDDEN", "The operation is not permitted.");
    return;
  }
  if (outcome.kind === "stale") {
    error(
      response,
      409,
      "SALES_VAT_PROFILE_STALE",
      "The sales VAT profile changed. Refresh and try again.",
    );
    return;
  }
  invalidRequest(response);
}

function sendPosProducts(
  response: Response,
  outcome: PosProductSearchOutcome,
): void {
  if (outcome.kind === "success") {
    response.status(200).json({
      data: { products: outcome.products },
      meta: {
        nextCursor: outcome.nextCursor,
        requestId: requestId(response),
      },
    });
    return;
  }
  if (outcome.kind === "forbidden") {
    error(response, 403, "FORBIDDEN", "The operation is not permitted.");
    return;
  }
  if (outcome.kind === "branch_inactive") {
    error(response, 409, "BRANCH_INACTIVE", "The branch is inactive.");
    return;
  }
  error(response, 400, "INVALID_CURSOR", "The cursor is invalid.");
}

type CheckoutFailureKind = Exclude<
  CheckoutOutcome,
  { kind: "success" } | { kind: "replay" }
>["kind"];

/** Checkout and PromptPay quote outcomes share one canonical error mapping. */
const CHECKOUT_FAILURES = {
  branch_inactive: [409, "BRANCH_INACTIVE", "The branch is inactive."],
  duplicate_product: [400, "VALIDATION_ERROR", "The request is invalid."],
  forbidden: [403, "FORBIDDEN", "The operation is not permitted."],
  idempotency_conflict: [
    409,
    "IDEMPOTENCY_CONFLICT",
    "The idempotency key was already used for another request.",
  ],
  insufficient_stock: [
    409,
    "INSUFFICIENT_STOCK",
    "There is insufficient stock to complete checkout.",
  ],
  invalid_amounts: [400, "VALIDATION_ERROR", "The request is invalid."],
  invalid_discount: [400, "VALIDATION_ERROR", "The discount is invalid."],
  invalid_idempotency_key: [
    400,
    "VALIDATION_ERROR",
    "The idempotency key is invalid.",
  ],
  invalid_payment: [400, "VALIDATION_ERROR", "The payment is invalid."],
  invalid_price: [400, "VALIDATION_ERROR", "The price is invalid."],
  invalid_quantity: [400, "VALIDATION_ERROR", "The quantity is invalid."],
  not_found: [404, "PRODUCT_NOT_FOUND", "A product was not found."],
  price_changed: [
    409,
    "PRICE_CHANGED",
    "A product price changed. Refresh and try again.",
  ],
  product_inactive: [409, "PRODUCT_INACTIVE", "A product is inactive."],
  total_mismatch: [
    409,
    "CHECKOUT_TOTAL_MISMATCH",
    "The total differs from the amount that was shown. Refresh and try again.",
  ],
  vat_configuration_required: [
    409,
    "VAT_CONFIGURATION_REQUIRED",
    "Sales VAT configuration is required before checkout.",
  ],
} as const satisfies Record<
  CheckoutFailureKind,
  readonly [number, string, string]
>;

function sendCheckout(response: Response, outcome: CheckoutOutcome): void {
  if (outcome.kind === "success" || outcome.kind === "replay") {
    response.status(outcome.kind === "success" ? 201 : 200).json({
      data: { sale: outcome.sale },
      meta: { requestId: requestId(response) },
    });
    return;
  }
  const [status, code, message] = CHECKOUT_FAILURES[outcome.kind];
  error(response, status, code, message);
}

function isPositiveMoneyAmount(amount: string): boolean {
  // Mirrors the payload builder's accepted shape so a bad total is a 400, not a crash.
  return /^\d{1,10}\.\d{2}$/.test(amount) && /[1-9]/.test(amount);
}

function sendPromptPayQuote(
  response: Response,
  outcome: CheckoutQuoteOutcome,
  promptPayId: string,
): void {
  if (outcome.kind === "success") {
    if (!isPositiveMoneyAmount(outcome.totalAmount)) {
      invalidRequest(response);
      return;
    }
    response.status(200).json({
      data: {
        amount: outcome.totalAmount,
        currency: "THB",
        payload: buildPromptPayPayload({
          amount: outcome.totalAmount,
          mobileNumber: promptPayId,
        }),
      },
      meta: { requestId: requestId(response) },
    });
    return;
  }
  const [status, code, message] = CHECKOUT_FAILURES[outcome.kind];
  error(response, status, code, message);
}

function sendRefund(response: Response, outcome: RefundOutcome): void {
  if (outcome.kind === "success" || outcome.kind === "replay") {
    response.status(outcome.kind === "success" ? 201 : 200).json({
      data: { refund: outcome.refund },
      meta: { requestId: requestId(response) },
    });
    return;
  }
  const failures = {
    branch_inactive: [409, "BRANCH_INACTIVE", "The branch is inactive."],
    duplicate_item: [400, "VALIDATION_ERROR", "The request is invalid."],
    forbidden: [403, "FORBIDDEN", "The operation is not permitted."],
    idempotency_conflict: [
      409,
      "IDEMPOTENCY_CONFLICT",
      "The idempotency key was already used for another request.",
    ],
    invalid_idempotency_key: [
      400,
      "VALIDATION_ERROR",
      "The idempotency key is invalid.",
    ],
    invalid_payment_method: [
      400,
      "VALIDATION_ERROR",
      "The payment is invalid.",
    ],
    invalid_quantity: [400, "VALIDATION_ERROR", "The quantity is invalid."],
    invalid_reason: [400, "VALIDATION_ERROR", "The reason is invalid."],
    invalid_restock: [
      400,
      "VALIDATION_ERROR",
      "The restock quantity is invalid.",
    ],
    invalid_transfer_reference: [
      400,
      "VALIDATION_ERROR",
      "The transfer reference is invalid.",
    ],
    not_found: [404, "SALE_NOT_FOUND", "The sale was not found."],
    refund_quantity_exceeded: [
      409,
      "REFUND_QUANTITY_EXCEEDED",
      "The refund quantity exceeds the remaining quantity.",
    ],
    sale_already_fully_refunded: [
      409,
      "SALE_ALREADY_FULLY_REFUNDED",
      "The sale is already fully refunded.",
    ],
    zero_refund_amount: [400, "VALIDATION_ERROR", "The request is invalid."],
  } as const;
  const [status, code, message] = failures[outcome.kind];
  error(response, status, code, message);
}

export function createSalesRouter({
  authenticationMiddleware,
  checkoutService,
  promptPayId,
  publicWebOrigin,
  refundService,
  salesApiService,
}: {
  authenticationMiddleware: RequestHandler;
  checkoutService: CheckoutService;
  promptPayId?: string | undefined;
  publicWebOrigin: string;
  refundService: RefundService;
  salesApiService: SalesApiService;
}): Router {
  const router = Router();
  const protectMutation = createCrossSiteRequestProtection(publicWebOrigin);

  router.get(
    "/organizations/:organizationId/branches/:branchId/sales",
    authenticationMiddleware,
    async (request, response, next) => {
      const id = actorId(response);
      const params = branchSalesParamsSchema.safeParse(request.params);
      const query = salesHistoryQuerySchema.safeParse(request.query);
      if (id === null) return authenticationRequired(response);
      if (!params.success || !query.success) return invalidRequest(response);
      try {
        sendSalesHistoryList(
          response,
          await salesApiService.listSalesHistory({
            actorUserId: id,
            branchId: params.data.branchId,
            organizationId: params.data.organizationId,
            query: query.data,
          }),
        );
      } catch (cause: unknown) {
        next(cause);
      }
    },
  );

  // Reports one deployment-wide boolean (is a PromptPay receiver configured); it
  // carries nothing tenant-specific, so authentication alone is enough.
  router.get(
    "/organizations/:organizationId/branches/:branchId/sales/payment-options",
    authenticationMiddleware,
    (request, response) => {
      const id = actorId(response);
      const params = branchSalesParamsSchema.safeParse(request.params);
      if (id === null) return authenticationRequired(response);
      if (!params.success) return invalidRequest(response);
      response.status(200).json({
        data: { promptPay: promptPayId !== undefined },
        meta: { requestId: requestId(response) },
      });
    },
  );

  router.post(
    "/organizations/:organizationId/branches/:branchId/sales/promptpay-qr",
    protectMutation,
    authenticationMiddleware,
    async (request, response, next) => {
      const id = actorId(response);
      const params = branchSalesParamsSchema.safeParse(request.params);
      const body = promptPayQuoteRequestSchema.safeParse(request.body);
      if (id === null) return authenticationRequired(response);
      if (!params.success || !body.success) return invalidRequest(response);
      if (promptPayId === undefined) {
        return error(
          response,
          404,
          "PROMPTPAY_NOT_CONFIGURED",
          "PromptPay is not configured.",
        );
      }
      try {
        sendPromptPayQuote(
          response,
          await checkoutService.quote({
            actorUserId: id,
            branchId: params.data.branchId,
            discount: body.data.discount,
            items: body.data.items,
            organizationId: params.data.organizationId,
          }),
          promptPayId,
        );
      } catch (cause: unknown) {
        next(cause);
      }
    },
  );

  router.get(
    "/organizations/:organizationId/branches/:branchId/sales/:saleId",
    authenticationMiddleware,
    async (request, response, next) => {
      const id = actorId(response);
      const params = saleDetailParamsSchema.safeParse(request.params);
      if (id === null) return authenticationRequired(response);
      if (!params.success) {
        return invalidRequest(response);
      }
      try {
        sendSalesHistoryDetail(
          response,
          await salesApiService.getSalesHistoryDetail({
            actorUserId: id,
            branchId: params.data.branchId,
            organizationId: params.data.organizationId,
            saleId: params.data.saleId,
          }),
        );
      } catch (cause: unknown) {
        next(cause);
      }
    },
  );

  router.get(
    "/organizations/:organizationId/sales-vat-profile",
    authenticationMiddleware,
    async (request, response, next) => {
      const id = actorId(response);
      const params = organizationSalesParamsSchema.safeParse(request.params);
      if (id === null) return authenticationRequired(response);
      if (!params.success) return invalidRequest(response);
      try {
        sendSalesVatProfile(
          response,
          await salesApiService.getSalesVatProfile({
            actorUserId: id,
            organizationId: params.data.organizationId,
          }),
        );
      } catch (cause: unknown) {
        next(cause);
      }
    },
  );

  router.patch(
    "/organizations/:organizationId/sales-vat-profile",
    protectMutation,
    authenticationMiddleware,
    async (request, response, next) => {
      const id = actorId(response);
      const params = organizationSalesParamsSchema.safeParse(request.params);
      const body = salesVatProfileUpdateSchema.safeParse(request.body);
      if (id === null) return authenticationRequired(response);
      if (!params.success || !body.success) return invalidRequest(response);
      try {
        sendSalesVatProfile(
          response,
          await salesApiService.updateSalesVatProfile({
            actorUserId: id,
            organizationId: params.data.organizationId,
            profile: body.data,
          }),
        );
      } catch (cause: unknown) {
        next(cause);
      }
    },
  );

  router.get(
    "/organizations/:organizationId/branches/:branchId/pos/products",
    authenticationMiddleware,
    async (request, response, next) => {
      const id = actorId(response);
      const params = branchSalesParamsSchema.safeParse(request.params);
      const query = posProductSearchQuerySchema.safeParse(request.query);
      if (id === null) return authenticationRequired(response);
      if (!params.success || !query.success) return invalidRequest(response);
      try {
        sendPosProducts(
          response,
          await salesApiService.searchPosProducts({
            actorUserId: id,
            branchId: params.data.branchId,
            organizationId: params.data.organizationId,
            query: query.data,
          }),
        );
      } catch (cause: unknown) {
        next(cause);
      }
    },
  );

  router.post(
    "/organizations/:organizationId/branches/:branchId/sales",
    protectMutation,
    authenticationMiddleware,
    async (request, response, next) => {
      const id = actorId(response);
      const params = branchSalesParamsSchema.safeParse(request.params);
      const body = checkoutRequestSchema.safeParse(request.body);
      const idempotencyKey = idempotencyKeySchema.safeParse(
        request.get("Idempotency-Key"),
      );
      if (id === null) return authenticationRequired(response);
      if (!params.success || !body.success || !idempotencyKey.success) {
        return invalidRequest(response);
      }
      try {
        sendCheckout(
          response,
          await checkoutService.checkout({
            actorUserId: id,
            branchId: params.data.branchId,
            discount: body.data.discount,
            idempotencyKey: idempotencyKey.data,
            items: body.data.items,
            organizationId: params.data.organizationId,
            payment: body.data.payment,
          }),
        );
      } catch (cause: unknown) {
        next(cause);
      }
    },
  );

  router.post(
    "/organizations/:organizationId/branches/:branchId/sales/:saleId/refunds",
    protectMutation,
    authenticationMiddleware,
    async (request, response, next) => {
      const id = actorId(response);
      const params = saleDetailParamsSchema.safeParse(request.params);
      const body = refundRequestSchema.safeParse(request.body);
      const idempotencyKey = idempotencyKeySchema.safeParse(
        request.get("Idempotency-Key"),
      );
      if (id === null) return authenticationRequired(response);
      if (!params.success || !body.success || !idempotencyKey.success) {
        return invalidRequest(response);
      }
      try {
        sendRefund(
          response,
          await refundService.createRefund({
            actorUserId: id,
            branchId: params.data.branchId,
            idempotencyKey: idempotencyKey.data,
            items: body.data.items,
            organizationId: params.data.organizationId,
            reason: body.data.reason,
            saleId: params.data.saleId,
            transferReference: body.data.transferReference,
          }),
        );
      } catch (cause: unknown) {
        next(cause);
      }
    },
  );

  return router;
}
