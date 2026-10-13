/**
 * RSS / Atom feeds for the feeds widget.
 *
 * - `GET /api/feeds?url=[&check=1]` → `Feed` (declared `paired()`: the paired Pages site may use
 *   it too). `check=1` (the feed settings trying an address) records no failure in health.
 *   The URL is user-entered and untrusted, so it is fetched with `policy: 'public'` (SSRF guard,
 *   §4.8), capped at {@link FEED_MAX_BYTES} and parsed by the linear-time reader in xml.ts. A web
 *   page instead of a feed is searched for its advertised feed
 *   (`<link rel="alternate" type="application/rss+xml">`), which is fetched once.
 * - Results are cached {@link FEED_TTL_MS} in the SQLite cache (feeds are public, non-sensitive);
 *   failures are not cached.
 *
 * Errors: not a feed / no advertised feed → 422 `validation_failed`; non-2xx upstream or a refused
 * document → 502 `provider_error`; timeouts → 504 `upstream_timeout`.
 *
 * Diagnostics (§17): every fetch (a cache miss; a `check` only when it succeeds) records health key
 * `feed:<id>` — `id` = the first 10 hex digits of the SHA-1 of the requested URL, never the URL —
 * labelled with its host, on demand (never stale). Detail `{status, bytes, items, finalHost, contentType}` describes the
 * last document read (`finalHost` only when it is not the feed's host, `contentType` its media
 * type only; `discovered: true` once a page led to its advertised feed, whose read the detail then
 * describes even when it fails); failures carry `not_a_feed`, `parse_error`, `too_large`, an HTTP
 * or a transport code.
 * The fetch runs in `withLogContext({area: 'feeds', feed: id})`, so the Diagnostics page can show
 * a feed's related log lines.
 */
import { createHash } from 'node:crypto';
import type { Hono } from 'hono';
import { FeedQuerySchema, type ErrorCode, type Feed } from '@portly/shared';
import type { AppContext, AppEnv } from '../../context.ts';
import { HttpError } from '../../lib/errors.ts';
import { outcomeFromError, type DetailValue, type HealthSubject, type Outcome } from '../../lib/health.ts';
import { withLogContext } from '../../lib/log-context.ts';
import { paired } from '../../lib/routes.ts';
import { parseQuery } from '../../lib/validate.ts';
import { NotAFeedError, decodeFeedBytes, discoverFeedUrl, looksLikeHtml, parseFeed } from './parse.ts';
import { XmlError } from './xml.ts';

export const prefixes = ['/api/feeds'] as const;

export const FEED_TTL_MS = 15 * 60 * 1000;
export const FEED_TIMEOUT_MS = 10_000;
export const FEED_MAX_BYTES = 5 * 1024 * 1024;

const ACCEPT = 'application/rss+xml, application/atom+xml, application/rdf+xml;q=0.9, application/xml;q=0.8, text/xml;q=0.8, text/html;q=0.5, */*;q=0.3';

/** A parameter-free media type of a registered top-level type (what the health detail accepts). */
const MEDIA_TYPE = /^(?:application|audio|font|image|message|model|multipart|text|video)\/[a-z0-9][a-z0-9.+_-]{0,47}$/;

export function feedCacheKey(url: string): string {
  return `feeds:feed:${url}`;
}

/** A feed's diagnostics id: the first 10 hex digits of the SHA-1 of its URL (log context `feed`). */
export function feedId(url: string): string {
  return createHash('sha1').update(url).digest('hex').slice(0, 10);
}

/** Health key of a feed (§17): `feed:<feedId>`. */
export function feedHealthKey(url: string): string {
  return `feed:${feedId(url)}`;
}

/**
 * A feed failure: the API error, plus what diagnostics need (never sent to the browser) — the
 * health code when the API code does not tell it, and the feed's HTTP status (`httpStatus`, logged
 * as `upstreamStatus` and mapped to `http_4xx`/`http_5xx`/`not_found` by `outcomeFromError`).
 */
export class FeedError extends HttpError {
  override name = 'FeedError';
  readonly healthCode: 'not_a_feed' | 'parse_error' | null;
  readonly httpStatus: number | null;
  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    facts: { healthCode?: 'not_a_feed' | 'parse_error'; httpStatus?: number; cause?: unknown } = {},
  ) {
    super(status, code, { message, cause: facts.cause });
    this.healthCode = facts.healthCode ?? null;
    this.httpStatus = facts.httpStatus ?? null;
  }
}

