"use client";

import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { fetchAccessContext } from "@/branch-api-client";
import { AuthCard } from "@/components/auth/auth-card";
import { OnboardingForm } from "@/components/auth/onboarding-form";
import { useLanguage } from "@/providers/language-provider";

export default function OnboardingPage() {
  const router = useRouter();
  const { t } = useLanguage();
  const contextQuery = useQuery({
    queryFn: fetchAccessContext,
    queryKey: ["access-context"],
  });
  const eligible =
    contextQuery.data?.organizations.length === 0 &&
    contextQuery.data.firstOrganizationOnboarding.eligible;

  useEffect(() => {
    if (contextQuery.data !== undefined && !eligible) {
      router.replace("/app");
    }
  }, [contextQuery.data, eligible, router]);

  if (contextQuery.isPending) {
    return <p aria-live="polite">{t("loadingAccess")}</p>;
  }
  if (contextQuery.isError) {
    return <p role="alert">{t("accessError")}</p>;
  }
  if (!eligible) {
    return <p aria-live="polite">{t("onboardingOpening")}</p>;
  }

  return (
    <AuthCard
      description={t("onboardingDescription")}
      title={t("onboardingTitle")}
    >
      <OnboardingForm />
    </AuthCard>
  );
}
