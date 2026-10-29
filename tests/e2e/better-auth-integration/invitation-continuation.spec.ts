import { randomBytes, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { createPrismaMembershipAccessRepository } from "../../../apps/api/src/modules/identity/membership-access-repository.ts";
import {
  createMembershipAccessService,
  type MembershipAccessService,
} from "../../../apps/api/src/modules/identity/membership-access-service.ts";
import type { InvitationCreateInput } from "../../../apps/api/src/modules/identity/membership-access-schemas.ts";
import { secureOneTimeTokenProvider } from "../../../apps/api/src/modules/identity/one-time-token.ts";
import { hashPassword } from "../../../apps/api/src/modules/identity/password-hasher.ts";
import {
  journey,
  expect,
  register,
  verifyByCode,
  login,
  assertNoAuthority,
  post,
  type Scenario,
} from "./fixtures";

const origin = "http://localhost:3202";
const selectorKey = "stockwise_invitation_continuation";
const continuationCookieNames = [
  "__Host-stockwise_invitation_slot_0",
  "__Host-stockwise_invitation_slot_1",
  "__Host-stockwise_invitation_slot_2",
  "__Host-stockwise_invitation_slot_3",
];
const isContinuationCookie = (name: string) =>
  continuationCookieNames.includes(name);

interface Issued {
  owner: { id: string };
  organization: { id: string };
  branch: { id: string };
  service: MembershipAccessService;
  payload: {
    actorUserId: string;
    organizationId: string;
    invitation: InvitationCreateInput;
  };
  invitationId: string;
  url: string;
}

async function expectUnavailable(page: Page) {
  await expect(page.getByRole("main").getByRole("alert")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Accept invitation", exact: true }),
  ).toHaveCount(0);
}

async function issue(input: Scenario): Promise<Issued> {
  input.stage = "invitation-fixture";
  const owner = await input.harness.prisma.user.create({
    data: {
      email: `seed-${randomUUID()}@example.invalid`,
      displayName: "Synthetic invitation owner",
      emailVerifiedAt: new Date(),
      passwordHash: await hashPassword(randomBytes(24).toString("base64url")),
    },
  });
  const organization = await input.harness.prisma.organization.create({
    data: { name: `Invited organization ${randomUUID()}` },
  });
  const branch = await input.harness.prisma.branch.create({
    data: {
      code: "INVITED",
      name: "Invited branch",
      organizationId: organization.id,
    },
  });
  await input.harness.prisma.organizationMembership.create({
    data: { organizationId: organization.id, userId: owner.id, role: "OWNER" },
  });
  const service = createMembershipAccessService({
    emailProvider: input.harness.mailbox.provider,
    publicWebOrigin: origin,
    repository: createPrismaMembershipAccessRepository(input.harness.prisma),
    tokenProvider: secureOneTimeTokenProvider,
  });
  const payload = {
    actorUserId: owner.id,
    organizationId: organization.id,
    invitation: {
      email: input.email,
      role: "CASHIER" as const,
      branchIds: [branch.id],
    },
  };
  const result = await service.createInvitation(payload);
  if (result.kind !== "success") throw new Error("invitation-fixture-refused");
  const mail = await input.harness.mailbox.next(input.email);
  if (mail.kind !== "invitation") throw new Error("invitation-mail-kind");
  return {
    owner,
    organization,
    branch,
    service,
    payload,
    invitationId: result.invitationId,
    url: mail.url,
  };
}

async function openInvitation(
  input: Scenario,
  invitation: Issued,
  page = input.page,
) {
  input.stage = "invitation-capture";
  const capture = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
        "/api/v1/invitations/continuations" &&
      response.request().method() === "POST",
  );
  await page.goto(invitation.url);
  expect((await capture).status()).toBe(200);
  await expect(page).toHaveURL(`${origin}/accept-invitation`);
  await expect
    .poll(() =>
      page.evaluate((key) => sessionStorage.getItem(key) !== null, selectorKey),
    )
    .toBe(true);
}

