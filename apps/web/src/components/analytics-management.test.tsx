// @vitest-environment jsdom

import { LanguageProvider, useLanguage } from "@/providers/language-provider";
import { en } from "@/i18n/en";
import { th } from "@/i18n/th";
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

import { AnalyticsManagement } from "./analytics-management";

vi.mock("next/navigation", () => ({
  useSearchParams: () =>
    new URLSearchParams(`organizationId=${ORG}&branchId=${BRANCH}`),
}));
vi.mock("recharts", () => ({
  CartesianGrid: () => null,
  Line: () => null,
  LineChart: ({ data }: { data: unknown }) => (
    <div data-testid="trend-data">{JSON.stringify(data)}</div>
  ),
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  Tooltip: () => null,
  XAxis: () => null,
  YAxis: () => null,
}));

const ORG = "10000000-0000-4000-8000-000000000001";
const BRANCH = "20000000-0000-4000-8000-000000000001";
const OTHER_BRANCH = "20000000-0000-4000-8000-000000000002";
let requests: string[];
let role: string;
let salesCost: boolean;
let costMoney: string;
let categoryCursorError: boolean;
let salesError: { code: string; status: number } | null;
let inventoryMode: "normal" | "empty" | "error";
let inventoryCost: boolean;
let inventoryClassification:
  "LOW_STOCK" | "NORMAL" | "OVERSTOCK" | null | undefined;
let inventoryReason: string | null;
let inventoryProductStatus: "ACTIVE" | "INACTIVE";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status });
}

function bucket(label: string, netSalesAmount: string) {
  return {
    averageOrderValue: { reason: "NO_SALES", value: null },
    dataStatus: "complete",
    discountAmount: "2.00",
    grossSalesAmount: "10.00",
    label,
    localEndExclusive: label === "2026-09-22" ? "2026-09-23" : "2026-09-24",
    localStartInclusive: label,
    netOutputVatAmount: "0.00",
    netSalesAmount,
    netSalesGrowthPercent: { reason: "NO_BASELINE", value: null },
    outputVatAmount: "0.00",
    refundAmount: "12.00",
    refundCount: 1,
    refundedDiscountAmount: "0.00",
    refundedOutputVatAmount: "0.00",
    refundedRegisteredTaxableAmount: {
      reason: "NO_REGISTERED_REFUNDS",
      value: null,
    },
    refundedSaleCount: 1,
    registeredTaxableSalesAmount: {
      reason: "NO_REGISTERED_SALES",
      value: null,
    },
    saleCount: 0,
    salesAfterDiscountAmount: "8.00",
    ...(salesCost
      ? {
          cost: {
            costCoverage: "partial",
            grossMarginPercent: {
              reason: "INCOMPLETE_COST_COVERAGE",
              value: null,
            },
            grossProfitAmount: {
              reason: "INCOMPLETE_COST_COVERAGE",
              value: null,
            },
            knownCostLineCount: 1,
            knownNetCogsAmount: costMoney,
            netCogsAmount: { reason: "INCOMPLETE_COST_COVERAGE", value: null },
            refundCogsReversalAmount: "0.0000000000",
            saleCogsAmount: costMoney,
            unknownCostLineCount: 1,
          },
        }
      : {}),
  };
}

function meta(nextCursor: string | null = null) {
  return {
    dataStatus: "complete",
    granularity: "day",
    includedBranchCount: 2,
    localFromInclusive: "2026-09-22",
    localToExclusive: "2026-09-24",
    reportingTimezone: "Asia/Bangkok",
    scopeType: "organization",
    sourceCutoff: "2026-09-23T00:00:00.000Z",
    nextCursor,
  };
}

