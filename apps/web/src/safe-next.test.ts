import { describe, expect, it } from "vitest";

import { loginUrlWithNext, safeNextPath } from "./safe-next";

describe("safeNextPath", () => {
  it("keeps same-origin absolute paths with query and hash", () => {
    expect(safeNextPath("/pricing")).toBe("/pricing");
    expect(safeNextPath("/pricing?organizationId=abc#plans")).toBe(
      "/pricing?organizationId=abc#plans",
    );
    expect(safeNextPath("/app/catalog?organizationId=1&branchId=2")).toBe(
      "/app/catalog?organizationId=1&branchId=2",
    );
  });

  it.each([
    ["https://evil.test"],
    ["//evil.test"],
    ["///evil.test"],
    ["/\\evil.test"],
    ["\\\\evil.test"],
    ["javascript:alert(1)"],
    ["pricing"],
    ["/pricing\nSet-Cookie: x"],
    ["/ok\u0000"],
    ["http:/evil.test"],
    [""],
    ["/login"],
    ["/login?next=/pricing"],
    ["/register"],
    ["/reset-password/x"],
    ["/" + "a".repeat(600)],
    ["/.//evil.test"],
    ["/..//evil.test"],
    ["/a/..//evil.test"],
    ["/.///"],
    ["/./login"],
    ["/a/../login"],
    ["/%2e/%2e//evil.test"],
  ])("falls back for %j", (value) => {
    expect(safeNextPath(value)).toBe("/");
  });

  it("falls back for missing values and honours a custom fallback", () => {
    expect(safeNextPath(null)).toBe("/");
    expect(safeNextPath(undefined, "/app")).toBe("/app");
  });
});

describe("loginUrlWithNext", () => {
  it("encodes a safe target and omits an unsafe or trivial one", () => {
    expect(loginUrlWithNext("/pricing")).toBe("/login?next=%2Fpricing");
    expect(loginUrlWithNext("/pricing?organizationId=a")).toBe(
      "/login?next=%2Fpricing%3ForganizationId%3Da",
    );
    expect(loginUrlWithNext("//evil.test")).toBe("/login");
    expect(loginUrlWithNext("/")).toBe("/login");
  });
});
