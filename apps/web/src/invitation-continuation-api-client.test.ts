// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { login, logout } from "./api-client";
import {
  acceptInvitationContinuation,
  captureInvitationContinuation,
  resumeInvitationContinuation,
} from "./invitation-continuation-api-client";

const flowId = "A".repeat(43);

function installCookieMutationLock() {
  let tail = Promise.resolve();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: (_name: string, _options: unknown, callback: () => unknown) => {
        const result = tail.then(callback);
        tail = result.then(
          () => undefined,
          () => undefined,
        );
        return result;
      },
    },
  });
}

beforeEach(() => installCookieMutationLock());

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
  Reflect.deleteProperty(navigator, "locks");
});

describe("invitation continuation API failures", () => {
  it.each([
    [401, "AUTHENTICATION_REQUIRED", "authentication_required"],
    [400, "INVALID_INVITATION", "invalid_invitation"],
    [400, "INVALID_INVITATION_CONTINUATION", "invalid_invitation_continuation"],
    [409, "INVITATION_CONTINUATION_LIMIT", "continuation_limit"],
    [409, "INVITATION_SCOPE_INVALID", "invitation_scope_invalid"],
    [503, "INTERNAL_PROVIDER_DETAIL", "unavailable"],
  ] as const)(
    "maps HTTP %s/%s to safe %s recovery",
    async (status, code, kind) => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(
            new Response(JSON.stringify({ error: { code } }), { status }),
          ),
      );
      await expect(resumeInvitationContinuation(flowId)).rejects.toMatchObject({
        kind,
      });
    },
  );

  it("rejects an invalid selector before transmitting an invitation credential", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      captureInvitationContinuation("invalid", "synthetic-private-invitation"),
    ).rejects.toMatchObject({ kind: "invalid_invitation_continuation" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    new Response("not JSON", { status: 200 }),
    new Response(
      JSON.stringify({ data: { membership: null, replayed: false } }),
      { status: 200 },
    ),
    new Response(
      JSON.stringify({
        data: {
          membership: { organization: { id: "organization" } },
          replayed: false,
        },
      }),
      { status: 202 },
    ),
  ])(
    "never reports acceptance from malformed or unexpected success",
    async (response) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
      await expect(acceptInvitationContinuation(flowId)).rejects.toMatchObject({
        kind: "unavailable",
      });
    },
  );

  it("reports transport failure without claiming expiration or acceptance", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("synthetic offline failure")),
    );
    await expect(acceptInvitationContinuation(flowId)).rejects.toMatchObject({
      kind: "unavailable",
    });
  });
  it("serializes continuation and auth cookie mutations through one origin lock", async () => {
    const { promise: resumeResponse, resolve: finishResume } =
      Promise.withResolvers<Response>();
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(resumeResponse)
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const resume = resumeInvitationContinuation(flowId);
    await Promise.resolve();
    const signedOut = logout();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    finishResume(
      new Response(
        JSON.stringify({
          data: {
            status: "ready",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        }),
      ),
    );
    await Promise.all([resume, signedOut]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("releases the origin lock after a failed continuation transport", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(resumeInvitationContinuation(flowId)).rejects.toMatchObject({
      kind: "unavailable",
    });
    await expect(logout()).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails continuation closed without Web Locks while auth remains usable", async () => {
    Reflect.deleteProperty(navigator, "locks");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(resumeInvitationContinuation(flowId)).rejects.toMatchObject({
      kind: "unavailable",
    });
    await expect(logout()).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("serializes continuation and login without nested lock acquisition", async () => {
    const { promise: resumeResponse, resolve: finishResume } =
      Promise.withResolvers<Response>();
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(resumeResponse)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              user: {
                displayName: null,
                email: "person@example.invalid",
                id: "synthetic-user",
              },
            },
          }),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const resume = resumeInvitationContinuation(flowId);
    await Promise.resolve();
    const signedIn = login({
      email: "person@example.invalid",
      password: "synthetic-password",
    });
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    finishResume(
      new Response(
        JSON.stringify({
          data: {
            status: "ready",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        }),
      ),
    );
    await Promise.all([resume, signedIn]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails continuation closed when session storage is unavailable", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      window,
      "sessionStorage",
    );
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      get() {
        throw new Error("storage unavailable");
      },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(resumeInvitationContinuation(flowId)).rejects.toMatchObject({
        kind: "unavailable",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      if (descriptor)
        Object.defineProperty(window, "sessionStorage", descriptor);
      else Reflect.deleteProperty(window, "sessionStorage");
    }
  });
});
