import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

import {
  E2E_BRANCH_ID,
  E2E_CASHIER_EMAIL,
  E2E_INVENTORY_PRODUCT_ID,
  E2E_ORGANIZATION_ID,
  E2E_OWNER_EMAIL,
  E2E_PASSWORD,
  E2E_PURCHASE_PRODUCT_ID,
} from "./catalog-fixtures.ts";
import { selectOption } from "./select-helpers.ts";

const purchaseOrderPath = `/app/purchase-orders?organizationId=${E2E_ORGANIZATION_ID}&branchId=${E2E_BRANCH_ID}`;
const inventoryPath = `/app/inventory?organizationId=${E2E_ORGANIZATION_ID}&branchId=${E2E_BRANCH_ID}`;

async function signIn(page: import("@playwright/test").Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app/);
}

async function createDraft(page: import("@playwright/test").Page) {
  const form = page.getByRole("form", { name: "Create draft purchase order" });
  await selectOption(page, form.getByLabel("Supplier"), {
    label: "Purchase order E2E supplier",
  });
  await selectOption(page, form.getByLabel("Product line 1 product"), {
    value: E2E_INVENTORY_PRODUCT_ID,
  });
  await form.getByLabel("Product line 1 quantity (EA)").fill("2");
  await form
    .getByLabel("Product line 1 expected unit cost (THB)")
    .fill("12.5000");
  await form.getByRole("button", { name: "Add product line" }).click();
  await selectOption(page, form.getByLabel("Product line 2 product"), {
    value: E2E_PURCHASE_PRODUCT_ID,
  });
  await form.getByLabel("Product line 2 quantity (KG)").fill("0.5");
  await form.getByLabel("Product line 2 expected unit cost (THB)").fill("8");
  await form
    .getByRole("button", { name: "Create draft purchase order" })
    .click();
  await expect(
    page.getByRole("form", { name: "Save draft changes" }),
  ).toBeVisible();
}

test("owner creates, edits, orders, and cancels purchase orders", async ({
  page,
}) => {
  await signIn(page, E2E_OWNER_EMAIL);
  await page.goto(purchaseOrderPath);
  await expect(
    page.getByRole("heading", { name: "Purchase orders" }),
  ).toBeVisible();

  await createDraft(page);
  const edit = page.getByRole("form", { name: "Save draft changes" });
  await edit.getByLabel("Expected date (optional)").fill("2026-09-15");
  await edit.getByRole("button", { name: "Save draft changes" }).click();
  await page.getByRole("button", { name: "Order purchase order" }).click();
  await page.getByRole("button", { name: "Confirm order" }).click();
  await expect(page.getByText("Frozen product lines")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Receive full purchase order" }),
  ).toBeVisible();
  await expect(
    page.getByRole("form", { name: "Save draft changes" }),
  ).toHaveCount(0);

  await createDraft(page);
  await page.getByRole("button", { name: "Cancel purchase order" }).click();
  await page.getByRole("button", { name: "Confirm cancellation" }).click();
  await expect(
    page.getByText(/Commercial fields are read-only in Cancelled status/),
  ).toBeVisible();
});

test("cashier cannot manage purchase orders", async ({ page }) => {
  await signIn(page, E2E_CASHIER_EMAIL);
  await page.goto(purchaseOrderPath);
  await expect(
    page.getByText("You do not have permission to manage purchase orders."),
  ).toBeVisible();
  await expect(
    page.getByRole("form", { name: "Create draft purchase order" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Receive full purchase order" }),
  ).toHaveCount(0);
});

test("owner receives an ORDERED purchase order with a bounded VAT snapshot", async ({
  page,
}) => {
  await signIn(page, E2E_OWNER_EMAIL);
  await page.goto(purchaseOrderPath);
  await createDraft(page);
  await page.getByRole("button", { name: "Order purchase order" }).click();
  await page.getByRole("button", { name: "Confirm order" }).click();

  await expect(
    page.getByRole("heading", { name: "Receive full purchase order" }),
  ).toBeVisible();
  await expect(page.getByText("Quantity: 2")).toBeVisible();
  await expect(page.getByText("Quantity: 0.5")).toBeVisible();
  await expect(
    page.getByLabel("Inventory test tea actual unit cost"),
  ).toBeVisible();
  await expect(
    page.getByLabel("Purchase order E2E coffee actual unit cost"),
  ).toBeVisible();
  await expect(
    page
      .getByRole("group", { name: "Inventory test tea · INVENTORY-E2E-01" })
      .getByRole("textbox"),
  ).toHaveCount(1);

  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.setViewportSize({ height: 844, width: 390 });
  await expect(
    page.getByLabel("Inventory test tea actual unit cost"),
  ).toBeVisible();
  await expect(page.getByLabel("Input VAT rate")).toBeVisible();
  expect(
    await page
      .getByRole("heading", { name: "Receive full purchase order" })
      .locator("..")
      .evaluate((panel) => panel.scrollWidth <= panel.clientWidth),
  ).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.setViewportSize({ height: 900, width: 1280 });

  await page.getByLabel("Inventory test tea actual unit cost").fill("12.5000");
  await page
    .getByLabel("Purchase order E2E coffee actual unit cost")
    .fill("8.0000");
  await page
    .getByLabel("Organization VAT registration asserted for this receipt")
    .check();
  await page.getByLabel("Input VAT rate").fill("7.000000");
  await page.getByLabel("Input VAT amount").fill("2.0300");
  await page.getByLabel("Supplier tax document number").fill("TAX-E2E-100");
  await page.getByLabel("Supplier tax document date").fill("2026-09-02");

  await page
    .getByRole("button", { name: "Receive full purchase order" })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Confirm irreversible receipt",
  });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(
    dialog.getByRole("button", { name: "Confirm receive" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(page.getByText(/Receipt RCPT-/)).toBeVisible();
  await expect(
    page.getByText(/The purchase order is now RECEIVED/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Receive full purchase order" }),
  ).toHaveCount(0);
  await expect(page.getByText("Received").last()).toBeVisible();

  await page.goto(inventoryPath);
  await page.getByRole("button", { name: /Purchase order E2E coffee/ }).click();
  await expect(page.getByText("0.5 KG").last()).toBeVisible();
});

test("purchase-order UI has no automated axe violations on desktop and mobile", async ({
  page,
}) => {
  await signIn(page, E2E_OWNER_EMAIL);
  await page.goto(purchaseOrderPath);
  await expect(
    page.getByRole("heading", { name: "Purchase orders" }),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.setViewportSize({ height: 844, width: 390 });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
