import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

import {
  E2E_BRANCH_ID,
  E2E_INVENTORY_PRODUCT_ID,
  E2E_CASHIER_EMAIL,
  E2E_ORGANIZATION_ID,
  E2E_OWNER_EMAIL,
  E2E_PASSWORD,
} from "./catalog-fixtures.ts";
import {
  chooseComboboxOption,
  expectSelectValue,
  selectOption,
} from "./select-helpers.ts";

async function signIn(page: import("@playwright/test").Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app/);
}

test("owner navigates sales, category, and branch analytics at tablet width", async ({
  page,
}) => {
  await signIn(page, E2E_OWNER_EMAIL);
  await page.setViewportSize({ width: 768, height: 900 });
  await page.getByRole("button", { name: "Catalog E2E Store" }).click();
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await page.getByRole("link", { name: "Analytics" }).click();
  await expect(page).toHaveURL(/\/app\/analytics/);
  await expect(page.getByRole("heading", { name: "Analytics" })).toBeVisible();
  await expect(page.getByLabel("Sales analytics")).toBeVisible();
  await expect(
    page.getByRole("table", { name: "Sales by period" }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/analytics-sales-tablet.png",
    fullPage: true,
  });
  const branchRequest = page.waitForResponse(
    (response) =>
      response.url().includes("/analytics/sales?") &&
      response.url().includes("scope=branch"),
  );
  await selectOption(page, "Analytics scope", { value: E2E_BRANCH_ID });
  await branchRequest;
  await selectOption(page, "Analytics scope", { value: "organization" });
  await page.getByRole("button", { name: "Categories" }).click();
  await expect(page.getByLabel("Category analytics")).toBeVisible();
  await expect(page.getByText("Loading categories…")).toBeHidden();
  await page.screenshot({
    path: "test-results/analytics-categories-tablet.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Branches" }).click();
  await expect(page.getByText("Main branch", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Branch analytics")).toContainText("net sales");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/analytics-tablet.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/analytics-mobile.png",
    fullPage: true,
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({
    path: "test-results/analytics-desktop.png",
    fullPage: true,
  });
});

test("cashier sees no analytics navigation and direct link remains inaccessible", async ({
  page,
}) => {
  await signIn(page, E2E_CASHIER_EMAIL);
  await expect(page.getByRole("link", { name: "Analytics" })).toHaveCount(0);
  await page.goto(
    `/app/analytics?organizationId=${E2E_ORGANIZATION_ID}&branchId=${E2E_BRANCH_ID}`,
  );
  await expect(
    page.getByRole("alert").filter({ hasText: "Analytics is not available" }),
  ).toContainText("Analytics is not available");
});

test("owner reads a stored AI report safely on mobile", async ({ page }) => {
  await signIn(page, E2E_OWNER_EMAIL);
  await page.route(/\/ai-insights\?/, async (route) => {
    expect(route.request().method()).toBe("GET");
    const success = {
      id: "30000000-0000-4000-8000-000000000001",
      cadence: "WEEKLY",
      reportingTimezone: "Asia/Bangkok",
      periodStartInclusive: "2026-09-20T17:00:00.000Z",
      periodEndExclusive: "2026-09-27T17:00:00.000Z",
      state: "SUCCEEDED",
      content: "<script>alert('x')</script>\n<b>hello</b>",
      failureCategory: null,
      generatedAt: "2026-09-27T23:01:00.000Z",
      completedAt: "2026-09-27T23:01:00.000Z",
    };
    await route.fulfill({
      json: { data: [success], meta: { nextCursor: null } },
    });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Catalog E2E Store" }).click();
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await page.getByRole("link", { name: "Analytics" }).click();
  await page.getByRole("button", { name: "AI insights" }).click();
  await expectSelectValue(
    page.getByLabel("Report period"),
    "Sep 21, 2026–Sep 27, 2026",
  );
  await expect(page.getByText(/Report period: Sep 21, 2026/)).toBeVisible();
  await expect(page.locator("article")).toContainText(
    "<script>alert('x')</script>",
  );
  await expect(page.locator("article script, article b")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/analytics-ai-insights-mobile.png",
    fullPage: true,
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole("button", { name: "Sales" }).click();
  await expect(page.getByLabel("Sales analytics")).toBeVisible();
});

test("owner selects a Branch/Product and lead time for deterministic advisory status", async ({
  page,
}) => {
  await signIn(page, E2E_OWNER_EMAIL);
  await page.getByRole("button", { name: "Catalog E2E Store" }).click();
  await page.getByRole("link", { name: "Analytics" }).click();
  await page.getByRole("button", { name: "Forecast / Reorder" }).click();
  await expect(
    page.getByRole("region", { name: "Forecast and reorder", exact: true }),
  ).toBeVisible();
  await selectOption(page, page.getByRole("combobox", { name: /^Branch\b/ }), {
    value: E2E_BRANCH_ID,
  });
  await chooseComboboxOption(
    page,
    // The wrapping <label> also holds the clear/show-options buttons, so the
    // combobox accessible name can carry more than the label text alone.
    page.getByRole("combobox", { name: /^Product\b/ }),
    "Inventory test tea",
    { value: E2E_INVENTORY_PRODUCT_ID },
  );
  await selectOption(page, "Planning lead time", { value: "7" });
  await expect(page.getByLabel("Forecast result")).toContainText(
    "forecast-sale-mean-28d-v1",
  );
  await expect(page.getByLabel("Reorder result")).toContainText("reorder-v1");
  await expect(
    page.getByLabel("Forecast and reorder limitations"),
  ).toContainText("never places an order");
  await page.screenshot({
    path: "test-results/analytics-forecast-reorder.png",
    fullPage: true,
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("cashier cannot call forecast or reorder API directly", async ({
  page,
}) => {
  await signIn(page, E2E_CASHIER_EMAIL);
  for (const path of ["forecast", "reorder-recommendations"]) {
    const leadTime = path === "forecast" ? "" : "&leadTimeDays=7";
    const response = await page.request.get(
      `/api/v1/organizations/${E2E_ORGANIZATION_ID}/analytics/${path}?branchId=${E2E_BRANCH_ID}&productId=${E2E_INVENTORY_PRODUCT_ID}${leadTime}`,
    );
    expect(response.status()).toBe(403);
  }
});

test("owner reads scoped inventory availability, movement, and classification", async ({
  page,
}) => {
  await signIn(page, E2E_OWNER_EMAIL);
  await page.getByRole("button", { name: "Catalog E2E Store" }).click();
  await page.getByRole("link", { name: "Analytics" }).click();
  await page.getByRole("button", { name: "Inventory" }).click();
  const inventory = page.getByLabel("Inventory analytics");
  await expect(
    inventory.getByRole("heading", { name: "Current branch availability" }),
  ).toBeVisible();
  await expect(
    inventory.getByRole("heading", { name: "Product movement and coverage" }),
  ).toBeVisible();
  await expect(inventory.getByText("Active products").first()).toBeVisible();
  const firstProduct = inventory.locator("details").first();
  await firstProduct.locator("summary").click();
  await expect(firstProduct.getByText(/Stock classification/)).toBeVisible();
  await expect(
    firstProduct.getByRole("table", { name: /Movement by period/ }),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("dimension load-more controls send opaque cursors in a real browser", async ({
  page,
}) => {
  await signIn(page, E2E_OWNER_EMAIL);
  await page.getByRole("button", { name: "Catalog E2E Store" }).click();
  const seenCursors: string[] = [];
  await page.route(/\/analytics\/(categories|branches)\?/, async (route) => {
    const url = new URL(route.request().url());
    const dimension = url.pathname.endsWith("categories")
      ? "categories"
      : "branches";
    const cursor = url.searchParams.get("cursor");
    if (cursor) seenCursors.push(`${dimension}:${cursor}`);
    url.searchParams.delete("cursor");
    url.pathname = url.pathname.replace(/\/(categories|branches)$/, "/sales");
    const sales = await (await route.fetch({ url: url.toString() })).json();
    const buckets = sales.data.buckets;
    const second = cursor !== null;
    const row =
      dimension === "categories"
        ? {
            categoryId: second
              ? "40000000-0000-4000-8000-000000000002"
              : "40000000-0000-4000-8000-000000000001",
            categoryKind: "CATEGORY",
            categoryName: second ? "Second category" : "First category",
            categoryStatus: "ACTIVE",
            buckets: buckets.map((bucket: Record<string, unknown>) => ({
              dataStatus: bucket.dataStatus,
              bucketEndExclusive: bucket.bucketEndExclusive,
              bucketStartInclusive: bucket.bucketStartInclusive,
              discountAmount: bucket.discountAmount,
              grossSalesAmount: bucket.grossSalesAmount,
              label: bucket.label,
              localEndExclusive: bucket.localEndExclusive,
              localStartInclusive: bucket.localStartInclusive,
              netSalesAmount: bucket.netSalesAmount,
              refundAmount: bucket.refundAmount,
              salesAfterDiscountAmount: bucket.salesAfterDiscountAmount,
              categorySharePercent: { value: null, reason: "NO_SALES" },
            })),
          }
        : {
            branchId: second
              ? "20000000-0000-4000-8000-000000000099"
              : E2E_BRANCH_ID,
            branchName: second ? "Second branch" : "First branch",
            branchStatus: "ACTIVE",
            buckets,
          };
    await route.fulfill({
      json: {
        data:
          dimension === "categories"
            ? { categories: [row] }
            : { branches: [row] },
        meta: {
          ...sales.meta,
          ...(dimension === "branches"
            ? {
                includedBranchCount: 2,
                includedBranchIds: [
                  E2E_BRANCH_ID,
                  "20000000-0000-4000-8000-000000000099",
                ],
              }
            : {}),
          nextCursor: second ? null : `opaque-${dimension}`,
        },
      },
    });
  });
  await page.getByRole("link", { name: "Analytics" }).click();
  await page.getByRole("button", { name: "Categories" }).click();
  await expect(page.getByText("First category")).toBeVisible();
  await page.getByRole("button", { name: "Load more categories" }).click();
  await expect(page.getByText("Second category")).toBeVisible();
  await page.getByRole("button", { name: "Branches" }).click();
  await expect(page.getByText("First branch", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Load more branches" }).click();
  await expect(page.getByText("Second branch", { exact: true })).toBeVisible();
  expect(seenCursors).toEqual([
    "categories:opaque-categories",
    "branches:opaque-branches",
  ]);
});
