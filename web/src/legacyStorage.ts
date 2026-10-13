/**
 * Before the rename to Portly, this app kept its browser settings under `homebase:…` keys in
 * localStorage (pairing with the server on this PC, the backend last used, the device location, …).
 * The first page load of Portly copies each of them to the matching `portly:…` key that does not
 * exist yet, then records that it did (`portly:migrated-from-homebase`), so a key Portly removes
 * later (disconnecting a pairing) is not brought back. Cached query snapshots are not copied (they
 * refill by themselves), and the old keys stay as they were. Never throws.
 *
 * `main.tsx` imports this module right after zod's configuration, so it runs before any module
 * reads storage.
 */

export const LEGACY_KEY_PREFIX = 'homebase:';
export const KEY_PREFIX = 'portly:';
export const MIGRATED_FLAG_KEY = 'portly:migrated-from-homebase';

/** Copies Homebase's keys to Portly's once; returns how many were copied. */
export function copyLegacyLocalStorage(storage: Storage | null): number {
  if (storage === null) return 0;
  try {
    if (storage.getItem(MIGRATED_FLAG_KEY) !== null) return 0;
    const legacyKeys: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key !== null && key.startsWith(LEGACY_KEY_PREFIX) && !key.includes(':query-cache')) legacyKeys.push(key);
    }
    let copied = 0;
    for (const key of legacyKeys) {
      const target = `${KEY_PREFIX}${key.slice(LEGACY_KEY_PREFIX.length)}`;
      const value = storage.getItem(key);
      if (value === null || storage.getItem(target) !== null) continue;
      storage.setItem(target, value);
      copied++;
    }
    storage.setItem(MIGRATED_FLAG_KEY, new Date().toISOString());
    return copied;
  } catch {
    // Storage blocked or full: try again on the next load.
    return 0;
  }
}

function pageLocalStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

copyLegacyLocalStorage(pageLocalStorage());
