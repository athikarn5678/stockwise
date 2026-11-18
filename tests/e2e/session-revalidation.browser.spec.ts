import { expect, test, type BrowserContext, type Page } from "@playwright/test";

const org = "10000000-0000-4000-8000-000000000001";
const branch = "20000000-0000-4000-8000-000000000001";
const user = "30000000-0000-4000-8000-000000000001";
const successorUser = "30000000-0000-4000-8000-000000000002";
type Role = "OWNER" | "CASHIER";

/**
 * Same mocked-API pattern as session-lifecycle.browser.spec.ts: every call is
 * intercepted, so no API process, accounts, mail or database are involved.
 */
async function mockSession(context: BrowserContext, initial = "Store A") {
  const state = {
    actor: initial as string | null,
    status: 200,
    role: "OWNER" as Role,
    requests: 0,
    logoutStatus: 204,
  };
  await context.addInitScript(() =>
    localStorage.setItem("stockwise.language", "en"),
  );
  const userId = () => (state.actor === "Store B" ? successorUser : user);
  const profile = () => ({
    id: userId(),
    email: "synthetic@example.test",
    displayName: state.actor,
    phone: null,
    updatedAt: "2026-10-25T01:00:00.000Z",
  });
  await context.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/me/access-context")) {
      state.requests += 1;
      if (state.status === 0) return route.abort("failed");
      if (!state.actor || state.status !== 200)
        return route.fulfill({
          status: state.actor ? state.status : 401,
          json: {
            error: {
              code:
                state.status === 403 ? "FORBIDDEN" : "AUTHENTICATION_REQUIRED",
            },
          },
        });
      return route.fulfill({
        json: {
          data: {
            user: {
              id: userId(),
              email: "synthetic@example.test",
              displayName: state.actor,
            },
            firstOrganizationOnboarding: { eligible: false },
            organizations: [
              {
                id: org,
                name: state.actor,
                role: state.role,
                branches: [{ id: branch, code: "MAIN", name: "Main" }],
              },
            ],
          },
        },
      });
    }
    if (path === "/api/v1/me")
      return route.fulfill({
        json: { data: profile(), meta: { requestId: "synthetic-e2e" } },
      });
    if (path.endsWith("/auth/logout")) {
      if (state.logoutStatus === 204) state.actor = null;
      return route.fulfill({
        status: state.logoutStatus,
        ...(state.logoutStatus === 204
          ? {}
          : { json: { error: { code: "DEPENDENCY_UNAVAILABLE" } } }),
      });
    }
    return route.fulfill({
      status: 503,
      json: { error: { code: "DEPENDENCY_UNAVAILABLE" } },
    });
  });
  return state;
}

async function hide(page: Page) {
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
}
async function show(page: Page) {
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

test("a drafted profile survives hidden→visible and blur→focus without a loading flash", async ({
  context,
  page,
}) => {
  const state = await mockSession(context);
  await page.goto("/app/settings");
  const name = page.getByLabel("Display name", { exact: true });
  await expect(name).toHaveValue("Store A");
  await name.fill("Unsaved Store A draft");
  await expect(page.getByText("You have unsaved changes.")).toBeVisible();
  const before = state.requests;
  await page.waitForTimeout(700);

  await hide(page);
  await expect(name).toHaveValue("Unsaved Store A draft");
  await expect(page.getByText("Loading access", { exact: false })).toHaveCount(
    0,
  );
  await show(page);
  await expect(name).toHaveValue("Unsaved Store A draft");
  await expect(page.getByText("Loading access", { exact: false })).toHaveCount(
    0,
  );
  await expect.poll(() => state.requests).toBe(before + 1);
  await page.waitForTimeout(300);
  expect(state.requests).toBe(before + 1);

  await page.waitForTimeout(700);
  await page.evaluate(() => {
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new Event("focus"));
  });
  await expect(name).toHaveValue("Unsaved Store A draft");
  await expect(page.getByText("You have unsaved changes.")).toBeVisible();
  await expect(page.getByText("Loading access", { exact: false })).toHaveCount(
    0,
  );
  await expect.poll(() => state.requests).toBe(before + 2);
  await page.waitForTimeout(300);
  expect(state.requests).toBe(before + 2);
});

test("an actor switch on return resets the screen to the new actor", async ({
  context,
  page,
}) => {
  const state = await mockSession(context);
  await page.goto("/app/settings");
  const name = page.getByLabel("Display name", { exact: true });
  await expect(name).toHaveValue("Store A");
  await name.fill("Unsaved Store A draft");
  await page.waitForTimeout(700);
  await hide(page);
  state.actor = "Store B";
  await show(page);
  await expect(name).toHaveValue("Store B");
  await expect(
    page.getByRole("complementary").getByTitle("Store B"),
  ).toBeVisible();
  await expect(
    page.locator('input[value="Unsaved Store A draft"]'),
  ).toHaveCount(0);
  await expect(page.getByText("Loading access", { exact: false })).toHaveCount(
    0,
  );
  expect(state.requests).toBeGreaterThanOrEqual(2);
});

test("a role downgrade on return resets the private screen", async ({
  context,
  page,
}) => {
  const state = await mockSession(context);
  await page.goto("/app/settings");
  const name = page.getByLabel("Display name", { exact: true });
  await expect(name).toHaveValue("Store A");
  await expect(
    page.getByRole("link", { name: "Manage members", exact: true }),
  ).toBeVisible();
  await name.fill("Unsaved Store A draft");
  await page.waitForTimeout(700);
  await hide(page);
  state.role = "CASHIER";
  await show(page);
  await expect(name).toHaveValue("Store A");
  await expect(
    page.locator('input[value="Unsaved Store A draft"]'),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Manage members", exact: true }),
  ).toHaveCount(0);
});

test("a 401 on return signs out instead of restoring the draft", async ({
  context,
  page,
}) => {
  const state = await mockSession(context);
  await page.goto("/app/settings");
  const name = page.getByLabel("Display name", { exact: true });
  await expect(name).toHaveValue("Store A");
  await name.fill("Unsaved Store A draft");
  await page.waitForTimeout(700);
  await hide(page);
  state.status = 401;
  await show(page);
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
  await expect(
    page.locator('input[value="Unsaved Store A draft"]'),
  ).toHaveCount(0);
});

test("logout in a second page purges the first even while the first is hidden", async ({
  context,
  page,
}) => {
  const state = await mockSession(context);
  await page.goto("/app/settings");
  const name = page.getByLabel("Display name", { exact: true });
  await expect(name).toHaveValue("Store A");
  await name.fill("Unsaved Store A draft");
  const second = await context.newPage();
  await second.goto("/app/settings");
  await expect(second.getByLabel("Display name", { exact: true })).toHaveValue(
    "Store A",
  );
  await hide(page);
  await second.getByRole("button", { name: "Log out", exact: true }).click();
  await expect(second).toHaveURL(/\/login$/);
  await expect(page).toHaveURL(/\/login$/);
  await expect(
    page.locator('input[value="Unsaved Store A draft"]'),
  ).toHaveCount(0);
  await expect(page.getByLabel("Display name", { exact: true })).toHaveCount(0);
  expect(state.actor).toBeNull();
  await second.close();
});
