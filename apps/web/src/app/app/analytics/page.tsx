import { LocalizedLoading } from "@/components/localized-loading";
import { Suspense } from "react";

import { AnalyticsManagement } from "@/components/analytics-management";

export default function AnalyticsPage() {
  return (
    <Suspense fallback={<LocalizedLoading messageKey="uiLoadingAnalytics" />}>
      <AnalyticsManagement />
    </Suspense>
  );
}
