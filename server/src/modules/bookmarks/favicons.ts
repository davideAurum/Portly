/**
 * Favicon resolver and icon storage (§8 Favicons, §4.3, §4.8, §5 `icons`).
 *
 * Resolution chain for a page URL (safe-fetch policy `public` for everything discovered):
 *   page HTML (≤ 2 MB) → `<link rel~=icon|apple-touch-icon>` candidates (+ web manifest icons when
 *   the links offer nothing good), hrefs resolved against the final response URL, ranked "largest
 *   ≥ 32 px raster or SVG first" → `/favicon.ico` → DuckDuckGo `ip3/<host>.ico` → Google s2
 *   (`sz=128`) — the last two via policy `provider`, skipped for local-looking hosts, non-2xx =
 *   miss. The chain stops at the first good image (SVG, or a raster ≥ 32 px); otherwise the best
 *   image seen is kept. `data:` hrefs are decoded locally, sniffed and capped. Client-side the
 *   letter tile is the last fallback.
 *
 * Storage: one favicon per host (`source_host` = lower-cased `host[:port]`, deduped) under a
 * random UUIDv4; the content type comes from magic-byte sniffing only. Refreshed after 30 days —
 * a refresh stores a *new* row (new id, so browsers never show a cached old icon) and repoints
 * the host's automatic bookmarks; old rows are garbage-collected once nothing references them.
 * Resolution is single-flight per host, runs in a small background queue after bookmark creation
 * and imports, and remembers misses for a day.
 *
 * Diagnostics (§17): each resolution runs in `withLogContext({area: 'bookmarks', op: 'favicon'})`
 * and ends with `debug 'favicon resolved' {host, step, attempts, ms}` (the chain step that gave
 * the kept image: `link`, `manifest`, `favicon.ico`, `duckduckgo`, `google`) or
 * `debug 'favicon miss' {host, attempts, retryAt}`; outbound purposes `favicon.<step>` (the page
 * itself: `favicon.page`). A queued resolution keeps the context of whoever queued it (the
 * request's rid, or the maintenance job's run). Never the page URL — the host only.
 */
import { SIZE_CAPS, decodeDataImage, isLocalLookingHost, type SafeFetch } from '../../security/safe-fetch.ts';
import type { ImageContentType } from '@portly/shared';
import type { Db } from '../../db/open.ts';
import { HttpError } from '../../lib/errors.ts';
import { isUuidV4, newId } from '../../lib/ids.ts';
import { sniffImageType } from '../../lib/image-sniff.ts';
import { getLogContext, outsideLogContext, withLogContext, type LogContext } from '../../lib/log-context.ts';
import { errorFields, type Logger } from '../../lib/logger.ts';
import { fetchPage, parseManifest, parsePage, type FetchedPage, type IconCandidate } from './html.ts';
import { imageSize } from './image-size.ts';
import { hostKey, type IconLinker } from './store.ts';

export const DAY_MS = 24 * 60 * 60 * 1000;
/** Favicons older than this are refreshed. */
export const ICON_MAX_AGE_MS = 30 * DAY_MS;
/** A failed resolution is not retried automatically for this long. */
export const MISS_RETRY_MS = DAY_MS;
/** Unreferenced favicons are kept this long (site-meta prefetches icons before a bookmark exists). */
export const FAVICON_GRACE_MS = DAY_MS;
/** Custom icons that lost their bookmark are kept this long (undo window). */
export const UPLOAD_GRACE_MS = 60 * 60 * 1000;
export const ICON_TIMEOUT_MS = 6_000;
/** At most this many image downloads per resolution. */
export const MAX_ICON_ATTEMPTS = 6;
/** Minimum raster size considered "good". */
export const GOOD_ICON_PX = 32;
export const QUEUE_CONCURRENCY = 3;
export const MAX_UPLOAD_ICON_BYTES = 10 * 1024 * 1024;

export interface IconImage {
  contentType: ImageContentType;
  bytes: Buffer;
  /** max(width, height) in px; null when unknown (SVG, AVIF). */
  width: number | null;
}

function isGood(image: IconImage): boolean {
  return image.contentType === 'image/svg+xml' || image.width === null || image.width >= GOOD_ICON_PX;
}

function quality(image: IconImage): number {
  if (image.contentType === 'image/svg+xml') return 10_000;
  return image.width ?? 64;
}

