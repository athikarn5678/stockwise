import { expect, test, type BrowserContext, type Page } from "@playwright/test";

const org = "10000000-0000-4000-8000-000000000001";
const branch = "20000000-0000-4000-8000-000000000001";
const user = "30000000-0000-4000-8000-000000000001";
const successorUser = "30000000-0000-4000-8000-000000000002";
async function mockSession(
  context: BrowserContext,
  initial: string | null = "Store A",
  onboarding = false,
) {
  const state = { actor: initial, status: 200, requests: 0, logoutStatus: 204 };
  await context.addInitScript(() =>
    localStorage.setItem("stockwise.language", "en"),
  );
  // Every API call is intercepted: no API process, accounts, mail or database.
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
              id: state.actor === "Store B" ? successorUser : user,
              email: "synthetic@example.test",
              displayName: state.actor,
            },
            firstOrganizationOnboarding: { eligible: onboarding },
            organizations: onboarding
              ? []
              : [
                  {
                    id: org,
                    name: state.actor,
                    role: state.actor === "Store B" ? "CASHIER" : "OWNER",
                    branches: [{ id: branch, code: "MAIN", name: "Main" }],
                  },
                ],
          },
        },
      });
    }
    if (path.endsWith("/auth/logout")) {
      if (state.logoutStatus === 204) state.actor = null;
      return route.fulfill({
        status: state.logoutStatus,
        ...(state.logoutStatus === 204
          ? {}
          : { json: { error: { code: "DEPENDENCY_UNAVAILABLE" } } }),
      });
    }
    if (path.endsWith("/auth/login")) {
      state.actor = "Store B";
      return route.fulfill({
        json: {
          data: {
            user: {
              id: successorUser,
              email: "synthetic@example.test",
              displayName: state.actor,
            },
          },
        },
      });
    }
    return route.fulfill({
      status: 503,
      json: { error: { code: "DEPENDENCY_UNAVAILABLE" } },
    });
  });
  return state;
}
/**
 * A sign-in returns to the landing page by default, so the workspace is one
 * click away: open it from the public header when the page is still there.
 */
async function expectWorkspaceHeading(page: Page, name: string) {
  const dashboard = page.getByRole("link", { name: "Go to dashboard" });
  const heading = page.getByRole("heading", { name, exact: true });
  await expect(heading.or(dashboard)).toBeVisible();
  if (await dashboard.isVisible()) await dashboard.click();
  await expect(heading).toBeVisible();
}

async function submitLogin(page: Page) {
  await page
    .getByLabel("Email address", { exact: true })
    .fill("synthetic@example.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill("synthetic password only");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

for (const fallback of [false, true]) {
  test(`two tabs logout then login as another actor (${fallback ? "storage fallback" : "BroadcastChannel"})`, async ({
    context,
    page,
  }) => {
    if (fallback)
      await context.addInitScript(() => {
        Object.defineProperty(window, "BroadcastChannel", { value: undefined });
      });
    const state = await mockSession(context);
    const second = await context.newPage();
    await page.goto("/app");
    await second.goto("/app");
    await expect(
      page.getByRole("heading", { name: "Store A", exact: true }),
    ).toBeVisible();
    await expect(
      second.getByRole("heading", { name: "Store A", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Log out", exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(second).toHaveURL(/\/login$/);
    await expect(second.getByText("Store A", { exact: true })).toHaveCount(0);
    await submitLogin(page);
    await expectWorkspaceHeading(page, "Store B");
    await expectWorkspaceHeading(second, "Store B");
    // The successor has a different user ID and reduced role, not just a new display name.
    await expect(
      second.getByRole("link", { name: "Members", exact: true }),
    ).toHaveCount(0);
    const hint = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("stockwise.session-change")!),
    );
    expect(Object.keys(hint).sort()).toEqual(["id", "type", "version"]);
    expect(hint).toMatchObject({
      version: 1,
      type: "session-change",
      id: expect.any(String),
    });
    expect(JSON.stringify(hint)).not.toMatch(
      /synthetic|Store|OWNER|cookie|token|proof/,
    );
    const count = state.requests;
    await page.waitForTimeout(300);
    expect(state.requests).toBe(count);
    await second.close();
  });
}

test("pageshow blocks old onboarding draft until fresh authority and resets local state", async ({
  context,
  page,
}) => {
  const state = await mockSession(context, "Store A", true);
  await page.goto("/onboarding");
  await page
    .getByLabel("Organization name", { exact: true })
    .fill("private draft A");
  await page.evaluate(() =>
    window.dispatchEvent(
      new PageTransitionEvent("pagehide", { persisted: true }),
    ),
  );
  await expect(
    page.getByLabel("Organization name", { exact: true }),
  ).toHaveCount(0);
  state.actor = "Store B";
  await page.evaluate(() =>
    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: true }),
    ),
  );
  await expect(
    page.getByLabel("Organization name", { exact: true }),
  ).toHaveValue("");
  await expect(page.getByText("private draft A", { exact: true })).toHaveCount(
    0,
  );
});

