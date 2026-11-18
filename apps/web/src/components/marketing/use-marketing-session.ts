"use client";

import { useQuery } from "@tanstack/react-query";

import { fetchAccessContext, type AccessContext } from "@/branch-api-client";

export type MarketingSession =
  | { status: "loading" }
  | { status: "guest" }
  | { context: AccessContext; status: "signedIn" };

/**
 * Who is looking at a public marketing page. It shares the `access-context`
 * query with the workspace shell, so signing in or out elsewhere updates the
 * marketing header and pricing page without another request. Any failure
 * (401, network) is treated as a guest: the API remains the only authority.
 */
export function useMarketingSession(): MarketingSession {
  const query = useQuery({
    queryFn: ({ signal }) => fetchAccessContext({ signal }),
    queryKey: ["access-context"],
    // One probe per visit: the public pages never poll or revalidate on focus
    // or reconnect. Sign-in/out invalidates the key and refetches this query.
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    retry: false,
  });
  if (query.data) return { context: query.data, status: "signedIn" };
  if (query.isPending) return { status: "loading" };
  return { status: "guest" };
}
