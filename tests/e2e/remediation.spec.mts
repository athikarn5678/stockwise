import { expect, test, type Locator, type Page } from "@playwright/test";
import { createTestPrismaClient } from "../../apps/api/src/test/database-harness.ts";
import { loadTestDatabaseEnvironment } from "../../apps/api/src/test/database-environment.ts";
import {
  E2E_BRANCH_ID,
  E2E_INVENTORY_PRODUCT_ID,
  E2E_ORGANIZATION_ID,
  E2E_OWNER_EMAIL,
  E2E_PASSWORD,
} from "./catalog-fixtures.ts";
import { selectOption } from "./select-helpers.ts";

const prisma = createTestPrismaClient(loadTestDatabaseEnvironment());
test.afterAll(async () => prisma.$disconnect());
function path(resource: string) {
  return `/app/${resource}?organizationId=${E2E_ORGANIZATION_ID}&branchId=${E2E_BRANCH_ID}`;
}
async function signIn(page: Page) {
  await page.goto("/login?next=%2Fapp");
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Email").fill(E2E_OWNER_EMAIL);
  await page.getByLabel("Password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app/);
}
async function fits(page: Page) {
  const measurements = await page.evaluate(() => ({
    viewport: window.innerWidth,
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
    containers: [
      ...document.querySelectorAll<HTMLElement>(
        'main, form fieldset, aside, aside li, aside li input, section[aria-label="Sales history"] > div, section[aria-label="Sales history"] th:last-child',
      ),
    ].map((node) => ({
      tag: node.tagName,
      class: node.className,
      client: node.clientWidth,
      scroll: node.scrollWidth,
      width: node.getBoundingClientRect().width,
      parentClient: node.parentElement?.clientWidth,
    })),
    overflowing: [...document.querySelectorAll<HTMLElement>("main *")]
      .filter(
        (node) =>
          node.getBoundingClientRect().right >
          document.documentElement.clientWidth + 1,
      )
      .map((node) => ({
        tag: node.tagName,
        text: node.textContent?.slice(0, 65),
        class: node.className,
        client: node.clientWidth,
        scroll: node.scrollWidth,
        right: node.getBoundingClientRect().right,
        minWidth: getComputedStyle(node).minWidth,
        position: getComputedStyle(node).position,
        parent: node.parentElement?.tagName,
      }))
      .slice(0, 20),
  }));
  console.log(JSON.stringify({ test: test.info().title, ...measurements }));
  await expect
    .poll(() =>
      page.evaluate(() => ({
        client: document.documentElement.clientWidth,
        scroll: document.documentElement.scrollWidth,
      })),
    )
    .toMatchObject({
      scroll: await page.evaluate(() => document.documentElement.clientWidth),
    });
}
async function controlFits(page: Page, control: Locator) {
  await control.scrollIntoViewIfNeeded();
  const box = await control.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(
    await page.evaluate(() => document.documentElement.clientWidth),
  );
}

test("MT-002 successful Supplier create sends one POST, persists one row and clears the form", async ({
  page,
}) => {
  await signIn(page);
  await page.goto(path("suppliers"));
  const create = page
    .getByRole("heading", { name: "Create supplier" })
    .locator("..");
  await create.getByLabel("Supplier name").fill("REM01 Supplier");
  await create.getByLabel("Contact name (optional)").fill("Synthetic buyer");
  await create.getByLabel("Email (optional)").fill("rem01@example.test");
  await create.getByLabel("Phone (optional)").fill("020000010");
  await create.getByLabel("Address (optional)").fill("Synthetic address");
  let posts = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().endsWith(`/organizations/${E2E_ORGANIZATION_ID}/suppliers`)
    )
      posts++;
  });
  await create.getByRole("button", { name: "Create supplier" }).click();
  await expect(
    page.getByRole("heading", { name: "REM01 Supplier" }),
  ).toBeVisible();
  await expect(create.getByLabel("Supplier name")).toHaveValue("");
  await expect(page.locator("main").getByRole("alert")).toHaveCount(0);
  expect(posts).toBe(1);
  expect(
    await prisma.supplier.count({
      where: { organizationId: E2E_ORGANIZATION_ID, name: "REM01 Supplier" },
    }),
  ).toBe(1);
});

