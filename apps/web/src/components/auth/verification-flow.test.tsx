// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render as renderComponent,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactElement, StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuthApiError,
  login,
  register,
  resendVerification,
  verificationPasswordProof,
  verifyEmail,
  verifyEmailCode,
} from "@/api-client";
import type * as AuthApi from "@/api-client";
import { LanguageProvider } from "@/providers/language-provider";
import {
  clearContinuation,
  saveContinuation,
} from "@/verification-continuation-browser";
import { verificationLinkEntryHtml } from "@/verification-link-entry";
import { LoginForm } from "./login-form";
import { RegistrationForm } from "./registration-form";
import { VerificationForm } from "./verification-form";
import { VerificationResendForm } from "./verification-resend-form";

const { push, replace } = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace }) }));
vi.mock("@/api-client", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthApi>()),
  login: vi.fn(),
  register: vi.fn(),
  resendVerification: vi.fn(),
  verificationPasswordProof: vi.fn(),
  verifyEmail: vi.fn(),
  verifyEmailCode: vi.fn(),
}));
const challengeId = "11111111-1111-4111-8111-111111111111";
const successor = "22222222-2222-4222-8222-222222222222";
const linkToken = "a".repeat(43);
const password = "  exact Unicode password Ω  ";
const key = "stockwise_verification_continuation";
// Exercise the real pre-router capture boundary before mounting the clean page.
function render(ui: ReactElement) {
  if (new URLSearchParams(window.location.search).has("token")) {
    const script = new DOMParser()
      .parseFromString(verificationLinkEntryHtml, "text/html")
      .querySelector("script")!.textContent;
    new Function(
      "window",
      "location",
      "history",
      "addEventListener",
      "fetch",
      script,
    )(
      window,
      window.location,
      window.history,
      window.addEventListener.bind(window),
      () => Promise.withResolvers().promise,
    );
  }
  return renderComponent(ui);
}
function save(selector: string | null = challengeId) {
  saveContinuation({
    version: 1,
    canonicalEmail: "person@example.com",
    challengeId: selector,
    savedAt: Date.now(),
  });
}
function submit(name = "Verify") {
  const accessibleName =
    name === "Verify" &&
    screen.queryByRole("button", { name: "Check verification link" })
      ? "Check verification link"
      : name;
  fireEvent.submit(
    screen.getByRole("button", { name: accessibleName }).closest("form")!,
  );
}
function credentials() {
  fireEvent.change(screen.getByLabelText("Email address"), {
    target: { value: " Person@Example.com " },
  });
  fireEvent.change(screen.getByLabelText("Password"), {
    target: { value: password },
  });
  const confirmation = screen.queryByLabelText("Confirm password");
  if (confirmation)
    fireEvent.change(confirmation, { target: { value: password } });
}
beforeEach(() => {
  window.history.replaceState(null, "", "/verify-email");
  sessionStorage.clear();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  localStorage.clear();
});

