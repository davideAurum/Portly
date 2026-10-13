/**
 * Search module of the static backend (port of server/src/modules/search/index.ts):
 * `GET /api/search/suggest?provider=&q=` → `string[]` (≤ 8).
 *
 * - `provider` must be one of the five suggestion providers (422 otherwise).
 * - `q` is trimmed and capped at 200 characters; an empty query answers `[]`.
 * - `settings.search.suggestionsEnabled === false` answers `[]` without any network request.
 * - Only Wikipedia is asked (CORS with `origin=*`); Google, YouTube, DuckDuckGo and Bing send no
 *   CORS headers, so those providers answer `[]` without a request — the same answer the server
 *   gives on any upstream failure, and the widget shows no rows either way.
 * - Results are cached for 5 minutes in memory (key per provider + lower-cased query).
 * - Upstream failures (timeouts, non-2xx, bad JSON, network) answer `[]`, so a flaky provider
 *   never turns keystrokes into a storm of error toasts. Failures are not cached.
 * - The upstream call runs inside the cache's single flight, shared by concurrent requests for the
 *   same key, so it never takes one request's AbortSignal (as on the server): a superseded
 *   keystroke's lookup finishes under its 4 s deadline and fills the cache.
 */
import { z } from 'zod';
import { SuggestProviderSchema, type SuggestResponse } from '@homebase/shared';
import type { StaticContext } from '../context.ts';
import { createMemoryCache, type MemoryCache } from '../lib/cache.ts';
import { parseQuery } from '../lib/validate.ts';
import { fetchSuggestions, isBrowserSuggestProvider, normalizeQuery } from '../providers/suggest.ts';
import { json } from '../respond.ts';
import type { StaticRouter } from '../router.ts';
import { getSettings } from '../slices.ts';

export const SUGGEST_CACHE_TTL_MS = 5 * 60 * 1000;

const SuggestParams = z.object({
  provider: SuggestProviderSchema,
  q: z.string().max(10_000).optional(),
});

const caches = new WeakMap<StaticContext, MemoryCache>();

/** The backend's suggestion cache (one per context; exposed for tests). */
export function suggestCache(ctx: StaticContext): MemoryCache {
  let cache = caches.get(ctx);
  if (!cache) {
    cache = createMemoryCache({ now: ctx.now });
    caches.set(ctx, cache);
  }
  return cache;
}

export function register(router: StaticRouter): void {
  router.get('/api/search/suggest', async (ctx, { url }) => {
    const { provider, q: raw } = parseQuery(url, SuggestParams);
    const q = normalizeQuery(raw);
    if (q === '' || !getSettings(ctx).search.suggestionsEnabled) return json([] satisfies SuggestResponse);
    if (!isBrowserSuggestProvider(provider)) return json([] satisfies SuggestResponse);

    const key = `search:suggest:${provider}:${q.toLowerCase()}`;
    try {
      const list = await suggestCache(ctx).getOrSet<string[]>(key, SUGGEST_CACHE_TTL_MS, () => fetchSuggestions(provider, q));
      return json(list satisfies SuggestResponse);
    } catch {
      return json([] satisfies SuggestResponse);
    }
  });
}