/** Ranking: SVG, then declared rasters ≥ 32 px (larger first, capped at 256), unknown sizes, small ones. */
export function candidateScore(candidate: IconCandidate): number {
  if (candidate.svg) return 3000;
  const size = candidate.size ?? (candidate.source === 'apple' ? 180 : null);
  if (size === null) return 1500;
  if (size >= GOOD_ICON_PX) return 2000 + Math.min(size, 256);
  return 1000 + size;
}

export function rankCandidates(candidates: readonly IconCandidate[]): IconCandidate[] {
  const seen = new Set<string>();
  return candidates
    .filter((c) => (seen.has(c.url) ? false : (seen.add(c.url), true)))
    .map((c, index) => ({ c, index, score: candidateScore(c) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((x) => x.c);
}

function hasGoodDeclaration(candidates: readonly IconCandidate[]): boolean {
  return candidates.some((c) => candidateScore(c) >= 2000 + GOOD_ICON_PX);
}

export function duckDuckGoUrl(hostname: string): string {
  return `https://icons.duckduckgo.com/ip3/${encodeURIComponent(hostname)}.ico`;
}

export function googleS2Url(hostname: string): string {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostname)}&sz=128`;
}

export interface ResolveDeps {
  fetch: SafeFetch;
  log: Logger;
}

/** Steps of the resolution chain (log field `step`, outbound purpose `favicon.<step>`). */
export type FaviconStep = 'link' | 'manifest' | 'favicon.ico' | 'duckduckgo' | 'google';

/** Downloads (or decodes) one icon; null for any failure, non-2xx or non-image. */
export async function fetchIcon(
  deps: ResolveDeps,
  url: string,
  policy: 'public' | 'provider' = 'public',
  step: FaviconStep = 'link',
): Promise<IconImage | null> {
  if (/^data:/i.test(url)) {
    const decoded = decodeDataImage(url, SIZE_CAPS.image);
    return decoded ? { ...decoded, width: imageSize(decoded.bytes, decoded.contentType) } : null;
  }
  try {
    const res = await deps.fetch(url, {
      policy,
      as: 'bytes',
      maxBytes: SIZE_CAPS.image,
      timeoutMs: ICON_TIMEOUT_MS,
      headers: { Accept: 'image/avif,image/webp,image/svg+xml,image/png,image/*;q=0.8,*/*;q=0.5' },
      purpose: step === 'favicon.ico' ? step : `favicon.${step}`,
    });
    if (res.status < 200 || res.status >= 300) return null;
    const contentType = sniffImageType(res.data);
    if (!contentType) return null;
    return { contentType, bytes: res.data, width: imageSize(res.data, contentType) };
  } catch (err) {
    deps.log.debug('icon fetch failed', { step, ...errorFields(err) });
    return null;
  }
}

/** What a resolution found: the best image (null: a miss), the step that gave it and the downloads tried. */
export interface FaviconResolution {
  image: IconImage | null;
  step: FaviconStep | null;
  attempts: number;
}

/**
 * Runs the §8 resolution chain for `pageUrl`. `page` may carry an already fetched page (site-meta
 * fetches it once for the title and the icon). Returns the best image found, or null.
 */
export async function resolveFavicon(deps: ResolveDeps, pageUrl: string, page?: FetchedPage | null): Promise<IconImage | null> {
  return (await traceFavicon(deps, pageUrl, page)).image;
}

/** {@link resolveFavicon}, also telling which step gave the image and how many downloads were tried. */
export async function traceFavicon(deps: ResolveDeps, pageUrl: string, page?: FetchedPage | null): Promise<FaviconResolution> {
  let target: URL;
  try {
    target = new URL(pageUrl);
  } catch {
    return { image: null, step: null, attempts: 0 };
  }
  let fetched = page;
  if (fetched === undefined) {
    try {
      fetched = await fetchPage(deps.fetch, pageUrl, { purpose: 'favicon.page' });
    } catch (err) {
      deps.log.debug('favicon page fetch failed', errorFields(err));
      fetched = null;
    }
  }

  let best: IconImage | null = null;
  let bestStep: FaviconStep | null = null;
  let attempts = 0;
  const tried = new Set<string>();
  const result = (): FaviconResolution => ({ image: best, step: bestStep, attempts });
  /** Tries one URL; true when the best image so far is good enough to stop. */
  const attempt = async (url: string, step: FaviconStep, policy: 'public' | 'provider' = 'public'): Promise<boolean> => {
    if (attempts >= MAX_ICON_ATTEMPTS || tried.has(url)) return best !== null && isGood(best);
    tried.add(url);
    attempts++;
    const image = await fetchIcon(deps, url, policy, step);
    if (image && (best === null || quality(image) > quality(best))) {
      best = image;
      bestStep = step;
    }
    return best !== null && isGood(best);
  };

  const base = fetched?.url ?? target.href;
  const parsed = fetched?.html ? parsePage(fetched.html, base) : null;
  const linkCandidates = parsed?.icons ?? [];
  for (const candidate of rankCandidates(linkCandidates).slice(0, 4)) {
    if (await attempt(candidate.url, 'link')) return result();
  }

  if (parsed?.manifestUrl && !hasGoodDeclaration(linkCandidates)) {
    try {
      const res = await deps.fetch(parsed.manifestUrl, {
        policy: 'public',
        as: 'json',
        maxBytes: 512 * 1024,
        timeoutMs: ICON_TIMEOUT_MS,
        purpose: 'favicon.manifest',
      });
      if (res.status >= 200 && res.status < 300) {
        for (const candidate of rankCandidates(parseManifest(res.data, res.url)).slice(0, 2)) {
          if (await attempt(candidate.url, 'manifest')) return result();
        }
      }
    } catch (err) {
      // Manifest unavailable: continue with the fallbacks.
      deps.log.debug('favicon manifest unavailable', errorFields(err));
    }
  }

  const origin = fetched ? new URL(fetched.url).origin : target.origin;
  if (await attempt(`${origin}/favicon.ico`, 'favicon.ico')) return result();

  const hostname = target.hostname.replace(/^\[|\]$/g, '');
  if (!isLocalLookingHost(target.host)) {
    if (await attempt(duckDuckGoUrl(hostname), 'duckduckgo', 'provider')) return result();
    if (await attempt(googleS2Url(hostname), 'google', 'provider')) return result();
  }
  return result();
}

// ---------------------------------------------------------------------------
// Service: storage, dedupe, single flight, background queue, maintenance
// ---------------------------------------------------------------------------

export interface IconRow {
  id: string;
  kind: 'favicon' | 'upload';
  content_type: string;
  bytes: Buffer;
}

export interface FaviconServiceOptions {
  db: Db;
  fetch: SafeFetch;
  log: Logger;
  /** Whether automatic (background) fetching is enabled (`settings.bookmarks.autoFetchIcons`). */
  autoFetch: () => boolean;
  /** Icon ids referenced outside the bookmarks table (search engine icons in settings). */
  externalReferences: () => Iterable<string>;
  now?: () => number;
  concurrency?: number;
}

export interface EnsureOptions {
  /** Re-resolve even if a fresh icon exists or a miss was recorded (explicit refresh). */
  force?: boolean;
  /** Already fetched page (site-meta). */
  page?: FetchedPage | null;
}

export interface FaviconService extends IconLinker {
  /** The host's icon id: a fresh stored one, or the result of resolving it (single-flight per host). */
  ensure(url: string, options?: EnsureOptions): Promise<string | null>;
  /** Queues a background resolution for the URL's host (deduped; no-op when the host has a fresh icon). */
  enqueue(url: string, options?: { force?: boolean }): void;
  /** Resolves when the background queue is empty. */
  idle(): Promise<void>;
  /** Points every automatic bookmark of `host` at `iconId`. */
  linkHost(host: string, iconId: string): number;
  /** Stored icon for `GET /api/icons/:id` (content type re-sniffed), or null. */
  read(id: string): { contentType: ImageContentType; bytes: Buffer } | null;
  /** Stores an uploaded custom icon (sniffed; 422 for non-images). Returns its id. */
  storeUpload(bytes: Buffer): string;
  /** Hourly job: resolve missing icons, refresh stale ones, garbage-collect unreferenced rows. */
  maintenance(): Promise<void>;
  /** Deletes unreferenced icons past their grace period; returns the number removed. */
  collectGarbage(): number;
}

export function createFaviconService(options: FaviconServiceOptions): FaviconService {
  const { db, log } = options;
  const now = options.now ?? Date.now;
  const concurrency = options.concurrency ?? QUEUE_CONCURRENCY;
  const deps: ResolveDeps = { fetch: options.fetch, log };

  const inflight = new Map<string, Promise<string | null>>();
  const misses = new Map<string, number>();
  const orphans = new Map<string, number>();
  const queue: { host: string; url: string; force: boolean; context: Readonly<LogContext> | undefined }[] = [];
  const queued = new Set<string>();
  let active = 0;
  let idleWaiters: (() => void)[] = [];

  const newestFavicon = (host: string): { id: string; fetched_at: number } | undefined =>
    db.get<{ id: string; fetched_at: number }>(
      "SELECT id, fetched_at FROM icons WHERE kind = 'favicon' AND source_host = ? ORDER BY fetched_at DESC, id LIMIT 1",
      [host],
    );

  const store = (host: string, image: IconImage): string => {
    const id = newId();
    db.run('INSERT INTO icons (id, kind, source_host, content_type, bytes, width, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      id,
      'favicon',
      host,
      image.contentType,
      image.bytes,
      image.width,
      now(),
    ]);
    return id;
  };

  const linkHost = (host: string, iconId: string): number => {
    // Pre-filter in SQL (the URL contains the host), then compare the parsed host exactly.
    const rows = db.all<{ id: string; url: string; icon_id: string | null }>(
      "SELECT id, url, icon_id FROM bookmarks WHERE icon_mode = 'auto' AND instr(lower(url), ?) > 0",
      [host],
    );
    let changed = 0;
    db.tx(() => {
      for (const row of rows) {
        if (row.icon_id === iconId || hostKey(row.url) !== host) continue;
        db.run("UPDATE bookmarks SET icon_id = ? WHERE id = ? AND icon_mode = 'auto'", [iconId, row.id]);
        changed++;
      }
    });
    return changed;
  };

  // Single-flight per host: the body runs in the first caller's context, so it sets its own.
  const resolveHost = (host: string, url: string, page: FetchedPage | null | undefined): Promise<string | null> =>
    withLogContext({ area: 'bookmarks', op: 'favicon' }, async () => {
      const existing = newestFavicon(host);
      const started = Date.now();
      let found: FaviconResolution = { image: null, step: null, attempts: 0 };
      try {
        found = await traceFavicon(deps, url, page);
      } catch (err) {
        log.warn('favicon resolution failed', { host, ...errorFields(err) });
      }
      const image = found.image;
      if (!image) {
        const retryAt = now() + MISS_RETRY_MS;
        misses.set(host, retryAt);
        log.debug('favicon miss', { host, attempts: found.attempts, retryAt: new Date(retryAt).toISOString() });
        return existing?.id ?? null;
      }
      misses.delete(host);
      const id = store(host, image);
      linkHost(host, id);
      log.debug('favicon resolved', { host, step: found.step, attempts: found.attempts, ms: Date.now() - started });
      return id;
    });

  const ensure = (url: string, opts: EnsureOptions = {}): Promise<string | null> => {
    const host = hostKey(url);
    if (!host) return Promise.resolve(null);
    if (!opts.force) {
      const existing = newestFavicon(host);
      if (existing && Number(existing.fetched_at) > now() - ICON_MAX_AGE_MS) return Promise.resolve(existing.id);
      if ((misses.get(host) ?? 0) > now()) return Promise.resolve(existing?.id ?? null);
    }
    const running = inflight.get(host);
    if (running) return running;
    const p = resolveHost(host, url, opts.page).finally(() => inflight.delete(host));
    inflight.set(host, p);
    return p;
  };

  const settleIdle = (): void => {
    if (active === 0 && queue.length === 0) {
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const w of waiters) w();
    }
  };

  const pump = (): void => {
    while (active < concurrency && queue.length > 0) {
      const job = queue.shift()!;
      queued.delete(job.host);
      active++;
      const run = (): Promise<unknown> =>
        ensure(job.url, { force: job.force })
          .catch((err: unknown) => log.warn('background favicon job failed', { host: job.host, ...errorFields(err) }))
          .finally(() => {
            active--;
            pump();
            settleIdle();
          });
      // A job runs in the context of whoever queued it (its request, or the maintenance run), never
      // in that of the earlier job whose completion starts it.
      void outsideLogContext(() => (job.context ? withLogContext(job.context, run) : run()));
    }
    settleIdle();
  };

  const enqueue = (url: string, opts: { force?: boolean } = {}): void => {
    const host = hostKey(url);
    if (!host || queued.has(host) || inflight.has(host)) return;
    if (!opts.force) {
      const existing = newestFavicon(host);
      if (existing && Number(existing.fetched_at) > now() - ICON_MAX_AGE_MS) return;
      if ((misses.get(host) ?? 0) > now()) return;
    }
    queued.add(host);
    queue.push({ host, url, force: opts.force ?? false, context: getLogContext() });
    pump();
  };

  const collectGarbage = (): number => {
    const referenced = new Set<string>();
    for (const row of db.all<{ icon_id: string }>('SELECT DISTINCT icon_id FROM bookmarks WHERE icon_id IS NOT NULL')) {
      referenced.add(row.icon_id);
    }
    for (const id of options.externalReferences()) referenced.add(id);
    const t = now();
    let removed = 0;
    db.tx(() => {
      for (const row of db.all<{ id: string; kind: string; fetched_at: number }>('SELECT id, kind, fetched_at FROM icons')) {
        if (referenced.has(row.id)) continue;
        const fetchedAt = Number(row.fetched_at);
        const keep =
          row.kind === 'favicon'
            ? fetchedAt > t - FAVICON_GRACE_MS
            : fetchedAt > t - UPLOAD_GRACE_MS || (orphans.get(row.id) ?? 0) > t - UPLOAD_GRACE_MS;
        if (keep) continue;
        db.run('DELETE FROM icons WHERE id = ?', [row.id]);
        orphans.delete(row.id);
        removed++;
      }
    });
    return removed;
  };

  const service: FaviconService = {
    hostIcon(host) {
      return newestFavicon(host)?.id ?? null;
    },
    icon(id) {
      const row = db.get<{ id: string; kind: string }>('SELECT id, kind FROM icons WHERE id = ?', [id]);
      if (!row) return null;
      return { id: row.id, kind: row.kind === 'upload' ? 'upload' : 'favicon' };
    },
    orphaned(iconId) {
      orphans.set(iconId, now());
    },
    ensure,
    enqueue,
    idle() {
      if (active === 0 && queue.length === 0) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.push(resolve));
    },
    linkHost,
    read(id) {
      if (!isUuidV4(id)) return null;
      const row = db.get<IconRow>('SELECT id, kind, content_type, bytes FROM icons WHERE id = ?', [id.toLowerCase()]);
      if (!row) return null;
      const contentType = sniffImageType(row.bytes);
      if (!contentType || contentType !== row.content_type) return null;
      return { contentType, bytes: row.bytes };
    },
    storeUpload(bytes) {
      if (bytes.length > MAX_UPLOAD_ICON_BYTES) {
        throw new HttpError(413, 'payload_too_large', `Icons are limited to ${MAX_UPLOAD_ICON_BYTES} bytes`);
      }
      const contentType = sniffImageType(bytes);
      if (!contentType) {
        throw new HttpError(422, 'validation_failed', 'Unsupported image type (png, gif, jpeg, webp, avif, ico, bmp or svg)');
      }
      const id = newId();
      db.run("INSERT INTO icons (id, kind, source_host, content_type, bytes, width, fetched_at) VALUES (?, 'upload', NULL, ?, ?, ?, ?)", [
        id,
        contentType,
        bytes,
        imageSize(bytes, contentType),
        now(),
      ]);
      return id;
    },
    async maintenance() {
      if (options.autoFetch()) {
        const rows = db.all<{ url: string; icon_id: string | null; existing: string | null }>(
          "SELECT b.url, b.icon_id, i.id AS existing FROM bookmarks b LEFT JOIN icons i ON i.id = b.icon_id WHERE b.icon_mode = 'auto'",
        );
        const sample = new Map<string, string>();
        const missing = new Set<string>();
        for (const row of rows) {
          const host = hostKey(row.url);
          if (!host) continue;
          if (!sample.has(host)) sample.set(host, row.url);
          if (row.existing === null) missing.add(host);
        }
        for (const host of missing) {
          const fresh = newestFavicon(host);
          // A fresh icon for the host already exists (e.g. after a config import): just link it.
          if (fresh && Number(fresh.fetched_at) > now() - ICON_MAX_AGE_MS) linkHost(host, fresh.id);
          else enqueue(sample.get(host)!);
        }
        const cutoff = now() - ICON_MAX_AGE_MS;
        for (const [host, url] of sample) {
          if (missing.has(host) || (misses.get(host) ?? 0) > now()) continue;
          const newest = newestFavicon(host);
          if (newest && Number(newest.fetched_at) <= cutoff) enqueue(url, { force: true });
        }
        await service.idle();
      }
      const removed = collectGarbage();
      if (removed > 0) log.debug('icons garbage-collected', { removed });
    },
    collectGarbage,
  };
  return service;
}