async function noLeak(input: Scenario, invitation: Issued, page = input.page) {
  input.stage = "credential-nonleakage";
  const token = new URL(invitation.url).searchParams.get("token");
  if (token === null) throw new Error("invitation-fixture-missing-token");
  const safe = await page.evaluate(
    ({ credential, cookieNames }) => {
      const stored = JSON.stringify({
        local: { ...localStorage },
        session: { ...sessionStorage },
      });
      return {
        url: !location.href.includes(credential) && location.search === "",
        document: !document.documentElement.outerHTML.includes(credential),
        storage: !stored.includes(credential),
        cookies:
          !document.cookie.includes(credential) &&
          !cookieNames.some((name) => document.cookie.includes(name)),
      };
    },
    { credential: token, cookieNames: continuationCookieNames },
  );
  expect(safe).toEqual({
    url: true,
    document: true,
    storage: true,
    cookies: true,
  });
  const cookies = (await input.context.cookies()).filter((item) =>
    isContinuationCookie(item.name),
  );
  expect(cookies.length).toBeGreaterThan(0);
  for (const cookie of cookies) {
    expect(cookie).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: "Strict",
      path: "/",
    });
    expect(Buffer.byteLength(cookie.value, "ascii")).toBeLessThanOrEqual(512);
    expect(Buffer.byteLength(cookie.value, "utf8")).toBe(cookie.value.length);
    expect(cookie.value.includes(token)).toBe(false);
  }
}

