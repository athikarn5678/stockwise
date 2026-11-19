import { redirect } from "next/navigation";

/** AI analysis now lives in the Analytics "AI analysis" tab; keep old links working. */
export default async function AiAnalysisRoute({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const target = new URLSearchParams({ view: "ai-analysis" });
  for (const key of ["organizationId", "branchId"] as const) {
    const value = query[key];
    if (typeof value === "string" && value !== "") target.set(key, value);
  }
  redirect(`/app/analytics?${target}`);
}
