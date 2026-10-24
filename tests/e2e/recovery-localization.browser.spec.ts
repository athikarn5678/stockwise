import { expect, test } from "@playwright/test";
import { en } from "../../apps/web/src/i18n/en";
import { th } from "../../apps/web/src/i18n/th";

const syntheticToken = "A".repeat(43);
const syntheticPassword = "  synthetic Unicode password 😀  ";

for (const language of ["en", "th"] as const) {
  const copy = language === "th" ? th : en;
  const other = language === "th" ? en : th;
  for (const flow of ["forgot", "reset"] as const) {
    test(`recovery ${flow} ${language}: keyboard validation, switching, pending and completion preserve credentials`, async ({
      page,
    }) => {
      await page.addInitScript(
        (language) => localStorage.setItem("stockwise.language", language),
        language,
      );
      let posts = 0;
      const pending = Promise.withResolvers<void>();
      await page.route("**/api/v1/**", async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/api/v1/me/access-context")
          return route.fulfill({
            status: 401,
            json: { error: { code: "AUTHENTICATION_REQUIRED" } },
          });
        if (
          path ===
          `/api/v1/auth/${flow === "forgot" ? "forgot-password" : "reset-password"}`
        ) {
          posts += 1;
          expect(route.request().method()).toBe("POST");
          expect(route.request().postDataJSON()).toEqual(
            flow === "forgot"
              ? { email: "synthetic@example.test" }
              : { newPassword: syntheticPassword, token: syntheticToken },
          );
          await pending.promise;
          return route.fulfill({
            status: flow === "forgot" ? 202 : 200,
            json: {
              data: {
                status: flow === "forgot" ? "accepted" : "password_reset",
              },
            },
          });
        }
        return route.fulfill({
          status: 503,
          json: { error: { code: "DEPENDENCY_UNAVAILABLE" } },
        });
      });
      const response = await page.goto(
        flow === "forgot"
          ? "/forgot-password"
          : `/reset-password?token=${syntheticToken}`,
      );
      await expect(page).toHaveURL(
        new RegExp(
          `/${flow === "forgot" ? "forgot-password" : "reset-password"}$`,
        ),
      );
      if (flow === "reset") {
        expect(await response!.text()).not.toContain(syntheticToken);
        expect(response!.headers()["cache-control"]).toContain("no-store");
        expect(response!.headers()["referrer-policy"]).toBe("no-referrer");
      }
      await expect(
        page.getByRole("heading", {
          name: flow === "forgot" ? copy.authForgotTitle : copy.authResetTitle,
        }),
      ).toBeVisible();
      const input = page.locator(
        flow === "forgot" ? "#password_reset-email" : "#reset-password",
      );
      await input.fill(flow === "forgot" ? "invalid" : "short");
      await input.press("Enter");
      const alert = page.getByRole("main").getByRole("alert");
      await expect(alert).toHaveText(
        flow === "forgot" ? copy.authInvalidEmail : copy.authPasswordLength,
      );
      await expect(alert).toBeFocused();
      await expect(input).toHaveAttribute("aria-invalid", "true");
      expect(
        (await input.getAttribute("aria-describedby"))?.split(" "),
      ).toContain(await alert.getAttribute("id"));
      expect(posts).toBe(0);
      await page
        .getByRole("button", { name: copy.language, exact: true })
        .click();
      await expect(alert).toHaveText(
        flow === "forgot" ? other.authInvalidEmail : other.authPasswordLength,
      );
      await input.fill(
        flow === "forgot" ? "synthetic@example.test" : syntheticPassword,
      );
      await input.press("Enter");
      await expect(
        page.getByRole("button", {
          name:
            flow === "forgot"
              ? other.authResendSending
              : other.authResettingPassword,
          exact: true,
        }),
      ).toBeDisabled();
      await page
        .getByRole("button", { name: other.language, exact: true })
        .click();
      await expect(
        page.getByRole("button", {
          name:
            flow === "forgot"
              ? copy.authResendSending
              : copy.authResettingPassword,
          exact: true,
        }),
      ).toBeDisabled();
      pending.resolve();
      await expect(page.getByRole("status")).toHaveText(
        flow === "forgot" ? copy.authResetAccepted : copy.authResetComplete,
      );
      await expect(page.getByRole("status")).toBeFocused();
      expect(posts).toBe(1);
      const storage = await page.evaluate(() => [
        JSON.stringify(localStorage),
        JSON.stringify(sessionStorage),
      ]);
      for (const value of storage) {
        expect(value).not.toContain(syntheticToken);
        expect(value).not.toContain(syntheticPassword);
      }
      const signIn = page.getByRole("main").getByRole("link", {
        name: flow === "forgot" ? copy.authBackToLogin : copy.authSignIn,
        exact: true,
      });
      await signIn.focus();
      await signIn.press("Enter");
      await expect(page).toHaveURL(/\/login$/);
    });
  }

  test(`recovery entry ${language}: loading and failure localize without retaining reset credentials`, async ({
    page,
  }) => {
    await page.addInitScript(
      (language) => localStorage.setItem("stockwise.language", language),
      language,
    );
    const pending = Promise.withResolvers<void>();
    await page.route("**/reset-password", async (route) => {
      if (route.request().resourceType() !== "fetch") return route.continue();
      await pending.promise;
      return route.fulfill({
        status: 503,
        contentType: "text/plain",
        body: "controlled unavailable",
      });
    });
    await page.goto(`/reset-password?token=${syntheticToken}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page).toHaveURL(/\/reset-password$/);
    await expect(page.getByRole("status")).toHaveText(copy.loading);
    await expect(page.locator("html")).toHaveAttribute("lang", language);
    pending.resolve();
    await expect(page.getByRole("status")).toHaveText(copy.authResetOpenError);
    expect(
      await page.evaluate(() =>
        Object.hasOwn(window, "__stockwiseTakeCredentialLink"),
      ),
    ).toBe(false);
    for (const value of await page.evaluate(() => [
      JSON.stringify(localStorage),
      JSON.stringify(sessionStorage),
    ]))
      expect(value).not.toContain(syntheticToken);
  });
}
