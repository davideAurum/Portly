/**
 * Every TanStack Query key in the app (§7a). Keys are hierarchical so that a prefix invalidates a
 * whole family, e.g. account create/delete/reconnect invalidates ['accounts'], ['calendar'], ['mail'].
 */
import type { LogsQuery, OAuthProvider, SuggestProvider } from '@portly/shared';
import type { QueryClient } from '@tanstack/react-query';

/** Rounds coordinates the same way the server's weather cache does (2 decimals). */
function coord(value: number): number {
  return Math.round(value * 100) / 100;
}

export const qk = {
  health: () => ['health'] as const,
  about: () => ['about'] as const,
  settings: () => ['settings'] as const,
  profiles: () => ['profiles'] as const,
  accounts: () => ['accounts'] as const,
  oauthClients: {
    all: () => ['oauth-clients'] as const,
    detail: (provider: OAuthProvider) => ['oauth-clients', provider] as const,
  },
  bookmarks: {
    all: () => ['bookmarks'] as const,
    importSources: () => ['bookmarks', 'import-sources'] as const,
    siteMeta: (url: string) => ['bookmarks', 'site-meta', url] as const,
  },
  icons: (iconId: string) => ['icons', iconId] as const,
  uploads: {
    /** What the stored Appearance background would gain from being prepared (not persisted). */
    backgroundCheck: (uploadId: string) => ['uploads', 'background-check', uploadId] as const,
  },
  search: {
    all: () => ['search'] as const,
    suggest: (provider: SuggestProvider, q: string) => ['search', 'suggest', provider, q] as const,
  },
  weather: (lat: number, lon: number) => ['weather', 'report', coord(lat), coord(lon)] as const,
  geocode: (q: string) => ['weather', 'geocode', q] as const,
  todoist: {
    all: () => ['todoist'] as const,
    token: () => ['todoist', 'token'] as const,
    tasks: (filter: string) => ['todoist', 'tasks', filter] as const,
    projects: () => ['todoist', 'projects'] as const,
  },
  calendar: {
    all: () => ['calendar'] as const,
    calendars: () => ['calendar', 'calendars'] as const,
    /** `calendars`: 'visible' (the server's default) or the sorted, comma-joined ids of a widget's own list. */
    events: (from: string, to: string, tz: string, calendars: string = 'visible') => ['calendar', 'events', from, to, tz, calendars] as const,
  },
  mail: {
    all: () => ['mail'] as const,
    summary: () => ['mail', 'summary'] as const,
  },
  feeds: {
    all: () => ['feeds'] as const,
    feed: (url: string) => ['feeds', 'feed', url] as const,
  },
  sports: {
    all: () => ['sports'] as const,
    teams: (league: string) => ['sports', 'teams', league] as const,
    games: (league: string, teamId: string) => ['sports', 'games', league, teamId] as const,
  },
  /** The configured Pages address and the browsers paired with it (server's own page only). */
  pairings: () => ['pairings'] as const,
  /** The other PCs connected through the remote origin and the requests waiting (never persisted). */
  devices: () => ['devices'] as const,
  /** Settings → Diagnostics (never persisted: the whole family is in NON_PERSISTED_ROOTS, app/providers.tsx). */
  diagnostics: {
    all: () => ['diagnostics'] as const,
    summary: () => ['diagnostics', 'summary'] as const,
    logs: (filters: Partial<LogsQuery>) => ['diagnostics', 'logs', filters] as const,
    history: (key: string) => ['diagnostics', 'history', key] as const,
  },
} as const;

/** Prefixes invalidated whenever an account is created, deleted or reconnected. */
export const ACCOUNT_DEPENDENT_KEYS = [qk.accounts(), qk.calendar.all(), qk.mail.all()] as const;

export async function invalidateAccountData(client: QueryClient): Promise<void> {
  await Promise.all(ACCOUNT_DEPENDENT_KEYS.map((queryKey) => client.invalidateQueries({ queryKey })));
}
