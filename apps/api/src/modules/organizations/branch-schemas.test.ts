import { describe, expect, it } from "vitest";

import {
  branchCreateRequestSchema,
  branchLifecycleRequestSchema,
  branchListQuerySchema,
  branchUpdateRequestSchema,
} from "./branch-schemas.ts";

describe("branch boundary schemas", () => {
  it("canonicalizes a valid branch create request", () => {
    expect(
      branchCreateRequestSchema.parse({
        address: "  1 ถนนสุขุมวิท  ",
        code: "  bkk_01  ",
        name: "  Bangkok  Central  ",
        phone: "   ",
      }),
    ).toEqual({
      address: "1 ถนนสุขุมวิท",
      code: "BKK_01",
      name: "Bangkok  Central",
      phone: null,
    });
  });

  it.each(["-A", "_A", "A B", "A!", "A".repeat(17)])(
    "rejects invalid code %j",
    (code) => {
      expect(
        branchCreateRequestSchema.safeParse({ code, name: "Branch" }).success,
      ).toBe(false);
    },
  );

  it("rejects immutable, unknown, empty, and imprecise update requests", () => {
    for (const body of [
      { code: "NEW", expectedUpdatedAt: "2026-08-24T12:00:00.000Z" },
      { expectedUpdatedAt: "2026-08-24T12:00:00.000Z" },
      { expectedUpdatedAt: "2026-08-24T12:00:00Z", name: "Name" },
      { expectedUpdatedAt: "2026-08-24T12:00:00.000Z", name: "   " },
    ]) {
      expect(branchUpdateRequestSchema.safeParse(body).success).toBe(false);
    }
  });

  it("requires an exact millisecond UTC version for lifecycle changes", () => {
    expect(
      branchLifecycleRequestSchema.parse({
        expectedUpdatedAt: "2026-08-24T12:00:00.123Z",
      }).expectedUpdatedAt,
    ).toEqual(new Date("2026-08-24T12:00:00.123Z"));
    expect(
      branchLifecycleRequestSchema.safeParse({
        expectedUpdatedAt: "2026-08-24T12:00:00.123+07:00",
      }).success,
    ).toBe(false);
    expect(
      branchLifecycleRequestSchema.safeParse({
        expectedUpdatedAt: "2026-99-24T12:00:00.123Z",
      }).success,
    ).toBe(false);
  });

  it("accepts only the explicit includeInactive query flag", () => {
    expect(branchListQuerySchema.parse({})).toEqual({ includeInactive: false });
    expect(branchListQuerySchema.parse({ includeInactive: "true" })).toEqual({
      includeInactive: true,
    });
    expect(
      branchListQuerySchema.safeParse({ includeInactive: "yes" }).success,
    ).toBe(false);
  });
});
