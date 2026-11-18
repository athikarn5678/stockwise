import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import type { SalesHistoryDetail } from "../../apps/web/src/sales-api-client";

const organizationId = "10000000-0000-4000-8000-000000000001";
const branchId = "20000000-0000-4000-8000-000000000001";
const saleId = "30000000-0000-4000-8000-000000000001";
const scope = `organizationId=${organizationId}&branchId=${branchId}`;

function receiptSale(count = 3, longNames = false): SalesHistoryDetail {
  const cents = 1235n * BigInt(count);
  const amount = `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
  return {
    id: saleId,
    reference: `SALE-${saleId}`,
    actorDisplayName: "Snapshot cashier",
    organizationName: "Snapshot shop",
    branchCode: "MAIN",
    branchName: "Snapshot branch",
    createdAt: "2026-10-05T00:00:00.000Z",
    currency: "THB",
    discount: null,
    discountAmount: "0.00",
    subtotalAmount: amount,
    totalAmount: amount,
    taxableAmount: null,
    outputVatAmount: "0.00",
    salesVatStatus: "NOT_REGISTERED",
    salesVatRate: null,
    refundState: "NONE",
    refundedAmount: "0.00",
    remainingAmount: amount,
    refunds: [],
    itemCount: count,
    payment: {
      method: "CASH",
      amount,
      amountTendered: amount,
      changeAmount: "0.00",
      reference: null,
    },
    items: Array.from({ length: count }, (_, index) => ({
      id: `40000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      productId: `50000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      productName: `Receipt item ${String(index + 1).padStart(3, "0")}${longNames ? ": " + "LongProductWithoutSpaces".repeat(5) + " ชาเขียว" : ""}`,
      productSku: `SKU-${index + 1}`,
      unit: "EA",
      quantity: "1.0000",
      remainingRefundableQuantity: "1.0000",
      unitPrice: "12.3456",
      lineGross: "12.35",
      lineNet: "12.35",
      lineDiscount: "0.00",
      lineTaxable: null,
      lineOutputVat: "0.00",
    })),
  };
}

async function stubSale(
  page: Page,
  sale: SalesHistoryDetail,
  historyCount = 1,
) {
  let detailReads = 0;
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let json: unknown;
    if (path.endsWith("/access-context")) {
      json = {
        data: {
          firstOrganizationOnboarding: { eligible: false },
          user: {
            id: "60000000-0000-4000-8000-000000000001",
            displayName: "Current cashier",
            email: "cashier@example.test",
          },
          organizations: [
            {
              id: organizationId,
              name: "Current shop",
              role: "CASHIER",
              branches: [
                { id: branchId, name: "Current branch", code: "MAIN" },
              ],
            },
          ],
        },
      };
    } else if (path.endsWith("/pos/products")) {
      json = {
        data: {
          products: [
            {
              id: sale.items[0]!.productId,
              name: "Current catalog name",
              sku: "CURRENT",
              barcode: null,
              unit: "EA",
              basePrice: "99.0000",
              available: true,
            },
          ],
        },
        meta: { nextCursor: null },
      };
    } else if (path.endsWith("/sales") && request.method() === "POST") {
      json = {
        data: {
          sale: {
            ...sale,
            occurredAt: sale.createdAt,
            actorDisplayNameSnapshot: sale.actorDisplayName,
            organizationNameSnapshot: sale.organizationName,
            branchCodeSnapshot: sale.branchCode,
            branchNameSnapshot: sale.branchName,
            items: sale.items.map((item) => ({
              ...item,
              nameSnapshot: item.productName,
              skuSnapshot: item.productSku,
              unitSnapshot: item.unit,
            })),
          },
        },
      };
    } else if (path.endsWith("/sales")) {
      json = {
        data: {
          sales: Array.from({ length: historyCount }, (_, index) => ({
            ...sale,
            id:
              index === 0
                ? sale.id
                : `30000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
            reference: index === 0 ? sale.reference : `SALE-LIST-${index + 1}`,
          })),
        },
        meta: { nextCursor: null },
      };
    } else if (path.endsWith(`/sales/${sale.id}`)) {
      detailReads += 1;
      json = { data: { sale } };
    } else {
      await route.fulfill({
        status: 404,
        json: { error: { code: "NOT_FOUND" } },
      });
      return;
    }
    await route.fulfill({ json });
  });
  return () => detailReads;
}

async function openHistoryReceipt(page: Page) {
  await page.goto(`/app/sales?${scope}`);
  await page.getByRole("button", { name: "View detail" }).click();
  await expect(page.getByLabel("Printable receipt")).toBeVisible();
}

async function checkPrintLayout(page: Page) {
  await page.emulateMedia({ media: "print" });
  const receipt = page.getByLabel("Printable receipt");
  await expect(receipt).toBeVisible();
  await expect(page.getByRole("complementary")).toBeHidden();
  await expect(
    page.getByRole("heading", { name: "Sales history", exact: true }),
  ).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Print receipt" }),
  ).toBeHidden();
  expect(
    await page.locator("button:visible, nav:visible, dialog:visible").count(),
  ).toBe(0);
  const bounds = await receipt.evaluate((element) => ({
    width: element.getBoundingClientRect().width,
    overflow: element.scrollWidth > element.clientWidth,
  }));
  expect(bounds.width).toBeCloseTo((72 * 96) / 25.4, 0);
  expect(bounds.overflow).toBe(false);
  expect(
    await receipt
      .locator("*")
      .evaluateAll((elements) =>
        elements.every(
          (element) => element.scrollWidth <= element.clientWidth + 1,
        ),
      ),
  ).toBe(true);
}

