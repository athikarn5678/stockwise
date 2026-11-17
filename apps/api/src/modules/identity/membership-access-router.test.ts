import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../../app.ts";
import type { ApiLogger } from "../../logger.ts";
import { startApiServer, type RunningApiServer } from "../../server.ts";
import { createSessionAuthenticationMiddleware } from "./authentication-context.ts";
import { createMembershipAccessRouter } from "./membership-access-router.ts";
import type {
  SafeInvitation,
  SafeMembership,
} from "./membership-access-repository.ts";
import type { MembershipAccessService } from "./membership-access-service.ts";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const MEMBERSHIP_ID = "20000000-0000-4000-8000-000000000001";
const INVITATION_ID = "30000000-0000-4000-8000-000000000001";
const BRANCH_ID = "40000000-0000-4000-8000-000000000001";
const USER_ID = "50000000-0000-4000-8000-000000000001";
const TOKEN = "A".repeat(43);
const TEST_COOKIE_NAME = "stockwise_test_session";
const UPDATED_AT = "2026-08-24T18:00:00.000Z";
const logger: ApiLogger = { error() {}, info() {} };
const membership: SafeMembership = {
  branchAssignments: [
    {
      branch: { code: "MAIN", id: BRANCH_ID, name: "Main", status: "ACTIVE" },
      status: "ACTIVE",
    },
  ],
  createdAt: UPDATED_AT,
  id: MEMBERSHIP_ID,
  organization: { id: ORGANIZATION_ID, name: "Store" },
  role: "CASHIER",
  status: "ACTIVE",
  updatedAt: UPDATED_AT,
  user: { displayName: "Member", email: "member@example.com", id: USER_ID },
};
const invitation: SafeInvitation = {
  branchScopes: [],
  createdAt: UPDATED_AT,
  expiresAt: "2026-08-31T18:00:00.000Z",
  id: INVITATION_ID,
  intendedRole: "ADMIN",
  invitedEmail: "invitee@example.com",
  state: "PENDING",
};

