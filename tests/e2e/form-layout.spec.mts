import { expect, test, type Page, type TestInfo } from "@playwright/test";

import { loadTestDatabaseEnvironment } from "../../apps/api/src/test/database-environment.ts";
import { createTestPrismaClient } from "../../apps/api/src/test/database-harness.ts";
import {
  E2E_BRANCH_ID,
  E2E_ORGANIZATION_ID,
  E2E_OWNER_EMAIL,
  E2E_PASSWORD,
} from "./catalog-fixtures.ts";
import { selectOption } from "./select-helpers.ts";

const scope = `organizationId=${E2E_ORGANIZATION_ID}&branchId=${E2E_BRANCH_ID}`;
const onboardingEmail = "form-onboarding-e2e@example.test";
const workflowEmail = "form-owner-e2e@example.test";
const workflowOrganizationId = "10000000-0000-4000-8000-000000000099";
const workflowBranchId = "20000000-0000-4000-8000-000000000099";
const workflowProductId = "50000000-0000-4000-8000-000000000099";
const workflowScope = `organizationId=${workflowOrganizationId}&branchId=${workflowBranchId}`;

test.beforeAll(async () => {
  const prisma = createTestPrismaClient(loadTestDatabaseEnvironment());
  try {
    await prisma.user.create({
      data: {
        email: onboardingEmail,
        emailVerifiedAt: new Date(),
      },
    });
    // Existing scenarios rely on both shared organizations' initial state.
    // Give this write scenario its own actor and organization.
    const workflowUser = await prisma.user.create({
      data: {
        email: workflowEmail,
        displayName: "Form layout owner",
        emailVerifiedAt: new Date(),
      },
    });
    await prisma.organization.create({
      data: { id: workflowOrganizationId, name: "Form layout store" },
    });
    await prisma.organizationMembership.create({
      data: {
        organizationId: workflowOrganizationId,
        userId: workflowUser.id,
        role: "OWNER",
      },
    });
    await prisma.branch.create({
      data: {
        id: workflowBranchId,
        code: "FORM",
        name: "Form layout branch",
        organizationId: workflowOrganizationId,
      },
    });
    await prisma.supplier.create({
      data: {
        name: "Form layout supplier",
        organizationId: workflowOrganizationId,
      },
    });
    await prisma.product.create({
      data: {
        id: workflowProductId,
        name: "Form layout coffee",
        sku: "FORM-LAYOUT",
        unit: "KG",
        basePrice: "35.0000",
        organizationId: workflowOrganizationId,
      },
    });
    await prisma.inventoryBalance.create({
      data: {
        branchId: workflowBranchId,
        organizationId: workflowOrganizationId,
        productId: workflowProductId,
        quantity: "5",
      },
    });
    await prisma.inventoryCostState.create({
      data: {
        basisState: "UNKNOWN",
        branchId: workflowBranchId,
        organizationId: workflowOrganizationId,
        productId: workflowProductId,
      },
    });
  } finally {
    await prisma.$disconnect();
  }
});

async function signIn(page: Page, email = E2E_OWNER_EMAIL) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/app/);
}

async function inspect(page: Page, info: TestInfo, name: string) {
  const controls = page.locator(
    '[data-slot="input"]:visible, [data-slot="native-select"]:visible, [data-slot="textarea"]:visible',
  );
  await expect(controls.first()).toBeVisible();
  const layout = await controls.evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect();
      const parent = element.parentElement!.getBoundingClientRect();
      return {
        name:
          element.getAttribute("name") ?? element.getAttribute("aria-label"),
        height: box.height,
        textarea: element.tagName === "TEXTAREA",
        contained: box.left >= parent.left - 1 && box.right <= parent.right + 1,
        inPage: box.left >= 0 && box.right <= window.innerWidth,
        numeric: element.classList.contains("form-control--numeric"),
        width: box.width,
      };
    }),
  );
  for (const control of layout) {
    expect(control.contained, `${name}: ${control.name} inside field`).toBe(
      true,
    );
    expect(control.inPage, `${name}: ${control.name} inside page`).toBe(true);
    if (!control.textarea) expect(control.height).toBe(32);
    if (control.numeric) expect(control.width).toBeLessThanOrEqual(192);
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    `${name}: page overflow`,
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath(`${name}.png`),
    fullPage: true,
  });
}

