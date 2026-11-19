import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

import {
  E2E_BRANCH_ID,
  E2E_CASHIER_EMAIL,
  E2E_ORGANIZATION_ID,
  E2E_OWNER_EMAIL,
  E2E_PASSWORD,
} from "./catalog-fixtures.ts";
import { selectOption } from "./select-helpers.ts";

const catalogPath = `/app/catalog?organizationId=${E2E_ORGANIZATION_ID}&branchId=${E2E_BRANCH_ID}`;

async function signIn(page: import("@playwright/test").Page, email: string) {
  await page.goto("/login?next=%2Fapp");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app/);
}

test("owner manages the catalog through the same-origin application path", async ({
  page,
}) => {
  await signIn(page, E2E_OWNER_EMAIL);
  await page.goto(catalogPath);
  await expect(page.getByRole("heading", { name: "Catalog" })).toBeVisible();

  await page.getByRole("button", { name: "Categories" }).click();
  await page.getByLabel("Category name").first().fill("Drinks");
  await page.getByRole("button", { name: "Create category" }).click();
  await expect(page.getByRole("heading", { name: "Drinks" })).toBeVisible();

  await page.getByRole("button", { name: "Products" }).click();
  await page.getByLabel("Product name").first().fill("Green tea");
  await page.getByLabel("SKU").first().fill("TEA-E2E-01");
  await page.getByLabel("Base price").first().fill("12.3400");
  await page.getByLabel("Barcode (optional)").first().fill("0012345678905");
  await selectOption(page, page.getByLabel("Category (optional)").first(), {
    label: "Drinks",
  });
  await page.getByRole("button", { name: "Create product" }).click();
  await expect(page.getByRole("heading", { name: "Green tea" })).toBeVisible();
  await expect(page.getByText("TEA-E2E-01 · 12.34 · EA")).toBeVisible();

  await page.getByLabel("Search catalog").fill("TEA-E2E");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByRole("heading", { name: "Green tea" })).toBeVisible();

  const productForm = page.getByRole("form", {
    name: "Edit product Green tea",
  });
  await expect(productForm.getByLabel("Barcode (optional)")).toHaveValue(
    "0012345678905",
  );
  await productForm
    .getByRole("button", { name: "Preview barcode labels" })
    .click();
  const labelPreview = page.getByRole("dialog", {
    name: "Barcode label preview",
  });
  await expect(
    labelPreview.getByRole("img", { name: "Code 128 barcode 0012345678905" }),
  ).toBeVisible();
  await labelPreview.getByLabel("Label quantity").fill("3");
  await expect(labelPreview.getByRole("article")).toHaveCount(3);
  await page.evaluate(() => {
    window.print = () => {
      document.body.dataset.labelPrintCalled = "true";
    };
  });
  await labelPreview.getByRole("button", { name: "Print labels" }).click();
  await expect(page.locator("body")).toHaveAttribute(
    "data-label-print-called",
    "true",
  );
  await page.emulateMedia({ media: "print" });
  await expect(page.getByRole("complementary")).toBeHidden();
  await expect(
    labelPreview.getByRole("button", { name: "Print labels" }),
  ).toBeHidden();
  await page.emulateMedia({ media: "screen" });
  await labelPreview.getByRole("button", { name: "Back to catalog" }).click();
  await expect(labelPreview).toHaveCount(0);
  await productForm.getByLabel("Product name").fill("Green tea updated");
  await productForm.getByRole("button", { name: "Save changes" }).click();
  await expect(
    page.getByRole("heading", { name: "Green tea updated" }),
  ).toBeVisible();

  const updatedProductForm = page.getByRole("form", {
    name: "Edit product Green tea updated",
  });
  await updatedProductForm.getByRole("button", { name: "Deactivate" }).click();
  await selectOption(page, "Status", { value: "INACTIVE" });
  await expect(
    page.getByRole("heading", { name: "Green tea updated" }),
  ).toBeVisible();
  await expect(updatedProductForm.getByText("Inactive")).toBeVisible();
  await selectOption(page, "Status", { value: "ALL" });
  await updatedProductForm.getByRole("button", { name: "Reactivate" }).click();
  await expect(updatedProductForm.getByText("Active")).toBeVisible();
});

test("cashier receives only the accepted catalog view UX", async ({ page }) => {
  await signIn(page, E2E_CASHIER_EMAIL);
  await page.goto(catalogPath);

  await expect(page.getByRole("heading", { name: "Catalog" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Create product" }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Deactivate" })).toHaveCount(0);
  await expect(page.getByLabel("Status")).toHaveCount(0);
});

test("catalog views have no automated axe violations on desktop and mobile", async ({
  page,
}) => {
  await signIn(page, E2E_OWNER_EMAIL);
  await page.goto(catalogPath);
  await expect(page.getByRole("heading", { name: "Catalog" })).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await page.getByRole("button", { name: "Categories" }).click();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await page.setViewportSize({ height: 844, width: 390 });
  await page.getByRole("button", { name: "Products" }).click();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
