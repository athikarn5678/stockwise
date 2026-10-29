import type { Page } from "@playwright/test";

import {
  WEB_ORIGIN,
  accessContextStatus,
  demoEmail,
  demoPassword,
  expect,
  newDemoContext,
  nextMail,
  test,
} from "./demo-fixtures.ts";

/**
 * STOCKWISE-DEMO-E2E-01: essential AWS Academy demo journeys on Better Auth
 * Native Live. The journeys build on each other (register → login/onboard →
 * invite), so they run serially and share synthetic identities in memory.
 */
test.describe.configure({ mode: "serial" });

const owner = {
  email: demoEmail("owner"),
  password: demoPassword("owner"),
  displayName: "Demo Owner",
  organizationName: "Demo Synthetic Store",
  branchName: "Demo Main Branch",
};
const cashier = {
  email: demoEmail("cashier"),
  password: demoPassword("cashier"),
};
let organizationId = "";
let invitationUrl = "";

const post = (page: Page, path: string) =>
  page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === path &&
      response.request().method() === "POST",
  );

async function register(page: Page, email: string, password: string) {
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Confirm password", { exact: true }).fill(password);
  const registration = post(page, "/api/v1/auth/register");
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  expect((await registration).status()).toBe(202);
  await expect(page).toHaveURL(`${WEB_ORIGIN}/verify-email`);
}

async function verifyByOtp(page: Page, email: string) {
  const mail = await nextMail(email, "verification");
  expect(mail.code).toMatch(/^[0-9]{6}$/);
  await page.getByLabel("6-digit verification code").fill(mail.code!);
  const verification = post(page, "/api/v1/auth/verify-email-code");
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  expect((await verification).status()).toBe(200);
  await expect(
    page.getByText("Your email has been verified. You can now sign in.", {
      exact: true,
    }),
  ).toBeVisible();
}

async function signIn(page: Page, email: string, password: string) {
  if (new URL(page.url()).pathname !== "/login") await page.goto("/login");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  const login = post(page, "/api/v1/auth/login");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  expect((await login).status()).toBe(200);
}

async function logOut(page: Page) {
  await page.getByRole("button", { name: "Log out", exact: true }).click();
  await expect(page).toHaveURL(`${WEB_ORIGIN}/login`);
  expect(await accessContextStatus(page)).toBe(401);
}

type AccessContext = {
  data: {
    organizations: {
      id: string;
      name: string;
      role: string;
      branches: { code: string }[];
    }[];
  };
};

async function accessContext(page: Page): Promise<AccessContext> {
  return page.evaluate(async () =>
    (await fetch("/api/v1/me/access-context")).json(),
  );
}

test("1 register: synthetic account verifies by captured OTP without auto-login", async ({
  browser,
  monitor,
}) => {
  const { context, page } = await newDemoContext(browser, monitor);
  try {
    await page.goto("/register");
    await register(page, owner.email, owner.password);
    // Pending registration: verification is required and no session exists.
    await expect(page.getByLabel("6-digit verification code")).toBeVisible();
    expect(await accessContextStatus(page)).toBe(401);

    await verifyByOtp(page, owner.email);
    // Verification creates the account but never signs the user in.
    expect(await accessContextStatus(page)).toBe(401);
    await page.goto("/app");
    await expect(page).toHaveURL(`${WEB_ORIGIN}/login`);
  } finally {
    await context.close();
  }
});

