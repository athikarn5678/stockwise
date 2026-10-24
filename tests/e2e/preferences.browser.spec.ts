import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const organizationId = "10000000-0000-4000-8000-000000000001";
const branchId = "20000000-0000-4000-8000-000000000001";
const scope = `organizationId=${organizationId}&branchId=${branchId}`;

async function stubWorkspace(page: Page, signedIn = true) {
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/access-context")) {
      return route.fulfill(
        signedIn
          ? {
              json: {
                data: {
                  firstOrganizationOnboarding: { eligible: false },
                  organizations: [
                    {
                      id: organizationId,
                      name: "ร้าน StockWise",
                      role: "OWNER",
                      branches: [
                        { id: branchId, code: "MAIN", name: "สาขากลาง" },
                      ],
                    },
                  ],
                  user: {
                    id: "30000000-0000-4000-8000-000000000001",
                    email: "owner@example.test",
                    displayName: "Owner",
                  },
                },
              },
            }
          : {
              status: 401,
              json: { error: { code: "AUTHENTICATION_REQUIRED" } },
            },
      );
    }
    if (path.endsWith("/categories"))
      return route.fulfill({
        json: { data: { categories: [] }, meta: { nextCursor: null } },
      });
    if (path.endsWith("/pos/products"))
      return route.fulfill({
        json: { data: { products: [] }, meta: { nextCursor: null } },
      });
    if (path.endsWith("/suppliers"))
      return route.fulfill({
        json: {
          data: {
            suppliers: [
              {
                id: "60000000-0000-4000-8000-000000000001",
                organizationId,
                name: "ผู้จำหน่าย StockWise",
                contactName: "Sample contact",
                email: null,
                phone: "020000000",
                address: "Sample address",
                status: "ACTIVE",
                createdAt: "2026-10-05T00:00:00.000Z",
                updatedAt: "2026-10-05T00:00:00.000Z",
              },
            ],
          },
          meta: { nextCursor: null },
        },
      });
    if (path.endsWith("/products"))
      return route.fulfill({
        json: {
          data: {
            products: [
              {
                id: "40000000-0000-4000-8000-000000000001",
                organizationId,
                name: "ชาเขียว Green tea",
                sku: "TEA-01",
                barcode: "0012345678905",
                basePrice: "12.3400",
                categoryId: null,
                description: null,
                status: "ACTIVE",
                unit: "EA",
                createdAt: "2026-10-05T00:00:00.000Z",
                updatedAt: "2026-10-05T00:00:00.000Z",
              },
            ],
          },
          meta: { nextCursor: null },
        },
      });
    if (path.endsWith("/analytics/sales"))
      return route.fulfill({
        json: {
          data: {
            buckets: [1, 2, 3].map((day) => ({
              label: `2026-10-0${day}`,
              localStartInclusive: `2026-10-0${day}`,
              localEndExclusive: `2026-10-0${day + 1}`,
              dataStatus: "complete",
              discountAmount: "0.00",
              grossSalesAmount: "1234.5678",
              netSalesAmount: "1234.5678",
              salesAfterDiscountAmount: "1234.5678",
              refundAmount: "0.00",
              netOutputVatAmount: "0.00",
              outputVatAmount: "0.00",
              averageOrderValue: { reason: null, value: "1234.5678" },
              netSalesGrowthPercent: { reason: "NO_BASELINE", value: null },
              refundCount: 0,
              refundedDiscountAmount: "0.00",
              refundedOutputVatAmount: "0.00",
              refundedSaleCount: 0,
              saleCount: 1,
              refundedRegisteredTaxableAmount: {
                reason: "NO_REGISTERED_REFUNDS",
                value: null,
              },
              registeredTaxableSalesAmount: {
                reason: "NO_REGISTERED_SALES",
                value: null,
              },
            })),
          },
          meta: {
            dataStatus: "complete",
            granularity: "day",
            includedBranchCount: 1,
            localFromInclusive: "2026-10-01",
            localToExclusive: "2026-10-04",
            reportingTimezone: "Asia/Bangkok",
            scopeType: "organization",
            sourceCutoff: "2026-10-04T00:00:00.000Z",
          },
        },
      });
    if (path.endsWith("/auth/logout")) {
      signedIn = false;
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({
      status: 404,
      json: { error: { code: "NOT_FOUND" } },
    });
  });
  return (value: boolean) => {
    signedIn = value;
  };
}

