import {
  armOperatorFocus,
  waitForOperatorClick,
  verifyOperatorAltTab,
  recordOperatorHistory,
} from "./operator-focus";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { IdentityEmailMessage } from "../../../apps/api/src/modules/identity/email-provider.ts";
import {
  journey,
  register,
  verifyByCode,
  login,
  post,
  assertNoAuthority,
  expect,
  type Scenario,
} from "./fixtures";
const nativeSessionCookie = "stockwise_native.session_token";

const webOrigin = "http://localhost:3202";
const proofCookie = "__Host-stockwise_verification_proof";
type JourneyWindow = Window & {
  __d4n3Persisted?: boolean;
  __d4n3Blurred?: boolean;
  __d4n3Focused?: boolean;
};

function messageUrl(message: IdentityEmailMessage) {
  return message.url;
}
async function completedAccount(input: Scenario) {
  const initial = await register(input);
  await verifyByCode(input, initial.message.code);
  return initial;
}
async function createOwnerScope(input: Scenario) {
  const user = await input.harness.prisma.user.findUniqueOrThrow({
    where: { email: input.email },
    select: { id: true },
  });
  const organization = await input.harness.prisma.organization.create({
    data: { name: `Journey ${user.id}` },
  });
  const first = await input.harness.prisma.branch.create({
    data: {
      code: "ONE",
      name: "First branch",
      organizationId: organization.id,
    },
  });
  const second = await input.harness.prisma.branch.create({
    data: {
      code: "TWO",
      name: "Second branch",
      organizationId: organization.id,
    },
  });
  await input.harness.prisma.organizationMembership.create({
    data: { organizationId: organization.id, userId: user.id, role: "OWNER" },
  });
  return { organization, first, second };
}

journey(
  "01 registration enters OTP directly and requires explicit login",
  async (input) => {
    const result = await register(input);
    expect(input.page.url()).toBe(`${webOrigin}/verify-email`);
    expect(
      await input.page
        .getByRole("link", { name: "Continue verification" })
        .count(),
    ).toBe(0);
    expect(
      await input.harness.prisma.user.findUnique({
        where: { email: input.email },
      }),
    ).toBeNull();
    const pending =
      await input.harness.prisma.pendingRegistration.findUniqueOrThrow({
        where: { email: input.email },
        select: { credentialVersion: true, passwordHash: true, userId: true },
      });
    expect(pending.credentialVersion).toBe(1n);
    expect(pending.passwordHash).toMatch(/^\$argon2id\$/);
    expect(pending.userId).toBeNull();
    input.stage = "pending-password-proof";
    const failureCount = input.harness.deliveryFailures.length;
    const pendingLogin = await input.page.evaluate(
      async ({ email, password }) => {
        const response = await fetch("/api/v1/auth/login", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
        });
        return { status: response.status, body: await response.json() };
      },
      { email: input.email, password: input.password },
    );
    expect(pendingLogin.status).toBe(202);
    expect(pendingLogin.body.data).toMatchObject({
      status: "verification_required",
      nextStep: "verify_email",
      verification: { challengeId: null },
    });
    expect(
      await input.harness.prisma.betterAuthSession.count({
        where: { user: { email: input.email } },
      }),
    ).toBe(0);
    expect(
      (await input.context.cookies()).some(
        (cookie) => cookie.name === nativeSessionCookie,
      ),
    ).toBe(false);
    expect(
      (await input.context.cookies()).some(
        (cookie) => cookie.name === proofCookie,
      ),
    ).toBe(true);
    expect(input.harness.mailbox.queuedCount(input.email)).toBe(0);
    expect(input.harness.deliveryFailures).toHaveLength(failureCount);
    expect(await input.context.cookies()).not.toContainEqual(
      expect.objectContaining({ name: nativeSessionCookie }),
    );
    expect(
      await input.harness.prisma.betterAuthAccount.count({
        where: { userId: result.pendingId },
      }),
    ).toBe(0);
    await input.page.getByRole("button", { name: "Language" }).click();
    await input.page.getByLabel("รหัสยืนยัน 6 หลัก").fill(result.message.code);
    await input.page
      .getByRole("button", { name: "ยืนยัน", exact: true })
      .click();
    await expect(
      input.page.getByText("ยืนยันอีเมลเรียบร้อยแล้ว คุณสามารถเข้าสู่ระบบได้", {
        exact: true,
      }),
    ).toBeVisible();
    await input.page.getByRole("button", { name: "ภาษา" }).click();
    await assertNoAuthority(input);
    expect(
      await input.harness.prisma.user.findUniqueOrThrow({
        where: { email: input.email },
        select: { id: true, credentialVersion: true },
      }),
    ).toEqual({ id: result.pendingId, credentialVersion: 1n });
    const response = await login(input);
    expect((await response).status()).toBe(200);
    expect(
      await input.page.evaluate(
        async () => (await fetch("/api/v1/me/access-context")).status,
      ),
    ).toBe(200);
  },
);

