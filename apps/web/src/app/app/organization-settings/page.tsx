import { redirect } from "next/navigation";

/** Profile and organization settings now live on /app/settings; keep old links working. */
export default async function LegacySettingsRoute({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const target = new URLSearchParams();
  for (const key of ["organizationId", "branchId"] as const) {
    const value = query[key];
    if (typeof value === "string" && value !== "") target.set(key, value);
  }
  const suffix = target.size === 0 ? "" : `?${target}`;
  redirect(`/app/settings${suffix}`);
}
