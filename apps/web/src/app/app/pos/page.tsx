import { LocalizedLoading } from "@/components/localized-loading";
import { Suspense } from "react";

import { PosManagement } from "@/components/pos-management";

export default function PosPage() {
  return (
    <Suspense fallback={<LocalizedLoading messageKey="uiLoadingPointOfSale" />}>
      <PosManagement />
    </Suspense>
  );
}
