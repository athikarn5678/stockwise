import { expect, test, type Page } from "@playwright/test";

const token = "synthetic_link_" + "a".repeat(27) + "b";
const challengeId = "11111111-1111-4111-8111-111111111111";
const successor = "22222222-2222-4222-8222-222222222222";
const storageKey = "stockwise_verification_continuation";
const longEmail = `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.example.com`;

async function expectNoCredential(page: Page) {
  const surfaces = await page.evaluate(() => ({
    url: location.href,
    history: JSON.stringify(history.state),
    html: document.documentElement.outerHTML,
    session: JSON.stringify(sessionStorage),
    local: JSON.stringify(localStorage),
    cookie: document.cookie,
    handoff: Object.hasOwn(window, "__stockwiseTakeVerificationLink"),
  }));
  for (const value of Object.values(surfaces))
    if (typeof value === "string") expect(value).not.toContain(token);
  expect(surfaces.handoff).toBe(false);
  expect(new URL(surfaces.url).search).toBe("");
  expect(JSON.stringify(await page.context().cookies())).not.toContain(token);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("stockwise.language", "en");
  });
  await page.route("**/api/**", (route) =>
    route.fulfill({
      status: 401,
      json: { error: { code: "AUTHENTICATION_REQUIRED" } },
    }),
  );
});

test("link entry never serializes credentials and requires explicit POST across router and history navigation", async ({
  page,
  request,
}) => {
  const response = await request.get(`/verify-email?token=${token}`);
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toBe("no-store");
  expect(response.headers()["referrer-policy"]).toBe("no-referrer");
  expect(await response.text()).not.toContain(token);
  expect(await response.text()).not.toContain("self.__next_f");
  const navigationResponse = await request.get(`/verify-email?token=${token}`, {
    headers: { RSC: "1" },
  });
  expect(navigationResponse.headers()["content-type"]).toContain("text/html");
  expect(await navigationResponse.text()).not.toContain(token);
  const destinations: string[] = [];
  page.on("request", (request) => destinations.push(request.url()));
  const posts: unknown[] = [];
  await page.route("**/api/v1/auth/verify-email", async (route) => {
    expect(route.request().method()).toBe("POST");
    posts.push(route.request().postDataJSON());
    await route.fulfill({ json: { data: { status: "verified" } } });
  });
  await page.goto("/");
  await page.goto(`/verify-email?token=${token}`);
  await expect(page.locator("main form button[type=submit]")).toBeVisible();
  expect(posts).toEqual([]);
  await expectNoCredential(page);
  await page.locator("main form button[type=submit]").click();
  await expect(
    page.getByRole("main").getByRole("link", { name: "Sign in", exact: true }),
  ).toBeVisible();
  expect(posts).toEqual([{ token }]);
  await expectNoCredential(page);
  await page
    .getByRole("main")
    .getByRole("link", { name: "Sign in", exact: true })
    .click();
  await expect(page).toHaveURL(/\/login$/);
  await expectNoCredential(page);
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await expectNoCredential(page);
  await page.goForward();
  await expect(page).toHaveURL(/\/login$/);
  await expectNoCredential(page);
  expect(destinations.filter((url) => url.includes(token))).toEqual([
    `http://localhost:3101/verify-email?token=${token}`,
  ]);
});

