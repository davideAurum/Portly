/**
 * Feeds API: `GET /api/feeds?url=` → Feed (fetched, parsed and cached 15 min by the server).
 * One query per feed URL, so widgets sharing a feed share its cache entry.
 */
import { queryOptions, useQueries } from '@tanstack/react-query';
import type { Feed } from '@homebase/shared';
import { apiGet } from './client.ts';
import { qk } from './keys.ts';

/** Default staleTime for feeds (the server caches for 15 min anyway). */
export const FEEDS_STALE_MS = 10 * 60 * 1000;
/** Background refresh so a long-open tab picks up new headlines. */
export const FEEDS_REFETCH_MS = 15 * 60 * 1000;

/** `check`: the feed settings trying an address before adding it (the server records no failure for it). */
export function fetchFeed(url: string, signal?: AbortSignal, options: { check?: boolean } = {}): Promise<Feed> {
  const params = new URLSearchParams({ url });
  if (options.check) params.set('check', '1');
  return apiGet<Feed>(`/api/feeds?${params.toString()}`, { signal });
}

export function feedQuery(url: string) {
  return queryOptions({
    queryKey: qk.feeds.feed(url),
    queryFn: ({ signal }) => fetchFeed(url, signal),
    staleTime: FEEDS_STALE_MS,
  });
}

/**
 * {@link feedQuery} fetched as a check (adding a feed): the same cache entry, but a typo or a page
 * without a feed does not leave a failing feed in Settings → Diagnostics.
 */
export function feedCheckQuery(url: string) {
  return queryOptions({ ...feedQuery(url), queryFn: ({ signal }) => fetchFeed(url, signal, { check: true }) });
}

/** One query per URL, in the given order. */
export function useFeeds(urls: readonly string[]) {
  return useQueries({
    queries: urls.map((url) => ({
      ...feedQuery(url),
      refetchInterval: FEEDS_REFETCH_MS,
      refetchOnWindowFocus: true,
    })),
  });
}
