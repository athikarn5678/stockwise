// @vitest-environment jsdom

import { LanguageProvider, useLanguage } from "@/providers/language-provider";
import { en } from "@/i18n/en";
import { th } from "@/i18n/th";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AuthApiError,
  completeFirstOrganizationOnboarding,
  forgotPassword,
  login,
  logout,
  register,
  resetPassword,
} from "@/api-client";
import type { LoginResult } from "@/api-client";
import {
  clearContinuation,
  saveContinuation,
} from "@/verification-continuation-browser";

import {
  clearInvitationRecoveryRequired,
  releaseInvitationFlowLock,
} from "@/invitation-continuation";
import { passwordValidationMessage } from "./auth-form-support";
import { EmailRequestForm } from "./email-request-form";
import { LoginForm } from "./login-form";
import { LogoutButton } from "./logout-button";
import { OnboardingForm } from "./onboarding-form";
import { RegistrationForm } from "./registration-form";
import { ResetPasswordForm } from "./reset-password-form";

const { routerPush, routerReplace } = vi.hoisted(() => ({
  routerPush: vi.fn(),
  routerReplace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: routerReplace }),
}));

vi.mock("@/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api-client")>();
  return {
    ...actual,
    forgotPassword: vi.fn(),
    completeFirstOrganizationOnboarding: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    register: vi.fn(),
    resetPassword: vi.fn(),
  };
});

afterEach(() => {
  cleanup();
  routerPush.mockReset();
  routerReplace.mockReset();
  vi.mocked(forgotPassword).mockReset();
  vi.mocked(completeFirstOrganizationOnboarding).mockReset();
  vi.mocked(login).mockReset();
  vi.mocked(logout).mockReset();
  vi.mocked(register).mockReset();
  vi.mocked(resetPassword).mockReset();
  window.history.replaceState(null, "", "/");
  delete (window as Window & { __stockwiseTakeCredentialLink?: unknown })
    .__stockwiseTakeCredentialLink;
  sessionStorage.clear();
  clearInvitationRecoveryRequired();
  releaseInvitationFlowLock();
});

function fillCredentials(password = "  password with Unicode Ω  ") {
  fireEvent.change(screen.getByLabelText("Email address"), {
    target: { value: "person@example.com" },
  });
  fireEvent.change(screen.getByLabelText("Password"), {
    target: { value: password },
  });
  const confirmation = screen.queryByLabelText("Confirm password");
  if (confirmation)
    fireEvent.change(confirmation, { target: { value: password } });
}

function renderWithQueryClient(ui: ReactNode, queryClient = new QueryClient()) {
  render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
  return queryClient;
}

