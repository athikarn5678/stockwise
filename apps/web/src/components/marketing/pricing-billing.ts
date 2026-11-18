"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  BILLING_CHANGED_EVENT,
  BillingApiError,
  getBilling,
  postCheckout,
  postConfirm,
  type BillingInterval,
  type BillingPlan,
  type BillingState,
  type BillingSubscription,
} from "@/billing-api-client";
import type { AccessibleOrganization } from "@/branch-api-client";
import type { TranslationKey } from "@/i18n/en";
import { useMarketingSession } from "./use-marketing-session";

const STRIPE_CHECKOUT_URL = /^https:\/\/checkout\.stripe\.com\//;

export type PricingMode =
  "loading" | "guest" | "no-organization" | "non-owner" | "owner";

/** The organization a signed-in visitor subscribes for: the requested one, else the first they own. */
export function pickOrganization(
  organizations: readonly AccessibleOrganization[],
  requestedId: string | null,
): AccessibleOrganization | null {
  const requested = organizations.find(({ id }) => id === requestedId);
  return (
    requested ??
    organizations.find(({ role }) => role === "OWNER") ??
    organizations[0] ??
    null
  );
}

function checkoutMessage(error: unknown): TranslationKey {
  if (error instanceof BillingApiError) {
    if (error.status === 403) return "billingDenied";
    if (error.status === 404) return "billingUnavailable";
    if (error.status === 409) return "billingErrConflict";
    if (error.status === 502) return "billingErrProvider";
  }
  return "billingErrCheckout";
}

function confirmMessage(error: unknown): TranslationKey {
  if (error instanceof BillingApiError) {
    if (error.status === 403) return "billingErrConfirmForbidden";
    if (error.status === 409)
      return error.code === "CHECKOUT_NOT_COMPLETE"
        ? "billingErrNotComplete"
        : "billingErrConflict";
    if (error.status === 502) return "billingErrProvider";
  }
  return "billingErrConfirm";
}

export type PricingBilling = Readonly<{
  billing: BillingState | null;
  billingFailed: boolean;
  canceled: boolean;
  /** Plan currently paid for (access ACTIVE), else null. */
  currentPlan: BillingPlan | null;
  confirmed: BillingSubscription | null;
  confirming: boolean;
  error: TranslationKey | null;
  mode: PricingMode;
  organization: AccessibleOrganization | null;
  /** True when this visitor may start a Checkout right now. */
  canSubscribe: boolean;
  subscribe: (plan: BillingPlan, interval: BillingInterval) => Promise<void>;
  subscribing: BillingPlan | null;
  subscription: BillingSubscription | null;
}>;

/**
 * Everything /pricing needs to be the only place to subscribe or renew:
 * who is looking (guest / member / owner), the organization's plan and access,
 * the Stripe redirect and the confirmation after Stripe returns. The API
 * enforces OWNER-only checkout; this hook only decides what to offer.
 */
export function usePricingBilling(
  navigate: (url: string) => void = (url) => window.location.assign(url),
): PricingBilling {
  const session = useMarketingSession();
  const searchParams = useSearchParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const requestedOrganizationId = searchParams.get("organizationId");
  const sessionId = searchParams.get("session_id");
  const canceled = searchParams.get("canceled") === "1";
  const organization =
    session.status === "signedIn"
      ? pickOrganization(session.context.organizations, requestedOrganizationId)
      : null;
  const mode: PricingMode =
    session.status === "loading"
      ? "loading"
      : session.status === "guest"
        ? "guest"
        : organization === null
          ? "no-organization"
          : organization.role === "OWNER"
            ? "owner"
            : "non-owner";

  const billingQuery = useQuery({
    enabled: organization !== null,
    queryFn: ({ signal }) => getBilling(organization!.id, signal),
    queryKey: ["billing", organization?.id ?? null],
    retry: false,
  });
  const [confirmed, setConfirmed] = useState<BillingSubscription | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<TranslationKey | null>(null);
  const [subscribing, setSubscribing] = useState<BillingPlan | null>(null);
  const attempted = useRef<string | null>(null);
  const ownerOrganizationId = mode === "owner" ? organization!.id : null;

  useEffect(() => {
    // One confirmation per Checkout Session, StrictMode effect replays included.
    if (
      sessionId === null ||
      ownerOrganizationId === null ||
      // Never confirm a session against a different organization than the one
      // the Stripe return link names.
      (requestedOrganizationId !== null &&
        requestedOrganizationId !== ownerOrganizationId) ||
      attempted.current === sessionId
    )
      return;
    attempted.current = sessionId;
    setConfirming(true);
    setError(null);
    postConfirm(ownerOrganizationId, sessionId).then(
      (subscription) => {
        setConfirmed(subscription);
        setConfirming(false);
        void queryClient.invalidateQueries({ queryKey: ["billing"] });
        window.dispatchEvent(new Event(BILLING_CHANGED_EVENT));
        router.replace(`/pricing?organizationId=${ownerOrganizationId}`);
      },
      (cause: unknown) => {
        setConfirming(false);
        setError(confirmMessage(cause));
      },
    );
  }, [
    ownerOrganizationId,
    queryClient,
    requestedOrganizationId,
    router,
    sessionId,
  ]);

  const subscribe = useCallback(
    async (plan: BillingPlan, interval: BillingInterval) => {
      if (ownerOrganizationId === null) return;
      setError(null);
      setSubscribing(plan);
      try {
        const url = await postCheckout(ownerOrganizationId, plan, interval);
        if (!STRIPE_CHECKOUT_URL.test(url)) {
          setError("billingErrUntrustedRedirect");
          return;
        }
        navigate(url);
      } catch (cause) {
        setError(checkoutMessage(cause));
      } finally {
        setSubscribing(null);
      }
    },
    [navigate, ownerOrganizationId],
  );

  const billing = billingQuery.data ?? null;
  const subscription = billing?.subscription ?? confirmed;
  const active = confirmed !== null || billing?.access?.state === "ACTIVE";
  return {
    billing,
    billingFailed: billingQuery.isError,
    canSubscribe:
      mode === "owner" && billing?.enabled === true && !active && !confirming,
    canceled,
    confirmed,
    confirming,
    currentPlan: active ? (subscription?.plan ?? null) : null,
    error,
    mode,
    organization,
    subscribe,
    subscribing,
    subscription,
  };
}
