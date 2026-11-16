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
  currentPrivateSessionSignal,
  discardPrivateSession,
  isSessionChangeHint,
  SESSION_CHANNEL,
  SESSION_CHANGE_EVENT,
  SESSION_UNAUTHORIZED_EVENT,
  type SessionChangeHint,
} from "@/session-lifecycle";
import { clearInvitationContinuation } from "@/invitation-continuation";
import { isGuestRoute, routeAccessPolicy } from "@/route-access-policy";
import { clearContinuation } from "@/verification-continuation-browser";
import { AccountDraftContext, createAccountDraftStore } from "./account-draft";
import {
  BranchApiError,
  fetchAccessContext,
  type AccessContext,
} from "@/branch-api-client";
import { accessAuthoritySignature } from "@/access-authority";

/**
 * How long a resumed screen may stay mounted while its authority cannot be
 * confirmed (ADR-044). A longer absence fails closed with a full reset.
 */
export const UNCONFIRMED_HIDDEN_LIMIT_MS = 5 * 60_000;

/**
 * Upper bound for one silent revalidation request. A hung request would
 * otherwise hold the in-flight guard forever and block every later resume.
 * Expiry is an unconfirmed result, not a reset (ADR-044).
 */
export const REVALIDATION_TIMEOUT_MS = 15_000;