describe("membership access router", () => {
  let server: RunningApiServer | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  async function start(overrides: Partial<MembershipAccessService> = {}) {
    const authenticationMiddleware = createSessionAuthenticationMiddleware(
      async (request) =>
        request.headers.cookie === `${TEST_COOKIE_NAME}=${TOKEN}`
          ? {
              actor: {
                displayName: "Owner",
                email: "owner@example.com",
                id: USER_ID,
              },
              sessionId: "session-id",
            }
          : null,
    );
    const service: MembershipAccessService = {
      acceptInvitation: vi
        .fn()
        .mockResolvedValue({ kind: "success", membership, replayed: false }),
      createInvitation: vi.fn().mockResolvedValue({
        invitation,
        invitationId: invitation.id,
        kind: "success",
        recipient: invitation.invitedEmail,
      }),
      deactivateMembership: vi
        .fn()
        .mockResolvedValue({ kind: "success", membership }),
      listInvitations: vi.fn().mockResolvedValue({
        kind: "success",
        page: { items: [invitation], nextCursor: "next" },
      }),
      listMemberships: vi.fn().mockResolvedValue({
        kind: "success",
        page: { items: [membership], nextCursor: "next" },
      }),
      reactivateMembership: vi
        .fn()
        .mockResolvedValue({ kind: "success", membership }),
      replaceMembership: vi
        .fn()
        .mockResolvedValue({ kind: "success", membership }),
      revokeInvitation: vi
        .fn()
        .mockResolvedValue({ kind: "success", invitation }),
      ...overrides,
    };
    const router = createMembershipAccessRouter({
      authenticationMiddleware,
      membershipAccessService: service,
      publicWebOrigin: "http://localhost:3000",
    });
    server = await startApiServer(createApp({ apiRouter: router, logger }), {
      host: "127.0.0.1",
      port: 0,
    });
    return {
      service,
      url: `http://${server.address.host}:${server.address.port}/api/v1`,
    };
  }

  function request(url: string, init: RequestInit = {}) {
    return fetch(url, {
      ...init,
      headers: {
        cookie: `${TEST_COOKIE_NAME}=${TOKEN}`,
        ...(init.body === undefined
          ? {}
          : { "content-type": "application/json" }),
        ...init.headers,
      },
    });
  }

  it("canonicalizes a strict invitation and derives the actor from authentication", async () => {
    const { service, url } = await start();
    const response = await request(
      `${url}/organizations/${ORGANIZATION_ID}/invitations`,
      {
        body: JSON.stringify({
          email: "  INVITEE@EXAMPLE.COM ",
          role: "ADMIN",
        }),
        headers: { "x-role": "OWNER", "x-user-id": "forged" },
        method: "POST",
      },
    );
    expect(response.status).toBe(201);
    expect(service.createInvitation).toHaveBeenCalledWith({
      actorUserId: USER_ID,
      invitation: {
        branchIds: [],
        email: "invitee@example.com",
        role: "ADMIN",
      },
      organizationId: ORGANIZATION_ID,
    });
    expect(JSON.stringify(await response.json())).not.toContain("token");
  });

  it("passes the verified authenticated email into acceptance and rejects malformed tokens generically", async () => {
    const { service, url } = await start();
    const accepted = await request(`${url}/invitations/accept`, {
      body: JSON.stringify({ token: TOKEN }),
      method: "POST",
    });
    expect(accepted.status).toBe(200);
    expect(service.acceptInvitation).toHaveBeenCalledWith({
      actorEmail: "owner@example.com",
      actorUserId: USER_ID,
      rawToken: TOKEN,
    });

    const malformed = await request(`${url}/invitations/accept`, {
      body: JSON.stringify({ token: "short" }),
      method: "POST",
    });
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toMatchObject({
      error: { code: "INVALID_INVITATION" },
    });
  });

  it("requires exact mutation shapes and protects cookie writes from cross-site requests", async () => {
    const { service, url } = await start();
    const unknown = await request(
      `${url}/organizations/${ORGANIZATION_ID}/members/${MEMBERSHIP_ID}`,
      {
        body: JSON.stringify({
          branchIds: [],
          expectedUpdatedAt: UPDATED_AT,
          role: "ADMIN",
          userId: "forged",
        }),
        method: "PATCH",
      },
    );
    expect(unknown.status).toBe(400);
    expect(service.replaceMembership).not.toHaveBeenCalled();

    const crossSite = await request(
      `${url}/organizations/${ORGANIZATION_ID}/members/${MEMBERSHIP_ID}/deactivate`,
      {
        body: JSON.stringify({ expectedUpdatedAt: UPDATED_AT }),
        headers: {
          origin: "https://attacker.example",
          "sec-fetch-site": "cross-site",
        },
        method: "POST",
      },
    );
    expect(crossSite.status).toBe(403);
    expect(service.deactivateMembership).not.toHaveBeenCalled();
  });

  it("returns opaque pagination metadata for management lists", async () => {
    const { service, url } = await start();
    const response = await request(
      `${url}/organizations/${ORGANIZATION_ID}/members?includeInactive=true&limit=25`,
    );
    expect(response.status).toBe(200);
    expect(service.listMemberships).toHaveBeenCalledWith({
      actorUserId: USER_ID,
      includeInactive: true,
      limit: 25,
      organizationId: ORGANIZATION_ID,
    });
    await expect(response.json()).resolves.toMatchObject({
      data: [membership],
      meta: { nextCursor: "next", requestId: expect.any(String) },
    });
  });

  it.each([
    [
      "MEMBERSHIP_ALREADY_EXISTS",
      409,
      "createInvitation",
      { kind: "membership_exists" },
    ],
    [
      "INVITATION_DELIVERY_FAILED",
      503,
      "createInvitation",
      { kind: "delivery_failed" },
    ],
    ["INVITATION_FINALIZED", 409, "revokeInvitation", { kind: "finalized" }],
    ["MEMBERSHIP_STALE", 409, "replaceMembership", { kind: "stale" }],
    [
      "LAST_ACTIVE_OWNER",
      409,
      "replaceMembership",
      { kind: "last_active_owner" },
    ],
  ] as const)(
    "maps %s without internal details",
    async (code, status, method, outcome) => {
      const { url } = await start({
        [method]: vi.fn().mockResolvedValue(outcome),
      });
      const target =
        method === "createInvitation"
          ? `${url}/organizations/${ORGANIZATION_ID}/invitations`
          : method === "revokeInvitation"
            ? `${url}/organizations/${ORGANIZATION_ID}/invitations/${INVITATION_ID}/revoke`
            : `${url}/organizations/${ORGANIZATION_ID}/members/${MEMBERSHIP_ID}`;
      const body =
        method === "createInvitation"
          ? { email: "new@example.com", role: "ADMIN" }
          : method === "replaceMembership"
            ? { branchIds: [], expectedUpdatedAt: UPDATED_AT, role: "ADMIN" }
            : undefined;
      const response = await request(target, {
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        method: method === "replaceMembership" ? "PATCH" : "POST",
      });
      expect(response.status).toBe(status);
      const payload = JSON.stringify(await response.json());
      expect(payload).toContain(code);
      expect(payload).not.toMatch(/Prisma|PostgreSQL|tokenHash|session-id/);
    },
  );
});