test("restored protected document recovers to login after expiry without loop", async ({
  context,
  page,
}) => {
  const state = await mockSession(context);
  await page.goto("/app");
  await expect(
    page.getByRole("heading", { name: "Store A", exact: true }),
  ).toBeVisible();
  state.actor = null;
  await page.evaluate(() => {
    window.dispatchEvent(
      new PageTransitionEvent("pagehide", { persisted: true }),
    );
    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: true }),
    );
  });
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
  await expect(page.getByText("Store A", { exact: true })).toHaveCount(0);
  const count = state.requests;
  await page.waitForTimeout(300);
  expect(state.requests).toBe(count);
});

for (const status of [403, 503, 0]) {
  test(`protected ${status || "network"} remains unavailable or denied with retry, not signed out`, async ({
    context,
    page,
  }) => {
    const state = await mockSession(context);
    state.status = status;
    await page.goto("/app");
    await expect(page.getByRole("main").getByRole("alert")).toContainText(
      status === 403 ? "permission" : "could not be loaded",
    );
    await expect(page).toHaveURL(/\/app$/);
    await expect(
      page.getByRole("button", { name: "Log out", exact: true }),
    ).toHaveCount(0);
    state.status = 200;
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Store A", exact: true }),
    ).toBeVisible();
  });
}

test("failed logout keeps authenticated screen and does not publish a success hint", async ({
  context,
  page,
}) => {
  const state = await mockSession(context);
  state.logoutStatus = 503;
  await page.goto("/app");
  await expect(
    page.getByRole("heading", { name: "Store A", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Log out", exact: true }).click();
  await expect(
    page.getByRole("complementary").getByRole("alert"),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Store A", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => localStorage.getItem("stockwise.session-change")),
  ).toBeNull();
});

test("public marketing stays session-free across restoration and other-tab hints", async ({
  context,
  page,
}) => {
  const state = await mockSession(context);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: /Run your inventory with clarity/ }),
  ).toBeVisible();
  await page.evaluate(() => {
    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: true }),
    );
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "stockwise.session-change",
        newValue: JSON.stringify({
          version: 1,
          type: "session-change",
          id: "synthetic-tab",
        }),
      }),
    );
    window.dispatchEvent(new Event("focus"));
  });
  expect(state.requests).toBe(0);
  await expect(
    page.getByRole("heading", { name: /Run your inventory with clarity/ }),
  ).toBeVisible();
});

test("late accepted login after pagehide reconciles actual authority on restoration", async ({
  context,
  page,
}) => {
  const state = await mockSession(context, null);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested = false;
  await page.route("**/api/v1/auth/login", async (route) => {
    requested = true;
    await pending;
    state.actor = "Store B";
    await route.fulfill({
      json: {
        data: {
          user: {
            id: user,
            email: "synthetic@example.test",
            displayName: "Store B",
          },
        },
      },
    });
  });
  await page.goto("/login");
  await submitLogin(page);
  await expect.poll(() => requested).toBe(true);
  await page.evaluate(() =>
    window.dispatchEvent(
      new PageTransitionEvent("pagehide", { persisted: true }),
    ),
  );
  release();
  await expect.poll(() => state.actor).toBe("Store B");
  await expect(page).toHaveURL(/\/login$/);
  await page.evaluate(() =>
    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: true }),
    ),
  );
  await expectWorkspaceHeading(page, "Store B");
  expect(
    await page.evaluate(() =>
      sessionStorage.getItem("stockwise_verification_continuation"),
    ),
  ).toBeNull();
});

test("a protected resource 401 removes private content and offers recovery without an automatic redirect loop", async ({
  context,
  page,
}) => {
  await mockSession(context);
  await page.route("**/api/v1/organizations/*/categories*", (route) =>
    route.fulfill({
      status: 401,
      json: { error: { code: "SESSION_EXPIRED" } },
    }),
  );
  await page.goto(`/app/catalog?organizationId=${org}&branchId=${branch}`);
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "Sign in again",
  );
  await expect(
    page.getByRole("button", { name: /Create product/ }),
  ).toHaveCount(0);
  await page
    .getByRole("main")
    .getByRole("link", { name: "Sign in", exact: true })
    .click();
  // The sign-in link carries the page the visitor was on as `next`; the mocked
  // session is still valid, so sign-in returns there (its categories stay 401).
  await expect(page).toHaveURL(/\/app\/catalog\?/);
});

