import { LocalizedLoading } from "@/components/localized-loading";
import { Suspense } from "react";

import { SalesHistoryManagement } from "@/components/sales-history-management";

export default function SalesHistoryPage() {
  return (
    <Suspense
      fallback={<LocalizedLoading messageKey="uiLoadingSalesHistory" />}
    >
      <SalesHistoryManagement />
    </Suspense>
  );
}
