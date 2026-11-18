import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import {
  E2E_BRANCH_ID,
  E2E_CASHIER_EMAIL,
  E2E_ORGANIZATION_ID,
  E2E_OWNER_EMAIL,
  E2E_PASSWORD,
} from "./catalog-fixtures.ts";

const homePath = `/app?organizationId=${E2E_ORGANIZATION_ID}&branchId=${E2E_BRANCH_ID}`;

async function signIn(page: Page, email = E2E_OWNER_EMAIL) {
  await page.goto("/login?next=%2Fapp");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app/);
  if (email === E2E_OWNER_EMAIL) {
    await page
      .getByRole("button", { name: "Catalog E2E Store", exact: true })
      .click();
  }
  await expect(
    page.getByRole("heading", { name: "Catalog E2E Store", exact: true }),
  ).toBeVisible();
}

async function expectNoOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
}

test("desktop sidebar preserves scoped navigation, active state, logo and logout", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  const sidebar = page.getByRole("complementary", {
    name: "Application sidebar",
  });
  const main = page.getByRole("main");
  await expect(sidebar).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sign in" })).toHaveCount(0);
  await expect(
    sidebar.getByRole("link", { name: "Home", exact: true }),
  ).toHaveAttribute("href", homePath);
  await expect(
    sidebar.getByRole("link", { name: "StockWise" }),
  ).toHaveAttribute("href", homePath);
  await expect(main.getByRole("link")).toHaveCount(0);
  const sidebarBox = (await sidebar.boundingBox())!;
  const mainBox = (await main.boundingBox())!;
  const logoutBox = (await sidebar
    .getByRole("button", { name: "Log out" })
    .boundingBox())!;
  expect(sidebarBox.x).toBe(0);
  expect(sidebarBox.height).toBe(900);
  expect(mainBox.x).toBeGreaterThanOrEqual(sidebarBox.x + sidebarBox.width);
  expect(logoutBox.y + logoutBox.height).toBeGreaterThan(850);
  await expectNoOverflow(page);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("desktop-home.png"),
    fullPage: true,
  });

  await sidebar.getByRole("link", { name: "Catalog", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Catalog", exact: true }),
  ).toBeVisible();
  await expect(
    sidebar.getByRole("link", { name: "Catalog", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(
    sidebar.getByRole("link", { name: "Home", exact: true }),
  ).not.toHaveAttribute("aria-current", "page");
  await expectNoOverflow(page);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("desktop-catalog.png"),
    fullPage: true,
  });
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  expect((await sidebar.boundingBox())!.y).toBe(0);
  await sidebar.getByRole("link", { name: "StockWise" }).click();
  await expect(page).toHaveURL(homePath);

  const logoutResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/auth/logout") &&
      response.request().method() === "POST",
  );
  await sidebar.getByRole("button", { name: "Log out" }).focus();
  await page.keyboard.press("Enter");
  expect((await logoutResponse).status()).toBe(204);
  await expect(page).toHaveURL("/login");
  await expect(page.getByRole("complementary")).toHaveCount(0);
  await expect(
    page.getByRole("navigation").getByRole("link", { name: "Sign in" }),
  ).toBeVisible();
  expect(
    (await page.context().cookies()).some((cookie) =>
      cookie.name.endsWith("stockwise_native.session_token"),
    ),
  ).toBe(false);
  expect((await page.request.get("/api/v1/me/access-context")).status()).toBe(
    401,
  );
  await page.screenshot({
    path: testInfo.outputPath("signed-out-login.png"),
    fullPage: true,
  });
});

