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
  const { billing, dismissRefusedNotice, refusedNotice } = useSubscription();
  const access = billing?.access;
  // A refused write (402) says plainly why, whatever the page's own error text is.
  const refused = refusedNotice ? (
    <div
      className="border-b border-destructive/30 bg-destructive/10 text-destructive"
      data-testid="subscription-refused"
      role="alert"
    >
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm sm:px-6">
        <p>{t("subscriptionRequired")}</p>
        <div className="flex gap-2">
          <Button
            nativeButton={false}
            render={<Link href="/pricing" />}
            role="link"
            size="sm"
          >
            {t("subscriptionViewPlans")}
          </Button>
          <Button
            onClick={dismissRefusedNotice}
            size="sm"
            type="button"
            variant="outline"
          >
            {t("subscriptionDismiss")}
          </Button>
        </div>
      </div>
    </div>
  ) : null;
  if (access === undefined || access === null || access.state === "ACTIVE")
    return refused;

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
    <>
      {refused}
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
    </>
  );
}
