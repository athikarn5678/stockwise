import { randomBytes, randomUUID } from "node:crypto";
import {
  test as base,
  expect,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { startHarness } from "./harness-runtime.ts";
import { createDelayedAuthResponse } from "./safe-route.ts";
const webOrigin = "http://localhost:3102";

type Harness = Awaited<ReturnType<typeof startHarness>>;
export type Scenario = {
  page: Page;
  harness: Harness;
  email: string;
  password: string;
  delayedResponse: () => ReturnType<typeof createDelayedAuthResponse>;
};

export const test = base.extend<{ scenario: Scenario }, { harness: Harness }>({
  harness: [
    async ({ browserName }, use) => {
      if (browserName !== "chromium")
        throw new Error(
          "Only the reviewed Chromium integration project is supported.",
        );
      let harness: Harness | undefined;
      try {
        harness = await startHarness();
        await use(harness);
      } catch {
        throw new Error(
          "Authentication harness setup or scenario failed; details withheld.",
        );
      } finally {
        await harness?.stop();
      }
    },
    { scope: "worker", timeout: 180_000 },
  ],
  scenario: async ({ page, harness }, use) => {
    const email = `t02a-${randomUUID()}@example.invalid`;
    const password = randomBytes(24).toString("base64url");
    harness.mailbox.allowAccount(email);
    const callbacks: ReturnType<typeof createDelayedAuthResponse>[] = [];
    let callbackFailed: boolean;
    try {
      await page.addInitScript(() =>
        localStorage.setItem("stockwise.language", "en"),
      );
      await use({
        page,
        harness,
        email,
        password,
        delayedResponse() {
          const callback = createDelayedAuthResponse(page);
          callbacks.push(callback);
          return callback;
        },
      });
    } finally {
      harness.mailbox.releaseAccount(email);
      const outcomes = await Promise.allSettled(
        callbacks.map((callback) => callback.finish()),
      );
      callbackFailed = outcomes.some(
        (outcome) => outcome.status === "rejected",
      );
    }
    if (callbackFailed)
      throw new Error(
        "Authentication route callback failed; details withheld.",
      );
  },
});

// Catch action/matcher errors before Playwright can copy input values into reports.
export function scenario(
  name: string,
  body: (input: Scenario, info: TestInfo) => Promise<void>,
) {
  test(name, async ({ scenario: input }, info) => {
    try {
      await body(input, info);
    } catch {
      throw new Error(
        "Authentication integration assertion failed; credential-bearing details withheld.",
      );
    }
  });
}
export { expect };

export async function post(
  page: Page,
  path: string,
  body: Record<string, unknown>,
) {
  return page.evaluate(
    async ({ path, body }) => {
      // Same-origin browser fetch exercises Secure/HttpOnly cookie transmission.
      const response = await fetch(`/api/v1/${path}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data: unknown =
        response.status === 204 ? null : await response.json();
      return { status: response.status, data };
    },
    { path, body },
  );
}

export async function register(input: Scenario) {
  await input.page.goto("/register");
  await input.page.getByLabel("Email address").fill(input.email);
  await input.page.getByLabel("Password", { exact: true }).fill(input.password);
  await input.page
    .getByLabel("Confirm password", { exact: true })
    .fill(input.password);
  const response = input.page
    .waitForResponse(
      (r) =>
        r.url().endsWith("/auth/register") && r.request().method() === "POST",
    )
    .catch(() => null);
  await input.page
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  expect((await response)?.status()).toBe(202);
  await input.page.getByRole("link", { name: "Continue verification" }).click();
  await expect(input.page).toHaveURL(`${webOrigin}/verify-email`);
  const mail = await input.harness.mailbox.next(input.email);
  const challenge =
    await input.harness.prisma.emailVerificationChallenge.findFirstOrThrow({
      where: {
        user: { email: input.email },
        consumedAt: null,
        replacedAt: null,
        revokedAt: null,
      },
      select: { id: true },
    });
  return { mail, challengeId: challenge.id };
}

export async function noAuthority(input: Scenario) {
  expect(
    (await input.page.context().cookies()).some(
      (c) => c.name === "stockwise_session",
    ),
  ).toBe(false);
  expect(
    await input.harness.prisma.session.count({
      where: { user: { email: input.email } },
    }),
  ).toBe(0);
  expect(
    await input.page.evaluate(
      async () => (await fetch("/api/v1/me/access-context")).status,
    ),
  ).toBe(401);
}

export async function verifyCode(input: Scenario, code: string) {
  await input.page.getByLabel("6-digit verification code").fill(code);
  await input.page.getByRole("button", { name: "Verify", exact: true }).click();
  await expect(
    input.page.getByText("Your email has been verified. You can now sign in.", {
      exact: true,
    }),
  ).toBeVisible();
}
