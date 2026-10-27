/**
 * Status of the in-browser backend (Pages build on its `browser` backend only): whether it
 * started, on which storage, and whether another tab has since closed its database. `memory`
 * storage means IndexedDB could not be opened (private browsing, blocked storage), so nothing
 * survives the tab — the shell warns about it, as it does when the backend could not start or must
 * be reloaded. A Pages page load on the `server` backend never opens the in-browser backend.
 *
 * Also maps the data another tab changed (slice names) to the query keys to refetch.
 */
import { useEffect, useState } from 'react';
import { getCapabilities } from '../capabilities.ts';
import type { StaticBackendStatus } from '../static/backend.ts';

export type StaticStorageKind = 'indexeddb' | 'memory';
export type { StaticBackendStatus };

/**
 * The in-browser backend's status, following changes; null in the server build, on a
 * server-backend page load (and until it is known).
 */
export function useStaticBackendStatus(): StaticBackendStatus | null {
  const [status, setStatus] = useState<StaticBackendStatus | null>(null);
  useEffect(() => {
    // The literal keeps the static backend out of the server build's bundle.
    if (!__PORTLY_STATIC__) return undefined;
    // This page load's data lives on the Portly server: never open (or start) the browser copy.
    if (getCapabilities().backend !== 'browser') return undefined;
    let live = true;
    let unsubscribe: (() => void) | undefined;
    void import('../static/backend.ts')
      .then((backend) => {
        if (!live) return;
        unsubscribe = backend.subscribeStaticBackendStatus((next) => {
          if (live) setStatus(next);
        });
        setStatus(backend.getStaticBackendStatus());
        // Starts it if nothing has yet (normally main.tsx already did).
        void backend.ensureStaticBackend().catch(() => undefined);
      })
      .catch(() => {
        if (live) setStatus({ state: 'failed', message: 'The in-browser backend could not be loaded', retryAt: 0 });
      });
    return () => {
      live = false;
      unsubscribe?.();
    };
  }, []);
  return status;
}

export function useStaticStorageKind(): StaticStorageKind | null {
  const status = useStaticBackendStatus();
  return status?.state === 'ready' || status?.state === 'closed' ? status.storage : null;
}

/**
 * Query-key prefixes to refetch when another tab changed these slices (names from
 * `src/static/slices.ts`). Unknown names refetch everything.
 */
const SLICE_QUERY_KEYS: Readonly<Record<string, readonly (readonly string[])[]>> = Object.freeze({
  // Settings also drive search suggestions and the weather location/units.
  settings: [['settings'], ['search'], ['weather']],
  profiles: [['profiles']],
  bookmarks: [['bookmarks'], ['icons']],
  icons: [['bookmarks'], ['icons']],
  // An upload changes nothing a query returns; the settings that reference it do.
  uploads: [['settings']],
  'todoist-token': [['todoist']],
  'github-sync': [['sync', 'github']],
  backups: [['backups']],
  // Accounts decide which calendars and mail exist.
  accounts: [['accounts'], ['calendar'], ['mail']],
  // Token refreshes change nothing a query returns (statuses live in the accounts slice).
  'account-tokens': [],
  'oauth-clients': [['oauth-clients']],
  'oauth-states': [],
  calendars: [['calendar']],
  'calendar-events': [['calendar', 'events']],
  // When each account was last synced: nothing a query returns.
  'calendar-sync': [],
  // Which one-time upgrades ran: nothing a query returns (an upgrade's own changes come with their slices).
  upgrades: [],
});

/** The query-key prefixes for changed slices, or null when everything should be refetched. */
export function queryKeysForSlices(keys: readonly string[]): (readonly string[])[] | null {
  const out = new Map<string, readonly string[]>();
  for (const key of keys) {
    const prefixes = SLICE_QUERY_KEYS[key];
    if (prefixes === undefined) return null;
    for (const prefix of prefixes) out.set(prefix.join('\u0000'), prefix);
  }
  return [...out.values()];
}
