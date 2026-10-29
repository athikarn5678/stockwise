import { randomUUID } from "node:crypto";
import { hashSessionToken } from "../../../apps/api/src/modules/identity/session-token.ts";
import { assertMailboxOnlyTerminalState } from "./terminal-state.ts";
import { assertSuccessorOtpUi } from "./successor-ui.ts";
import {
  expect,
  noAuthority,
  post,
  register,
  scenario,
  verifyCode,
  type Scenario,
} from "./fixtures";

const proofName = "__Host-stockwise_verification_proof";
const origin = "http://localhost:3102";
const continuationKey = "stockwise_verification_continuation";

async function submitCode(input: Scenario, challengeId: string, code: string) {
  return post(input.page, "auth/verify-email-code", {
    email: input.email,
    challengeId,
    code,
  });
}
function linkToken(url: string) {
  const token = new URL(url).searchParams.get("token");
  if (!token) throw new Error("Private link material unavailable.");
  return token;
}
async function login(input: Scenario) {
  await input.page.goto("/login");
  await input.page.getByLabel("Email address").fill(input.email);
  await input.page.getByLabel("Password", { exact: true }).fill(input.password);
  const response = input.page
    .waitForResponse(
      (r) => r.url().endsWith("/auth/login") && r.request().method() === "POST",
    )
    .catch(() => null);
  await input.page
    .getByRole("button", { name: "Sign in", exact: true })
    .click();
  const result = await response;
  if (!result) throw new Error("Login response unavailable.");
  return result.status();
}

async function registerSuccessor(input: Scenario, email: string) {
  await input.page.locator('header a[href="/"]').click();
  await input.page.getByRole("link", { name: "Get started" }).first().click();
  await input.page.getByLabel("Email address").fill(email);
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
  await expect(input.page).toHaveURL(`${origin}/verify-email`);
  await expect(
    input.page.getByLabel("6-digit verification code"),
  ).toBeVisible();
  await expect(
    input.page.getByRole("button", { name: "Verify", exact: true }),
  ).toBeEnabled();
  await input.harness.mailbox.next(email);
}

scenario(
  "01 registration returns generic 202 and pending OTP continuation without authority",
  async (input) => {
    const { challengeId } = await register(input);
    const user = await input.harness.prisma.user.findUniqueOrThrow({
      where: { email: input.email },
      select: { emailVerifiedAt: true, credentialVersion: true },
    });
    expect(user.emailVerifiedAt).toBeNull();
    expect(user.credentialVersion === 1n).toBe(true);
    const saved = await input.page.evaluate(
      (key) => JSON.parse(sessionStorage.getItem(key) ?? "null"),
      continuationKey,
    );
    expect(saved).toMatchObject({
      canonicalEmail: input.email,
      challengeId,
      version: 1,
    });
    await noAuthority(input);
  },
);

scenario(
  "02 OTP consumes verification once and keeps link informational only before expiry",
  async (input) => {
    const { mail, challengeId } = await register(input);
    expect(/^[0-9]{6}$/.test(mail.code)).toBe(true);
    await verifyCode(input, mail.code);
    expect(
      (await input.page.context().cookies()).some((c) => c.name === proofName),
    ).toBe(false);
    expect((await submitCode(input, challengeId, mail.code)).status).toBe(400);
    const replay = await post(input.page, "auth/verify-email", {
      token: linkToken(mail.url),
    });
    expect(replay.status).toBe(200);
    expect(replay.data).toMatchObject({ data: { status: "already_verified" } });
    await noAuthority(input);
  },
);

scenario(
  "03 secure link GET remains unconsumed and explicit UI POST verifies",
  async (input) => {
    const { mail, challengeId } = await register(input);
    let posts = 0;
    input.page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        request.url().endsWith("/auth/verify-email")
      )
        posts += 1;
    });
    await input.page.goto(mail.url);
    await expect(
      input.page.getByRole("button", { name: "Verify", exact: true }),
    ).toBeVisible();
    expect(posts).toBe(0);
    expect(
      (
        await input.harness.prisma.emailVerificationChallenge.findUniqueOrThrow(
          { where: { id: challengeId }, select: { consumedAt: true } },
        )
      ).consumedAt,
    ).toBeNull();
    const privateToken = linkToken(mail.url);
    const clean = await input.page.evaluate(
      (token) =>
        ![
          location.href,
          JSON.stringify(history.state),
          document.documentElement.outerHTML,
          JSON.stringify(localStorage),
          JSON.stringify(sessionStorage),
          document.cookie,
        ].some((surface) => surface.includes(token)),
      privateToken,
    );
    expect(clean).toBe(true);
    await input.page
      .getByRole("button", { name: "Verify", exact: true })
      .click();
    await expect(
      input.page.getByText(
        "Your email has been verified. You can now sign in.",
        { exact: true },
      ),
    ).toBeVisible();
    expect(posts).toBe(1);
    expect((await submitCode(input, challengeId, mail.code)).status).toBe(400);
    await noAuthority(input);
  },
);

