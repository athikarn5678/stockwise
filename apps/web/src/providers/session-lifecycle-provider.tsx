"use client";
import { useQueryClient } from "@tanstack/react-query";
import { usePathname } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import {
  discardPrivateSession,
  isSessionChangeHint,
  SESSION_CHANNEL,
  SESSION_CHANGE_EVENT,
  SESSION_UNAUTHORIZED_EVENT,
  type SessionChangeHint,
} from "@/session-lifecycle";
import { clearContinuation } from "@/verification-continuation-browser";
import { isGuestRoute, routeAccessPolicy } from "@/route-access-policy";
import { AccountDraftContext, createAccountDraftStore } from "./account-draft";
import type { AccessContext } from "@/branch-api-client";

interface SessionLifecycleState {
  generation: number;
  suspended: boolean;
  unauthorized: boolean;
  authenticatedActorId: string | null;
}
interface SessionLifecycleValue extends SessionLifecycleState {
  acknowledgeFreshAuthenticatedContext: () => void;
  reconcileAccountDraft: (context: AccessContext | null) => void;
  reconcileAuthenticatedActor: (actorId: string) => void;
}
const SessionLifecycleContext = createContext<SessionLifecycleValue>({
  generation: 0,
  suspended: false,
  unauthorized: false,
  authenticatedActorId: null,
  acknowledgeFreshAuthenticatedContext: () => {},
  reconcileAccountDraft: () => {},
  reconcileAuthenticatedActor: () => {},
});
export function useSessionLifecycle() {
  return useContext(SessionLifecycleContext);
}

