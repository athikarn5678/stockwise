import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { Router } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../../app.ts";
import type { ApiLogger } from "../../logger.ts";
import { startApiServer, type RunningApiServer } from "../../server.ts";
import { createSessionAuthenticationMiddleware } from "../identity/authentication-context.ts";
import type { AccessFacts } from "./billing-repository.ts";
import {
  createSubscriptionGuard,
  SUBSCRIPTION_GUARD_EXEMPT_ROUTES,
} from "./subscription-guard.ts";

const SOURCE_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_ORGANIZATION_ID = "10000000-0000-4000-8000-000000000002";
const TOKEN = "A".repeat(43);
const COOKIE = `stockwise_test_session=${TOKEN}`;
const NOW = new Date("2026-11-18T00:00:00.000Z");
const logger: ApiLogger = { error() {}, info() {} };

type Route = Readonly<{ file: string; method: string; path: string }>;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory())
      return name === "generated" ? [] : sourceFiles(path);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : [];
  });
}

/** Every mutating route registered by any API source file, as written in code. */
function mutatingRoutes(): Route[] {
  const routes: Route[] = [];
  const registration =
    /\b(?:router|app|apiRouter)\.(post|put|patch|delete|all)\(\s*(\[[^\]]*\]|"[^"]*"|`[^`]*`|[A-Za-z_.]+)/g;
  for (const file of sourceFiles(SOURCE_ROOT)) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(registration)) {
      const [, method, argument] = match;
      const paths = [...argument!.matchAll(/["'`]([^"'`]*)["'`]/g)].map(
        (quoted) => quoted[1]!,
      );
      // A non-literal path cannot be classified: fail loudly instead of skipping.
      if (paths.length === 0)
        paths.push(
          `<non-literal ${argument} in ${relative(SOURCE_ROOT, file)}>`,
        );
      for (const path of paths)
        routes.push({
          file: relative(SOURCE_ROOT, file),
          method: method!.toUpperCase(),
          path,
        });
    }
  }
  return routes;
}

const ORGANIZATION_PREFIX = "/organizations/:organizationId/";
const isOrganizationScoped = (route: Route) =>
  route.path.startsWith(ORGANIZATION_PREFIX) ||
  route.path === "/organizations/:organizationId";

/**
 * Mutating routes outside `/organizations/:organizationId` are not touched by
 * the guard. Each is deliberately classified here (owner brief: auth, own
 * profile, onboarding, invitation acceptance stay open). A route that is in
 * neither this list nor under the guarded prefix fails the test below, so a new
 * route cannot silently bypass the subscription guard.
 */
const UNSCOPED_EXEMPT_PATHS = new Set([
  "/auth/forgot-password",
  "/auth/login",
  "/auth/logout",
  "/auth/logout-all",
  "/auth/register",
  "/auth/reset-password",
  "/auth/verification-password-proof",
  "/auth/verification-resend",
  "/auth/verify-email",
  "/auth/verify-email-code",
  "/invitations/accept",
  "/invitations/continuations",
  "/invitations/continuations/accept",
  "/invitations/continuations/cancel",
  "/invitations/continuations/resume",
  "/me/profile",
  "/organizations",
]);

function concretePath(path: string): string {
  return path
    .replace(":organizationId", ORGANIZATION_ID)
    .replace(/:[A-Za-z]+/g, "20000000-0000-4000-8000-000000000009");
}

describe("subscription guard route table", () => {
  const routes = mutatingRoutes();

  it("finds the real mutating routes (the scan itself is not empty)", () => {
    expect(routes.length).toBeGreaterThan(30);
    expect(routes.map((route) => route.path)).toContain(
      "/organizations/:organizationId/ai-insights/analyze",
    );
    expect(routes.map((route) => route.path)).toContain(
      "/organizations/:organizationId/branches/:branchId/sales",
    );
  });

  it("classifies every mutating route: guarded prefix, or an explicit exemption", () => {
    const unclassified = routes.filter(
      (route) =>
        !isOrganizationScoped(route) && !UNSCOPED_EXEMPT_PATHS.has(route.path),
    );
    expect(
      unclassified,
      "classify each new mutating route: put it under /organizations/:organizationId/ (guarded) or add it to UNSCOPED_EXEMPT_PATHS with the owner's reason",
    ).toEqual([]);
    // The exemption list cannot rot: every entry still exists in the code.
    const registered = new Set(routes.map((route) => route.path));
    expect(
      [...UNSCOPED_EXEMPT_PATHS].filter((path) => !registered.has(path)),
    ).toEqual([]);
  });

  it("exempts exactly the billing checkout/confirm and AI analyze routes under the prefix", () => {
    const exempt = new Set(
      SUBSCRIPTION_GUARD_EXEMPT_ROUTES.map(
        (route) =>
          `${route.method} ${ORGANIZATION_PREFIX}${route.path.slice(1)}`,
      ),
    );
    expect(exempt).toEqual(
      new Set([
        `POST ${ORGANIZATION_PREFIX}billing/checkout`,
        `POST ${ORGANIZATION_PREFIX}billing/confirm`,
        `POST ${ORGANIZATION_PREFIX}ai-insights/analyze`,
      ]),
    );
    const registered = new Set(
      routes.map((route) => `${route.method} ${route.path}`),
    );
    for (const entry of exempt) expect(registered.has(entry)).toBe(true);
  });

  describe("with the real route table mounted behind the guard", () => {
    let server: RunningApiServer | undefined;
    afterEach(async () => {
      await server?.stop();
      server = undefined;
    });

    async function start(facts: Record<string, AccessFacts | null>) {
      const authenticationMiddleware = createSessionAuthenticationMiddleware(
        async (request) =>
          request.headers.cookie === COOKIE
            ? {
                actor: {
                  displayName: "Owner",
                  email: "owner@example.com",
                  id: "trusted-user-id",
                },
                sessionId: "session-id",
              }
            : null,
      );
      const repository = {
        accessFactsForMember: vi.fn(
          async (_actor: string, organizationId: string) =>
            facts[organizationId] ?? null,
        ),
      };
      const writes: string[] = [];
      const apiRouter = Router();
      apiRouter.use(
        createSubscriptionGuard({
          authenticationMiddleware,
          now: () => NOW,
          repository,
        }),
      );
      // Stand-in handlers for every discovered route: reaching one is a write.
      const downstream = Router();
      for (const route of routes.filter(isOrganizationScoped)) {
        const method = route.method.toLowerCase() as "post";
        downstream[method === ("all" as string) ? "post" : method](
          route.path,
          (request, response) => {
            writes.push(`${request.method} ${request.path}`);
            response.status(204).end();
          },
        );
      }
      downstream.get(`${ORGANIZATION_PREFIX}anything`, (_request, response) => {
        response.status(200).json({ ok: true });
      });
      apiRouter.use(downstream);
      server = await startApiServer(createApp({ apiRouter, logger }), {
        host: "127.0.0.1",
        port: 0,
      });
      return {
        repository,
        url: `http://127.0.0.1:${server.address.port}/api/v1`,
        writes,
      };
    }

    const request = (
      url: string,
      method: string,
      headers: Record<string, string> = { cookie: COOKIE },
    ) =>
      fetch(url, {
        body: method === "GET" ? null : "{}",
        headers: { "content-type": "application/json", ...headers },
        method,
      });

    const expired: AccessFacts = {
      organizationCreatedAt: new Date("2026-01-01T00:00:00.000Z"),
      subscription: null,
    };
    const trial: AccessFacts = {
      organizationCreatedAt: new Date("2026-11-10T00:00:00.000Z"),
      subscription: null,
    };
    const active: AccessFacts = {
      organizationCreatedAt: new Date("2026-01-01T00:00:00.000Z"),
      subscription: { interval: "MONTH", plan: "STARTER", status: "ACTIVE" },
    };
    const explicitlyExpired: AccessFacts = {
      organizationCreatedAt: new Date("2026-11-17T00:00:00.000Z"),
      subscription: { interval: "MONTH", plan: "STARTER", status: "EXPIRED" },
    };

    it("answers 402 SUBSCRIPTION_REQUIRED for every guarded mutating route before any handler runs", async () => {
      for (const facts of [expired, explicitlyExpired]) {
        const { url, writes } = await start({ [ORGANIZATION_ID]: facts });
        const exempt = new Set(
          SUBSCRIPTION_GUARD_EXEMPT_ROUTES.map(
            (route) =>
              `${route.method} ${ORGANIZATION_PREFIX}${route.path.slice(1)}`,
          ),
        );
        const guarded = routes
          .filter(isOrganizationScoped)
          .filter((route) => !exempt.has(`${route.method} ${route.path}`));
        expect(guarded.length).toBeGreaterThan(20);
        for (const route of guarded) {
          const method = route.method === "ALL" ? "POST" : route.method;
          const response = await request(
            `${url}${concretePath(route.path)}`,
            method,
          );
          expect(response.status, `${method} ${route.path}`).toBe(402);
          expect(await response.json()).toMatchObject({
            error: { code: "SUBSCRIPTION_REQUIRED" },
          });
        }
        expect(writes).toEqual([]);
        await server?.stop();
        server = undefined;
      }
    });

    it("lets the exempt routes and every read through while EXPIRED", async () => {
      const { url, writes } = await start({ [ORGANIZATION_ID]: expired });
      for (const route of SUBSCRIPTION_GUARD_EXEMPT_ROUTES) {
        const response = await request(
          `${url}${concretePath(`${ORGANIZATION_PREFIX}${route.path.slice(1)}`)}`,
          route.method,
        );
        expect(response.status).toBe(204);
      }
      expect(writes).toHaveLength(SUBSCRIPTION_GUARD_EXEMPT_ROUTES.length);
      const read = await request(
        `${url}${ORGANIZATION_PREFIX.replace(":organizationId", ORGANIZATION_ID)}anything`,
        "GET",
      );
      expect(read.status).toBe(200);
    });

    it("does not block TRIAL or ACTIVE organizations", async () => {
      for (const facts of [trial, active]) {
        const { url, writes } = await start({ [ORGANIZATION_ID]: facts });
        const response = await request(
          `${url}/organizations/${ORGANIZATION_ID}/branches/20000000-0000-4000-8000-000000000009/sales`,
          "POST",
        );
        expect(response.status).toBe(204);
        expect(writes).toHaveLength(1);
        await server?.stop();
        server = undefined;
      }
    });

    it("stays silent for non-members and other organizations so state never leaks", async () => {
      const { url, writes } = await start({
        [ORGANIZATION_ID]: expired,
        [OTHER_ORGANIZATION_ID]: null,
      });
      // The caller is not a member of the other organization: the route answers.
      const response = await request(
        `${url}/organizations/${OTHER_ORGANIZATION_ID}/categories`,
        "POST",
      );
      expect(response.status).toBe(204);
      expect(writes).toHaveLength(1);
    });

    it("answers 401 to an anonymous caller without consulting the repository", async () => {
      const { repository, url, writes } = await start({
        [ORGANIZATION_ID]: expired,
      });
      const response = await request(
        `${url}/organizations/${ORGANIZATION_ID}/categories`,
        "POST",
        {},
      );
      expect(response.status).toBe(401);
      expect(repository.accessFactsForMember).not.toHaveBeenCalled();
      expect(writes).toEqual([]);
    });
  });
});