test("2 login: owner onboards, workspace persists across refresh, logout locks routes", async ({
  browser,
  monitor,
}) => {
  const { context, page } = await newDemoContext(browser, monitor);
  try {
    await signIn(page, owner.email, owner.password);
    await expect(page).toHaveURL(`${WEB_ORIGIN}/onboarding`);
    await page
      .getByLabel("Display name", { exact: true })
      .fill(owner.displayName);
    await page
      .getByLabel("Organization name", { exact: true })
      .fill(owner.organizationName);
    await page
      .getByLabel("First branch name", { exact: true })
      .fill(owner.branchName);
    const onboarding = post(page, "/api/v1/organizations");
    await page
      .getByRole("button", { name: "Create organization", exact: true })
      .click();
    expect((await onboarding).status()).toBeLessThan(300);
    await expect(page).toHaveURL(/\/app\?organizationId=[0-9a-f-]{36}/);
    organizationId = new URL(page.url()).searchParams.get("organizationId")!;

    const workspace = await accessContext(page);
    expect(workspace.data.organizations).toMatchObject([
      {
        id: organizationId,
        name: owner.organizationName,
        role: "OWNER",
        branches: [{ code: "MAIN" }],
      },
    ]);
    await expect(page.getByText(owner.organizationName).first()).toBeVisible();

    await page.reload();
    await expect(page).toHaveURL(/\/app\?organizationId=/);
    await expect(page.getByText(owner.organizationName).first()).toBeVisible();
    expect(await accessContextStatus(page)).toBe(200);

    await logOut(page);
    for (const route of ["/app", "/app/members", "/onboarding"]) {
      await page.goto(route);
      await expect(page).toHaveURL(`${WEB_ORIGIN}/login`);
    }
  } finally {
    await context.close();
  }
});

test("3 invitation: owner invites a CASHIER for MAIN who registers and accepts", async ({
  browser,
  monitor,
}) => {
  expect(organizationId).not.toBe("");
  const ownerSide = await newDemoContext(browser, monitor);
  try {
    const page = ownerSide.page;
    await signIn(page, owner.email, owner.password);
    await expect(page).toHaveURL(/\/app\?organizationId=/);
    await page.getByRole("link", { name: "Manage members" }).first().click();
    await expect(page).toHaveURL(/\/app\/members\?/);
    // Member cards also render role/branch controls; use the invite form only.
    // A wrapped <select> is named by its label plus the selected option.
    const inviteForm = page.locator("form").filter({
      has: page.getByRole("heading", { name: "Invite member", exact: true }),
    });
    await inviteForm.getByLabel("Email", { exact: true }).fill(cashier.email);
    await inviteForm
      .getByRole("combobox", { name: /^Role\b/ })
      .selectOption("CASHIER");
    await inviteForm.getByRole("checkbox", { name: /^MAIN — / }).check();
    page.once("dialog", (dialog) => void dialog.accept());
    const invitation = post(
      page,
      `/api/v1/organizations/${organizationId}/invitations`,
    );
    await inviteForm
      .getByRole("button", { name: "Send invitation", exact: true })
      .click();
    expect((await invitation).status()).toBe(201);
    await expect(page.getByText("Invitation sent.")).toBeVisible();
    await expect(
      page
        .getByRole("region", { name: "Open invitations" })
        .getByText(cashier.email),
    ).toBeVisible();
    invitationUrl = (await nextMail(cashier.email, "invitation")).url;
    expect(new URL(invitationUrl).origin).toBe(WEB_ORIGIN);
  } finally {
    await ownerSide.context.close();
  }

  const cashierSide = await newDemoContext(browser, monitor);
  try {
    const page = cashierSide.page;
    const continuation = post(page, "/api/v1/invitations/continuations");
    await page.goto(invitationUrl);
    expect((await continuation).status()).toBe(200);
    await expect(page).toHaveURL(`${WEB_ORIGIN}/accept-invitation`);
    await page
      .getByRole("main")
      .getByRole("link", { name: "Create account", exact: true })
      .click();
    await register(page, cashier.email, cashier.password);
    await verifyByOtp(page, cashier.email);
    expect(await accessContextStatus(page)).toBe(401);
    await page
      .getByRole("main")
      .getByRole("link", { name: "Sign in", exact: true })
      .click();
    await expect(page).toHaveURL(`${WEB_ORIGIN}/login`);
    await signIn(page, cashier.email, cashier.password);
    await expect(page).toHaveURL(`${WEB_ORIGIN}/accept-invitation`);

    const accepted = post(page, "/api/v1/invitations/continuations/accept");
    await page
      .getByRole("button", { name: "Accept invitation", exact: true })
      .click();
    expect((await accepted).status()).toBe(200);
    await expect(page).toHaveURL(
      new RegExp(`/app\\?organizationId=${organizationId}`),
    );
    const membership = await accessContext(page);
    expect(membership.data.organizations).toMatchObject([
      {
        id: organizationId,
        name: owner.organizationName,
        role: "CASHIER",
        branches: [{ code: "MAIN" }],
      },
    ]);
    await expect(page.getByText(owner.organizationName).first()).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Manage members" }),
    ).toHaveCount(0);
  } finally {
    await cashierSide.context.close();
  }
});

