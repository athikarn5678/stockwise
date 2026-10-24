import { randomBytes } from "node:crypto";
import {
  expect,
  register,
  test,
  verifyByCode,
  type Scenario,
} from "./fixtures";

async function withSanitizedFailure(
  input: Scenario,
  stage: string,
  body: () => Promise<void>,
) {
  input.stage = stage;
  // Retain only a source line, never assertion values or browser error text.
  const failedAt = await body().then(
    () => null,
    (error: unknown) =>
      error instanceof Error
        ? (error.stack?.match(/accessibility\.spec\.ts:(\d+):\d+/)?.[1] ??
          "unknown")
        : "unknown",
  );
  if (failedAt !== null)
    throw new Error(`D4N3_STAGE:a11y-${input.stage}-line-${failedAt}`);
}

async function setLanguage(input: Scenario, language: "en" | "th") {
  await input.page.goto("/register");
  await expect(
    input.page.getByLabel("Email address", { exact: true }),
  ).toBeVisible();
  if (language === "th") {
    await input.page
      .getByRole("button", { name: "Language", exact: true })
      .press("Enter");
  }
}

test("a11y Thai registration and OTP support labelled keyboard submission", async ({
  scenario: input,
}) => {
  await withSanitizedFailure(input, "registration", async () => {
    await setLanguage(input, "th");
    const email = input.page.getByLabel("อีเมล", { exact: true });
    const password = input.page.getByLabel("รหัสผ่าน", { exact: true });
    const submit = input.page.getByRole("button", {
      name: "สร้างบัญชี",
      exact: true,
    });
    expect(await email.getAttribute("id")).toBe("registration-email");
    expect(await password.getAttribute("id")).toBe("registration-password");
    await email.focus();
    await input.page.keyboard.press("Tab");
    await expect(password).toBeFocused();
    await input.page.keyboard.press("Tab");
    await expect(submit).toBeFocused();
    await email.fill(input.email);
    await password.fill(input.password);
    const response = input.page.waitForResponse(
      (r) =>
        r.url().endsWith("/auth/register") && r.request().method() === "POST",
    );
    await submit.press("Enter");
    expect((await response).status()).toBe(202);
    const message = await input.harness.mailbox.next(input.email);
    if (message.kind !== "verification") throw new Error("mail-kind");
    const code = input.page.getByLabel("รหัสยืนยัน 6 หลัก", { exact: true });
    await expect(code).toBeVisible();
    const describedBy =
      (await code.getAttribute("aria-describedby"))?.split(/\s+/) ?? [];
    expect(describedBy).toContain("verification-safety");
    for (const id of describedBy) {
      await expect(input.page.locator(`#${id}`)).toHaveCount(1);
    }
    await code.fill("123");
    await code.press("Enter");
    const invalidCode = input.page.getByRole("main").getByRole("alert");
    await expect(invalidCode).toContainText("กรุณากรอกรหัส 6 หลัก");
    await expect(invalidCode).toBeFocused();
    await expect(code).toHaveAttribute(
      "aria-describedby",
      "verification-error verification-safety",
    );
    await code.fill(message.code);
    const verify = input.page.getByRole("button", {
      name: "ยืนยัน",
      exact: true,
    });
    const verificationResponse = input.page.waitForResponse(
      (r) =>
        r.url().endsWith("/auth/verify-email-code") &&
        r.request().method() === "POST",
    );
    await code.press("Enter");
    expect((await verificationResponse).status()).toBe(200);
    const status = input.page.getByRole("status");
    await expect(status).toContainText(
      "ยืนยันอีเมลเรียบร้อยแล้ว คุณสามารถเข้าสู่ระบบได้",
    );
    await expect(status).toBeFocused();
    await expect(
      input.page
        .getByRole("main")
        .getByRole("link", { name: "เข้าสู่ระบบ", exact: true }),
    ).toBeVisible();
    await expect(verify).toHaveCount(0);
  });
});

test("a11y English registration errors associate fields and move focus to feedback", async ({
  scenario: input,
}) => {
  await withSanitizedFailure(input, "registration-error", async () => {
    await setLanguage(input, "en");
    await input.page.goto("/register");
    const email = input.page.getByLabel("Email address", { exact: true });
    const password = input.page.getByLabel("Password", { exact: true });
    await expect(email).toHaveAttribute("id", "registration-email");
    await expect(password).toHaveAttribute("id", "registration-password");
    await email.fill("invalid-email");
    await password.fill(input.password);
    await password.press("Enter");
    const alert = input.page.getByRole("main").getByRole("alert");
    await expect(alert).toContainText("Enter a valid email address.");
    await expect(alert).toBeFocused();
    await expect(email).toHaveAttribute(
      "aria-describedby",
      "registration-error",
    );
    await expect(password).toHaveAttribute(
      "aria-describedby",
      "registration-error",
    );
    await expect(input.page.locator("#registration-error")).toHaveCount(1);
    await expect(input.page).toHaveURL(/\/register$/);
  });
});

