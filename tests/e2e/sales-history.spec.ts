import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

import {
  E2E_BRANCH_ID,
  E2E_CASHIER_EMAIL,
  E2E_ORGANIZATION_ID,
  E2E_OWNER_EMAIL,
  E2E_PASSWORD,
} from "./catalog-fixtures.ts";

const posPath = `/app/pos?organizationId=${E2E_ORGANIZATION_ID}&branchId=${E2E_BRANCH_ID}`;
const salesPath = `/app/sales?organizationId=${E2E_ORGANIZATION_ID}&branchId=${E2E_BRANCH_ID}`;

async function signIn(
  page: import("@playwright/test").Page,
  email = E2E_OWNER_EMAIL,
) {
  await page.goto("/login?next=%2Fapp");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app/);
}

test("owner creates a linked refund that cashiers can review without mutation controls", async ({
  page,
}) => {
  await signIn(page);
  await page.goto(posPath);
  await page.getByLabel("Sales VAT status").selectOption("NOT_REGISTERED");
  await page.getByRole("button", { name: "Save VAT profile" }).click();
  await page.getByLabel("Search products").fill("POS-E2E-03");
  await page.getByRole("button", { name: "Search" }).click();
  await page.getByRole("button", { name: "Add POS E2E coffee" }).click();
  await page.getByLabel("Amount tendered (THB)").fill("50.00");
  await page.getByRole("button", { name: "Complete sale" }).click();
  const reference = (await page.getByText(/^SALE-/).textContent())?.split(
    " · ",
  )[0];
  expect(reference).not.toBeNull();

  await page.goto(salesPath);
  await expect(
    page.getByRole("heading", { name: "Sales history" }),
  ).toBeVisible();
  await expect(page.getByText(reference!)).toBeVisible();
  await page.getByRole("button", { name: "View detail" }).first().click();
  const receipt = page.getByLabel("Printable receipt");
  await expect(receipt.getByText("POS E2E coffee")).toBeVisible();
  await expect(receipt.getByText(/Tendered THB 50.00/)).toBeVisible();
  await expect(receipt).not.toContainText(/COGS|cost/i);
  await page.getByLabel("Refund quantity").fill("1");
  await page.getByLabel("Restock quantity").fill("1");
  await page.getByLabel("Reason").fill("E2E customer return");
  await page
    .getByRole("button", { name: "Confirm irreversible refund" })
    .click();
  const refundHistory = page.locator(
    'section[aria-labelledby="refund-history-heading"]',
  );
  const refundReference = refundHistory.getByText(/^REFUND-/).first();
  await expect(refundReference).toBeVisible();
  await expect(refundHistory).toContainText("FULLY REFUNDED");
  await expect(receipt).not.toContainText(/REFUND-|refund/i);
  await page.evaluate(() => {
    window.print = () => {
      document.documentElement.dataset.printed = "true";
    };
  });
  await page.getByRole("button", { name: "Print receipt" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-printed", "true");

  await page.context().clearCookies();
  await signIn(page, E2E_CASHIER_EMAIL);
  await page.goto(salesPath);
  await expect(page.getByText(reference!)).toBeVisible();
  await page.getByRole("button", { name: "View detail" }).first().click();
  await expect(page.getByText(/^REFUND-/).first()).toBeVisible();
  await expect(
    page.getByRole("form", { name: "Create sale refund" }),
  ).toHaveCount(0);
  await expect(page.getByLabel("Printable receipt")).not.toContainText(
    /REFUND-|refund|COGS|cost/i,
  );
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("sales history is accessible and fits a narrow tablet", async ({
  page,
}) => {
  await signIn(page);
  await page.goto(salesPath);
  await expect(
    page.getByRole("heading", { name: "Sales history" }),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.setViewportSize({ height: 844, width: 768 });
  await expect(
    page
      .locator("main")
      .evaluate((main) => main.scrollWidth <= main.clientWidth),
  ).resolves.toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("exact monetary displays stay consistent from catalog through receiving and receipt", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  await signIn(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  const scope = `organizationId=${E2E_ORGANIZATION_ID}&branchId=${E2E_BRANCH_ID}`;
  await page.goto(`/app/catalog?${scope}`);
  const create = page
    .getByRole("heading", { name: "Create product" })
    .locator("..");
  for (const [name, price, display] of [
    ["Money integer", "4.0000", "4.00"],
    ["Money precision", "4.1230", "4.123"],
    ["Money fourth", "4.1234", "4.1234"],
  ]) {
    await create.getByLabel("Product name").fill(name!);
    await create.getByLabel("SKU").fill(name!.replace(" ", "-"));
    await create.getByLabel("Base price").fill(price!);
    await create
      .getByRole("combobox", { name: "Unit", exact: true })
      .selectOption("KG");
    await create.getByRole("button", { name: "Create product" }).click();
    await expect(
      page.getByText(
        `${name!.replace(" ", "-").toUpperCase()} · ${display} · KG`,
      ),
    ).toBeVisible();
    const editor = page.getByRole("form", { name: `Edit product ${name}` });
    await expect(editor.getByLabel("Base price")).toHaveValue(price!);
    await editor.screenshot({
      path: testInfo.outputPath(`${name!.replace(" ", "-").toLowerCase()}.png`),
    });
  }
  await page.screenshot({
    path: testInfo.outputPath("money-catalog.png"),
    fullPage: true,
  });

  await page.goto(`/app/purchase-orders?${scope}`);
  const draft = page.getByRole("form", { name: "Create draft purchase order" });
  await draft
    .getByLabel("Supplier")
    .selectOption({ label: "Purchase order E2E supplier" });
  await draft
    .getByLabel("Product line 1 product")
    .selectOption({ label: "Money precision · MONEY-PRECISION (KG)" });
  await draft.getByLabel("Product line 1 quantity (KG)").fill("1.25");
  await draft
    .getByLabel("Product line 1 expected unit cost (THB)")
    .fill("4.1230");
  await draft
    .getByRole("button", { name: "Create draft purchase order" })
    .click();
  await expect(
    page.getByRole("form", { name: "Save draft changes" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Order purchase order" }).click();
  await page.getByRole("button", { name: "Confirm order" }).click();
  await expect(page.getByText("Expected: 4.123 THB")).toBeVisible();
  await page.getByLabel("Money precision actual unit cost").fill("4.5000");
  await page.screenshot({
    path: testInfo.outputPath("money-receiving.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Receive full purchase order" })
    .click();
  await page.getByRole("button", { name: "Confirm receive" }).click();
  await expect(
    page.getByText(/Money precision: 1.25 at 4.50 THB/),
  ).toBeVisible();

  await page.goto(posPath);
  await page.getByLabel("Sales VAT status").selectOption("NOT_REGISTERED");
  await page.getByRole("button", { name: "Save VAT profile" }).click();
  await page.getByLabel("Search products").fill("MONEY-PRECISION");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByText("THB 4.123", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add Money precision" }).click();
  await page.getByLabel("Amount tendered (THB)").fill("5.00");
  await page.screenshot({
    path: testInfo.outputPath("money-pos.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Complete sale" }).click();
  await expect(
    page.getByRole("heading", { name: "Sale completed" }),
  ).toBeVisible();
  await expect(
    page.getByText("THB 4.12", { exact: true }).first(),
  ).toBeVisible();
  const reference = (await page.getByText(/^SALE-/).textContent())!.split(
    " · ",
  )[0]!;
  await page.goto(salesPath);
  const row = page.getByRole("row").filter({ hasText: reference });
  await row.getByRole("button", { name: "View detail" }).click();
  const receipt = page.getByLabel("Printable receipt");
  await expect(receipt).toContainText("THB 4.123");
  await expect(receipt).toContainText("1.0000 KG");
  await expect(receipt).not.toContainText("4.1230");
  await receipt.screenshot({ path: testInfo.outputPath("money-receipt.png") });
  await page.screenshot({
    path: testInfo.outputPath("money-sale-receipt.png"),
    fullPage: true,
  });

  await page.goto(`/app/analytics?${scope}`);
  await page.getByRole("button", { name: "Inventory", exact: true }).click();
  const product = page.locator("details").filter({
    has: page.locator("summary").filter({ hasText: "Money precision" }),
  });
  await product.locator("summary").click();
  await expect(product).toContainText("1.125 THB");
  await product.screenshot({
    path: testInfo.outputPath("money-product-value.png"),
  });
  await page.screenshot({
    path: testInfo.outputPath("money-inventory-value.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