journey(
  "02 resend rotates OTP and link without extending expiry; throttles safely",
  async (input) => {
    const previous = await register(input);
    input.stage = "proof-cookie";
    const proof = (await input.context.cookies()).find(
      (cookie) => cookie.name === proofCookie,
    );
    expect(proof).toMatchObject({
      secure: true,
      httpOnly: true,
      sameSite: "Strict",
      path: "/",
    });
    input.stage = "resend-first";
    const firstResend = input.page.waitForResponse(
      (response) =>
        response.url().endsWith("/auth/verification-resend") &&
        response.request().method() === "POST",
    );
    await input.page
      .getByRole("button", { name: "Request a new code" })
      .click();
    expect((await firstResend).status()).toBe(202);
    input.stage = "resend-feedback";
    await expect(input.page.getByRole("status")).toBeVisible();
    const firstReplacement = await input.harness.mailbox.next(input.email);
    if (firstReplacement.kind !== "verification")
      throw new Error("resend-mail-kind");
    const firstActive =
      await input.harness.prisma.pendingRegistration.findUniqueOrThrow({
        where: { email: input.email },
        select: { challengeId: true },
      });
    input.stage = "resend-second";
    const secondResend = input.page.waitForResponse(
      (response) =>
        response.url().endsWith("/auth/verification-resend") &&
        response.request().method() === "POST",
    );
    await input.page
      .getByRole("button", { name: "Request a new code" })
      .click();
    expect((await secondResend).status()).toBe(202);
    const replacement = await input.harness.mailbox.next(input.email);
    if (replacement.kind !== "verification")
      throw new Error("resend-mail-kind");
    input.stage = "resend-limit";
    const limitedResend = input.page.waitForResponse(
      (response) =>
        response.url().endsWith("/auth/verification-resend") &&
        response.request().method() === "POST",
    );
    await input.page
      .getByRole("button", { name: "Request a new code" })
      .click();
    const limitedStatus = (await limitedResend).status();
    input.stage = `resend-limit-http-${limitedStatus}`;
    expect(limitedStatus).toBe(429);
    input.stage = "resend-limit-feedback";
    // Next's shadow-root route announcer is also an alert, outside the main landmark.
    await expect(input.page.getByRole("main").getByRole("alert")).toBeVisible();
    input.stage = "resend-state";
    const current =
      await input.harness.prisma.pendingRegistration.findUniqueOrThrow({
        where: { email: input.email },
        select: { challengeId: true, expiresAt: true, credentialVersion: true },
      });
    const continuation = await input.page.evaluate(() =>
      JSON.parse(
        sessionStorage.getItem("stockwise_verification_continuation") ?? "null",
      ),
    );
    expect(continuation).toMatchObject({
      version: 1,
      canonicalEmail: input.email,
      challengeId: current.challengeId,
    });
    expect(current.challengeId).not.toBe(previous.challengeId);
    expect(current.challengeId).not.toBe(firstActive.challengeId);
    expect(current.expiresAt.getTime()).toBe(previous.expiresAt.getTime());
    expect(current.credentialVersion).toBe(1n);
    expect(
      (await input.context.cookies()).find(
        (cookie) => cookie.name === proofCookie,
      )?.expires,
    ).toBe(proof?.expires);
    input.stage = "resend-old-credentials";
    expect(
      (
        await post(input, "auth/verify-email-code", {
          email: input.email,
          challengeId: previous.challengeId,
          code: previous.message.code,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post(input, "auth/verify-email-code", {
          email: input.email,
          challengeId: firstActive.challengeId,
          code: firstReplacement.code,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post(input, "auth/verify-email", {
          token: new URL(messageUrl(previous.message)).searchParams.get(
            "token",
          ),
        })
      ).status,
    ).toBe(400);
    await input.page
      .getByLabel("6-digit verification code")
      .fill(replacement.code);
    await input.page
      .getByRole("button", { name: "Verify", exact: true })
      .click();
    await expect(
      input.page.getByText(
        "Your email has been verified. You can now sign in.",
        { exact: true },
      ),
    ).toBeVisible();
    expect(
      (await input.page.context().cookies()).some(
        (cookie) => cookie.name === proofCookie,
      ),
    ).toBe(false);
    await assertNoAuthority(input);
  },
);

journey(
  "03 verification link opens in a new tab, scrubs URL and prevents duplicate consumption",
  async (input) => {
    const { message } = await register(input);
    const link = messageUrl(message);
    const verificationToken = new URL(link).searchParams.get("token");
    if (!verificationToken) throw new Error("verification-token-unavailable");
    const linkPage = await input.context.newPage();
    await linkPage.goto(link);
    await expect(
      linkPage.getByRole("button", {
        name: "Check verification link",
        exact: true,
      }),
    ).toBeVisible();
    expect(new URL(linkPage.url()).search).toBe("");
    expect(
      await linkPage.evaluate(
        (secret) =>
          ![
            location.href,
            JSON.stringify(history.state),
            document.documentElement.outerHTML,
            JSON.stringify(localStorage),
            JSON.stringify(sessionStorage),
            document.cookie,
          ].some((value) => value.includes(secret)),
        verificationToken,
      ),
    ).toBe(true);
    expect(
      (
        await input.harness.prisma.pendingRegistration.findUniqueOrThrow({
          where: { email: input.email },
          select: { consumedAt: true },
        })
      ).consumedAt,
    ).toBeNull();
    await linkPage.reload();
    await expect(
      linkPage.getByRole("button", {
        name: "Check verification link",
        exact: true,
      }),
    ).toHaveCount(0);
    expect(
      (
        await input.harness.prisma.pendingRegistration.findUniqueOrThrow({
          where: { email: input.email },
          select: { consumedAt: true },
        })
      ).consumedAt,
    ).toBeNull();
    const verifyingPage = await input.context.newPage();
    await verifyingPage.goto(link);
    await expect(
      verifyingPage.getByRole("button", {
        name: "Check verification link",
        exact: true,
      }),
    ).toBeVisible();
    await verifyingPage
      .getByRole("button", { name: "Check verification link", exact: true })
      .click();
    await expect(
      verifyingPage.getByText(
        "Your email has been verified. You can now sign in.",
        { exact: true },
      ),
    ).toBeVisible();
    expect(
      (await post(input, "auth/verify-email", { token: verificationToken }))
        .status,
    ).toBe(200);
    expect(
      (
        await input.harness.prisma.pendingRegistration.findUniqueOrThrow({
          where: { email: input.email },
          select: { consumedAt: true },
        })
      ).consumedAt,
    ).not.toBeNull();
    await assertNoAuthority(input);
    expect((await login(input)).status()).toBe(200);
    expect(
      await input.page.evaluate(
        async () => (await fetch("/api/v1/me/access-context")).status,
      ),
    ).toBe(200);
  },
);

journey(
  "04 password fallback verifies mailbox after proof and never starts a session",
  async (input) => {
    const { message } = await register(input);
    await input.context.clearCookies();
    const linkPage = await input.context.newPage();
    const link = messageUrl(message);
    const verificationToken = new URL(link).searchParams.get("token");
    if (!verificationToken) throw new Error("verification-token-unavailable");
    await linkPage.goto(link);
    expect(new URL(linkPage.url()).search).toBe("");
    expect(
      await linkPage.evaluate(
        (secret) =>
          ![
            location.href,
            JSON.stringify(history.state),
            document.documentElement.outerHTML,
            JSON.stringify(localStorage),
            JSON.stringify(sessionStorage),
            document.cookie,
          ].some((surface) => surface.includes(secret)),
        verificationToken,
      ),
    ).toBe(true);
    await linkPage
      .getByRole("button", { name: "Check verification link", exact: true })
      .click();
    await expect(
      linkPage.getByRole("button", { name: "Confirm password", exact: true }),
    ).toBeVisible();
    await linkPage.getByLabel("Email address").fill(input.email);
    await linkPage.getByLabel("Password", { exact: true }).fill(input.password);
    await linkPage
      .getByRole("button", { name: "Confirm password", exact: true })
      .click();
    await expect(
      linkPage.getByText("Your email has been verified. You can now sign in.", {
        exact: true,
      }),
    ).toBeVisible();
    expect(
      (await input.context.cookies()).some(
        (cookie) => cookie.name === proofCookie,
      ),
    ).toBe(false);
    await assertNoAuthority(input);
  },
);

journey(
  "05 native login gates protected access and logout rejects a copied old cookie",
  async (input) => {
    const completed = await completedAccount(input);
    expect(
      await input.harness.prisma.session.count({
        where: { userId: completed.pendingId },
      }),
    ).toBe(0);
    const scope = await createOwnerScope(input);
    input.stage = "legacy-authority-denied";
    const legacyToken = randomBytes(32).toString("base64url");
    await input.harness.prisma.session.create({
      data: {
        userId: completed.pendingId,
        tokenHash: createHash("sha256").update(legacyToken).digest("hex"),
        idleExpiresAt: new Date(Date.now() + 86_400_000),
        absoluteExpiresAt: new Date(Date.now() + 604_800_000),
      },
    });
    const legacyOnly = await input.context
      .browser()!
      .newContext({ baseURL: webOrigin });
    try {
      await legacyOnly.addCookies([
        {
          name: "stockwise_session",
          value: legacyToken,
          url: webOrigin,
          httpOnly: true,
          sameSite: "Lax",
          secure: false,
        },
      ]);
      expect(
        (
          await legacyOnly.request.get(`${webOrigin}/api/v1/me/access-context`)
        ).status(),
      ).toBe(401);
    } finally {
      await legacyOnly.close();
    }
    const response = await login(input);
    expect((await response).status()).toBe(200);
    // The single legacy row is the negative-authority fixture, not a Native write.
    expect(
      await input.harness.prisma.session.count({
        where: { userId: completed.pendingId },
      }),
    ).toBe(1);
    const cookie = (await input.context.cookies()).find(
      (candidate) => candidate.name === nativeSessionCookie,
    );
    expect(cookie).toMatchObject({
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
    });
    expect(cookie?.secure).toBe(false);
    const accessStatus = await input.page.evaluate(
      async () => (await fetch("/api/v1/me/access-context")).status,
    );
    expect(accessStatus).toBe(200);
    input.stage = "origin-and-native-bypass";
    expect(
      await input.page.evaluate(() =>
        document.cookie.includes("stockwise_native.session_token"),
      ),
    ).toBe(false);
    expect((await response.json()).data).toMatchObject({
      user: { email: input.email },
    });
    for (const path of [
      "auth/sign-up/email",
      "auth/sign-in/email",
      "auth/request-password-reset",
    ]) {
      expect(
        (
          await input.context.request.post(`${webOrigin}/api/v1/${path}`, {
            headers: { Origin: webOrigin },
            data: { email: input.email, password: input.password },
          })
        ).status(),
      ).toBe(404);
    }
    expect(
      (
        await input.context.request.post(`${webOrigin}/api/v1/auth/logout`, {
          headers: { Origin: "https://attacker.example.invalid" },
          data: {},
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await input.context.request.post(`${webOrigin}/api/v1/auth/login`, {
          data: { email: input.email, password: input.password },
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await input.context.request.post(`${webOrigin}/api/v1/auth/login`, {
          headers: { Origin: webOrigin, "Content-Type": "text/plain" },
          data: JSON.stringify({
            email: input.email,
            password: input.password,
          }),
        })
      ).status(),
    ).toBe(403);
    expect(
      await input.page.evaluate(
        async () => (await fetch("/api/v1/me/access-context")).status,
      ),
    ).toBe(200);
    input.stage = "session-provenance";
    const native =
      await input.harness.prisma.betterAuthSession.findFirstOrThrow({
        where: { user: { email: input.email } },
        select: {
          id: true,
          stockwisePurpose: true,
          stockwiseCredentialVersion: true,
        },
      });
    expect(native.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(native).toMatchObject({
      stockwisePurpose: "APPLICATION",
      stockwiseCredentialVersion: 1n,
    });
    const oldCookieContext = await input.context
      .browser()!
      .newContext({ baseURL: webOrigin });
    try {
      await oldCookieContext.addCookies([cookie!]);
      await input.harness.prisma.betterAuthSession.update({
        where: { id: native.id },
        data: { stockwisePurpose: null, stockwiseCredentialVersion: null },
      });
      expect(
        await input.page.evaluate(
          async () => (await fetch("/api/v1/me/access-context")).status,
        ),
      ).toBe(401);
      await input.harness.prisma.betterAuthSession.update({
        where: { id: native.id },
        data: {
          stockwisePurpose: "APPLICATION",
          stockwiseCredentialVersion: 2n,
        },
      });
      expect(
        await input.page.evaluate(
          async () => (await fetch("/api/v1/me/access-context")).status,
        ),
      ).toBe(401);
      await input.harness.prisma.betterAuthSession.update({
        where: { id: native.id },
        data: {
          stockwisePurpose: "APPLICATION",
          stockwiseCredentialVersion: 1n,
        },
      });
      expect(
        await input.page.evaluate(
          async () => (await fetch("/api/v1/me/access-context")).status,
        ),
      ).toBe(200);
      await input.page.goto(
        `/app?organizationId=${scope.organization.id}&branchId=${scope.first.id}`,
      );
      await expect(
        input.page.getByRole("button", { name: "Log out", exact: true }),
      ).toBeVisible();
      input.stage = "logout";
      const logoutResponse = input.page.waitForResponse(
        (r) =>
          r.url().endsWith("/auth/logout") && r.request().method() === "POST",
      );
      await input.page
        .getByRole("button", { name: "Log out", exact: true })
        .click();
      expect((await logoutResponse).status()).toBe(204);
      await expect(input.page).toHaveURL(`${webOrigin}/login`);
      expect(
        await input.harness.prisma.session.count({
          where: { userId: completed.pendingId },
        }),
      ).toBe(1);
      expect(
        (
          await oldCookieContext.request.get(
            `${webOrigin}/api/v1/me/access-context`,
          )
        ).status(),
      ).toBe(401);
    } finally {
      await oldCookieContext.close();
    }
    expect(
      await input.page.evaluate(
        async () => (await fetch("/api/v1/me/access-context")).status,
      ),
    ).toBe(401);
  },
);

journey(
  "06 forgot-password is generic; browser reset enforces policy and revokes native sessions",
  async (input) => {
    await completedAccount(input);
    expect(
      await input.harness.prisma.session.count({
        where: { user: { email: input.email } },
      }),
    ).toBe(0);
    expect((await login(input)).status()).toBe(200);
    const oldSessionCookie = (await input.context.cookies()).find(
      (candidate) => candidate.name === nativeSessionCookie,
    );
    const staleContext = await input.context
      .browser()!
      .newContext({ baseURL: webOrigin });
    await staleContext.addCookies([oldSessionCookie!]);
    const otherDevice = await input.context
      .browser()!
      .newContext({ baseURL: webOrigin });
    expect(
      (
        await otherDevice.request.post(`${webOrigin}/api/v1/auth/login`, {
          headers: { Origin: webOrigin },
          data: { email: input.email, password: input.password },
        })
      ).status(),
    ).toBe(200);
    const recoveryContext = await input.context
      .browser()!
      .newContext({ baseURL: webOrigin });
    await recoveryContext.addInitScript(() =>
      localStorage.setItem("stockwise.language", "en"),
    );
    const recoveryPage = await recoveryContext.newPage();
    try {
      input.stage = "forgot-password";
      await recoveryPage.goto("/forgot-password");
      await recoveryPage.getByLabel("Email address").fill(input.email);
      await recoveryPage
        .getByRole("button", { name: "Request password reset" })
        .click();
      await expect(
        recoveryPage.getByText(
          "If that email can receive a password reset, check its inbox for the next step.",
          { exact: true },
        ),
      ).toBeVisible();
      const resetMail = await input.harness.mailbox.next(input.email);
      if (resetMail.kind !== "password_reset")
        throw new Error("reset-mail-kind");
      const resetUrl = messageUrl(resetMail);
      const resetToken = new URL(resetUrl).searchParams.get("token");
      const previousNativeSessions =
        await input.harness.prisma.betterAuthSession.count({
          where: { user: { email: input.email } },
        });
      expect(previousNativeSessions).toBe(2);
      input.stage = "reset-password";
      const resetPage = await recoveryContext.newPage();
      await resetPage.goto(resetUrl);
      await expect(resetPage.getByLabel("New password")).toBeVisible();
      await resetPage.getByLabel("New password").fill("short");
      await resetPage.getByRole("button", { name: "Reset password" }).click();
      await expect(
        resetPage.getByRole("main").getByRole("alert"),
      ).toBeVisible();
      const replacement = randomBytes(20).toString("base64url");
      await resetPage.getByLabel("New password").fill(replacement);
      await resetPage.getByRole("button", { name: "Reset password" }).click();
      await expect(
        resetPage.getByText(
          "Your password has been reset. Sign in with your new password.",
          { exact: true },
        ),
      ).toBeVisible();
      expect(new URL(resetPage.url()).search).toBe("");
      if (!resetToken) throw new Error("reset-token-unavailable");
      expect(
        await resetPage.evaluate(
          (token) =>
            ![
              location.href,
              JSON.stringify(history.state),
              document.documentElement.outerHTML,
              JSON.stringify(localStorage),
              JSON.stringify(sessionStorage),
              document.cookie,
            ].some((surface) => surface.includes(token)),
          resetToken,
        ),
      ).toBe(true);
      const afterResetCookie = (await resetPage.context().cookies()).find(
        (candidate) => candidate.name === nativeSessionCookie,
      );
      expect(afterResetCookie).toBeUndefined();
      expect(
        await input.harness.prisma.betterAuthSession.count({
          where: { user: { email: input.email } },
        }),
      ).toBe(0);
      expect(
        (
          await staleContext.request.get(
            `${webOrigin}/api/v1/me/access-context`,
          )
        ).status(),
      ).toBe(401);
      expect(
        (
          await otherDevice.request.get(`${webOrigin}/api/v1/me/access-context`)
        ).status(),
      ).toBe(401);
      expect(
        await resetPage.evaluate(
          async () => (await fetch("/api/v1/me/access-context")).status,
        ),
      ).toBe(401);
      input.stage = "reset-explicit-login";
      expect((await login(input)).status()).toBe(401);
      expect((await login(input, replacement)).status()).toBe(200);
      expect(
        await input.harness.prisma.session.count({
          where: { user: { email: input.email } },
        }),
      ).toBe(0);
      await recoveryPage.goto("/forgot-password");
      await recoveryPage
        .getByLabel("Email address")
        .fill(`d4n3-${randomUUID()}@example.invalid`);
      await recoveryPage
        .getByRole("button", { name: "Request password reset" })
        .click();
      await expect(
        recoveryPage.getByText(
          "If that email can receive a password reset, check its inbox for the next step.",
          { exact: true },
        ),
      ).toBeVisible();
    } finally {
      await staleContext.close();
      await otherDevice.close();
      await recoveryContext.close();
    }
  },
);

journey(
  "07 wrong credentials and expired credentials are rejected in real forms",
  async (input) => {
    const { message } = await register(input);
    const wrongLoginPage = await input.context.newPage();
    await wrongLoginPage.goto("/login");
    await wrongLoginPage.getByLabel("Email address").fill(input.email);
    await wrongLoginPage
      .getByLabel("Password", { exact: true })
      .fill("wrong-value-not-a-secret");
    await wrongLoginPage
      .getByRole("button", { name: "Sign in", exact: true })
      .click();
    await expect(
      wrongLoginPage.getByRole("main").getByRole("alert"),
    ).toBeVisible();
    await wrongLoginPage.close();
    const wrong = message.code === "000000" ? "000001" : "000000";
    await input.page.goto("/verify-email");
    await input.page.getByLabel("6-digit verification code").fill(wrong);
    await input.page
      .getByRole("button", { name: "Verify", exact: true })
      .click();
    await expect(input.page.getByRole("main").getByRole("alert")).toBeVisible();
    await input.harness.prisma.pendingRegistration.update({
      where: { email: input.email },
      data: {
        issuedAt: new Date(Date.now() - 660_000),
        expiresAt: new Date(Date.now() - 60_000),
      },
    });
    const verificationToken = new URL(messageUrl(message)).searchParams.get(
      "token",
    );
    if (!verificationToken) throw new Error("verification-token-unavailable");
    expect(
      (await post(input, "auth/verify-email", { token: verificationToken }))
        .status,
    ).toBe(400);
    const expiredLinkPage = await input.context.newPage();
    await expiredLinkPage.goto(messageUrl(message));
    await expiredLinkPage
      .getByRole("button", { name: "Check verification link", exact: true })
      .click();
    await expect(
      expiredLinkPage.getByRole("main").getByRole("alert"),
    ).toBeVisible();
    await input.page.getByLabel("6-digit verification code").fill(message.code);
    await input.page
      .getByRole("button", { name: "Verify", exact: true })
      .click();
    await expect(input.page.getByRole("main").getByRole("alert")).toBeVisible();
    const secondaryEmail = `d4n3-${randomUUID()}@example.invalid`;
    const secondaryPassword = randomBytes(24).toString("base64url");
    input.harness.mailbox.allowAccount(secondaryEmail);
    const secondaryContext = await input.context
      .browser()!
      .newContext({ baseURL: webOrigin });
    try {
      const secondaryPage = await secondaryContext.newPage();
      await secondaryPage.addInitScript(() =>
        localStorage.setItem("stockwise.language", "en"),
      );
      await secondaryPage.goto("/register");
      await secondaryPage.getByLabel("Email address").fill(secondaryEmail);
      await secondaryPage
        .getByLabel("Password", { exact: true })
        .fill(secondaryPassword);
      await secondaryPage
        .getByLabel("Confirm password", { exact: true })
        .fill(secondaryPassword);
      const registration = secondaryPage.waitForResponse(
        (response) =>
          response.url().endsWith("/auth/register") &&
          response.request().method() === "POST",
      );
      await secondaryPage
        .getByRole("button", { name: "Create account", exact: true })
        .click();
      expect((await registration).status()).toBe(202);
      const verification = await input.harness.mailbox.next(secondaryEmail);
      if (verification.kind !== "verification")
        throw new Error("secondary-mail-kind");
      await secondaryPage
        .getByLabel("6-digit verification code")
        .fill(verification.code);
      await secondaryPage
        .getByRole("button", { name: "Verify", exact: true })
        .click();
      await expect(
        secondaryPage.getByText(
          "Your email has been verified. You can now sign in.",
          { exact: true },
        ),
      ).toBeVisible();
      await secondaryPage.goto("/login");
      await secondaryPage.getByLabel("Email address").fill(secondaryEmail);
      await secondaryPage
        .getByLabel("Password", { exact: true })
        .fill("wrong-value-not-a-secret");
      const failedLogin = secondaryPage.waitForResponse(
        (response) =>
          response.url().endsWith("/auth/login") &&
          response.request().method() === "POST",
      );
      await secondaryPage
        .getByRole("button", { name: "Sign in", exact: true })
        .click();
      expect((await failedLogin).status()).toBe(401);
      await expect(
        secondaryPage.getByRole("main").getByRole("alert"),
      ).toBeVisible();
      await secondaryPage.goto("/forgot-password");
      await secondaryPage.getByLabel("Email address").fill(secondaryEmail);
      await secondaryPage
        .getByRole("button", { name: "Request password reset" })
        .click();
      const reset = await input.harness.mailbox.next(secondaryEmail);
      if (reset.kind !== "password_reset")
        throw new Error("secondary-reset-kind");
      const resetRow =
        await input.harness.prisma.passwordResetToken.findFirstOrThrow({
          where: { user: { email: secondaryEmail } },
          select: { id: true },
        });
      await input.harness.prisma.passwordResetToken.update({
        where: { id: resetRow.id },
        data: {
          issuedAt: new Date(Date.now() - 1_860_000),
          expiresAt: new Date(Date.now() - 60_000),
          deliveryConfirmedAt: new Date(Date.now() - 1_850_000),
        },
      });
      const resetPage = await secondaryContext.newPage();
      await resetPage.goto(messageUrl(reset));
      await resetPage
        .getByLabel("New password")
        .fill(randomBytes(20).toString("base64url"));
      await resetPage.getByRole("button", { name: "Reset password" }).click();
      await expect(
        resetPage.getByRole("main").getByRole("alert"),
      ).toBeVisible();
    } finally {
      input.harness.mailbox.releaseAccount(secondaryEmail);
      await secondaryContext.close();
    }
  },
);

journey(
  "08 refresh history BFCache and tab focus preserve nonsecret continuation",
  async (input) => {
    await input.page.addInitScript(() => {
      window.addEventListener("pageshow", (event) => {
        if (event.persisted) (window as JourneyWindow).__d4n3Persisted = true;
      });
    });
    const result = await register(input);
    const cacheDiagnostics = await input.context.newCDPSession(input.page);
    const cacheReasons: string[] = [];
    cacheDiagnostics.on(
      "Page.backForwardCacheNotUsed",
      (event: { notRestoredExplanations?: Array<{ reason: string }> }) => {
        cacheReasons.push(
          ...(event.notRestoredExplanations ?? []).map((item) => item.reason),
        );
      },
    );
    await cacheDiagnostics.send("Page.enable");
    await input.page.reload();
    await expect(
      input.page.getByLabel("6-digit verification code"),
    ).toBeVisible();
    const storage = await input.page.evaluate(() =>
      sessionStorage.getItem("stockwise_verification_continuation"),
    );
    expect(storage).toContain(input.email);
    expect(storage).not.toContain(result.message.code);
    expect(storage).not.toContain(
      new URL(messageUrl(result.message)).searchParams.get("token") ?? "",
    );
    input.stage = "otp-bfcache";
    await input.page.waitForLoadState("networkidle");
    cacheReasons.length = 0;
    // Cross-site navigation forces a distinct browsing instance without relaxing no-store.
    input.stage = "bfcache-target-navigation";
    await input.page.goto("http://127.0.0.1:3202/pricing", {
      waitUntil: "domcontentloaded",
      timeout: 8_000,
    });
    input.stage = "bfcache-back-commit";
    await input.page.goBack({ waitUntil: "commit", timeout: 8_000 });
    input.stage = "bfcache-restored-view";
    await expect(input.page).toHaveURL(`${webOrigin}/verify-email`);
    await expect(
      input.page.getByLabel("6-digit verification code"),
    ).toBeVisible();
    const restored = await input.page.evaluate(
      () => (window as JourneyWindow).__d4n3Persisted === true,
    );
    if (!restored) {
      const cause = cacheReasons.some((reason) => reason.includes("NoStore"))
        ? "no-store"
        : cacheReasons.some((reason) => reason.includes("Network"))
          ? "network"
          : cacheReasons.some((reason) => reason.includes("BrowsingInstance"))
            ? "browsing-instance"
            : cacheReasons.some((reason) => reason.includes("Disabled"))
              ? "disabled"
              : "other";
      input.stage = `otp-bfcache-${cause}`;
    }
    expect(restored).toBe(true);
    const navigationHistory: {
      currentIndex: number;
      entries: Array<{ id: number }>;
    } = await cacheDiagnostics.send("Page.getNavigationHistory");
    const hasForwardEntry =
      navigationHistory.currentIndex < navigationHistory.entries.length - 1;
    input.stage = hasForwardEntry
      ? "history-forward-commit"
      : "history-forward-missing";
    expect(hasForwardEntry).toBe(true);
    await input.page.goForward({ waitUntil: "commit", timeout: 8_000 });
    input.stage = "history-forward-location";
    await expect(input.page).toHaveURL("http://127.0.0.1:3202/pricing");
    input.stage = "history-second-back-commit";
    await input.page.goBack({ waitUntil: "commit", timeout: 8_000 });
    input.stage = "history-second-restored-location";
    await expect(input.page).toHaveURL(`${webOrigin}/verify-email`);
    input.stage = "history-second-restored-otp";
    try {
      await expect(
        input.page.getByLabel("6-digit verification code"),
      ).toBeVisible();
    } catch {
      input.stage = "history-second-state-diagnostic";
      const state = await input.page.evaluate(() => ({
        persisted: (window as JourneyWindow).__d4n3Persisted === true,
        continuation:
          sessionStorage.getItem("stockwise_verification_continuation") !==
          null,
      }));
      input.stage = `history-second-${state.persisted ? "cached" : "loaded"}-${state.continuation ? "saved" : "missing"}`;
      throw new Error("second-history-otp-unavailable");
    }
    await recordOperatorHistory(restored);
    // Playwright enables focus emulation by default. Observe native focus instead.
    await cacheDiagnostics.send("Emulation.setFocusEmulationEnabled", {
      enabled: false,
    });
    input.stage = "otp-native-focus";
    const ownedWindow = await cacheDiagnostics.send(
      "Browser.getWindowForTarget",
    );
    await cacheDiagnostics.send("Browser.setWindowBounds", {
      windowId: ownedWindow.windowId,
      bounds: { windowState: "normal" },
    });
    await armOperatorFocus(input.page, "otp");
    await waitForOperatorClick(input.page);
    const codeInput = input.page.getByLabel("6-digit verification code");
    await codeInput.fill("123");
    await expect(codeInput).toHaveValue("123");
    input.stage = "otp-operator-alt-tab";
    await verifyOperatorAltTab(input.page, "otp");
    input.stage = "otp-draft-preserved";
    expect(await codeInput.inputValue()).toBe("123");
    await codeInput.fill(result.message.code);
    await verifyByCode(input, result.message.code);
    input.stage = "login-draft-focus";
    await input.page.goto("/login");
    await input.page.getByLabel("Email address").fill(input.email);
    await input.page
      .getByLabel("Password", { exact: true })
      .fill(input.password);
    await expect(input.page.getByLabel("Email address")).toHaveValue(
      input.email,
    );
    await expect(
      input.page.getByLabel("Password", { exact: true }),
    ).toHaveValue(input.password);
    await cacheDiagnostics.send("Emulation.setFocusEmulationEnabled", {
      enabled: false,
    });
    await armOperatorFocus(input.page, "login");
    input.stage = "login-operator-alt-tab";
    await verifyOperatorAltTab(input.page, "login");
    await expect(input.page.getByLabel("Email address")).toHaveValue(
      input.email,
    );
    await expect(
      input.page.getByLabel("Password", { exact: true }),
    ).toHaveValue(input.password);
    expect(
      await input.page.evaluate(
        (password) =>
          JSON.stringify(localStorage).includes(password) ||
          JSON.stringify(sessionStorage).includes(password),
        input.password,
      ),
    ).toBe(false);
    await cacheDiagnostics.detach();
  },
);

journey(
  "09 protected redirect resolves without loops and guest routes remain reachable",
  async (input) => {
    await input.page.goto("/app?organizationId=not-a-uuid&branchId=not-a-uuid");
    await expect(input.page).toHaveURL(`${webOrigin}/login`);
    await expect(
      input.page.getByRole("button", { name: "Sign in", exact: true }),
    ).toBeVisible();
    await input.page.goto("/verify-email");
    input.stage = "guest-recovery-view";
    const recovery = input.page.getByRole("main");
    await expect(recovery.getByRole("status")).toBeVisible();
    input.stage = "guest-recovery-link";
    await recovery.locator('a[href="/login"]').click();
    await expect(input.page).toHaveURL(`${webOrigin}/login`);
    await input.page.goto("/register");
    await expect(
      input.page.getByRole("button", { name: "Create account", exact: true }),
    ).toBeVisible();
    const requests: string[] = [];
    input.page.on("request", (request) => {
      if (request.url().includes("/api/v1/me/access-context"))
        requests.push(request.url());
    });
    await input.page.goto("/app");
    await expect(input.page).toHaveURL(`${webOrigin}/login`);
    await expect.poll(() => requests.length).toBeLessThan(4);
  },
);

journey(
  "10 tenant boundaries, RBAC, branch scope and query cache isolation use authenticated requests",
  async (input) => {
    await completedAccount(input);
    expect((await login(input)).status()).toBe(200);
    const scope = await createOwnerScope(input);
    const context = await input.page.evaluate(async () => {
      const response = await fetch("/api/v1/me/access-context");
      return { status: response.status, data: await response.json() };
    });
    expect(context.status).toBe(200);
    expect(
      context.data.data.organizations.map((org: { id: string }) => org.id),
    ).toContain(scope.organization.id);
    await input.page.goto(
      `/app?organizationId=${scope.organization.id}&branchId=${scope.first.id}`,
    );
    await expect(input.page.getByLabel("Branch")).toHaveValue(scope.first.id);
    const allowedBranch = await input.page.request.get(
      `${webOrigin}/api/v1/organizations/${scope.organization.id}/branches`,
    );
    expect(allowedBranch.status()).toBe(200);
    const foreignOrg = await input.harness.prisma.organization.create({
      data: { name: "Foreign tenant" },
    });
    const foreignBranch = await input.harness.prisma.branch.create({
      data: {
        code: "X",
        name: "Foreign branch",
        organizationId: foreignOrg.id,
      },
    });
    const denied = await input.page.request.get(
      `${webOrigin}/api/v1/organizations/${foreignOrg.id}/branches`,
    );
    expect(denied.status()).toBe(403);
    const secondEmail = `d4n3-${randomUUID()}@example.invalid`;
    const secondPassword = randomBytes(24).toString("base64url");
    input.harness.mailbox.allowAccount(secondEmail);
    const secondContext = await input.context
      .browser()!
      .newContext({ baseURL: webOrigin });
    try {
      const secondPage = await secondContext.newPage();
      await secondPage.addInitScript(() =>
        localStorage.setItem("stockwise.language", "en"),
      );
      await secondPage.goto("/register");
      await secondPage.getByLabel("Email address").fill(secondEmail);
      await secondPage
        .getByLabel("Password", { exact: true })
        .fill(secondPassword);
      await secondPage
        .getByLabel("Confirm password", { exact: true })
        .fill(secondPassword);
      const registration = secondPage.waitForResponse(
        (response) =>
          response.url().endsWith("/auth/register") &&
          response.request().method() === "POST",
      );
      await secondPage
        .getByRole("button", { name: "Create account", exact: true })
        .click();
      expect((await registration).status()).toBe(202);
      const secondMail = await input.harness.mailbox.next(secondEmail);
      if (secondMail.kind !== "verification")
        throw new Error("second-mail-kind");
      await secondPage
        .getByLabel("6-digit verification code")
        .fill(secondMail.code);
      await secondPage
        .getByRole("button", { name: "Verify", exact: true })
        .click();
      await expect(
        secondPage.getByText(
          "Your email has been verified. You can now sign in.",
          { exact: true },
        ),
      ).toBeVisible();
      const secondUser = await input.harness.prisma.user.findUniqueOrThrow({
        where: { email: secondEmail },
        select: { id: true },
      });
      await input.harness.prisma.organizationMembership.create({
        data: {
          organizationId: scope.organization.id,
          userId: secondUser.id,
          role: "BRANCH_MANAGER",
        },
      });
      await input.harness.prisma.branchAssignment.create({
        data: {
          organizationId: scope.organization.id,
          userId: secondUser.id,
          branchId: scope.second.id,
        },
      });
      await secondPage.goto("/login");
      await secondPage.getByLabel("Email address").fill(secondEmail);
      await secondPage
        .getByLabel("Password", { exact: true })
        .fill(secondPassword);
      const secondLogin = secondPage.waitForResponse(
        (response) =>
          response.url().endsWith("/auth/login") &&
          response.request().method() === "POST",
      );
      await secondPage
        .getByRole("button", { name: "Sign in", exact: true })
        .click();
      expect((await secondLogin).status()).toBe(200);
      const scopedContext = await secondPage.evaluate(async () =>
        (await fetch("/api/v1/me/access-context")).json(),
      );
      expect(scopedContext.data.organizations).toMatchObject([
        {
          id: scope.organization.id,
          role: "BRANCH_MANAGER",
          branches: [{ id: scope.second.id }],
        },
      ]);
      const scopedBranches = await secondPage.request.get(
        `${webOrigin}/api/v1/organizations/${scope.organization.id}/branches`,
      );
      expect(scopedBranches.status()).toBe(200);
      expect(
        (await scopedBranches.json()).data.map(
          (branch: { id: string }) => branch.id,
        ),
      ).toEqual([scope.second.id]);
      input.stage = "rbac-denial";
      expect(
        (
          await secondContext.request.post(
            `${webOrigin}/api/v1/organizations/${scope.organization.id}/branches`,
            {
              headers: { Origin: webOrigin },
              data: { code: "DENIED", name: "Denied creation" },
            },
          )
        ).status(),
      ).toBe(403);
      expect(
        await input.harness.prisma.branch.count({
          where: { organizationId: scope.organization.id, code: "DENIED" },
        }),
      ).toBe(0);
      await secondPage.goto(
        `/app?organizationId=${scope.organization.id}&branchId=${scope.first.id}`,
      );
      await expect(secondPage).toHaveURL(
        new RegExp(`branchId=${scope.second.id}`),
      );
      await expect(
        secondPage
          .getByLabel("Branch")
          .locator(`option[value="${scope.first.id}"]`),
      ).toHaveCount(0);
      expect(
        (
          await secondPage.request.get(
            `${webOrigin}/api/v1/organizations/${foreignOrg.id}/branches`,
          )
        ).status(),
      ).toBe(403);
    } finally {
      input.harness.mailbox.releaseAccount(secondEmail);
      await secondContext.close();
    }
    const tamperedContext = await input.page.evaluate(
      async ({ organizationId, branchId }) => {
        const response = await fetch(
          `/api/v1/me/access-context?organizationId=${organizationId}&branchId=${branchId}`,
        );
        return { status: response.status, body: await response.json() };
      },
      { organizationId: foreignOrg.id, branchId: foreignBranch.id },
    );
    expect(tamperedContext.status).toBe(200);
    expect(
      tamperedContext.body.data.organizations.map(
        (organization: { id: string }) => organization.id,
      ),
    ).toEqual([scope.organization.id]);
    await input.page.getByLabel("Branch").selectOption(scope.second.id);
    await expect(input.page).toHaveURL(
      new RegExp(`branchId=${scope.second.id}`),
    );
    const one = await input.page.evaluate(async () =>
      (await fetch("/api/v1/me/access-context")).json(),
    );
    expect(JSON.stringify(one)).not.toContain("Foreign tenant");
    const replayContext = await input.context
      .browser()!
      .newContext({ baseURL: webOrigin });
    try {
      expect(
        await replayContext.request
          .get(`${webOrigin}/api/v1/me/access-context`)
          .then((response) => response.status()),
      ).toBe(401);
    } finally {
      await replayContext.close();
    }
    input.stage = "same-context-account-switch";
    await input.page.getByLabel("Branch").selectOption(scope.first.id);
    await input.page
      .getByRole("button", { name: "Log out", exact: true })
      .click();
    await expect(input.page).toHaveURL(`${webOrigin}/login`);
    await input.page.getByLabel("Email address").fill(secondEmail);
    await input.page
      .getByLabel("Password", { exact: true })
      .fill(secondPassword);
    const switchedLogin = input.page.waitForResponse(
      (r) => r.url().endsWith("/auth/login") && r.request().method() === "POST",
    );
    await input.page
      .getByRole("button", { name: "Sign in", exact: true })
      .click();
    expect((await switchedLogin).status()).toBe(200);
    await expect(input.page).toHaveURL(
      new RegExp(`branchId=${scope.second.id}`),
    );
    const switched = await input.page.evaluate(async () =>
      (await fetch("/api/v1/me/access-context")).json(),
    );
    expect(switched.data.user.email).toBe(secondEmail);
    expect(switched.data.organizations).toMatchObject([
      {
        id: scope.organization.id,
        role: "BRANCH_MANAGER",
        branches: [{ id: scope.second.id }],
      },
    ]);
    await expect(
      input.page.getByRole("link", { name: "Branches", exact: true }),
    ).toHaveCount(0);
    await expect(
      input.page
        .getByLabel("Branch")
        .locator(`option[value="${scope.first.id}"]`),
    ).toHaveCount(0);
  },
);
