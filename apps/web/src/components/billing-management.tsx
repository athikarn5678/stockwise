"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { resolveApplicationContext } from "@/application-context";
import {
  BILLING_CHANGED_EVENT,
  BillingApiError,
  getBilling,
  postCheckout,
  postConfirm,
  type BillingPlan,
  type BillingSubscription,
} from "@/billing-api-client";
import { fetchAccessContext } from "@/branch-api-client";
import { plans } from "@/components/marketing/pricing-content";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from "@/components/ui/card";
import type { TranslationKey } from "@/i18n/en";
import { useLanguage } from "@/providers/language-provider";

const STRIPE_CHECKOUT_URL = /^https:\/\/checkout\.stripe\.com\//;

const PLAN_KEYS: Record<(typeof plans)[number]["name"], BillingPlan> = {
  Business: "BUSINESS",
  Growth: "GROWTH",
  Starter: "STARTER",
};

const PLAN_LABELS: Record<BillingPlan, TranslationKey> = {
  BUSINESS: "billingPlanBusiness",
  GROWTH: "billingPlanGrowth",
  STARTER: "billingPlanStarter",
};

const STATUS_LABELS: Record<BillingSubscription["status"], TranslationKey> = {
  ACTIVE: "billingStatusActive",
  CANCELED: "billingStatusCanceled",
  PAST_DUE: "billingStatusPastDue",
};

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

export function BillingManagement() {
  const { t } = useLanguage();
  const searchParams = useSearchParams();
  const organizationId = searchParams.get("organizationId");
  const accessQuery = useQuery({
    queryKey: ["access-context"],
    queryFn: ({ signal }) => fetchAccessContext({ signal }),
    retry: false,
  });
  const organization =
    organizationId && accessQuery.data
      ? resolveApplicationContext(accessQuery.data, organizationId, null)
          .organization
      : null;

  if (accessQuery.isPending)
    return <p aria-live="polite">{t("billingLoading")}</p>;
  if (accessQuery.isError)
    return (
      <section className="w-full max-w-2xl space-y-4">
        <p role="alert">{t("billingLoadError")}</p>
        <Button type="button" onClick={() => void accessQuery.refetch()}>
          {t("billingRetry")}
        </Button>
      </section>
    );
  if (!organizationId || !organization)
    return <p role="alert">{t("billingLoadError")}</p>;
  if (organization.role !== "OWNER")
    return <p role="alert">{t("billingDenied")}</p>;

  return (
    <BillingContent
      key={organization.id}
      canceled={searchParams.get("canceled") === "1"}
      organizationId={organization.id}
      sessionId={searchParams.get("session_id")}
    />
  );
}

export function BillingManagementFallback() {
  const { t } = useLanguage();
  return <p aria-live="polite">{t("billingLoading")}</p>;
}