describe("OTP and secure-link verification", () => {
  it("keeps leading zero, accepts native keyboard/paste editing and blocks duplicate submission", async () => {
    save();
    const { promise, resolve } = Promise.withResolvers<{
      data: { status: "verified" };
    }>();
    vi.mocked(verifyEmailCode).mockReturnValue(promise);
    render(<VerificationForm />);
    const input = screen.getByLabelText("6-digit verification code");
    fireEvent.change(input, { target: { value: "0a1๒2345" } });
    expect((input as HTMLInputElement).value).toBe("012345");
    fireEvent.paste(input, { clipboardData: { getData: () => "01 2345" } });
    const form = screen
      .getByRole("button", { name: "Verify" })
      .closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(verifyEmailCode).toHaveBeenCalledTimes(1);
    expect(verifyEmailCode).toHaveBeenCalledWith(
      {
        email: "person@example.com",
        challengeId,
        code: "012345",
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(sessionStorage.getItem(key)).not.toContain("012345");
    await act(async () => resolve({ data: { status: "verified" } }));
    expect(await screen.findByRole("status")).toBe(document.activeElement);
    expect(
      screen.getByRole("link", { name: "Sign in" }).getAttribute("href"),
    ).toBe("/login");
    expect(sessionStorage.getItem(key)).toBeNull();
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it("requires six ASCII digits and handles server-invalid code without guessing LINK_ONLY", async () => {
    save();
    vi.mocked(verifyEmailCode).mockRejectedValue(
      new AuthApiError("invalid_verification_code"),
    );
    render(<VerificationForm />);
    fireEvent.change(screen.getByLabelText("6-digit verification code"), {
      target: { value: "01234" },
    });
    submit();
    expect(verifyEmailCode).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBe(document.activeElement);
    fireEvent.change(screen.getByLabelText("6-digit verification code"), {
      target: { value: "012345" },
    });
    submit();
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("secure link"),
    );
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Request a new code" }),
    ).toBeTruthy();
  });

  it("scrubs before interaction in StrictMode and never verifies on GET", async () => {
    save();
    window.history.replaceState(
      null,
      "",
      `/verify-email?token=${linkToken}#discard`,
    );
    vi.mocked(verifyEmail).mockResolvedValue({ data: { status: "verified" } });
    render(
      <StrictMode>
        <VerificationForm />
      </StrictMode>,
    );
    expect(window.location.search).toBe("");
    expect(window.location.hash).toBe("");
    expect(verifyEmail).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(key)).toBeNull();
    expect(document.body.textContent).not.toContain(linkToken);
    submit();
    await waitFor(() =>
      expect(verifyEmail).toHaveBeenCalledWith(
        { token: linkToken },
        { signal: expect.any(AbortSignal) },
      ),
    );
    expect(verifyEmail).toHaveBeenCalledTimes(1);
  });

  it.each(["", "malformed", `${linkToken}&token=${linkToken}`])(
    "scrubs malformed or duplicate link input without POST (%s)",
    (value) => {
      window.history.replaceState(null, "", `/verify-email?token=${value}`);
      render(<VerificationForm />);
      expect(window.location.search).toBe("");
      expect(screen.getByRole("alert").textContent).toContain(
        "invalid or expired",
      );
      expect(verifyEmail).not.toHaveBeenCalled();
      expect(screen.queryByRole("button", { name: "Verify" })).toBeNull();
    },
  );

  it("shows an informational already-verified state and Sign in for a recognized consumed link", async () => {
    window.history.replaceState(null, "", `/verify-email?token=${linkToken}`);
    vi.mocked(verifyEmail).mockResolvedValue({
      data: { status: "already_verified" },
    });
    render(<VerificationForm />);
    expect(window.location.search).toBe("");
    expect(verifyEmail).not.toHaveBeenCalled();
    submit();
    expect((await screen.findByRole("status")).textContent).toContain(
      "already verified",
    );
    expect(
      screen.getByRole("link", { name: "Sign in" }).getAttribute("href"),
    ).toBe("/login");
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(verificationPasswordProof).not.toHaveBeenCalled();
    expect(login).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(key)).toBeNull();
  });

  it("discards an invalid/replayed link and offers recovery without password fallback", async () => {
    window.history.replaceState(null, "", `/verify-email?token=${linkToken}`);
    vi.mocked(verifyEmail).mockRejectedValue(new AuthApiError("invalid_token"));
    render(<VerificationForm />);
    submit();
    await screen.findByRole("alert");
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(screen.queryByRole("button", { name: "Verify" })).toBeNull();
  });

  it.each(["code", "link"])(
    "establishes dedicated proof and retries the same valid %s after an incorrect password",
    async (kind) => {
      const verify =
        kind === "code" ? vi.mocked(verifyEmailCode) : vi.mocked(verifyEmail);
      verify
        .mockRejectedValueOnce(
          new AuthApiError("verification_password_proof_required"),
        )
        .mockResolvedValueOnce({ data: { status: "verified" } });
      vi.mocked(verificationPasswordProof)
        .mockRejectedValueOnce(new AuthApiError("invalid_credentials"))
        .mockResolvedValueOnce({ data: { status: "accepted" } });
      if (kind === "code") save();
      else
        window.history.replaceState(
          null,
          "",
          `/verify-email?token=${linkToken}`,
        );
      render(<VerificationForm />);
      if (kind === "code")
        fireEvent.change(screen.getByLabelText("6-digit verification code"), {
          target: { value: "012345" },
        });
      submit();
      await screen.findByLabelText("Password");
      if (kind === "link")
        fireEvent.change(screen.getByLabelText("Email address"), {
          target: { value: "person@example.com" },
        });
      fireEvent.change(screen.getByLabelText("Password"), {
        target: { value: password },
      });
      submit("Confirm password");
      await screen.findByRole("alert");
      expect(verify).toHaveBeenCalledTimes(1);
      expect(
        (screen.getByLabelText("Password") as HTMLInputElement).value,
      ).toBe("");
      fireEvent.change(screen.getByLabelText("Password"), {
        target: { value: password },
      });
      submit("Confirm password");
      await screen.findByRole("link", { name: "Sign in" });
      expect(verificationPasswordProof).toHaveBeenLastCalledWith(
        { email: "person@example.com", password },
        { signal: expect.any(AbortSignal) },
      );
      expect(verify.mock.calls[0]![0]).toEqual(verify.mock.calls[1]![0]);
      expect(verify).toHaveBeenCalledTimes(2);
      expect(login).not.toHaveBeenCalled();
      expect(resendVerification).not.toHaveBeenCalled();
      expect(sessionStorage.getItem(key)).toBeNull();
      expect(localStorage.length).toBe(0);
    },
  );

  it.each(["verification", "proof"])(
    "shows server Retry-After for %s requests",
    async (stage) => {
      save();
      vi.mocked(verifyEmailCode).mockRejectedValue(
        new AuthApiError(
          stage === "proof"
            ? "verification_password_proof_required"
            : "rate_limited",
          45,
        ),
      );
      vi.mocked(verificationPasswordProof).mockRejectedValue(
        new AuthApiError("rate_limited", 45),
      );
      render(<VerificationForm />);
      fireEvent.change(screen.getByLabelText("6-digit verification code"), {
        target: { value: "012345" },
      });
      submit();
      if (stage === "proof") {
        await screen.findByLabelText("Password");
        fireEvent.change(screen.getByLabelText("Password"), {
          target: { value: password },
        });
        submit("Confirm password");
      }
      expect((await screen.findByRole("alert")).textContent).toContain(
        "45 seconds",
      );
    },
  );

  it("refreshes non-secret continuation without resend, then expires on focus", () => {
    save();
    render(<VerificationForm />);
    fireEvent.change(screen.getByLabelText("6-digit verification code"), {
      target: { value: "012345" },
    });
    cleanup();
    render(<VerificationForm />);
    expect(
      (screen.getByLabelText("6-digit verification code") as HTMLInputElement)
        .value,
    ).toBe("");
    expect(resendVerification).not.toHaveBeenCalled();
    expect(verificationPasswordProof).not.toHaveBeenCalled();
    sessionStorage.setItem(
      key,
      JSON.stringify({
        version: 1,
        canonicalEmail: "person@example.com",
        challengeId,
        savedAt: Date.now() - 30 * 60_000,
      }),
    );
    fireEvent(window, new Event("focus"));
    expect(screen.queryByLabelText("6-digit verification code")).toBeNull();
    expect(
      screen
        .getByRole("link", { name: "Back to sign in" })
        .getAttribute("href"),
    ).toBe("/login");
  });

  it("loses scrubbed link credentials on refresh rather than persisting them", () => {
    window.history.replaceState(null, "", `/verify-email?token=${linkToken}`);
    render(<VerificationForm />);
    cleanup();
    render(<VerificationForm />);
    expect(screen.queryByRole("button", { name: "Verify" })).toBeNull();
    expect(sessionStorage.length).toBe(0);
    expect(localStorage.length).toBe(0);
  });

  it("recovers safely when continuation storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    render(<VerificationForm />);
    expect(screen.getByRole("link", { name: "Back to sign in" })).toBeTruthy();
    expect(verifyEmailCode).not.toHaveBeenCalled();
    expect(resendVerification).not.toHaveBeenCalled();
  });

  it("uses Thai labels, validation and verification success through the existing language provider", async () => {
    localStorage.setItem("stockwise.language", "th");
    save();
    vi.mocked(verifyEmailCode).mockResolvedValue({
      data: { status: "verified" },
    });
    render(
      <LanguageProvider>
        <VerificationForm />
      </LanguageProvider>,
    );
    const input = await screen.findByLabelText("รหัสยืนยัน 6 หลัก");
    fireEvent.change(input, { target: { value: "012345" } });
    submit("ยืนยัน");
    expect((await screen.findByRole("status")).textContent).toContain(
      "เข้าสู่ระบบ",
    );
    expect(
      screen.getByRole("link", { name: "เข้าสู่ระบบ" }).getAttribute("href"),
    ).toBe("/login");
  });
});

