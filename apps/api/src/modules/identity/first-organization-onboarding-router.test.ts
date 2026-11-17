import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../../app.ts";
import type { ApiLogger } from "../../logger.ts";
import { startApiServer, type RunningApiServer } from "../../server.ts";
import { createSessionAuthenticationMiddleware } from "./authentication-context.ts";
import type { FirstOrganizationOnboardingOutcome } from "./first-organization-onboarding-repository.ts";
import { createFirstOrganizationOnboardingRouter } from "./first-organization-onboarding-router.ts";
import type { FirstOrganizationOnboardingService } from "./first-organization-onboarding-service.ts";

const logger: ApiLogger = { error() {}, info() {} };
const VALID_SESSION_TOKEN = "A".repeat(43);
const TEST_COOKIE_NAME = "stockwise_test_session";
const result = {
  branch: {
    address: null,
    code: "MAIN" as const,
    id: "branch-id",
    name: "Main Branch",
    phone: null,
  },
  nextStep: "app" as const,
  organization: { id: "organization-id", name: "Store" },
  role: "OWNER" as const,
  user: { displayName: "Owner", id: "trusted-user-id", phone: null },
};

describe("first organization onboarding router", () => {
  let runningServer: RunningApiServer | undefined;

  afterEach(async () => {
    await runningServer?.stop();
    runningServer = undefined;
  });

  async function startRouter(
    outcome: FirstOrganizationOnboardingOutcome = {
      kind: "success",
      replayed: false,
      result,
    },
  ) {
    const complete = vi.fn().mockResolvedValue(outcome);
    const authenticationMiddleware = createSessionAuthenticationMiddleware(
      async (request) =>
        request.headers.cookie === `${TEST_COOKIE_NAME}=${VALID_SESSION_TOKEN}`
          ? {
              actor: {
                displayName: null,
                email: "owner@example.com",
                id: "trusted-user-id",
              },
              sessionId: "session-id",
            }
          : null,
    );
    const onboardingService: FirstOrganizationOnboardingService = { complete };
    const apiRouter = createFirstOrganizationOnboardingRouter({
      authenticationMiddleware,
      onboardingService,
      publicWebOrigin: "http://localhost:3000",
    });
    runningServer = await startApiServer(createApp({ apiRouter, logger }), {
      host: "127.0.0.1",
      port: 0,
    });

    return {
      complete,
      url: `http://${runningServer.address.host}:${runningServer.address.port}/api/v1/organizations`,
    };
  }

  function post(
    url: string,
    body: unknown,
    authenticated = true,
    extraHeaders: Record<string, string> = {},
  ) {
    return fetch(url, {
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        ...(authenticated
          ? { cookie: `${TEST_COOKIE_NAME}=${VALID_SESSION_TOKEN}` }
          : {}),
        ...extraHeaders,
      },
      method: "POST",
    });
  }

  it("requires the trusted authenticated context", async () => {
    const { complete, url } = await startRouter();
    const response = await post(
      url,
      {
        branchName: "Main",
        displayName: "Owner",
        organizationName: "Store",
      },
      false,
    );

    expect(response.status).toBe(401);
    expect(complete).not.toHaveBeenCalled();
  });

  it("uses the trusted actor, canonicalizes accepted fields, and returns only the safe result", async () => {
    const { complete, url } = await startRouter();
    const response = await post(
      url,
      {
        branchAddress: "  1 Main Road  ",
        branchName: "  Main  Branch  ",
        branchPhone: "  ",
        displayName: "  Owner  Name  ",
        organizationName: "  Store  Name  ",
        phone: "  +66 1 234 5678  ",
      },
      true,
      {
        "x-branch-id": "forged-branch",
        "x-organization-id": "forged-organization",
        "x-role": "OWNER",
        "x-user-id": "forged-user",
      },
    );
    const body = await response.json();

    expect(complete).toHaveBeenCalledWith("trusted-user-id", {
      branchAddress: "1 Main Road",
      branchName: "Main  Branch",
      branchPhone: null,
      displayName: "Owner  Name",
      organizationName: "Store  Name",
      phone: "+66 1 234 5678",
    });
    expect(response.status).toBe(200);
    expect(body).toEqual({
      data: result,
      meta: { requestId: response.headers.get("x-request-id") },
    });
    expect(JSON.stringify(body)).not.toContain("requestHash");
    expect(JSON.stringify(body)).not.toContain("session-id");
  });

  it("rejects cross-site cookie-authenticated writes", async () => {
    const { complete, url } = await startRouter();
    const response = await post(
      url,
      {
        branchName: "Main",
        displayName: "Owner",
        organizationName: "Store",
      },
      true,
      { origin: "https://attacker.example", "sec-fetch-site": "cross-site" },
    );

    expect(response.status).toBe(403);
    expect(complete).not.toHaveBeenCalled();
  });

  it("rejects client identity, role, branch-code, and other unknown fields", async () => {
    const forbiddenFields = [
      "userId",
      "organizationId",
      "branchId",
      "membershipId",
      "role",
      "branchCode",
      "permissions",
      "onboardingId",
    ];

    for (const field of forbiddenFields) {
      const { complete, url } = await startRouter();
      const response = await post(url, {
        branchName: "Main",
        displayName: "Owner",
        organizationName: "Store",
        [field]: "forged",
      });
      expect(response.status).toBe(400);
      expect(complete).not.toHaveBeenCalled();
      await runningServer?.stop();
      runningServer = undefined;
    }
  });

  it("maps both accepted eligibility conflicts without leaking state", async () => {
    for (const outcome of [
      {
        code: "ALREADY_ONBOARDED",
        kind: "already_onboarded" as const,
      },
      {
        code: "ALREADY_HAS_ORGANIZATION_ACCESS",
        kind: "already_has_organization_access" as const,
      },
    ]) {
      const { url } = await startRouter({ kind: outcome.kind });
      const response = await post(url, {
        branchName: "Main",
        displayName: "Owner",
        organizationName: "Store",
      });
      const body = (await response.json()) as { error: { code: string } };

      expect(response.status).toBe(409);
      expect(body.error.code).toBe(outcome.code);
      await runningServer?.stop();
      runningServer = undefined;
    }
  });
});
