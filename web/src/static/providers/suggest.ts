/**
 * Search suggestion providers for the static backend — a copy of the pure parts of
 * server/src/modules/search/suggest.ts (`suggestUrl`, `parseSuggestions`, `normalizeQuery`,
 * `SuggestUpstreamError`, constants) plus the browser transport.
 *
 * Only Wikipedia can be asked from a browser: the MediaWiki API answers CORS requests when the
 * query carries `origin=*` (anonymous cross-site requests), while Google, YouTube, DuckDuckGo and
 * Bing send no `Access-Control-Allow-Origin` header at all. {@link fetchSuggestions} therefore
 * only ever calls Wikipedia; the handler answers `[]` for the other providers without a request,
 * which is also what the server answers on any upstream failure. The request stays "simple" (no
 * custom `Accept`) so there is no preflight.
 */
import { MAX_SUGGESTIONS, type SuggestProvider } from '@homebase/shared';
import { fetchTextCapped, type FetchLike } from '../lib/fetch.ts';
import { errorName, hostOf, recordProviderFailure, statusFailureCode, stopwatch, transportFailureCode } from './diagnostics.ts';

export const SUGGEST_TIMEOUT_MS = 4_000;
export const SUGGEST_MAX_BYTES = 256 * 1024;
export const MAX_QUERY_LENGTH = 200;
const MAX_SUGGESTION_LENGTH = 200;

/** Providers a browser can call directly (CORS). The others answer `[]` in the static build. */
export const BROWSER_SUGGEST_PROVIDERS: ReadonlySet<SuggestProvider> = new Set<SuggestProvider>(['wikipedia']);

export function isBrowserSuggestProvider(provider: SuggestProvider): boolean {
  return BROWSER_SUGGEST_PROVIDERS.has(provider);
}

/** Provider endpoint for a query (the query is URI-component encoded) — identical to the server's. */
export function suggestUrl(provider: SuggestProvider, q: string): string {
  const query = encodeURIComponent(q);
  switch (provider) {
    case 'google':
      return `https://suggestqueries.google.com/complete/search?client=firefox&q=${query}`;
    case 'youtube':
      return `https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=${query}`;
    case 'ddg':
      return `https://duckduckgo.com/ac/?type=list&q=${query}`;
    case 'bing':
      return `https://api.bing.com/osjson.aspx?query=${query}`;
    case 'wikipedia':
      return `https://en.wikipedia.org/w/api.php?action=opensearch&format=json&namespace=0&limit=8&search=${query}`;
  }
}

/** The URL a browser must use: Wikipedia needs `origin=*` to send CORS headers to anonymous callers. */
export function browserSuggestUrl(provider: SuggestProvider, q: string): string {
  const url = suggestUrl(provider, q);
  return provider === 'wikipedia' ? `${url}&origin=*` : url;
}

/** Takes index 1 of the provider response: strings only, trimmed, de-duplicated, ≤ 8. */
export function parseSuggestions(data: unknown): string[] {
  if (!Array.isArray(data)) return [];
  const list: unknown = data[1];
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const text = item.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
    if (text === '' || text.length > MAX_SUGGESTION_LENGTH) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= MAX_SUGGESTIONS) break;
  }
  return out;
}

/** Normalizes the user's query: trimmed and capped at 200 characters (code points). */
export function normalizeQuery(q: unknown): string {
  if (typeof q !== 'string') return '';
  const chars = Array.from(q.trim());
  return (chars.length > MAX_QUERY_LENGTH ? chars.slice(0, MAX_QUERY_LENGTH).join('') : chars.join('')).trim();
}

export class SuggestUpstreamError extends Error {
  override name = 'SuggestUpstreamError';
  readonly status: number;
  constructor(status: number) {
    super(`Suggestion provider answered ${status}`);
    this.status = status;
  }
}

export interface SuggestFetchOptions {
  /**
   * A caller's signal; its abort is rethrown as-is. The handlers pass none: the call runs inside
   * the cache's single flight, shared by every concurrent request for the same key.
   */
  signal?: AbortSignal | null;
  /** Transport override for tests (default `globalThis.fetch`). */
  fetch?: FetchLike;
}

/**
 * Asks the provider from the browser. Resolves with the parsed suggestions; rejects on a non-2xx
 * answer ({@link SuggestUpstreamError}), malformed JSON, a timeout (4 s) or a network failure — the
 * handler turns every rejection into `[]`. Providers without CORS resolve `[]` without a request.
 * A failure is also an info `provider` event (host, status, code — never the search text).
 */
export async function fetchSuggestions(provider: SuggestProvider, q: string, options: SuggestFetchOptions = {}): Promise<string[]> {
  if (!isBrowserSuggestProvider(provider)) return [];
  const url = browserSuggestUrl(provider, q);
  const elapsed = stopwatch();
  let status: number;
  let text: string;
  try {
    ({ status, text } = await fetchTextCapped(
      url,
      { method: 'GET', credentials: 'omit' },
      { timeoutMs: SUGGEST_TIMEOUT_MS, maxBytes: SUGGEST_MAX_BYTES, signal: options.signal, fetch: options.fetch },
    ));
  } catch (err) {
    const code = transportFailureCode(err);
    if (code !== null) recordProviderFailure('wikipedia', hostOf(url), { code, errName: errorName(err), ms: elapsed() }, 'info');
    throw err;
  }
  if (status < 200 || status >= 300) {
    recordProviderFailure('wikipedia', hostOf(url), { status, code: statusFailureCode(status), ms: elapsed() }, 'info');
    throw new SuggestUpstreamError(status);
  }
  try {
    return parseSuggestions(JSON.parse(text) as unknown);
  } catch (err) {
    recordProviderFailure('wikipedia', hostOf(url), { status, code: 'parse_error', errName: errorName(err), ms: elapsed() }, 'info');
    throw err;
  }
}