describe("pending login, registration recovery and resend", () => {
  it.each([challengeId, null])(
    "routes pending login to verification, not application (%s)",
    async (selector) => {
      save(successor);
      vi.mocked(login).mockResolvedValue({
        outcome: "verification_required",
        status: "verification_required",
        nextStep: "verify_email",
        verification: { challengeId: selector },
      });
      const queryClient = new QueryClient();
      queryClient.setQueryData(["access-context"], { old: "identity" });
      render(
        <QueryClientProvider client={queryClient}>
          <LoginForm />
        </QueryClientProvider>,
      );
      credentials();
      submit("Sign in");
      await waitFor(() =>
        expect(replace).toHaveBeenCalledWith("/verify-email"),
      );
      expect(replace).not.toHaveBeenCalledWith("/app");
      expect(push).not.toHaveBeenCalled();
      expect(JSON.parse(sessionStorage.getItem(key)!)).toMatchObject({
        canonicalEmail: "person@example.com",
        challengeId: selector,
      });
      expect(queryClient.getQueryData(["access-context"])).toBeUndefined();
      expect(
        (screen.getByLabelText("Password") as HTMLInputElement).value,
      ).toBe("");
    },
  );

  it("clears the prior identity when registration cannot store continuation", async () => {
    save();
    vi.mocked(register).mockResolvedValue({
      data: {
        status: "accepted",
        nextStep: "verify_email",
        verification: { challengeId: successor },
      },
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    render(<RegistrationForm />);
    credentials();
    submit("Create account");
    await screen.findByRole("alert");
    expect(replace).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(key)).toBeNull();
    expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe(
      "",
    );
    expect(resendVerification).not.toHaveBeenCalled();
  });

  it("provides explicit resend for a null selector without inventing expiry state", () => {
    save(null);
    render(<VerificationForm />);
    expect(screen.queryByLabelText("6-digit verification code")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Request a new code" }),
    ).toBeTruthy();
    expect(resendVerification).not.toHaveBeenCalled();
  });

  it("resends directly from the current OTP continuation with one click and no email re-entry", async () => {
    save();
    const before = JSON.parse(sessionStorage.getItem(key)!);
    const deferred = Promise.withResolvers<{
      data: { status: "accepted"; verification: { challengeId: string } };
    }>();
    vi.mocked(resendVerification).mockReturnValue(deferred.promise);
    render(<VerificationForm />);
    expect(screen.queryByLabelText("Email address")).toBeNull();
    const button = screen.getByRole("button", { name: "Request a new code" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(resendVerification).toHaveBeenCalledTimes(1);
    expect(resendVerification).toHaveBeenCalledWith(
      { email: "person@example.com" },
      { signal: expect.any(AbortSignal) },
    );
    await act(async () =>
      deferred.resolve({
        data: { status: "accepted", verification: { challengeId: successor } },
      }),
    );
    expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual({
      ...before,
      challengeId: successor,
    });
    expect(screen.getByRole("status").textContent).toContain("inbox");
    expect(push).not.toHaveBeenCalled();
    expect(login).not.toHaveBeenCalled();
    expect(verificationPasswordProof).not.toHaveBeenCalled();
  });

  it("recovers safely without leaving busy UI if storage refuses the successor", async () => {
    save();
    vi.mocked(resendVerification).mockResolvedValue({
      data: { status: "accepted", verification: { challengeId: successor } },
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("synthetic storage unavailable");
    });
    render(<VerificationForm />);
    fireEvent.click(screen.getByRole("button", { name: "Request a new code" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "could not complete",
      ),
    );
    expect(sessionStorage.getItem(key)).toBeNull();
    expect(screen.queryByLabelText("6-digit verification code")).toBeNull();
    expect(
      screen
        .getByRole("link", { name: "Request a new code" })
        .getAttribute("href"),
    ).toBe("/verification-resend");
    expect(
      screen
        .getByRole("link", { name: "Back to sign in" })
        .getAttribute("href"),
    ).toBe("/login");
    expect(verifyEmailCode).not.toHaveBeenCalled();
    expect(verificationPasswordProof).not.toHaveBeenCalled();
    expect(login).not.toHaveBeenCalled();
  });

  it("ignores a resend response after the continuation is cleared or replaced", async () => {
    save();
    const deferred = Promise.withResolvers<{
      data: { status: "accepted"; verification: { challengeId: string } };
    }>();
    vi.mocked(resendVerification).mockReturnValue(deferred.promise);
    render(<VerificationForm />);
    fireEvent.click(screen.getByRole("button", { name: "Request a new code" }));
    const newer = {
      version: 1 as const,
      canonicalEmail: "other@example.com",
      challengeId: successor,
      savedAt: Date.now(),
    };
    saveContinuation(newer);
    await act(async () =>
      deferred.resolve({
        data: { status: "accepted", verification: { challengeId: successor } },
      }),
    );
    expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual(newer);
    expect(push).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("preserves Back to sign in while resend is pending and abandons safely", async () => {
    save();
    const deferred = Promise.withResolvers<{
      data: { status: "accepted"; verification: { challengeId: string } };
    }>();
    vi.mocked(resendVerification).mockReturnValue(deferred.promise);
    const view = render(<VerificationForm />);
    fireEvent.click(screen.getByRole("button", { name: "Request a new code" }));
    const resendButton = screen.getByRole("button", {
      name: "Request a new code",
    }) as HTMLButtonElement;
    expect(resendButton.disabled).toBe(true);
    const back = screen.getByRole("link", { name: "Back to sign in" });
    expect(back.getAttribute("href")).toBe("/login");
    const signal = vi.mocked(resendVerification).mock.calls[0]?.[1]?.signal;
    expect(signal?.aborted).toBe(false);
    fireEvent.click(back);
    expect(sessionStorage.getItem(key)).toBeNull();
    view.unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () =>
      deferred.resolve({
        data: { status: "accepted", verification: { challengeId: successor } },
      }),
    );
    expect(sessionStorage.getItem(key)).toBeNull();
    expect(verifyEmailCode).not.toHaveBeenCalled();
    expect(verificationPasswordProof).not.toHaveBeenCalled();
    expect(login).not.toHaveBeenCalled();
  });

  it("ignores a delayed resend after clearing and restoring identical continuation (ABA)", async () => {
    save();
    const original = JSON.parse(sessionStorage.getItem(key)!);
    const deferred = Promise.withResolvers<{
      data: { status: "accepted"; verification: { challengeId: string } };
    }>();
    vi.mocked(resendVerification).mockReturnValue(deferred.promise);
    render(<VerificationForm />);
    fireEvent.click(screen.getByRole("button", { name: "Request a new code" }));
    clearContinuation();
    saveContinuation(original);
    await act(async () =>
      deferred.resolve({
        data: { status: "accepted", verification: { challengeId: successor } },
      }),
    );
    expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual(original);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("aborts a direct resend on unmount and never changes its saved challenge", async () => {
    save();
    const original = JSON.parse(sessionStorage.getItem(key)!);
    const deferred = Promise.withResolvers<{
      data: { status: "accepted"; verification: { challengeId: string } };
    }>();
    vi.mocked(resendVerification).mockReturnValue(deferred.promise);
    const view = render(<VerificationForm />);
    fireEvent.click(screen.getByRole("button", { name: "Request a new code" }));
    const options = vi.mocked(resendVerification).mock.calls[0]?.[1];
    view.unmount();
    expect(options?.signal?.aborted).toBe(true);
    await act(async () =>
      deferred.resolve({
        data: { status: "accepted", verification: { challengeId: successor } },
      }),
    );
    expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual(original);
  });

  it("keeps successive one-click resends bound to the newly saved challenge", async () => {
    save();
    const old = JSON.parse(sessionStorage.getItem(key)!);
    vi.mocked(resendVerification)
      .mockResolvedValueOnce({
        data: { status: "accepted", verification: { challengeId: successor } },
      })
      .mockResolvedValueOnce({
        data: { status: "accepted", verification: { challengeId } },
      });
    render(<VerificationForm />);
    fireEvent.click(screen.getByRole("button", { name: "Request a new code" }));
    await waitFor(() =>
      expect(JSON.parse(sessionStorage.getItem(key)!).challengeId).toBe(
        successor,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Request a new code" }));
    await waitFor(() =>
      expect(JSON.parse(sessionStorage.getItem(key)!).challengeId).toBe(
        challengeId,
      ),
    );
    expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual(old);
    expect(resendVerification).toHaveBeenCalledTimes(2);
  });

  it("prefills known email and replaces only the selector without renewing proof", async () => {
    save();
    const old = JSON.parse(sessionStorage.getItem(key)!);
    vi.mocked(resendVerification).mockResolvedValue({
      data: { status: "accepted", verification: { challengeId: successor } },
    });
    render(<VerificationResendForm />);
    expect(
      (screen.getByLabelText("Email address") as HTMLInputElement).value,
    ).toBe("person@example.com");
    expect(resendVerification).not.toHaveBeenCalled();
    const form = screen
      .getByRole("button", { name: "Request verification code" })
      .closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/verify-email"));
    expect(push).not.toHaveBeenCalled();
    expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual({
      ...old,
      challengeId: successor,
    });
    expect(resendVerification).toHaveBeenCalledTimes(1);
    expect(verificationPasswordProof).not.toHaveBeenCalled();
    expect(login).not.toHaveBeenCalled();
  });

  it("supports manual resend identity changes and server rate limits", async () => {
    save();
    vi.mocked(resendVerification).mockRejectedValue(
      new AuthApiError("rate_limited", 45),
    );
    render(<VerificationResendForm />);
    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "different@example.com" },
    });
    submit("Request verification code");
    expect((await screen.findByRole("alert")).textContent).toContain(
      "45 seconds",
    );
    expect(sessionStorage.getItem(key)).toBeNull();
    expect(push).not.toHaveBeenCalled();
  });
});
