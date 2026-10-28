import { LocalizedLoading } from "@/components/localized-loading";
import { Suspense } from "react";

import { InventoryManagement } from "@/components/inventory-management";

export default function InventoryPage() {
  return (
    <Suspense
      fallback={<LocalizedLoading messageKey="inventoryLoadingBalances" />}
    >
      <InventoryManagement />
    </Suspense>
  );
}