async function explicitAccept(
  input: Scenario,
  invitation: Issued,
  expectedRemainingFlows: string[] = [],
) {
  input.stage = "explicit-invitation-acceptance";
  await expect(input.page).toHaveURL(`${origin}/accept-invitation`);
  await expect(
    input.page.getByRole("button", { name: "Accept invitation", exact: true }),
  ).toBeEnabled();
  if (input.scenarioId === "31") {
    await input.page.setViewportSize({ width: 390, height: 844 });
    await mkdir("test-results/better-auth-integration/operator", {
      recursive: true,
    });
    await input.page.screenshot({
      path: "test-results/better-auth-integration/operator/invitation-ready-mobile.png",
      fullPage: true,
    });
    expect(
      await input.page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
  }
  expect(
    await input.harness.prisma.organizationMembership.count({
      where: {
        organizationId: invitation.organization.id,
        user: { email: input.email },
      },
    }),
  ).toBe(0);
  const accepted = input.page.waitForResponse(
    (response) =>
      response.url().endsWith("/invitations/continuations/accept") &&
      response.request().method() === "POST",
  );
  await input.page
    .getByRole("button", { name: "Accept invitation", exact: true })
    .click();
  expect((await accepted).status()).toBe(200);
  await expect(input.page).toHaveURL(
    new RegExp(`/app\\?organizationId=${invitation.organization.id}`),
  );
  const membership =
    await input.harness.prisma.organizationMembership.findUniqueOrThrow({
      where: {
        organizationId_userId: {
          organizationId: invitation.organization.id,
          userId: (
            await input.harness.prisma.user.findUniqueOrThrow({
              where: { email: input.email },
            })
          ).id,
        },
      },
    });
  expect(membership.role).toBe("CASHIER");
  expect(membership.sourceInvitationId).toBe(invitation.invitationId);
  expect(
    await input.harness.prisma.branchAssignment.findMany({
      where: {
        organizationId: invitation.organization.id,
        userId: membership.userId,
      },
      select: { branchId: true, status: true },
    }),
  ).toEqual([{ branchId: invitation.branch.id, status: "ACTIVE" }]);
  expect(
    await input.harness.prisma.firstOrganizationOnboarding.count({
      where: { userId: membership.userId },
    }),
  ).toBe(0);
  expect(
    await input.harness.prisma.session.count({
      where: { userId: membership.userId },
    }),
  ).toBe(0);
  expect(
    await input.harness.prisma.betterAuthSession.count({
      where: { userId: membership.userId },
    }),
  ).toBe(1);
  expect(
    await input.page.evaluate(
      (key) => sessionStorage.getItem(key),
      selectorKey,
    ),
  ).toBeNull();
  const remainingFlows = (await input.context.cookies())
    .filter((cookie) => isContinuationCookie(cookie.name))
    .map((cookie) => cookie.value.split(".")[2]);
  expect(remainingFlows.sort()).toEqual(expectedRemainingFlows.sort());
  const context = await input.page.evaluate(async () =>
    (await fetch("/api/v1/me/access-context")).json(),
  );
  expect(context.data.organizations).toMatchObject([
    {
      id: invitation.organization.id,
      role: "CASHIER",
      branches: [{ id: invitation.branch.id }],
    },
  ]);
  expect(
    (
      await input.page.request.post(
        `${origin}/api/v1/organizations/${invitation.organization.id}/branches`,
        {
          headers: { Origin: origin },
          data: { code: "DENIED", name: "Denied branch" },
        },
      )
    ).status(),
  ).toBe(403);
}

journey(
  "31 invitation registers verifies OTP explicitly signs in and accepts after reload",
  async (input) => {
    const invitation = await issue(input);
    await openInvitation(input, invitation);
    await noLeak(input, invitation);
    await expect(
      input.page
        .getByRole("main")
        .getByRole("link", { name: "Sign in", exact: true }),
    ).toBeVisible();
    await input.page.reload();
    await expect(
      input.page
        .getByRole("main")
        .getByRole("link", { name: "Create account", exact: true }),
    ).toBeVisible();
    input.stage = "invitation-registration-navigation";
    await input.page
      .getByRole("main")
      .getByRole("link", { name: "Create account", exact: true })
      .click();
    await input.page.getByLabel("Email address").fill(input.email);
    await input.page
      .getByLabel("Password", { exact: true })
      .fill(input.password);
    await input.page
      .getByLabel("Confirm password", { exact: true })
      .fill(input.password);
    await input.page
      .getByRole("button", { name: "Create account", exact: true })
      .click();
    await expect(input.page).toHaveURL(`${origin}/verify-email`);
    const mail = await input.harness.mailbox.next(input.email);
    if (mail.kind !== "verification") throw new Error("verification-mail-kind");
    await verifyByCode(input, mail.code);
    await assertNoAuthority(input);
    await input.page
      .getByRole("main")
      .getByRole("link", { name: "Sign in", exact: true })
      .click();
    input.stage = "flow-login";
    await input.page.getByLabel("Email address").fill(input.email);
    await input.page
      .getByLabel("Password", { exact: true })
      .fill(input.password);
    await input.page
      .getByRole("button", { name: "Sign in", exact: true })
      .click();
    await explicitAccept(input, invitation);
  },
);

journey(
  "32 invitation survives same-tab verification-link document replacement",
  async (input) => {
    const invitation = await issue(input);
    await openInvitation(input, invitation);
    await input.page
      .getByRole("main")
      .getByRole("link", { name: "Create account", exact: true })
      .click();
    await input.page.getByLabel("Email address").fill(input.email);
    await input.page
      .getByLabel("Password", { exact: true })
      .fill(input.password);
    await input.page
      .getByLabel("Confirm password", { exact: true })
      .fill(input.password);
    await input.page
      .getByRole("button", { name: "Create account", exact: true })
      .click();
    await expect(input.page).toHaveURL(`${origin}/verify-email`);
    const mail = await input.harness.mailbox.next(input.email);
    if (mail.kind !== "verification") throw new Error("verification-mail-kind");
    input.stage = "same-tab-verification-link";
    await input.page.goto(mail.url);
    await expect(input.page).toHaveURL(`${origin}/verify-email`);
    await input.page
      .getByRole("button", { name: "Check verification link", exact: true })
      .click();
    await expect(
      input.page.getByText(
        "Your email has been verified. You can now sign in.",
        { exact: true },
      ),
    ).toBeVisible();
    await assertNoAuthority(input);
    await input.page.reload();
    expect((await login(input)).status()).toBe(200);
    await explicitAccept(input, invitation);
  },
);

journey(
  "33 existing verified invitee resumes without first-organization onboarding",
  async (input) => {
    const registration = await register(input);
    await verifyByCode(input, registration.message.code);
    const invitation = await issue(input);
    await openInvitation(input, invitation);
    await input.page
      .getByRole("main")
      .getByRole("link", { name: "Sign in", exact: true })
      .click();
    expect((await login(input)).status()).toBe(200);
    await input.page.reload();
    await explicitAccept(input, invitation);
  },
);

journey(
  "34 cancellation missing flow and expired continuation fail closed",
  async (input) => {
    const invitation = await issue(input);
    await openInvitation(input, invitation);
    input.stage = "back-to-pending-invitation";
    await input.page
      .getByRole("main")
      .getByRole("link", { name: "Sign in", exact: true })
      .click();
    await expect(input.page).toHaveURL(`${origin}/login`);
    await input.page.goBack();
    await expect(input.page).toHaveURL(`${origin}/accept-invitation`);
    await expect(
      input.page
        .getByRole("main")
        .getByRole("link", { name: "Sign in", exact: true }),
    ).toBeVisible();
    input.stage = "cancel-continuation";
    const cancelled = input.page.waitForResponse(
      (response) =>
        response.url().endsWith("/invitations/continuations/cancel") &&
        response.request().method() === "POST",
    );
    await input.page
      .getByRole("button", { name: "Cancel invitation", exact: true })
      .click();
    expect((await cancelled).status()).toBe(204);
    expect(
      await input.page.evaluate(
        (key) => sessionStorage.getItem(key),
        selectorKey,
      ),
    ).toBeNull();
    expect(
      (await input.context.cookies()).filter((cookie) =>
        isContinuationCookie(cookie.name),
      ),
    ).toEqual([]);
    await input.page.goto("/accept-invitation");
    await expectUnavailable(input.page);
    expect(
      await input.harness.prisma.invitation.findUniqueOrThrow({
        where: { id: invitation.invitationId },
        select: { consumedAt: true, revokedAt: true },
      }),
    ).toEqual({ consumedAt: null, revokedAt: null });
    await openInvitation(input, invitation);
    input.stage = "expired-local-selector";
    await input.page.evaluate((key) => {
      const saved = JSON.parse(sessionStorage.getItem(key)!);
      saved.expiresAt = new Date(Date.now() - 1).toISOString();
      sessionStorage.setItem(key, JSON.stringify(saved));
    }, selectorKey);
    await input.page.reload();
    await expectUnavailable(input.page);
    await input.page.evaluate(
      (key) => sessionStorage.setItem(key, "{invalid"),
      selectorKey,
    );
    await input.page.reload();
    await expect
      .poll(() =>
        input.page.evaluate((key) => sessionStorage.getItem(key), selectorKey),
      )
      .toBeNull();
  },
);

journey(
  "35 four cooperative signed-in tabs allocate fixed slots and reject a cloned active flow",
  async (input) => {
    const registration = await register(input);
    await verifyByCode(input, registration.message.code);
    expect((await login(input)).status()).toBe(200);
    const invitations: Issued[] = [];
    for (let index = 0; index < 4; index++)
      invitations.push(await issue(input));
    const pages = [
      input.page,
      await input.context.newPage(),
      await input.context.newPage(),
      await input.context.newPage(),
    ];
    try {
      await Promise.all(
        pages.map((page, index) =>
          openInvitation(input, invitations[index]!, page),
        ),
      );
      await Promise.all(
        pages.map((page) =>
          expect(
            page.getByRole("button", {
              name: "Accept invitation",
              exact: true,
            }),
          ).toBeEnabled(),
        ),
      );
      const selectors = await Promise.all(
        pages.map((page) =>
          page.evaluate(
            (key) => JSON.parse(sessionStorage.getItem(key)!).flowId as string,
            selectorKey,
          ),
        ),
      );
      expect(new Set(selectors).size).toBe(4);
      const cookies = (await input.context.cookies()).filter((cookie) =>
        isContinuationCookie(cookie.name),
      );
      expect(cookies).toHaveLength(4);
      expect(new Set(cookies.map((cookie) => cookie.name)).size).toBe(4);
      for (let index = 0; index < pages.length; index++)
        await noLeak(input, invitations[index]!, pages[index]!);
      const membershipsBeforeAccept = await Promise.all(
        invitations.map((invitation) =>
          input.harness.prisma.organizationMembership.count({
            where: {
              organizationId: invitation.organization.id,
              user: { email: input.email },
            },
          }),
        ),
      );
      expect(membershipsBeforeAccept).toEqual([0, 0, 0, 0]);

      input.stage = "cloned-selector-lock-contention";
      const popupWait = input.page.waitForEvent("popup");
      await input.page.evaluate(() =>
        window.open("/accept-invitation", "_blank"),
      );
      const clone = await popupWait;
      try {
        await expectUnavailable(clone);
        await expect
          .poll(() =>
            clone.evaluate((key) => sessionStorage.getItem(key), selectorKey),
          )
          .toBeNull();
        expect(
          await input.page.evaluate(
            (key) => JSON.parse(sessionStorage.getItem(key)!).flowId as string,
            selectorKey,
          ),
        ).toBe(selectors[0]);
        expect(
          (await input.context.cookies()).filter((cookie) =>
            isContinuationCookie(cookie.name),
          ),
        ).toHaveLength(4);
      } finally {
        await clone.close();
      }

      input.stage = "selected-tab-cancellation";
      const cancelled = pages[1]!.waitForResponse(
        (response) =>
          response.url().endsWith("/invitations/continuations/cancel") &&
          response.request().method() === "POST",
      );
      await pages[1]!
        .getByRole("button", { name: "Cancel invitation", exact: true })
        .click();
      expect((await cancelled).status()).toBe(204);
      expect(
        (await input.context.cookies()).filter((cookie) =>
          isContinuationCookie(cookie.name),
        ),
      ).toHaveLength(3);
      expect(
        await input.page.evaluate(
          (key) => JSON.parse(sessionStorage.getItem(key)!).flowId as string,
          selectorKey,
        ),
      ).toBe(selectors[0]);
      await explicitAccept(input, invitations[0]!, [
        selectors[2]!,
        selectors[3]!,
      ]);
      for (const index of [2, 3]) {
        await expectUnavailable(pages[index]!);
        await expect
          .poll(() =>
            pages[index]!.evaluate(
              (key) => sessionStorage.getItem(key),
              selectorKey,
            ),
          )
          .toBeNull();
      }
      const membershipsAfterAccept = await Promise.all(
        invitations.map((invitation) =>
          input.harness.prisma.organizationMembership.count({
            where: {
              organizationId: invitation.organization.id,
              user: { email: input.email },
            },
          }),
        ),
      );
      expect(membershipsAfterAccept).toEqual([1, 0, 0, 0]);
      expect(
        (await input.context.cookies()).filter((cookie) =>
          isContinuationCookie(cookie.name),
        ),
      ).toHaveLength(2);
    } finally {
      await Promise.all(pages.slice(1).map((page) => page.close()));
    }
  },
);

journey(
  "36 revoked expired and replaced invitations never become membership",
  async (input) => {
    const registration = await register(input);
    await verifyByCode(input, registration.message.code);
    expect((await login(input)).status()).toBe(200);
    const invitation = await issue(input);
    await openInvitation(input, invitation);
    input.stage = "revoke-after-capture";
    expect(
      (
        await invitation.service.revokeInvitation({
          actorUserId: invitation.owner.id,
          invitationId: invitation.invitationId,
          organizationId: invitation.organization.id,
        })
      ).kind,
    ).toBe("success");
    await input.page.reload();
    await expectUnavailable(input.page);
    const replacement = await invitation.service.createInvitation(
      invitation.payload,
    );
    if (replacement.kind !== "success")
      throw new Error("replacement-fixture-refused");
    const replacementMail = await input.harness.mailbox.next(input.email);
    if (replacementMail.kind !== "invitation")
      throw new Error("replacement-mail-kind");
    const third = await invitation.service.createInvitation(invitation.payload);
    if (third.kind !== "success")
      throw new Error("replacement-fixture-refused");
    const current = await input.harness.mailbox.next(input.email);
    if (current.kind !== "invitation") throw new Error("replacement-mail-kind");
    input.stage = "replaced-link-refused";
    const oldCapture = input.page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          "/api/v1/invitations/continuations" &&
        response.request().method() === "POST",
    );
    await input.page.goto(replacementMail.url);
    expect((await oldCapture).status()).toBe(400);
    await expectUnavailable(input.page);
    input.stage = "expired-invitation-refused";
    // Preserve the database issuance/expiry ordering while making this synthetic invitation stale.
    const oldIssue = new Date(Date.now() - 8 * 24 * 60 * 60_000);
    await input.harness.prisma.invitation.update({
      where: { id: third.invitationId },
      data: {
        issuedAt: oldIssue,
        expiresAt: new Date(oldIssue.getTime() + 7 * 24 * 60 * 60_000),
      },
    });
    const expiredCapture = input.page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          "/api/v1/invitations/continuations" &&
        response.request().method() === "POST",
    );
    await input.page.goto(current.url);
    expect((await expiredCapture).status()).toBe(400);
    expect(
      await input.harness.prisma.organizationMembership.count({
        where: {
          organizationId: invitation.organization.id,
          user: { email: input.email },
        },
      }),
    ).toBe(0);
  },
);

