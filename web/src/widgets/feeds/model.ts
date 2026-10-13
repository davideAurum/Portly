/**
 * Pure view model of the feeds widget: merges the items of several feeds newest first.
 */
import type { Feed, FeedItem } from '@homebase/shared';
import type { FeedSource } from './index.ts';

export interface FeedRow {
  key: string;
  item: FeedItem;
  /** The configured name, else the feed's title. */
  source: string;
}

/** Display name of a configured feed (its custom title, the fetched title, or its host). */
export function sourceName(source: FeedSource, feed?: Feed): string {
  if (source.title) return source.title;
  if (feed?.title) return feed.title;
  try {
    return new URL(source.url).hostname.replace(/^www\./, '');
  } catch {
    return source.url;
  }
}

/**
 * Items of every loaded feed, newest first; undated items follow the dated ones, in feed order.
 * The same article listed by two feeds (same URL) is shown once.
 */
export function mergeFeedItems(entries: readonly { source: FeedSource; feed: Feed | undefined }[], max: number): FeedRow[] {
  const rows: (FeedRow & { order: number })[] = [];
  const seenUrls = new Set<string>();
  let order = 0;
  for (const { source, feed } of entries) {
    if (!feed) continue;
    const name = sourceName(source, feed);
    for (const item of feed.items) {
      if (item.url) {
        if (seenUrls.has(item.url)) continue;
        seenUrls.add(item.url);
      }
      rows.push({ key: `${source.url}\n${item.id}`, item, source: name, order: order++ });
    }
  }
  rows.sort((a, b) => {
    const pa = a.item.published;
    const pb = b.item.published;
    if (pa && pb) return pa === pb ? a.order - b.order : pb.localeCompare(pa);
    if (pa) return -1;
    if (pb) return 1;
    return a.order - b.order;
  });
  return rows.slice(0, max).map(({ order: _order, ...row }) => row);
}

/** Accepts `example.com/feed` as `https://example.com/feed`; returns the trimmed input otherwise. */
export function normalizeFeedInput(input: string): string {
  const trimmed = input.trim();
  if (trimmed === '' || /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  return `https://${trimmed.replace(/^\/+/, '')}`;
}