test("desktop sidebar collapse returns keyboard focus to the trigger and blocks Tab into inert content", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  const sidebar = page.getByRole("complementary", {
    name: "Application sidebar",
  });
  const container = page.locator('[data-slot="sidebar"]');
  const panel = page.locator('[data-slot="sidebar-container"]');
  const menu = page.getByRole("button", { name: "Menu", exact: true });
  const catalog = sidebar.getByRole("link", { name: "Catalog", exact: true });

  const focusInsideSidebar = () =>
    page.evaluate(
      (selector) =>
        document.querySelector(selector)?.contains(document.activeElement) ??
        false,
      '[data-slot="sidebar"]',
    );

  // Expanded baseline: no inert, panel on-screen, slide transition intact.
  await expect(menu).toHaveAttribute("aria-expanded", "true");
  await expect(container).not.toHaveAttribute("inert");
  expect((await panel.boundingBox())!.x).toBe(0);
  const transition = await panel.evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      property: style.transitionProperty,
      duration: style.transitionDuration,
    };
  });
  expect(transition.property).toContain("left");
  expect(transition.property).toContain("width");
  expect(transition.duration).toContain("0.2s");

  // Put keyboard focus on a real sidebar link, then collapse with the
  // keyboard shortcut so focus is inside the sidebar at collapse time.
  await catalog.focus();
  await expect(catalog).toBeFocused();
  await page.keyboard.press("Control+b");

  // Focus is returned to the visible trigger; content becomes inert and the
  // panel slides fully off-screen.
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  await expect(menu).toBeFocused();
  await expect(container).toHaveAttribute("inert");
  await expect.poll(async () => (await panel.boundingBox())!.x).toBe(-256);

  // Neither Tab nor Shift+Tab reaches the collapsed off-screen sidebar.
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press("Tab");
    expect(await focusInsideSidebar()).toBe(false);
    const focusedX = await page.evaluate(() => {
      const rect = document.activeElement?.getBoundingClientRect();
      return rect ? rect.x : 0;
    });
    expect(focusedX).toBeGreaterThanOrEqual(0);
  }
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press("Shift+Tab");
    expect(await focusInsideSidebar()).toBe(false);
  }

  // Reopening restores normal keyboard access to the sidebar.
  await page.keyboard.press("Control+b");
  await expect(menu).toHaveAttribute("aria-expanded", "true");
  await expect(container).not.toHaveAttribute("inert");
  await expect.poll(async () => (await panel.boundingBox())!.x).toBe(0);
  await menu.focus();
  await page.keyboard.press("Shift+Tab");
  await expect.poll(focusInsideSidebar).toBe(true);
});
test("small-screen menu supports keyboard navigation and scoped logo links", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  const sidebar = page.getByRole("complementary", {
    name: "Application sidebar",
  });
  await expect(sidebar).toBeHidden();
  const menu = page.getByRole("button", { name: "Menu", exact: true });
  await menu.focus();
  await page.keyboard.press("Enter");
  await expect(sidebar).toBeVisible();
  // While the Sheet is open the background (including the Menu trigger) is
  // inert, so the trigger's aria-expanded is not observable; the visible
  // "Close menu" control is the accessible close affordance.
  const closeMenu = page.getByRole("button", { name: "Close menu" });
  await expect(closeMenu).toBeVisible();
  await expect(sidebar.getByRole("button", { name: "Log out" })).toBeVisible();
  await expectNoOverflow(page);
  // Axe must not sample the sheet mid fade-in (blended colours read as low contrast).
  await expect(sidebar).toHaveCSS("opacity", "1");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("mobile-menu.png"),
    fullPage: true,
  });

  // The visible close control is keyboard-reachable and closes the Sheet.
  await closeMenu.focus();
  await expect(closeMenu).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(sidebar).toBeHidden();
  await expect(menu).toHaveAttribute("aria-expanded", "false");

  // Escape still closes the Sheet.
  await menu.focus();
  await page.keyboard.press("Enter");
  await expect(sidebar).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sidebar).toBeHidden();
  await expect(menu).toHaveAttribute("aria-expanded", "false");

  // Reopen for the navigation flow below.
  await menu.focus();
  await page.keyboard.press("Enter");
  await expect(sidebar).toBeVisible();
  await sidebar
    .getByRole("link", { name: "Catalog", exact: true })
    .press("Enter");
  await expect(
    page.getByRole("heading", { name: "Catalog", exact: true }),
  ).toBeVisible();
  await expect(sidebar).toBeHidden();
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  await expectNoOverflow(page);
  await page.screenshot({
    path: testInfo.outputPath("mobile-catalog.png"),
    fullPage: true,
  });
  // The logo link is scoped inside the sidebar; on mobile it is only
  // reachable through the Sheet, so reopen it to exercise the scoped logo.
  await menu.focus();
  await page.keyboard.press("Enter");
  await expect(sidebar).toBeVisible();
  await sidebar.getByRole("link", { name: "StockWise" }).click();
  await expect(page).toHaveURL(homePath);
  await page.setViewportSize({ width: 320, height: 640 });
  await expectNoOverflow(page);
  await page.setViewportSize({ width: 768, height: 1024 });
  await expect(menu).toBeVisible();
  // 768px is the desktop breakpoint (useIsMobile is innerWidth < 768), so the
  // offcanvas desktop sidebar is visible here, not the mobile Sheet.
  await expect(sidebar).toBeVisible();
  await expectNoOverflow(page);
});

test("cashier receives access-aware destinations while API authorization remains enforced", async ({
  page,
}) => {
  await signIn(page, E2E_CASHIER_EMAIL);
  const nav = page.getByRole("navigation", { name: "Primary navigation" });
  await expect(nav.getByRole("link", { name: "Point of sale" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Sales history" })).toBeVisible();
  for (const name of [
    "Manage branches",
    "Manage members",
    "Analytics",
    "Suppliers",
    "Purchase orders",
  ]) {
    await expect(nav.getByRole("link", { name, exact: true })).toHaveCount(0);
  }
  const forbidden = await page.request.get(
    `/api/v1/organizations/${E2E_ORGANIZATION_ID}/members`,
  );
  expect(forbidden.status()).toBe(403);
  expect((await forbidden.json()).error.code).toBe("FORBIDDEN");
});

test("signed-out public and app surfaces do not expose authenticated navigation", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: /Run your inventory with clarity/ }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "Public navigation" })
      .getByRole("link", { name: "Get started" }),
  ).toBeVisible();
  await expect(page.getByRole("complementary")).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("public-home.png"),
    fullPage: true,
  });
  await page.goto("/app");
  // The existing workspace observer retries access-context reads before settling.
  await expect(
    page.getByRole("navigation").getByRole("link", { name: "Sign in" }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("complementary")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Log out" })).toHaveCount(0);
});

test("authenticated marketing stays public and login returns to Home", async ({
  page,
}) => {
  await signIn(page);
  for (const path of ["/", "/pricing"]) {
    await page.goto(path);
    await expect(
      page.getByRole("navigation", { name: "Public navigation" }),
    ).toBeVisible();
    await expect(page).toHaveURL(path);
    await expect(page.getByRole("complementary")).toHaveCount(0);
  }
  // A signed-in visit to /login returns to the landing page, one click from the app.
  await page.goto("/login");
  await expect(page).toHaveURL("/");
  await page
    .getByRole("navigation", { name: "Public navigation" })
    .getByRole("link", { name: "Go to dashboard" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Choose an organization" }),
  ).toBeVisible();
  await expect(page).toHaveURL("/app");
  await expect(page.getByRole("link", { name: "Sign in" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sign in" })).toHaveCount(0);
});