journey(
  "37 unrelated login and logout cannot inherit another tab continuation",
  async (input) => {
    const registration = await register(input);
    await verifyByCode(input, registration.message.code);
    const invitation = await issue(input);
    await openInvitation(input, invitation);
    const other = await input.context.newPage();
    try {
      input.stage = "unrelated-tab-login";
      await other.goto("/login");
      await other.getByLabel("Email address").fill(input.email);
      await other.getByLabel("Password", { exact: true }).fill(input.password);
      await other.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(other).toHaveURL(`${origin}/onboarding`);
      expect(
        (await input.context.cookies()).filter((cookie) =>
          isContinuationCookie(cookie.name),
        ),
      ).toEqual([]);
      await input.page.reload();
      await expectUnavailable(input.page);
      input.stage = "authenticated-capture-then-logout";
      await openInvitation(input, invitation);
      await expect(
        input.page.getByRole("button", {
          name: "Accept invitation",
          exact: true,
        }),
      ).toBeEnabled();
      const flow = await input.page.evaluate(
        (key) => JSON.parse(sessionStorage.getItem(key)!).flowId as string,
        selectorKey,
      );
      const logout = await post(input, "auth/logout", {});
      expect(logout.status).toBe(204);
      const replay = await input.page.evaluate(async (flowId) => {
        const response = await fetch(
          "/api/v1/invitations/continuations/accept",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Stockwise-Invitation-Flow": flowId,
            },
            body: "{}",
          },
        );
        return response.status;
      }, flow);
      expect(replay).toBe(401);
      expect(
        (await input.context.cookies()).filter((cookie) =>
          isContinuationCookie(cookie.name),
        ),
      ).toEqual([]);
      expect(
        await input.harness.prisma.organizationMembership.count({
          where: {
            organizationId: invitation.organization.id,
            user: { email: input.email },
          },
        }),
      ).toBe(0);
    } finally {
      await other.close();
    }
  },
);

