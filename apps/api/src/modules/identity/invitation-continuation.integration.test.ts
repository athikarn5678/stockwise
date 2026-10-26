import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createApp } from "../../app.ts";
import { loadApiEnvironment } from "../../environment.ts";
import { loadTestDatabaseEnvironment } from "../../test/database-environment.ts";
import {
  createTestPrismaClient,
  resetTestDatabase,
} from "../../test/database-harness.ts";
import { startApiServer, type RunningApiServer } from "../../server.ts";
import { createAuthenticationRuntime } from "./authentication-runtime.ts";
import { createRecordingEmailProvider } from "./email-provider.ts";
import { createPrismaMembershipAccessRepository } from "./membership-access-repository.ts";
import { createMembershipAccessService } from "./membership-access-service.ts";
import {
  hashOneTimeToken,
  secureOneTimeTokenProvider,
} from "./one-time-token.ts";
import { hashPassword } from "./password-hasher.ts";
import { SESSION_COOKIE_NAME } from "./session-cookie.ts";
import {
  encryptInvitationContinuation,
  hashContinuationSessionCredential,
} from "./invitation-continuation-cookie.ts";

const database = loadTestDatabaseEnvironment();
const environment = loadApiEnvironment({
  DATABASE_URL: database.TEST_DATABASE_URL,
  STOCKWISE_RUNTIME_ENV: "test",
  STOCKWISE_API_PORT: "3103",
  STOCKWISE_PUBLIC_WEB_ORIGIN: "http://localhost:3000",
  STOCKWISE_EMAIL_PROVIDER: "non_delivery",
  STOCKWISE_ANALYTICS_CURSOR_HMAC_KEY: randomBytes(32).toString("base64url"),
  STOCKWISE_VERIFICATION_OTP_KEY: randomBytes(32).toString("base64url"),
  STOCKWISE_VERIFICATION_OTP_KEY_ID: "1",
  STOCKWISE_VERIFICATION_PROOF_KEY: randomBytes(32).toString("base64url"),
  STOCKWISE_VERIFICATION_PROOF_KEY_ID: "2",
  STOCKWISE_INVITATION_CONTINUATION_KEY: randomBytes(32).toString("base64url"),
});
const prisma = createTestPrismaClient(database);
const origin = environment.STOCKWISE_PUBLIC_WEB_ORIGIN;
const password = "continuation integration password";
const responseErrorSchema = z.object({ error: z.object({ code: z.string() }) });
let drain: (() => Promise<void>) | undefined;
let server: RunningApiServer | undefined;

function flowId(): string {
  return randomBytes(32).toString("base64url");
}

function cookieValue(cookies: string[], name: string): string {
  const cookie = cookies.find((value) => value.startsWith(`${name}=`));
  if (cookie === undefined) throw new Error(`Expected ${name} cookie.`);
  const separator = cookie.indexOf("=");
  return cookie.slice(separator + 1).split(";", 1)[0]!;
}

