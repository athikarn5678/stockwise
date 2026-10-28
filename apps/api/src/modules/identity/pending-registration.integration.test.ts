import { createHash, randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadTestDatabaseEnvironment } from "../../test/database-environment.ts";
import { PrismaClient } from "../../generated/prisma/client.ts";
import { createBetterAuthNative } from "./better-auth-native.ts";
import { defaultAuthenticationAuthority } from "../../environment.ts";
import { hashPassword, verifyPassword } from "./password-hasher.ts";
import { createPendingRegistrationRepository } from "./pending-registration-repository.ts";
import { createPendingRegistrationService } from "./pending-registration-service.ts";
import {
  createVerificationSecurity,
  type PreparedVerification,
} from "./verification-security.ts";

const environment = loadTestDatabaseEnvironment();
// The isolated Docker-exec relay has a cold connection cost above Prisma's
// acquisition deadline. Retain warmed connections; keep transaction limits default.
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
beforeAll(async () => {
  // Eight is the largest concurrent wave below. Warm outside a transaction so
  // the tests measure lock/transaction behavior, not relay process startup.
  await Promise.all(
    Array.from({ length: 8 }, () => prisma.$queryRaw`SELECT 1`),
  );
  hash = await hashPassword(PASSWORD);
});
afterAll(async () => {
  await prisma.$disconnect();
});
function email() {
  return `${randomUUID()}@example.test`;
}
function cookie(material: PreparedVerification) {
  return `__Host-stockwise_verification_proof=${material.proof}`;
}
async function stage(address = email()) {
  const material = await repository.register({
    email: address,
    passwordHash: hash,
    security,
  });
  if (!material) throw new Error("Expected fresh pending attempt.");
  return { email: address, material };
}
function complete(
  row: { email: string; material: PreparedVerification },
  proof = cookie(row.material),
) {
  return repository.completeCode({
    email: row.email,
    challengeId: row.material.challenge.id,
    code: row.material.code,
    cookieHeader: proof,
    security,
  });
}