test("native history Back never restores expired private authority", async ({
  context,
  page,
}) => {
  const state = await mockSession(context);
  await context.addInitScript(() => {
    window.addEventListener("pageshow", (event) => {
      const previous: boolean[] = JSON.parse(
        sessionStorage.getItem("stockwise.test.pageshow") ?? "[]",
      );
      sessionStorage.setItem(
        "stockwise.test.pageshow",
        JSON.stringify([...previous, event.persisted]),
      );
    });
  });
  await page.goto("/app");
  await expect(
    page.getByRole("heading", { name: "Store A", exact: true }),
  ).toBeVisible();
  await page.goto("about:blank");
  state.actor = null;
  await page.goBack();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
  await expect(page.getByText("Store A", { exact: true })).toHaveCount(0);
  const events: boolean[] = await page.evaluate(() =>
    JSON.parse(sessionStorage.getItem("stockwise.test.pageshow") ?? "[]"),
  );
  console.log(`NATIVE_HISTORY_PAGESHOW persisted=${events.includes(true)}`);
});

for (const authPath of ["/login", "/register"]) {
  test(`returning focus preserves a drafted ${authPath} form while revalidating anonymous authority`, async ({
    context,
    page,
  }) => {
    const state = await mockSession(context, null);
    await page.goto(authPath);
    await page
      .getByLabel("Email address", { exact: true })
      .fill("draft@example.test");
    await page
      .getByLabel("Password", { exact: true })
      .fill("temporary draft password");
    await page.evaluate(() => {
      window.dispatchEvent(new Event("blur"));
      window.dispatchEvent(new Event("focus"));
    });
    await expect(page.getByLabel("Email address", { exact: true })).toHaveValue(
      "draft@example.test",
    );
    await expect(page.getByLabel("Password", { exact: true })).toHaveValue(
      "temporary draft password",
    );
    await expect(
      page.getByText("Loading access", { exact: false }),
    ).toHaveCount(0);
    const helper = await context.newPage();
    await helper.goto("about:blank");
    await helper.bringToFront();
    await page.bringToFront();
    await expect(page.getByLabel("Email address", { exact: true })).toHaveValue(
      "draft@example.test",
    );
    await expect(page.getByLabel("Password", { exact: true })).toHaveValue(
      "temporary draft password",
    );
    expect(state.actor).toBeNull();
    await helper.close();
  });
}

for (const authPath of ["/login", "/register"]) {
  test(`a drafted ${authPath} form survives hidden/visible lifecycle and a failed background recheck`, async ({
    context,
    page,
  }) => {
    await mockSession(context, null);
    await page.goto(authPath);
    await page
      .getByLabel("Email address", { exact: true })
      .fill("draft@example.test");
    await page
      .getByLabel("Password", { exact: true })
      .fill("temporary draft password");
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(page.getByLabel("Email address", { exact: true })).toHaveValue(
      "draft@example.test",
    );
    await page.route("**/api/v1/me/access-context", (route) =>
      route.fulfill({
        status: 503,
        json: { error: { code: "DEPENDENCY_UNAVAILABLE" } },
      }),
    );
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "visible",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(page.getByLabel("Email address", { exact: true })).toHaveValue(
      "draft@example.test",
    );
    await expect(page.getByLabel("Password", { exact: true })).toHaveValue(
      "temporary draft password",
    );
    await expect(
      page.getByText("Loading access", { exact: false }),
    ).toHaveCount(0);
  });

  test(`a focused ${authPath} form redirects after the backend confirms a new session`, async ({
    context,
    page,
  }) => {
    const state = await mockSession(context, null);
    await page.goto(authPath);
    await page
      .getByLabel("Email address", { exact: true })
      .fill("draft@example.test");
    state.actor = "Store A";
    await page.evaluate(() => {
      window.dispatchEvent(new Event("blur"));
      window.dispatchEvent(new Event("focus"));
    });
    // Sign-in pages return to the landing page; other guest pages open the app.
    if (authPath === "/login") await expectWorkspaceHeading(page, "Store A");
    else
      await expect(
        page.getByRole("heading", { name: "Store A", exact: true }),
      ).toBeVisible();
    await expect(page).toHaveURL(/\/app/);
    await expect(page.getByLabel("Email address", { exact: true })).toHaveCount(
      0,
    );
  });
}