test("4 reliability: refresh, navigation, logout and authorization boundaries", async ({
  browser,
  monitor,
}) => {
  expect(organizationId).not.toBe("");
  const ownerSide = await newDemoContext(browser, monitor);
  try {
    const page = ownerSide.page;
    await signIn(page, owner.email, owner.password);
    await expect(page).toHaveURL(/\/app\?organizationId=/);
    for (const [name, path] of [
      ["Catalog", "/app/catalog"],
      ["Inventory", "/app/inventory"],
      ["Manage members", "/app/members"],
    ] as const) {
      await page.getByRole("link", { name, exact: true }).first().click();
      await expect(page).toHaveURL(new RegExp(`${path}\\?`));
      await page.reload();
      await expect(page).toHaveURL(new RegExp(`${path}\\?`));
      expect(await accessContextStatus(page)).toBe(200);
    }
    await page.goBack();
    await expect(page).toHaveURL(/\/app\/inventory\?/);
    await page.goForward();
    await expect(page).toHaveURL(/\/app\/members\?/);
    await expect(
      page
        .getByRole("region", { name: "Organization members" })
        .getByText(cashier.email)
        .first(),
    ).toBeVisible();

    // Owner of this organization has no access to an unrelated one.
    const foreign = await page.request.get(
      `/api/v1/organizations/00000000-0000-4000-8000-000000000000/branches`,
    );
    expect([403, 404]).toContain(foreign.status());
    await logOut(page);
  } finally {
    await ownerSide.context.close();
  }

  const cashierSide = await newDemoContext(browser, monitor);
  try {
    const page = cashierSide.page;
    await signIn(page, cashier.email, cashier.password);
    await expect(page).toHaveURL(/\/app\?organizationId=/);
    await page.reload();
    expect(await accessContextStatus(page)).toBe(200);
    // CASHIER cannot administer members or branches (server is the boundary).
    expect(
      (
        await page.request.get(
          `/api/v1/organizations/${organizationId}/members`,
        )
      ).status(),
    ).toBe(403);
    expect(
      (
        await page.request.post(
          `/api/v1/organizations/${organizationId}/branches`,
          {
            headers: { Origin: WEB_ORIGIN },
            data: { code: "DENIED", name: "Denied branch" },
          },
        )
      ).status(),
    ).toBe(403);
    await page.goto(`/app/members?organizationId=${organizationId}`);
    await expect(
      page.getByText(
        "Owner or administrator access is required for this organization.",
      ),
    ).toBeVisible();
    await page.goto(`/app?organizationId=${organizationId}`);
    await logOut(page);
    await page.goto("/app");
    await expect(page).toHaveURL(`${WEB_ORIGIN}/login`);
  } finally {
    await cashierSide.context.close();
  }

  const anonymous = await newDemoContext(browser, monitor);
  try {
    await anonymous.page.goto("/login");
    expect(await accessContextStatus(anonymous.page)).toBe(401);
  } finally {
    await anonymous.context.close();
  }
});