describe("isolated D3 PostgreSQL pending registration", () => {
  it("stages only an expiring hash, then atomically enrolls a native credential without sessions", async () => {
    const row = await stage();
    const pending = await prisma.pendingRegistration.findUniqueOrThrow({
      where: { email: row.email },
    });
    expect(pending.expiresAt.getTime() - pending.issuedAt.getTime()).toBe(
      600_000,
    );
    expect(pending.passwordHash).toBe(hash);
    expect(
      await prisma.betterAuthAccount.count({ where: { userId: pending.id } }),
    ).toBe(0);
    expect(
      await prisma.user.findUnique({ where: { email: row.email } }),
    ).toBeNull();
    expect(await complete(row)).toBe("verified");
    const user = await prisma.user.findUniqueOrThrow({
      where: { email: row.email },
    });
    const account = await prisma.betterAuthAccount.findUniqueOrThrow({
      where: {
        providerId_accountId: { providerId: "credential", accountId: user.id },
      },
    });
    expect(user.passwordHash).not.toBe(hash);
    expect(await verifyPassword(user.passwordHash, PASSWORD)).toBe(false);
    expect(account.password).toBe(hash);
    expect(await verifyPassword(account.password!, PASSWORD)).toBe(true);
    expect(await verifyPassword(account.password!, PASSWORD.trim())).toBe(
      false,
    );
    expect(user).toMatchObject({
      status: "ACTIVE",
      emailVerified: true,
      credentialVersion: pending.credentialVersion,
      id: pending.id,
    });
    expect(user.emailVerifiedAt).not.toBeNull();
    expect(user.nativeRegistrationCompletedAt).not.toBeNull();
    expect(
      (
        await prisma.pendingRegistration.findUniqueOrThrow({
          where: { email: row.email },
        })
      ).passwordHash,
    ).toBeNull();
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);
    expect(
      await prisma.betterAuthSession.count({ where: { userId: user.id } }),
    ).toBe(0);
    const native = createBetterAuthNative({
      prisma,
      secret: "test-only-native-password-seam-secret",
      publicWebOrigin: "https://web.example.test",
      secureCookie: true,
    });
    const context = await native.$context;
    const found = await context.internalAdapter.findCredentialAccount(user.id);
    expect(found?.password).toBe(hash);
    expect(
      await context.password.verify({
        hash: found!.password!,
        password: PASSWORD,
      }),
    ).toBe(true);
    expect(
      await context.password.verify({
        hash: found!.password!,
        password: "different password",
      }),
    ).toBe(false);
    expect(defaultAuthenticationAuthority("test")).toBe("legacy");
  });
  it("requires exact initiating proof; mailbox-only and another attempt cannot activate the password", async () => {
    const row = await stage();
    const other = await stage();
    expect(await complete(row, "")).toBe("proof_required");
    expect(await complete(row, cookie(other.material))).toBe("proof_required");
    expect(
      await prisma.user.findUnique({ where: { email: row.email } }),
    ).toBeNull();
    expect(await complete(row)).toBe("verified");
  });
  it("allows explicit pending-password fallback only for a current snapshot", async () => {
    const row = await stage();
    const snapshot = await repository.credentialSnapshot(row.email);
    expect(snapshot).not.toBeNull();
    expect(await verifyPassword(snapshot!.passwordHash, PASSWORD)).toBe(true);
    const attempt = await repository.reserveCredential(row.email);
    expect(attempt.allowed).toBe(true);
    if (!attempt.allowed) throw new Error("Expected credential reservation.");
    const proof = await repository.finishCredential(
      row.email,
      attempt.attemptId,
      snapshot,
      security,
    );
    expect(proof).not.toBeNull();
    if (proof === null || !("proof" in proof))
      throw new Error("Expected pending password proof.");
    expect(
      await complete(
        row,
        `__Host-stockwise_verification_proof=${proof!.proof}`,
      ),
    ).toBe("verified");
    const nextAttempt = await repository.reserveCredential(row.email);
    expect(nextAttempt.allowed).toBe(true);
    if (!nextAttempt.allowed)
      throw new Error("Expected credential reservation.");
    expect(
      await repository.finishCredential(
        row.email,
        nextAttempt.attemptId,
        snapshot,
        security,
      ),
    ).toBeNull();
  });
  it("resend rotates only challenge, never password, version, lifetime or initiating proof", async () => {
    const row = await stage();
    const before = await prisma.pendingRegistration.findUniqueOrThrow({
      where: { email: row.email },
    });
    const rotated = await repository.resend(row.email, security);
    expect(rotated).not.toBeNull();
    const after = await prisma.pendingRegistration.findUniqueOrThrow({
      where: { email: row.email },
    });
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.credentialVersion).toBe(before.credentialVersion);
    expect(after.expiresAt).toEqual(before.expiresAt);
    expect(after.issuedAt).toEqual(before.issuedAt);
    expect(await complete(row)).toBe("invalid");
    expect(
      await repository.completeCode({
        email: row.email,
        challengeId: rotated!.challenge.id,
        code: rotated!.code,
        cookieHeader: cookie(row.material),
        security,
      }),
    ).toBe("verified");
  });
  it("replaces pending attempts atomically and rejects stale challenge, proof and password snapshots", async () => {
    const row = await stage();
    const snapshot = await repository.credentialSnapshot(row.email);
    const replacement = await repository.register({
      email: row.email,
      passwordHash: hash,
      security,
    });
    expect(replacement).not.toBeNull();
    expect(await complete(row)).toBe("invalid");
    const attempt = await repository.reserveCredential(row.email);
    expect(attempt.allowed).toBe(true);
    if (!attempt.allowed) throw new Error("Expected credential reservation.");
    expect(
      await repository.finishCredential(
        row.email,
        attempt.attemptId,
        snapshot,
        security,
      ),
    ).toBeNull();
    expect(
      await repository.completeCode({
        email: row.email,
        challengeId: replacement!.challenge.id,
        code: replacement!.code,
        cookieHeader: cookie(row.material),
        security,
      }),
    ).toBe("proof_required");
  });
  it("counts five wrong OTPs without proof, preserves link and never consumes valid material without proof", async () => {
    const row = await stage();
    const wrong = row.material.code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++)
      expect(
        await repository.completeCode({
          email: row.email,
          challengeId: row.material.challenge.id,
          code: wrong,
          cookieHeader: undefined,
          security,
        }),
      ).toBe("invalid");
    expect(await complete(row)).toBe("invalid");
    expect(
      await repository.completeLink({
        linkTokenHash: row.material.challenge.linkTokenHash,
        cookieHeader: undefined,
        security,
      }),
    ).toBe("proof_required");
    expect(
      await repository.completeLink({
        linkTokenHash: row.material.challenge.linkTokenHash,
        cookieHeader: cookie(row.material),
        security,
      }),
    ).toBe("verified");
  });
  it("handles concurrent completions and lost-response retries with one account and bounded informational link replay", async () => {
    const row = await stage();
    const results = await Promise.all([
      complete(row),
      complete(row),
      complete(row),
    ]);
    expect(results.sort()).toEqual(["invalid", "invalid", "verified"]);
    const user = await prisma.user.findUniqueOrThrow({
      where: { email: row.email },
    });
    expect(
      await prisma.betterAuthAccount.count({ where: { userId: user.id } }),
    ).toBe(1);
    expect(
      await repository.completeLink({
        linkTokenHash: row.material.challenge.linkTokenHash,
        cookieHeader: undefined,
        security,
      }),
    ).toBe("already_verified");
    await prisma.user.update({
      where: { id: user.id },
      data: { credentialVersion: { increment: 1 } },
    });
    expect(
      await repository.completeLink({
        linkTokenHash: row.material.challenge.linkTokenHash,
        cookieHeader: undefined,
        security,
      }),
    ).toBe("invalid");
  });
  it("recovers a staged attempt in a fresh repository composition without changing its proof", async () => {
    const row = await stage();
    const restarted = createPendingRegistrationRepository(prisma);
    expect(await restarted.canDeliver(row.material.challenge.id)).toBe(true);
    expect(
      await restarted.completeLink({
        linkTokenHash: row.material.challenge.linkTokenHash,
        cookieHeader: cookie(row.material),
        security,
      }),
    ).toBe("verified");
    const retry = createPendingRegistrationRepository(prisma);
    expect(
      await retry.completeLink({
        linkTokenHash: row.material.challenge.linkTokenHash,
        cookieHeader: undefined,
        security,
      }),
    ).toBe("already_verified");
    expect(
      await prisma.user.findUniqueOrThrow({ where: { email: row.email } }),
    ).toMatchObject({ id: row.material.challenge.userId });
  });
  it.each(["ACTIVE", "DISABLED"] as const)(
    "never replaces a preexisting %s user's credential or UUID",
    async (status) => {
      const address = email();
      const user = await prisma.user.create({
        data: {
          email: address,
          passwordHash: hash,
          status,
          ...(status === "DISABLED" ? { disabledAt: new Date() } : {}),
        },
      });
      expect(
        await repository.register({
          email: address,
          passwordHash: hash,
          security,
        }),
      ).toBeNull();
      expect(await repository.credentialSnapshot(address)).toBeNull();
      expect(await repository.resend(address, security)).toBeNull();
      expect(
        await prisma.user.findUniqueOrThrow({ where: { id: user.id } }),
      ).toEqual(user);
    },
  );
  it("protects a verified user's existing native account", async () => {
    const address = email();
    const user = await prisma.user.create({
      data: {
        email: address,
        emailVerifiedAt: new Date(),
        emailVerified: true,
      },
    });
    const account = await prisma.betterAuthAccount.create({
      data: {
        userId: user.id,
        accountId: user.id,
        providerId: "credential",
        password: hash,
      },
    });
    expect(
      await repository.register({
        email: address,
        passwordHash: hash,
        security,
      }),
    ).toBeNull();
    expect(
      await prisma.betterAuthAccount.findUniqueOrThrow({
        where: { id: account.id },
      }),
    ).toEqual(account);
  });
  it.each(["status", "version", "password-change", "account-hash"] as const)(
    "revalidates matching Native credentials after a locked %s mutation",
    async (change) => {
      const address = email();
      const user = await prisma.user.create({
        data: {
          email: address,
          emailVerified: true,
          emailVerifiedAt: new Date(),
          nativeRegistrationCompletedAt: new Date(),
        },
      });
      await prisma.betterAuthAccount.create({
        data: {
          userId: user.id,
          accountId: user.id,
          providerId: "credential",
          password: hash,
        },
      });
      const snapshot = await repository.credentialSnapshot(address);
      expect(snapshot?.kind).toBe("verified");
      expect(await verifyPassword(snapshot!.passwordHash, PASSWORD)).toBe(true);
      const attempt = await repository.reserveCredential(address);
      if (!attempt.allowed) throw new Error("Expected credential reservation.");

      if (change === "status") {
        await prisma.user.update({
          where: { id: user.id },
          data: { status: "DISABLED", disabledAt: new Date() },
        });
      } else if (change === "version") {
        await prisma.user.update({
          where: { id: user.id },
          data: { credentialVersion: { increment: 1 } },
        });
      } else if (change === "password-change") {
        await prisma.user.update({
          where: { id: user.id },
          data: { passwordChangedAt: new Date(Date.now() + 1_000) },
        });
      } else {
        await prisma.betterAuthAccount.updateMany({
          where: { userId: user.id, providerId: "credential" },
          data: { password: await hashPassword("different Native password") },
        });
      }

      expect(
        await repository.finishCredential(
          address,
          attempt.attemptId,
          snapshot,
          security,
        ),
      ).toEqual({ ineligible: true });
      expect((await repository.reserveCredential(address)).allowed).toBe(true);
    },
  );
  it("rejects enrollment if a legacy user appeared after staging", async () => {
    const row = await stage();
    const user = await prisma.user.create({
      data: { email: row.email, passwordHash: hash },
    });
    expect(await complete(row)).toBe("invalid");
    expect(
      await prisma.user.findUniqueOrThrow({ where: { id: user.id } }),
    ).toEqual(user);
  });
  it("serializes registration/resend/completion races without mixed credentials", async () => {
    const row = await stage();
    const results = await Promise.all([
      complete(row),
      repository.resend(row.email, security),
      repository.register({ email: row.email, passwordHash: hash, security }),
    ]);
    const user = await prisma.user.findUnique({ where: { email: row.email } });
    const pending = await prisma.pendingRegistration.findUniqueOrThrow({
      where: { email: row.email },
    });
    if (user) {
      expect(results[0]).toBe("verified");
      expect(pending.passwordHash).toBeNull();
      expect(
        await prisma.betterAuthAccount.count({ where: { userId: user.id } }),
      ).toBe(1);
    } else {
      expect(results[0]).toBe("invalid");
      expect(pending.consumedAt).toBeNull();
      expect(pending.passwordHash).toBe(hash);
    }
  });
  it("keeps delivery failure closed while allowing same-password resend recovery", async () => {
    const row = await stage();
    await repository.revokeDelivery({
      challengeId: row.material.challenge.id,
      reason: "DELIVERY_FAILED",
    });
    expect(await complete(row)).toBe("invalid");
    expect(await repository.credentialSnapshot(row.email)).not.toBeNull();
    expect(await repository.canDeliver(row.material.challenge.id)).toBe(false);
    const replacement = await repository.resend(row.email, security);
    expect(replacement).not.toBeNull();
    await repository.revokeDelivery({
      challengeId: row.material.challenge.id,
      reason: "RESPONSE_ABORTED",
    });
    expect(await repository.canDeliver(replacement!.challenge.id)).toBe(true);
  });
  it("persists admission and failure budgets across workers and restart compositions", async () => {
    const address = email();
    const workers = Array.from({ length: 8 }, () =>
      createPendingRegistrationRepository(prisma),
    );
    const results = await Promise.all(
      workers.map((worker) => worker.admit(address, "registration")),
    );
    expect(results.filter((result) => result.allowed)).toHaveLength(5);
    expect(
      (
        await createPendingRegistrationRepository(prisma).admit(
          address,
          "registration",
        )
      ).allowed,
    ).toBe(false);
    for (let i = 0; i < 3; i++)
      expect((await repository.admit(address, "delivery")).allowed).toBe(true);
    expect((await repository.admit(address, "delivery")).allowed).toBe(false);
    const credentialWorkers = Array.from({ length: 5 }, () =>
      createPendingRegistrationRepository(prisma),
    );
    const credentialAttempts = await Promise.all(
      credentialWorkers.map((worker) => worker.reserveCredential(address)),
    );
    expect(credentialAttempts.filter((result) => result.allowed)).toHaveLength(
      5,
    );
    expect(
      (
        await createPendingRegistrationRepository(prisma).reserveCredential(
          address,
        )
      ).allowed,
    ).toBe(false);
  });
  it("limits eight simultaneous wrong password proofs and blocks a correct proof after exhaustion", async () => {
    const row = await stage();
    const gate = Promise.withResolvers<void>();
    const reached = Promise.withResolvers<void>();
    let decisions = 0;
    let comparisons = 0;
    const arrived = () => {
      if (++decisions === 8) reached.resolve();
    };
    const makeService = () => {
      const worker = createPendingRegistrationRepository(prisma);
      return createPendingRegistrationService({
        repository: {
          ...worker,
          async reserveCredential(...args) {
            const result = await worker.reserveCredential(...args);
            if (!result.allowed) arrived();
            return result;
          },
          async credentialSnapshot(address) {
            const snapshot = await worker.credentialSnapshot(address);
            arrived();
            return snapshot;
          },
        },
        security,
        delivery: { reserve: () => null, drain: async () => undefined },
        passwordHasher: { hash: hashPassword },
        passwordVerifier: {
          async verify(_hash, password) {
            comparisons++;
            if (password !== PASSWORD) await gate.promise;
            return password === PASSWORD;
          },
        },
      });
    };
    const services = Array.from({ length: 8 }, makeService);
    const attempts = services.map((service) =>
      service.provePassword({ email: row.email, password: "wrong password" }),
    );
    await reached.promise;
    gate.resolve();
    const results = await Promise.all(attempts);
    expect(comparisons).toBe(5);
    expect(
      results.filter((result) => result.outcome === "limited"),
    ).toHaveLength(3);
    expect(
      results.filter((result) => result.outcome === "invalid"),
    ).toHaveLength(5);
    expect(
      await services[0]!.provePassword({
        email: row.email,
        password: PASSWORD,
      }),
    ).toMatchObject({ outcome: "limited" });
    expect(comparisons).toBe(5);
  });
  it("refunds only the successful reservation without resetting prior failures", async () => {
    const row = await stage();
    for (let i = 0; i < 4; i++) {
      const failed = await repository.reserveCredential(row.email);
      if (!failed.allowed) throw new Error("Expected failed-proof admission.");
      expect(
        await repository.finishCredential(
          row.email,
          failed.attemptId,
          null,
          security,
        ),
      ).toBeNull();
    }
    const correct = await repository.reserveCredential(row.email);
    if (!correct.allowed) throw new Error("Expected fifth-slot admission.");
    const snapshot = await repository.credentialSnapshot(row.email);
    expect(await verifyPassword(snapshot!.passwordHash, PASSWORD)).toBe(true);
    const proof = await repository.finishCredential(
      row.email,
      correct.attemptId,
      snapshot,
      security,
    );
    if (proof === null || !("proof" in proof))
      throw new Error("Expected pending password proof.");
    expect(
      security.readProof(
        `__Host-stockwise_verification_proof=${proof!.proof}`,
        new Date(),
      ),
    ).toMatchObject({ usable: true, subject: snapshot!.id });
    expect(
      await repository.finishCredential(
        row.email,
        correct.attemptId,
        snapshot,
        security,
      ),
    ).toBeNull();
    const lastFailure = await repository.reserveCredential(row.email);
    if (!lastFailure.allowed) throw new Error("Expected refunded slot.");
    expect(
      await repository.finishCredential(
        row.email,
        lastFailure.attemptId,
        null,
        security,
      ),
    ).toBeNull();
    expect((await repository.reserveCredential(row.email)).allowed).toBe(false);
  });
  it("keeps an in-flight correct reservation charged and rejects its expired finalization", async () => {
    const row = await stage();
    const first = await repository.reserveCredential(row.email);
    expect(first.allowed).toBe(true);
    if (!first.allowed) throw new Error("Expected credential reservation.");
    const snapshot = await repository.credentialSnapshot(row.email);
    expect(snapshot).not.toBeNull();
    const otherReservations = await Promise.all(
      Array.from({ length: 4 }, () => repository.reserveCredential(row.email)),
    );
    expect(otherReservations.every((result) => result.allowed)).toBe(true);
    expect((await repository.reserveCredential(row.email)).allowed).toBe(false);
    const lease =
      await prisma.pendingRegistrationCredentialAttempt.findUniqueOrThrow({
        where: { id: first.attemptId },
      });
    await prisma.pendingRegistrationCredentialAttempt.update({
      where: { id: first.attemptId },
      data: { expiresAt: new Date(lease.windowAt.getTime() + 1) },
    });
    expect(
      await repository.finishCredential(
        row.email,
        first.attemptId,
        snapshot,
        security,
      ),
    ).toBeNull();
    expect((await repository.reserveCredential(row.email)).allowed).toBe(false);
  });
  it("does not refund an expired abandoned lease after a repository restart", async () => {
    const address = email();
    const first = await repository.reserveCredential(address);
    expect(first.allowed).toBe(true);
    if (!first.allowed) throw new Error("Expected credential reservation.");
    const lease =
      await prisma.pendingRegistrationCredentialAttempt.findUniqueOrThrow({
        where: { id: first.attemptId },
      });
    await prisma.pendingRegistrationCredentialAttempt.update({
      where: { id: first.attemptId },
      data: { expiresAt: new Date(lease.windowAt.getTime() + 1) },
    });
    const restarted = createPendingRegistrationRepository(prisma);
    const remaining = await Promise.all(
      Array.from({ length: 4 }, () => restarted.reserveCredential(address)),
    );
    expect(remaining.every((result) => result.allowed)).toBe(true);
    expect((await restarted.reserveCredential(address)).allowed).toBe(false);
  });
  it("does not issue proof or refund quota for a changed credential snapshot", async () => {
    const row = await stage();
    const snapshot = await repository.credentialSnapshot(row.email);
    expect(snapshot).not.toBeNull();
    const attempt = await repository.reserveCredential(row.email);
    expect(attempt.allowed).toBe(true);
    if (!attempt.allowed) throw new Error("Expected credential reservation.");
    await prisma.pendingRegistration.update({
      where: { email: row.email },
      data: { credentialVersion: snapshot!.credentialVersion + 1n },
    });
    expect(
      await repository.finishCredential(
        row.email,
        attempt.attemptId,
        snapshot,
        security,
      ),
    ).toBeNull();
    const remaining = await Promise.all(
      Array.from({ length: 4 }, () => repository.reserveCredential(row.email)),
    );
    expect(remaining.every((result) => result.allowed)).toBe(true);
    expect((await repository.reserveCredential(row.email)).allowed).toBe(false);
  });
  it("does not refund a mismatched supplied snapshot", async () => {
    const row = await stage();
    const snapshot = await repository.credentialSnapshot(row.email);
    expect(snapshot).not.toBeNull();
    const attempt = await repository.reserveCredential(row.email);
    expect(attempt.allowed).toBe(true);
    if (!attempt.allowed) throw new Error("Expected credential reservation.");
    expect(
      await repository.finishCredential(
        row.email,
        attempt.attemptId,
        { ...snapshot!, passwordHash: "not-the-current-hash" },
        security,
      ),
    ).toBeNull();
    const remaining = await Promise.all(
      Array.from({ length: 4 }, () => repository.reserveCredential(row.email)),
    );
    expect(remaining.every((result) => result.allowed)).toBe(true);
    expect((await repository.reserveCredential(row.email)).allowed).toBe(false);
  });
  it("does not debit a new quota window when finalizing an old-window attempt", async () => {
    const row = await stage();
    const snapshot = await repository.credentialSnapshot(row.email);
    expect(snapshot).not.toBeNull();
    const attempt = await repository.reserveCredential(row.email);
    expect(attempt.allowed).toBe(true);
    if (!attempt.allowed) throw new Error("Expected credential reservation.");
    const key = createHash("sha256").update(row.email).digest("hex");
    const oldWindow = new Date(Date.now() - 901_000);
    await prisma.pendingRegistrationCredentialAttempt.update({
      where: { id: attempt.attemptId },
      data: {
        windowAt: oldWindow,
        expiresAt: new Date(oldWindow.getTime() + 900_000),
      },
    });
    await prisma.pendingRegistrationQuota.update({
      where: { key_purpose: { key, purpose: "credential" } },
      data: { windowAt: oldWindow },
    });
    const current = await repository.reserveCredential(row.email);
    expect(current.allowed).toBe(true);
    expect(
      await repository.finishCredential(
        row.email,
        attempt.attemptId,
        snapshot,
        security,
      ),
    ).toBeNull();
    const quota = await prisma.pendingRegistrationQuota.findUniqueOrThrow({
      where: { key_purpose: { key, purpose: "credential" } },
    });
    expect(quota.count).toBe(1);
    expect((await repository.reserveCredential(row.email)).allowed).toBe(true);
    expect(
      await prisma.pendingRegistrationQuota.findUniqueOrThrow({
        where: { key_purpose: { key, purpose: "credential" } },
      }),
    ).toMatchObject({ count: 2 });
  });
  it("expires fail-closed and sweeps only staging data, never the completed User", async () => {
    const row = await stage();
    expect(await complete(row)).toBe("verified");
    const user = await prisma.user.findUniqueOrThrow({
      where: { email: row.email },
    });
    await prisma.$executeRaw`UPDATE pending_registrations SET issued_at = statement_timestamp() - interval '11 minutes', expires_at = statement_timestamp() - interval '1 minute', consumed_at = statement_timestamp() - interval '2 minutes' WHERE email = ${row.email}`;
    expect(
      await repository.completeLink({
        linkTokenHash: row.material.challenge.linkTokenHash,
        cookieHeader: cookie(row.material),
        security,
      }),
    ).toBe("invalid");
    expect(await repository.sweepExpired(1)).toBe(1);
    expect(
      await prisma.user.findUniqueOrThrow({ where: { id: user.id } }),
    ).toEqual(user);
    const pending = await stage();
    await prisma.$executeRaw`UPDATE pending_registrations SET issued_at = statement_timestamp() - interval '11 minutes', expires_at = statement_timestamp() - interval '1 minute' WHERE email = ${pending.email}`;
    expect(await complete(pending)).toBe("invalid");
    expect(await repository.resend(pending.email, security)).toBeNull();
    expect(await repository.credentialSnapshot(pending.email)).toBeNull();
  });
});
