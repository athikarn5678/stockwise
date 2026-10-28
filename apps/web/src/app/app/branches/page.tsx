import { LocalizedLoading } from "@/components/localized-loading";
import { Suspense } from "react";

import { BranchManagement } from "@/components/branch-management";

export default function BranchManagementPage() {
  return (
    <Suspense fallback={<LocalizedLoading messageKey="branchLoading" />}>
      <BranchManagement />
    </Suspense>
  );
}
