import { Router, type RequestHandler, type Response } from "express";
import { z } from "zod";

import { getTrustedAuthenticationContext } from "../identity/authentication-context.ts";
import { billingPlanSchema } from "./billing-plans.ts";
import type { BillingService } from "./billing-service.ts";
import { CHECKOUT_SESSION_ID } from "./stripe-client.ts";

const paramsSchema = z.object({ organizationId: z.string().uuid() }).strict();
const checkoutBodySchema = z.object({ plan: billingPlanSchema }).strict();
const confirmBodySchema = z
  .object({ sessionId: z.string().regex(CHECKOUT_SESSION_ID) })
  .strict();

function error(
  response: Response,
  status: number,
  code: string,
  message: string,
): void {
  response.status(status).json({
    error: {
      code,
      message,
      requestId: response.getHeader("X-Request-Id") ?? "unavailable",
    },
  });
}

const forbidden = (response: Response) =>
  error(response, 403, "FORBIDDEN", "The operation is not permitted.");
const invalid = (response: Response) =>
  error(response, 400, "VALIDATION_ERROR", "The billing request is invalid.");
const unavailable = (response: Response) =>
  error(response, 404, "NOT_FOUND", "The resource is unavailable.");
const providerFailed = (response: Response) =>
  error(
    response,
    502,
    "BILLING_PROVIDER_FAILED",
    "The payment provider is unavailable.",
  );

export function createBillingRouter(input: {
  authenticationMiddleware: RequestHandler;
  service: BillingService;
}): Router {
  const router = Router();

  router.get(
    "/organizations/:organizationId/billing",
    input.authenticationMiddleware,
    async (request, response, next) => {
      try {
        const params = paramsSchema.safeParse(request.params);
        if (!params.success) return invalid(response);
        const actor = getTrustedAuthenticationContext(response);
        if (actor === null)
          return error(
            response,
            401,
            "AUTHENTICATION_REQUIRED",
            "Authentication is required.",
          );
        const result = await input.service.read(
          actor.actor.id,
          params.data.organizationId,
        );
        if (result.kind === "forbidden") return forbidden(response);
        response.setHeader("Cache-Control", "no-store");
        response.status(200).json({
          data: {
            canManage: result.canManage,
            enabled: result.enabled,
            subscription: result.subscription,
          },
        });
      } catch (cause) {
        next(cause);
      }
    },
  );

  router.post(
    "/organizations/:organizationId/billing/checkout",
    input.authenticationMiddleware,
    async (request, response, next) => {
      try {
        const params = paramsSchema.safeParse(request.params);
        const body = checkoutBodySchema.safeParse(request.body);
        if (!params.success || !body.success) return invalid(response);
        const actor = getTrustedAuthenticationContext(response);
        if (actor === null)
          return error(
            response,
            401,
            "AUTHENTICATION_REQUIRED",
            "Authentication is required.",
          );
        const result = await input.service.checkout({
          actorUserId: actor.actor.id,
          organizationId: params.data.organizationId,
          plan: body.data.plan,
        });
        if (result.kind === "disabled") return unavailable(response);
        if (result.kind === "forbidden") return forbidden(response);
        if (result.kind === "conflict")
          return error(
            response,
            409,
            "SUBSCRIPTION_EXISTS",
            "The organization already has a subscription.",
          );
        if (result.kind !== "ok") return providerFailed(response);
        response.setHeader("Cache-Control", "no-store");
        response.status(200).json({ data: { url: result.url } });
      } catch (cause) {
        next(cause);
      }
    },
  );

  router.post(
    "/organizations/:organizationId/billing/confirm",
    input.authenticationMiddleware,
    async (request, response, next) => {
      try {
        const params = paramsSchema.safeParse(request.params);
        const body = confirmBodySchema.safeParse(request.body);
        if (!params.success || !body.success) return invalid(response);
        const actor = getTrustedAuthenticationContext(response);
        if (actor === null)
          return error(
            response,
            401,
            "AUTHENTICATION_REQUIRED",
            "Authentication is required.",
          );
        const result = await input.service.confirm({
          actorUserId: actor.actor.id,
          organizationId: params.data.organizationId,
          sessionId: body.data.sessionId,
        });
        if (result.kind === "disabled") return unavailable(response);
        if (result.kind === "forbidden") return forbidden(response);
        if (result.kind === "conflict")
          return error(
            response,
            409,
            "SUBSCRIPTION_EXISTS",
            "The organization already has a different subscription.",
          );
        if (result.kind === "not_complete")
          return error(
            response,
            409,
            "CHECKOUT_NOT_COMPLETE",
            "The checkout has not been completed and paid.",
          );
        if (result.kind !== "ok") return providerFailed(response);
        response.setHeader("Cache-Control", "no-store");
        response
          .status(200)
          .json({ data: { subscription: result.subscription } });
      } catch (cause) {
        next(cause);
      }
    },
  );

  return router;
}