scenario(
  "04 pending login returns verification_required and no new mail or application session",
  async (input) => {
    const { challengeId } = await register(input);
    await input.page.context().clearCookies();
    expect(await login(input)).toBe(202);
    await expect(input.page).toHaveURL(`${origin}/verify-email`);
    const saved = await input.page.evaluate(
      (key) => JSON.parse(sessionStorage.getItem(key) ?? "null"),
      continuationKey,
    );
    expect(saved.challengeId === challengeId).toBe(true);
    await expect(input.harness.mailbox.next(input.email, 25)).rejects.toThrow(
      "Private verification delivery unavailable.",
    );
    await noAuthority(input);
  },
);

scenario(
  "05 verified UI login establishes real session and protected access",
  async (input) => {
    const { mail } = await register(input);
    await verifyCode(input, mail.code);
    expect(await login(input)).toBe(200);
    expect(
      (await input.page.context().cookies()).some(
        (c) =>
          c.name === "stockwise_session" && c.httpOnly && c.sameSite === "Lax",
      ),
    ).toBe(true);
    expect(
      await input.page.evaluate(
        async () => (await fetch("/api/v1/me/access-context")).status,
      ),
    ).toBe(200);
    expect(
      await input.harness.prisma.session.count({
        where: { user: { email: input.email }, revokedAt: null },
      }),
    ).toBe(1);
  },
);

scenario(
  "06 mailbox-only rejection triggers real password-proof UI fallback",
  async (input) => {
    const { mail } = await register(input);
    await input.page.context().clearCookies();
    await input.page.getByLabel("6-digit verification code").fill(mail.code);
    await input.page
      .getByRole("button", { name: "Verify", exact: true })
      .click();
    await expect(
      input.page.getByRole("button", { name: "Confirm password", exact: true }),
    ).toBeVisible();
    await noAuthority(input);
    await input.page
      .getByLabel("Password", { exact: true })
      .fill(input.password);
    await input.page
      .getByRole("button", { name: "Confirm password", exact: true })
      .click();
    await expect(
      input.page.getByText(
        "Your email has been verified. You can now sign in.",
        { exact: true },
      ),
    ).toBeVisible();
    await noAuthority(input);
  },
);

scenario(
  "07 one-click resend UI replaces challenge without renewing proof",
  async (input) => {
    const previous = await register(input);
    const proof = (await input.page.context().cookies()).find(
      (c) => c.name === proofName,
    );
    await expect(input.page.getByLabel("Email address")).toHaveCount(0);
    await input.page
      .getByRole("button", { name: "Request a new code" })
      .click();
    const next = await input.harness.mailbox.next(input.email);
    await expect(input.page).toHaveURL(`${origin}/verify-email`);
    const unchanged = (await input.page.context().cookies()).find(
      (c) => c.name === proofName,
    );
    expect(
      !!proof &&
        !!unchanged &&
        proof.value === unchanged.value &&
        proof.expires === unchanged.expires,
    ).toBe(true);
    expect(
      (await submitCode(input, previous.challengeId, previous.mail.code))
        .status,
    ).toBe(400);
    expect(
      (
        await post(input.page, "auth/verify-email", {
          token: linkToken(previous.mail.url),
        })
      ).status,
    ).toBe(400);
    await verifyCode(input, next.code);
  },
);

