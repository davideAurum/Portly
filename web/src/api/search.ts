/**
 * Search suggestions (§7 Search, §8): `GET /api/search/suggest?provider=&q=` → `string[]` (≤ 8).
 * The server answers `[]` when suggestions are disabled or the provider fails, so the widget never
 * shows error states for suggestions. Queries are keyed per provider + query; switching the key
 * (typing) aborts the previous in-flight request because the query function consumes `signal`.
 * Suggestions are never persisted to localStorage.
 */
import { useQuery } from '@tanstack/react-query';
import type { SuggestProvider } from '@portly/shared';
import { apiGet } from './client.ts';
import { qk } from './keys.ts';

export const SUGGEST_STALE_MS = 5 * 60 * 1000;

export async function fetchSuggestions(provider: SuggestProvider, q: string, signal?: AbortSignal): Promise<string[]> {
  const list = await apiGet<unknown>(`/api/search/suggest?provider=${encodeURIComponent(provider)}&q=${encodeURIComponent(q)}`, { signal });
  return Array.isArray(list) ? list.filter((s): s is string => typeof s === 'string').slice(0, 8) : [];
}

/** Suggestions for `q` (already debounced by the caller); disabled when `provider` is null or `q` is empty. */
export function useSuggestions(provider: SuggestProvider | null, q: string) {
  const query = q.trim();
  return useQuery({
    queryKey: qk.search.suggest(provider ?? 'google', query),
    queryFn: ({ signal }) => fetchSuggestions(provider!, query, signal),
    enabled: provider !== null && query !== '',
    staleTime: SUGGEST_STALE_MS,
    gcTime: SUGGEST_STALE_MS,
    retry: false,
    refetchOnWindowFocus: false,
    // While typing on ("weather ch" → "weather chi") the previous list stays up; after deleting or
    // replacing the text ("w" after "weather chic") nothing stale is shown (UX-12).
    placeholderData: (previous, previousQuery) => {
      const before = previousQuery?.queryKey[3];
      return typeof before === 'string' && before !== '' && query.toLowerCase().startsWith(before.toLowerCase()) ? previous : undefined;
    },
    meta: { persist: false },
  });
}