/** What the last document read looked like (health detail). */
interface FeedTrace {
  /** The document is the feed a web page advertised (the page was read first). */
  discovered?: boolean;
  status?: number;
  bytes?: number;
  finalHost?: string;
  contentType?: string;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

/** `text/html; charset=utf-8` → `text/html` (undefined when it is not a plain media type). */
function mediaType(contentType: string | null): string | undefined {
  const essence = contentType?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return MEDIA_TYPE.test(essence) ? essence : undefined;
}

async function fetchDocument(ctx: AppContext, url: string, purpose: string, trace: FeedTrace): Promise<{ text: string; url: string }> {
  const res = await ctx.fetch(url, {
    policy: 'public',
    as: 'bytes',
    maxBytes: FEED_MAX_BYTES,
    timeoutMs: FEED_TIMEOUT_MS,
    headers: { Accept: ACCEPT },
    purpose,
  });
  const finalUrl = res.url || url;
  trace.status = res.status;
  trace.bytes = res.data.length;
  trace.contentType = mediaType(res.headers.get('content-type'));
  trace.finalHost = hostOf(finalUrl) ?? undefined;
  if (res.status < 200 || res.status >= 300) {
    throw new FeedError(502, 'provider_error', `The feed answered HTTP ${res.status}`, { httpStatus: res.status });
  }
  return { text: decodeFeedBytes(res.data, res.headers.get('content-type')), url: finalUrl };
}

function notAFeed(message: string, cause?: unknown): FeedError {
  return new FeedError(422, 'validation_failed', message, { healthCode: 'not_a_feed', cause });
}

function toFeed(text: string, feedUrl: string, requestedUrl: string): Feed {
  try {
    return parseFeed(text, feedUrl, requestedUrl);
  } catch (err) {
    if (err instanceof NotAFeedError) throw notAFeed('This address is not an RSS or Atom feed', err);
    if (err instanceof XmlError) {
      throw new FeedError(502, 'provider_error', `The feed could not be read: ${err.message}`, { healthCode: 'parse_error', cause: err });
    }
    throw err;
  }
}

async function loadFeed(ctx: AppContext, url: string, trace: FeedTrace): Promise<Feed> {
  const doc = await fetchDocument(ctx, url, 'feed', trace);
  if (!looksLikeHtml(doc.text)) return toFeed(doc.text, doc.url, url);
  const discovered = discoverFeedUrl(doc.text, doc.url);
  if (!discovered) throw notAFeed('No RSS or Atom feed was found on this page');
  // From here the trace describes the advertised feed: a read that fails must not show the page's status.
  Object.assign(trace, { discovered: true, status: undefined, bytes: undefined, finalHost: undefined, contentType: undefined });
  const feed = await fetchDocument(ctx, discovered, 'feed.discovered', trace);
  if (looksLikeHtml(feed.text)) throw notAFeed('This address is not an RSS or Atom feed');
  return toFeed(feed.text, feed.url, url);
}

function traceDetail(trace: FeedTrace, host: string | null): Record<string, DetailValue> {
  const detail: Record<string, DetailValue> = {};
  if (trace.discovered) detail.discovered = true;
  if (trace.status !== undefined) detail.status = trace.status;
  if (trace.bytes !== undefined) detail.bytes = trace.bytes;
  if (trace.finalHost !== undefined && trace.finalHost !== host) detail.finalHost = trace.finalHost;
  if (trace.contentType !== undefined) detail.contentType = trace.contentType;
  return detail;
}

/**
 * Fetches and parses the feed at `url` (following a page to its advertised feed), recording
 * `feed:<id>`. A `check` (the feed settings trying an address before adding it) records success
 * only: an address typed wrong, or a page without a feed, must not leave a failing feed behind.
 */
export async function fetchFeed(ctx: AppContext, url: string, options: { check?: boolean } = {}): Promise<Feed> {
  const id = feedId(url);
  const host = hostOf(url);
  const subject: HealthSubject = { key: `feed:${id}`, area: 'feeds', label: host, expectEveryMs: null };
  return withLogContext({ area: 'feeds', feed: id }, async () => {
    const trace: FeedTrace = {};
    const started = Date.now();
    try {
      const feed = await loadFeed(ctx, url, trace);
      ctx.health.record(subject, { ok: true, ms: Date.now() - started, detail: { ...traceDetail(trace, host), items: feed.items.length } });
      return feed;
    } catch (err) {
      const extra: Partial<Outcome> = { ms: Date.now() - started, detail: traceDetail(trace, host) };
      if (err instanceof FeedError && err.healthCode !== null) {
        // The document arrived (its status is the last one read) but is no feed we can read.
        extra.code = err.healthCode;
        if (trace.status !== undefined) extra.status = trace.status;
      }
      if (!options.check) ctx.health.record(subject, outcomeFromError(err, extra));
      throw err;
    }
  });
}

export function register(app: Hono<AppEnv>, ctx: AppContext): void {
  app.get('/api/feeds', paired(), async (c) => {
    const { url, check } = parseQuery(c, FeedQuerySchema);
    const feed = await ctx.cache.getOrSet(feedCacheKey(url), FEED_TTL_MS, () => fetchFeed(ctx, url, { check: check === '1' }));
    return c.json(feed);
  });
}
