/**
 * Search engines, suggestion providers and the `search` settings namespace (§7a search.ts, §10.8).
 */
import { z } from 'zod';
import { EntityId, RECORD_KEY_REGEX, SafeHttpUrl } from './core.ts';

export const SUGGEST_PROVIDERS = ['google', 'ddg', 'bing', 'wikipedia', 'youtube'] as const;
export const SuggestProviderSchema = z.enum(SUGGEST_PROVIDERS);
export type SuggestProvider = z.output<typeof SuggestProviderSchema>;

export const MAX_SEARCH_ENGINES = 50;
export const MAX_SUGGESTIONS = 8;

/** Engine id: preset ids (`google`, `google-maps`, …) or UUIDs for user-created engines. */
export const SearchEngineIdSchema = z.string().regex(RECORD_KEY_REGEX, { message: 'Invalid engine id' });

/** Keyword typed before a space to switch engine (`yt cats`). No whitespace, ≤ 16 chars. */
export const SearchKeywordSchema = z
  .string()
  .trim()
  .min(1)
  .max(16)
  .regex(/^\S+$/, { message: 'Keyword cannot contain spaces' });

/** A SafeHttpUrl that contains the `%s` query placeholder. */
export const SearchUrlTemplateSchema = SafeHttpUrl.refine((s) => s.includes('%s'), {
  message: 'URL template must contain %s',
});

export const SearchEngineSchema = z
  .object({
    id: SearchEngineIdSchema,
    name: z.string().trim().min(1).max(64),
    urlTemplate: SearchUrlTemplateSchema,
    keyword: SearchKeywordSchema.nullable().default(null),
    suggest: SuggestProviderSchema.nullable().default(null),
    iconId: EntityId.nullable().default(null),
  })
  .strict();
export type SearchEngine = z.output<typeof SearchEngineSchema>;
export type SearchEngineInput = z.input<typeof SearchEngineSchema>;

/** Substitutes the (URI-component-encoded) query into an engine's URL template. */
export function buildSearchUrl(urlTemplate: string, query: string): string {
  return urlTemplate.split('%s').join(encodeURIComponent(query));
}

export interface SearchEnginePreset {
  id: string;
  name: string;
  urlTemplate: string;
  keyword: string;
  suggest: SuggestProvider;
}

/** Preset catalog offered in Settings → Search ("Add from preset"). */
export const SEARCH_ENGINE_PRESETS: readonly SearchEnginePreset[] = Object.freeze([
  { id: 'google', name: 'Google', urlTemplate: 'https://www.google.com/search?q=%s', keyword: 'g', suggest: 'google' },
  { id: 'duckduckgo', name: 'DuckDuckGo', urlTemplate: 'https://duckduckgo.com/?q=%s', keyword: 'd', suggest: 'ddg' },
  { id: 'bing', name: 'Bing', urlTemplate: 'https://www.bing.com/search?q=%s', keyword: 'b', suggest: 'bing' },
  {
    id: 'youtube',
    name: 'YouTube',
    urlTemplate: 'https://www.youtube.com/results?search_query=%s',
    keyword: 'yt',
    suggest: 'youtube',
  },
  {
    id: 'wikipedia',
    name: 'Wikipedia',
    urlTemplate: 'https://en.wikipedia.org/wiki/Special:Search?search=%s',
    keyword: 'w',
    suggest: 'wikipedia',
  },
  {
    id: 'google-maps',
    name: 'Google Maps',
    urlTemplate: 'https://www.google.com/maps/search/%s',
    keyword: 'm',
    suggest: 'google',
  },
  { id: 'github', name: 'GitHub', urlTemplate: 'https://github.com/search?q=%s', keyword: 'gh', suggest: 'google' },
  { id: 'amazon', name: 'Amazon', urlTemplate: 'https://www.amazon.com/s?k=%s', keyword: 'a', suggest: 'google' },
  { id: 'reddit', name: 'Reddit', urlTemplate: 'https://www.reddit.com/search/?q=%s', keyword: 'r', suggest: 'google' },
  {
    id: 'perplexity',
    name: 'Perplexity',
    urlTemplate: 'https://www.perplexity.ai/search?q=%s',
    keyword: 'pp',
    suggest: 'google',
  },
  { id: 'chatgpt', name: 'ChatGPT', urlTemplate: 'https://chatgpt.com/?q=%s', keyword: 'gpt', suggest: 'google' },
  { id: 'claude', name: 'Claude', urlTemplate: 'https://claude.ai/new?q=%s', keyword: 'c', suggest: 'google' },
]);

/** Ids of the presets enabled on a fresh install, in display order. */
export const DEFAULT_ENGINE_IDS = ['google', 'duckduckgo', 'bing', 'youtube', 'wikipedia', 'google-maps'] as const;
export const DEFAULT_ENGINE_ID = 'google';

export function presetToEngine(preset: SearchEnginePreset): SearchEngine {
  return {
    id: preset.id,
    name: preset.name,
    urlTemplate: preset.urlTemplate,
    keyword: preset.keyword,
    suggest: preset.suggest,
    iconId: null,
  };
}

export function defaultSearchEngines(): SearchEngine[] {
  return DEFAULT_ENGINE_IDS.map((id) => {
    const preset = SEARCH_ENGINE_PRESETS.find((p) => p.id === id);
    if (!preset) throw new Error(`Unknown default search engine preset: ${id}`);
    return presetToEngine(preset);
  });
}

/** `settings.search` */
export const SearchSettingsSchema = z
  .object({
    engines: z.array(SearchEngineSchema).min(1).max(MAX_SEARCH_ENGINES).default(defaultSearchEngines),
    defaultEngineId: SearchEngineIdSchema.default(DEFAULT_ENGINE_ID),
    suggestionsEnabled: z.boolean().default(true),
    showBookmarkMatches: z.boolean().default(true),
  })
  .strict()
  .superRefine((s, ctx) => {
    const ids = new Set<string>();
    const keywords = new Set<string>();
    s.engines.forEach((engine, index) => {
      if (ids.has(engine.id)) {
        ctx.addIssue({ code: 'custom', message: `Duplicate engine id "${engine.id}"`, path: ['engines', index, 'id'] });
      }
      ids.add(engine.id);
      if (engine.keyword !== null) {
        const kw = engine.keyword.toLowerCase();
        if (keywords.has(kw)) {
          ctx.addIssue({
            code: 'custom',
            message: `Duplicate keyword "${engine.keyword}"`,
            path: ['engines', index, 'keyword'],
          });
        }
        keywords.add(kw);
      }
    });
    if (!ids.has(s.defaultEngineId)) {
      ctx.addIssue({ code: 'custom', message: 'defaultEngineId must reference an engine', path: ['defaultEngineId'] });
    }
  });
export type SearchSettings = z.output<typeof SearchSettingsSchema>;

/** `GET /api/search/suggest?provider=&q=` → `string[]` (≤ 8). */
export const SuggestQuerySchema = z
  .object({
    provider: SuggestProviderSchema,
    q: z.string().trim().min(1).max(200),
  });
export type SuggestQuery = z.output<typeof SuggestQuerySchema>;

export const SuggestResponseSchema = z.array(z.string()).max(MAX_SUGGESTIONS);
export type SuggestResponse = z.output<typeof SuggestResponseSchema>;
