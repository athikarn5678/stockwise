import { createHash, randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadTestDatabaseEnvironment } from "../../test/database-environment.ts";
import { createApp } from "../../app.ts";
import { PrismaClient } from "../../generated/prisma/client.ts";
import { startApiServer, type RunningApiServer } from "../../server.ts";
import type { ApiLogger } from "../../logger.ts";
import type { PendingRegistrationService } from "./pending-registration-service.ts";
import { hashPassword } from "./password-hasher.ts";
import { createPendingRegistrationRepository } from "./pending-registration-repository.ts";
import { createPendingRegistrationRouter } from "./pending-registration-router.ts";
import { createPendingRegistrationService } from "./pending-registration-service.ts";
import { createRecordingEmailProvider } from "./email-provider.ts";
import { createVerificationDelivery } from "./verification-delivery.ts";
import { createVerificationSecurity } from "./verification-security.ts";

const environment = loadTestDatabaseEnvironment();
const prisma = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: environment.TEST_DATABASE_URL,
    idleTimeoutMillis: 0,
  }),
});
const repository = createPendingRegistrationRepository(prisma);
const security = createVerificationSecurity({
  publicWebOrigin: "https://web.example.test",
  otpKey: Buffer.alloc(32, 31),
  otpKeyId: 1,
  proofKey: Buffer.alloc(32, 32),
  proofKeyId: 1,
});
const PASSWORD = "  pending password é🔒  ";
let hash: string;
let server: RunningApiServer | undefined;
const logger: ApiLogger = { error() {}, info() {} };
beforeAll(async () => {
  await prisma.$queryRaw`SELECT 1`;
  hash = await hashPassword(PASSWORD);
});
afterAll(async () => {
  await server?.stop();
  await prisma.$disconnect();
});
function email() {
  return `${randomUUID()}@example.test`;
}
async function exhaustDeliveryQuota(address: string) {
  for (let attempt = 0; attempt < 3; attempt++)
    expect((await repository.admit(address, "delivery")).allowed).toBe(true);
  expect((await repository.admit(address, "delivery")).allowed).toBe(false);
}
function createService(passwordHash = hash) {
  const provider = createRecordingEmailProvider();
  const delivery = createVerificationDelivery({
    emailProvider: provider,
    publicWebOrigin: "https://web.example.test",
    repository,
  });
  const service = createPendingRegistrationService({
    delivery,
    passwordHasher: { hash: async () => passwordHash },
    passwordVerifier: { verify: async () => false },
    repository,
    security,
  });
  return { delivery, provider, service };
}
async function postRegistration(
  service: PendingRegistrationService,
  address: string,
) {
  const router = createPendingRegistrationRouter({
    pendingRegistrationService: service,
    publicWebOrigin: "http://localhost:3000",
  });
  server = await startApiServer(createApp({ apiRouter: router, logger }), {
    host: "127.0.0.1",
    port: 0,
  });
  try {
    return await fetch(
      `http://${server.address.host}:${server.address.port}/api/v1/auth/register`,
      {
        method: "POST",
        body: JSON.stringify({ email: address, password: PASSWORD }),
        headers: {
          "content-type": "application/json",
          Origin: "http://localhost:3000",
        },
      },
    );
  } finally {
    await server.stop();
    server = undefined;
  }
}

const registered = (
  address: string,
  passwordHash: string,
  suppressed: boolean,
) =>
  repository.register({ email: address, passwordHash, security, suppressed });

