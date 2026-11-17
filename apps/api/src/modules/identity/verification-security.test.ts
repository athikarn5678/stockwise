import {
  createCipheriv,
  createHash,
  createHmac,
  randomBytes,
} from "node:crypto";
import type * as NodeCrypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadApiEnvironment } from "../../environment.ts";
import {
  createVerificationSecurity,
  serializeClearedVerificationProofCookie,
  serializeVerificationProofCookie,
  verificationSecurityConfiguration,
  advanceVerificationProofIssuanceCount,
  VERIFICATION_LIFETIME_MILLISECONDS,
  type VerificationProof,
  type VerificationSecurity,
  type VerificationSecurityConfiguration,
} from "./verification-security.ts";

const randomIntMock = vi.hoisted(() =>
  vi.fn<() => number>().mockReturnValue(123),
);
vi.mock("node:crypto", async () => {
  const actual = await vi.importActual<typeof NodeCrypto>("node:crypto");
  return { ...actual, randomInt: randomIntMock };
});

const USER_ID = "3f2b1c9a-8d4e-4a6f-9c1b-2e5d7f0a3b6c";
const NOW = new Date("2026-01-01T00:00:00.000Z");
const PROOF_COOKIE_NAME = "__Host-stockwise_verification_proof";
const PROOF_KEY_ISSUANCE_CEILING = 2 ** 24;

const otpKey = Buffer.alloc(32, 11);
const proofKey = Buffer.alloc(32, 22);
const otherProofKey = Buffer.alloc(32, 44);
const previousProofKey = Buffer.alloc(32, 33);

const baseConfiguration: VerificationSecurityConfiguration = {
  publicWebOrigin: "http://localhost:3000",
  otpKey,
  otpKeyId: 1,
  proofKey,
  proofKeyId: 2,
};

function cookieFor(proof: string, expiresAt: Date, now: Date = NOW): string {
  return serializeVerificationProofCookie(proof, expiresAt, now);
}

function readRaw(
  security: VerificationSecurity,
  proof: string,
  now: Date = NOW,
): VerificationProof | null {
  return security.readProof(`${PROOF_COOKIE_NAME}=${proof}`, now);
}

// Independent re-implementation of the documented OTP HMAC binding so the
// tests can assert exact-string (leading-zero) and field binding without
// relying on the module's internals.
function referenceOtpMac(
  key: Buffer,
  userId: string,
  challengeId: string,
  credentialVersion: bigint,
  code: string,
): string {
  return createHmac("sha256", key)
    .update(
      [
        "stockwise-verification-otp/v1",
        userId,
        challengeId,
        credentialVersion.toString(),
        code,
      ].join("\u0000"),
    )
    .digest("hex");
}

function authenticatedClaims(patch: (claims: Buffer) => void): string {
  const header = Buffer.alloc(5);
  header[0] = 1;
  header.writeUInt32BE(2, 1);
  const claims = Buffer.alloc(42);
  claims[0] = 1;
  claims[1] = 1;
  Buffer.from(USER_ID.replaceAll("-", ""), "hex").copy(claims, 2);
  claims.writeBigUInt64BE(1n, 18);
  claims.writeBigUInt64BE(BigInt(NOW.getTime()), 26);
  claims.writeBigUInt64BE(BigInt(NOW.getTime() + 600_000), 34);
  patch(claims);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", proofKey, nonce);
  cipher.setAAD(
    Buffer.concat([
      Buffer.from("stockwise-verification-proof/v1"),
      header.subarray(0, 1),
      Buffer.from(baseConfiguration.publicWebOrigin),
      header.subarray(1),
    ]),
  );
  const encrypted = cipher.update(claims);
  cipher.final();
  return Buffer.concat([
    header,
    nonce,
    encrypted,
    cipher.getAuthTag(),
  ]).toString("base64url");
}