describe("registration form", () => {
  it.each(["en", "th"] as const)(
    "validates touched confirmation inline on blur and subsequent edits in %s",
    (language) => {
      localStorage.setItem("stockwise.language", language);
      const copy = language === "th" ? th : en;
      render(
        <LanguageProvider>
          <RegistrationForm />
        </LanguageProvider>,
      );
      const password = screen.getByLabelText(copy.authPassword);
      const confirmation = screen.getByLabelText(copy.authConfirmPassword);
      fireEvent.change(password, {
        target: { value: "a sufficiently long password" },
      });
      fireEvent.change(confirmation, { target: { value: "different" } });
      expect(screen.queryByRole("alert")).toBeNull();
      expect(confirmation.getAttribute("aria-invalid")).toBe("false");
      fireEvent.blur(confirmation);
      const message = screen.getByRole("alert");
      expect(message.textContent).toBe(copy.authPasswordMismatch);
      expect(confirmation.nextElementSibling).toBe(message);
      expect(message.classList.contains("text-destructive")).toBe(true);
      expect(confirmation.getAttribute("aria-invalid")).toBe("true");
      expect(confirmation.getAttribute("aria-describedby")).toBe(message.id);
      fireEvent.change(confirmation, {
        target: { value: "a sufficiently long password" },
      });
      expect(screen.queryByRole("alert")).toBeNull();
      expect(confirmation.getAttribute("aria-invalid")).toBe("false");
      fireEvent.change(password, {
        target: { value: "an updated long password" },
      });
      expect(screen.getByRole("alert").textContent).toBe(
        copy.authPasswordMismatch,
      );
      fireEvent.change(confirmation, { target: { value: "" } });
      expect(screen.getByRole("alert").textContent).toBe(
        copy.authConfirmPasswordRequired,
      );
      expect(register).not.toHaveBeenCalled();
      localStorage.clear();
    },
  );
  it.each(["en", "th"] as const)(
    "requires exact password confirmation and preserves the OTP request in %s",
    async (language) => {
      localStorage.setItem("stockwise.language", language);
      const copy = language === "th" ? th : en;
      vi.mocked(register).mockResolvedValue({
        data: {
          status: "accepted",
          nextStep: "verify_email",
          verification: { challengeId: "11111111-1111-4111-8111-111111111111" },
        },
      });
      render(
        <LanguageProvider>
          <TestLanguageToggle />
          <RegistrationForm />
        </LanguageProvider>,
      );
      const password = "  password with Unicode Ω  ";
      const input = screen.getByLabelText(copy.authPassword);
      const confirmation = screen.getByLabelText(copy.authConfirmPassword);
      expect(input.hasAttribute("required")).toBe(true);
      expect(confirmation.hasAttribute("required")).toBe(true);
      expect(confirmation.getAttribute("type")).toBe("password");
      fireEvent.change(screen.getByLabelText(copy.authEmail), {
        target: { value: "person@example.com" },
      });
      fireEvent.change(input, { target: { value: password } });
      const form = screen
        .getByRole("button", { name: copy.authCreateAccount })
        .closest("form")!;
      fireEvent.submit(form);
      expect((await screen.findByRole("alert")).textContent).toBe(
        copy.authConfirmPasswordRequired,
      );
      expect(register).not.toHaveBeenCalled();
      fireEvent.change(confirmation, { target: { value: password.trim() } });
      fireEvent.submit(form);
      expect((await screen.findByRole("alert")).textContent).toBe(
        copy.authPasswordMismatch,
      );
      expect(register).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Switch language" }));
      expect(screen.getByRole("alert").textContent).toBe(
        (language === "th" ? en : th).authPasswordMismatch,
      );
      fireEvent.change(confirmation, { target: { value: password } });
      fireEvent.change(input, { target: { value: password + "!" } });
      fireEvent.submit(form);
      expect(screen.getByRole("alert").textContent).toBe(
        (language === "th" ? en : th).authPasswordMismatch,
      );
      expect(register).not.toHaveBeenCalled();
      fireEvent.change(input, { target: { value: password } });
      fireEvent.submit(form);
      await waitFor(() =>
        expect(register).toHaveBeenCalledExactlyOnceWith({
          email: "person@example.com",
          password,
        }),
      );
      await waitFor(() =>
        expect(routerReplace).toHaveBeenCalledWith("/verify-email"),
      );
      expect((input as HTMLInputElement).value).toBe("");
      expect((confirmation as HTMLInputElement).value).toBe("");
      localStorage.clear();
    },
  );
  it("goes directly to OTP verification after the privacy-neutral accepted response", async () => {
    vi.mocked(register).mockResolvedValue({
      data: {
        nextStep: "verify_email",
        status: "accepted",
        verification: { challengeId: "11111111-1111-4111-8111-111111111111" },
      },
    });
    render(<RegistrationForm />);
    fillCredentials();

    fireEvent.submit(
      screen.getByRole("button", { name: "Create account" }).closest("form")!,
    );

    await waitFor(() =>
      expect(register).toHaveBeenCalledWith({
        email: "person@example.com",
        password: "  password with Unicode Ω  ",
      }),
    );
    await waitFor(() =>
      expect(routerReplace).toHaveBeenCalledWith("/verify-email"),
    );
    expect(screen.queryByRole("status")).toBeNull();
    expect(
      screen.queryByRole("link", { name: "Continue verification" }),
    ).toBeNull();
    const saved = JSON.parse(
      sessionStorage.getItem("stockwise_verification_continuation") ?? "{}",
    );
    expect(saved).toEqual({
      version: 1,
      canonicalEmail: "person@example.com",
      challengeId: "11111111-1111-4111-8111-111111111111",
      savedAt: expect.any(Number),
    });
    expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe(
      "",
    );
    expect(routerReplace).not.toHaveBeenCalledWith("/app");
    expect(routerPush).not.toHaveBeenCalled();
  });

  it.each(["unmount", "pagehide", "superseded"])(
    "does not persist a late accepted result after %s",
    async (exit) => {
      const deferred = Promise.withResolvers<{
        data: {
          status: "accepted";
          nextStep: "verify_email";
          verification: { challengeId: string };
        };
      }>();
      vi.mocked(register).mockReturnValue(deferred.promise);
      const view = render(<RegistrationForm />);
      fillCredentials();
      const form = screen
        .getByRole("button", { name: "Create account" })
        .closest("form")!;
      fireEvent.submit(form);
      fireEvent.submit(form);
      expect(register).toHaveBeenCalledTimes(1);
      if (exit === "unmount") view.unmount();
      else if (exit === "pagehide") fireEvent(window, new Event("pagehide"));
      else {
        clearContinuation();
        saveContinuation({
          version: 1,
          canonicalEmail: "successor@example.test",
          challengeId: "22222222-2222-4222-8222-222222222222",
          savedAt: Date.now(),
        });
      }
      const before = sessionStorage.getItem(
        "stockwise_verification_continuation",
      );
      await act(async () =>
        deferred.resolve({
          data: {
            status: "accepted",
            nextStep: "verify_email",
            verification: {
              challengeId: "11111111-1111-4111-8111-111111111111",
            },
          },
        }),
      );
      expect(
        sessionStorage.getItem("stockwise_verification_continuation"),
      ).toBe(before);
      expect(screen.queryByRole("status")).toBeNull();
      expect(routerReplace).not.toHaveBeenCalled();
    },
  );

  it("ignores a late registration error after leaving without replacing successor state", async () => {
    const deferred = Promise.withResolvers<{
      data: {
        status: "accepted";
        nextStep: "verify_email";
        verification: { challengeId: string };
      };
    }>();
    vi.mocked(register).mockReturnValue(deferred.promise);
    const view = render(<RegistrationForm />);
    fillCredentials();
    fireEvent.submit(
      screen.getByRole("button", { name: "Create account" }).closest("form")!,
    );
    view.unmount();
    await act(async () => deferred.reject(new AuthApiError("unavailable")));
    expect(
      sessionStorage.getItem("stockwise_verification_continuation"),
    ).toBeNull();
    expect(routerReplace).not.toHaveBeenCalled();
  });

  it("allows a fresh submission after document restoration without accepting the abandoned result", async () => {
    const abandoned = Promise.withResolvers<{
      data: {
        status: "accepted";
        nextStep: "verify_email";
        verification: { challengeId: string };
      };
    }>();
    vi.mocked(register)
      .mockReturnValueOnce(abandoned.promise)
      .mockResolvedValueOnce({
        data: {
          status: "accepted",
          nextStep: "verify_email",
          verification: { challengeId: "22222222-2222-4222-8222-222222222222" },
        },
      });
    render(<RegistrationForm />);
    fillCredentials();
    fireEvent.submit(
      screen.getByRole("button", { name: "Create account" }).closest("form")!,
    );
    fireEvent(window, new Event("pagehide"));
    fireEvent(window, new Event("pageshow"));
    const submit = screen.getByRole("button", { name: "Create account" });
    expect(submit.hasAttribute("disabled")).toBe(false);
    fireEvent.submit(submit.closest("form")!);
    await waitFor(() =>
      expect(routerReplace).toHaveBeenCalledWith("/verify-email"),
    );
    await act(async () =>
      abandoned.resolve({
        data: {
          status: "accepted",
          nextStep: "verify_email",
          verification: { challengeId: "11111111-1111-4111-8111-111111111111" },
        },
      }),
    );
    expect(
      JSON.parse(sessionStorage.getItem("stockwise_verification_continuation")!)
        .challengeId,
    ).toBe("22222222-2222-4222-8222-222222222222");
  });

  it("shows client validation and rate limit feedback without submitting invalid input", async () => {
    render(<RegistrationForm />);
    fireEvent.submit(
      screen.getByRole("button", { name: "Create account" }).closest("form")!,
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Enter a valid email address.",
    );
    expect(register).not.toHaveBeenCalled();

    cleanup();
    vi.mocked(register).mockRejectedValue(new AuthApiError("rate_limited", 60));
    render(<RegistrationForm />);
    fillCredentials();
    fireEvent.submit(
      screen.getByRole("button", { name: "Create account" }).closest("form")!,
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Please wait 60 seconds before trying again.",
    );
  });
});

