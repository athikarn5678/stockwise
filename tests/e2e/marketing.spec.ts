import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { en } from "../../apps/web/src/i18n/en";
import { th } from "../../apps/web/src/i18n/th";

for (const width of [375, 430, 768, 1024, 1280, 1440]) {
  for (const path of ["/", "/pricing"]) {
    test(`${path} is accessible and fits at ${width}px`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      const apiRequests: string[] = [];
      page.on("request", (request) => {
        if (new URL(request.url()).pathname.startsWith("/api/"))
          apiRequests.push(request.url());
      });
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.getByRole("complementary")).toHaveCount(0);
      await expect(page.getByRole("contentinfo")).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      expect(await page.title()).toContain("StockWise");
      expect(
        await page.locator('meta[name="description"]').getAttribute("content"),
      ).toBeTruthy();
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      if (width < 768) {
        await expect(
          page.getByRole("navigation", { name: "Public navigation" }),
        ).toBeHidden();
        await page.getByRole("button", { name: "Menu", exact: true }).click();
        await expect(
          page
            .getByRole("dialog")
            .getByRole("navigation", { name: "Public navigation" }),
        ).toBeVisible();
        await expect(page.getByRole("dialog")).toHaveCSS("opacity", "1");
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual(
          [],
        );
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        ).toBe(true);
        await page.getByRole("button", { name: "Close menu" }).click();
      }
      expect(apiRequests).toEqual([]);
      await page.screenshot({
        path: testInfo.outputPath(
          `public-${path === "/" ? "home" : "pricing"}-${width}-top.png`,
        ),
      });
      await page.screenshot({
        path: testInfo.outputPath(
          `public-${path === "/" ? "home" : "pricing"}-${width}.png`,
        ),
        fullPage: true,
      });
    });
  }
}

test("public navigation reaches features, pricing, and the actual auth forms", async ({
  page,
}) => {
  // Only session observation is stubbed; the public pages and auth forms are real Next.js routes.
  await page.route("**/api/v1/me/access-context", (route) =>
    route.fulfill({
      status: 401,
      json: { error: { code: "AUTHENTICATION_REQUIRED" } },
    }),
  );
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Public navigation" });
  await nav.getByRole("link", { name: "Features" }).click();
  await expect(page).toHaveURL(/\/#features$/);
  await expect(
    page.getByRole("heading", { name: /The essentials, connected/ }),
  ).toBeInViewport();
  await nav.getByRole("link", { name: "Pricing" }).click();
  await expect(page).toHaveURL("/pricing");
  for (const name of ["Starter", "Growth", "Business"])
    await expect(
      page.getByRole("heading", { name, exact: true }),
    ).toBeVisible();
  await page
    .getByRole("link", { name: "Create an account", exact: true })
    .first()
    .click();
  await expect(page).toHaveURL("/register");
  await expect(page.getByLabel("Email address")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Create account" }),
  ).toBeVisible();
  await page
    .getByRole("main")
    .getByRole("link", { name: "Sign in", exact: true })
    .click();
  await expect(page).toHaveURL("/login");
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Forgot password?" }),
  ).toHaveAttribute("href", "/forgot-password");
});
for (const detour of [false, true]) {
  test(`completed auth journey returns Back to marketing${detour ? " after internal links" : ""}`, async ({
    page,
  }) => {
    let authenticated = false;
    const user = {
      id: "30000000-0000-4000-8000-000000000001",
      displayName: "Test Owner",
      email: "person@example.test",
    };
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/v1/me/access-context")
        return route.fulfill(
          authenticated
            ? {
                json: {
                  data: {
                    user,
                    organizations: [],
                    firstOrganizationOnboarding: { eligible: false },
                  },
                },
              }
            : {
                status: 401,
                json: { error: { code: "AUTHENTICATION_REQUIRED" } },
              },
        );
      if (path === "/api/v1/auth/register")
        return route.fulfill({
          status: 202,
          json: {
            data: {
              status: "accepted",
              nextStep: "verify_email",
              verification: {
                challengeId: "11111111-1111-4111-8111-111111111111",
              },
            },
          },
        });
      if (path === "/api/v1/auth/verify-email-code")
        return route.fulfill({ json: { data: { status: "verified" } } });
      if (path === "/api/v1/auth/login") {
        authenticated = true;
        return route.fulfill({ json: { data: { user } } });
      }
      throw new Error(`Unexpected API request: ${path}`);
    });
    await page.goto("/");
    await page.getByRole("link", { name: "Get started" }).first().click();
    if (detour) {
      await page
        .getByRole("main")
        .getByRole("link", { name: "Sign in", exact: true })
        .click();
      await page.getByRole("link", { name: "Forgot password?" }).click();
      await page
        .getByRole("main")
        .getByRole("link", { name: "Back to sign in" })
        .click();
      await page
        .getByRole("main")
        .getByRole("link", { name: "Create one" })
        .click();
    }
    await expect(page).toHaveURL("/register");
    await page.getByLabel("Email address").fill(user.email);
    await page
      .getByLabel("Password", { exact: true })
      .fill("test password for journey");
    await page
      .getByLabel("Confirm password", { exact: true })
      .fill("test password for journey");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page).toHaveURL("/verify-email");
    await page.getByLabel("6-digit verification code").fill("123456");
    await page.getByRole("button", { name: "Verify", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("verified");
    expect(authenticated).toBe(false);
    await page
      .getByRole("main")
      .getByRole("link", { name: "Sign in", exact: true })
      .click();
    await expect(page).toHaveURL("/login");
    await page.getByLabel("Email address").fill(user.email);
    await page
      .getByLabel("Password", { exact: true })
      .fill("test password for journey");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL("/app");
    await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);
    await page.goBack();
    await expect(page).toHaveURL("/");
    await expect(
      page.getByRole("button", { name: "Sign in", exact: true }),
    ).toHaveCount(0);
    await page.goForward();
    await expect(page).toHaveURL("/app");
    await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);
  });
}