for (const width of [375, 430, 768, 1024, 1280, 1440]) {
  test(`native forms remain proportionate and contained at ${width}px`, async ({
    page,
  }, info) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 900 });
    for (const route of [
      "login",
      "register",
      "verification-resend",
      "forgot-password",
      "reset-password",
    ]) {
      await page.goto(`/${route}`);
      await inspect(page, info, route);
    }
    await page.goto("/register");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.locator("form [role=alert]")).toHaveText(
      "Enter a valid email address.",
    );
    await inspect(page, info, "registration-error");
    await signIn(page, onboardingEmail);
    await page.goto("/onboarding");
    await inspect(page, info, "onboarding");
    await page.context().clearCookies();
    await signIn(page);
    for (const [route, heading] of [
      ["branches", "Branches"],
      ["members", "Members"],
      ["suppliers", "Suppliers"],
      ["sales", "Sales history"],
      ["purchase-orders", "Purchase orders"],
      ["analytics", "Analytics"],
    ]) {
      await page.goto(`/app/${route}?${scope}`);
      await expect(
        page.getByRole("heading", { name: heading, exact: true }).first(),
      ).toBeVisible();
      await inspect(page, info, route!);
    }
    await page
      .getByRole("button", { name: "Forecast / Reorder", exact: true })
      .click();
    await expect(page.getByLabel("Planning lead time")).toBeVisible();
    await inspect(page, info, "forecast-reorder");
    await page
      .getByRole("button", { name: "AI insights", exact: true })
      .click();
    await expect(page.getByLabel("Insight cadence")).toBeVisible();
    await inspect(page, info, "ai-insights");
    await page.goto(`/app/catalog?${scope}`);
    await expect(
      page.getByRole("heading", { name: "Create product", exact: true }),
    ).toBeVisible();
    await inspect(page, info, "catalog-products");
    await page.getByRole("tab", { name: "Categories", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Create category", exact: true }),
    ).toBeVisible();
    await inspect(page, info, "catalog-categories");
    await page.goto(`/app/inventory?${scope}`);
    await page.getByRole("button", { name: /Inventory test tea/ }).click();
    await expect(page.getByLabel("Signed adjustment (EA)")).toBeVisible();
    await inspect(page, info, "inventory-adjustment");
    await page.goto(`/app/pos?${scope}`);
    await page
      .getByRole("button", { name: "Add POS E2E coffee", exact: true })
      .click();
    await expect(page.getByLabel("Amount tendered (THB)")).toBeVisible();
    await inspect(page, info, "pos-cart");
  });
}

test("receiving, confirmation and refund forms fit mobile and desktop", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  await signIn(page, workflowEmail);
  await page.goto(`/app/purchase-orders?${workflowScope}`);
  const draft = page.getByRole("form", { name: "Create draft purchase order" });
  await selectOption(page, draft.getByLabel("Supplier"), {
    label: "Form layout supplier",
  });
  await selectOption(page, draft.getByLabel("Product line 1 product"), {
    value: workflowProductId,
  });
  await draft.getByLabel("Product line 1 quantity (KG)").fill("1.2500");
  await draft
    .getByLabel("Product line 1 expected unit cost (THB)")
    .fill("4.1234");
  await draft
    .getByRole("button", { name: "Create draft purchase order" })
    .click();
  await expect(
    page.getByRole("form", { name: "Save draft changes" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Order purchase order", exact: true })
    .click();
  for (const width of [375, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    const panel = await dialog.locator(":scope > div").boundingBox();
    expect(panel).not.toBeNull();
    expect(
      Math.abs(panel!.x + panel!.width / 2 - width / 2),
    ).toBeLessThanOrEqual(1);
    expect(Math.abs(panel!.y + panel!.height / 2 - 450)).toBeLessThanOrEqual(1);
    expect(panel!.height).toBeLessThan(450);
    await expect(
      dialog.getByRole("button", { name: "Confirm order" }),
    ).toBeInViewport();
    await dialog.screenshot({
      path: info.outputPath(`confirmation-${width}.png`),
    });
  }
  await page.getByRole("button", { name: "Confirm order" }).click();
  await expect(
    page.getByLabel("Form layout coffee actual unit cost"),
  ).toBeVisible();
  for (const width of [375, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await inspect(page, info, `receiving-${width}`);
  }
  await page.getByLabel("Form layout coffee actual unit cost").fill("4.1234");
  await page
    .getByRole("button", { name: "Receive full purchase order" })
    .click();
  for (const width of [375, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    const panel = await dialog.locator(":scope > div").boundingBox();
    expect(panel).not.toBeNull();
    expect(
      Math.abs(panel!.x + panel!.width / 2 - width / 2),
    ).toBeLessThanOrEqual(1);
    expect(Math.abs(panel!.y + panel!.height / 2 - 450)).toBeLessThanOrEqual(1);
    expect(panel!.height).toBeLessThan(450);
    await expect(
      dialog.getByRole("button", { name: "Confirm receive" }),
    ).toBeInViewport();
    await dialog.screenshot({
      path: info.outputPath(`receive-confirmation-${width}.png`),
    });
  }
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await page.goto(`/app/pos?${workflowScope}`);
  await selectOption(page, "Sales VAT status", {
    value: "NOT_REGISTERED",
  });
  await page.getByRole("button", { name: "Save VAT profile" }).click();
  await page
    .getByRole("button", { name: "Add Form layout coffee", exact: true })
    .click();
  await page.getByLabel("Amount tendered (THB)").fill("50.00");
  await page.getByRole("button", { name: "Complete sale" }).click();
  await expect(
    page.getByRole("heading", { name: "Sale completed" }),
  ).toBeVisible();
  const reference = (await page.getByText(/^SALE-/).textContent())!.split(
    " · ",
  )[0]!;
  await page.goto(`/app/sales?${workflowScope}`);
  await page
    .getByRole("row")
    .filter({ hasText: reference })
    .getByRole("button", { name: "View detail" })
    .click();
  await expect(page.getByLabel("Refund quantity")).toBeVisible();
  for (const width of [375, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await inspect(page, info, `refund-${width}`);
  }
});
