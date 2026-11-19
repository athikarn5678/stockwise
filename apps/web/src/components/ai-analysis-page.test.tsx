// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AiAnalysisRun } from "@/ai-analysis-api-client";
import type { AccessibleOrganization } from "@/branch-api-client";
import { AiAnalysisContent, mayAnalyze } from "./ai-analysis-page";

const ORG = "10000000-0000-4000-8000-000000000001";
const A = "20000000-0000-4000-8000-000000000001";
const B = "20000000-0000-4000-8000-000000000002";
const RUN_ID = "70000000-0000-4000-8000-000000000001";
const OLD_RUN_ID = "70000000-0000-4000-8000-000000000002";
const OLDEST_RUN_ID = "70000000-0000-4000-8000-000000000003";

const searchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useSearchParams: () => searchParams,
}));

const mocks = vi.hoisted(() => {
  class AiAnalysisApiError extends Error {
    constructor(
      readonly status: number,
      readonly code: string | null = null,
      readonly retryAfterSeconds: number | null = null,
    ) {
      super("AI analysis request failed");
    }
  }
  return {
    AiAnalysisApiError,
    createRun: vi.fn(),
    fetchAccessContext: vi.fn(),
    fetchBranches: vi.fn(),
    listRuns: vi.fn(),
    retryRun: vi.fn(),
  };
});

vi.mock("@/ai-analysis-api-client", () => ({
  AiAnalysisApiError: mocks.AiAnalysisApiError,
  createRun: mocks.createRun,
  listRuns: mocks.listRuns,
  retryRun: mocks.retryRun,
}));

vi.mock("@/branch-api-client", () => ({
  fetchAccessContext: mocks.fetchAccessContext,
  fetchBranches: mocks.fetchBranches,
}));

function run(overrides: Partial<AiAnalysisRun> = {}): AiAnalysisRun {
  return {
    createdAt: "2026-11-16T03:00:00.000Z",
    days: 7,
    id: RUN_ID,
    languages: {
      en: [
        { body: "English overview body", heading: "Overview" },
        { body: "English sales body", heading: "Sales" },
      ],
      th: [
        { body: "เนื้อหาภาพรวม", heading: "ภาพรวม" },
        { body: "เนื้อหายอดขาย", heading: "ยอดขาย" },
      ],
    },
    missing: [],
    mock: false,
    model: "deepseek-v4.1-flash",
    period: {
      from: "2026-11-09",
      scope: "organization",
      timezone: "Asia/Bangkok",
      to: "2026-11-16",
    },
    ...overrides,
  };
}

const createdRun = run();
const olderRun = run({
  createdAt: "2026-11-14T03:00:00.000Z",
  id: OLD_RUN_ID,
  languages: {
    en: [{ body: "Older English body", heading: "Older overview" }],
    th: [{ body: "เนื้อหาเก่า", heading: "ภาพรวมเก่า" }],
  },
  model: "older-model",
});
const oldestRun = run({
  createdAt: "2026-11-12T03:00:00.000Z",
  id: OLDEST_RUN_ID,
  languages: {
    en: [{ body: "Oldest English body", heading: "Oldest overview" }],
    th: [{ body: "เนื้อหาเก่าที่สุด", heading: "ภาพรวมเก่าที่สุด" }],
  },
  model: "oldest-model",
});
const halfRun = run({
  id: RUN_ID,
  languages: {
    en: [{ body: "Half English body", heading: "Half overview" }],
    th: null,
  },
  missing: ["th"],
  model: "half-model",
});

function organization(
  role: AccessibleOrganization["role"] = "OWNER",
  branches = [
    { id: A, code: "A", name: "Alpha" },
    { id: B, code: "B", name: "Beta" },
  ],
): AccessibleOrganization {
  return { branches, id: ORG, name: "Store One", role };
}

function page(items: AiAnalysisRun[], nextCursor: string | null = null) {
  return { data: items, meta: { nextCursor } };
}

