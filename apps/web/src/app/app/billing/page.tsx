import { Suspense } from "react";

import {
  BillingManagement,
  BillingManagementFallback,
} from "@/components/billing-management";

export default function BillingPage() {
  return (
    <Suspense fallback={<BillingManagementFallback />}>
      <BillingManagement />
    </Suspense>
  );
}