journey(
  "38 wrong verified account cannot accept an email-bound continuation",
  async (input) => {
    const wrongEmail = `d4n3-${randomUUID()}@example.invalid`;
    input.harness.mailbox.allowAccount(wrongEmail);
    try {
      const wrong = { ...input, email: wrongEmail };
      const registration = await register(wrong);
      await verifyByCode(wrong, registration.message.code);
      const invitation = await issue(input);
      await openInvitation(input, invitation);
      await input.page
        .getByRole("main")
        .getByRole("link", { name: "Sign in", exact: true })
        .click();
      input.stage = "wrong-account-resume";
      expect((await login(wrong)).status()).toBe(200);
      await expect(input.page).toHaveURL(`${origin}/accept-invitation`);
      await expectUnavailable(input.page);
      expect(
        await input.harness.prisma.organizationMembership.count({
          where: {
            organizationId: invitation.organization.id,
            user: { email: { in: [input.email, wrongEmail] } },
          },
        }),
      ).toBe(0);
      expect(
        await input.harness.prisma.invitation.findUniqueOrThrow({
          where: { id: invitation.invitationId },
          select: { consumedAt: true, acceptedByUserId: true },
        }),
      ).toEqual({ consumedAt: null, acceptedByUserId: null });
    } finally {
      input.harness.mailbox.releaseAccount(wrongEmail);
    }
  },
);

