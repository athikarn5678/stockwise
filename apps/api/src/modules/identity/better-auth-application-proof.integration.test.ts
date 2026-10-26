import { createHash, randomBytes, randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../app.ts";
import { loadApiEnvironment } from "../../environment.ts";
import { PrismaClient } from "../../generated/prisma/client.ts";
import { loadTestDatabaseEnvironment } from "../../test/database-environment.ts";
import { createBetterAuthApplicationRuntime } from "./better-auth-application-runtime.ts";
import {
  createRecordingEmailProvider,
  type IdentityEmailMessage,
} from "./email-provider.ts";
import {
  createVerificationSecurity,
  verificationSecurityConfiguration,
} from "./verification-security.ts";
import { hashPassword, verifyPassword } from "./password-hasher.ts";
import { createPendingRegistrationRepository } from "./pending-registration-repository.ts";

const db = loadTestDatabaseEnvironment();
const prisma = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: db.TEST_DATABASE_URL,
    idleTimeoutMillis: 0,
  }),
});
const origin = "https://web.example.test";
const password = "  verified proof password é🔒  ";
const environment = loadApiEnvironment({
  DATABASE_URL: db.TEST_DATABASE_URL,
  STOCKWISE_RUNTIME_ENV: "test",
  STOCKWISE_API_PORT: "3103",
  STOCKWISE_PUBLIC_WEB_ORIGIN: origin,
  STOCKWISE_BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
  STOCKWISE_INVITATION_CONTINUATION_KEY: randomBytes(32).toString("base64url"),
  STOCKWISE_ANALYTICS_CURSOR_HMAC_KEY: randomBytes(32).toString("base64url"),
  STOCKWISE_VERIFICATION_OTP_KEY: randomBytes(32).toString("base64url"),
  STOCKWISE_VERIFICATION_OTP_KEY_ID: "1",
  STOCKWISE_VERIFICATION_PROOF_KEY: randomBytes(32).toString("base64url"),
  STOCKWISE_VERIFICATION_PROOF_KEY_ID: "1",
});
const mail = createRecordingEmailProvider();
const attemptedMessages: IdentityEmailMessage[] = [];
let failNextDelivery = false;
const emailProvider = {
  async send(message: IdentityEmailMessage, signal?: AbortSignal) {
    attemptedMessages.push(message);
    if (failNextDelivery) {
      failNextDelivery = false;
      throw new Error("test provider failure");
    }
    await mail.send(message, signal);
  },
};
const runtime = createBetterAuthApplicationRuntime({
  environment,
  prisma,
  emailProvider,
  onDeliveryFailure() {},
});
const app = createApp({
  apiRouter: runtime.router,
  logger: { error() {}, info() {} },
});
const verificationSecurity = createVerificationSecurity(
  verificationSecurityConfiguration(environment),
);
const pendingRepository = createPendingRegistrationRepository(prisma);
const server = createServer(app);
let baseUrl: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("HTTP test server unavailable");
  baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
});
afterAll(async () => {
  await runtime.drain();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await prisma.$disconnect();
});

async function post(path: string, body: unknown, cookie?: string) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