describe("login form", () => {
  it.each(["unmount", "pagehide"])(
    "ignores a pending-login continuation after %s",
    async (leave) => {
      const pending = Promise.withResolvers<LoginResult>();
      vi.mocked(login).mockReturnValue(pending.promise);
      renderWithQueryClient(<LoginForm />);
      fillCredentials();
      fireEvent.submit(
        screen.getByRole("button", { name: "Sign in" }).closest("form")!,
      );
      if (leave === "unmount") cleanup();
      else
        act(() =>
          window.dispatchEvent(
            new PageTransitionEvent("pagehide", { persisted: true }),
          ),
        );
      await act(async () =>
        pending.resolve({
          outcome: "verification_required",
          status: "verification_required",
          nextStep: "verify_email",
          verification: { challengeId: null },
        }),
      );
      expect(
        sessionStorage.getItem("stockwise_verification_continuation"),
      ).toBeNull();
      expect(routerReplace).not.toHaveBeenCalled();
    },
  );
  function renderLoginForm(queryClient = new QueryClient()) {
    return renderWithQueryClient(<LoginForm />, queryClient);
  }

  it("submits exact credentials, prevents a duplicate pending submission, and enters the access-context flow", async () => {
    let resolveLogin: (() => void) | undefined;
    vi.mocked(login).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLogin = () =>
            resolve({
              outcome: "authenticated",
              user: {
                displayName: null,
                email: "person@example.com",
                id: "user-id",
              },
            });
        }),
    );
    const queryClient = renderLoginForm();
    queryClient.setQueryData(["access-context"], {
      organizations: [],
      user: { displayName: null, email: "previous@example.com", id: "old" },
    });
    fillCredentials();

    const form = screen
      .getByRole("button", { name: "Sign in" })
      .closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);

    expect(login).toHaveBeenCalledTimes(1);
    expect(
      screen
        .getByRole("button", { name: "Signing in…" })
        .hasAttribute("disabled"),
    ).toBe(true);
    resolveLogin?.();
    await waitFor(() => expect(routerReplace).toHaveBeenCalledWith("/app"));
    expect(routerPush).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(["access-context"])).toBeUndefined();
  });

  it("routes an expired invitation login to safe invitation recovery instead of onboarding", async () => {
    sessionStorage.setItem(
      "stockwise_invitation_continuation",
      JSON.stringify({
        version: 1,
        flowId: "E".repeat(43),
        expiresAt: new Date(Date.now() - 1).toISOString(),
      }),
    );
    vi.mocked(login).mockResolvedValue({
      outcome: "authenticated",
      user: { displayName: null, email: "person@example.com", id: "user-id" },
    });
    renderLoginForm();
    fillCredentials();
    fireEvent.submit(
      screen.getByRole("button", { name: "Sign in" }).closest("form")!,
    );
    await waitFor(() =>
      expect(routerReplace).toHaveBeenCalledWith("/accept-invitation"),
    );
    expect(login).toHaveBeenCalledWith(
      expect.objectContaining({ email: "person@example.com" }),
    );
    expect(
      sessionStorage.getItem("stockwise_invitation_continuation"),
    ).toBeNull();
  });
  it("shows generic invalid credentials and rate-limit states", async () => {
    vi.mocked(login).mockRejectedValue(new AuthApiError("invalid_credentials"));
    renderLoginForm();
    fillCredentials();
    fireEvent.submit(
      screen.getByRole("button", { name: "Sign in" }).closest("form")!,
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "The email or password is incorrect.",
    );

    cleanup();
    vi.mocked(login).mockRejectedValue(new AuthApiError("rate_limited", 15));
    renderLoginForm();
    fillCredentials();
    fireEvent.submit(
      screen.getByRole("button", { name: "Sign in" }).closest("form")!,
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Please wait 15 seconds before trying again.",
    );
  });
});