scenario(
  "08 invalid OTP and random secure link return mailbox errors without consumption",
  async (input) => {
    const { mail, challengeId } = await register(input);
    const wrong = mail.code === "000000" ? "000001" : "000000";
    expect((await submitCode(input, challengeId, wrong)).status).toBe(400);
    expect(
      (await post(input.page, "auth/verify-email", { token: "x".repeat(43) }))
        .status,
    ).toBe(400);
    expect(
      (
        await input.harness.prisma.emailVerificationChallenge.findUniqueOrThrow(
          {
            where: { id: challengeId },
            select: { failedOtpAttempts: true, consumedAt: true },
          },
        )
      ).failedOtpAttempts,
    ).toBe(1);
    await verifyCode(input, mail.code);
  },
);

scenario(
  "09 expired unified challenge rejects both OTP and secure link",
  async (input) => {
    const { mail, challengeId } = await register(input);
    // Fixture-only clock preparation; real services still use fresh PostgreSQL time.
    await input.harness.prisma.emailVerificationChallenge.update({
      where: { id: challengeId },
      data: {
        issuedAt: new Date(Date.now() - 660_000),
        expiresAt: new Date(Date.now() - 60_000),
      },
    });
    expect((await submitCode(input, challengeId, mail.code)).status).toBe(400);
    expect(
      (
        await post(input.page, "auth/verify-email", {
          token: linkToken(mail.url),
        })
      ).status,
    ).toBe(400);
    await noAuthority(input);
  },
);

scenario(
  "10 five durable wrong attempts enforce LINK_ONLY while secure link still succeeds",
  async (input) => {
    const { mail, challengeId } = await register(input);
    const wrong = mail.code === "000000" ? "000001" : "000000";
    for (let attempt = 0; attempt < 5; attempt += 1)
      expect((await submitCode(input, challengeId, wrong)).status).toBe(400);
    const exhausted =
      await input.harness.prisma.emailVerificationChallenge.findUniqueOrThrow({
        where: { id: challengeId },
        select: { failedOtpAttempts: true, consumedAt: true, revokedAt: true },
      });
    expect(exhausted).toMatchObject({
      failedOtpAttempts: 5,
      consumedAt: null,
      revokedAt: null,
    });
    expect((await submitCode(input, challengeId, mail.code)).status).toBe(400);
    expect(
      (
        await post(input.page, "auth/verify-email", {
          token: linkToken(mail.url),
        })
      ).status,
    ).toBe(200);
    await noAuthority(input);
  },
);

scenario(
  "11 legitimate duplicate replacement invalidates old proof and old challenge",
  async (input) => {
    const previous = await register(input);
    const context = await input.page
      .context()
      .browser()!
      .newContext({ baseURL: origin });
    try {
      const successorPage = await context.newPage();
      await successorPage.goto("/register");
      expect(
        (
          await post(successorPage, "auth/register", {
            email: input.email,
            password: input.password,
          })
        ).status,
      ).toBe(202);
      const next = await input.harness.mailbox.next(input.email);
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
      expect(
        (await submitCode(input, previous.challengeId, previous.mail.code))
          .status,
      ).toBe(400);
      expect((await submitCode(input, challenge.id, next.code)).status).toBe(
        401,
      );
      expect(
        (
          await post(input.page, "auth/verification-password-proof", {
            email: input.email,
            password: input.password,
          })
        ).status,
      ).toBe(202);
      expect((await submitCode(input, challenge.id, next.code)).status).toBe(
        200,
      );
    } finally {
      await context.close();
    }
    await noAuthority(input);
  },
);

scenario(
  "12 Secure HttpOnly Strict proof is created, hidden from JS, transmitted and cleared",
  async (input) => {
    const { mail } = await register(input);
    const cookie = (await input.page.context().cookies()).find(
      (c) => c.name === proofName,
    );
    expect(
      !!cookie &&
        cookie.secure &&
        cookie.httpOnly &&
        cookie.sameSite === "Strict" &&
        cookie.path === "/" &&
        cookie.domain === "localhost" &&
        cookie.value.length === 100,
    ).toBe(true);
    expect(
      await input.page.evaluate(
        (name) => document.cookie.includes(name),
        proofName,
      ),
    ).toBe(false);
    await verifyCode(input, mail.code);
    expect(
      (await input.page.context().cookies()).some((c) => c.name === proofName),
    ).toBe(false);
  },
);

