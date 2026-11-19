"use client";

import { useEffect, useRef } from "react";

/**
 * The list APIs only expose `includeInactive`, so the Inactive-only views are
 * filtered on already-loaded pages. A loaded page can therefore hold no
 * matching row while the cursor still has more pages. This hook keeps
 * requesting the next page until one contributes a matching row or the cursor
 * is exhausted.
 *
 * The requested-page-count ref makes the fetch idempotent per loaded page:
 * a rejected or empty page never retriggers itself, so the hook cannot loop.
 */
export function useAutoFetchFilteredPage({
  enabled,
  fetchNextPage,
  hasNextPage,
  isError,
  isFetching,
  loadedPageCount,
}: {
  /** True while the filtered view is empty and needs another page. */
  enabled: boolean;
  fetchNextPage: () => void;
  hasNextPage: boolean;
  isError: boolean;
  isFetching: boolean;
  /** Number of pages already held by the infinite query. */
  loadedPageCount: number;
}): void {
  const requestedPageCount = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) {
      requestedPageCount.current = null;
      return;
    }
    if (!hasNextPage || isFetching || isError) return;
    if (requestedPageCount.current === loadedPageCount) return;
    requestedPageCount.current = loadedPageCount;
    fetchNextPage();
  }, [
    enabled,
    fetchNextPage,
    hasNextPage,
    isError,
    isFetching,
    loadedPageCount,
  ]);
}
