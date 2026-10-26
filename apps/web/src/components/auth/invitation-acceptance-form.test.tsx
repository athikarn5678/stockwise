// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  acceptInvitationContinuation,
  cancelInvitationContinuation,
  captureInvitationContinuation,
  InvitationContinuationApiError,
  resumeInvitationContinuation,
} from "@/invitation-continuation-api-client";
import {
  clearInvitationRecoveryRequired,
  releaseInvitationFlowLock,
  saveInvitationContinuation,
} from "@/invitation-continuation";
import { InvitationAcceptanceForm } from "./invitation-acceptance-form";
const organizationId = "10000000-0000-4000-8000-000000000001";
const replace = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));
vi.mock("@/invitation-continuation-api-client", () => ({
  acceptInvitationContinuation: vi.fn(),
  cancelInvitationContinuation: vi.fn(),
  captureInvitationContinuation: vi.fn(),
  resumeInvitationContinuation: vi.fn(),
  InvitationContinuationApiError: class InvitationContinuationApiError extends Error {
    constructor(readonly kind: string) {
      super(kind);
    }
  },
}));

function setCredential(token: string) {
  Object.defineProperty(window, "__stockwiseTakeCredentialLink", {
    configurable: true,
    value: vi.fn(() => ({ route: "/accept-invitation", token })),
  });
}
function allowFlowLock() {
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: (
        _name: string,
        _options: unknown,
        callback: (lock: object) => Promise<void>,
      ) => Promise.resolve(callback({})),
    },
  });
}
function renderForm() {
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <InvitationAcceptanceForm />
    </QueryClientProvider>,
  );
  return client;
}

afterEach(() => {
  cleanup();
  replace.mockReset();
  vi.mocked(captureInvitationContinuation).mockReset();
  vi.mocked(resumeInvitationContinuation).mockReset();
  vi.mocked(acceptInvitationContinuation).mockReset();
  vi.mocked(cancelInvitationContinuation).mockReset();
  sessionStorage.clear();
  localStorage.clear();
  releaseInvitationFlowLock();
  clearInvitationRecoveryRequired();
  delete (window as Window & { __stockwiseTakeCredentialLink?: unknown })
    .__stockwiseTakeCredentialLink;
  Reflect.deleteProperty(navigator, "locks");
});