for (const language of ["en", "th"] as const) {
  test(`registration recovers safely in ${language} when continuation storage is unavailable`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 900 });
    await page.addInitScript((language) => {
      localStorage.setItem("stockwise.language", language);
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key === "stockwise_verification_continuation")
          throw new Error("storage unavailable");
        original.call(this, key, value);
      };
    }, language);
    const requests: string[] = [];
    await page.route("**/api/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      requests.push(path);
      if (path === "/api/v1/me/access-context")
        return route.fulfill({
          status: 401,
          json: { error: { code: "AUTHENTICATION_REQUIRED" } },
        });
      if (path === "/api/v1/auth/register")
        return route.fulfill({
          status: 202,
          json: {
            data: {
              status: "accepted",
              nextStep: "verify_email",
              verification: {
                challengeId: "11111111-1111-4111-8111-111111111111",
              },
            },
          },
        });
      throw new Error(`Unexpected API request: ${path}`);
    });
    await page.goto("/register");
    await page
      .getByLabel(language === "en" ? "Email address" : "อีเมล")
      .fill("person@example.test");
    await page
      .getByLabel(language === "en" ? "Password" : "รหัสผ่าน", { exact: true })
      .fill("test password for journey");
    await page
      .getByLabel(language === "en" ? "Confirm password" : "ยืนยันรหัสผ่าน", {
        exact: true,
      })
      .fill("test password for journey");
    await page
      .getByRole("button", {
        name: language === "en" ? "Create account" : "สร้างบัญชี",
      })
      .click();
    // No OTP selector can survive navigation when storage is denied.
    // Keep the neutral form and explain recovery instead of showing a broken OTP.
    await expect(page).toHaveURL("/register");
    await expect(page.locator("#registration-error")).toBeVisible();
    await expect(page.locator("#registration-error")).toContainText(
      language === "en" ? "continuation is unavailable" : "ไม่พร้อมใช้งาน",
    );
    await expect(
      page.getByLabel(language === "en" ? "Password" : "รหัสผ่าน", {
        exact: true,
      }),
    ).toHaveValue("");
    await expect(
      page.getByRole("link", { name: "Continue verification" }),
    ).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(
      requests.filter((path) => path !== "/api/v1/me/access-context"),
    ).toEqual(["/api/v1/auth/register"]);
    await page
      .getByRole("link", {
        name: language === "en" ? "Sign in" : "เข้าสู่ระบบ",
        exact: true,
      })
      .last()
      .click();
    await expect(page).toHaveURL("/login");
  });
}

