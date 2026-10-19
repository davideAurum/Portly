/**
 * Engine selection helpers for the search widget (§10.8): which engines a widget offers, the
 * default, keyword lookup, the suggestion provider in effect (and the one this page load can ask
 * for it) and bookmark matching.
 */
import { buildSearchUrl, type Bookmark, type BookmarkGroup, type SearchEngine, type SearchSettings, type SuggestProvider } from '@portly/shared';
import { getCapabilities } from '../../capabilities.ts';
import type { SearchConfig } from './index.ts';

export { buildSearchUrl };

/** Engines offered by a widget (settings order); an empty selection falls back to all engines. */
export function widgetEngines(settings: SearchSettings, engineIds: SearchConfig['engineIds']): SearchEngine[] {
  if (engineIds === 'all') return settings.engines;
  const wanted = new Set(engineIds);
  const list = settings.engines.filter((e) => wanted.has(e.id));
  return list.length > 0 ? list : settings.engines;
}

/** The widget's default engine: the global default if offered, else the first offered engine. */
export function defaultEngine(engines: readonly SearchEngine[], defaultEngineId: string): SearchEngine | undefined {
  return engines.find((e) => e.id === defaultEngineId) ?? engines[0];
}

export function engineForKeyword(engines: readonly SearchEngine[], keyword: string): SearchEngine | undefined {
  const kw = keyword.trim().toLowerCase();
  if (kw === '') return undefined;
  return engines.find((e) => e.keyword !== null && e.keyword.toLowerCase() === kw);
}

/**
 * Suggestion provider (§10.8): the engine's, else the default engine's (the global default, then
 * the widget's own default when the global one has none), else none — and none when disabled.
 */
export function suggestProviderFor(
  settings: SearchSettings,
  engine: SearchEngine | undefined,
  fallback: SearchEngine | undefined,
): SuggestProvider | null {
  if (!settings.suggestionsEnabled) return null;
  const globalDefault = settings.engines.find((e) => e.id === settings.defaultEngineId);
  return engine?.suggest ?? globalDefault?.suggest ?? fallback?.suggest ?? null;
}

/** The provider every page load can ask: Wikipedia answers a browser directly (CORS). */
export const BROWSER_SUGGEST_FALLBACK: SuggestProvider = 'wikipedia';

/**
 * Whether this page load can ask `provider` for suggestions. Portly asks every provider; the
 * in-browser backend reaches only Wikipedia (Google, DuckDuckGo, Bing and YouTube send no CORS
 * headers). The stored setting is unchanged either way.
 */
export function isSuggestProviderAvailable(provider: SuggestProvider): boolean {
  return getCapabilities().serverSearchSuggestions || provider === BROWSER_SUGGEST_FALLBACK;
}

/**
 * The provider this page load asks for `provider`'s suggestions: itself when it can; otherwise
 * Wikipedia's when this browser has turned that on (`wikipediaFallback.ts`; the widget then labels
 * them as Wikipedia's, not the engine's), else none.
 */
export function reachableSuggestProvider(provider: SuggestProvider, wikipediaFallback: boolean): SuggestProvider | null {
  if (isSuggestProviderAvailable(provider)) return provider;
  return wikipediaFallback ? BROWSER_SUGGEST_FALLBACK : null;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Bookmarks matching the query by title (prefix, word start, substring) or host, best first. */
export function matchBookmarks(groups: readonly BookmarkGroup[] | undefined, query: string, limit = 4): Bookmark[] {
  const needle = query.trim().toLowerCase();
  if (needle === '' || !groups) return [];
  const scored: { bookmark: Bookmark; score: number }[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const bookmark of group.bookmarks) {
      if (seen.has(bookmark.url)) continue;
      const title = bookmark.title.toLowerCase();
      const host = hostOf(bookmark.url).toLowerCase();
      let score = 0;
      if (title.startsWith(needle)) score = 4;
      else if (host.startsWith(needle)) score = 3.5;
      else if (title.split(/[\s\-_/.:|·—]+/).some((word) => word.startsWith(needle))) score = 3;
      else if (title.includes(needle)) score = 2;
      else if (host.includes(needle)) score = 1;
      if (score > 0) {
        seen.add(bookmark.url);
        scored.push({ bookmark, score });
      }
    }
  }
  return scored
    .sort((a, b) => b.score - a.score || a.bookmark.title.length - b.bookmark.title.length)
    .slice(0, limit)
    .map((s) => s.bookmark);
}

export function bookmarkHost(url: string): string {
  return hostOf(url);
}
