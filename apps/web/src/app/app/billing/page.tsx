import { redirect } from "next/navigation";

/**
 * Billing moved to /pricing, the only place to subscribe or renew. Old links,
 * bookmarks and Stripe return URLs of Checkout Sessions created before the move
 * still land here; only the three known parameters are carried over.
 */
export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const forwarded = new URLSearchParams();
  for (const key of ["organizationId", "session_id", "canceled"]) {
    const value = params[key];
    if (typeof value === "string") forwarded.set(key, value);
  }
  const query = forwarded.toString();
  redirect(query === "" ? "/pricing" : `/pricing?${query}`);
}
