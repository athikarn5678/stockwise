"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import {
  BILLING_CHANGED_EVENT,
  getBilling,
  type BillingState,
} from "@/billing-api-client";
import { SUBSCRIPTION_REQUIRED_EVENT } from "@/session-lifecycle";

export type SubscriptionContextValue = Readonly<{
  /** Silent summary: null while loading, disabled, or after any failure. */
  billing: BillingState | null;
  /** True only when the API reports the organization EXPIRED (writes are refused). */
  readOnly: boolean;
  /** True after a write was refused with 402, until dismissed or the plan is renewed. */
  refusedNotice: boolean;
  dismissRefusedNotice: () => void;
}>;

const SubscriptionContext = createContext<SubscriptionContextValue>({
  billing: null,
  dismissRefusedNotice: () => undefined,
  readOnly: false,
  refusedNotice: false,
});

/**
 * One billing summary per signed-in organization, shared by the plan badge,
 * the banners and every action that must not be offered while the subscription
 * is expired. Deliberately not a TanStack query: any failure (403, disabled,
 * network) simply yields no banner and leaves the API as the only enforcer.
 */
export function SubscriptionProvider({
  children,
  organizationId,
}: {
  children: ReactNode;
  organizationId: string | undefined;
}) {
  const [state, setState] = useState<{
    billing: BillingState;
    organizationId: string;
  } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [refusedNotice, setRefusedNotice] = useState(false);
  const bump = useCallback(() => setRefresh((value) => value + 1), []);
  const onRefused = useCallback(() => {
    setRefusedNotice(true);
    bump();
  }, [bump]);
  const dismissRefusedNotice = useCallback(() => setRefusedNotice(false), []);

  useEffect(() => {
    // A confirmed payment and a 402 answer both mean the state just changed.
    const onBillingChanged = () => {
      setRefusedNotice(false);
      bump();
    };
    window.addEventListener(BILLING_CHANGED_EVENT, onBillingChanged);
    window.addEventListener(SUBSCRIPTION_REQUIRED_EVENT, onRefused);
    return () => {
      window.removeEventListener(BILLING_CHANGED_EVENT, onBillingChanged);
      window.removeEventListener(SUBSCRIPTION_REQUIRED_EVENT, onRefused);
    };
  }, [bump, onRefused]);

  useEffect(() => {
    if (organizationId === undefined) return;
    const controller = new AbortController();
    getBilling(organizationId, controller.signal).then(
      (billing) => setState({ billing, organizationId }),
      () => undefined,
    );
    return () => controller.abort();
  }, [organizationId, refresh]);

  const value = useMemo<SubscriptionContextValue>(() => {
    const billing =
      state !== null && state.organizationId === organizationId
        ? state.billing
        : null;
    return {
      billing,
      dismissRefusedNotice,
      readOnly: billing?.access?.state === "EXPIRED",
      refusedNotice,
    };
  }, [state, organizationId, refusedNotice, dismissRefusedNotice]);

  return (
    <SubscriptionContext.Provider value={value}>
      {children}
    </SubscriptionContext.Provider>
  );
}

export function useSubscription(): SubscriptionContextValue {
  return useContext(SubscriptionContext);
}

/**
 * The one hook every primary create/edit/checkout action uses:
 * `disabled={... || writeBlocked}`. It only hides the affordance; the API
 * answers 402 SUBSCRIPTION_REQUIRED for the same request regardless.
 */
export function useSubscriptionWriteGate(): { writeBlocked: boolean } {
  return { writeBlocked: useSubscription().readOnly };
}
