import { Suspense } from "react";

import { SettingsPage, SettingsPageFallback } from "@/components/settings-page";

export default function SettingsRoute() {
  return (
    <Suspense fallback={<SettingsPageFallback />}>
      <SettingsPage />
    </Suspense>
  );
}