test("a11y English rejected login and password recovery keep keyboard feedback reachable", async ({
  scenario: input,
}) => {
  test.setTimeout(120_000);
  await withSanitizedFailure(input, "login-rejection", async () => {
    await setLanguage(input, "en");
    const registration = await register(input);
    await verifyByCode(input, registration.message.code);
    await input.page.goto("/login");
    const email = input.page.getByLabel("Email address", { exact: true });
    const password = input.page.getByLabel("Password", { exact: true });
    await expect(email).toHaveAttribute("id", "login-email");
    await expect(password).toHaveAttribute("id", "login-password");
    await email.fill(input.email);
    await password.fill(`${input.password}wrong`);
    const response = input.page.waitForResponse(
      (r) => r.url().endsWith("/auth/login") && r.request().method() === "POST",
    );
    await password.press("Enter");
    expect((await response).status()).toBe(401);
    const alert = input.page.getByRole("main").getByRole("alert");
    await expect(alert).toContainText("The email or password is incorrect.");
    await expect(alert).toBeFocused();
    await expect(email).toHaveAttribute("aria-describedby", "login-error");
    await expect(password).toHaveAttribute("aria-describedby", "login-error");

    await input.page
      .getByRole("link", { name: "Forgot password?", exact: true })
      .focus();
    await input.page.keyboard.press("Enter");
    await expect(input.page).toHaveURL(/\/forgot-password$/);
    await expect
      .poll(() =>
        input.page.evaluate(() =>
          document.querySelector("main")?.contains(document.activeElement),
        ),
      )
      .toBe(true);
    const recoveryEmail = input.page.getByLabel("Email address", {
      exact: true,
    });
    await expect(recoveryEmail).toHaveAttribute("id", "password_reset-email");
    await recoveryEmail.fill(input.email);
    await recoveryEmail.press("Enter");
    await expect(input.page.getByRole("status")).toContainText(
      "If that email can receive a password reset, check its inbox for the next step.",
    );
    await expect(input.page.getByRole("status")).toBeFocused();
    const resetMail = await input.harness.mailbox.next(input.email);
    if (resetMail.kind !== "password_reset") throw new Error("reset-mail-kind");
    const backToLogin = input.page.getByRole("link", {
      name: "Back to sign in",
      exact: true,
    });
    await backToLogin.focus();
    await input.page.keyboard.press("Enter");
    await expect(input.page).toHaveURL(/\/login$/);
    await expect
      .poll(() =>
        input.page.evaluate(() =>
          document.querySelector("main")?.contains(document.activeElement),
        ),
      )
      .toBe(true);
    await expect(
      input.page.getByLabel("Email address", { exact: true }),
    ).toBeVisible();
    input.stage = "reset-keyboard";
    await input.page.goto(resetMail.url);
    const newPassword = input.page.getByLabel("New password", { exact: true });
    await newPassword.fill("short");
    await newPassword.press("Enter");
    await expect(input.page.getByRole("main").getByRole("alert")).toBeFocused();
    await expect(newPassword).toHaveAttribute("aria-invalid", "true");
    await expect(newPassword).toHaveAttribute(
      "aria-describedby",
      "reset-password-requirements reset-password-error",
    );
    await newPassword.fill(randomBytes(24).toString("base64url"));
    await newPassword.press("Enter");
    await expect(input.page.getByRole("status")).toContainText(
      "Your password has been reset. Sign in with your new password.",
    );
    await expect(input.page.getByRole("status")).toBeFocused();
    await input.page.keyboard.press("Tab");
    await expect(
      input.page
        .getByRole("main")
        .getByRole("link", { name: "Sign in", exact: true }),
    ).toBeFocused();
  });
});

test("a11y Thai rejected login and recovery expose keyboard feedback", async ({
  scenario: input,
}) => {
  await withSanitizedFailure(input, "thai-recovery", async () => {
    await input.page.goto("/login");
    await input.page
      .getByRole("button", { name: "Language", exact: true })
      .press("Enter");
    const email = input.page.getByLabel("อีเมล", { exact: true });
    const password = input.page.getByLabel("รหัสผ่าน", { exact: true });
    await email.fill(input.email);
    await password.fill(input.password);
    const rejection = input.page.waitForResponse(
      (r) => r.url().endsWith("/auth/login") && r.request().method() === "POST",
    );
    await password.press("Enter");
    expect((await rejection).status()).toBe(401);
    const alert = input.page.getByRole("main").getByRole("alert");
    await expect(alert).toContainText("อีเมลหรือรหัสผ่านไม่ถูกต้อง");
    await expect(alert).toBeFocused();
    await expect(email).toHaveAttribute("aria-describedby", "login-error");
    await expect(password).toHaveAttribute("aria-describedby", "login-error");
    await input.page
      .getByRole("link", { name: "ลืมรหัสผ่าน?", exact: true })
      .press("Enter");
    await expect(input.page).toHaveURL(/\/forgot-password$/);
    await expect
      .poll(() =>
        input.page.evaluate(() =>
          document.querySelector("main")?.contains(document.activeElement),
        ),
      )
      .toBe(true);
    const recoveryEmail = input.page.getByLabel("อีเมล", { exact: true });
    await recoveryEmail.fill("invalid");
    await recoveryEmail.press("Enter");
    await expect(input.page.getByRole("main").getByRole("alert")).toBeFocused();
    await expect(recoveryEmail).toHaveAttribute("aria-invalid", "true");
    await expect(recoveryEmail).toHaveAttribute(
      "aria-describedby",
      "password_reset-error",
    );
    await recoveryEmail.fill(input.email);
    await recoveryEmail.press("Enter");
    await expect(input.page.getByRole("status")).toContainText(
      "หากอีเมลนี้สามารถรับลิงก์รีเซ็ตรหัสผ่านได้ กรุณาตรวจสอบกล่องจดหมายสำหรับขั้นตอนถัดไป",
    );
    await expect(input.page.getByRole("status")).toBeFocused();
    await input.page.keyboard.press("Tab");
    await expect(
      input.page.getByRole("link", { name: "กลับเข้าสู่ระบบ", exact: true }),
    ).toBeFocused();
  });
});