export function BillingContent({
  canceled = false,
  navigate = (url: string) => window.location.assign(url),
  organizationId,
  sessionId,
}: {
  canceled?: boolean;
  /** Test seam: the browser redirect to Stripe's hosted page. */
  navigate?: (url: string) => void;
  organizationId: string;
  sessionId: string | null;
}) {
  const { t } = useLanguage();
  const queryClient = useQueryClient();
  const router = useRouter();
  const billingQuery = useQuery({
    queryKey: ["billing", organizationId],
    queryFn: ({ signal }) => getBilling(organizationId, signal),
    retry: false,
  });
  const [confirmed, setConfirmed] = useState<BillingSubscription | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<TranslationKey | null>(null);
  const [checkoutError, setCheckoutError] = useState<TranslationKey | null>(
    null,
  );
  const [subscribing, setSubscribing] = useState<BillingPlan | null>(null);
  const attempted = useRef<string | null>(null);

  useEffect(() => {
    // One confirmation per Checkout Session, StrictMode effect replays included.
    if (sessionId === null || attempted.current === sessionId) return;
    attempted.current = sessionId;
    setConfirming(true);
    setConfirmError(null);
    postConfirm(organizationId, sessionId).then(
      (subscription) => {
        setConfirmed(subscription);
        setConfirming(false);
        void queryClient.invalidateQueries({
          queryKey: ["billing", organizationId],
        });
        window.dispatchEvent(new Event(BILLING_CHANGED_EVENT));
        router.replace(`/app/billing?organizationId=${organizationId}`);
      },
      (error: unknown) => {
        setConfirming(false);
        setConfirmError(confirmMessage(error));
      },
    );
  }, [organizationId, queryClient, router, sessionId]);

  async function subscribe(plan: BillingPlan) {
    setCheckoutError(null);
    setSubscribing(plan);
    try {
      const url = await postCheckout(organizationId, plan);
      if (!STRIPE_CHECKOUT_URL.test(url)) {
        setCheckoutError("billingErrUntrustedRedirect");
        return;
      }
      navigate(url);
    } catch (error) {
      setCheckoutError(checkoutMessage(error));
    } finally {
      setSubscribing(null);
    }
  }

  if (billingQuery.isPending)
    return <p aria-live="polite">{t("billingLoading")}</p>;
  if (billingQuery.isError)
    return (
      <section className="w-full max-w-2xl space-y-4">
        <p role="alert">
          {billingQuery.error instanceof BillingApiError &&
          billingQuery.error.status === 403
            ? t("billingDenied")
            : t("billingLoadError")}
        </p>
        <Button type="button" onClick={() => void billingQuery.refetch()}>
          {t("billingRetry")}
        </Button>
      </section>
    );

  const billing = billingQuery.data;
  const subscription = billing.subscription ?? confirmed;

  if (!billing.enabled)
    return (
      <section className="w-full max-w-2xl space-y-4">
        <h2 className="text-xl font-semibold">{t("billing")}</h2>
        <p role="status">{t("billingUnavailable")}</p>
      </section>
    );

  return (
    <section aria-label={t("billing")} className="w-full max-w-5xl space-y-6">
      <div>
        <h2 className="text-xl font-semibold">{t("billing")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("billingDescription")}
        </p>
      </div>

      {canceled ? <p role="status">{t("billingCanceledNote")}</p> : null}
      {confirming ? <p aria-live="polite">{t("billingConfirming")}</p> : null}
      {confirmError ? <p role="alert">{t(confirmError)}</p> : null}
      {confirmed ? (
        <p className="rounded-lg border bg-card p-4" role="status">
          {t("billingConfirmed").replace(
            "{plan}",
            t(PLAN_LABELS[confirmed.plan]),
          )}
        </p>
      ) : null}

      {subscription ? (
        <p className="font-medium">
          {t("billingCurrentPlan")
            .replace("{plan}", t(PLAN_LABELS[subscription.plan]))
            .replace("{status}", t(STATUS_LABELS[subscription.status]))}
        </p>
      ) : null}

      {checkoutError ? <p role="alert">{t(checkoutError)}</p> : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {plans.map((plan) => {
          const planKey = PLAN_KEYS[plan.name];
          return (
            <Card key={plan.name} className="flex h-full flex-col">
              <CardHeader>
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-lg font-semibold">
                    {t(PLAN_LABELS[planKey])}
                  </h3>
                  {subscription?.plan === planKey ? (
                    <Badge variant="secondary">
                      {t(STATUS_LABELS[subscription.status])}
                    </Badge>
                  ) : null}
                </div>
                <CardDescription>
                  {`THB ${plan.monthly} ${t("billingPerMonth")}`}
                </CardDescription>
              </CardHeader>
              <CardContent className="mt-auto">
                <Button
                  className="w-full"
                  disabled={subscription !== null || subscribing !== null}
                  onClick={() => void subscribe(planKey)}
                  type="button"
                >
                  {subscribing === planKey
                    ? t("billingSubscribing")
                    : t("billingSubscribe")}
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </section>
  );
}