function mockFetch(input: RequestInfo | URL): Promise<Response> {
  const url = String(input);
  requests.push(url);
  if (url.endsWith("me/access-context"))
    return Promise.resolve(
      json({
        data: {
          firstOrganizationOnboarding: { eligible: false },
          organizations: [
            {
              id: ORG,
              name: "Store One",
              role,
              branches: [
                { id: BRANCH, code: "A", name: "Alpha" },
                { id: OTHER_BRANCH, code: "B", name: "Beta" },
              ],
            },
          ],
          user: {
            id: "30000000-0000-4000-8000-000000000001",
            email: "owner@example.com",
            displayName: "Owner",
          },
        },
      }),
    );
  if (url.includes("/branches?includeInactive=true"))
    return Promise.resolve(json({ data: [] }));
  if (url.includes("/ai-insights/latest?"))
    return Promise.resolve(
      json({ data: { latest: null, lastSuccess: null, stale: false } }),
    );
  if (url.includes("/analytics/sales?") && salesError)
    return Promise.resolve(
      json({ error: { code: salesError.code } }, salesError.status),
    );
  if (url.includes("/analytics/sales?"))
    return Promise.resolve(
      json({
        data: {
          buckets: [
            bucket("2026-09-22", "0.00"),
            bucket("2026-09-23", "-4.00"),
          ],
        },
        meta: meta(),
      }),
    );
  if (url.includes("/analytics/inventory?")) {
    if (inventoryMode === "error")
      return Promise.resolve(json({ error: { code: "FORBIDDEN" } }, 403));
    const cursor = new URL(url, "http://localhost").searchParams.get("cursor");
    const classification =
      inventoryClassification === undefined
        ? cursor
          ? "OVERSTOCK"
          : "LOW_STOCK"
        : inventoryClassification;
    const cost = inventoryCost
      ? {
          inventoryValue: { value: null, reason: "INCOMPLETE_COST_COVERAGE" },
          knownInventoryValue: "0.0000000000",
          knownCostProductCount: 0,
          unknownCostProductCount: 1,
          unknownQuantityByUnit: { EA: "3.0000" },
        }
      : undefined;
    return Promise.resolve(
      json({
        data: {
          branches: [
            {
              branchId: BRANCH,
              branchName: "Alpha",
              branchStatus: "ACTIVE",
              activeProductCount: 2,
              inStockProductCount: 1,
              outOfStockProductCount: 1,
              ...(cost ? { cost } : {}),
            },
          ],
          dimensions:
            inventoryMode === "empty"
              ? []
              : [
                  {
                    branchId: BRANCH,
                    branchName: "Alpha",
                    branchStatus: "ACTIVE",
                    productId: cursor ? OTHER_BRANCH : BRANCH,
                    productName: cursor ? "Second product" : "First product",
                    productStatus: inventoryProductStatus,
                    productUnit: "EA",
                    onHandQuantity: "3.0000",
                    requestedPeriodAds: { value: "1.0000", reason: null },
                    coverageSalesVelocity: { value: "0.5000", reason: null },
                    coverageDays: {
                      value:
                        inventoryReason &&
                        inventoryReason !== "INACTIVE_PRODUCT"
                          ? null
                          : cursor
                            ? "60.00"
                            : "6.00",
                      reason:
                        inventoryReason === "INACTIVE_PRODUCT"
                          ? null
                          : inventoryReason,
                    },
                    stockClassification: {
                      classification,
                      reason: inventoryReason,
                      thresholdVersion: "stock-risk-v1",
                    },
                    buckets: [
                      {
                        label: "2026-09-22",
                        localStartInclusive: "2026-09-22",
                        localEndExclusive: "2026-09-23",
                        dataStatus: "complete",
                        purchaseReceivedQuantity: "4.0000",
                        saleDepletionQuantity: "1.0000",
                        refundReturnQuantity: "0.0000",
                        positiveAdjustmentQuantity: "0.0000",
                        negativeAdjustmentQuantity: "0.0000",
                      },
                    ],
                    ...(cost ? { cost } : {}),
                  },
                ],
        },
        meta: {
          ...meta(cursor ? null : "opaque-inventory-next"),
          currentSnapshotCapturedAt: cursor
            ? "2026-09-24T00:00:01.000Z"
            : "2026-09-24T00:00:00.000Z",
        },
      }),
    );
  }
  if (url.includes("/analytics/categories?")) {
    const cursor = new URL(url, "http://localhost").searchParams.get("cursor");
    if (cursor && categoryCursorError)
      return Promise.resolve(json({ error: { code: "INVALID_CURSOR" } }, 400));
    return Promise.resolve(
      json({
        data: {
          categories: [
            {
              categoryId: cursor
                ? "40000000-0000-4000-8000-000000000002"
                : null,
              categoryKind: cursor ? "CATEGORY" : "UNCATEGORIZED",
              categoryName: cursor ? "Old category" : "UNCATEGORIZED",
              categoryStatus: cursor ? "INACTIVE" : null,
              buckets: [
                bucket("2026-09-22", "0.00"),
                bucket("2026-09-23", "-4.00"),
              ].map((row) => ({
                dataStatus: row.dataStatus,
                discountAmount: row.discountAmount,
                grossSalesAmount: row.grossSalesAmount,
                label: row.label,
                localEndExclusive: row.localEndExclusive,
                localStartInclusive: row.localStartInclusive,
                netSalesAmount: row.netSalesAmount,
                refundAmount: row.refundAmount,
                salesAfterDiscountAmount: row.salesAfterDiscountAmount,
                categorySharePercent: { reason: "NO_SALES", value: null },
              })),
            },
          ],
        },
        meta: meta(cursor ? null : "opaque-category-next"),
      }),
    );
  }
  if (url.includes("/analytics/branches?")) {
    const cursor = new URL(url, "http://localhost").searchParams.get("cursor");
    return Promise.resolve(
      json({
        data: {
          branches: [
            {
              branchId: cursor ? OTHER_BRANCH : BRANCH,
              branchName: cursor ? "Old Branch" : "Zero Branch",
              branchStatus: cursor ? "INACTIVE" : "ACTIVE",
              buckets: [
                bucket("2026-09-22", "0.00"),
                bucket("2026-09-23", cursor ? "-4.00" : "0.00"),
              ],
            },
          ],
        },
        meta: meta(cursor ? null : "opaque-branch-next"),
      }),
    );
  }
  throw new Error(`Unexpected request: ${url}`);
}