async function post(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Origin: origin,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function invite(email: string) {
  const owner = await prisma.user.create({
    data: {
      displayName: "Invitation owner",
      email: `owner-${randomBytes(8).toString("hex")}@example.test`,
      emailVerifiedAt: new Date(),
      passwordHash: await hashPassword(password),
    },
  });
  const organization = await prisma.organization.create({
    data: { name: `Continuation ${randomBytes(6).toString("hex")}` },
  });
  const branch = await prisma.branch.create({
    data: {
      code: "INVITED",
      name: "Invited branch",
      organizationId: organization.id,
    },
  });
  await prisma.organizationMembership.create({
    data: { organizationId: organization.id, role: "OWNER", userId: owner.id },
  });
  const mail = createRecordingEmailProvider();
  const service = createMembershipAccessService({
    emailProvider: mail,
    publicWebOrigin: origin,
    repository: createPrismaMembershipAccessRepository(prisma),
    tokenProvider: secureOneTimeTokenProvider,
  });
  const outcome = await service.createInvitation({
    actorUserId: owner.id,
    organizationId: organization.id,
    invitation: { branchIds: [branch.id], email, role: "CASHIER" },
  });
  if (outcome.kind !== "success")
    throw new Error(`Invitation setup failed: ${outcome.kind}`);
  const url = new URL(mail.messages[0]!.url);
  const token = url.searchParams.get("token");
  if (token === null) throw new Error("Issued invitation token missing.");
  return { owner, organization, branch, token, service, mail };
}

async function user(email: string) {
  return prisma.user.create({
    data: {
      displayName: "Invitee",
      email,
      emailVerifiedAt: new Date(),
      passwordHash: await hashPassword(password),
    },
  });
}

async function startApi() {
  const startedRuntime = createAuthenticationRuntime({
    environment,
    prisma,
    emailProvider: { async send() {} },
    onDeliveryFailure() {},
  });
  drain = startedRuntime.drain;
  server = await startApiServer(
    createApp({
      apiRouter: startedRuntime.router,
      logger: { info() {}, error() {} },
    }),
    { host: "127.0.0.1", port: 0 },
  );
  return `http://${server.address.host}:${server.address.port}/api/v1`;
}

async function login(
  base: string,
  email: string,
  flow?: string,
  cookie?: string,
) {
  return post(
    `${base}/auth/login`,
    { email, password },
    {
      ...(flow === undefined ? {} : { "X-Stockwise-Invitation-Flow": flow }),
      ...(cookie === undefined ? {} : { cookie }),
    },
  );
}

describe("encrypted invitation continuation API with PostgreSQL", () => {
  beforeEach(async () => {
    await resetTestDatabase(database);
  });
  afterEach(async () => {
    await server?.stop();
    server = undefined;
    await drain?.();
    drain = undefined;
  });

  afterAll(async () => {
    await server?.stop();
    await drain?.();
    drain = undefined;
    await resetTestDatabase(database);
    await prisma.$disconnect();
  });

  it("captures anonymously, binds only on verified login, resumes, explicitly accepts, and permits same-user replay", async () => {
    const email = `invitee-${randomBytes(8).toString("hex")}@example.test`;
    const { token, organization } = await invite(email);
    await user(email);
    const base = await startApi();
    const flow = flowId();
    const captured = await post(
      `${base}/invitations/continuations`,
      { token },
      { "X-Stockwise-Invitation-Flow": flow },
    );
    expect(captured.status).toBe(200);
    const capturePayload: unknown = await captured.json();
    expect(JSON.stringify(capturePayload).includes(token)).toBe(false);
    const captureBody = z
      .object({ data: z.object({ expiresAt: z.string().datetime() }) })
      .parse(capturePayload);
    const captureExpiry = Date.parse(captureBody.data.expiresAt);
    expect(captureExpiry).toBeGreaterThan(Date.now());
    expect(captureExpiry).toBeLessThanOrEqual(Date.now() + 30 * 60_000);
    const setCookie = captured.headers
      .getSetCookie()
      .find((value) => value.startsWith("__Host-stockwise_invitation_slot_"))!;
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("Expires=");
    expect(Number(setCookie.match(/Max-Age=(\d+)/)?.[1])).toBeGreaterThan(0);
    expect(Number(setCookie.match(/Max-Age=(\d+)/)?.[1])).toBeLessThanOrEqual(
      30 * 60,
    );
    const encryptedCookie = cookieValue(
      captured.headers.getSetCookie(),
      "__Host-stockwise_invitation_slot_0",
    );
    const loginResponse = await login(
      base,
      email,
      flow,
      `__Host-stockwise_invitation_slot_0=${encryptedCookie}`,
    );
    expect(loginResponse.status).toBe(200);
    const loginCookies = loginResponse.headers.getSetCookie();
    const session = cookieValue(loginCookies, SESSION_COOKIE_NAME);
    const rebound = cookieValue(
      loginCookies,
      "__Host-stockwise_invitation_slot_0",
    );
    expect(rebound).not.toBe(encryptedCookie);
    const selectedCookie = `__Host-stockwise_invitation_slot_0=${rebound}`;
    const resume = await post(
      `${base}/invitations/continuations/resume`,
      {},
      {
        cookie: `${SESSION_COOKIE_NAME}=%${session.charCodeAt(0).toString(16)}${session.slice(1)}; ${selectedCookie}`,
        "X-Stockwise-Invitation-Flow": flow,
      },
    );
    expect(resume.status).toBe(200);
    expect(await resume.json()).toMatchObject({ data: { status: "ready" } });
    const expiredFlow = flowId();
    const expiredAt = Date.now() - 1;
    const expiredEnvelope = encryptInvitationContinuation({
      continuation: {
        flowId: expiredFlow,
        token,
        sessionDigest: hashContinuationSessionCredential(session),
        issuedAt: expiredAt - 30 * 60_000,
        expiresAt: expiredAt,
      },
      flowId: expiredFlow,
      slot: 0,
      key: Buffer.from(
        environment.STOCKWISE_INVITATION_CONTINUATION_KEY!,
        "base64url",
      ),
      origin,
    });
    const expiredResume = await post(
      `${base}/invitations/continuations/resume`,
      {},
      {
        cookie: `${SESSION_COOKIE_NAME}=${session}; __Host-stockwise_invitation_slot_0=${expiredEnvelope}`,
        "X-Stockwise-Invitation-Flow": expiredFlow,
      },
    );
    expect(expiredResume.status).toBe(400);
    expect(
      responseErrorSchema.parse(await expiredResume.json()).error.code,
    ).toBe("INVALID_INVITATION_CONTINUATION");
    const accepted = await post(
      `${base}/invitations/continuations/accept`,
      {},
      {
        cookie: `${SESSION_COOKIE_NAME}=${session}; ${selectedCookie}`,
        "X-Stockwise-Invitation-Flow": flow,
      },
    );
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({
      data: {
        membership: { organization: { id: organization.id } },
        replayed: false,
      },
    });
    expect(
      accepted.headers
        .getSetCookie()
        .some((value) => value.includes("Max-Age=0")),
    ).toBe(true);
    const replay = await post(
      `${base}/invitations/continuations/accept`,
      {},
      {
        cookie: `${SESSION_COOKIE_NAME}=${session}; __Host-stockwise_invitation_slot_0=${rebound}`,
        "X-Stockwise-Invitation-Flow": flow,
      },
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ data: { replayed: true } });
  });

  it("rejects foreign flow, wrong email, session mismatch, malformed bodies, origin and header failures", async () => {
    const invitedEmail = `right-${randomBytes(8).toString("hex")}@example.test`;
    const wrongEmail = `wrong-${randomBytes(8).toString("hex")}@example.test`;
    const { token } = await invite(invitedEmail);
    await user(invitedEmail);
    await user(wrongEmail);
    const base = await startApi();
    const flow = flowId();
    const capture = await post(
      `${base}/invitations/continuations`,
      { token },
      { "X-Stockwise-Invitation-Flow": flow },
    );
    expect(capture.status).toBe(200);
    const unauthenticated = await post(
      `${base}/invitations/continuations/resume`,
      {},
      { "X-Stockwise-Invitation-Flow": flow },
    );
    expect(unauthenticated.status).toBe(401);
    const unknownSession = await post(
      `${base}/invitations/continuations/resume`,
      {},
      {
        cookie: `${SESSION_COOKIE_NAME}=${randomBytes(32).toString("base64url")}`,
        "X-Stockwise-Invitation-Flow": flow,
      },
    );
    expect(unknownSession.status).toBe(401);
    const cookie = cookieValue(
      capture.headers.getSetCookie(),
      "__Host-stockwise_invitation_slot_0",
    );
    const mismatchFlow = flowId();
    const mismatchCapture = await post(
      `${base}/invitations/continuations`,
      { token },
      { "X-Stockwise-Invitation-Flow": mismatchFlow },
    );
    const mismatchCookie = cookieValue(
      mismatchCapture.headers.getSetCookie(),
      "__Host-stockwise_invitation_slot_0",
    );
    const firstSessionLogin = await login(
      base,
      invitedEmail,
      mismatchFlow,
      `__Host-stockwise_invitation_slot_0=${mismatchCookie}`,
    );
    const firstSession = cookieValue(
      firstSessionLogin.headers.getSetCookie(),
      SESSION_COOKIE_NAME,
    );
    const reboundMismatchCookie = cookieValue(
      firstSessionLogin.headers.getSetCookie(),
      "__Host-stockwise_invitation_slot_0",
    );
    const secondSessionLogin = await login(base, invitedEmail);
    const secondSession = cookieValue(
      secondSessionLogin.headers.getSetCookie(),
      SESSION_COOKIE_NAME,
    );
    const mismatch = await post(
      `${base}/invitations/continuations/resume`,
      {},
      {
        cookie: `${SESSION_COOKIE_NAME}=${secondSession}; __Host-stockwise_invitation_slot_0=${reboundMismatchCookie}`,
        "X-Stockwise-Invitation-Flow": mismatchFlow,
      },
    );
    expect(mismatch.status).toBe(400);
    expect(responseErrorSchema.parse(await mismatch.json()).error.code).toBe(
      "INVALID_INVITATION_CONTINUATION",
    );
    expect(firstSession).not.toBe(secondSession);
    const wrongLogin = await login(
      base,
      wrongEmail,
      flow,
      `__Host-stockwise_invitation_slot_0=${cookie}`,
    );
    const wrongSession = cookieValue(
      wrongLogin.headers.getSetCookie(),
      SESSION_COOKIE_NAME,
    );
    const reboundCookie = cookieValue(
      wrongLogin.headers.getSetCookie(),
      "__Host-stockwise_invitation_slot_0",
    );
    const protectedCookie = `${SESSION_COOKIE_NAME}=${wrongSession}; __Host-stockwise_invitation_slot_0=${reboundCookie}`;
    const wrongResume = await post(
      `${base}/invitations/continuations/resume`,
      {},
      {
        cookie: protectedCookie,
        "X-Stockwise-Invitation-Flow": flow,
      },
    );
    expect(wrongResume.status).toBe(400);
    expect(responseErrorSchema.parse(await wrongResume.json()).error.code).toBe(
      "INVALID_INVITATION",
    );

    const otherFlow = flowId();
    const foreign = await post(
      `${base}/invitations/continuations/resume`,
      {},
      {
        cookie: protectedCookie,
        "X-Stockwise-Invitation-Flow": otherFlow,
      },
    );
    expect(foreign.status).toBe(400);

    const missingOrigin = await fetch(
      `${base}/invitations/continuations/cancel`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );
    expect(missingOrigin.status).toBe(403);
    expect(missingOrigin.headers.get("cache-control")).toBe("no-store");
    const crossSite = await fetch(`${base}/invitations/continuations/cancel`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Origin: origin,
        "Sec-Fetch-Site": "cross-site",
      },
      body: "{}",
    });
    expect(crossSite.status).toBe(403);
    const nonJson = await fetch(`${base}/invitations/continuations/cancel`, {
      method: "POST",
      headers: { Origin: origin, "content-type": "text/plain" },
      body: "{}",
    });
    expect(nonJson.status).toBe(403);
    const extraBody = await post(
      `${base}/invitations/continuations/resume`,
      { token },
      {
        cookie: protectedCookie,
        "X-Stockwise-Invitation-Flow": flow,
      },
    );
    expect(extraBody.status).toBe(400);
    const invalidFlow = await post(
      `${base}/invitations/continuations/cancel`,
      {},
      {
        "X-Stockwise-Invitation-Flow": `${flow.slice(0, -1)}!`,
      },
    );
    expect(invalidFlow.status).toBe(400);
    const duplicateFlowHeader = await post(
      `${base}/invitations/continuations/cancel`,
      {},
      { "X-Stockwise-Invitation-Flow": `${flow}, ${flow}` },
    );
    expect(duplicateFlowHeader.status).toBe(400);
    const duplicateCookie = await post(
      `${base}/invitations/continuations/resume`,
      {},
      {
        cookie: `${protectedCookie}; __Host-stockwise_invitation_slot_0=duplicate`,
        "X-Stockwise-Invitation-Flow": flow,
      },
    );
    expect(duplicateCookie.status).toBe(400);
  });

  it("keeps a 48-request stale-snapshot burst inside the four fixed cookie names", async () => {
    const email = `burst-${randomBytes(8).toString("hex")}@example.test`;
    const { token } = await invite(email);
    await user(email);
    const base = await startApi();
    const responses = await Promise.all(
      Array.from({ length: 48 }, async () =>
        post(
          `${base}/invitations/continuations`,
          { token },
          { "X-Stockwise-Invitation-Flow": flowId() },
        ),
      ),
    );
    expect(responses.every((response) => response.status === 200)).toBe(true);
    const issued = responses.map((response) =>
      response.headers
        .getSetCookie()
        .find((cookie) =>
          cookie.startsWith("__Host-stockwise_invitation_slot_"),
        ),
    );
    expect(issued.every((cookie) => cookie !== undefined)).toBe(true);
    expect(
      new Set(issued.map((cookie) => cookie!.split("=", 1)[0])).size,
    ).toBeLessThanOrEqual(4);
    expect(
      issued.every((cookie) => {
        const value = cookie!.slice(cookie!.indexOf("=") + 1).split(";", 1)[0]!;
        return Buffer.byteLength(value, "ascii") <= 512;
      }),
    ).toBe(true);
    expect((await login(base, email)).status).toBe(200);
  });

  it("enforces four distinct flow cookies, clears on cancellation/logout, and refuses expired or revoked tokens", async () => {
    const email = `capacity-${randomBytes(8).toString("hex")}@example.test`;
    const { token, service, owner, organization, branch, mail } =
      await invite(email);
    await user(email);
    const base = await startApi();
    const flows = [flowId(), flowId(), flowId(), flowId(), flowId()];
    const cookies: string[] = [];
    let presentedCookieHeader = "";
    for (const [index, flow] of flows.slice(0, 4).entries()) {
      const capture = await post(
        `${base}/invitations/continuations`,
        { token },
        {
          "X-Stockwise-Invitation-Flow": flow,
          ...(presentedCookieHeader ? { cookie: presentedCookieHeader } : {}),
        },
      );
      expect(capture.status).toBe(200);
      const cookie = cookieValue(
        capture.headers.getSetCookie(),
        `__Host-stockwise_invitation_slot_${index}`,
      );
      cookies.push(cookie);
      presentedCookieHeader = [
        presentedCookieHeader,
        `__Host-stockwise_invitation_slot_${index}=${cookie}`,
      ]
        .filter(Boolean)
        .join("; ");
    }
    expect(new Set(cookies).size).toBe(4);
    const cancellation = await post(
      `${base}/invitations/continuations/cancel`,
      {},
      { "X-Stockwise-Invitation-Flow": flows[4]! },
    );
    expect(cancellation.status).toBe(204);
    expect(cancellation.headers.getSetCookie()).toHaveLength(0);
    const fifth = await post(
      `${base}/invitations/continuations`,
      { token },
      {
        "X-Stockwise-Invitation-Flow": flows[4]!,
        cookie: flows
          .slice(0, 4)
          .map(
            (_, index) =>
              `__Host-stockwise_invitation_slot_${index}=${cookies[index]}`,
          )
          .join("; "),
      },
    );
    expect(fifth.status).toBe(409);
    expect(responseErrorSchema.parse(await fifth.json()).error.code).toBe(
      "INVITATION_CONTINUATION_LIMIT",
    );

    const presentedFlows = flows
      .slice(0, 4)
      .map(
        (_, index) =>
          `__Host-stockwise_invitation_slot_${index}=${cookies[index]}`,
      )
      .join("; ");
    const loginResponse = await login(base, email, flows[0], presentedFlows);
    const loginCookies = loginResponse.headers.getSetCookie();
    const session = cookieValue(loginCookies, SESSION_COOKIE_NAME);
    const logout = await post(
      `${base}/auth/logout`,
      {},
      {
        cookie: `${SESSION_COOKIE_NAME}=${session}; ${presentedFlows}`,
      },
    );
    expect(logout.status).toBe(204);
    for (const [index] of flows.slice(0, 4).entries()) {
      expect(
        logout.headers
          .getSetCookie()
          .some(
            (value) =>
              value.startsWith(`__Host-stockwise_invitation_slot_${index}=`) &&
              value.includes("Max-Age=0"),
          ),
      ).toBe(true);
    }
    const secondLoginResponse = await login(
      base,
      email,
      flows[1],
      presentedFlows,
    );
    const secondSession = cookieValue(
      secondLoginResponse.headers.getSetCookie(),
      SESSION_COOKIE_NAME,
    );
    const logoutAll = await post(
      `${base}/auth/logout-all`,
      {},
      {
        cookie: `${SESSION_COOKIE_NAME}=${secondSession}; ${presentedFlows}`,
      },
    );
    expect(logoutAll.status).toBe(204);
    expect(
      logoutAll.headers
        .getSetCookie()
        .filter(
          (value) =>
            value.includes("__Host-stockwise_invitation_") &&
            value.includes("Max-Age=0"),
        ),
    ).toHaveLength(4);

    const reissued = await service.createInvitation({
      actorUserId: owner.id,
      organizationId: organization.id,
      invitation: { branchIds: [branch.id], email, role: "CASHIER" },
    });
    expect(reissued.kind).toBe("success");
    const reissuedToken = new URL(mail.messages.at(-1)!.url).searchParams.get(
      "token",
    )!;
    const replacedCapture = await post(
      `${base}/invitations/continuations`,
      { token },
      { "X-Stockwise-Invitation-Flow": flowId() },
    );
    expect(replacedCapture.status).toBe(400);
    if (reissued.kind !== "success") throw new Error("Reissue fixture failed.");
    expect(
      (
        await service.revokeInvitation({
          actorUserId: owner.id,
          invitationId: reissued.invitationId,
          organizationId: organization.id,
        })
      ).kind,
    ).toBe("success");
    const revokedCapture = await post(
      `${base}/invitations/continuations`,
      { token: reissuedToken },
      { "X-Stockwise-Invitation-Flow": flowId() },
    );
    expect(revokedCapture.status).toBe(400);

    const expiredEmail = `expired-${randomBytes(8).toString("hex")}@example.test`;
    const expiring = await service.createInvitation({
      actorUserId: owner.id,
      organizationId: organization.id,
      invitation: {
        branchIds: [branch.id],
        email: expiredEmail,
        role: "CASHIER",
      },
    });
    expect(expiring.kind).toBe("success");
    const expiredToken = new URL(mail.messages.at(-1)!.url).searchParams.get(
      "token",
    )!;
    const issuedAt = new Date(Date.now() - 8 * 24 * 60 * 60_000);
    await prisma.invitation.update({
      where: { tokenHash: hashOneTimeToken(expiredToken) },
      data: {
        issuedAt,
        expiresAt: new Date(issuedAt.getTime() + 7 * 24 * 60 * 60_000),
      },
    });
    const expiredCapture = await post(
      `${base}/invitations/continuations`,
      { token: expiredToken },
      { "X-Stockwise-Invitation-Flow": flowId() },
    );
    expect(expiredCapture.status).toBe(400);
  });
});