describe("first organization onboarding form", () => {
  function renderOnboardingForm(queryClient = new QueryClient()) {
    return renderWithQueryClient(<OnboardingForm />, queryClient);
  }

  function fillOnboarding() {
    fireEvent.change(screen.getByLabelText("Display name"), {
      target: { value: "  Owner  Name  " },
    });
    fireEvent.change(screen.getByLabelText("Organization name"), {
      target: { value: "  Example  Store  " },
    });
    fireEvent.change(screen.getByLabelText("First branch name"), {
      target: { value: "  Main  Branch  " },
    });
  }

  it("renders exactly the accepted fields, submits no actor or branch code, and prevents duplicate submission", async () => {
    let resolveOnboarding: (() => void) | undefined;
    vi.mocked(completeFirstOrganizationOnboarding).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveOnboarding = () =>
            resolve({
              data: {
                branch: {
                  address: null,
                  code: "MAIN",
                  id: "branch-id",
                  name: "Main  Branch",
                  phone: null,
                },
                nextStep: "app",
                organization: {
                  id: "organization-id",
                  name: "Example  Store",
                },
                role: "OWNER",
                user: {
                  displayName: "Owner  Name",
                  id: "user-id",
                  phone: null,
                },
              },
            });
        }),
    );
    const queryClient = renderOnboardingForm();
    queryClient.setQueryData(["access-context"], {
      firstOrganizationOnboarding: { eligible: true },
      organizations: [],
      user: { displayName: null, email: "person@example.com", id: "user-id" },
    });
    fillOnboarding();

    expect(screen.queryByLabelText(/branch code/i)).toBeNull();
    expect(screen.queryByLabelText(/user id|organization id|role/i)).toBeNull();
    const form = screen
      .getByRole("button", { name: "Create organization" })
      .closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);

    expect(completeFirstOrganizationOnboarding).toHaveBeenCalledTimes(1);
    expect(completeFirstOrganizationOnboarding).toHaveBeenCalledWith({
      branchAddress: "",
      branchName: "  Main  Branch  ",
      branchPhone: "",
      displayName: "  Owner  Name  ",
      organizationName: "  Example  Store  ",
      phone: "",
    });
    expect(
      screen
        .getByRole("button", { name: "Creating organization…" })
        .hasAttribute("disabled"),
    ).toBe(true);
    resolveOnboarding?.();
    await waitFor(() => expect(routerReplace).toHaveBeenCalledWith("/app"));
    expect(routerPush).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(["access-context"])).toBeUndefined();
  });

  it("blocks whitespace-only required values and presents both safe conflict states", async () => {
    renderOnboardingForm();
    fireEvent.submit(
      screen
        .getByRole("button", { name: "Create organization" })
        .closest("form")!,
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Enter a display name, organization name, and branch name.",
    );
    expect(completeFirstOrganizationOnboarding).not.toHaveBeenCalled();

    cleanup();
    vi.mocked(completeFirstOrganizationOnboarding).mockRejectedValue(
      new AuthApiError("already_onboarded"),
    );
    renderOnboardingForm();
    fillOnboarding();
    fireEvent.submit(
      screen
        .getByRole("button", { name: "Create organization" })
        .closest("form")!,
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "already completed",
    );

    cleanup();
    vi.mocked(completeFirstOrganizationOnboarding).mockRejectedValue(
      new AuthApiError("already_has_organization_access"),
    );
    renderOnboardingForm();
    fillOnboarding();
    fireEvent.submit(
      screen
        .getByRole("button", { name: "Create organization" })
        .closest("form")!,
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "already has organization access",
    );
  });
});

