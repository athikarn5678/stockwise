import { LocalizedLoading } from "@/components/localized-loading";
import { Suspense } from "react";
import { SupplierManagement } from "@/components/supplier-management";
export default function SuppliersPage() {
  return (
    <Suspense fallback={<LocalizedLoading messageKey="supplierLoading" />}>
      <SupplierManagement />
    </Suspense>
  );
}
