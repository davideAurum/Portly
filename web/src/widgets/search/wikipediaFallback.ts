/**
 * Wikipedia suggestions instead (§16): on the in-browser backend, an engine whose suggestions only
 * Portly can ask (Google, DuckDuckGo, Bing, YouTube) shows Wikipedia's instead, labelled as such.
 * Off unless turned on, because it sends what you type to a provider you did not pick. It is a
 * setting of this browser, not part of the synced search settings: it only matters while this
 * page has no Portly to ask, and the strict `SearchSettingsSchema` of an older Pages site, server
 * or export would reject a field it does not know (as with `theme/glassPreference.ts`). Each
 * Portly address keeps its own, like other `portly:` keys. Storage that cannot be read counts as
 * off; nothing here throws.
 */
import { useSyncExternalStore } from 'react';

export const WIKIPEDIA_FALLBACK_KEY = 'portly:wikipedia-suggestions-instead';

const listeners = new Set<() => void>();

function safeLocalStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/** Whether this browser shows Wikipedia's suggestions for engines whose own need Portly. */
export function readWikipediaFallback(storage: Pick<Storage, 'getItem'> | undefined = safeLocalStorage()): boolean {
  try {
    return storage?.getItem(WIKIPEDIA_FALLBACK_KEY) === '1';
  } catch {
    return false;
  }
}

/** Turns the fallback on or off for this browser (every Portly tab of this address follows). */
export function writeWikipediaFallback(on: boolean, storage: Pick<Storage, 'setItem' | 'removeItem'> | undefined = safeLocalStorage()): void {
  try {
    if (on) storage?.setItem(WIKIPEDIA_FALLBACK_KEY, '1');
    else storage?.removeItem(WIKIPEDIA_FALLBACK_KEY);
  } catch {
    // Storage is full or blocked: nothing is saved and the setting stays as it was.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Other tabs of this address change it through localStorage.
  const onStorage = (event: StorageEvent) => {
    if (event.key === WIKIPEDIA_FALLBACK_KEY || event.key === null) listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

/** This browser's setting, kept current across this page and other tabs. */
export function useWikipediaFallback(): boolean {
  return useSyncExternalStore(subscribe, () => readWikipediaFallback(), () => false);
}