scenario(
  "13 missing null mismatched Origin and cross-site metadata are rejected before writes",
  async (input) => {
    await input.page.goto("/register");
    for (const path of [
      "register",
      "login",
      "verification-password-proof",
      "verification-resend",
      "verify-email-code",
      "verify-email",
    ]) {
      const body =
        path === "verify-email"
          ? { token: "x".repeat(43) }
          : path === "verify-email-code"
            ? { email: input.email, challengeId: randomUUID(), code: "000000" }
            : path === "verification-resend"
              ? { email: input.email }
              : { email: input.email, password: input.password };
      for (const headers of [
        {},
        { Origin: "null" },
        { Origin: "http://cross-site.invalid" },
        { Origin: origin, "Sec-Fetch-Site": "cross-site" },
      ]) {
        const response = await input.page
          .context()
          .request.post(`${origin}/api/v1/auth/${path}`, {
            headers,
            data: body,
          });
        expect(response.status()).toBe(403);
      }
    }
    expect(
      await input.harness.prisma.user.count({ where: { email: input.email } }),
    ).toBe(0);
    expect(
      (await input.page.context().cookies()).some((c) => c.name === proofName),
    ).toBe(false);
    expect(
      await input.harness.prisma.emailVerificationChallenge.count({
        where: { user: { email: input.email } },
      }),
    ).toBe(0);
    // The real limiter permits five registrations; mail admission has a separate three-request budget.
    for (let attempt = 0; attempt < 5; attempt += 1)
      expect(
        (
          await post(input.page, "auth/register", {
            email: input.email,
            password: input.password,
          })
        ).status,
      ).toBe(202);
    expect(
      (
        await post(input.page, "auth/register", {
          email: input.email,
          password: input.password,
        })
      ).status,
    ).toBe(429);
    await noAuthority(input);
  },
);

scenario(
  "14 refresh retains only continuation and navigation never resends",
  async (input) => {
    const { mail } = await register(input);
    await input.page.reload();
    await expect(
      input.page.getByLabel("6-digit verification code"),
    ).toBeVisible();
    const safeStorage = await input.page.evaluate(
      ({ password, code, token }) =>
        ![
          JSON.stringify(localStorage),
          JSON.stringify(sessionStorage),
          JSON.stringify(history.state),
        ].some((surface) =>
          [password, code, token].some((secret) => surface.includes(secret)),
        ),
      { password: input.password, code: mail.code, token: linkToken(mail.url) },
    );
    expect(safeStorage).toBe(true);
    await expect(input.harness.mailbox.next(input.email, 25)).rejects.toThrow(
      "Private verification delivery unavailable.",
    );
    await verifyCode(input, mail.code);
  },
);

scenario(
  "15 refresh abandons link and pending login recovers continuation",
  async (input) => {
    const { mail } = await register(input);
    await input.page.goto(mail.url);
    await expect(
      input.page.getByRole("button", { name: "Verify", exact: true }),
    ).toBeVisible();
    await input.page.reload();
    await expect(
      input.page.getByRole("button", { name: "Verify", exact: true }),
    ).toHaveCount(0);
    expect(await login(input)).toBe(202);
    await verifyCode(input, mail.code);
  },
);

