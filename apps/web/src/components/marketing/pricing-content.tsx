"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowRight, Check } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import type { TranslationKey } from "@/i18n/en";
import { useLanguage } from "@/providers/language-provider";
import type { BillingPlan } from "@/billing-api-client";
import { loginUrlWithNext } from "@/safe-next";
import { usePricingBilling } from "./pricing-billing";

export const plans = [
  {
    name: "Starter",
    audience: "pricingStarterAudience",
    focus: "pricingStarterFocus",
    features: [
      "pricingStarterFeature1",
      "pricingStarterFeature2",
      "pricingStarterFeature3",
      "pricingStarterFeature4",
    ],
    branches: "pricingStarterBranches",
    users: "pricingStarterUsers",
    monthly: 199,
    yearly: 1990,
  },
  {
    name: "Growth",
    audience: "pricingGrowthAudience",
    focus: "pricingGrowthFocus",
    features: [
      "pricingGrowthFeature1",
      "pricingGrowthFeature2",
      "pricingGrowthFeature3",
      "pricingGrowthFeature4",
    ],
    branches: "pricingGrowthBranches",
    users: "pricingGrowthUsers",
    monthly: 499,
    yearly: 4990,
  },
  {
    name: "Business",
    audience: "pricingBusinessAudience",
    focus: "pricingBusinessFocus",
    features: [
      "pricingBusinessFeature1",
      "pricingBusinessFeature2",
      "pricingBusinessFeature3",
      "pricingBusinessFeature4",
    ],
    branches: "pricingBusinessBranches",
    users: "pricingBusinessUsers",
    monthly: 999,
    yearly: 9990,
  },
] as const;

function planLabel(plan: BillingPlan, t: (key: TranslationKey) => string) {
  return t(
    plan === "STARTER"
      ? "billingPlanStarter"
      : plan === "GROWTH"
        ? "billingPlanGrowth"
        : "billingPlanBusiness",
  );
}

function PlanAction({
  billingPeriod,
  plan,
  pricing,
}: {
  billingPeriod: "monthly" | "yearly";
  plan: BillingPlan;
  pricing: ReturnType<typeof usePricingBilling>;
}) {
  const { t } = useLanguage();
  const className = "mt-auto";
  if (pricing.mode === "loading")
    return (
      <Button className={className} disabled type="button" variant="outline">
        {t("billingLoading")}
      </Button>
    );
  if (pricing.mode === "guest")
    return (
      <Button
        className={className}
        nativeButton={false}
        render={<Link href={loginUrlWithNext("/pricing")} />}
        role="link"
        variant="outline"
      >
        {t("pricingSignInToSubscribe")}
        <ArrowRight aria-hidden="true" />
      </Button>
    );
  if (pricing.mode === "no-organization")
    return (
      <Button
        className={className}
        nativeButton={false}
        render={<Link href="/onboarding" />}
        role="link"
        variant="outline"
      >
        {t("pricingSetUpStore")}
        <ArrowRight aria-hidden="true" />
      </Button>
    );
  // The active plan is shown by the panel above and its highlighted card: no
  // button-like control that would read as a disabled Subscribe.
  if (pricing.currentPlan === plan) return null;
  return (
    <Button
      className={className}
      disabled={!pricing.canSubscribe || pricing.subscribing !== null}
      onClick={() =>
        void pricing.subscribe(
          plan,
          billingPeriod === "yearly" ? "YEAR" : "MONTH",
        )
      }
      type="button"
      variant="outline"
    >
      {pricing.subscribing === plan
        ? t("billingSubscribing")
        : t("billingSubscribe")}
    </Button>
  );
}

const enterprise = {
  audience: "pricingEnterpriseAudience",
  focus: "pricingEnterpriseFocus",
  branches: "pricingEnterpriseBranches",
  users: "pricingEnterpriseUsers",
} as const;

const PLAN_KEYS: Record<(typeof plans)[number]["name"], BillingPlan> = {
  Business: "BUSINESS",
  Growth: "GROWTH",
  Starter: "STARTER",
};

