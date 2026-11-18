import { beforeEach, describe, expect, it, vi } from "vitest";

const { redirect } = vi.hoisted(() => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`redirect:${url}`);
  }),
}));
vi.mock("next/navigation", () => ({ redirect }));

import AiAnalysisRoute from "./page";

async function go(query: Record<string, string | string[] | undefined>) {
  try {
    await AiAnalysisRoute({ searchParams: Promise.resolve(query) });
  } catch (error) {
    return (error as Error).message;
  }
  return "no redirect";
}

describe("legacy /app/ai-analysis route", () => {
  beforeEach(() => redirect.mockClear());

  it("redirects to the Analytics AI analysis tab and keeps the context", async () => {
    expect(await go({ organizationId: "org-1", branchId: "branch-1" })).toBe(
      "redirect:/app/analytics?view=ai-analysis&organizationId=org-1&branchId=branch-1",
    );
  });

  it("drops unknown or repeated parameters and keeps working without context", async () => {
    expect(await go({ organizationId: ["a", "b"], evil: "x" })).toBe(
      "redirect:/app/analytics?view=ai-analysis",
    );
  });
});