export function SessionLifecycleProvider({
  children,
}: {
  children: ReactNode;
}) {
  const client = useQueryClient();
  const pathname = usePathname();
  const [accountDraft] = useState(createAccountDraftStore);
  const previousPathname = useRef(pathname);
  if (previousPathname.current !== pathname) {
    accountDraft.clear();
    previousPathname.current = pathname;
  }
  const guestRouteRef = useRef(isGuestRoute(routeAccessPolicy(pathname)));
  guestRouteRef.current = isGuestRoute(routeAccessPolicy(pathname));
  const [state, setState] = useState<SessionLifecycleState>({
    generation: 0,
    suspended: false,
    unauthorized: false,
    authenticatedActorId: null,
  });
  const suspended = useRef(false);
  const authenticatedActor = useRef<string | null>(null);
  const reconcileAuthenticatedActor = useCallback(
    (actorId: string) => {
      if (authenticatedActor.current === actorId) return;
      const changed = authenticatedActor.current !== null;
      authenticatedActor.current = actorId;
      if (changed) {
        accountDraft.clear();
        clearContinuation();
        discardPrivateSession(client);
      }
      // Called from the shell's pre-paint authority boundary. Do not flushSync
      // inside a React lifecycle; its layout update already blocks private paint.
      setState((previous) => ({
        ...previous,
        authenticatedActorId: actorId,
        generation: previous.generation + (changed ? 1 : 0),
      }));
    },
    [accountDraft, client],
  );
  const acknowledgeFreshAuthenticatedContext = useCallback(() => {
    // Clear the 401 recovery latch only after a fresh authenticated
    // access-context response has been validated by the guest-entry guard.
    setState((previous) =>
      previous.unauthorized ? { ...previous, unauthorized: false } : previous,
    );
  }, []);
  useEffect(() => {
    let channel: BroadcastChannel | undefined;
    let lastHint: string | undefined;
    let lostFocus = false;
    // Initial focus is not a session transition. Do not throw away an
    // in-flight/failed first access-context request just because the new tab focused.
    let lastResume = performance.now();
    try {
      channel = new BroadcastChannel(SESSION_CHANNEL);
    } catch {
      /* Storage/focus fallback. */
    }

    const reset = (unauthorized = false, preserveAccountDraft = false) => {
      if (!preserveAccountDraft) {
        accountDraft.clear();
        authenticatedActor.current = null;
      }
      discardPrivateSession(client);
      flushSync(() =>
        setState((previous) => ({
          generation: previous.generation + 1,
          suspended: suspended.current,
          unauthorized,
          authenticatedActorId: authenticatedActor.current,
        })),
      );
    };
    const receive = (value: unknown) => {
      if (!isSessionChangeHint(value) || value.id === lastHint) return;
      lastHint = value.id;
      clearContinuation();
      // A received hint is never rebroadcast or treated as authenticated state.
      reset();
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key !== SESSION_CHANNEL || !event.newValue) return;
      try {
        receive(JSON.parse(event.newValue));
      } catch {
        /* Ignore malformed hints. */
      }
    };
    const onMessage = (event: MessageEvent<unknown>) => receive(event.data);
    const onChange = () => {
      const hint: SessionChangeHint = {
        version: 1,
        type: "session-change",
        id: crypto.randomUUID(),
      };
      lastHint = hint.id;
      reset();
      try {
        channel?.postMessage(hint);
      } catch {
        /* Storage/focus fallback. */
      }
      try {
        localStorage.setItem(SESSION_CHANNEL, JSON.stringify(hint));
      } catch {
        /* Focus remains available without storage. */
      }
    };
    const onUnauthorized = () => {
      clearContinuation();
      reset(true);
    };
    const suspend = () => {
      if (suspended.current) return;
      suspended.current = true;
      // Anonymous auth drafts are not private session data. Do not remount
      // their forms simply because the user opened a different window.
      if (!guestRouteRef.current) reset(false, true);
    };
    const resume = (force = false) => {
      if (document.visibilityState === "hidden") return;
      const wasSuspended = suspended.current;
      suspended.current = false;
      // Coalesce the focus/visibility/pageshow burst, not session-change hints.
      if (
        !wasSuspended &&
        !force &&
        (performance.now() - lastResume < 500 ||
          client.isFetching({ queryKey: ["access-context"] }) > 0)
      )
        return;
      lastResume = performance.now();
      if (guestRouteRef.current) {
        // Discard old private responses without resetting the rendered
        // guest form. Authority is still checked against the backend.
        discardPrivateSession(client);
        flushSync(() =>
          setState((previous) => ({ ...previous, suspended: false })),
        );
        return;
      }
      reset(false, true);
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted || suspended.current) resume(event.persisted);
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") suspend();
      else resume();
    };
    const onBlur = () => {
      lostFocus = true;
    };
    const onFocus = () => {
      // Browsers fire an initial focus event as the document mounts. Only a
      // real blur -> focus transition implies possible cookie/actor changes.
      if (!lostFocus) return;
      lostFocus = false;
      resume(true);
    };
    channel?.addEventListener("message", onMessage);
    window.addEventListener("storage", onStorage);
    window.addEventListener(SESSION_CHANGE_EVENT, onChange);
    window.addEventListener(SESSION_UNAUTHORIZED_EVENT, onUnauthorized);
    window.addEventListener("pagehide", suspend);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      channel?.removeEventListener("message", onMessage);
      channel?.close();
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(SESSION_CHANGE_EVENT, onChange);
      window.removeEventListener(SESSION_UNAUTHORIZED_EVENT, onUnauthorized);
      window.removeEventListener("pagehide", suspend);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      // StrictMode replays effect cleanup during initial mount. Purging the
      // shared QueryClient here would cancel the first access-context request
      // and silently issue another request before the guest can retry.
      // Explicit session events and pagehide still purge private authority.
    };
  }, [client, accountDraft]);
  return (
    <SessionLifecycleContext.Provider
      value={{
        ...state,
        acknowledgeFreshAuthenticatedContext,
        reconcileAccountDraft: accountDraft.reconcile,
        reconcileAuthenticatedActor,
      }}
    >
      <AccountDraftContext.Provider value={accountDraft}>
        {children}
      </AccountDraftContext.Provider>
    </SessionLifecycleContext.Provider>
  );
}