describe("password recovery and logout", () => {
  it("clears all private cache only after confirmed logout", async () => {
    vi.mocked(logout).mockRejectedValueOnce(new AuthApiError("unavailable"));
    const client = renderWithQueryClient(<LogoutButton />);
    client.setQueryData(["sales"], "private receipt");
    fireEvent.click(screen.getByRole("button", { name: "Log out" }));
    await screen.findByRole("alert");
    expect(client.getQueryData(["sales"])).toBe("private receipt");
    expect(routerReplace).not.toHaveBeenCalled();
    vi.mocked(logout).mockResolvedValueOnce(undefined);
    fireEvent.click(screen.getByRole("button", { name: "Log out" }));
    await waitFor(() => expect(routerReplace).toHaveBeenCalledWith("/login"));
    expect(client.getQueryData(["sales"])).toBeUndefined();
  });
  it("keeps forgot-password completion non-disclosing and handles rate limits", async () => {
    vi.mocked(forgotPassword).mockResolvedValue({
      data: { status: "accepted" },
    });
    render(<EmailRequestForm kind="password_reset" />);
    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "person@example.com" },
    });
    fireEvent.submit(
      screen
        .getByRole("button", { name: "Request password reset" })
        .closest("form")!,
    );
    expect(
      await screen.findByText(/If that email can receive a password reset/),
    ).toBeTruthy();

    cleanup();
    vi.mocked(forgotPassword).mockRejectedValue(
      new AuthApiError("rate_limited", 20),
    );
    render(<EmailRequestForm kind="password_reset" />);
    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "person@example.com" },
    });
    fireEvent.submit(
      screen
        .getByRole("button", { name: "Request password reset" })
        .closest("form")!,
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Please wait 20 seconds before trying again.",
    );
  });

  it("enforces the exact password length UX and submits an unchanged Unicode password with the query token", async () => {
    expect(passwordValidationMessage("a".repeat(14))).not.toBeNull();
    expect(passwordValidationMessage("a".repeat(15))).toBeNull();
    expect(passwordValidationMessage("a".repeat(128))).toBeNull();
    expect(passwordValidationMessage("a".repeat(129))).not.toBeNull();
    expect(passwordValidationMessage("😀".repeat(15))).toBeNull();

    Object.defineProperty(window, "__stockwiseTakeCredentialLink", {
      configurable: true,
      value: vi.fn(() => ({
        route: "/reset-password",
        token: "opaque-reset-token",
      })),
    });
    vi.mocked(resetPassword).mockResolvedValue({
      data: { status: "password_reset" },
    });
    render(<ResetPasswordForm />);
    const password = "  รหัสผ่านสำหรับทดสอบ 😀  ";
    fireEvent.change(screen.getByLabelText("New password"), {
      target: { value: password },
    });
    fireEvent.submit(
      screen.getByRole("button", { name: "Reset password" }).closest("form")!,
    );

    await waitFor(() =>
      expect(resetPassword).toHaveBeenCalledWith({
        newPassword: password,
        token: "opaque-reset-token",
      }),
    );
    expect(window.location.search).toBe("");
    expect(
      await screen.findByText(
        "Your password has been reset. Sign in with your new password.",
      ),
    ).toBeTruthy();
  });

  it("calls the current-session logout endpoint and leaves cookie handling to the API", async () => {
    vi.mocked(logout).mockResolvedValue(undefined);
    const queryClient = renderWithQueryClient(<LogoutButton />);
    queryClient.setQueryData(["access-context"], {
      organizations: [],
      user: { displayName: null, email: "person@example.com", id: "user-id" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Log out" }));
    await waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
    expect(routerReplace).toHaveBeenCalledWith("/login");
    expect(routerPush).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(["access-context"])).toBeUndefined();
  });
});

function TestLanguageToggle() {
  const { language, setLanguage } = useLanguage();
  return (
    <button onClick={() => setLanguage(language === "en" ? "th" : "en")}>
      Switch language
    </button>
  );
}

it("retranslates an existing login validation message", async () => {
  localStorage.clear();
  renderWithQueryClient(
    <LanguageProvider>
      <TestLanguageToggle />
      <LoginForm />
    </LanguageProvider>,
  );
  fireEvent.submit(
    screen.getByRole("button", { name: en.authSignIn }).closest("form")!,
  );
  expect(await screen.findByText(en.authInvalidEmail)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Switch language" }));
  expect(screen.getByText(th.authInvalidEmail)).toBeTruthy();
  expect(login).not.toHaveBeenCalled();
  localStorage.clear();
});
