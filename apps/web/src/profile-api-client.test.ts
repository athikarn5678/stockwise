import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSelfProfile, updateSelfProfile } from "./profile-api-client";
const profile = {
  id: "30000000-0000-4000-8000-000000000001",
  email: "person@example.com",
  displayName: "Person",
  phone: null,
  updatedAt: "2026-10-25T10:20:30.123Z",
};

afterEach(() => vi.unstubAllGlobals());

describe("self profile API client", () => {
  it("loads the current actor from the canonical envelope", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ data: profile, meta: { requestId: "request-1" } }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetch);
    await expect(fetchSelfProfile()).resolves.toEqual(profile);
  });

  it("distinguishes stale conflicts from generic save failure", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "PROFILE_STALE" } }), {
        status: 409,
      }),
    );
    vi.stubGlobal("fetch", fetch);
    await expect(
      updateSelfProfile({
        displayName: "Person",
        phone: "",
        expectedUpdatedAt: profile.updatedAt,
      }),
    ).rejects.toMatchObject({ kind: "stale" });
  });
});
