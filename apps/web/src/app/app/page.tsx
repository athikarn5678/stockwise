import { LocalizedLoading } from "@/components/localized-loading";
import { Suspense } from "react";

import { ApplicationContextShell } from "@/components/application-context-shell";

export default function ApplicationPage() {
  return (
    <Suspense fallback={<LocalizedLoading messageKey="openingWorkspace" />}>
      <ApplicationContextShell />
    </Suspense>
  );
}