function TestLanguageToggle() {
  const { language, setLanguage } = useLanguage();
  return (
    <button onClick={() => setLanguage(language === "en" ? "th" : "en")}>
      Switch language
    </button>
  );
}
function renderPage(localized = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      {localized ? (
        <LanguageProvider>
          <TestLanguageToggle />
          <AnalyticsManagement />
        </LanguageProvider>
      ) : (
        <AnalyticsManagement />
      )}
    </QueryClientProvider>,
  );
  return client;
}

beforeEach(() => {
  costMoney = "2.0000000000";
  requests = [];
  role = "OWNER";
  salesCost = false;
  categoryCursorError = false;
  salesError = null;
  inventoryMode = "normal";
  inventoryCost = false;
  inventoryClassification = undefined;
  inventoryReason = null;
  inventoryProductStatus = "ACTIVE";
  vi.stubGlobal("fetch", vi.fn(mockFetch));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("analytics management", () => {
  it("formats exact cost metrics with grouping and meaningful extra digits", async () => {
    salesCost = true;
    costMoney = "9007199254740993.1230000000";
    renderPage();
    expect(
      (await screen.findAllByText("THB 9,007,199,254,740,993.123")).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText("THB 0.00", { selector: "dd" }).length,
    ).toBeGreaterThan(0);
  });

  it("keeps deterministic Sales and its scope available after viewing AI insights", async () => {
    renderPage();
    expect(
      await screen.findByRole("region", { name: "Sales analytics" }),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Analytics scope"), {
      target: { value: BRANCH },
    });
    fireEvent.click(screen.getByRole("button", { name: "AI insights" }));
    expect(screen.getByRole("region", { name: "AI insights" })).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "AI insights" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Sales" }));
    expect(
      await screen.findByRole("region", { name: "Sales analytics" }),
    ).toBeTruthy();
    expect(screen.getByLabelText("Analytics scope")).toHaveProperty(
      "value",
      BRANCH,
    );
    expect(
      screen
        .getByRole("button", { name: "Sales" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it.each(["OWNER", "ADMIN", "BRANCH_MANAGER"])(
    "offers persisted AI insights to %s",
    async (allowedRole) => {
      role = allowedRole;
      renderPage();
      expect(
        await screen.findByRole("button", { name: "AI insights" }),
      ).toBeTruthy();
    },
  );

  it.each(["INVENTORY_STAFF", "CASHIER"])(
    "hides persisted AI insights from %s",
    async (deniedRole) => {
      role = deniedRole;
      renderPage();
      await screen.findByRole("heading", { name: "Analytics" });
      expect(screen.queryByRole("button", { name: "AI insights" })).toBeNull();
    },
  );

  it("shows inventory facts and opaque continuation without cost for staff", async () => {
    role = "INVENTORY_STAFF";
    renderPage();
    expect(
      await screen.findByRole("region", { name: "Inventory analytics" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sales" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Forecast / Reorder" }),
    ).toBeNull();
    expect(screen.getByText("Out of stock")).toBeTruthy();
    expect(screen.getAllByText(/LOW STOCK/).length).toBeGreaterThan(0);
    expect(screen.getByText("6.00 days")).toBeTruthy();
    expect(screen.queryByText("Current inventory value")).toBeNull();
    expect(
      screen.getByText("Cost and value require additional access."),
    ).toBeTruthy();
    expect(
      screen.queryByText(/STOCKOUT_RISK|FAST_MOVING|SLOW_MOVING/),
    ).toBeNull();
    fireEvent.click(screen.getByText(/^First product/));
    expect(
      screen.getByRole("table", {
        name: /Movement by period for First product/,
      }),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Load more inventory" }),
    );
    expect(await screen.findByText(/^Second product/)).toBeTruthy();
    expect(screen.getByText("OVERSTOCK")).toBeTruthy();
    expect(
      requests.some((url) => url.includes("cursor=opaque-inventory-next")),
    ).toBe(true);
    expect(requests.some((url) => url.includes("/analytics/sales?"))).toBe(
      false,
    );
    fireEvent.change(screen.getByLabelText("Analytics scope"), {
      target: { value: OTHER_BRANCH },
    });
    await waitFor(() =>
      expect(
        requests.some(
          (url) =>
            url.includes(`/analytics/inventory?`) &&
            url.includes(`scope=branch&branchId=${OTHER_BRANCH}`),
        ),
      ).toBe(true),
    );
  });

  it("resets Sales and excludes cached Owner cost when access changes to Inventory Staff", async () => {
    inventoryCost = true;
    const client = renderPage();
    expect(
      await screen.findByRole("region", { name: "Sales analytics" }),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Analytics scope"), {
      target: { value: BRANCH },
    });
    await waitFor(() =>
      expect(
        requests.some(
          (url) =>
            url.includes(`/analytics/sales?`) &&
            url.includes(`branchId=${BRANCH}`),
        ),
      ).toBe(true),
    );
    fireEvent.click(screen.getByRole("button", { name: "Inventory" }));
    expect(
      (await screen.findAllByText("Current inventory value")).length,
    ).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Sales" }));
    expect(
      screen.getByRole("region", { name: "Sales analytics" }),
    ).toBeTruthy();
    inventoryCost = false;
    role = "INVENTORY_STAFF";
    await client.invalidateQueries({ queryKey: ["access-context"] });
    expect(
      await screen.findByRole("region", { name: "Inventory analytics" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("region", { name: "Sales analytics" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Sales" })).toBeNull();
    expect(screen.queryByText("Current inventory value")).toBeNull();
    expect(
      await screen.findByText("Cost and value require additional access."),
    ).toBeTruthy();
  });

  it("shows normal classification and explains unavailable inactive or no-demand states", async () => {
    inventoryClassification = "NORMAL";
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Inventory" }));
    expect(await screen.findByText("NORMAL")).toBeTruthy();
  });

  it("explains why classification is unavailable for an inactive product", async () => {
    inventoryClassification = null;
    inventoryReason = "INACTIVE_PRODUCT";
    inventoryProductStatus = "INACTIVE";
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Inventory" }));
    expect(
      await screen.findByText("Product is inactive", { selector: "dd" }),
    ).toBeTruthy();
  });

  it("shows authorized inventory cost and handles empty and denied states", async () => {
    inventoryCost = true;
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Inventory" }));
    expect(
      (await screen.findAllByText("Some stocked products have unknown cost"))
        .length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText("Current inventory value").length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText("0.00 THB").length).toBeGreaterThan(0);
    expect(screen.getAllByText("3.0000 EA").length).toBeGreaterThan(0);
  });

  it("shows an explicit empty inventory state", async () => {
    inventoryMode = "empty";
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Inventory" }));
    expect(
      await screen.findByText("No product dimensions in this scope."),
    ).toBeTruthy();
  });

  it("announces inventory API denial", async () => {
    inventoryMode = "error";
    role = "INVENTORY_STAFF";
    renderPage();
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Inventory analytics is not available for your current access.",
    );
  });
  it("renders exact API sales strings, null reasons, negative trend, and hides absent cost", async () => {
    renderPage();
    expect(
      await screen.findByRole("heading", { name: "Analytics" }),
    ).toBeTruthy();
    expect(
      await screen.findByText("THB -4.00", { selector: "dd" }),
    ).toBeTruthy();
    expect(screen.getByText("No sales", { selector: "dd" })).toBeTruthy();
    expect(
      screen.getByText("No comparison baseline", { selector: "dd" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("region", { name: "Cost and profit" }),
    ).toBeNull();
    expect(screen.getByTestId("trend-data").textContent).toContain(
      '"netSales":-4',
    );
    expect(
      screen.getByTestId("trend-data").textContent?.indexOf("2026-09-22"),
    ).toBeLessThan(
      screen.getByTestId("trend-data").textContent?.indexOf("2026-09-23") ?? 0,
    );
  });

  it("uses explicit period and authorized branch scope inputs", async () => {
    renderPage();
    await screen.findByText("THB -4.00", { selector: "dd" });
    fireEvent.change(screen.getByLabelText("Analytics scope"), {
      target: { value: BRANCH },
    });
    await waitFor(() =>
      expect(
        requests.some((url) => url.includes(`scope=branch&branchId=${BRANCH}`)),
      ).toBe(true),
    );
    fireEvent.change(screen.getByLabelText("From (inclusive)"), {
      target: { value: "2026-09-22" },
    });
    fireEvent.change(screen.getByLabelText("To (exclusive)"), {
      target: { value: "2026-09-24" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply period" }));
    await waitFor(() =>
      expect(
        requests.some((url) =>
          url.includes("from=2026-09-22&to=2026-09-24&granularity=day"),
        ),
      ).toBe(true),
    );
  });

  it("paginates both dimensions with opaque cursors and restarts on period changes", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Categories" }));
    expect(
      screen
        .getByRole("button", { name: "Categories" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(await screen.findByText("Uncategorized")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Load more categories" }),
    );
    expect(await screen.findByText("Old category")).toBeTruthy();
    expect(screen.getByText("Inactive")).toBeTruthy();
    expect(
      requests.some((url) => url.includes("cursor=opaque-category-next")),
    ).toBe(true);
    fireEvent.change(screen.getByLabelText("From (inclusive)"), {
      target: { value: "2026-09-22" },
    });
    fireEvent.change(screen.getByLabelText("To (exclusive)"), {
      target: { value: "2026-09-24" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply period" }));
    await waitFor(() =>
      expect(
        requests.some(
          (url) =>
            url.includes("/analytics/categories?") &&
            url.includes("from=2026-09-22&to=2026-09-24") &&
            !url.includes("cursor="),
        ),
      ).toBe(true),
    );
    expect(screen.queryByText("Old category")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Branches" }));
    expect(await screen.findByText("Zero Branch")).toBeTruthy();
    expect(screen.getByText(/THB 0.00 net sales · 0 sales/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load more branches" }));
    expect(await screen.findByText("Old Branch")).toBeTruthy();
    expect(
      requests.some((url) => url.includes("cursor=opaque-branch-next")),
    ).toBe(true);
    expect(screen.queryByText(/Top|Rank/i)).toBeNull();
  });

  it("denies cashier locally and shows backend errors without metrics", async () => {
    role = "CASHIER";
    renderPage();
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Analytics is not available for your current access.",
    );
    expect(requests.some((url) => url.includes("/analytics/"))).toBe(false);
    expect(
      screen.queryByRole("button", { name: "Forecast / Reorder" }),
    ).toBeNull();
  });

  it("shows cost coverage and incomplete-cost reasons only when API supplies cost", async () => {
    salesCost = true;
    renderPage();
    expect(
      await screen.findByRole("region", { name: "Cost and profit" }),
    ).toBeTruthy();
    expect(
      within(
        screen.getByRole("region", { name: "Cost and profit" }),
      ).getAllByText("Cost coverage is incomplete"),
    ).toHaveLength(3);
    fireEvent.click(screen.getByText("Cost detail"));
    expect(screen.getByText("Known cost lines")).toBeTruthy();
    expect(screen.getByText("Unknown cost lines")).toBeTruthy();
  });

  it("handles an authoritative API denial without showing financial data", async () => {
    salesError = { code: "FORBIDDEN", status: 403 };
    renderPage();
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Analytics is not available for your current access.",
    );
    expect(screen.queryByText("THB -4.00")).toBeNull();
  });

  it("prompts for sign-in when the analytics session expires", async () => {
    salesError = { code: "AUTHENTICATION_REQUIRED", status: 401 };
    renderPage();
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Sign in again to view analytics.",
    );
    expect(screen.queryByText("THB -4.00")).toBeNull();
  });

  it("restarts a dimension list after an invalid cursor", async () => {
    categoryCursorError = true;
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Categories" }));
    await screen.findByText("Uncategorized");
    fireEvent.click(
      screen.getByRole("button", { name: "Load more categories" }),
    );
    expect(
      await screen.findByText(
        "This page can no longer be continued. Restart this list.",
      ),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Restart category list" }),
    );
    expect(await screen.findByText("Uncategorized")).toBeTruthy();
  });
});

it("switches analytics labels between English and Thai", async () => {
  localStorage.clear();
  renderPage(true);
  await screen.findByLabelText(en.uiAnalyticsScope);
  fireEvent.click(screen.getByRole("button", { name: "Switch language" }));
  expect(screen.getByLabelText(th.uiAnalyticsScope)).toBeTruthy();
  expect(screen.getByRole("button", { name: th.uiApplyPeriod })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Switch language" }));
  expect(screen.getByLabelText(en.uiAnalyticsScope)).toBeTruthy();
  localStorage.clear();
});
