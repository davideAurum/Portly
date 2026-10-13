/**
 * Search suggestion providers (§8 Search suggestions). Every provider answers an OpenSearch-style
 * array `[query, string[], ...]`; index 1 holds the suggestions. Requests use safe-fetch policy
 * `provider` (fixed vendor endpoints) with purpose `suggest.<provider>`, and send the Homebase
 * User-Agent (added by safe-fetch).
 */
import { MAX_SUGGESTIONS, type SuggestProvider } from '@homebase/shared';
import { SafeFetchError, type SafeFetch } from '../../security/safe-fetch.ts';

export const SUGGEST_TIMEOUT_MS = 4_000;
export const SUGGEST_MAX_BYTES = 256 * 1024;
export const MAX_QUERY_LENGTH = 200;
const MAX_SUGGESTION_LENGTH = 200;

/** Provider endpoint for a query (the query is URI-component encoded). */
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

/**
 * Asks the provider. The body is read as text and parsed after the status check, so an error page
 * (HTML 503) fails as {@link SuggestUpstreamError} with its status rather than as invalid JSON.
 */
export async function fetchSuggestions(fetch: SafeFetch, provider: SuggestProvider, q: string): Promise<string[]> {
  const url = suggestUrl(provider, q);
  const res = await fetch(url, {
    policy: 'provider',
    as: 'text',
    maxBytes: SUGGEST_MAX_BYTES,
    timeoutMs: SUGGEST_TIMEOUT_MS,
    headers: { Accept: 'application/json, application/x-suggestions+json;q=0.9, */*;q=0.5' },
    purpose: `suggest.${provider}`,
  });
  if (res.status < 200 || res.status >= 300) throw new SuggestUpstreamError(res.status);
  if (res.data.trim() === '') return [];
  let data: unknown;
  try {
    data = JSON.parse(res.data);
  } catch {
    const host = new URL(url).host;
    throw new SafeFetchError('invalid_json', `Invalid JSON from ${host}`, host);
  }
  return parseSuggestions(data);
}
