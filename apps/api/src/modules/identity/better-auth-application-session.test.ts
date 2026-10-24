import { PrismaPg } from "@prisma/adapter-pg";
import { describe, expect, it } from "vitest";
import { PrismaClient } from "../../generated/prisma/client.ts";
import { createBetterAuthApplicationSessionService } from "./better-auth-application-session.ts";
import { createLoginLimiter } from "./login-limiter.ts";
import { createBetterAuthNative } from "./better-auth-native.ts";

const origin = "https://web.example.test";
const prisma = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: "postgresql://unused:unused@127.0.0.1:1/d4_unused_test",
  }),
});
const configuration = {
  secureCookie: true,
  absoluteTimeoutMilliseconds: 604800000,
  idleTimeoutMilliseconds: 86400000,
  touchIntervalMilliseconds: 900000,
};
const service = createBetterAuthApplicationSessionService({
  prisma,
  native: createBetterAuthNative({
    prisma,
    secret: "d4-test-only-secret-not-a-real-credential",
    publicWebOrigin: origin,
    secureCookie: true,
  }),
  publicWebOrigin: origin,
  configuration,
  limiter: createLoginLimiter(),
  pendingRegistrationService: {
    async provePassword() {
      return { outcome: "invalid" };
    },
  },
});
describe("isolated explicit native session boundary", () => {
  it.each([
    {},
    { origin: "https://attacker.example.test" },
    { origin, "sec-fetch-site": "cross-site" },
  ])("denies login and logout before database work for %j", async (headers) => {
    expect(
      await service.login(
        { email: "person@example.test", password: "test-only password" },
        new Headers(headers),
      ),
    ).toEqual({ outcome: "forbidden" });
    expect(await service.logout(new Headers(headers))).toEqual({
      outcome: "forbidden",
    });
    expect(await service.logoutAll(new Headers(headers))).toEqual({
      outcome: "forbidden",
    });
  });
  it.each([
    {},
    { email: "not-email", password: "test-only password" },
    { email: "person@example.test", password: "short" },
    { email: "person@example.test", password: "\u{1f512}".repeat(129) },
    {
      email: "person@example.test",
      password: "test-only password",
      stockwisePurpose: "APPLICATION",
    },
  ])("rejects malformed or caller-provided authority %j", async (body) => {
    expect(await service.login(body, new Headers({ origin }))).toEqual({
      outcome: "validation_error",
    });
  });
  it("clears only the native cookie on missing-session logout", async () => {
    const result = await service.logout(new Headers({ origin }));
    expect(result).toEqual({
      outcome: "logged_out",
      cookies: [
        "__Secure-stockwise_native.session_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure",
      ],
    });
  });
  it("requires a trusted native session for logout-all", async () => {
    expect(await service.logoutAll(new Headers({ origin }))).toEqual({
      outcome: "authentication_required",
    });
  });
});