test("MT-004 PO create, selected lines, edit and detail fit mobile and desktop", async ({
  page,
}) => {
  await signIn(page);
  await page.goto(path("purchase-orders"));
  const create = page.getByRole("form", {
    name: "Create draft purchase order",
  });
  await selectOption(page, create.getByLabel("Supplier"), {
    label: "Purchase order E2E supplier",
  });
  await selectOption(page, create.getByLabel("Product line 1 product"), {
    value: E2E_INVENTORY_PRODUCT_ID,
  });
  await create.getByLabel("Product line 1 quantity (EA)").fill("2");
  await create
    .getByLabel("Product line 1 expected unit cost (THB)")
    .fill("12.5");
  for (const width of [390, 375, 768, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await fits(page);
    await controlFits(page, create.getByLabel("Product line 1 product"));
    await controlFits(page, create.getByLabel("Product line 1 quantity (EA)"));
    await controlFits(
      page,
      create.getByLabel("Product line 1 expected unit cost (THB)"),
    );
  }
  await create
    .getByRole("button", { name: "Create draft purchase order" })
    .click();
  const edit = page.getByRole("form", { name: "Save draft changes" });
  await expect(edit).toBeVisible();
  for (const width of [390, 375, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await fits(page);
    await controlFits(page, edit.getByLabel("Product line 1 product"));
  }
  await edit.getByLabel("Product line 1 quantity (EA)").fill("3");
  await page.setViewportSize({ width: 375, height: 844 });
  await page.screenshot({
    path: test.info().outputPath("po-mobile-edit.png"),
    fullPage: true,
  });
  await edit.getByRole("button", { name: "Save draft changes" }).click();
  await page.getByRole("button", { name: "Order purchase order" }).click();
  await page.getByRole("button", { name: "Confirm order" }).click();
  await expect(page.getByText("Frozen product lines")).toBeVisible();
  for (const width of [390, 375, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await fits(page);
  }
});

test("MT-005 populated POS keeps quantity, removal, totals and payment usable at mobile/tablet/desktop", async ({
  page,
}) => {
  await signIn(page);
  await page.goto(path("pos"));
  await page.getByLabel("Search products").fill("POS-E2E-03");
  await page.getByRole("button", { name: "Search" }).click();
  await page.getByRole("button", { name: "Add POS E2E coffee" }).click();
  const quantity = page.getByLabel("Quantity for POS E2E coffee (EA)");
  for (const width of [390, 375, 768, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await fits(page);
    await controlFits(page, quantity);
    await controlFits(
      page,
      page.getByRole("button", { name: "Increase POS E2E coffee quantity" }),
    );
    await controlFits(
      page,
      page.getByRole("button", { name: "Decrease POS E2E coffee quantity" }),
    );
    await controlFits(
      page,
      page.getByRole("button", { name: "Remove POS E2E coffee from cart" }),
    );
    await controlFits(page, page.getByLabel("Amount tendered (THB)"));
    await expect(
      page.getByText("Current-price subtotal", { exact: true }),
    ).toBeVisible();
    if (width === 375 || width === 768) {
      await page.screenshot({
        path: test.info().outputPath(`pos-${width}.png`),
        fullPage: true,
      });
    }
  }
  await page.setViewportSize({ width: 375, height: 844 });
  await page
    .getByRole("button", { name: "Increase POS E2E coffee quantity" })
    .click();
  await expect(quantity).toHaveValue("2");
  await page
    .getByRole("button", { name: "Decrease POS E2E coffee quantity" })
    .click();
  await expect(quantity).toHaveValue("1");
  await page
    .getByRole("button", { name: "Remove POS E2E coffee from cart" })
    .click();
  await expect(page.getByLabel("Cart items")).toHaveCount(0);
});

test("MT-006/007 populated Sales list, detail and receipt fit mobile with accepted timezone copy", async ({
  page,
}) => {
  await signIn(page);
  await page.goto(path("pos"));
  await selectOption(page, "Sales VAT status", {
    value: "NOT_REGISTERED",
  });
  await page.getByRole("button", { name: "Save VAT profile" }).click();
  await page.getByLabel("Search products").fill("POS-E2E-03");
  await page.getByRole("button", { name: "Search" }).click();
  await page.getByRole("button", { name: "Add POS E2E coffee" }).click();
  await page.getByLabel("Amount tendered (THB)").fill("50");
  await page.getByRole("button", { name: "Complete sale" }).click();
  await expect(
    page.getByRole("heading", { name: "Sale completed" }),
  ).toBeVisible();
  await page.goto(path("sales"));
  await expect(
    page.getByRole("heading", { name: "Sales history" }),
  ).toBeVisible();
  for (const width of [390, 375, 768, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await fits(page);
  }
  await page.setViewportSize({ width: 375, height: 844 });
  await page.getByRole("button", { name: "View detail" }).first().click();
  await expect(page.getByLabel("Printable receipt")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Print receipt" }),
  ).toBeVisible();
  await fits(page);
  await page.screenshot({
    path: test.info().outputPath("sales-mobile-detail.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1280, height: 844 });
  await fits(page);
  await expect(page.locator("main")).not.toContainText("OQ-016");
});