interface SessionLifecycleState {
  generation: number;
  suspended: boolean;
  unauthorized: boolean;
  authenticatedActorId: string | null;
  /**
   * Start sequence of the latest resume revalidation that confirmed an equal
   * authority signature (ADR-044), 0 when none. Consumers holding a denied
   * state can clear it once a check that began after the denial confirms the
   * authority unchanged. Resets never roll it back.
   */
  confirmedAuthority: number;
}
interface SessionLifecycleValue extends SessionLifecycleState {
  /**
   * Sequence number of the most recently started resume revalidation (0 when
   * none). `confirmedAuthority` carries the sequence of the confirmed check, so
   * a consumer that was denied at sequence N only accepts a confirmation > N,
   * i.e. one that began after the denial.
   */
  currentRevalidationSequence: () => number;
  acknowledgeFreshAuthenticatedContext: () => void;
  reconcileAccountDraft: (context: AccessContext | null) => void;
  reconcileAuthenticatedActor: (actorId: string) => void;
}
const SessionLifecycleContext = createContext<SessionLifecycleValue>({
  generation: 0,
  suspended: false,
  unauthorized: false,
  authenticatedActorId: null,
  confirmedAuthority: 0,
  currentRevalidationSequence: () => 0,
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
  // Marketing pages mount no private document, so their lifecycle handling
  // stays exactly as before: no access-context revalidation request.
  const publicRouteRef = useRef(
    routeAccessPolicy(pathname) === "public-marketing",
  );
  publicRouteRef.current = routeAccessPolicy(pathname) === "public-marketing";
  const [state, setState] = useState<SessionLifecycleState>({
    generation: 0,
    suspended: false,
    unauthorized: false,
    authenticatedActorId: null,
    confirmedAuthority: 0,
  });
  const suspended = useRef(false);
  const revalidationSequence = useRef(0);
  const currentRevalidationSequence = useCallback(
    () => revalidationSequence.current,
    [],
  );
  const authenticatedActor = useRef<string | null>(null);
  const reconcileAuthenticatedActor = useCallback(
    (actorId: string) => {
      if (authenticatedActor.current === actorId) return;
      const changed = authenticatedActor.current !== null;
      authenticatedActor.current = actorId;
      if (changed) {
        clearContinuation();
        clearInvitationContinuation();
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
    // First departure (hidden or blur) since the last confirmed authority.
    // Bounds how long an unconfirmed private screen may stay mounted (ADR-044).
    let leftAt: number | undefined;
    // Only pagehide/back-forward-cache must still tear the tree down: the
    // frozen page receives no session hint and must not hold private data.
    // A plain hidden/blurred tab keeps the mounted screen.
    let suspendedByPagehide = false;
    // Bumped by every reset so a revalidation that raced a purge is ignored.
    let epoch = 0;
    let revalidation: object | undefined;
    // Initial focus is not a session transition. Do not throw away an
    // in-flight/failed first access-context request just because the new tab focused.
    let lastResume = performance.now();
    try {
      channel = new BroadcastChannel(SESSION_CHANNEL);
    } catch {
      /* Storage/focus fallback. */
    }

    const reset = (unauthorized = false, preserveAccountDraft = false) => {
      epoch += 1;
      leftAt = undefined;
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
          // A reset is not a confirmation: keep the counter monotonic so
          // consumers never see a spurious change.
          confirmedAuthority: previous.confirmedAuthority,
        })),
      );
    };
    const receive = (value: unknown) => {
      if (!isSessionChangeHint(value) || value.id === lastHint) return;
      lastHint = value.id;
      clearContinuation();
      clearInvitationContinuation();
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
      clearInvitationContinuation();
      reset(true);
    };
    const markLeft = () => {
      if (leftAt === undefined) leftAt = Date.now();
    };
    const suspendByPagehide = () => {
      if (suspended.current) return;
      suspended.current = true;
      suspendedByPagehide = true;
      // Anonymous auth drafts are not private session data. Do not remount
      // their forms simply because the user opened a different window.
      if (!guestRouteRef.current) reset(false, true);
    };
    /**
     * Silent revalidation (ADR-044): keep the mounted private screen and
     * confirm its authority without a visible query refetch. Reset only when
     * the actor, role, organization or branch scope changed, or cannot be
     * confirmed after a bounded absence.
     */
    const revalidate = () => {
      if (revalidation !== undefined) return;
      const cached = client.getQueryData<AccessContext>(["access-context"]);
      const settled =
        cached !== undefined &&
        client.getQueryState(["access-context"])?.status === "success";
      if (!settled || publicRouteRef.current) {
        // Nothing private is mounted: keep the previous reset-and-refetch.
        reset(false, true);
        return;
      }
      const token = {};
      revalidation = token;
      const requestEpoch = epoch;
      revalidationSequence.current += 1;
      const sequence = revalidationSequence.current;
      // privateFetch already joins the private-session signal; this controller
      // only adds the bound so a hung request cannot hold the guard forever.
      const sessionSignal = currentPrivateSessionSignal();
      const bound = new AbortController();
      const timer = setTimeout(() => bound.abort(), REVALIDATION_TIMEOUT_MS);
      void (async () => {
        try {
          const fresh = await fetchAccessContext({ signal: bound.signal });
          // A reset (hint, 401, pagehide, another mismatch) supersedes us, and
          // so does any private-session discard, even one that kept the epoch.
          if (requestEpoch !== epoch || sessionSignal.aborted) return;
          // Compare with the cache as it is now: a local mutation may have
          // refreshed access-context while this request was in flight.
          const baseline =
            client.getQueryData<AccessContext>(["access-context"]) ?? cached;
          if (
            accessAuthoritySignature(baseline) ===
            accessAuthoritySignature(fresh)
          ) {
            client.setQueryData(["access-context"], fresh);
            leftAt = undefined;
            // Same actor/role/organization/scope confirmed: signal consumers
            // that a denied state may be released.
            setState((previous) => ({
              ...previous,
              confirmedAuthority: Math.max(
                previous.confirmedAuthority,
                sequence,
              ),
            }));
            return;
          }
          reset();
        } catch (error) {
          // An abort caused by logout/reset/discard is not "unconfirmed": the
          // session it belonged to is gone. Only our own timeout, a network
          // error or a 5xx falls through to the unconfirmed path below.
          if (requestEpoch !== epoch || sessionSignal.aborted) return;
          if (
            error instanceof BranchApiError &&
            (error.kind === "authentication_required" ||
              error.kind === "forbidden")
          ) {
            reset();
            return;
          }
          // Network/5xx/timeout: authority cannot be confirmed. Keep the
          // screen for a short absence and retry on the next resume or the
          // next `online` event; fail closed after a longer one.
          if (leftAt !== undefined) {
            const away = Date.now() - leftAt;
            // A negative duration means the clock moved backwards: the real
            // absence is unknown, so fail closed.
            if (away < 0 || away > UNCONFIRMED_HIDDEN_LIMIT_MS) reset();
          }
        } finally {
          clearTimeout(timer);
          if (revalidation === token) revalidation = undefined;
        }
      })();
    };
    const resume = (force = false, fullReset = false) => {
      if (document.visibilityState === "hidden") return;
      const wasSuspended = suspended.current;
      const fromPagehide = suspendedByPagehide;
      suspended.current = false;
      suspendedByPagehide = false;
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
        // Unchanged: guest drafts survive the transition, old private
        // responses are discarded and authority is still checked by the API.
        discardPrivateSession(client);
        flushSync(() =>
          setState((previous) => ({ ...previous, suspended: false })),
        );
        return;
      }
      if (fromPagehide || fullReset) {
        // bfcache/back-forward restore keeps the previous full teardown.
        reset(false, true);
        return;
      }
      revalidate();
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted || suspended.current || suspendedByPagehide)
        resume(event.persisted, event.persisted);
    };
    const onPageHide = () => {
      markLeft();
      suspendByPagehide();
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        // Keep the mounted screen; returning revalidates silently.
        markLeft();
        return;
      }
      resume();
    };
    const onBlur = () => {
      lostFocus = true;
      markLeft();
    };
    const onFocus = () => {
      // Browsers fire an initial focus event as the document mounts. Only a
      // real blur -> focus transition implies possible cookie/actor changes.
      if (!lostFocus) return;
      lostFocus = false;
      resume(true);
    };
    const onOnline = () => {
      // Retry an unconfirmed revalidation without tearing the screen down.
      if (guestRouteRef.current || publicRouteRef.current) return;
      // Only a mounted, settled private screen has anything to retry.
      if (client.getQueryState(["access-context"])?.status !== "success")
        return;
      revalidate();
    };
    channel?.addEventListener("message", onMessage);
    window.addEventListener("storage", onStorage);
    window.addEventListener(SESSION_CHANGE_EVENT, onChange);
    window.addEventListener(SESSION_UNAUTHORIZED_EVENT, onUnauthorized);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      channel?.removeEventListener("message", onMessage);
      channel?.close();
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(SESSION_CHANGE_EVENT, onChange);
      window.removeEventListener(SESSION_UNAUTHORIZED_EVENT, onUnauthorized);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onOnline);
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
        currentRevalidationSequence,
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