async function chooseLanguage(
  page: Page,
  thai: boolean,
  next: "English" | "ไทย",
) {
  await page
    .getByRole("button", { name: thai ? "ภาษา" : "Language", exact: true })
    .click();
  await expect(page.locator("html")).toHaveAttribute(
    "lang",
    next === "ไทย" ? "th" : "en",
  );
}
async function chooseTheme(
  page: Page,
  thai: boolean,
  next: "Light" | "Dark" | "สว่าง" | "มืด",
) {
  await page
    .getByRole("button", {
      name: thai ? "รูปแบบหน้าจอ" : "Appearance",
      exact: true,
    })
    .click();
  await expect(page.locator("html")).toHaveClass(
    next === "Dark" || next === "มืด" ? /dark/ : /light/,
  );
}
test("preferences persist through navigation and reload without hydration errors", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (/hydration|did not match/i.test(m.text())) errors.push(m.text());
  });
  await stubWorkspace(page, false);
  await page.goto("/");
  await chooseTheme(page, false, "Dark");
  await chooseLanguage(page, false, "ไทย");
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(page.locator("html")).toHaveAttribute("lang", "th");
  await page
    .getByRole("navigation", { name: "เมนูเว็บไซต์" })
    .getByRole("link", { name: "เข้าสู่ระบบ" })
    .click();
  await expect(page).toHaveURL("/login");
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(page.locator("html")).toHaveAttribute("lang", "th");
  expect(
    await page.evaluate(() => localStorage.getItem("stockwise.theme")),
  ).toBe("dark");
  expect(
    await page.evaluate(() => localStorage.getItem("stockwise.language")),
  ).toBe("th");
  await chooseTheme(page, true, "สว่าง");
  await chooseLanguage(page, true, "English");
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/light/);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  expect(errors).toEqual([]);
});
test.describe("browser defaults", () => {
  test.use({ locale: "th-TH", colorScheme: "dark" });
  test("uses browser Thai and OS dark preference", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("lang", "th");
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page
      .getByRole("button", { name: "รูปแบบหน้าจอ", exact: true })
      .press("Enter");
    await expect(page.locator("html")).toHaveClass(/light/);
    expect(
      await page.evaluate(() => localStorage.getItem("stockwise.theme")),
    ).toBe("light");
    await page
      .getByRole("button", { name: "รูปแบบหน้าจอ", exact: true })
      .press("Space");
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(page.getByRole("menuitem")).toHaveCount(0);
  });
});
test("failed logout text follows the language without repeating the request", async ({
  page,
}) => {
  await stubWorkspace(page);
  let requests = 0;
  await page.route("**/api/v1/auth/logout", (r) => {
    requests++;
    return r.fulfill({ status: 503, json: { error: { code: "UNAVAILABLE" } } });
  });
  await page.goto(`/app?${scope}`);
  await page.getByRole("button", { name: "Log out", exact: true }).click();
  const error = page.getByRole("complementary").getByRole("alert");
  await expect(error).toHaveText(
    "We could not complete that request. Please try again.",
  );
  await chooseLanguage(page, false, "ไทย");
  await expect(error).toHaveText("ไม่สามารถดำเนินการได้ กรุณาลองอีกครั้ง");
  await chooseLanguage(page, true, "English");
  await expect(error).toHaveText(
    "We could not complete that request. Please try again.",
  );
  expect(requests).toBe(1);
});
test("Thai mobile sidebar closes on Escape and navigation and preserves logout", async ({
  page,
}) => {
  await stubWorkspace(page);
  await page.setViewportSize({ width: 375, height: 900 });
  await page.addInitScript(() =>
    localStorage.setItem("stockwise.language", "th"),
  );
  await page.goto(`/app?${scope}`);
  const trigger = page.getByRole("button", { name: "เมนู", exact: true });
  await trigger.click();
  const nav = page.getByRole("navigation", { name: "เมนูหลัก" });
  const catalog = nav.getByRole("link", { name: "สินค้า", exact: true });
  await expect(catalog).toHaveAttribute("href", `/app/catalog?${scope}`);
  await catalog.focus();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await trigger.click();
  await catalog.click();
  await expect(nav).toBeHidden();
  await trigger.click();
  await page.getByRole("button", { name: "ออกจากระบบ", exact: true }).click();
  await expect(page).toHaveURL("/login");
  await expect(page.locator("html")).toHaveAttribute("lang", "th");
});
for (const [width, theme, language] of [
  [1440, "light", "en"],
  [1440, "dark", "th"],
  [430, "light", "th"],
  [375, "dark", "en"],
] as const) {
  test(`foundation ${width}px ${theme}/${language} with controlled API fixtures`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(
      ({ theme, language }) => {
        localStorage.setItem("stockwise.theme", theme);
        localStorage.setItem("stockwise.language", language);
      },
      { theme, language },
    );
    const setSignedIn = await stubWorkspace(page);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (/hydration|did not match/i.test(m.text())) errors.push(m.text());
    });
    for (const [name, path] of [
      ["home", "/"],
      ["pricing", "/pricing"],
      ["login", "/login"],
      ["register", "/register"],
      ["workspace", `/app?${scope}`],
      ["catalog", `/app/catalog?${scope}`],
      ["analytics", `/app/analytics?${scope}`],
      ["suppliers", `/app/suppliers?${scope}`],
      ["pos", `/app/pos?${scope}`],
    ]) {
      setSignedIn(name !== "login" && name !== "register");
      await page.goto(path!);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.locator("html")).toHaveClass(new RegExp(theme));
      await expect(page.locator("html")).toHaveAttribute("lang", language);
      if (name === "catalog") {
        const editor = page.getByRole("form", {
          name: "Edit product ชาเขียว Green tea",
        });
        await expect(editor.getByLabel("Barcode (optional)")).toHaveValue(
          "0012345678905",
        );
        await expect(editor.getByLabel("Base price")).toHaveValue("12.3400");
      }
      if (name === "analytics")
        await expect(
          page.getByRole("table", { name: "Sales by period" }),
        ).toContainText("THB 1,234.5678");
      if (name === "suppliers")
        await expect(
          page.getByRole("heading", { name: "ผู้จำหน่าย StockWise" }),
        ).toBeVisible();
      if (name === "pos")
        await expect(page.getByLabel("Scan or enter barcode")).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await page.screenshot({
        path: info.outputPath(`${name}-${width}-${theme}-${language}.png`),
        fullPage: true,
      });
    }
    expect(errors).toEqual([]);
  });
}
