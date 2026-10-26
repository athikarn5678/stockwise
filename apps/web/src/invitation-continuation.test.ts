// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireInvitationFlowLock,
  clearInvitationContinuation,
  clearInvitationRecoveryRequired,
  createInvitationFlowId,
  isInvitationRecoveryRequired,
  loadInvitationContinuation,
  releaseInvitationFlowLock,
  saveInvitationContinuation,
} from "./invitation-continuation";

const KEY = "stockwise_invitation_continuation";
const flowId = "A".repeat(43);

afterEach(() => {
  sessionStorage.clear();
  clearInvitationRecoveryRequired();
  releaseInvitationFlowLock();
  Reflect.deleteProperty(navigator, "locks");
});

describe("invitation continuation selector storage", () => {
  it("stores only the strict selector and absolute expiry for this tab", () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    expect(saveInvitationContinuation({ version: 1, flowId, expiresAt })).toBe(
      true,
    );
    expect(sessionStorage.length).toBe(1);
    expect(sessionStorage.getItem(KEY)).toBe(
      JSON.stringify({ version: 1, flowId, expiresAt }),
    );
    expect(loadInvitationContinuation()).toEqual({
      status: "ready",
      continuation: { version: 1, flowId, expiresAt },
    });
  });

  it("rejects malformed records and clears expired records", () => {
    sessionStorage.setItem(
      KEY,
      JSON.stringify({
        version: 1,
        flowId,
        expiresAt: new Date(Date.now() - 1).toISOString(),
      }),
    );
    expect(loadInvitationContinuation().status).toBe("expired");
    expect(sessionStorage.getItem(KEY)).toBeNull();
    expect(isInvitationRecoveryRequired()).toBe(true);
    sessionStorage.setItem(
      KEY,
      JSON.stringify({
        version: 1,
        flowId,
        expiresAt: new Date().toISOString(),
        token: "secret",
      }),
    );
    expect(loadInvitationContinuation().status).toBe("invalid");
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it("creates canonical random selectors and clears the selected record", () => {
    expect(createInvitationFlowId()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(
      saveInvitationContinuation({
        version: 1,
        flowId,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    ).toBe(true);
    clearInvitationContinuation();
    expect(loadInvitationContinuation().status).toBe("missing");
  });

  it("fails closed on a cloned selector contending for its exclusive lock", async () => {
    const request = vi.fn(
      (
        _name: string,
        _options: unknown,
        callback: (lock: object | null) => Promise<void>,
      ) => Promise.resolve(callback(null)),
    );
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: { request },
    });
    expect(await acquireInvitationFlowLock(flowId)).toBeNull();
    expect(request).toHaveBeenCalledWith(
      `stockwise-invitation-${flowId}`,
      { mode: "exclusive", ifAvailable: true },
      expect.any(Function),
    );
  });
  it("coalesces same-document acquisition and invalidates pending ownership on release", async () => {
    let enter: ((value: object | null) => Promise<void>) | undefined;
    const request = vi.fn(
      (
        _name: string,
        _options: unknown,
        callback: (lock: object | null) => Promise<void>,
      ) => {
        enter = callback;
        return Promise.resolve();
      },
    );
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: { request },
    });
    const first = acquireInvitationFlowLock(flowId);
    const second = acquireInvitationFlowLock(flowId);
    expect(request).toHaveBeenCalledTimes(1);
    releaseInvitationFlowLock();
    await enter?.({});
    expect(await first).toBeNull();
    expect(await second).toBeNull();
  });
});