// Runtime delivery completes on response finish; observe its completion instead
// of draining and permanently stopping the runtime between requests.
async function waitForDelivery(email: string) {
  for (let tries = 0; tries < 500; tries += 1) {
    const message = mail.messages.find(
      (candidate) =>
        candidate.kind === "verification" && candidate.recipient === email,
    );
    if (message?.kind === "verification") return message;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Verification delivery did not complete");
}

async function waitForRevocation(email: string) {
  for (let tries = 0; tries < 500; tries += 1) {
    const current = await prisma.pendingRegistration.findUnique({
      where: { email },
      select: { revokedAt: true },
    });
    if (current?.revokedAt) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Delivery failure was not compensated");
}

describe("Native application runtime verification-password-proof HTTP regressions", () => {
  it("accepts verified Native credentials only as phantom proof, without a session or delivery", async () => {
    const email = `${randomUUID()}@example.test`;
    const registration = await post("/auth/register", { email, password });
    expect(registration.status).toBe(202);
    const registrationBody = (await registration.json()) as {
      data: { verification: { challengeId: string } };
    };
    const challengeId = registrationBody.data.verification.challengeId;
    const verification = await waitForDelivery(email);
    const completion = await post(
      "/auth/verify-email-code",
      {
        email,
        challengeId,
        code: verification.code,
      },
      registration.headers.get("set-cookie")?.split(";")[0],
    );
    expect(completion.status).toBe(200);
    const badProof = await post("/auth/verification-password-proof", {
      email,
      password: `${password}wrong`,
    });
    expect(badProof.status).toBe(401);
    expect(
      (
        await post("/auth/verification-password-proof", {
          email: `${randomUUID()}@example.test`,
          password,
        })
      ).status,
    ).toBe(401);
    expect(
      await prisma.betterAuthSession.count({
        where: { user: { email }, stockwisePurpose: "APPLICATION" },
      }),
    ).toBe(0);
    const verifiedUser = await prisma.user.findUniqueOrThrow({
      where: { email },
    });
    await prisma.user.update({
      where: { id: verifiedUser.id },
      data: { status: "DISABLED", disabledAt: new Date() },
    });
    expect(
      (await post("/auth/verification-password-proof", { email, password }))
        .status,
    ).toBe(401);
    await prisma.user.update({
      where: { id: verifiedUser.id },
      data: { status: "ACTIVE", disabledAt: null },
    });
    const nativeAccount = await prisma.betterAuthAccount.findUniqueOrThrow({
      where: {
        providerId_accountId: {
          providerId: "credential",
          accountId: verifiedUser.id,
        },
      },
    });
    await prisma.user.update({
      where: { id: verifiedUser.id },
      data: { nativeRegistrationCompletedAt: null },
    });
    expect(
      (await post("/auth/verification-password-proof", { email, password }))
        .status,
    ).toBe(401);
    await prisma.user.update({
      where: { id: verifiedUser.id },
      data: {
        nativeRegistrationCompletedAt:
          verifiedUser.nativeRegistrationCompletedAt,
      },
    });
    await prisma.betterAuthAccount.update({
      where: { id: nativeAccount.id },
      data: { password: null },
    });
    expect(
      (await post("/auth/verification-password-proof", { email, password }))
        .status,
    ).toBe(401);
    await prisma.betterAuthAccount.update({
      where: { id: nativeAccount.id },
      data: { password: nativeAccount.password },
    });
    const changedHash = await hashPassword("different Native password");
    const mutations = [
      {
        apply: () =>
          prisma.user.update({
            where: { id: verifiedUser.id },
            data: { status: "DISABLED", disabledAt: new Date() },
          }),
        restore: () =>
          prisma.user.update({
            where: { id: verifiedUser.id },
            data: { status: "ACTIVE", disabledAt: null },
          }),
      },
      {
        apply: () =>
          prisma.user.update({
            where: { id: verifiedUser.id },
            data: { credentialVersion: { increment: 1 } },
          }),
        restore: () =>
          prisma.user.update({
            where: { id: verifiedUser.id },
            data: { credentialVersion: verifiedUser.credentialVersion },
          }),
      },
      {
        apply: () =>
          prisma.user.update({
            where: { id: verifiedUser.id },
            data: { passwordChangedAt: new Date(Date.now() + 1_000) },
          }),
        restore: () =>
          prisma.user.update({
            where: { id: verifiedUser.id },
            data: { passwordChangedAt: verifiedUser.passwordChangedAt },
          }),
      },
      {
        apply: () =>
          prisma.user.update({
            where: { id: verifiedUser.id },
            data: {
              nativeRegistrationCompletedAt: new Date(Date.now() + 1_000),
            },
          }),
        restore: () =>
          prisma.user.update({
            where: { id: verifiedUser.id },
            data: {
              nativeRegistrationCompletedAt:
                verifiedUser.nativeRegistrationCompletedAt,
            },
          }),
      },
      {
        apply: () =>
          prisma.betterAuthAccount.update({
            where: { id: nativeAccount.id },
            data: { password: changedHash },
          }),
        restore: () =>
          prisma.betterAuthAccount.update({
            where: { id: nativeAccount.id },
            data: { password: nativeAccount.password },
          }),
      },
    ];
    for (const mutation of mutations) {
      const snapshot = await pendingRepository.credentialSnapshot(email);
      if (!snapshot || snapshot.kind !== "verified")
        throw new Error("Expected Native credential snapshot");
      const attempt = await pendingRepository.reserveCredential(email);
      if (!attempt.allowed) throw new Error("Expected credential reservation");
      expect(await verifyPassword(snapshot.passwordHash, password)).toBe(true);
      await mutation.apply();
      expect(
        await pendingRepository.finishCredential(
          email,
          attempt.attemptId,
          snapshot,
          verificationSecurity,
        ),
      ).toEqual({ ineligible: true });
      await mutation.restore();
    }

    const beforeMessages = mail.messages.length;
    for (let attempt = 0; attempt < 7; attempt += 1) {
      const proof = await post("/auth/verification-password-proof", {
        email,
        password,
      });
      expect(proof.status).toBe(202);
      const cookie = proof.headers.get("set-cookie");
      expect(cookie).toMatch(/stockwise_verification_proof=/i);
      expect(cookie).toMatch(/HttpOnly/i);
      expect(
        verificationSecurity.readProof(cookie?.split(";")[0], new Date())
          ?.usable,
      ).toBe(false);
      expect(mail.messages).toHaveLength(beforeMessages);
      const payload = (await proof.json()) as { data: { status: string } };
      expect(payload.data.status).toBe("accepted");
    }

    expect(
      await prisma.betterAuthSession.count({
        where: { user: { email }, stockwisePurpose: "APPLICATION" },
      }),
    ).toBe(0);
    const login = await post("/auth/login", { email, password });
    expect(login.status).toBe(200);
    expect(login.headers.get("set-cookie")).toMatch(
      /stockwise_native\.session_token=/i,
    );
    const sessions = await prisma.betterAuthSession.count({
      where: { user: { email }, stockwisePurpose: "APPLICATION" },
    });
    expect(sessions).toBe(1);
    expect(mail.messages).toHaveLength(beforeMessages);
  });

  it("keeps a failed-delivery pending password usable from another browser and recovers only by resend", async () => {
    const email = `${randomUUID()}@example.test`;
    failNextDelivery = true;
    const registration = await post("/auth/register", { email, password });
    expect(registration.status).toBe(202);
    await waitForRevocation(email);
    const initial = attemptedMessages.find(
      (message) =>
        message.kind === "verification" && message.recipient === email,
    );
    if (!initial || initial.kind !== "verification")
      throw new Error("Failed verification attempt missing");

    const before = await prisma.pendingRegistration.findUniqueOrThrow({
      where: { email },
      select: {
        challengeId: true,
        expiresAt: true,
        passwordHash: true,
        credentialVersion: true,
      },
    });
    if (!before.challengeId)
      throw new Error("Failed delivery challenge missing");
    const mailCount = mail.messages.length;
    const pendingLogin = await post("/auth/login", { email, password });
    expect(pendingLogin.status).toBe(202);
    const loginBody = (await pendingLogin.json()) as {
      data: { status: string; verification: { challengeId: string | null } };
    };
    expect(loginBody.data.status).toBe("verification_required");
    expect(loginBody.data.verification.challengeId).toBeNull();
    expect(pendingLogin.headers.get("set-cookie")).not.toMatch(
      /stockwise_native\.session_token=/i,
    );
    const afterLogin = await prisma.pendingRegistration.findUniqueOrThrow({
      where: { email },
      select: {
        challengeId: true,
        expiresAt: true,
        passwordHash: true,
        credentialVersion: true,
      },
    });
    expect(afterLogin).toEqual(before);
    expect(mail.messages).toHaveLength(mailCount);
    expect(
      await prisma.betterAuthSession.count({
        where: { user: { email }, stockwisePurpose: "APPLICATION" },
      }),
    ).toBe(0);

    const loginCookie = pendingLogin.headers.get("set-cookie")?.split(";")[0];
    const oldCode = await post(
      "/auth/verify-email-code",
      {
        email,
        challengeId: before.challengeId,
        code: initial.code,
      },
      loginCookie,
    );
    expect(oldCode.status).toBe(400);
    expect(
      ((await oldCode.json()) as { error: { code: string } }).error.code,
    ).toBe("INVALID_VERIFICATION_CODE");
    const oldToken = new URL(initial.url).searchParams.get("token");
    if (!oldToken) throw new Error("Verification link token missing");
    expect(
      (await post("/auth/verify-email", { token: oldToken }, loginCookie))
        .status,
    ).toBe(400);

    const resend = await post("/auth/verification-resend", { email });
    expect(resend.status).toBe(202);
    const resent = await waitForDelivery(email);
    if (!resent || resent.kind !== "verification")
      throw new Error("Resend recovery delivery missing");
    const afterResend = await prisma.pendingRegistration.findUniqueOrThrow({
      where: { email },
      select: {
        challengeId: true,
        expiresAt: true,
        passwordHash: true,
        credentialVersion: true,
      },
    });
    expect(afterResend.expiresAt).toEqual(before.expiresAt);
    expect(afterResend.passwordHash).toBe(before.passwordHash);
    expect(afterResend.credentialVersion).toBe(before.credentialVersion);
    expect(afterResend.challengeId).not.toBe(before.challengeId);
    expect(mail.messages).toHaveLength(mailCount + 1);
    const resendBody = (await resend.json()) as {
      data: { verification: { challengeId: string } };
    };
    expect(resendBody.data.verification.challengeId).not.toBe(
      loginBody.data.verification.challengeId,
    );
    const recovered = await post(
      "/auth/verify-email-code",
      {
        email,
        challengeId: resendBody.data.verification.challengeId,
        code: resent.code,
      },
      loginCookie,
    );
    expect(recovered.status).toBe(200);
  });

  it("retains a suppressed pending password until explicit resend recovers delivery", async () => {
    const email = `${randomUUID()}@example.test`;
    for (let index = 0; index < 3; index += 1)
      expect((await post("/auth/verification-resend", { email })).status).toBe(
        202,
      );

    const messagesBefore = mail.messages.length;
    expect((await post("/auth/register", { email, password })).status).toBe(
      202,
    );
    expect(mail.messages).toHaveLength(messagesBefore);

    const pending = await prisma.pendingRegistration.findUniqueOrThrow({
      where: { email },
      select: {
        challengeId: true,
        expiresAt: true,
        passwordHash: true,
        credentialVersion: true,
        revokedAt: true,
      },
    });
    if (!pending.challengeId)
      throw new Error("Suppressed registration challenge missing");
    expect(pending.revokedAt).not.toBeNull();
    const login = await post("/auth/login", { email, password });
    expect(login.status).toBe(202);
    const loginBody = (await login.json()) as {
      data: { verification: { challengeId: string | null } };
    };
    expect(loginBody.data.verification.challengeId).toBeNull();
    expect(login.headers.get("set-cookie")).not.toMatch(
      /stockwise_native\.session_token=/i,
    );
    const mailCount = mail.messages.length;
    expect(mailCount).toBe(messagesBefore);
    const afterLogin = await prisma.pendingRegistration.findUniqueOrThrow({
      where: { email },
      select: {
        challengeId: true,
        expiresAt: true,
        passwordHash: true,
        credentialVersion: true,
        revokedAt: true,
      },
    });
    expect(afterLogin).toEqual(pending);
    expect(
      await prisma.betterAuthSession.count({
        where: { user: { email }, stockwisePurpose: "APPLICATION" },
      }),
    ).toBe(0);
    const oldCode = await post(
      "/auth/verify-email-code",
      {
        email,
        challengeId: pending.challengeId,
        code: "000000",
      },
      login.headers.get("set-cookie")?.split(";")[0],
    );
    expect(oldCode.status).toBe(400);
    expect(
      ((await oldCode.json()) as { error: { code: string } }).error.code,
    ).toBe("INVALID_VERIFICATION_CODE");

    const key = createHash("sha256").update(email).digest("hex");
    await prisma.pendingRegistrationQuota.update({
      where: { key_purpose: { key, purpose: "delivery" } },
      data: { windowAt: new Date(Date.now() - 900_001) },
    });
    const resend = await post("/auth/verification-resend", { email });
    expect(resend.status).toBe(202);
    const verification = await waitForDelivery(email);
    const afterResend = await prisma.pendingRegistration.findUniqueOrThrow({
      where: { email },
      select: {
        challengeId: true,
        expiresAt: true,
        passwordHash: true,
        credentialVersion: true,
        revokedAt: true,
      },
    });
    expect(afterResend.expiresAt).toEqual(pending.expiresAt);
    expect(afterResend.passwordHash).toBe(pending.passwordHash);
    expect(afterResend.credentialVersion).toBe(pending.credentialVersion);
    expect(afterResend.revokedAt).toBeNull();
    expect(afterResend.challengeId).not.toBe(pending.challengeId);
    expect(mail.messages).toHaveLength(mailCount + 1);
    const resendBody = (await resend.json()) as {
      data: { verification: { challengeId: string } };
    };
    expect(resendBody.data.verification.challengeId).not.toBe(
      loginBody.data.verification.challengeId,
    );
    expect(
      (
        await post(
          "/auth/verify-email-code",
          {
            email,
            challengeId: resendBody.data.verification.challengeId,
            code: verification.code,
          },
          login.headers.get("set-cookie")?.split(";")[0],
        )
      ).status,
    ).toBe(200);
  });

  it("rejects expired and replaced pending proof generations", async () => {
    const expiredEmail = `${randomUUID()}@example.test`;
    expect(
      (await post("/auth/register", { email: expiredEmail, password })).status,
    ).toBe(202);
    await waitForDelivery(expiredEmail);
    const expiredAt = new Date(Date.now() - 1);
    await prisma.pendingRegistration.update({
      where: { email: expiredEmail },
      data: {
        issuedAt: new Date(expiredAt.getTime() - 600_000),
        expiresAt: expiredAt,
      },
    });
    expect(
      (
        await post("/auth/verification-password-proof", {
          email: expiredEmail,
          password,
        })
      ).status,
    ).toBe(401);

    const email = `${randomUUID()}@example.test`;
    const replacementPassword = "replacement Native password é🔒";
    expect((await post("/auth/register", { email, password })).status).toBe(
      202,
    );
    const original = await waitForDelivery(email);
    const before = await prisma.pendingRegistration.findUniqueOrThrow({
      where: { email },
    });
    expect(
      (
        await post("/auth/register", {
          email,
          password: replacementPassword,
        })
      ).status,
    ).toBe(202);
    const after = await prisma.pendingRegistration.findUniqueOrThrow({
      where: { email },
    });
    expect(after.challengeId).not.toBe(before.challengeId);
    expect(
      (await post("/auth/verification-password-proof", { email, password }))
        .status,
    ).toBe(401);
    expect(
      (
        await post("/auth/verify-email-code", {
          email,
          challengeId: before.challengeId!,
          code: original.code,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post("/auth/verification-password-proof", {
          email,
          password: replacementPassword,
        })
      ).status,
    ).toBe(202);
  });
});
