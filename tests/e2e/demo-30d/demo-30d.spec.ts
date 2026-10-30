import { readFileSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";
import { z } from "../../../apps/api/node_modules/zod/index.js";

const stateFile = process.env.DEMO30D_BROWSER_STATE;
if (!stateFile)
  throw new Error(
    "DEMO30D_BROWSER_STATE must identify the separately prepared disposable local fixture.",
  );
const state = z
  .object({
    organizationId: z.uuid(),
    branchId: z.uuid(),
    otherBranchId: z.uuid(),
    otherOrganizationId: z.uuid(),
    productId: z.uuid(),
  })
  .parse(JSON.parse(readFileSync(stateFile, "utf8")));
const scope = `organizationId=${state.organizationId}&branchId=${state.branchId}`;
const roles = [
  "OWNER",
  "ADMIN",
  "BRANCH_MANAGER",
  "INVENTORY_STAFF",
  "CASHIER",
] as const;

async function login(page: Page, role: (typeof roles)[number]) {
  await page.goto("/login");
  await page
    .getByLabel("Email address", { exact: true })
    .fill(`demo30d-${role.toLowerCase()}@example.invalid`);
  await page
    .getByLabel("Password", { exact: true })
    .fill("synthetic-demo30d-password-only");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/app(?:\?|$)/);
  await page.goto(`/app?${scope}`);
  await expect(
    page.getByRole("link", { name: "Inventory", exact: true }),
  ).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem("stockwise.language"))
      localStorage.setItem("stockwise.language", "en");
  });
});

for (const role of roles) {
  test(`${role} navigation matches API permissions on a real Chromium session`, async ({
    page,
  }) => {
    await login(page, role);
    const management = ["OWNER", "ADMIN", "BRANCH_MANAGER"].includes(role);
    await expect(
      page.getByRole("link", { name: "Catalog", exact: true }),
    ).toHaveCount(role === "INVENTORY_STAFF" ? 0 : 1);
    await expect(
      page.getByRole("link", { name: "Suppliers", exact: true }),
    ).toHaveCount(management ? 1 : 0);
    await expect(
      page.getByRole("link", { name: "Purchase orders", exact: true }),
    ).toHaveCount(management ? 1 : 0);
    const response = await page.request.get(
      `/api/v1/organizations/${state.organizationId}/analytics/forecast?branchId=${state.branchId}&productId=${state.productId}`,
    );
    expect(response.status()).toBe(management ? 200 : 403);
    await page.goto(`/app/inventory?${scope}`);
    await expect(page.getByText("Daily Rice", { exact: true })).toBeVisible();
  });
}

test("inventory staff direct URLs are denied while Inventory analytics remains useful", async ({
  page,
}) => {
  await login(page, "INVENTORY_STAFF");
  for (const path of ["catalog", "suppliers", "purchase-orders"]) {
    await page.goto(`/app/${path}?${scope}`);
    await expect(page.getByRole("alert").first()).toBeVisible();
  }
  await page.goto(`/app/analytics?${scope}`);
  await expect(
    page.getByRole("region", { name: "Inventory analytics", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Forecast / Reorder", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "AI insights", exact: true }),
  ).toHaveCount(0);
  const denied = await page.request.get(
    `/api/v1/organizations/${state.organizationId}/branches/${state.otherBranchId}/inventory`,
  );
  expect(denied.status()).toBe(403);
  await page.screenshot({
    path: test.info().outputPath("inventory-staff.png"),
    fullPage: true,
  });
});

test("owner sees 30 real daily analytics buckets, sales history, forecast and reorder", async ({
  page,
}) => {
  await login(page, "OWNER");
  await page.goto(`/app/sales?${scope}`);
  await expect(page.getByText(/SALE-/).first()).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("sales-history.png"),
    fullPage: true,
  });
  await page.goto(`/app/analytics?${scope}`);
  await page.getByLabel("From (inclusive)", { exact: true }).fill("2026-09-30");
  await page.getByLabel("To (exclusive)", { exact: true }).fill("2026-10-30");
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().includes("/analytics/sales?") &&
      response.url().includes("from=2026-09-30") &&
      response.url().includes("to=2026-10-30"),
  );
  await page.getByRole("button", { name: "Apply period", exact: true }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  const body = z
    .object({
      data: z.object({
        buckets: z.array(
          z.object({ saleCount: z.number(), netSalesAmount: z.string() }),
        ),
      }),
    })
    .parse(await response.json());
  expect(body.data.buckets).toHaveLength(30);
  expect(body.data.buckets.reduce((n, b) => n + b.saleCount, 0)).toBe(436);
  await expect(
    page.getByRole("img", { name: "Net sales trend chart", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("daily-analytics.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Forecast / Reorder", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Product", exact: true })
    .selectOption(state.productId);
  await expect(page.getByText(/EA total/)).toBeVisible();
  await page
    .getByRole("combobox", { name: "Planning lead time", exact: true })
    .selectOption("7");
  await expect(page.getByText(/Recommend .* EA/)).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("forecast-reorder.png"),
    fullPage: true,
  });
});

test("computed Demo Insight is labeled in English and Thai and hidden from an unrelated organization", async ({
  page,
}) => {
  await login(page, "OWNER");
  await page.goto(`/app/analytics?${scope}`);
  await page.getByRole("button", { name: "AI insights", exact: true }).click();
  const article = page.getByRole("article", {
    name: "Demo Insight",
    exact: true,
  });
  await expect(article).toBeVisible();
  await expect(article).toContainText("Not generated by OpenRouter.");
  await expect(article).toContainText("436 sales");
  await expect(article).toContainText("Top products by base unit");
  await expect(article).toContainText("Low-stock branch/product pairs");
  await page.screenshot({
    path: test.info().outputPath("demo-insight-en.png"),
    fullPage: true,
  });
  const response = await page.request.get(
    `/api/v1/organizations/${state.otherOrganizationId}/ai-insights/demo?scope=organization&language=en`,
  );
  expect(response.status()).toBe(404);
  await page.evaluate(() => localStorage.setItem("stockwise.language", "th"));
  // Reload preserves the application's normal language preference behavior.
  await page.reload();
  await page
    .getByRole("button", { name: "ข้อมูลเชิงลึกจาก AI", exact: true })
    .click();
  await expect(
    page.getByRole("article", { name: "ข้อมูลตัวอย่าง", exact: true }),
  ).toBeVisible();
  const thaiTextFits = await page
    .getByRole("article", { name: "ข้อมูลตัวอย่าง", exact: true })
    .locator("p")
    .last()
    .evaluate((element) => element.scrollWidth <= element.clientWidth + 1);
  expect(thaiTextFits).toBe(true);
  await page.screenshot({
    path: test.info().outputPath("demo-insight-th.png"),
    fullPage: true,
  });
});
