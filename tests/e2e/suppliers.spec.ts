import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {
  E2E_BRANCH_ID,
  E2E_CASHIER_EMAIL,
  E2E_MANAGER_EMAIL,
  E2E_OTHER_ORGANIZATION_ID,
  E2E_ORGANIZATION_ID,
  E2E_OWNER_EMAIL,
  E2E_PASSWORD,
} from "./catalog-fixtures.ts";
import { selectOption } from "./select-helpers.ts";

const supplierPath = `/app/suppliers?organizationId=${E2E_ORGANIZATION_ID}&branchId=${E2E_BRANCH_ID}`;
const otherSupplierPath = `/app/suppliers?organizationId=${E2E_OTHER_ORGANIZATION_ID}`;
async function signIn(page: import("@playwright/test").Page, email: string) {
  await page.goto("/login?next=%2Fapp");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app/);
}

test("owner creates, edits, filters, and changes Supplier lifecycle", async ({
  page,
}) => {
  await signIn(page, E2E_OWNER_EMAIL);
  await page.goto(supplierPath);
  await expect(page.getByRole("heading", { name: "Suppliers" })).toBeVisible();
  const create = page
    .getByRole("heading", { name: "Create supplier" })
    .locator("..");
  await create.getByLabel("Supplier name").fill("Tea Supply");
  await create.getByLabel("Email (optional)").fill("SALES@EXAMPLE.TEST");
  await create.getByRole("button", { name: "Create supplier" }).click();
  await expect(page.getByRole("heading", { name: "Tea Supply" })).toBeVisible();
  await page.goto(otherSupplierPath);
  await expect(page.getByText("No suppliers match this view.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Tea Supply" })).toHaveCount(
    0,
  );
  await page.goto(supplierPath);
  await expect(page.getByRole("heading", { name: "Tea Supply" })).toBeVisible();
  const card = () =>
    page
      .getByRole("heading", { name: "Tea Supply" })
      .locator("..")
      .locator("..");
  await card().getByLabel("Phone (optional)").fill("02-123");
  await card().getByRole("button", { name: "Save changes" }).click();
  await card().getByRole("button", { name: "Deactivate" }).click();
  await selectOption(page, "Status", { value: "INACTIVE" });
  await expect(page.getByRole("heading", { name: "Tea Supply" })).toBeVisible();
  await expect(card().getByText("Inactive")).toBeVisible();
  await card().getByRole("button", { name: "Reactivate" }).click();
  await selectOption(page, "Status", { value: "ACTIVE" });
  await expect(page.getByRole("heading", { name: "Tea Supply" })).toBeVisible();
  await expect(card().getByText("Active")).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("manager may edit Suppliers but cashier receives no Supplier access", async ({
  page,
}) => {
  await signIn(page, E2E_MANAGER_EMAIL);
  await page.goto(supplierPath);
  await expect(page.getByRole("heading", { name: "Suppliers" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Create supplier" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Deactivate" })).toHaveCount(0);
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page).toHaveURL("/login");
  await signIn(page, E2E_CASHIER_EMAIL);
  await page.goto(supplierPath);
  await expect(
    page.getByText("You do not have permission to access suppliers."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Create supplier" }),
  ).toHaveCount(0);
});
