import { Suspense } from "react";

import {
  OrganizationSettings,
  OrganizationSettingsFallback,
} from "@/components/organization-settings";

export default function OrganizationSettingsPage() {
  return (
    <Suspense fallback={<OrganizationSettingsFallback />}>
      <OrganizationSettings />
    </Suspense>
  );
}
