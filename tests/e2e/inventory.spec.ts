import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

import {
  E2E_BRANCH_ID,
  E2E_CASHIER_EMAIL,
  E2E_ORGANIZATION_ID,
  E2E_OWNER_EMAIL,
  E2E_PASSWORD,
} from "./catalog-fixtures.ts";

const inventoryPath = `/app/inventory?organizationId=${E2E_ORGANIZATION_ID}&branchId=${E2E_BRANCH_ID}`;

async function signIn(page: import("@playwright/test").Page, email: string) {
  await page.goto("/login?next=%2Fapp");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app/);
}

test("owner adjusts a branch balance and sees the immutable movement", async ({
  page,
}) => {
  await signIn(page, E2E_OWNER_EMAIL);
  await page.goto(inventoryPath);
  await expect(
    page.getByRole("heading", { name: "Inventory", exact: true }),
  ).toBeVisible();
  const productCard = page.getByRole("button", { name: /Inventory test tea/ });
  await productCard.click();
  await expect(
    productCard.getByText("No persisted balance (zero)"),
  ).toBeVisible();

  const form = page.getByRole("form", {
    name: "Adjust stock for Inventory test tea",
  });
  await form.getByLabel("Signed adjustment (EA)").fill("+2");
  await form.getByLabel("Reason").selectOption("FOUND");
  await form.getByRole("button", { name: "Submit adjustment" }).click();

  await expect(page.getByText("2 EA").last()).toBeVisible();
  await expect(page.getByText("+2 · FOUND")).toBeVisible();
});

test("cashier has the inventory view without an adjustment action", async ({
  page,
}) => {
  await signIn(page, E2E_CASHIER_EMAIL);
  await page.goto(inventoryPath);
  await page.getByRole("button", { name: /Inventory test tea/ }).click();

  await expect(
    page.getByRole("form", { name: "Adjust stock for Inventory test tea" }),
  ).toHaveCount(0);
  await expect(
    page.getByText(/can view inventory but cannot adjust stock/i),
  ).toBeVisible();
});

test("inventory has no automated axe violations on desktop and mobile", async ({
  page,
}) => {
  await signIn(page, E2E_OWNER_EMAIL);
  await page.goto(inventoryPath);
  await page.getByRole("button", { name: /Inventory test tea/ }).click();
  // Axe must not sample colours mid-transition (the selected row fades in).
  await page.addStyleTag({
    content:
      "*,*::before,*::after{transition:none!important;animation:none!important}",
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await page.setViewportSize({ height: 844, width: 390 });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
