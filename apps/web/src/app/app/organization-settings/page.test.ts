import { beforeEach, describe, expect, it, vi } from "vitest";

const { redirect } = vi.hoisted(() => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`redirect:${url}`);
  }),
}));
vi.mock("next/navigation", () => ({ redirect }));

import LegacySettingsRoute from "./page";

async function go(query: Record<string, string | string[] | undefined>) {
  try {
    await LegacySettingsRoute({ searchParams: Promise.resolve(query) });
  } catch (error) {
    return (error as Error).message;
  }
  return "no redirect";
}

describe("legacy /app/organization-settings route", () => {
  beforeEach(() => {
    redirect.mockClear();
  });

  it("redirects to /app/settings and keeps the context", async () => {
    expect(await go({ organizationId: "org-1", branchId: "branch-1" })).toBe(
      "redirect:/app/settings?organizationId=org-1&branchId=branch-1",
    );
  });

  it("redirects without context and drops unknown parameters", async () => {
    expect(await go({ evil: "x" })).toBe("redirect:/app/settings");
  });
});
