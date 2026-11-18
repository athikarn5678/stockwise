// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AccessibleOrganization } from "@/branch-api-client";
import { AiInsightView } from "./ai-insight-view";

const ORG = "10000000-0000-4000-8000-000000000001";
const A = "20000000-0000-4000-8000-000000000001";
const B = "20000000-0000-4000-8000-000000000002";
const OLD = "20000000-0000-4000-8000-000000000003";
const text = "<script>alert('x')</script>\n<b>hello</b>";

type StoredState = "SUCCEEDED" | "FAILED" | "INSUFFICIENT" | "IN_PROGRESS";

let storedReports: Record<string, unknown[][]>;
let demoStatus: number;
let demoResult: null | {
  mode: "DEMO";
  label: string;
  explanation: string;
  content: string;
  from: string;
  to: string;
  reportingTimezone: string;
  provider: null;
  providerCalls: 0;
} = null;
let requests: { url: string; method: string }[];
let pending = false;
let pendingBranches = false;
let listStatus = 200;

function report(input: {
  id: string;
  cadence: "WEEKLY" | "MONTHLY";
  periodStartInclusive: string;
  periodEndExclusive: string;
  content: string | null;
  state?: StoredState;
  reportingTimezone?: string;
  completedAt?: string | null;
}) {
  return {
    id: input.id,
    cadence: input.cadence,
    reportingTimezone: input.reportingTimezone ?? "Asia/Bangkok",
    periodStartInclusive: input.periodStartInclusive,
    periodEndExclusive: input.periodEndExclusive,
    schemaVersion: "1",
    metricDefinitionVersion: "1",
    sourceCutoff: "2026-09-27T17:00:00.000Z",
    promptVersion: "1",
    state: input.state ?? "SUCCEEDED",
    // Stored-report metadata the UI must never render.
    attemptCount: 2,
    provider: "seeded-template",
    actualModel: "seeded-model-v1",
    content: input.content,
    failureCategory: null,
    generatedAt: "2026-09-27T23:01:00.000Z",
    completedAt:
      input.completedAt === undefined
        ? "2026-09-27T23:01:00.000Z"
        : input.completedAt,
  };
}

const weeklyNewest = report({
  id: "50000000-0000-4000-8000-000000000001",
  cadence: "WEEKLY",
  periodStartInclusive: "2026-09-27T17:00:00.000Z",
  periodEndExclusive: "2026-10-04T17:00:00.000Z",
  content: text,
});
const weeklyOlder = report({
  id: "50000000-0000-4000-8000-000000000002",
  cadence: "WEEKLY",
  periodStartInclusive: "2026-09-20T17:00:00.000Z",
  periodEndExclusive: "2026-09-27T17:00:00.000Z",
  content: "Older weekly content",
});
const monthlyNewest = report({
  id: "50000000-0000-4000-8000-000000000003",
  cadence: "MONTHLY",
  periodStartInclusive: "2026-09-30T17:00:00.000Z",
  periodEndExclusive: "2026-10-31T17:00:00.000Z",
  content: "Newest monthly content",
});
const monthlyOlder = report({
  id: "50000000-0000-4000-8000-000000000004",
  cadence: "MONTHLY",
  periodStartInclusive: "2026-08-31T17:00:00.000Z",
  periodEndExclusive: "2026-09-30T17:00:00.000Z",
  content: "Older monthly content",
});
const weeklyFailed = report({
  id: "50000000-0000-4000-8000-000000000005",
  cadence: "WEEKLY",
  periodStartInclusive: "2026-10-04T17:00:00.000Z",
  periodEndExclusive: "2026-10-11T17:00:00.000Z",
  content: null,
  state: "FAILED",
  completedAt: null,
});

const WEEKLY_NEWEST_LABEL = "Sep 28, 2026–Oct 4, 2026";
const WEEKLY_OLDER_LABEL = "Sep 21, 2026–Sep 27, 2026";
const MONTHLY_NEWEST_LABEL = "Oct 1, 2026–Oct 31, 2026";
const MONTHLY_OLDER_LABEL = "Sep 1, 2026–Sep 30, 2026";