test("abandoning or reloading a link loses its credential rather than restoring it", async ({
  page,
}) => {
  let posts = 0;
  await page.route("**/api/v1/auth/verify-email", (route) => {
    posts += 1;
    return route.fulfill({ json: { data: { status: "verified" } } });
  });
  await page.goto("/");
  await page.goto(`/verify-email?token=${token}`);
  await expect(page.locator("main form button[type=submit]")).toBeVisible();
  await page.getByRole("link", { name: "Back to sign in" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await expectNoCredential(page);
  await expect(page.locator("main form button[type=submit]")).toHaveCount(0);
  await page.goto(`/verify-email?token=${token}`);
  await expect(page.locator("main form button[type=submit]")).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("link", { name: "Back to sign in" }),
  ).toBeVisible();
  await expectNoCredential(page);
  expect(posts).toBe(0);
});

test("all possible SPA entry documents reject cross-origin framing", async ({
  page,
  request,
}) => {
  for (const path of [
    "/",
    "/register",
    "/login",
    "/verification-resend",
    "/verify-email",
  ]) {
    const response = await request.get(path);
    expect(response.headers()["x-frame-options"]).toBe("DENY");
    expect(response.headers()["content-security-policy"]).toContain(
      "frame-ancestors 'none'",
    );
  }
  await page.route("http://127.0.0.1:3101/frame-parent", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<iframe id="direct" src="http://localhost:3101/verify-email?token=${token}"></iframe><iframe id="spa-entry" src="http://localhost:3101/register"></iframe>`,
    }),
  );
  const errors: string[] = [];
  const devtools = await page.context().newCDPSession(page);
  await devtools.send("Log.enable");
  devtools.on("Log.entryAdded", ({ entry }) => errors.push(entry.text));
  await page.goto("http://127.0.0.1:3101/frame-parent");
  await expect
    .poll(
      () =>
        errors.filter((message) =>
          /frame-ancestors|X-Frame-Options/i.test(message),
        ).length,
    )
    .toBeGreaterThanOrEqual(2);
  await expect(
    page
      .frameLocator("#direct")
      .getByRole("button", { name: "Verify", exact: true }),
  ).toHaveCount(0);
  // Registration cannot load in the parent: router.push cannot bypass document policy.
  await expect(
    page
      .frameLocator("#spa-entry")
      .getByRole("button", { name: "Create account" }),
  ).toHaveCount(0);
});

test("delayed resend cannot overwrite the next account after SPA abandonment", async ({
  page,
}) => {
  const delayed = Promise.withResolvers<void>();
  const received = Promise.withResolvers<void>();
  await page.addInitScript(
    ({ storageKey, challengeId }) => {
      sessionStorage.setItem(
        storageKey,
        JSON.stringify({
          version: 1,
          canonicalEmail: "a@example.com",
          challengeId,
          savedAt: Date.now(),
        }),
      );
    },
    { storageKey, challengeId },
  );
  await page.route("**/api/v1/auth/verification-resend", async (route) => {
    received.resolve();
    await delayed.promise;
    await route
      .fulfill({
        status: 202,
        json: {
          data: {
            status: "accepted",
            verification: { challengeId: successor },
          },
        },
      })
      .catch(() => {});
  });
  await page.goto("/verification-resend");
  await page.getByRole("button", { name: "Request verification code" }).click();
  await received.promise;
  await page.getByRole("link", { name: "Back to sign in" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.evaluate(
    ({ storageKey, challengeId }) => {
      sessionStorage.setItem(
        storageKey,
        JSON.stringify({
          version: 1,
          canonicalEmail: "b@example.com",
          challengeId,
          savedAt: Date.now(),
        }),
      );
    },
    { storageKey, challengeId },
  );
  delayed.resolve();
  await expect
    .poll(() =>
      page.evaluate(
        (key) => JSON.parse(sessionStorage.getItem(key)!).canonicalEmail,
        storageKey,
      ),
    )
    .toBe("b@example.com");
  await expect(page).toHaveURL(/\/login$/);
});

async function registerSuccessor(page: Page) {
  await page.locator('header a[href="/"]').click();
  await expect(page).toHaveURL(/\/$/);
  await page.getByRole("link", { name: "Get started" }).first().click();
  await expect(page).toHaveURL(/\/register$/);
  await page.getByLabel("Email address").fill("successor@example.com");
  await page.getByLabel("Password", { exact: true }).fill("correct-horse-123");
  await page
    .getByLabel("Confirm password", { exact: true })
    .fill("correct-horse-123");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/verify-email$/);
  await expect
    .poll(() =>
      page.evaluate(
        (key) => JSON.parse(sessionStorage.getItem(key)!),
        storageKey,
      ),
    )
    .toMatchObject({
      canonicalEmail: "successor@example.com",
      challengeId: successor,
    });
}

test("an active password-proof retry verifies the same link exactly once", async ({
  page,
}) => {
  let verifyPosts = 0;
  const verifyPayloads: unknown[] = [];
  let proofPosts = 0;
  await page.route("**/api/v1/auth/verify-email", async (route) => {
    verifyPosts += 1;
    verifyPayloads.push(route.request().postDataJSON());
    if (verifyPosts === 1) {
      await route.fulfill({
        status: 401,
        json: { error: { code: "VERIFICATION_PASSWORD_PROOF_REQUIRED" } },
      });
      return;
    }
    await route.fulfill({ json: { data: { status: "verified" } } });
  });
  await page.route(
    "**/api/v1/auth/verification-password-proof",
    async (route) => {
      proofPosts += 1;
      await route.fulfill({
        status: 202,
        json: { data: { status: "accepted" } },
      });
    },
  );
  await page.goto(`/verify-email?token=${token}`);
  await page.locator("main form button[type=submit]").click();
  await page.getByLabel("Email address").fill("owner@example.com");
  await page.getByLabel("Password").fill("correct-horse-123");
  await page
    .getByRole("button", { name: "Confirm password", exact: true })
    .click();
  await expect(
    page.getByRole("main").getByRole("link", { name: "Sign in", exact: true }),
  ).toBeVisible();
  expect(proofPosts).toBe(1);
  expect(verifyPosts).toBe(2);
  expect(verifyPayloads).toEqual([{ token }, { token }]);
});

for (const proofStatus of ["success", "failure"] as const) {
  for (const abandonment of ["SPA", "pagehide"] as const) {
    test(`abandoned pending password proof (${proofStatus}, ${abandonment}) cannot verify or clear a successor`, async ({
      page,
    }) => {
      const delayed = Promise.withResolvers<void>();
      const received = Promise.withResolvers<void>();
      let verifyPosts = 0;
      await page.route("**/api/v1/auth/verify-email", async (route) => {
        verifyPosts += 1;
        await route.fulfill({
          status: 401,
          json: { error: { code: "VERIFICATION_PASSWORD_PROOF_REQUIRED" } },
        });
      });
      await page.route(
        "**/api/v1/auth/verification-password-proof",
        async (route) => {
          received.resolve();
          await delayed.promise;
          await route
            .fulfill(
              proofStatus === "success"
                ? { status: 202, json: { data: { status: "accepted" } } }
                : {
                    status: 401,
                    json: { error: { code: "INVALID_CREDENTIALS" } },
                  },
            )
            .catch(() => {});
        },
      );
      await page.route("**/api/v1/auth/register", (route) =>
        route.fulfill({
          status: 202,
          json: {
            data: {
              nextStep: "verify_email",
              status: "accepted",
              verification: { challengeId: successor },
            },
          },
        }),
      );
      await page.goto(`/verify-email?token=${token}`);
      await page.locator("main form button[type=submit]").click();
      await page.getByLabel("Email address").fill("owner@example.com");
      await page.getByLabel("Password").fill("correct-horse-123");
      await page
        .getByRole("button", { name: "Confirm password", exact: true })
        .click();
      await received.promise;
      if (abandonment === "pagehide")
        await page.evaluate(() =>
          window.dispatchEvent(new PageTransitionEvent("pagehide")),
        );
      await registerSuccessor(page);
      delayed.resolve();
      await expect
        .poll(() =>
          page.evaluate(
            (key) => JSON.parse(sessionStorage.getItem(key)!),
            storageKey,
          ),
        )
        .toMatchObject({
          canonicalEmail: "successor@example.com",
          challengeId: successor,
        });
      expect(verifyPosts).toBe(1);
      await expect(page).toHaveURL(/\/verify-email$/);
    });
  }
}

for (const verifyStatus of ["success", "failure"] as const) {
  for (const abandonment of ["SPA", "pagehide"] as const) {
    test(`abandoned pending verification (${verifyStatus}, ${abandonment}) cannot clear a successor`, async ({
      page,
    }) => {
      const delayed = Promise.withResolvers<void>();
      const received = Promise.withResolvers<void>();
      let verifyPosts = 0;
      await page.route("**/api/v1/auth/verify-email", async (route) => {
        verifyPosts += 1;
        received.resolve();
        await delayed.promise;
        await route
          .fulfill(
            verifyStatus === "success"
              ? { json: { data: { status: "verified" } } }
              : {
                  status: 401,
                  json: { error: { code: "INVALID_TOKEN" } },
                },
          )
          .catch(() => {});
      });
      await page.route("**/api/v1/auth/register", (route) =>
        route.fulfill({
          status: 202,
          json: {
            data: {
              nextStep: "verify_email",
              status: "accepted",
              verification: { challengeId: successor },
            },
          },
        }),
      );
      await page.goto(`/verify-email?token=${token}`);
      await page.locator("main form button[type=submit]").click();
      await received.promise;
      if (abandonment === "pagehide")
        await page.evaluate(() =>
          window.dispatchEvent(new PageTransitionEvent("pagehide")),
        );
      await registerSuccessor(page);
      delayed.resolve();
      await expect
        .poll(() =>
          page.evaluate(
            (key) => JSON.parse(sessionStorage.getItem(key)!),
            storageKey,
          ),
        )
        .toMatchObject({
          canonicalEmail: "successor@example.com",
          challengeId: successor,
        });
      expect(verifyPosts).toBe(1);
      await expect(page).toHaveURL(/\/verify-email$/);
    });
  }
}

for (const width of [320, 390]) {
  for (const language of ["en", "th"]) {
    for (const theme of ["light", "dark"]) {
      test(`long email wraps at ${width}px ${language} ${theme}; OTP selection and deletion remain native`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 844 });
        await page.addInitScript(
          ({ storageKey, challengeId, longEmail, language, theme }) => {
            localStorage.setItem("stockwise.language", language);
            localStorage.setItem("stockwise.theme", theme);
            sessionStorage.setItem(
              storageKey,
              JSON.stringify({
                version: 1,
                canonicalEmail: longEmail,
                challengeId,
                savedAt: Date.now(),
              }),
            );
          },
          { storageKey, challengeId, longEmail, language, theme },
        );
        await page.goto("/verify-email");
        const text = page.locator("p").filter({ hasText: longEmail });
        await expect(text).toBeVisible();
        await expect(page.locator("html")).toHaveAttribute("lang", language);
        await expect(page.locator("html")).toHaveClass(new RegExp(theme));
        const geometry = await text.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          return {
            left: bounds.left,
            right: bounds.right,
            scroll: element.scrollWidth,
            width: element.clientWidth,
            documentWidth: document.documentElement.scrollWidth,
            viewport: innerWidth,
            text: element.textContent,
          };
        });
        expect(geometry.text).toContain(longEmail);
        expect(geometry.left).toBeGreaterThanOrEqual(0);
        expect(geometry.right).toBeLessThanOrEqual(width);
        expect(geometry.scroll).toBeLessThanOrEqual(geometry.width);
        expect(geometry.documentWidth).toBe(geometry.viewport);
        const input = page.locator('input[autocomplete="one-time-code"]');
        await input.fill("");
        await input.pressSequentially("012345");
        await expect(input).toHaveValue("012345");
        await input.evaluate((element: HTMLInputElement) =>
          element.setSelectionRange(2, 3),
        );
        await input.pressSequentially("a");
        await expect(input).toHaveValue("01345");
        await expect
          .poll(() =>
            input.evaluate(
              (element: HTMLInputElement) => element.selectionStart,
            ),
          )
          .toBe(2);
        await input.pressSequentially("9");
        await expect(input).toHaveValue("019345");

        await input.evaluate((element: HTMLInputElement) => {
          element.setSelectionRange(2, 3);
          const clipboard = new DataTransfer();
          clipboard.setData("text", "9");
          element.dispatchEvent(
            new ClipboardEvent("paste", {
              clipboardData: clipboard,
              bubbles: true,
              cancelable: true,
            }),
          );
        });
        await expect(input).toHaveValue("019345");
        await input.press("Backspace");
        await expect(input).toHaveValue("01345");
        await input.press("Delete");
        await expect(input).toHaveValue("0145");
      });
    }
  }
}

test("BFCache restore retains the OTP email and focus does not discard its draft", async ({
  page,
}) => {
  await page.addInitScript(
    ({ storageKey, challengeId }) => {
      sessionStorage.setItem(
        storageKey,
        JSON.stringify({
          version: 1,
          canonicalEmail: "synthetic@example.com",
          challengeId,
          savedAt: Date.now(),
        }),
      );
    },
    { storageKey, challengeId },
  );
  let posts = 0;
  await page.route("**/api/v1/auth/verify-email-code", (route) => {
    posts++;
    expect(route.request().postDataJSON()).toEqual({
      email: "synthetic@example.com",
      challengeId,
      code: "654321",
    });
    return route.fulfill({ json: { data: { status: "verified" } } });
  });
  await page.goto("/verify-email");
  const input = page.getByLabel("6-digit verification code");
  await input.fill("012345");
  await page.evaluate(() => {
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new Event("focus"));
  });
  await expect(input).toHaveValue("012345");
  await page.evaluate(() => {
    window.dispatchEvent(
      new PageTransitionEvent("pagehide", { persisted: true }),
    );
    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: true }),
    );
  });
  await expect(
    page.getByText("synthetic@example.com", { exact: false }),
  ).toBeVisible();
  await expect(input).toHaveValue("");
  expect(posts).toBe(0);
  await input.fill("654321");
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await expect(
    page.getByRole("main").getByRole("link", { name: "Sign in", exact: true }),
  ).toBeVisible();
  expect(posts).toBe(1);
  expect(
    await page.evaluate((key) => sessionStorage.getItem(key), storageKey),
  ).toBeNull();
});