journey(
  "39 ordinary owner first-organization onboarding stays unchanged",
  async (input) => {
    const registration = await register(input);
    await verifyByCode(input, registration.message.code);
    expect((await login(input)).status()).toBe(200);
    await expect(input.page).toHaveURL(`${origin}/onboarding`);
    input.stage = "owner-first-onboarding";
    await input.page
      .getByLabel("Display name", { exact: true })
      .fill("Synthetic owner");
    await input.page
      .getByLabel("Organization name", { exact: true })
      .fill("Synthetic owner organization");
    await input.page
      .getByLabel("First branch name", { exact: true })
      .fill("Owner main branch");
    await input.page
      .getByRole("button", { name: "Create organization", exact: true })
      .click();
    await expect(input.page).toHaveURL(new RegExp("/app(?:\\\\?|$)"));
    const user = await input.harness.prisma.user.findUniqueOrThrow({
      where: { email: input.email },
    });
    const memberships =
      await input.harness.prisma.organizationMembership.findMany({
        where: { userId: user.id },
        select: { role: true, sourceInvitationId: true, organizationId: true },
      });
    expect(memberships).toMatchObject([
      { role: "OWNER", sourceInvitationId: null },
    ]);
    expect(
      await input.harness.prisma.firstOrganizationOnboarding.count({
        where: { userId: user.id },
      }),
    ).toBe(1);
    expect(
      await input.harness.prisma.branchAssignment.count({
        where: { userId: user.id },
      }),
    ).toBe(0);
    expect(
      await input.harness.prisma.branch.findMany({
        where: { organizationId: memberships[0]!.organizationId },
        select: { code: true },
      }),
    ).toEqual([{ code: "MAIN" }]);
  },
);