for (const signedIn of [false, true]) {
  test(`guest session retry reaches ${signedIn ? "workspace" : "explicit 401 form"} without an auth flash`, async ({
    page,
  }) => {
    let attempts = 0;
    const retry = Promise.withResolvers<void>();
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path !== "/api/v1/me/access-context")
        throw new Error(`Unexpected API request: ${path}`);
      attempts += 1;
      if (attempts === 1) return route.fulfill({ status: 503, json: {} });
      await retry.promise;
      return route.fulfill(
        signedIn
          ? {
              json: {
                data: {
                  user: {
                    id: "30000000-0000-4000-8000-000000000001",
                    email: "person@example.test",
                    displayName: "Test Owner",
                  },
                  organizations: [],
                  firstOrganizationOnboarding: { eligible: false },
                },
              },
            }
          : {
              status: 401,
              json: { error: { code: "AUTHENTICATION_REQUIRED" } },
            },
      );
    });
    await page.goto("/login");
    await expect(
      page.getByRole("alert").filter({ hasText: "access context" }),
    ).toBeVisible();
    await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByText("Loading access…")).toBeVisible();
    await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);
    retry.resolve();
    if (signedIn) {
      await expect(page).toHaveURL("/app");
      await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);
    } else {
      await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
      await expect(page).toHaveURL("/login");
    }
    expect(attempts).toBe(2);
  });
}

test("authenticated Get Started and browser history cannot reopen guest forms", async ({
  page,
}) => {
  const organizationId = "10000000-0000-4000-8000-000000000001";
  const branchId = "20000000-0000-4000-8000-000000000001";
  const workspace = `/app?organizationId=${organizationId}&branchId=${branchId}`;
  const sessionContext = {
    firstOrganizationOnboarding: { eligible: false },
    organizations: [
      {
        id: organizationId,
        name: "Test Store",
        role: "OWNER",
        branches: [{ id: branchId, name: "Main branch", code: "MAIN" }],
      },
    ],
    user: {
      id: "30000000-0000-4000-8000-000000000001",
      displayName: "Test Owner",
      email: "owner@example.test",
    },
  };
  await page.route("**/api/v1/me/access-context", (route) =>
    route.fulfill({ status: 200, json: { data: sessionContext } }),
  );

  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.getByRole("link", { name: "Get started" }).first().click();
  await expect(page).toHaveURL(workspace);
  await expect(
    page.getByRole("button", { name: "Create account" }),
  ).toHaveCount(0);
  await expect(page.getByLabel("Password")).toHaveCount(0);

  await page.goBack();
  await expect(page).toHaveURL("/");
  await page.goForward();
  await expect(page).toHaveURL(workspace);
  await expect(
    page.getByRole("button", { name: "Create account" }),
  ).toHaveCount(0);

  for (const guest of [
    "/register",
    "/login",
    "/verify-email",
    "/verification-resend",
    "/forgot-password",
    "/reset-password",
  ]) {
    await page.goto(guest);
    await expect(page).toHaveURL(workspace);
    await expect(
      page.getByRole("button", { name: "Create account" }),
    ).toHaveCount(0);
    await expect(page.getByLabel("Password")).toHaveCount(0);
  }

  await page.goto("/pricing");
  await page
    .getByRole("link", { name: "Create an account", exact: true })
    .first()
    .click();
  await expect(page).toHaveURL(workspace);
  await expect(
    page.getByRole("button", { name: "Create account" }),
  ).toHaveCount(0);
});

test("mobile menu supports keyboard use, Escape, and closes after a feature link", async ({
  page,
}) => {
  await page.route("**/api/v1/me/access-context", (route) =>
    route.fulfill({
      status: 401,
      json: { error: { code: "AUTHENTICATION_REQUIRED" } },
    }),
  );
  await page.setViewportSize({ width: 375, height: 900 });
  await page.goto("/");
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("link", { name: "Skip to main content" }),
  ).toBeFocused();
  const menu = page.locator('[data-slot="sheet-trigger"]');
  await menu.focus();
  await page.keyboard.press("Enter");
  await expect(menu).toHaveAttribute("aria-expanded", "true");
  const features = page
    .getByRole("dialog")
    .getByRole("navigation", { name: "Public navigation" })
    .getByRole("link", { name: "Features" });
  await features.focus();
  await expect(features).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toBeFocused();
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Enter");
  await features.click();
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  await expect(page).toHaveURL(/\/#features$/);
  await menu.click();
  await page
    .getByRole("dialog")
    .getByRole("link", { name: "Get started" })
    .click();
  await expect(page).toHaveURL("/register");
  await expect(
    page.getByRole("heading", { name: "Create account" }),
  ).toBeVisible();
});

