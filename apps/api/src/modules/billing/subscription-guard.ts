import type { Request, RequestHandler, Response } from "express";
import { Router } from "express";
import { z } from "zod";

import { getTrustedAuthenticationContext } from "../identity/authentication-context.ts";
import type { BillingRepository } from "./billing-repository.ts";
import { resolveSubscriptionAccess } from "./subscription-access.ts";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const organizationIdSchema = z.string().uuid();

/**
 * The only organization-scoped mutating routes that stay open while the
 * subscription is EXPIRED (ADR-050): paying, and the on-demand AI analysis
 * (`ai-analysis/runs`, which replaced `ai-insights/analyze`, and its per-language
 * retry). Matched on method and the path after `/organizations/:organizationId`;
 * a `:name` segment matches any single non-empty segment.
 * Everything else under that prefix is blocked: a new route is guarded by
 * default, and `subscription-guard.test.ts` scans every router source so a
 * route outside the prefix must be classified explicitly.
 */
export const SUBSCRIPTION_GUARD_EXEMPT_ROUTES: readonly Readonly<{
  method: "POST";
  path: string;
}>[] = [
  { method: "POST", path: "/billing/checkout" },
  { method: "POST", path: "/billing/confirm" },
  { method: "POST", path: "/ai-analysis/runs" },
  { method: "POST", path: "/ai-analysis/runs/:runId/retry" },
];

function matchesTemplate(template: string, path: string): boolean {
  const expected = template.split("/");
  const actual = path.split("/");
  return (
    expected.length === actual.length &&
    expected.every(
      (segment, index) =>
        (segment.startsWith(":") && actual[index] !== "") ||
        segment === actual[index],
    )
  );
}

function isExempt(method: string, path: string): boolean {
  return SUBSCRIPTION_GUARD_EXEMPT_ROUTES.some(
    (route) => route.method === method && matchesTemplate(route.path, path),
  );
}

function subscriptionRequired(response: Response): void {
  const requestId = response.getHeader("X-Request-Id");
  response.status(402).json({
    error: {
      code: "SUBSCRIPTION_REQUIRED",
      message: "The subscription has expired. Renew the plan to make changes.",
      requestId: typeof requestId === "string" ? requestId : "unavailable",
    },
  });
}

/**
 * One central guard (ADR-050): when the caller's organization is EXPIRED, every
 * mutating `/organizations/:organizationId/...` request answers
 * 402 SUBSCRIPTION_REQUIRED before its route handler (and so any write) runs.
 * Reads are never touched. It authenticates first so an anonymous caller learns
 * nothing, and it is silent for non-members so subscription state never leaks
 * across tenants (the route then answers with its own 403/404).
 */
export function createSubscriptionGuard(input: {
  authenticationMiddleware: RequestHandler;
  now?: () => Date;
  repository: Pick<BillingRepository, "accessFactsForMember">;
}): Router {
  const now = input.now ?? (() => new Date());
  const router = Router();

  router.use(
    "/organizations/:organizationId",
    async (request: Request, response: Response, next) => {
      try {
        if (
          !MUTATING_METHODS.has(request.method) ||
          isExempt(request.method, request.path)
        ) {
          next();
          return;
        }
        const organizationId = organizationIdSchema.safeParse(
          request.params.organizationId,
        );
        if (!organizationId.success) {
          next();
          return;
        }
        // The route authenticates again; a failure here already answered 401.
        let proceeded = false;
        let failure: unknown;
        await Promise.resolve(
          input.authenticationMiddleware(
            request,
            response,
            (error?: unknown) => {
              proceeded = true;
              failure = error;
            },
          ),
        );
        if (failure !== undefined) throw failure;
        if (!proceeded) return;
        const actor = getTrustedAuthenticationContext(response);
        if (actor === null) {
          next();
          return;
        }
        const facts = await input.repository.accessFactsForMember(
          actor.actor.id,
          organizationId.data,
        );
        if (
          facts !== null &&
          resolveSubscriptionAccess({
            now: now(),
            organizationCreatedAt: facts.organizationCreatedAt,
            subscription: facts.subscription,
          }).state === "EXPIRED"
        ) {
          subscriptionRequired(response);
          return;
        }
        next();
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
