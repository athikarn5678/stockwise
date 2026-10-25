import { Suspense } from "react";

import {
  MembershipManagement,
  MembershipManagementFallback,
} from "@/components/membership-management";

export default function MembershipManagementPage() {
  return (
    <Suspense fallback={<MembershipManagementFallback />}>
      <MembershipManagement />
    </Suspense>
  );
}
