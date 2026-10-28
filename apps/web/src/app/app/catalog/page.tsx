import { LocalizedLoading } from "@/components/localized-loading";
import { Suspense } from "react";

import { CatalogManagement } from "@/components/catalog-management";

export default function CatalogPage() {
  return (
    <Suspense fallback={<LocalizedLoading messageKey="uiLoadingCatalog" />}>
      <CatalogManagement />
    </Suspense>
  );
}