test("opening detail below a long Sales History list scrolls its heading into view", async ({
  page,
}) => {
  const sale = receiptSale();
  await stubSale(page, sale, 25);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`/app/sales?${scope}`);
  const viewDetail = page.getByRole("button", { name: "View detail" }).first();
  const scrollBefore = await page.evaluate(() => window.scrollY);
  await viewDetail.click();
  await expect(
    page.getByRole("heading", { name: sale.reference, exact: true }),
  ).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(
    scrollBefore,
  );
  await expect(viewDetail).toBeFocused();
  await expect(page.getByLabel("Printable receipt")).toBeAttached();
});

for (const width of [375, 430, 768, 1024, 1280, 1440]) {
  test(`receipt preview and reprint fit at ${width}px (stub API)`, async ({
    page,
  }, testInfo) => {
    const reads = await stubSale(page, receiptSale(3, true));
    await page.setViewportSize({ width, height: 900 });
    await openHistoryReceipt(page);
    const receipt = page.getByLabel("Printable receipt");
    await expect(receipt.locator("li")).toHaveCount(3);
    await expect(receipt).toContainText("Snapshot shop");
    await expect(receipt).not.toContainText(
      /Current shop|Current catalog name|COGS|refund/i,
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(
      await receipt.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    const itemDetails = page.getByRole("region", { name: "Sale item details" });
    await itemDetails.focus();
    await expect(itemDetails).toBeFocused();
    await receipt.screenshot({
      path: testInfo.outputPath(`receipt-${width}.png`),
    });
    await page.screenshot({
      path: testInfo.outputPath(`receipt-screen-${width}.png`),
      fullPage: true,
    });
    await page.evaluate(() => {
      window.print = () => {
        document.body.dataset.receiptPrintCalls = String(
          Number(document.body.dataset.receiptPrintCalls ?? 0) + 1,
        );
      };
    });
    const print = page.getByRole("button", { name: "Print receipt" });
    await print.focus();
    await page.keyboard.press("Enter");
    await print.click();
    await expect(page.locator("body")).toHaveAttribute(
      "data-receipt-print-calls",
      "2",
    );
    expect(reads()).toBe(1);
    await checkPrintLayout(page);
  });
}

for (const method of ["CASH", "TRANSFER"] as const) {
  test(`completed POS ${method} sale uses the same printable snapshot receipt (stub API)`, async ({
    page,
  }) => {
    const sale = receiptSale(1);
    if (method === "TRANSFER")
      sale.payment = {
        method,
        amount: sale.totalAmount,
        amountTendered: null,
        changeAmount: null,
        reference: "MANUAL-TX-001",
      };
    await stubSale(page, sale);
    await page.goto(`/app/pos?${scope}`);
    await page
      .getByRole("button", { name: "Add Current catalog name" })
      .click();
    // POS offers Cash and PromptPay only; the stub answers with a historic
    // TRANSFER sale to prove its snapshot receipt still renders.
    await page.getByLabel("Amount tendered (THB)").fill("100.00");
    await expect(page.getByRole("radio", { name: "Transfer" })).toHaveCount(0);
    await page.getByRole("button", { name: "Complete sale" }).click();
    const receipt = page.getByLabel("Printable receipt");
    await expect(receipt).toContainText("Receipt item 001");
    await expect(receipt).toContainText("THB 12.3456");
    await expect(receipt).toContainText(`Payment: ${method}`);
    await expect(receipt).not.toContainText("Current catalog name");
    await page.evaluate(() => {
      window.print = () => {
        document.body.dataset.receiptPrintCalls = "1";
      };
    });
    await page.getByRole("button", { name: "Print receipt" }).click();
    await expect(page.locator("body")).toHaveAttribute(
      "data-receipt-print-calls",
      "1",
    );
    await page.emulateMedia({ media: "print" });
    await expect(
      page.getByRole("heading", { name: "Sale completed" }),
    ).toBeHidden();
    await expect(receipt).toBeVisible();
    await page.emulateMedia({ media: "screen" });
    await page.getByRole("button", { name: "New sale" }).click();
    await expect(receipt).toHaveCount(0);
  });
}

for (const [sample, count, longNames] of [
  ["single", 1, false],
  ["multi", 6, false],
  ["long-name", 1, true],
  ["long", 80, true],
] as const) {
  test(`80 mm headless PDF: ${sample} receipt (native preview unverified)`, async ({
    page,
  }, testInfo) => {
    await stubSale(page, receiptSale(count, longNames));
    await openHistoryReceipt(page);
    await checkPrintLayout(page);
    await expect(
      page.getByLabel("Printable receipt").locator("li"),
    ).toHaveCount(count);
    await page.pdf({
      path: testInfo.outputPath(`receipt-${sample}.pdf`),
      preferCSSPageSize: true,
      displayHeaderFooter: false,
    });
    await page
      .getByLabel("Printable receipt")
      .screenshot({ path: testInfo.outputPath(`print-${sample}.png`) });
  });
}
for (const theme of ["light", "dark"] as const) {
  test(`receipt retains white paper and exact snapshot values in ${theme}`, async ({
    page,
  }) => {
    await page.addInitScript(
      (value) => localStorage.setItem("stockwise.theme", value),
      theme,
    );
    await stubSale(page, receiptSale());
    await openHistoryReceipt(page);
    const receipt = page.getByLabel("Printable receipt");
    await expect(receipt).toHaveCSS("background-color", "rgb(255, 255, 255)");
    await expect(receipt).toHaveCSS("color", "rgb(0, 0, 0)");
    await checkPrintLayout(page);
    await expect(receipt).toHaveCSS("background-color", "rgb(255, 255, 255)");
    await expect(receipt).toHaveCSS("color", "rgb(0, 0, 0)");
    await expect(receipt).toContainText("THB 12.3456");
  });
}