describe("verification-security", () => {
  beforeEach(() => {
    randomIntMock.mockReset();
    randomIntMock.mockReturnValue(123);
  });

  describe("OTP code generation", () => {
    it("preserves six ASCII digits at both random-number boundaries", () => {
      const security = createVerificationSecurity(baseConfiguration);
      randomIntMock.mockReturnValueOnce(0).mockReturnValueOnce(999_999);
      expect(security.prepare(USER_ID, 1n, NOW).code).toBe("000000");
      expect(security.prepare(USER_ID, 1n, NOW).code).toBe("999999");
    });
  });

  describe("OTP MAC binding", () => {
    it("is a 64-character lowercase hex digest", () => {
      const security = createVerificationSecurity(baseConfiguration);
      const prepared = security.prepare(USER_ID, 1n, NOW);
      expect(prepared.challenge.otpMac).toMatch(/^[0-9a-f]{64}$/);
    });

    it("accepts the exact issued code and rejects a different one", () => {
      const security = createVerificationSecurity(baseConfiguration);
      const prepared = security.prepare(USER_ID, 1n, NOW);
      const input = {
        userId: prepared.challenge.userId,
        id: prepared.challenge.id,
        credentialVersion: prepared.challenge.credentialVersion,
        otpKeyId: prepared.challenge.otpKeyId,
        otpMac: prepared.challenge.otpMac,
      };
      expect(security.matchesOtp(input, prepared.code)).toBe(true);
      const wrong = String((Number(prepared.code) + 1) % 1_000_000).padStart(
        6,
        "0",
      );
      expect(security.matchesOtp(input, wrong)).toBe(false);
    });

    it("binds the MAC to user, challenge, version, and key ID", () => {
      const security = createVerificationSecurity(baseConfiguration);
      const prepared = security.prepare(USER_ID, 7n, NOW);
      const base = {
        userId: prepared.challenge.userId,
        id: prepared.challenge.id,
        credentialVersion: prepared.challenge.credentialVersion,
        otpKeyId: prepared.challenge.otpKeyId,
        otpMac: prepared.challenge.otpMac,
      };
      expect(security.matchesOtp(base, prepared.code)).toBe(true);
      expect(
        security.matchesOtp(
          { ...base, userId: "11111111-2222-3333-4444-555555555555" },
          prepared.code,
        ),
      ).toBe(false);
      expect(
        security.matchesOtp(
          { ...base, id: "11111111-2222-3333-4444-555555555555" },
          prepared.code,
        ),
      ).toBe(false);
      expect(
        security.matchesOtp({ ...base, credentialVersion: 8n }, prepared.code),
      ).toBe(false);
      expect(
        security.matchesOtp({ ...base, otpKeyId: 99 }, prepared.code),
      ).toBe(false);
    });

    it("rejects malformed codes (wrong length or non-digits)", () => {
      const security = createVerificationSecurity(baseConfiguration);
      const prepared = security.prepare(USER_ID, 1n, NOW);
      const input = {
        userId: prepared.challenge.userId,
        id: prepared.challenge.id,
        credentialVersion: prepared.challenge.credentialVersion,
        otpKeyId: prepared.challenge.otpKeyId,
        otpMac: prepared.challenge.otpMac,
      };
      for (const code of [
        "12345",
        "1234567",
        "12a456",
        "",
        " 12345",
        "1234 56",
      ]) {
        expect(security.matchesOtp(input, code)).toBe(false);
      }
      for (const otpMac of ["é".repeat(64), "f".repeat(63), "f".repeat(65)]) {
        expect(security.matchesOtp({ ...input, otpMac }, prepared.code)).toBe(
          false,
        );
      }
    });

    it("binds the exact six-digit string, preserving leading zeros", () => {
      const security = createVerificationSecurity(baseConfiguration);
      const challengeId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
      const version = 3n;
      const macFor000042 = referenceOtpMac(
        otpKey,
        USER_ID,
        challengeId,
        version,
        "000042",
      );
      const macFor000043 = referenceOtpMac(
        otpKey,
        USER_ID,
        challengeId,
        version,
        "000043",
      );
      const input = {
        userId: USER_ID,
        id: challengeId,
        credentialVersion: version,
        otpKeyId: 1,
      };
      expect(
        security.matchesOtp({ ...input, otpMac: macFor000042 }, "000042"),
      ).toBe(true);
      expect(
        security.matchesOtp({ ...input, otpMac: macFor000043 }, "000042"),
      ).toBe(false);
      expect(
        security.matchesOtp({ ...input, otpMac: macFor000042 }, "000043"),
      ).toBe(false);
      // The stripped five-digit form is malformed and must not match.
      expect(
        security.matchesOtp({ ...input, otpMac: macFor000042 }, "42"),
      ).toBe(false);
    });
  });

  describe("link token", () => {
    it("persists only a 64-character lowercase SHA-256 hex hash", () => {
      const security = createVerificationSecurity(baseConfiguration);
      const prepared = security.prepare(USER_ID, 1n, NOW);
      expect(prepared.challenge.linkTokenHash).toMatch(/^[0-9a-f]{64}$/);
      const expected = createHash("sha256")
        .update(prepared.rawLinkToken)
        .digest("hex");
      expect(prepared.challenge.linkTokenHash).toBe(expected);
      expect(prepared.rawLinkToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });
  });

  describe("proof wire format", () => {
    it("encodes to exactly 100 unpadded base64url characters / 75 bytes", () => {
      const security = createVerificationSecurity(baseConfiguration);
      const prepared = security.prepare(USER_ID, 1n, NOW);
      expect(prepared.proof).toMatch(/^[A-Za-z0-9_-]{100}$/);
      const wire = Buffer.from(prepared.proof, "base64url");
      expect(wire.length).toBe(75);
      expect(wire.readUInt8(0)).toBe(1);
      expect(wire.readUInt32BE(1)).toBe(2);
    });

    it("round-trips subject, version, and timestamps", () => {
      const security = createVerificationSecurity(baseConfiguration);
      const prepared = security.prepare(USER_ID, 2n ** 63n - 1n, NOW);
      const proof = readRaw(security, prepared.proof);
      expect(proof).not.toBeNull();
      expect(proof!.usable).toBe(true);
      expect(proof!.subject).toBe(USER_ID);
      expect(proof!.credentialVersion).toBe(2n ** 63n - 1n);
      expect(proof!.issuedAt.getTime()).toBe(NOW.getTime());
      expect(proof!.expiresAt.getTime()).toBe(
        NOW.getTime() + VERIFICATION_LIFETIME_MILLISECONDS,
      );
    });
  });

  describe("phantom proof", () => {
    it("is the same wire size as a real proof but non-authorizing", () => {
      const security = createVerificationSecurity(baseConfiguration);
      const real = security.prove(USER_ID, 1n, NOW);
      const phantom = security.phantom(NOW);
      expect(real.proof.length).toBe(100);
      expect(phantom.proof.length).toBe(100);
      const decoded = readRaw(security, phantom.proof);
      expect(decoded).not.toBeNull();
      expect(decoded!.usable).toBe(false);
      expect(decoded!.credentialVersion).toBe(1n);
      expect(decoded!.subject).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    });
  });

  describe("readProof negatives", () => {
    const security = createVerificationSecurity(baseConfiguration);
    const prepared = security.prepare(USER_ID, 1n, NOW);

    it("rejects a missing or unrelated cookie", () => {
      expect(security.readProof(undefined, NOW)).toBeNull();
      expect(security.readProof("other=1", NOW)).toBeNull();
    });

    it("rejects duplicate matching cookies", () => {
      const cookie = cookieFor(prepared.proof, prepared.challenge.expiresAt);
      expect(security.readProof(`${cookie}; ${cookie}`, NOW)).toBeNull();
      expect(
        security.readProof(
          `${PROOF_COOKIE_NAME}; ${PROOF_COOKIE_NAME}=${prepared.proof}`,
          NOW,
        ),
      ).toBeNull();
    });

    it("rejects malformed wire lengths and non-base64url values", () => {
      expect(
        security.readProof(
          `${PROOF_COOKIE_NAME}=${prepared.proof.slice(0, 90)}`,
          NOW,
        ),
      ).toBeNull();
      expect(
        security.readProof(
          `${PROOF_COOKIE_NAME}=${prepared.proof.slice(0, 99)}!`,
          NOW,
        ),
      ).toBeNull();
      const unsupported = Buffer.from(prepared.proof, "base64url");
      unsupported[0] = 2;
      expect(readRaw(security, unsupported.toString("base64url"))).toBeNull();
    });

    it("rejects tampered ciphertext and authentication tag", () => {
      const tamperedCiphertext = Buffer.from(prepared.proof, "base64url");
      tamperedCiphertext.writeUInt8(
        tamperedCiphertext.readUInt8(30) ^ 0xff,
        30,
      );
      expect(
        security.readProof(
          `${PROOF_COOKIE_NAME}=${tamperedCiphertext.toString("base64url")}`,
          NOW,
        ),
      ).toBeNull();
      const tamperedTag = Buffer.from(prepared.proof, "base64url");
      tamperedTag.writeUInt8(tamperedTag.readUInt8(74) ^ 0xff, 74);
      expect(
        security.readProof(
          `${PROOF_COOKIE_NAME}=${tamperedTag.toString("base64url")}`,
          NOW,
        ),
      ).toBeNull();
    });

    it("rejects a proof bound to a different public web origin", () => {
      const otherOrigin = createVerificationSecurity({
        ...baseConfiguration,
        publicWebOrigin: "https://other.example",
      });
      const proof = otherOrigin.prove(USER_ID, 1n, NOW);
      expect(readRaw(security, proof.proof)).toBeNull();
    });

    it("rejects a proof encrypted under a different key of the same ID", () => {
      const otherKey = createVerificationSecurity({
        ...baseConfiguration,
        proofKey: otherProofKey,
      });
      const proof = otherKey.prove(USER_ID, 1n, NOW);
      expect(readRaw(security, proof.proof)).toBeNull();
    });

    it("rejects a proof from an unknown or retired key ID", () => {
      const foreign = createVerificationSecurity({
        ...baseConfiguration,
        proofKeyId: 9,
      });
      const proof = foreign.prove(USER_ID, 1n, NOW);
      expect(readRaw(security, proof.proof)).toBeNull();
    });

    it("rejects an expired proof", () => {
      const issuedAt = new Date(NOW.getTime() - 601_000);
      const expired = security.prepare(USER_ID, 1n, issuedAt);
      expect(readRaw(security, expired.proof)).toBeNull();
      expect(
        readRaw(security, prepared.proof, new Date(NOW.getTime() + 600_000)),
      ).toBeNull();
    });

    it("rejects issuance more than five seconds in the future", () => {
      const issuedAt = new Date(NOW.getTime() + 5_001);
      const future = security.prepare(USER_ID, 1n, issuedAt);
      expect(readRaw(security, future.proof)).toBeNull();
    });

    it("accepts issuance within the five-second future skew", () => {
      const issuedAt = new Date(NOW.getTime() + 5_000);
      const withinSkew = security.prepare(USER_ID, 1n, issuedAt);
      expect(readRaw(security, withinSkew.proof)).toMatchObject({
        usable: true,
        subject: USER_ID,
        credentialVersion: 1n,
      });
    });

    it("rejects authenticated malformed purpose, marker, version and lifetime claims", () => {
      expect(
        readRaw(
          security,
          authenticatedClaims(() => undefined),
        ),
      ).toMatchObject({
        usable: true,
        subject: USER_ID,
        credentialVersion: 1n,
      });
      for (const patch of [
        (claims: Buffer) => {
          claims[0] = 2;
        },
        (claims: Buffer) => {
          claims[1] = 2;
        },
        (claims: Buffer) => {
          claims.writeBigUInt64BE(0n, 18);
        },
        (claims: Buffer) => {
          claims.writeBigUInt64BE(2n ** 63n, 18);
        },
        (claims: Buffer) => {
          claims.writeBigUInt64BE(BigInt(NOW.getTime() + 600_001), 34);
        },
        (claims: Buffer) => {
          claims.writeBigUInt64BE(BigInt(NOW.getTime()), 34);
        },
        (claims: Buffer) => {
          claims.writeBigUInt64BE(2n ** 64n - 1n, 26);
        },
        (claims: Buffer) => {
          claims.writeBigUInt64BE(2n ** 64n - 1n, 34);
        },
      ])
        expect(readRaw(security, authenticatedClaims(patch))).toBeNull();
    });
  });

  describe("proof key rotation", () => {
    it("validates proofs issued under the retained previous key", () => {
      const oldSecurity = createVerificationSecurity({
        ...baseConfiguration,
        proofKey: previousProofKey,
        proofKeyId: 5,
      });
      const oldProof = oldSecurity.prove(USER_ID, 9n, NOW);
      const rotated = createVerificationSecurity({
        ...baseConfiguration,
        previousProofKey,
        previousProofKeyId: 5,
        previousProofKeyLastIssuedAt: NOW,
      });
      const decoded = readRaw(rotated, oldProof.proof);
      expect(decoded).not.toBeNull();
      expect(decoded!.usable).toBe(true);
      expect(decoded!.subject).toBe(USER_ID);
      expect(decoded!.credentialVersion).toBe(9n);
    });

    it("does not read current-key proofs with the old key", () => {
      const oldSecurity = createVerificationSecurity({
        ...baseConfiguration,
        proofKey: previousProofKey,
        proofKeyId: 5,
      });
      const rotated = createVerificationSecurity({
        ...baseConfiguration,
        previousProofKey,
        previousProofKeyId: 5,
        previousProofKeyLastIssuedAt: NOW,
      });
      const newProof = rotated.prove(USER_ID, 1n, NOW);
      expect(readRaw(oldSecurity, newProof.proof)).toBeNull();
    });

    it("rejects fresh proofs produced with retired previous material or after its last issuance bound", () => {
      const old = createVerificationSecurity({
        ...baseConfiguration,
        proofKey: previousProofKey,
        proofKeyId: 5,
      });
      const fresh = old.prove(USER_ID, 1n, NOW);
      const retired = createVerificationSecurity({
        ...baseConfiguration,
        previousProofKey,
        previousProofKeyId: 5,
        previousProofKeyLastIssuedAt: new Date(NOW.getTime() - 900_000),
      });
      expect(readRaw(retired, fresh.proof)).toBeNull();
      const retained = createVerificationSecurity({
        ...baseConfiguration,
        previousProofKey,
        previousProofKeyId: 5,
        previousProofKeyLastIssuedAt: NOW,
      });
      const afterLast = old.prove(USER_ID, 1n, new Date(NOW.getTime() + 5_001));
      expect(
        readRaw(retained, afterLast.proof, new Date(NOW.getTime() + 5_001)),
      ).toBeNull();
    });

    it("retains the maximum skewed previous proof only before the 605-second deadline", () => {
      const old = createVerificationSecurity({
        ...baseConfiguration,
        proofKey: previousProofKey,
        proofKeyId: 5,
      });
      const proof = old.prove(USER_ID, 1n, new Date(NOW.getTime() + 5_000));
      const rotated = createVerificationSecurity({
        ...baseConfiguration,
        previousProofKey,
        previousProofKeyId: 5,
        previousProofKeyLastIssuedAt: NOW,
      });
      expect(
        readRaw(rotated, proof.proof, new Date(NOW.getTime() + 604_999)),
      ).toMatchObject({
        usable: true,
        subject: USER_ID,
        credentialVersion: 1n,
      });
      expect(
        readRaw(rotated, proof.proof, new Date(NOW.getTime() + 605_000)),
      ).toBeNull();
    });
  });

  describe("issuance ceiling", () => {
    it("advances only valid counts strictly below the per-key encryption ceiling", () => {
      expect(advanceVerificationProofIssuanceCount(0)).toBe(1);
      expect(
        advanceVerificationProofIssuanceCount(PROOF_KEY_ISSUANCE_CEILING - 2),
      ).toBe(PROOF_KEY_ISSUANCE_CEILING - 1);
      for (const count of [
        -1,
        Number.NaN,
        0.5,
        PROOF_KEY_ISSUANCE_CEILING - 1,
        PROOF_KEY_ISSUANCE_CEILING,
      ])
        expect(() => advanceVerificationProofIssuanceCount(count)).toThrow();
    });
  });

  describe("cookie serialization", () => {
    it("always emits Secure, HttpOnly, SameSite=Strict, Path=/ and no Domain", () => {
      const security = createVerificationSecurity(baseConfiguration);
      const prepared = security.prepare(USER_ID, 1n, NOW);
      const cookie = cookieFor(prepared.proof, prepared.challenge.expiresAt);
      expect(cookie).toContain(`${PROOF_COOKIE_NAME}=${prepared.proof}`);
      expect(cookie).toContain("Path=/");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Strict");
      expect(cookie).toContain("Secure");
      expect(cookie).not.toContain("Domain");
      expect(cookie).toContain("Max-Age=600");
      expect(cookie).toContain(
        `Expires=${prepared.challenge.expiresAt.toUTCString()}`,
      );
    });

    it("caps Max-Age at the ten-minute lifetime and aligns it with Expires", () => {
      const farFuture = new Date(NOW.getTime() + 3_600_000);
      const cookie = serializeVerificationProofCookie(
        "p".repeat(100),
        farFuture,
        NOW,
      );
      expect(cookie).toContain("Max-Age=600");
      expect(cookie).toContain(
        `Expires=${new Date(NOW.getTime() + 600_000).toUTCString()}`,
      );
    });

    it("never rounds the cookie lifetime past a subsecond proof expiry", () => {
      const cookie = serializeVerificationProofCookie(
        "p".repeat(100),
        new Date(NOW.getTime() + 1),
        NOW,
      );
      expect(cookie).toContain("Max-Age=0");
      expect(cookie).toContain(`Expires=${NOW.toUTCString()}`);
    });

    it("clears with the same attributes and an expired lifetime", () => {
      const cleared = serializeClearedVerificationProofCookie();
      expect(cleared).toContain(`${PROOF_COOKIE_NAME}=`);
      expect(cleared).toContain("Path=/");
      expect(cleared).toContain("HttpOnly");
      expect(cleared).toContain("SameSite=Strict");
      expect(cleared).toContain("Secure");
      expect(cleared).not.toContain("Domain");
      expect(cleared).toContain("Max-Age=0");
      expect(cleared).toContain("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
    });
  });

  describe("configuration validation", () => {
    it("requires distinct, correctly sized, in-range dedicated keys", () => {
      expect(() =>
        createVerificationSecurity({
          ...baseConfiguration,
          otpKey: Buffer.alloc(31),
        }),
      ).toThrow();
      expect(() =>
        createVerificationSecurity({
          ...baseConfiguration,
          proofKey: Buffer.alloc(31),
        }),
      ).toThrow();
      expect(() =>
        createVerificationSecurity({
          ...baseConfiguration,
          proofKey: Buffer.alloc(33),
        }),
      ).toThrow();
      expect(() =>
        createVerificationSecurity({ ...baseConfiguration, otpKeyId: 0 }),
      ).toThrow();
      expect(() =>
        createVerificationSecurity({
          ...baseConfiguration,
          otpKeyId: 2_147_483_648,
        }),
      ).toThrow();
      expect(() =>
        createVerificationSecurity({ ...baseConfiguration, proofKeyId: -1 }),
      ).toThrow();
      expect(() =>
        createVerificationSecurity({
          ...baseConfiguration,
          proofKeyId: 4_294_967_296,
        }),
      ).toThrow();
      expect(() =>
        createVerificationSecurity({ ...baseConfiguration, proofKey: otpKey }),
      ).toThrow();
    });

    it("requires a complete, distinct, ID-unique previous proof key", () => {
      const withPrevious: VerificationSecurityConfiguration = {
        ...baseConfiguration,
        previousProofKey,
        previousProofKeyId: 5,
        previousProofKeyLastIssuedAt: NOW,
      };
      expect(() =>
        createVerificationSecurity({
          ...withPrevious,
          previousProofKeyId: 2,
        }),
      ).toThrow();
      expect(() =>
        createVerificationSecurity({
          ...withPrevious,
          previousProofKey: proofKey,
        }),
      ).toThrow();
      expect(() =>
        createVerificationSecurity({
          ...withPrevious,
          previousProofKey: otpKey,
        }),
      ).toThrow();
      expect(() =>
        createVerificationSecurity({
          ...withPrevious,
          previousProofKeyLastIssuedAt: new Date(Date.now() + 606_000),
        }),
      ).toThrow();
    });

    it("never includes key material in validation errors", () => {
      let error: unknown;
      try {
        createVerificationSecurity({ ...baseConfiguration, proofKey: otpKey });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain(otpKey.toString("base64url"));
    });
  });

  describe("verificationSecurityConfiguration", () => {
    const analyticsKey = Buffer.alloc(32, 7).toString("base64url");
    const baseEnv = {
      DATABASE_URL:
        "postgresql://local-user:local-password@127.0.0.1:5432/local-database",
      STOCKWISE_API_PORT: "3001",
      STOCKWISE_ANALYTICS_CURSOR_HMAC_KEY: analyticsKey,
      STOCKWISE_PUBLIC_WEB_ORIGIN: "http://localhost:3000",
      STOCKWISE_BETTER_AUTH_SECRET: Buffer.alloc(32, 55).toString("base64url"),
      STOCKWISE_RUNTIME_ENV: "development",
      STOCKWISE_VERIFICATION_OTP_KEY: otpKey.toString("base64url"),
      STOCKWISE_VERIFICATION_OTP_KEY_ID: "1",
      STOCKWISE_VERIFICATION_PROOF_KEY: proofKey.toString("base64url"),
      STOCKWISE_VERIFICATION_PROOF_KEY_ID: "2",
    };

    it("issues a proof compatible with the configured current key and origin", () => {
      const configured = createVerificationSecurity(
        verificationSecurityConfiguration(loadApiEnvironment(baseEnv)),
      );
      const proof = configured.prove(USER_ID, 7n, NOW);
      expect(
        readRaw(createVerificationSecurity(baseConfiguration), proof.proof),
      ).toMatchObject({
        usable: true,
        subject: USER_ID,
        credentialVersion: 7n,
      });
    });

    it("validates an existing proof through the configured previous-key rotation boundary", () => {
      const old = createVerificationSecurity({
        ...baseConfiguration,
        proofKey: previousProofKey,
        proofKeyId: 5,
      });
      const oldProof = old.prove(USER_ID, 9n, NOW);
      const configured = createVerificationSecurity(
        verificationSecurityConfiguration(
          loadApiEnvironment({
            ...baseEnv,
            STOCKWISE_VERIFICATION_PREVIOUS_PROOF_KEY:
              previousProofKey.toString("base64url"),
            STOCKWISE_VERIFICATION_PREVIOUS_PROOF_KEY_ID: "5",
            STOCKWISE_VERIFICATION_PREVIOUS_PROOF_KEY_LAST_ISSUED_AT:
              NOW.toISOString(),
          }),
        ),
      );
      expect(readRaw(configured, oldProof.proof)).toMatchObject({
        usable: true,
        subject: USER_ID,
        credentialVersion: 9n,
      });
    });
  });
});