describe("invitation continuation form", () => {
  it("captures a one-use link, keeps only selector data, and requires explicit acceptance", async () => {
    allowFlowLock();
    setCredential("private-token");
    vi.mocked(captureInvitationContinuation).mockResolvedValue({
      data: { expiresAt: new Date(Date.now() + 60_000).toISOString() },
    });
    vi.mocked(resumeInvitationContinuation).mockResolvedValue({
      data: {
        status: "ready",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    vi.mocked(acceptInvitationContinuation).mockResolvedValue({
      data: {
        membership: { organization: { id: organizationId } },
        replayed: false,
      },
    });
    const client = renderForm();
    await screen.findByRole("button", { name: "Accept invitation" });
    expect(captureInvitationContinuation).toHaveBeenCalledWith(
      expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      "private-token",
    );
    expect(
      sessionStorage.getItem("stockwise_invitation_continuation"),
    ).not.toContain("private-token");
    expect(
      screen.getByRole("button", { name: "Accept invitation" }),
    ).toBeTruthy();
    expect(acceptInvitationContinuation).not.toHaveBeenCalled();
    client.setQueryData(["access-context"], { organizations: [{ id: "old" }] });
    fireEvent.click(screen.getByRole("button", { name: "Accept invitation" }));
    await waitFor(() =>
      expect(acceptInvitationContinuation).toHaveBeenCalledTimes(1),
    );
    expect(replace).toHaveBeenCalledWith(
      `/app?organizationId=${organizationId}`,
    );
    expect(client.getQueryData(["access-context"])).toBeUndefined();
  });

  it("provides immediate sign-in and account creation recovery for anonymous recipients", async () => {
    allowFlowLock();
    setCredential("private-token");
    vi.mocked(captureInvitationContinuation).mockResolvedValue({
      data: { expiresAt: new Date(Date.now() + 60_000).toISOString() },
    });
    vi.mocked(resumeInvitationContinuation).mockRejectedValue(
      new InvitationContinuationApiError("authentication_required"),
    );
    renderForm();
    expect(await screen.findByRole("link", { name: "Sign in" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Create account" })).toBeTruthy();
    expect(document.body.textContent).not.toContain("private-token");
    expect(acceptInvitationContinuation).not.toHaveBeenCalled();
  });

  it("fails closed when exclusive per-tab locks are unavailable", async () => {
    setCredential("private-token");
    renderForm();
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(captureInvitationContinuation).not.toHaveBeenCalled();
    expect(
      sessionStorage.getItem("stockwise_invitation_continuation"),
    ).toBeNull();
  });
  it("ignores a delayed capture response after pagehide invalidates its generation", async () => {
    allowFlowLock();
    setCredential("private-token");
    const delayed = Promise.withResolvers<{ data: { expiresAt: string } }>();
    vi.mocked(captureInvitationContinuation).mockReturnValue(delayed.promise);
    renderForm();
    await waitFor(() =>
      expect(captureInvitationContinuation).toHaveBeenCalledTimes(1),
    );
    act(() => window.dispatchEvent(new Event("pagehide")));
    await act(async () => {
      delayed.resolve({
        data: { expiresAt: new Date(Date.now() + 60_000).toISOString() },
      });
      await delayed.promise;
    });
    expect(
      sessionStorage.getItem("stockwise_invitation_continuation"),
    ).toBeNull();
    expect(resumeInvitationContinuation).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "Accept invitation" }),
    ).toBeNull();
  });
  it("does not expose acceptance from a delayed resume response after pagehide", async () => {
    allowFlowLock();
    const flowId = "C".repeat(43);
    saveInvitationContinuation({
      version: 1,
      flowId,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const delayed = Promise.withResolvers<{
      data: { status: "ready"; expiresAt: string };
    }>();
    vi.mocked(resumeInvitationContinuation).mockReturnValue(delayed.promise);
    renderForm();
    await waitFor(() =>
      expect(resumeInvitationContinuation).toHaveBeenCalledWith(flowId),
    );
    act(() => window.dispatchEvent(new Event("pagehide")));
    await act(async () => {
      delayed.resolve({
        data: {
          status: "ready",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      });
      await delayed.promise;
    });
    expect(
      screen.queryByRole("button", { name: "Accept invitation" }),
    ).toBeNull();
    expect(
      sessionStorage.getItem("stockwise_invitation_continuation"),
    ).toContain(flowId);
  });
  it("retains the ready invitation after a retryable acceptance outage", async () => {
    allowFlowLock();
    const flowId = "D".repeat(43);
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    saveInvitationContinuation({ version: 1, flowId, expiresAt });
    vi.mocked(resumeInvitationContinuation).mockResolvedValue({
      data: { status: "ready", expiresAt },
    });
    vi.mocked(acceptInvitationContinuation)
      .mockRejectedValueOnce(new InvitationContinuationApiError("unavailable"))
      .mockResolvedValueOnce({
        data: {
          membership: { organization: { id: organizationId } },
          replayed: false,
        },
      });
    renderForm();
    fireEvent.click(
      await screen.findByRole("button", { name: "Accept invitation" }),
    );
    await screen.findByRole("alert");
    expect(replace).not.toHaveBeenCalled();
    expect(
      sessionStorage.getItem("stockwise_invitation_continuation"),
    ).toContain(flowId);
    const retry = screen.getByRole("button", { name: "Accept invitation" });
    await waitFor(() => expect(retry.hasAttribute("disabled")).toBe(false));
    fireEvent.click(retry);
    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith(
        `/app?organizationId=${organizationId}`,
      ),
    );
  });

  it("cancels a capture-created cookie only after a pending capture settles", async () => {
    allowFlowLock();
    setCredential("private-token");
    const delayed = Promise.withResolvers<{ data: { expiresAt: string } }>();
    vi.mocked(captureInvitationContinuation).mockReturnValue(delayed.promise);
    vi.mocked(cancelInvitationContinuation).mockResolvedValue(undefined);
    renderForm();
    await waitFor(() =>
      expect(captureInvitationContinuation).toHaveBeenCalledTimes(1),
    );
    const captureCall = vi.mocked(captureInvitationContinuation).mock.calls[0];
    if (!captureCall) throw new Error("Expected pending capture.");
    const [flowId] = captureCall;
    fireEvent.click(screen.getByRole("button", { name: "Cancel invitation" }));
    expect(cancelInvitationContinuation).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalledWith("/");
    await act(async () => {
      delayed.resolve({
        data: { expiresAt: new Date(Date.now() + 60_000).toISOString() },
      });
      await delayed.promise;
    });
    await waitFor(() =>
      expect(cancelInvitationContinuation).toHaveBeenCalledWith(flowId),
    );
    expect(
      sessionStorage.getItem("stockwise_invitation_continuation"),
    ).toBeNull();
  });
  it("discards a terminal invitation instead of leaving acceptance available", async () => {
    allowFlowLock();
    const flowId = "E".repeat(43);
    saveInvitationContinuation({
      version: 1,
      flowId,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    vi.mocked(resumeInvitationContinuation).mockRejectedValue(
      new InvitationContinuationApiError("invalid_invitation"),
    );
    renderForm();
    await screen.findByRole("alert");
    expect(
      screen.queryByRole("button", { name: "Accept invitation" }),
    ).toBeNull();
    expect(
      sessionStorage.getItem("stockwise_invitation_continuation"),
    ).toBeNull();
    expect(acceptInvitationContinuation).not.toHaveBeenCalled();
  });
  it("shows recovery instead of silently ignoring acceptance after continuation expiry", async () => {
    allowFlowLock();
    const flowId = "F".repeat(43);
    const expiry = Date.now() + 60_000;
    const expiresAt = new Date(expiry).toISOString();
    saveInvitationContinuation({ version: 1, flowId, expiresAt });
    vi.mocked(resumeInvitationContinuation).mockResolvedValue({
      data: { status: "ready", expiresAt },
    });
    renderForm();
    const accept = await screen.findByRole("button", {
      name: "Accept invitation",
    });
    const clock = vi.spyOn(Date, "now").mockReturnValue(expiry);
    try {
      fireEvent.click(accept);
      expect(screen.getByRole("alert")).toBeTruthy();
      expect(
        screen.queryByRole("button", { name: "Accept invitation" }),
      ).toBeNull();
      expect(acceptInvitationContinuation).not.toHaveBeenCalled();
      expect(replace).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });
});