const BRANCH_REPORT = report({
  id: "50000000-0000-4000-8000-000000000006",
  cadence: "WEEKLY",
  periodStartInclusive: "2026-09-27T17:00:00.000Z",
  periodEndExclusive: "2026-10-04T17:00:00.000Z",
  content: "Beta branch content",
});
const OLD_BRANCH_REPORT = report({
  id: "50000000-0000-4000-8000-000000000007",
  cadence: "WEEKLY",
  periodStartInclusive: "2026-09-20T17:00:00.000Z",
  periodEndExclusive: "2026-09-27T17:00:00.000Z",
  content: "Old branch history",
});

function pageCursor(index: number) {
  return `60000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function listKey(scope: string, branchId: string, cadence: string) {
  return `${scope}:${branchId}:${cadence}`;
}

function organization(
  role: AccessibleOrganization["role"] = "OWNER",
): AccessibleOrganization {
  return {
    id: ORG,
    name: "Store One",
    role,
    branches: [
      { id: A, code: "A", name: "Alpha" },
      { id: B, code: "B", name: "Beta" },
    ],
  };
}

function renderView(role: AccessibleOrganization["role"] = "OWNER") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <AiInsightView organization={organization(role)} selectedBranchId={A} />
    </QueryClientProvider>,
  );
}

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

function storedReportRequests() {
  return requests.filter(({ url }) => url.includes("/ai-insights?"));
}

async function periodOptions() {
  const select = (await screen.findByLabelText(
    "Report period",
  )) as HTMLSelectElement;
  return within(select)
    .getAllByRole("option")
    .map((option) => option.textContent);
}

beforeEach(() => {
  storedReports = {
    [listKey("organization", "", "WEEKLY")]: [[weeklyNewest]],
    [listKey("organization", "", "MONTHLY")]: [[monthlyNewest]],
    [listKey("branch", A, "WEEKLY")]: [[weeklyOlder]],
    [listKey("branch", B, "WEEKLY")]: [[BRANCH_REPORT]],
    [listKey("branch", OLD, "WEEKLY")]: [[OLD_BRANCH_REPORT]],
    [listKey("branch", A, "MONTHLY")]: [[monthlyOlder]],
  };
  demoStatus = 404;
  demoResult = null;
  requests = [];
  pending = false;
  pendingBranches = false;
  listStatus = 200;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, method: init?.method ?? "GET" });
      if (url.includes("/ai-insights/demo?"))
        return demoStatus === 200
          ? json({ data: demoResult }, demoResult ? 200 : 404)
          : json({ error: { code: "NOT_FOUND" } }, demoStatus);
      if (url.includes("/ai-insights?")) {
        if (pending) return new Promise(() => {});
        if (listStatus !== 200)
          return json({ error: { code: "FORBIDDEN" } }, listStatus);
        const params = new URL(url, "http://localhost").searchParams;
        const pages =
          storedReports[
            listKey(
              params.get("scope") ?? "",
              params.get("branchId") ?? "",
              params.get("cadence") ?? "",
            )
          ] ?? [];
        const cursor = params.get("cursor");
        const index = cursor === null ? 0 : Number(cursor.slice(-12));
        return json({
          data: pages[index] ?? [],
          meta: {
            nextCursor: index + 1 < pages.length ? pageCursor(index + 1) : null,
          },
        });
      }
      if (url.includes("/branches?includeInactive=true")) {
        if (pendingBranches) return new Promise(() => {});
        return json({
          data: [
            {
              id: A,
              code: "A",
              name: "Alpha",
              status: "ACTIVE",
              organizationId: ORG,
              address: null,
              phone: null,
              updatedAt: "2026-09-01T00:00:00.000Z",
            },
            {
              id: B,
              code: "B",
              name: "Beta",
              status: "ACTIVE",
              organizationId: ORG,
              address: null,
              phone: null,
              updatedAt: "2026-09-01T00:00:00.000Z",
            },
            {
              id: OLD,
              code: "OLD",
              name: "Old",
              status: "INACTIVE",
              organizationId: ORG,
              address: null,
              phone: null,
              updatedAt: "2026-09-01T00:00:00.000Z",
            },
          ],
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("stored AI report picker", () => {
  it("offers only Weekly and Monthly, with Weekly selected by default", async () => {
    renderView();
    await screen.findByRole("heading", { name: "Successful AI summary" });
    const cadence = screen.getByLabelText(
      "Insight cadence",
    ) as HTMLSelectElement;
    expect(cadence.value).toBe("WEEKLY");
    expect(
      within(cadence)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Weekly", "Monthly"]);
    expect(requests.some(({ url }) => url.includes("cadence=WEEKLY"))).toBe(
      true,
    );
    expect(requests.some(({ url }) => url.includes("cadence=DAILY"))).toBe(
      false,
    );
    expect(requests.some(({ url }) => url.includes("cadence=YEARLY"))).toBe(
      false,
    );
  });

  it("loads every stored period page and shows the newest report by default", async () => {
    storedReports[listKey("organization", "", "WEEKLY")] = [
      [weeklyNewest],
      [weeklyOlder],
    ];
    renderView();
    await waitFor(async () =>
      expect(await periodOptions()).toEqual([
        WEEKLY_NEWEST_LABEL,
        WEEKLY_OLDER_LABEL,
      ]),
    );
    const listRequests = storedReportRequests();
    expect(listRequests).toHaveLength(2);
    expect(listRequests[0]?.url).toContain("scope=organization");
    expect(listRequests[0]?.url).toContain("cadence=WEEKLY");
    expect(listRequests[0]?.url).toContain("limit=100");
    expect(listRequests[0]?.url).not.toContain("cursor=");
    expect(listRequests[1]?.url).toContain(`cursor=${pageCursor(1)}`);
    expect(listRequests[1]?.url).toContain("limit=100");
    expect(
      (screen.getByLabelText("Report period") as HTMLSelectElement).value,
    ).toBe(weeklyNewest.id);
    expect(
      screen.getByText(/Report period: Sep 28, 2026–Oct 4, 2026/),
    ).toBeTruthy();
    expect(
      screen.getByText(
        (_, element) =>
          element?.tagName === "P" && element.textContent === text,
      ).textContent,
    ).toBe(text);
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("article b")).toBeNull();
  });

  it("switches to an older week, then reloads Monthly and its older month", async () => {
    storedReports[listKey("organization", "", "WEEKLY")] = [
      [weeklyNewest, weeklyOlder],
    ];
    storedReports[listKey("organization", "", "MONTHLY")] = [
      [monthlyNewest, monthlyOlder],
    ];
    renderView();
    await screen.findByRole("heading", { name: "Successful AI summary" });
    await waitFor(async () =>
      expect(await periodOptions()).toEqual([
        WEEKLY_NEWEST_LABEL,
        WEEKLY_OLDER_LABEL,
      ]),
    );
    fireEvent.change(screen.getByLabelText("Report period"), {
      target: { value: weeklyOlder.id },
    });
    expect(screen.getByText("Older weekly content")).toBeTruthy();
    expect(
      screen.getByText(/Report period: Sep 21, 2026–Sep 27, 2026/),
    ).toBeTruthy();
    expect(screen.queryByText("Newest monthly content")).toBeNull();

    fireEvent.change(screen.getByLabelText("Insight cadence"), {
      target: { value: "MONTHLY" },
    });
    await waitFor(async () =>
      expect(await periodOptions()).toEqual([
        MONTHLY_NEWEST_LABEL,
        MONTHLY_OLDER_LABEL,
      ]),
    );
    expect(
      storedReportRequests().some(
        ({ url }) =>
          url.includes("cadence=MONTHLY") && url.includes("limit=100"),
      ),
    ).toBe(true);
    // Changing the cadence restarts at the newest period of the new list.
    expect(
      (screen.getByLabelText("Report period") as HTMLSelectElement).value,
    ).toBe(monthlyNewest.id);
    expect(screen.getByText("Newest monthly content")).toBeTruthy();
    expect(screen.queryByText("Older weekly content")).toBeNull();

    fireEvent.change(screen.getByLabelText("Report period"), {
      target: { value: monthlyOlder.id },
    });
    expect(screen.getByText("Older monthly content")).toBeTruthy();
    expect(screen.queryByText("Newest monthly content")).toBeNull();
  });

  it("reloads the stored reports with the selected branch", async () => {
    renderView();
    await screen.findByRole("heading", { name: "Successful AI summary" });
    fireEvent.change(screen.getByLabelText("Insight scope"), {
      target: { value: B },
    });
    await waitFor(() =>
      expect(
        storedReportRequests().some(
          ({ url }) =>
            url.includes("scope=branch") &&
            url.includes(`branchId=${B}`) &&
            url.includes("cadence=WEEKLY") &&
            url.includes("limit=100"),
        ),
      ).toBe(true),
    );
    expect(await screen.findByText("Beta branch content")).toBeTruthy();
    expect(
      screen.queryByText(
        (_, element) =>
          element?.tagName === "P" && element.textContent === text,
      ),
    ).toBeNull();
  });

  it("never renders stored provider, model, or attempt metadata", async () => {
    renderView();
    await screen.findByRole("heading", { name: "Successful AI summary" });
    expect(screen.queryByText(/seeded-template/)).toBeNull();
    expect(screen.queryByText(/seeded-model-v1/)).toBeNull();
    expect(screen.queryByText(/attempt/i)).toBeNull();
    expect(screen.queryByText(/OpenRouter/)).toBeNull();
  });

  it("offers only completed reports with report text", async () => {
    storedReports[listKey("organization", "", "WEEKLY")] = [
      [weeklyFailed, { ...weeklyNewest, state: "IN_PROGRESS", content: null }],
      [{ ...weeklyOlder, content: "   " }],
    ];
    renderView();
    expect(
      await screen.findByText(
        "No persisted insight yet for this scope and cadence.",
      ),
    ).toBeTruthy();
    expect(await periodOptions()).toEqual([
      "No stored report period is available.",
    ]);
    expect(
      screen.queryByRole("heading", { name: "Successful AI summary" }),
    ).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("treats an empty stored list as normal", async () => {
    storedReports[listKey("organization", "", "WEEKLY")] = [[]];
    renderView();
    expect(
      await screen.findByText(
        "No persisted insight yet for this scope and cadence.",
      ),
    ).toBeTruthy();
    expect(
      (screen.getByLabelText("Report period") as HTMLSelectElement).disabled,
    ).toBe(true);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("distinguishes loading and a safe access error", async () => {
    pending = true;
    renderView();
    expect(screen.getByText("Loading persisted insight…")).toBeTruthy();
    expect(
      (screen.getByLabelText("Report period") as HTMLSelectElement).disabled,
    ).toBe(true);
    cleanup();
    pending = false;
    listStatus = 403;
    renderView();
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "AI insights are not available for your current access.",
    );
  });

  it("announces historical Branch choices while they load", () => {
    pendingBranches = true;
    renderView();
    expect(screen.getByText("Loading historical branch choices…")).toBeTruthy();
  });

  it.each([
    [
      "WEEKLY",
      "America/New_York",
      "2026-03-02T05:00:00.000Z",
      "2026-03-09T04:00:00.000Z",
      "Mar 2, 2026–Mar 8, 2026",
    ],
    [
      "MONTHLY",
      "America/New_York",
      "2026-03-01T05:00:00.000Z",
      "2026-04-01T04:00:00.000Z",
      "Mar 1, 2026–Mar 31, 2026",
    ],
  ])(
    "uses reporting timezone for %s half-open period",
    async (
      cadence,
      reportingTimezone,
      periodStartInclusive,
      periodEndExclusive,
      label,
    ) => {
      const stored = report({
        id: "50000000-0000-4000-8000-000000000010",
        cadence: cadence as "WEEKLY" | "MONTHLY",
        reportingTimezone,
        periodStartInclusive,
        periodEndExclusive,
        content: "Timezone report content",
      });
      storedReports[listKey("organization", "", cadence)] = [[stored]];
      renderView();
      if (cadence !== "WEEKLY")
        fireEvent.change(screen.getByLabelText("Insight cadence"), {
          target: { value: cadence },
        });
      await waitFor(async () => expect(await periodOptions()).toEqual([label]));
      expect(
        screen.getByText(new RegExp(`Report period: ${label}`)),
      ).toBeTruthy();
    },
  );

  it("isolates organization, branches, inactive history, and cadences in GET requests", async () => {
    renderView();
    await screen.findByRole("heading", { name: "Successful AI summary" });
    const scope = screen.getByLabelText("Insight scope");
    await screen.findByRole("option", { name: "OLD — Old (inactive)" });
    fireEvent.change(scope, { target: { value: A } });
    await waitFor(() =>
      expect(
        storedReportRequests().some(
          ({ url }) =>
            url.includes("scope=branch") && url.includes(`branchId=${A}`),
        ),
      ).toBe(true),
    );
    fireEvent.change(scope, { target: { value: B } });
    await waitFor(() =>
      expect(
        storedReportRequests().some(({ url }) => url.includes(`branchId=${B}`)),
      ).toBe(true),
    );
    fireEvent.change(scope, { target: { value: OLD } });
    await waitFor(() =>
      expect(
        storedReportRequests().some(({ url }) =>
          url.includes(`branchId=${OLD}`),
        ),
      ).toBe(true),
    );
    fireEvent.change(scope, { target: { value: "organization" } });
    fireEvent.change(screen.getByLabelText("Insight cadence"), {
      target: { value: "MONTHLY" },
    });
    await waitFor(() =>
      expect(
        storedReportRequests().some(
          ({ url }) =>
            url.includes("scope=organization") &&
            url.includes("cadence=MONTHLY") &&
            !url.includes("branchId="),
        ),
      ).toBe(true),
    );
    expect(requests.every(({ method }) => method === "GET")).toBe(true);
  });

  it("limits a branch manager to assigned active branch choices", async () => {
    renderView("BRANCH_MANAGER");
    await screen.findByRole("heading", { name: "Successful AI summary" });
    expect(
      screen.queryByRole("option", { name: "All organization branches" }),
    ).toBeNull();
    expect(screen.queryByRole("option", { name: /inactive/ })).toBeNull();
    expect(requests.some(({ url }) => url.includes("includeInactive"))).toBe(
      false,
    );
  });

  it("clears prior report content while another branch or cadence loads", async () => {
    renderView();
    await screen.findByRole("heading", { name: "Successful AI summary" });
    pending = true;
    fireEvent.change(screen.getByLabelText("Insight scope"), {
      target: { value: A },
    });
    expect(screen.getByText("Loading persisted insight…")).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: "Successful AI summary" }),
    ).toBeNull();
    pending = false;
    fireEvent.change(screen.getByLabelText("Insight scope"), {
      target: { value: "organization" },
    });
    await screen.findByRole("heading", { name: "Successful AI summary" });
    pending = true;
    fireEvent.change(screen.getByLabelText("Insight cadence"), {
      target: { value: "MONTHLY" },
    });
    expect(screen.getByText("Loading persisted insight…")).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: "Successful AI summary" }),
    ).toBeNull();
  });
});

describe("Demo Insight card", () => {
  it("renders nothing and announces nothing when its reader is off", async () => {
    demoStatus = 404;
    renderView();
    await screen.findByRole("heading", { name: "Successful AI summary" });
    expect(screen.queryByRole("article", { name: "Demo Insight" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the current error text for other failures", async () => {
    demoStatus = 500;
    renderView();
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Demo Insight could not be loaded.",
    );
  });

  it("shows explicitly labeled demo text separately from stored reports", async () => {
    demoStatus = 200;
    demoResult = {
      mode: "DEMO",
      label: "Demo Insight",
      explanation:
        "Deterministic demo text from computed metrics. Not generated by OpenRouter.",
      content: "Computed revenue 123.45 THB. <b>plain text</b>",
      from: "2026-09-30",
      to: "2026-10-30",
      reportingTimezone: "Asia/Bangkok",
      provider: null,
      providerCalls: 0,
    };
    renderView();
    expect(
      await screen.findByRole("article", { name: "Demo Insight" }),
    ).toBeTruthy();
    expect(screen.getByText(demoResult.content)).toBeTruthy();
    expect(document.querySelector("article b")).toBeNull();
    expect(
      await screen.findByRole("heading", {
        name: "Successful AI summary",
      }),
    ).toBeTruthy();
    expect(requests.every((r) => r.method === "GET")).toBe(true);
  });
});

describe("stored AI insight section", () => {
  it("links to the AI analysis page instead of running an analysis inline", async () => {
    renderView();
    await screen.findByRole("heading", { name: "Successful AI summary" });
    expect(
      screen.getByText(/AI generated summaries of persisted data/),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "analytics views" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Analyze" })).toBeNull();
    const link = screen.getByRole("link", { name: "AI analysis" });
    expect(link.getAttribute("href")).toBe(
      `/app/ai-analysis?organizationId=${ORG}&branchId=${A}`,
    );
    expect(requests.every(({ method }) => method === "GET")).toBe(true);
  });
});
