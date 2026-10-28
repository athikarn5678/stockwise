import { LocalizedLoading } from "@/components/localized-loading";
import { Suspense } from "react";

import { PurchaseOrderManagement } from "@/components/purchase-order-management";

export default function PurchaseOrdersPage() {
  return (
    <Suspense
      fallback={<LocalizedLoading messageKey="uiLoadingPurchaseOrders" />}
    >
      <PurchaseOrderManagement />
    </Suspense>
  );
}