function renderContent(input?: {
  role?: AccessibleOrganization["role"];
  selectedBranchId?: string | null;
}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <AiAnalysisContent
        organization={organization(input?.role ?? "OWNER")}
        selectedBranchId={input?.selectedBranchId ?? A}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  // jsdom has no layout; Base UI scrolls the highlighted option into view.
  Element.prototype.scrollIntoView = vi.fn();
  searchParams.delete("organizationId");
  searchParams.delete("branchId");
  mocks.createRun.mockReset();
  mocks.listRuns.mockReset();
  mocks.retryRun.mockReset();
  mocks.fetchBranches.mockReset();
  mocks.fetchAccessContext.mockReset();
  mocks.listRuns.mockResolvedValue(page([]));
  mocks.fetchBranches.mockResolvedValue(
    [A, B].map((id, index) => ({
      address: null,
      code: index === 0 ? "A" : "B",
      id,
      name: index === 0 ? "Alpha" : "Beta",
      organizationId: ORG,
      phone: null,
      status: "ACTIVE",
      updatedAt: "2026-09-01T00:00:00.000Z",
    })),
  );
  mocks.fetchAccessContext.mockResolvedValue({
    firstOrganizationOnboarding: { eligible: false },
    organizations: [
      {
        branches: [A, B].map((id, index) => ({
          code: index === 0 ? "A" : "B",
          id,
          name: index === 0 ? "Alpha" : "Beta",
        })),
        id: ORG,
        name: "Store One",
        role: "OWNER",
      },
    ],
    user: { displayName: "Owner", id: "user-id" },
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(Element.prototype, "scrollIntoView");
});

describe("AI analysis access rule", () => {
  it("allows owners, admins and branch managers with a branch only", () => {
    expect(mayAnalyze(organization("OWNER"))).toBe(true);
    expect(mayAnalyze(organization("ADMIN"))).toBe(true);
    expect(mayAnalyze(organization("BRANCH_MANAGER"))).toBe(true);
    expect(mayAnalyze(organization("BRANCH_MANAGER", []))).toBe(false);
    expect(mayAnalyze(organization("INVENTORY_STAFF"))).toBe(false);
    expect(mayAnalyze(organization("CASHIER"))).toBe(false);
  });
});

describe("AI analysis viewer", () => {
  it("generates both languages once and switches without another request", async () => {
    mocks.createRun.mockResolvedValue(createdRun);
    renderContent();
    fireEvent.click(screen.getByRole("button", { name: "Generate analysis" }));

    expect(await screen.findByText("English overview body")).toBeTruthy();
    expect(mocks.createRun).toHaveBeenCalledWith(
      ORG,
      { scope: "organization" },
      7,
    );
    const createCalls = mocks.createRun.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "Thai" }));
    expect(await screen.findByText("เนื้อหาภาพรวม")).toBeTruthy();
    expect(screen.queryByText("English overview body")).toBeNull();
    expect(mocks.createRun).toHaveBeenCalledTimes(createCalls);
    expect(screen.getByRole("heading", { name: "ภาพรวม" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Thai" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(mocks.listRuns.mock.calls.length).toBeGreaterThan(0);
  });

  it("shows the skeleton and the progress message while pending", async () => {
    mocks.createRun.mockReturnValue(new Promise(() => {}));
    renderContent();
    fireEvent.click(screen.getByRole("button", { name: "Generate analysis" }));
    const pending = await screen.findAllByText(
      "Analyzing — this can take about half a minute…",
    );
    expect(pending.length).toBeGreaterThan(1);
    expect(
      document.querySelectorAll('[data-slot="skeleton"]').length,
    ).toBeGreaterThan(4);
    expect(
      (
        screen.getByRole("button", {
          name: "Analyzing — this can take about half a minute…",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("retries a missing language and shows the new text", async () => {
    mocks.listRuns.mockResolvedValue(page([halfRun]));
    mocks.retryRun.mockResolvedValue(run({ id: RUN_ID, model: "half-model" }));
    renderContent();
    const item = await screen.findByRole("button", { name: /half-model/ });
    fireEvent.click(item);
    fireEvent.click(screen.getByRole("button", { name: "Thai" }));

    expect(
      screen.getByText("This language could not be generated."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry Thai" }));
    expect(await screen.findByText("เนื้อหาภาพรวม")).toBeTruthy();
    expect(mocks.retryRun).toHaveBeenCalledWith(
      ORG,
      { scope: "organization" },
      RUN_ID,
      "th",
    );
  });

  it("shows the other language when the viewed language failed to generate", async () => {
    // The UI language is English by default; only Thai is present here.
    mocks.createRun.mockResolvedValue(
      run({
        languages: {
          en: null,
          th: [{ body: "เนื้อหาภาพรวม", heading: "ภาพรวม" }],
        },
        missing: ["en"],
      }),
    );
    renderContent();
    fireEvent.click(screen.getByRole("button", { name: "Generate analysis" }));
    expect(await screen.findByText("เนื้อหาภาพรวม")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "English" }));
    expect(screen.getByRole("button", { name: "Retry English" })).toBeTruthy();
  });

  it("locks the selectors and history while a request is in flight", async () => {
    mocks.listRuns.mockResolvedValue(page([olderRun]));
    mocks.createRun.mockReturnValue(new Promise(() => undefined));
    renderContent();
    await screen.findByRole("button", { name: /older-model/ });
    fireEvent.click(screen.getByRole("button", { name: "Generate analysis" }));
    await waitFor(() => {
      expect(
        (
          screen.getByRole("combobox", {
            name: "Insight scope",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
    });
    expect(
      (screen.getByRole("button", { name: /older-model/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("offers Retry for the missing language even while the other language is shown", async () => {
    mocks.createRun.mockResolvedValue(
      run({
        languages: {
          en: [{ body: "English overview body", heading: "Overview" }],
          th: null,
        },
        missing: ["th"],
      }),
    );
    renderContent();
    fireEvent.click(screen.getByRole("button", { name: "Generate analysis" }));
    expect(await screen.findByText("English overview body")).toBeTruthy();
    // No blanket provider error: the run exists, one language is missing.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      screen.getByText("This language could not be generated."),
    ).toBeTruthy();
    mocks.retryRun.mockResolvedValue(createdRun);
    fireEvent.click(screen.getByRole("button", { name: "Retry Thai" }));
    await waitFor(() =>
      expect(mocks.retryRun).toHaveBeenCalledWith(
        ORG,
        { scope: "organization" },
        RUN_ID,
        "th",
      ),
    );
  });

  it("shows a spinner while pending and re-enables Generate after the 429 countdown", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mocks.createRun.mockRejectedValueOnce(
        new mocks.AiAnalysisApiError(429, "RATE_LIMITED", 3),
      );
      renderContent();
      const generate = screen.getByRole("button", {
        name: "Generate analysis",
      });
      expect((generate as HTMLButtonElement).disabled).toBe(false);
      fireEvent.click(generate);
      expect(
        await screen.findByRole("button", { name: /Try again in 3s/ }),
      ).toBeTruthy();
      expect(
        (
          screen.getByRole("button", {
            name: /Try again in/,
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_100);
      });
      const again = screen.getByRole("button", { name: "Generate analysis" });
      expect((again as HTMLButtonElement).disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("disables Generate with a spinner only while the run request is pending", async () => {
    mocks.createRun.mockReturnValue(new Promise(() => undefined));
    renderContent();
    fireEvent.click(screen.getByRole("button", { name: "Generate analysis" }));
    const pending = await screen.findByRole("button", {
      name: "Analyzing — this can take about half a minute…",
    });
    expect((pending as HTMLButtonElement).disabled).toBe(true);
    expect(pending.querySelector("svg.animate-spin")).not.toBeNull();
  });

  it("explains the one-per-minute limit", async () => {
    mocks.createRun.mockRejectedValue(new mocks.AiAnalysisApiError(429));
    renderContent();
    fireEvent.click(screen.getByRole("button", { name: "Generate analysis" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Please wait a moment and try again (one request per minute).",
    );
  });
});

describe("AI analysis history", () => {
  it("lists newest first, appends pages and shows a stored run on click", async () => {
    mocks.listRuns
      .mockResolvedValueOnce(page([createdRun, olderRun], "cursor-2"))
      .mockResolvedValueOnce(page([oldestRun]));
    renderContent();
    expect(
      await screen.findByRole("button", { name: /deepseek-v4\.1-flash/ }),
    ).toBeTruthy();
    expect(mocks.listRuns).toHaveBeenCalledWith(
      ORG,
      { scope: "organization" },
      null,
      expect.any(AbortSignal),
    );

    fireEvent.click(screen.getByRole("button", { name: /older-model/ }));
    expect(await screen.findByText("Older English body")).toBeTruthy();
    expect(mocks.createRun).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(
      await screen.findByRole("button", { name: /oldest-model/ }),
    ).toBeTruthy();
    expect(mocks.listRuns).toHaveBeenLastCalledWith(
      ORG,
      { scope: "organization" },
      "cursor-2",
      expect.any(AbortSignal),
    );
    expect(mocks.createRun).not.toHaveBeenCalled();
  });

  it("clears the shown analysis when the scope changes", async () => {
    mocks.createRun.mockResolvedValue(createdRun);
    renderContent();
    fireEvent.click(screen.getByRole("button", { name: "Generate analysis" }));
    expect(await screen.findByText("English overview body")).toBeTruthy();

    fireEvent.click(screen.getByRole("combobox", { name: "Insight scope" }));
    const option = await screen.findByRole("option", { name: /Beta/ });
    // Base UI arms pointer selection on pointerdown; click alone is ignored.
    fireEvent.pointerDown(option, { pointerType: "mouse" });
    fireEvent.click(option);
    expect(screen.queryByText("English overview body")).toBeNull();
    expect(
      await screen.findByText("No analysis is saved for this scope yet."),
    ).toBeTruthy();
  });

  it("shows the empty and error states", async () => {
    renderContent();
    expect(
      await screen.findByText("No analysis is saved for this scope yet."),
    ).toBeTruthy();
    mocks.listRuns.mockRejectedValue(new mocks.AiAnalysisApiError(500));
    renderContent();
    expect(
      await screen.findByText("The analysis history could not be loaded."),
    ).toBeTruthy();
  });

  it("sends the selected branch scope", async () => {
    renderContent({ role: "BRANCH_MANAGER", selectedBranchId: A });
    await waitFor(() =>
      expect(mocks.listRuns).toHaveBeenCalledWith(
        ORG,
        { scope: "branch", branchId: A },
        null,
        expect.any(AbortSignal),
      ),
    );
  });
});
