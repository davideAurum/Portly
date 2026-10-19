/**
 * Frosted glass (§7a Theme rendering): a live blur of the photo behind glass surfaces. It is a
 * setting of this browser, not part of the synced theme, because what it costs depends on this
 * PC's graphics, and because the strict `ThemeSchema` of an older Pages site, server or export
 * would reject a theme carrying a field it does not know. Each Portly address (the Pages site,
 * `localhost:5757`) keeps its own, like other `portly:` keys. Off unless turned on. Storage that
 * cannot be read counts as off; nothing here throws.
 */
import { useSyncExternalStore } from 'react';

export const FROSTED_GLASS_KEY = 'portly:frosted-glass';

const listeners = new Set<() => void>();

function safeLocalStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/** Whether this browser has frosted glass turned on. */
export function readFrostedGlass(storage: Pick<Storage, 'getItem'> | undefined = safeLocalStorage()): boolean {
  try {
    return storage?.getItem(FROSTED_GLASS_KEY) === '1';
  } catch {
    return false;
  }
}

/** Turns frosted glass on or off for this browser (every Portly tab of this address follows). */
export function writeFrostedGlass(on: boolean, storage: Pick<Storage, 'setItem' | 'removeItem'> | undefined = safeLocalStorage()): void {
  try {
    if (on) storage?.setItem(FROSTED_GLASS_KEY, '1');
    else storage?.removeItem(FROSTED_GLASS_KEY);
  } catch {
    // Storage is full or blocked: nothing is saved and the setting stays as it was.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Other tabs of this address change it through localStorage.
  const onStorage = (event: StorageEvent) => {
    if (event.key === FROSTED_GLASS_KEY || event.key === null) listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

/** This browser's frosted glass setting, kept current across this page and other tabs. */
export function useFrostedGlass(): boolean {
  return useSyncExternalStore(subscribe, () => readFrostedGlass(), () => false);
}