scenario(
  "16 canceled real resend preserves successor after SPA abandonment",
  async (input) => {
    const previous = await register(input);
    const successorEmail = `t02a-${randomUUID()}@example.invalid`;
    input.harness.mailbox.allowAccount(successorEmail);
    const delayed = input.delayedResponse();
    let requests = 0;
    input.page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        request.url().endsWith("/auth/verification-resend")
      )
        requests += 1;
    });
    // Only defer transport of an actual backend response; never fabricate a response.
    await input.page.route(
      "**/api/v1/auth/verification-resend",
      delayed.handle,
    );
    try {
      await input.page
        .getByRole("button", { name: "Request a new code" })
        .click();
      expect(await delayed.status()).toBe(202);
      await input.harness.mailbox.next(input.email);
      const replaced =
        await input.harness.prisma.emailVerificationChallenge.findUniqueOrThrow(
          {
            where: { id: previous.challengeId },
            select: { replacedAt: true, consumedAt: true },
          },
        );
      expect(replaced.replacedAt !== null && replaced.consumedAt === null).toBe(
        true,
      );
      const next =
        await input.harness.prisma.emailVerificationChallenge.findFirstOrThrow({
          where: {
            user: { email: input.email },
            consumedAt: null,
            replacedAt: null,
            revokedAt: null,
          },
          select: { id: true },
        });
      expect(next.id !== previous.challengeId).toBe(true);
      await input.page.getByRole("link", { name: "Back to sign in" }).click();
      await expect(input.page).toHaveURL(`${origin}/login`);
      await registerSuccessor(input, successorEmail);
      const successorContinuation = await input.page.evaluate(
        (key) => sessionStorage.getItem(key),
        continuationKey,
      );
      await assertSuccessorOtpUi(
        input.page,
        {
          email: successorEmail,
          continuation: successorContinuation,
          url: `${origin}/verify-email`,
        },
        async () => {
          delayed.release();
          expect(await delayed.finish()).toEqual({
            backendStatus: 202,
            browserOutcome: "canceled",
          });
          await input.page.unrouteAll({ behavior: "wait" });
        },
      );
      expect(
        await input.page.evaluate(
          (key) =>
            JSON.parse(sessionStorage.getItem(key) ?? "null").canonicalEmail,
          continuationKey,
        ),
      ).toBe(successorEmail);
      expect(
        await input.page.evaluate(
          (key) => sessionStorage.getItem(key),
          continuationKey,
        ),
      ).toBe(successorContinuation);
      expect(requests).toBe(1);
      expect(
        await input.harness.prisma.emailVerificationChallenge.findUniqueOrThrow(
          {
            where: { id: next.id },
            select: {
              consumedAt: true,
              replacedAt: true,
              revokedAt: true,
              failedOtpAttempts: true,
            },
          },
        ),
      ).toMatchObject({
        consumedAt: null,
        replacedAt: null,
        revokedAt: null,
        failedOtpAttempts: 0,
      });
      expect(
        (
          await input.harness.prisma.user.findUniqueOrThrow({
            where: { email: input.email },
            select: { emailVerifiedAt: true },
          })
        ).emailVerifiedAt,
      ).toBeNull();
      expect(
        (
          await input.harness.prisma.user.findUniqueOrThrow({
            where: { email: successorEmail },
            select: { emailVerifiedAt: true },
          })
        ).emailVerifiedAt,
      ).toBeNull();
      await expect(input.page).toHaveURL(`${origin}/verify-email`);
      await expect(
        input.page.getByLabel("6-digit verification code"),
      ).toBeVisible();
      expect(
        await input.harness.prisma.session.count({
          where: { user: { email: { in: [input.email, successorEmail] } } },
        }),
      ).toBe(0);
    } finally {
      delayed.release();
      try {
        await input.page.unrouteAll({ behavior: "wait" });
      } finally {
        input.harness.mailbox.releaseAccount(successorEmail);
      }
    }
  },
);

