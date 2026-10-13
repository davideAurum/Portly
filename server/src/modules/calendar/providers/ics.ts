/**
 * ICS / webcal subscriptions (§8 ICS, read-only): `webcal://` → `https://` (IcsFeedUrlSchema);
 * the full URL is the vault secret `ics:<calendarId>` and only the host is ever displayed or
 * logged; fetched with safe-fetch's `public` policy (SSRF guard, 10 MB cap, purpose `ics.fetch`)
 * using conditional GET (ETag / Last-Modified kept in `calendars.sync_state`); parsed and
 * expanded in the worker.
 *
 * Failures are HttpErrors with Portly messages built from the host and status: an error status
 * keeps it as `httpStatus` ({@link IcsHttpError}), a transport failure keeps the SafeFetchError as
 * `cause` ({@link feedTransportError}), a parse failure names its health code in `details.reason`.
 * What the request saw ({@link IcsFetchInfo}: status, final host, redirects, size) feeds the
 * `ics:<id>` health detail (§17).
 */
import { z } from 'zod';
import type { ErrorCode } from '@portly/shared';
import type { AppContext } from '../../../context.ts';
import { HttpError } from '../../../lib/errors.ts';
import { SIZE_CAPS, SafeFetchError } from '../../../security/safe-fetch.ts';
import type { ExpandResult } from '../ical/expand.ts';
import { expandFailureCode, type ExpandRunner } from '../ical/run.ts';
import type { SyncWindow } from '../time.ts';
import { truncationWarning } from '../store.ts';
import type { EventRecord } from '../types.ts';

export const ICS_SECRET_PREFIX = 'ics:';
export const ICS_TIMEOUT_MS = 20_000;

export function icsSecretId(calendarId: string): string {
  return `${ICS_SECRET_PREFIX}${calendarId}`;
}

const IcsSyncStateSchema = z.object({
  etag: z.string().max(500).nullable().default(null),
  lastModified: z.string().max(100).nullable().default(null),
  /** Window start the cached rows were expanded for (conditional GET only within the same window). */
  windowFrom: z.string().max(10).nullable().default(null),
});
export type IcsSyncState = z.output<typeof IcsSyncStateSchema>;

export function parseIcsSyncState(text: string | null): IcsSyncState | null {
  if (!text) return null;
  try {
    const parsed = IcsSyncStateSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** What a feed request saw: hosts and sizes only (never the URL, whose path may hold a token). */
export interface IcsFetchInfo {
  /** Status of the final answer (304: not modified). */
  status: number;
  /** Host of the final URL when redirects led to another host; null otherwise. */
  finalHost: string | null;
  /** Redirects followed (0: none). */
  redirects: number;
  /** Size of the body (UTF-8 bytes); null for a 304. */
  bytes: number | null;
}

export type IcsFetchResult =
  | { kind: 'not_modified'; info: IcsFetchInfo }
  | { kind: 'body'; text: string; etag: string | null; lastModified: string | null; info: IcsFetchInfo };

/** A feed answered with an error status, kept as `httpStatus` (logs and health: the upstream status). */
export class IcsHttpError extends HttpError {
  override name = 'IcsHttpError';
  readonly httpStatus: number;
  constructor(httpStatus: number, code: ErrorCode, message: string) {
    super(code === 'rate_limited' ? 429 : 502, code, message);
    this.httpStatus = httpStatus;
  }
}

/** The safe-fetch failure behind a feed error (its reason, hosts and cause chain), or null. */
export function feedTransportError(err: unknown): SafeFetchError | null {
  return err instanceof HttpError && err.cause instanceof SafeFetchError ? err.cause : null;
}

/** The host a blocked feed request was refused at (the feed's own host, or a redirect hop's), or null. */
export function blockedHost(err: unknown): string | null {
  const transport = feedTransportError(err);
  return transport?.reason === 'blocked' ? transport.host : null;
}

function finalHostOf(finalUrl: string, host: string): string | null {
  try {
    const final = new URL(finalUrl).host;
    return final !== host ? final : null;
  } catch {
    return null;
  }
}

/** Host of a feed URL for display/logs (never the path or query, which may hold a token). */
export function feedHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'feed';
  }
}

/**
 * GETs a feed; sends `If-None-Match` / `If-Modified-Since` only when `state` belongs to the same
 * sync window (a new day re-expands recurrences, so it needs the body).
 */