export function PricingContent({
  navigate,
}: {
  /** Test seam: the browser redirect to Stripe's hosted page. */
  navigate?: (url: string) => void;
} = {}) {
  const { t } = useLanguage();
  const pricing = usePricingBilling(navigate);
  const [billingPeriod, setBillingPeriod] = useState<"monthly" | "yearly">(
    "monthly",
  );

  return (
    <div className="mx-auto max-w-7xl px-5 py-16 sm:px-8">
      <section
        aria-labelledby="pricing-title"
        className="mx-auto max-w-2xl text-center"
      >
        <Badge variant="outline">{t("pricingBadge")}</Badge>
        <h1
          id="pricing-title"
          className="mt-5 text-4xl font-semibold tracking-tight sm:text-5xl"
        >
          {t("pricingTitle")}
        </h1>
        <p className="mt-5 leading-7 text-muted-foreground">
          {t("pricingIntro")}
        </p>
      </section>
      <div className="mb-6 mt-10 flex justify-center">
        <div
          aria-label={t("pricingBillingPeriod")}
          className="inline-flex rounded-lg border p-1"
          role="group"
        >
          <button
            type="button"
            aria-pressed={billingPeriod === "monthly"}
            onClick={() => setBillingPeriod("monthly")}
            className={`rounded-md px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
              billingPeriod === "monthly"
                ? "bg-primary text-primary-foreground"
                : "hover:bg-muted"
            }`}
          >
            {t("pricingMonthly")}
          </button>
          <button
            type="button"
            aria-pressed={billingPeriod === "yearly"}
            onClick={() => setBillingPeriod("yearly")}
            className={`rounded-md px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
              billingPeriod === "yearly"
                ? "bg-primary text-primary-foreground"
                : "hover:bg-muted"
            }`}
          >
            {t("pricingYearly")}
          </button>
        </div>
      </div>
      {pricing.currentPlan !== null && pricing.subscription !== null ? (
        <div
          className="mx-auto mb-6 flex max-w-xl items-center gap-4 rounded-xl border-2 border-primary bg-primary/5 p-5 text-left"
          data-testid="active-plan-panel"
          role="status"
        >
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <Check aria-hidden="true" className="size-5" />
          </span>
          <div className="min-w-0">
            <p className="text-lg font-semibold">
              {t("pricingActivePanelTitle")}
            </p>
            <p className="text-sm text-muted-foreground">
              {t("pricingActivePanelBody")
                .replace("{plan}", planLabel(pricing.currentPlan, t))
                .replace(
                  "{period}",
                  t(
                    pricing.subscription.interval === "YEAR"
                      ? "pricingYearly"
                      : "pricingMonthly",
                  ),
                )}
            </p>
          </div>
        </div>
      ) : null}
      <div className="mx-auto mb-6 max-w-3xl space-y-3 text-center">
        {pricing.canceled ? (
          <p role="status">{t("billingCanceledNote")}</p>
        ) : null}
        {pricing.confirming ? (
          <p aria-live="polite">{t("billingConfirming")}</p>
        ) : null}
        {pricing.error ? <p role="alert">{t(pricing.error)}</p> : null}
        {pricing.mode === "non-owner" ? (
          <p className="rounded-lg border bg-card p-4" role="status">
            {t("pricingNonOwnerNotice")}
          </p>
        ) : null}
        {pricing.mode === "owner" && pricing.billing?.enabled === false ? (
          <p role="status">{t("billingUnavailable")}</p>
        ) : null}
        {pricing.mode === "owner" && pricing.billingFailed ? (
          <p role="alert">{t("billingLoadError")}</p>
        ) : null}
        {pricing.mode === "owner" &&
        pricing.billing?.access?.state === "EXPIRED" ? (
          <p className="rounded-lg border bg-card p-4" role="status">
            {t("pricingExpiredNotice")}
          </p>
        ) : null}
      </div>
      <section
        aria-label={t("pricingPlansLabel")}
        className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4"
      >
        {plans.map((plan) => (
          <article
            key={plan.name}
            aria-labelledby={`plan-${plan.name.toLowerCase()}`}
          >
            <Card
              className={`h-full ${
                pricing.currentPlan === PLAN_KEYS[plan.name]
                  ? "ring-2 ring-primary"
                  : ""
              }`}
            >
              <CardHeader>
                {pricing.currentPlan === PLAN_KEYS[plan.name] ? (
                  <Badge className="w-fit">
                    {t("pricingCurrentPlanBadge")}
                  </Badge>
                ) : (
                  <Badge variant="secondary" className="w-fit">
                    {t("pricingProposed")}
                  </Badge>
                )}
                <h2
                  id={`plan-${plan.name.toLowerCase()}`}
                  className="mt-2 text-xl font-semibold"
                >
                  {plan.name}
                </h2>
                <CardDescription>{t(plan.audience)}</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-1 flex-col gap-5">
                <div>
                  <p className="text-3xl font-semibold tracking-tight">
                    THB{" "}
                    {(billingPeriod === "monthly"
                      ? plan.monthly
                      : plan.yearly
                    ).toLocaleString("en-US")}
                  </p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {billingPeriod === "monthly"
                      ? t("pricingPerMonth")
                      : t("pricingPerYear")}
                  </p>
                </div>
                <Separator />
                <div>
                  <h3 className="font-medium">{t("pricingPlanningFocus")}</h3>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {t(plan.focus)}
                  </p>
                </div>
                <ul className="space-y-3 text-sm">
                  {plan.features.map((feature) => (
                    <li className="flex items-start gap-2" key={feature}>
                      <Check
                        className="mt-0.5 size-4 shrink-0"
                        aria-hidden="true"
                      />
                      {t(feature)}
                    </li>
                  ))}
                </ul>
                <Separator />
                <ul className="space-y-2 text-sm font-medium">
                  <li>{t(plan.branches)}</li>
                  <li>{t(plan.users)}</li>
                </ul>
                <PlanAction
                  billingPeriod={billingPeriod}
                  plan={PLAN_KEYS[plan.name]}
                  pricing={pricing}
                />
              </CardContent>
            </Card>
          </article>
        ))}
        <article aria-labelledby="plan-enterprise">
          <Card className="h-full">
            <CardHeader>
              <Badge variant="secondary" className="w-fit">
                {t("pricingProposed")}
              </Badge>
              <h2 id="plan-enterprise" className="mt-2 text-xl font-semibold">
                Enterprise
              </h2>
              <CardDescription>{t(enterprise.audience)}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-1 flex-col gap-5">
              <div>
                <p className="text-3xl font-semibold tracking-tight">
                  {t("pricingEnterpriseCustomPrice")}
                </p>
                <p className="mt-2 text-xs text-muted-foreground">
                  {t("pricingEnterprisePricingNote")}
                </p>
              </div>
              <Separator />
              <div>
                <h3 className="font-medium">{t("pricingPlanningFocus")}</h3>
                <p className="mt-2 text-sm text-muted-foreground">
                  {t(enterprise.focus)}
                </p>
              </div>
              <ul className="space-y-2 text-sm font-medium">
                <li>{t(enterprise.branches)}</li>
                <li>{t(enterprise.users)}</li>
              </ul>
              <div className="mt-auto border-t pt-4">
                <p className="font-medium">{t("pricingContactSales")}</p>
                <p className="mt-2 text-sm text-muted-foreground">
                  {t("pricingContactUnavailable")}
                </p>
              </div>
            </CardContent>
          </Card>
        </article>
      </section>
      <p className="mt-6 text-sm leading-6 text-muted-foreground">
        {t("pricingAccountDisclaimer")}
      </p>
      <section className="mt-16 border-t pt-10">
        <h2 className="text-2xl font-semibold">{t("pricingExploreTitle")}</h2>
        <p className="mt-3 max-w-2xl leading-7 text-muted-foreground">
          {t("pricingExploreDescription")}
        </p>
        <Button
          className="mt-5"
          variant="outline"
          nativeButton={false}
          role="link"
          render={<Link href="/#features" />}
        >
          {t("pricingViewFeatures")}
        </Button>
      </section>
    </div>
  );
}
