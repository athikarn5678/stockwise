"use client";

import Link from "next/link";

import { Button } from "@/components/ui/button";
import { useLanguage } from "@/providers/language-provider";
import { useSubscription } from "@/providers/subscription-provider";

/**
 * Read-only banner (EXPIRED) or trial countdown (TRIAL), shown above the page
 * content in the signed-in workspace. Both link to /pricing, the only place to
 * subscribe or renew.
 */
export function SubscriptionBanner() {
  const { t } = useLanguage();
  const { billing } = useSubscription();
  const access = billing?.access;
  if (access === undefined || access === null || access.state === "ACTIVE")
    return null;

  const expired = access.state === "EXPIRED";
  const days = access.trialDaysLeft ?? 0;
  const message = expired
    ? t("subscriptionReadOnlyBanner")
    : t("subscriptionTrialBanner").replace(
        "{days}",
        t(
          days === 1 ? "subscriptionTrialDay" : "subscriptionTrialDays",
        ).replace("{days}", String(days)),
      );

  return (
    <div
      className={
        expired
          ? "border-b border-destructive/30 bg-destructive/10 text-destructive"
          : "border-b bg-muted text-foreground"
      }
      data-testid="subscription-banner"
      role={expired ? "alert" : "status"}
    >
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm sm:px-6">
        <p>{message}</p>
        <Button
          nativeButton={false}
          render={<Link href="/pricing" />}
          role="link"
          size="sm"
          variant={expired ? "default" : "outline"}
        >
          {t("subscriptionViewPlans")}
        </Button>
      </div>
    </div>
  );
}
