/**
 * RSS / Atom feed contracts (`GET /api/feeds?url=`). The server fetches the feed (or, for a web
 * page, the feed it advertises), parses RSS 2.0 / 0.9x, RSS 1.0 (RDF) and Atom, and returns plain
 * text only: titles and summaries are converted from HTML server-side and links are SafeHttpUrls.
 */
import { z } from 'zod';
import { SafeHttpUrl } from './core.ts';

/** Most items returned per feed (newest first). */
export const MAX_FEED_ITEMS = 50;
/** Longest item summary returned (characters, after HTML → text). */
export const MAX_FEED_SUMMARY = 400;
/** Longest feed or item title returned. */
export const MAX_FEED_TITLE = 300;

export interface FeedItem {
  /** Stable within the feed (guid / Atom id / link), unique per response. */
  id: string;
  title: string;
  /** Article link (SafeHttpUrl) or null. */
  url: string | null;
  /** ISO-8601 UTC, or null when the feed gives no (readable) date. */
  published: string | null;
  author: string | null;
  /** Plain text, ≤ {@link MAX_FEED_SUMMARY} characters, or null. */
  summary: string | null;
}

/** `GET /api/feeds?url=` */
export interface Feed {
  /** The URL that was requested. */
  url: string;
  /** The feed document's URL (differs from `url` when a web page advertised its feed). */
  feedUrl: string;
  title: string;
  /** The site's home page (SafeHttpUrl) or null. */
  siteUrl: string | null;
  /** Newest first (undated items keep their feed order, after the dated ones). */
  items: FeedItem[];
  /** When the server fetched the feed (ISO-8601). */
  fetchedAt: string;
}

/**
 * Query of `GET /api/feeds`. `check=1`: the feed settings are trying an address before adding it
 * (the server then records no failure for the feed: a typo is not a feed that fails).
 */
export const FeedQuerySchema = z.object({ url: SafeHttpUrl, check: z.literal('1').optional() });
export type FeedQuery = z.output<typeof FeedQuerySchema>;
