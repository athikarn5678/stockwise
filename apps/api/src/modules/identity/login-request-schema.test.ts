import { describe, expect, it } from "vitest";

import { loginRequestSchema } from "./login-request-schema.ts";

describe("login request validation", () => {
  it("canonicalizes email and preserves the exact password", () => {
    const password = "  exact password é  ";

    expect(
      loginRequestSchema.parse({ email: "  User@Example.COM  ", password }),
    ).toEqual({ email: "user@example.com", password });
  });

  it.each([
    ["malformed email", { email: "not-an-email", password: "x".repeat(15) }],
    ["missing email", { password: "x".repeat(15) }],
    ["missing password", { email: "user@example.com" }],
    [
      "unknown field",
      {
        email: "user@example.com",
        password: "password-long-enough",
        role: "OWNER",
      },
    ],
  ])("rejects %s", (_name, body) => {
    expect(loginRequestSchema.safeParse(body).success).toBe(false);
  });
});