test("public routes separate from the desktop/mobile app shell and preserve logout navigation", async ({
  page,
}) => {
  let signedIn = true;
  const organizationId = "10000000-0000-4000-8000-000000000001";
  const branchId = "20000000-0000-4000-8000-000000000001";
  // This checks browser shell transitions; it does not claim live authentication verification.
  await page.route("**/api/v1/me/access-context", (route) =>
    route.fulfill(
      signedIn
        ? {
            json: {
              data: {
                firstOrganizationOnboarding: { eligible: false },
                organizations: [
                  {
                    id: organizationId,
                    name: "Test shop",
                    role: "OWNER",
                    branches: [
                      { id: branchId, name: "Main store", code: "MAIN" },
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
        : { status: 401, json: { error: { code: "AUTHENTICATION_REQUIRED" } } },
    ),
  );
  await page.route("**/api/v1/auth/logout", (route) => {
    signedIn = false;
    return route.fulfill({ status: 204 });
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/login");
  await expect(page).toHaveURL(
    `/app?organizationId=${organizationId}&branchId=${branchId}`,
  );
  const appNav = page.getByRole("navigation", { name: "Primary navigation" });
  await expect(
    appNav.getByRole("link", { name: "Inventory", exact: true }),
  ).toHaveAttribute(
    "href",
    `/app/inventory?organizationId=${organizationId}&branchId=${branchId}`,
  );
  for (const path of ["/", "/pricing"]) {
    await page.goto(path);
    await expect(page).toHaveURL(path);
    await expect(page.getByRole("complementary")).toHaveCount(0);
    await expect(
      page.getByRole("navigation", { name: "Public navigation" }),
    ).toBeVisible();
  }
  await page.goto("/login");
  await expect(appNav).toBeVisible();
  await page.setViewportSize({ width: 375, height: 900 });
  await expect(appNav).toBeHidden();
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await expect(appNav).toBeVisible();
  await appNav.getByRole("link", { name: "Home", exact: true }).click();
  await expect(appNav).toBeHidden();
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await page.getByRole("button", { name: "Log out", exact: true }).click();
  await expect(page).toHaveURL("/login");
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("complementary")).toHaveCount(0);
});

for (const width of [375, 1280]) {
  for (const path of ["/", "/pricing"]) {
    test(`marketing preferences update in place at ${width}px on ${path}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(() => {
        localStorage.setItem("stockwise.language", "en");
        localStorage.setItem("stockwise.theme", "light");
      });
      await page.goto(path);
      const documentIdentity = await page.evaluate(
        () => performance.timeOrigin,
      );
      for (const [language, theme, action] of [
        ["en", "light", null],
        ["th", "light", "language"],
        ["th", "dark", "theme"],
        ["en", "dark", "language"],
      ] as const) {
        if (action) {
          const previous = action === "language" && language === "th" ? en : th;
          if (width < 768)
            await page
              .getByRole("button", { name: previous.menu, exact: true })
              .click();
          await page
            .getByRole("button", {
              name: action === "language" ? previous.language : previous.theme,
              exact: true,
            })
            .press("Enter");
          if (width < 768) await page.keyboard.press("Escape");
        }
        const copy = language === "th" ? th : en;
        await expect(page.locator("html")).toHaveAttribute("lang", language);
        await expect(page.locator("html")).toHaveClass(new RegExp(theme));
        await expect(page.getByRole("heading", { level: 1 })).toHaveText(
          path === "/" ? copy.marketingHeroTitle : copy.pricingTitle,
        );
        if (path === "/pricing") {
          await page
            .getByRole("button", { name: copy.pricingYearly, exact: true })
            .click();
          await expect(
            page.getByText("THB 1,990", { exact: true }),
          ).toBeVisible();
          await expect(
            page.getByText(copy.pricingEnterpriseBranches, { exact: true }),
          ).toBeVisible();
          await expect(
            page.getByText(copy.pricingContactUnavailable, { exact: true }),
          ).toBeVisible();
          await expect(
            page.getByRole("link", { name: copy.pricingContactSales }),
          ).toHaveCount(0);
        } else {
          await expect(
            page.getByText(copy.marketingProductTea, { exact: true }),
          ).toBeVisible();
          await expect(
            page.getByRole("heading", {
              name: copy.marketingFeaturesTitle,
              exact: true,
            }),
          ).toBeVisible();
          await expect(
            page.getByRole("heading", {
              name: copy.marketingWorkflowTitle,
              exact: true,
            }),
          ).toBeVisible();
        }
        expect(await page.evaluate(() => performance.timeOrigin)).toBe(
          documentIdentity,
        );
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual(
          [],
        );
        await page.screenshot({
          path: testInfo.outputPath(
            `ux-${path === "/" ? "home" : "pricing"}-${width}-${language}-${theme}.png`,
          ),
          fullPage: true,
        });
      }
    });
  }
}