describe("isolated D3 PostgreSQL delivery-suppressed registration", () => {
  it.each(["delivery quota", "dispatcher capacity"] as const)(
    "returns the generic accepted proof response and stages initial credentials when %s is exhausted",
    async (cause) => {
      const address = email();
      const fixture = createService();
      const reservations =
        cause === "dispatcher capacity"
          ? Array.from({ length: 32 }, () => fixture.delivery.reserve())
          : [];
      try {
        expect(reservations.every((reservation) => reservation !== null)).toBe(
          true,
        );
        if (cause === "delivery quota") await exhaustDeliveryQuota(address);
        const response = await postRegistration(fixture.service, address);
        const bodyText = await response.text();
        const body = JSON.parse(bodyText);
        expect(response.status).toBe(202);
        expect(body).toMatchObject({
          data: {
            nextStep: "verify_email",
            status: "accepted",
            verification: { challengeId: expect.any(String) },
          },
        });
        expect(bodyText).not.toMatch(
          /session|auth_token|token|proof|password|hash/i,
        );
        const setCookie = response.headers.get("set-cookie") ?? "";
        expect(setCookie).toContain("__Host-stockwise_verification_proof=");
        expect(setCookie).toContain("HttpOnly");
        expect(setCookie).toContain("Secure");
        expect(setCookie).toContain("SameSite=Strict");
        expect(setCookie).not.toMatch(/session|auth_token/i);
        const proofCookie = setCookie.match(
          /(__Host-stockwise_verification_proof=[^;]+)/,
        )?.[1];
        expect(proofCookie).toBeDefined();
        const proof = security.readProof(proofCookie, new Date());
        expect(proof).toMatchObject({
          usable: true,
          credentialVersion: 1n,
        });
        expect(fixture.provider.messages).toHaveLength(0);
        const pending = await prisma.pendingRegistration.findUniqueOrThrow({
          where: { email: address },
        });
        expect(
          await prisma.user.findUnique({ where: { email: address } }),
        ).toBeNull();
        expect(
          await prisma.betterAuthAccount.count({
            where: { accountId: pending.id },
          }),
        ).toBe(0);
        expect(
          await prisma.betterAuthSession.count({
            where: { userId: pending.id },
          }),
        ).toBe(0);
        expect(proof?.subject).toBe(pending.id);
        expect(pending).toMatchObject({
          passwordHash: hash,
          credentialVersion: 1n,
          revokedAt: expect.any(Date),
        });
        expect(body.data.verification.challengeId).toBe(pending.challengeId);
        expect(pending.expiresAt.getTime() - pending.issuedAt.getTime()).toBe(
          600_000,
        );
        for (const reservation of reservations) reservation?.release();
        if (cause === "delivery quota")
          await prisma.pendingRegistrationQuota.update({
            where: {
              key_purpose: {
                key: createHash("sha256").update(address).digest("hex"),
                purpose: "delivery",
              },
            },
            data: { windowAt: new Date(Date.now() - 901_000) },
          });
        const recovered = await fixture.service.resend(address);
        if (recovered.outcome !== "accepted" || recovered.delivery === null)
          throw new Error("Expected first suppressed registration recovery.");
        recovered.delivery.finish();
        await fixture.delivery.drain();
        expect(fixture.provider.messages).toHaveLength(1);
        const message = fixture.provider.messages[0];
        if (!message || message.kind !== "verification")
          throw new Error("Expected verification delivery.");
        const current = await prisma.pendingRegistration.findUniqueOrThrow({
          where: { email: address },
        });
        expect(current.passwordHash).toBe(pending.passwordHash);
        expect(current.credentialVersion).toBe(pending.credentialVersion);
        expect(current.expiresAt).toEqual(pending.expiresAt);
        expect(current.issuedAt).toEqual(pending.issuedAt);
        expect(
          await repository.completeCode({
            email: address,
            challengeId: recovered.challengeId,
            code: message.code,
            cookieHeader: proofCookie,
            security,
          }),
        ).toBe("verified");
      } finally {
        for (const reservation of reservations) reservation?.release();
      }
    },
  );

  it("keeps a suppressed duplicate generation unchanged when a different password hash is accepted, then recovers without renewing it", async () => {
    const address = email();
    const replacementHash = await hashPassword("different accepted password");
    const original = await registered(address, hash, true);
    expect(original).not.toBeNull();
    expect(
      await repository.completeCode({
        email: address,
        challengeId: original!.challenge.id,
        code: original!.code,
        cookieHeader: `__Host-stockwise_verification_proof=${original!.proof}`,
        security,
      }),
    ).toBe("invalid");
    const before = await prisma.pendingRegistration.findUniqueOrThrow({
      where: { email: address },
    });
    expect(before.revokedAt).not.toBeNull();
    expect(original!.challenge.id).toBe(before.challengeId);
    await exhaustDeliveryQuota(address);
    const fixture = createService(replacementHash);
    const response = await postRegistration(fixture.service, address);
    const setCookie = response.headers.get("set-cookie") ?? "";
    const duplicateProof = setCookie.match(
      /(__Host-stockwise_verification_proof=[^;]+)/,
    )?.[1];
    expect(response.status).toBe(202);
    expect(security.readProof(duplicateProof, new Date())?.usable).toBe(false);
    expect(fixture.provider.messages).toHaveLength(0);
    const unchanged = await prisma.pendingRegistration.findUniqueOrThrow({
      where: { email: address },
    });
    expect(unchanged).toEqual(before);

    await prisma.pendingRegistrationQuota.update({
      where: {
        key_purpose: {
          key: createHash("sha256").update(address).digest("hex"),
          purpose: "delivery",
        },
      },
      data: { windowAt: new Date(Date.now() - 901_000) },
    });
    const recovered = await fixture.service.resend(address);
    expect(recovered).toMatchObject({ outcome: "accepted" });
    if (recovered.outcome !== "accepted" || recovered.delivery === null)
      throw new Error("Expected resend delivery.");
    recovered.delivery.finish();
    await fixture.delivery.drain();
    expect(fixture.provider.messages).toHaveLength(1);
    const message = fixture.provider.messages[0];
    if (!message || message.kind !== "verification")
      throw new Error("Expected a verification delivery.");
    const afterResend = await prisma.pendingRegistration.findUniqueOrThrow({
      where: { email: address },
    });
    expect(afterResend.passwordHash).toBe(before.passwordHash);
    expect(afterResend.credentialVersion).toBe(before.credentialVersion);
    expect(afterResend.expiresAt).toEqual(before.expiresAt);
    expect(afterResend.issuedAt).toEqual(before.issuedAt);
    expect(
      await repository.completeCode({
        email: address,
        challengeId: recovered.challengeId,
        code: message.code,
        cookieHeader: `__Host-stockwise_verification_proof=${original!.proof}`,
        security,
      }),
    ).toBe("verified");
  });

  it("does not revive an expired pending generation after delivery suppression", async () => {
    const address = email();
    const original = await registered(address, hash, true);
    expect(original).not.toBeNull();
    const before = await prisma.pendingRegistration.findUniqueOrThrow({
      where: { email: address },
    });
    const expiredIssuedAt = new Date(Date.now() - 601_000);
    const expiredAt = new Date(expiredIssuedAt.getTime() + 600_000);
    await prisma.pendingRegistration.update({
      where: { email: address },
      data: { issuedAt: expiredIssuedAt, expiresAt: expiredAt },
    });
    const expired = await prisma.pendingRegistration.findUniqueOrThrow({
      where: { email: address },
    });
    await exhaustDeliveryQuota(address);
    const fixture = createService();
    const response = await postRegistration(fixture.service, address);
    expect(response.status).toBe(202);
    expect(await repository.resend(address, security)).toBeNull();
    expect(
      await prisma.pendingRegistration.findUniqueOrThrow({
        where: { email: address },
      }),
    ).toEqual(expired);
    expect(expired.passwordHash).toBe(before.passwordHash);
    expect(fixture.provider.messages).toHaveLength(0);
  });

  it.each([
    { name: "unverified", status: "ACTIVE" as const, verified: false },
    { name: "verified", status: "ACTIVE" as const, verified: true },
    { name: "disabled", status: "DISABLED" as const, verified: false },
  ])(
    "leaves an existing $name user untouched under suppression",
    async ({ status, verified }) => {
      const address = email();
      const user = await prisma.user.create({
        data: {
          email: address,
          status,
          emailVerified: verified,
          ...(verified ? { emailVerifiedAt: new Date() } : {}),
          ...(status === "DISABLED" ? { disabledAt: new Date() } : {}),
        },
      });
      await exhaustDeliveryQuota(address);
      const fixture = createService();
      const response = await postRegistration(fixture.service, address);
      expect(response.status).toBe(202);
      expect(
        await prisma.user.findUniqueOrThrow({ where: { id: user.id } }),
      ).toEqual(user);
      expect(
        await prisma.pendingRegistration.findUnique({
          where: { email: address },
        }),
      ).toBeNull();
      expect(fixture.provider.messages).toHaveLength(0);
    },
  );
});
