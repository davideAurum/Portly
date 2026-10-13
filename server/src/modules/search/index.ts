/**
 * Search module (§7 Search, §8): `GET /api/search/suggest?provider=&q=` → `string[]` (≤ 8),
 * declared `paired()` (the paired Pages site may use it too).
 *
 * - `provider` must be one of the five suggestion providers (422 otherwise).
 * - `q` is trimmed and capped at 200 characters; an empty query answers `[]`.
 * - `settings.search.suggestionsEnabled === false` answers `[]` without any network request.
 * - Results are cached for 5 minutes in the SQLite cache (non-sensitive; key per provider + query).
 * - Upstream failures (timeouts, non-2xx, bad JSON) answer `[]`, so a flaky provider never turns
 *   keystrokes into a storm of error toasts. Failures are not cached.
 *
 * Diagnostics (§17): every provider call (a cache miss) records health key `suggest:<provider>`
 * (on demand, never stale), so a failing provider shows up once — the health tracker logs
 * transitions only (`search failing` / `search recovered`); each failed keystroke is a debug line.
 * Never the query: outbound purpose `suggest.<provider>`, health detail `{host}`.
 */
import type { Hono } from 'hono';
import { z } from 'zod';
import { SuggestProviderSchema, type SuggestProvider, type SuggestResponse } from '@portly/shared';
import type { AppContext, AppEnv } from '../../context.ts';
import { outcomeFromError, type HealthSubject, type Outcome } from '../../lib/health.ts';
import { withLogContext } from '../../lib/log-context.ts';
import { errorFields } from '../../lib/logger.ts';
import { paired } from '../../lib/routes.ts';
import { parseQuery } from '../../lib/validate.ts';
import { SuggestUpstreamError, fetchSuggestions, normalizeQuery, suggestUrl } from './suggest.ts';

export const prefixes = ['/api/search'] as const;

export const SUGGEST_CACHE_TTL_MS = 5 * 60 * 1000;

const SuggestParams = z.object({
  provider: SuggestProviderSchema,
  q: z.string().max(10_000).optional(),
});

const PROVIDER_LABELS: Readonly<Record<SuggestProvider, string>> = {
  google: 'Google',
  youtube: 'YouTube',
  ddg: 'DuckDuckGo',
  bing: 'Bing',
  wikipedia: 'Wikipedia',
};

/** A suggestion provider's subject (key `suggest:<provider>`): checked on demand, so never stale. */
export function suggestHealthSubject(provider: SuggestProvider): HealthSubject {
  return { key: `suggest:${provider}`, area: 'search', label: PROVIDER_LABELS[provider], expectEveryMs: null };
}

/** The provider's host (health detail; the query never leaves `suggestUrl`). */
function providerHost(provider: SuggestProvider): string {
  return new URL(suggestUrl(provider, '')).host;
}

export function register(app: Hono<AppEnv>, ctx: AppContext): void {
  const log = ctx.log.child({ module: 'search' });

  /** One provider call (a cache miss), its outcome recorded on `suggest:<provider>`. */
  const fetchTracked = (provider: SuggestProvider, q: string): Promise<string[]> =>
    withLogContext({ area: 'search', op: 'suggest' }, async () => {
      const subject = suggestHealthSubject(provider);
      const host = providerHost(provider);
      const started = Date.now();
      try {
        const list = await fetchSuggestions(ctx.fetch, provider, q);
        ctx.health.record(subject, { ok: true, ms: Date.now() - started, detail: { host } });
        return list;
      } catch (err) {
        const extra: Partial<Outcome> = { ms: Date.now() - started, detail: { host } };
        // Its message ("Suggestion provider answered 503") is ours; outcomeFromError keeps only HttpError ones.
        if (err instanceof SuggestUpstreamError) extra.message = err.message;
        ctx.health.record(subject, outcomeFromError(err, extra));
        throw err;
      }
    });

  app.get('/api/search/suggest', paired(), async (c) => {
    const { provider, q: raw } = parseQuery(c, SuggestParams);
    const q = normalizeQuery(raw);
    if (q === '' || !ctx.settings.get('search').suggestionsEnabled) return c.json([] satisfies SuggestResponse);

    const key = `search:suggest:${provider}:${q.toLowerCase()}`;
    try {
      const list = await ctx.cache.getOrSet<string[]>(key, SUGGEST_CACHE_TTL_MS, () => fetchTracked(provider, q));
      return c.json(list satisfies SuggestResponse);
    } catch (err) {
      // Per keystroke: the `suggest:<provider>` health transition is the visible line.
      log.debug('suggestions unavailable', { provider, ...errorFields(err) });
      return c.json([] satisfies SuggestResponse);
    }
  });
}