export async function fetchIcsFeed(
  fetch: AppContext['fetch'],
  url: string,
  state: IcsSyncState | null,
  window: SyncWindow,
): Promise<IcsFetchResult> {
  const headers: Record<string, string> = { Accept: 'text/calendar, text/plain;q=0.8, */*;q=0.5' };
  if (state && state.windowFrom === window.fromDate) {
    if (state.etag) headers['If-None-Match'] = state.etag;
    if (state.lastModified) headers['If-Modified-Since'] = state.lastModified;
  }
  const host = feedHost(url);
  let res;
  try {
    res = await fetch(url, { policy: 'public', as: 'text', headers, maxBytes: SIZE_CAPS.ics, timeoutMs: ICS_TIMEOUT_MS, purpose: 'ics.fetch' });
  } catch (err) {
    if (err instanceof SafeFetchError) {
      if (err.reason === 'blocked') {
        const hop = err.host !== null && err.host !== host ? err.host : null;
        const message = hop ? `${host} redirected to ${hop}, a private or reserved address` : `${host} is a private or reserved address`;
        throw new HttpError(502, 'provider_error', { message, cause: err });
      }
      if (err.reason === 'too_large') throw new HttpError(502, 'provider_error', { message: `The feed from ${host} is larger than 10 MB`, cause: err });
      if (err.reason === 'timeout') throw new HttpError(504, 'upstream_timeout', { message: `${host} did not respond in time`, cause: err });
      throw new HttpError(502, 'provider_error', { message: `Could not reach ${host}`, cause: err });
    }
    throw err;
  }
  const info: IcsFetchInfo = { status: res.status, finalHost: finalHostOf(res.url, host), redirects: res.redirects ?? 0, bytes: null };
  if (res.status === 304) return { kind: 'not_modified', info };
  if (res.status === 401 || res.status === 403) throw new IcsHttpError(res.status, 'provider_error', `${host} refused access to the feed (${res.status})`);
  if (res.status === 404 || res.status === 410) throw new IcsHttpError(res.status, 'provider_error', `${host} says the feed does not exist (${res.status})`);
  if (res.status === 429) throw new IcsHttpError(res.status, 'rate_limited', `${host} is rate limiting requests`);
  if (res.status < 200 || res.status >= 300) throw new IcsHttpError(res.status, 'provider_error', `${host} answered ${res.status}`);
  return {
    kind: 'body',
    text: res.data,
    etag: res.headers.get('etag')?.slice(0, 500) ?? null,
    lastModified: res.headers.get('last-modified')?.slice(0, 100) ?? null,
    info: { ...info, bytes: Buffer.byteLength(res.data) },
  };
}

export type IcsLoadResult =
  | { kind: 'unchanged'; info: IcsFetchInfo }
  | {
      kind: 'events';
      info: IcsFetchInfo;
      events: EventRecord[];
      syncState: string;
      name: string | null;
      color: string | null;
      /** Non-fatal warning (shortened repeating events), or null. */
      warning: string | null;
    };

/**
 * Fetches and expands a feed. Parse failures and feed-level limits throw 502 (unreadable data
 * 422) with the parser's message; events shortened by the per-event limits only produce a warning.
 */
export async function loadIcsFeed(
  fetch: AppContext['fetch'],
  runExpand: ExpandRunner,
  url: string,
  state: IcsSyncState | null,
  window: SyncWindow,
): Promise<IcsLoadResult> {
  const fetched = await fetchIcsFeed(fetch, url, state, window);
  if (fetched.kind === 'not_modified') return { kind: 'unchanged', info: fetched.info };
  const result: ExpandResult = await runExpand({
    sources: [{ data: fetched.text }],
    window: { fromDate: window.fromDate, toDate: window.toDate, fromMs: window.fromMs, toMs: window.toMs },
    localTz: window.tz,
  });
  if (!result.ok) {
    throw new HttpError(result.reason === 'invalid' ? 422 : 502, result.reason === 'invalid' ? 'validation_failed' : 'provider_error', {
      message: result.message,
      details: { reason: expandFailureCode(result.reason) },
    });
  }
  const syncState: IcsSyncState = { etag: fetched.etag, lastModified: fetched.lastModified, windowFrom: window.fromDate };
  return {
    kind: 'events',
    info: fetched.info,
    events: result.events,
    syncState: JSON.stringify(syncState),
    name: result.name,
    color: result.color,
    warning: truncationWarning(result.truncated, result.descriptionsDropped),
  };
}