for (const fallback of [false, true])
  scenario(
    `21 canceled real ${fallback ? "password proof" : "verification"} preserves successor SPA continuation`,
    async (input) => {
      const { mail, challengeId } = await register(input);
      await input.page.getByLabel("6-digit verification code").fill(mail.code);
      if (fallback) {
        await input.page.context().clearCookies();
        await input.page
          .getByRole("button", { name: "Verify", exact: true })
          .click();
        await expect(
          input.page.getByRole("button", {
            name: "Confirm password",
            exact: true,
          }),
        ).toBeVisible();
        await input.page
          .getByLabel("Password", { exact: true })
          .fill(input.password);
      }
      const delayed = input.delayedResponse();
      const counts = { proof: 0, verification: 0 };
      input.page.on("request", (request) => {
        if (request.method() !== "POST") return;
        if (request.url().endsWith("/auth/verification-password-proof"))
          counts.proof += 1;
        if (request.url().endsWith("/auth/verify-email-code"))
          counts.verification += 1;
      });
      const successorEmail = `t02a-${randomUUID()}@example.invalid`;
      input.harness.mailbox.allowAccount(successorEmail);
      await input.page.route(
        `**/api/v1/auth/${fallback ? "verification-password-proof" : "verify-email-code"}`,
        delayed.handle,
      );
      try {
        await input.page
          .getByRole("button", {
            name: fallback ? "Confirm password" : "Verify",
            exact: true,
          })
          .click();
        expect(await delayed.status()).toBe(fallback ? 202 : 200);
        const original = await input.harness.prisma.user.findUniqueOrThrow({
          where: { email: input.email },
          select: { emailVerifiedAt: true },
        });
        const challenge =
          await input.harness.prisma.emailVerificationChallenge.findUniqueOrThrow(
            {
              where: { id: challengeId },
              select: {
                consumedAt: true,
                replacedAt: true,
                revokedAt: true,
                failedOtpAttempts: true,
              },
            },
          );
        expect(original.emailVerifiedAt === null).toBe(fallback);
        expect(challenge.consumedAt === null).toBe(fallback);
        expect(challenge.replacedAt).toBeNull();
        expect(challenge.revokedAt).toBeNull();
        expect(challenge.failedOtpAttempts).toBe(0);
        await registerSuccessor(input, successorEmail);
        const successorContinuation = await input.page.evaluate(
          (key) => sessionStorage.getItem(key),
          continuationKey,
        );
        const successorChallenge =
          await input.harness.prisma.emailVerificationChallenge.findFirstOrThrow(
            {
              where: {
                user: { email: successorEmail },
                consumedAt: null,
                replacedAt: null,
                revokedAt: null,
              },
              select: { id: true },
            },
          );
        await assertSuccessorOtpUi(
          input.page,
          {
            email: successorEmail,
            continuation: successorContinuation,
            url: `${origin}/verify-email`,
          },
          async () => {
            delayed.release();
            expect(await delayed.finish()).toEqual({
              backendStatus: fallback ? 202 : 200,
              browserOutcome: "canceled",
            });
            await input.page.unrouteAll({ behavior: "wait" });
          },
        );
        expect(
          await input.page.evaluate(
            (key) =>
              JSON.parse(sessionStorage.getItem(key) ?? "null").canonicalEmail,
            continuationKey,
          ),
        ).toBe(successorEmail);
        expect(
          await input.page.evaluate(
            (key) => sessionStorage.getItem(key),
            continuationKey,
          ),
        ).toBe(successorContinuation);
        expect(counts).toEqual({
          proof: fallback ? 1 : 0,
          verification: fallback ? 0 : 1,
        });
        expect(
          await input.harness.prisma.emailVerificationChallenge.findUniqueOrThrow(
            {
              where: { id: successorChallenge.id },
              select: {
                consumedAt: true,
                replacedAt: true,
                revokedAt: true,
                failedOtpAttempts: true,
              },
            },
          ),
        ).toMatchObject({
          consumedAt: null,
          replacedAt: null,
          revokedAt: null,
          failedOtpAttempts: 0,
        });
        expect(
          await input.harness.prisma.emailVerificationChallenge.findUniqueOrThrow(
            {
              where: { id: challengeId },
              select: {
                consumedAt: true,
                replacedAt: true,
                revokedAt: true,
                failedOtpAttempts: true,
              },
            },
          ),
        ).toEqual(challenge);
        expect(
          await input.harness.prisma.user.findUniqueOrThrow({
            where: { email: input.email },
            select: { emailVerifiedAt: true },
          }),
        ).toEqual(original);
        expect(
          await input.harness.prisma.session.count({
            where: { user: { email: { in: [input.email, successorEmail] } } },
          }),
        ).toBe(0);
        await expect(
          input.page.getByLabel("6-digit verification code"),
        ).toBeVisible();
        expect(
          (
            await input.harness.prisma.user.findUniqueOrThrow({
              where: { email: successorEmail },
              select: { emailVerifiedAt: true },
            })
          ).emailVerifiedAt,
        ).toBeNull();
      } finally {
        delayed.release();
        try {
          await input.page.unrouteAll({ behavior: "wait" });
        } finally {
          input.harness.mailbox.releaseAccount(successorEmail);
        }
      }
    },
  );

scenario(
  "17 concurrent OTP and link consumption yield exactly one success",
  async (input) => {
    const { mail, challengeId } = await register(input);
    const outcomes = await Promise.all([
      submitCode(input, challengeId, mail.code),
      post(input.page, "auth/verify-email", { token: linkToken(mail.url) }),
    ]);
    const [otpOutcome, linkOutcome] = outcomes;
    if (otpOutcome.status === 200) {
      // OTP won the user lock: the link can only report already verified.
      expect(otpOutcome.data).toMatchObject({ data: { status: "verified" } });
      expect(linkOutcome.status).toBe(200);
      expect(linkOutcome.data).toMatchObject({
        data: { status: "already_verified" },
      });
    } else {
      // Link won the user lock: the losing OTP is terminal and invalid.
      expect(otpOutcome.status).toBe(400);
      expect(otpOutcome.data).toMatchObject({
        error: { code: "INVALID_VERIFICATION_CODE" },
      });
      expect(linkOutcome.status).toBe(200);
      expect(linkOutcome.data).toMatchObject({ data: { status: "verified" } });
    }
    const challenge =
      await input.harness.prisma.emailVerificationChallenge.findUniqueOrThrow({
        where: { id: challengeId },
        select: { consumedAt: true },
      });
    expect(challenge.consumedAt !== null).toBe(true);
    await noAuthority(input);
  },
);