journey(
  "40 expired invitation login stays in recovery across document reload",
  async (input) => {
    const registration = await register(input);
    await verifyByCode(input, registration.message.code);
    const invitation = await issue(input);
    await openInvitation(input, invitation);
    await input.page
      .getByRole("main")
      .getByRole("link", { name: "Sign in", exact: true })
      .click();
    input.stage = "expire-before-explicit-login";
    await input.page.evaluate((key) => {
      const saved = JSON.parse(sessionStorage.getItem(key)!);
      saved.expiresAt = new Date(Date.now() - 1).toISOString();
      sessionStorage.setItem(key, JSON.stringify(saved));
    }, selectorKey);
    await input.page.getByLabel("Email address").fill(input.email);
    await input.page
      .getByLabel("Password", { exact: true })
      .fill(input.password);
    await input.page
      .getByRole("button", { name: "Sign in", exact: true })
      .click();
    await expect(input.page).toHaveURL(`${origin}/accept-invitation`);
    await expectUnavailable(input.page);
    input.stage = "reload-expired-flow-recovery";
    expect((await login(input)).status()).toBe(200);
    await expect(input.page).toHaveURL(`${origin}/accept-invitation`);
    await expectUnavailable(input.page);
    const actor = await input.harness.prisma.user.findUniqueOrThrow({
      where: { email: input.email },
      select: { id: true },
    });
    expect(
      await input.harness.prisma.firstOrganizationOnboarding.count({
        where: { userId: actor.id },
      }),
    ).toBe(0);
    expect(
      await input.harness.prisma.organizationMembership.count({
        where: { user: { email: input.email } },
      }),
    ).toBe(0);
  },
);

journey(
  "41 expired ready confirmation shows recovery without an acceptance request",
  async (input) => {
    const registration = await register(input);
    await verifyByCode(input, registration.message.code);
    expect((await login(input)).status()).toBe(200);
    const invitation = await issue(input);
    await openInvitation(input, invitation);
    const accept = input.page.getByRole("button", {
      name: "Accept invitation",
      exact: true,
    });
    await expect(accept).toBeEnabled();
    input.stage = "expired-ready-confirmation";
    const acceptanceRequests: string[] = [];
    input.page.on("request", (request) => {
      if (
        new URL(request.url()).pathname ===
        "/api/v1/invitations/continuations/accept"
      )
        acceptanceRequests.push(request.method());
    });
    await input.page.evaluate((key) => {
      const saved = JSON.parse(sessionStorage.getItem(key)!);
      saved.expiresAt = new Date(Date.now() - 1).toISOString();
      sessionStorage.setItem(key, JSON.stringify(saved));
    }, selectorKey);
    await accept.click();
    await expectUnavailable(input.page);
    expect(acceptanceRequests).toEqual([]);
    expect(
      await input.harness.prisma.organizationMembership.count({
        where: {
          organizationId: invitation.organization.id,
          user: { email: input.email },
        },
      }),
    ).toBe(0);
    expect(
      await input.harness.prisma.invitation.findUniqueOrThrow({
        where: { id: invitation.invitationId },
        select: { consumedAt: true },
      }),
    ).toEqual({ consumedAt: null });
  },
);
