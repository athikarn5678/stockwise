import { Suspense } from "react";

import {
  AiAnalysisPage,
  AiAnalysisPageFallback,
} from "@/components/ai-analysis-page";

export default function AiAnalysisRoute() {
  return (
    <Suspense fallback={<AiAnalysisPageFallback />}>
      <AiAnalysisPage />
    </Suspense>
  );
}