scenario(
  "18 verified login rotates session and logout revokes protected access",
  async (input) => {
    const { mail } = await register(input);
    await verifyCode(input, mail.code);
    expect(await login(input)).toBe(200);
    const before = (await input.page.context().cookies()).find(
      (c) => c.name === "stockwise_session",
    );
    expect(
      (
        await post(input.page, "auth/login", {
          email: input.email,
          password: input.password,
        })
      ).status,
    ).toBe(200);
    const after = (await input.page.context().cookies()).find(
      (c) => c.name === "stockwise_session",
    );
    expect(!!before && !!after && before.value !== after.value).toBe(true);
    if (!after) throw new Error("Private session credential unavailable.");
    const sessionId = await input.harness.prisma.session.findUniqueOrThrow({
      where: { tokenHash: hashSessionToken(after.value) },
      select: { id: true, revokedAt: true },
    });
    expect(sessionId.revokedAt).toBeNull();
    expect(
      await input.harness.prisma.session.count({
        where: { user: { email: input.email }, revokedAt: null },
      }),
    ).toBe(1);
    expect((await post(input.page, "auth/logout", {})).status).toBe(204);
    expect(
      (
        await input.harness.prisma.session.findUniqueOrThrow({
          where: { id: sessionId.id },
          select: { revokedAt: true },
        })
      ).revokedAt !== null,
    ).toBe(true);
    expect(
      await input.harness.prisma.session.count({
        where: { user: { email: input.email }, revokedAt: null },
      }),
    ).toBe(0);
    const replay = await input.page
      .context()
      .browser()!
      .newContext({ baseURL: origin });
    try {
      await replay.addCookies([after]);
      expect(
        (
          await replay.request.get(`${origin}/api/v1/me/access-context`)
        ).status(),
      ).toBe(401);
    } finally {
      await replay.close();
    }
    expect(
      await input.page.evaluate(
        async () => (await fetch("/api/v1/me/access-context")).status,
      ),
    ).toBe(401);
    expect(
      (await input.page.context().cookies()).some(
        (c) => c.name === "stockwise_session" || c.name === proofName,
      ),
    ).toBe(false);
  },
);

scenario(
  "19 duplicate verified registration remains generic and cannot grant authority",
  async (input) => {
    const { mail } = await register(input);
    await verifyCode(input, mail.code);
    const response = await post(input.page, "auth/register", {
      email: input.email,
      password: input.password,
    });
    expect(response.status).toBe(202);
    expect(response.data).toMatchObject({
      data: {
        status: "accepted",
        nextStep: "verify_email",
        verification: { challengeId: expect.any(String) },
      },
    });
    await expect(input.harness.mailbox.next(input.email, 25)).rejects.toThrow(
      "Private verification delivery unavailable.",
    );
    await noAuthority(input);
  },
);

scenario(
  "20 invalid mailbox precedes proof-required error and correct mailbox never increments attempts",
  async (input) => {
    const { mail, challengeId } = await register(input);
    await input.page.context().clearCookies();
    const wrong = mail.code === "000000" ? "000001" : "000000";
    expect((await submitCode(input, challengeId, wrong)).status).toBe(400);
    expect((await submitCode(input, challengeId, mail.code)).status).toBe(401);
    expect(
      (
        await post(input.page, "auth/verify-email", {
          token: linkToken(mail.url),
        })
      ).status,
    ).toBe(401);
    assertMailboxOnlyTerminalState(
      await input.harness.prisma.emailVerificationChallenge.findUniqueOrThrow({
        where: { id: challengeId },
        select: { failedOtpAttempts: true, consumedAt: true },
      }),
      await input.harness.prisma.user.findUniqueOrThrow({
        where: { email: input.email },
        select: { emailVerifiedAt: true },
      }),
      await input.harness.prisma.session.count({
        where: { user: { email: input.email } },
      }),
    );
    await noAuthority(input);
  },
);
