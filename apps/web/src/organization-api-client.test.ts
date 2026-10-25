import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchOrganizationSettings,
  updateOrganizationSettings,
} from "./organization-api-client";

const organization = {
  id: "30000000-0000-4000-8000-000000000001",
  name: "North  Store",
  updatedAt: "2026-10-25T10:20:30.123Z",
};

afterEach(() => vi.unstubAllGlobals());

describe("organization settings API client", () => {
  it("loads only the canonical organization envelope", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: organization,
          meta: { requestId: "request-1" },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetch);
    await expect(fetchOrganizationSettings(organization.id)).resolves.toEqual(
      organization,
    );
    expect(fetch.mock.calls[0]?.[0]).toBe(
      `/api/v1/organizations/${organization.id}`,
    );
  });

  it("sends the expected version unchanged and preserves the returned version", async () => {
    const updated = {
      ...organization,
      name: "Updated Store",
      updatedAt: "2026-10-25T10:20:31.456Z",
    };
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ data: updated, meta: { requestId: "request-2" } }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetch);
    await expect(
      updateOrganizationSettings(organization.id, {
        name: "Updated Store",
        expectedUpdatedAt: organization.updatedAt,
      }),
    ).resolves.toEqual(updated);
    const [, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({
      name: "Updated Store",
      expectedUpdatedAt: organization.updatedAt,
    });
  });

  it("distinguishes stale and validation failures from unavailable errors", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { code: "ORGANIZATION_STALE" } }),
          { status: 409 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: "VALIDATION_ERROR" } }), {
          status: 400,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: "UNEXPECTED" } }), {
          status: 500,
        }),
      );
    vi.stubGlobal("fetch", fetch);
    const input = { name: "Store", expectedUpdatedAt: organization.updatedAt };
    await expect(
      updateOrganizationSettings(organization.id, input),
    ).rejects.toMatchObject({ kind: "stale" });
    await expect(
      updateOrganizationSettings(organization.id, input),
    ).rejects.toMatchObject({ kind: "validation" });
    await expect(
      updateOrganizationSettings(organization.id, input),
    ).rejects.toMatchObject({ kind: "unavailable" });
  });
});
