import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

import {
  E2E_BRANCH_ID,
  E2E_ORGANIZATION_ID,
  E2E_OWNER_EMAIL,
  E2E_PASSWORD,
} from "./catalog-fixtures.ts";

const posPath = `/app/pos?organizationId=${E2E_ORGANIZATION_ID}&branchId=${E2E_BRANCH_ID}`;

async function signIn(page: import("@playwright/test").Page) {
  await page.goto("/login?next=%2Fapp");
  await page.getByLabel("Email").fill(E2E_OWNER_EMAIL);
  await page.getByLabel("Password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app/);
}

test("owner configures VAT, searches, and completes a cash POS sale", async ({
  page,
}) => {
  await signIn(page);
  await page.goto(posPath);
  await expect(
    page.getByRole("heading", { name: "Point of sale" }),
  ).toBeVisible();
  const posAlert = page.locator("main").getByRole("alert");
  await expect(posAlert).toContainText(/VAT profile/i);

  await page.getByLabel("Sales VAT status").selectOption("NOT_REGISTERED");
  await page.getByRole("button", { name: "Save VAT profile" }).click();
  await expect(posAlert).toHaveCount(0);

  await page.getByLabel("Search products").fill("POS-E2E-03");
  await page.getByRole("button", { name: "Search" }).click();
  await page.getByRole("button", { name: "Add POS E2E coffee" }).click();
  await page.getByLabel("Amount tendered (THB)").fill("50.00");
  await page.getByRole("button", { name: "Complete sale" }).click();

  await expect(
    page.getByRole("heading", { name: "Sale completed" }),
  ).toBeVisible();
  await expect(page.getByText(/SALE-/)).toBeVisible();
  await expect(page.getByText(/change THB 15.00/)).toBeVisible();
});

test("POS has no automated axe violations on desktop and narrow tablet", async ({
  page,
}) => {
  await signIn(page);
  await page.goto(posPath);
  await expect(
    page.getByRole("heading", { name: "Point of sale" }),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.setViewportSize({ height: 844, width: 768 });
  await expect(
    page.getByRole("heading", { name: "Point of sale" }),
  ).toBeVisible();
  expect(
    await page
      .locator("main")
      .evaluate((main) => main.scrollWidth <= main.clientWidth),
  ).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
