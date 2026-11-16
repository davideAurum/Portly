/**
 * One-time move of this browser's data from the Pages site's old address (`/`) to the new one
 * (`/portly/`). Both are on the same origin, so a page at the new address can read what the old one
 * stored, but every key and the IndexedDB database are named after the build's base path, so the
 * new address starts empty. This copies, once per browser:
 * - the pairing with Portly on this PC and the backend hints (`portly:pairing:`, `backend-mode:`,
 *   `server-seen:`), and the last address of another PC (`portly:remote-address:`), from
 *   localStorage;
 * - the copy kept in the browser (database `portly-static:/`: settings, launch pad, uploads and the
 *   browser-only sign-ins), into `portly-static:/portly/` - only while the new database is empty,
 *   so data already made at the new address is never replaced.
 * Afterwards the old keys and the old database are deleted, so no second copy of the data (the
 * sign-ins among it) stays behind at an address nothing uses any more. The marker
 * `portly:base-migrated:<base>` is written only when everything went through, so a failed run is
 * tried again on the next page load (the old data is deleted only after the copy succeeded).
 */
import { clientEventsStorageKey } from '../diagnostics/clientLog.ts';
import { remoteAddressKey } from '../localServer/remote.ts';
import { hybridStorageKeys, readItem, writeItem, type StorageLike } from '../localServer/pairing.ts';
import { IndexedDbStorage } from './storage/idb.ts';
import type { StoredBlob } from './storage/types.ts';

/** The address the Pages site used before it moved under `/portly/`. */
export const LEGACY_BASE = '/';

export function baseMigratedKey(base: string): string {
  return `portly:base-migrated:${base}`;
}

export type BaseMigrationResult = 'skipped' | 'migrated' | 'failed';

export interface BaseMigrationDeps {
  /** This build's base path (`import.meta.env.BASE_URL`). */
  base: string;
  local: StorageLike | null;
  indexedDB: IDBFactory | null;
}

/** localStorage keys that move, as [old, new] pairs. */
export function migratedLocalKeys(base: string): Array<[string, string]> {
  const from = hybridStorageKeys(LEGACY_BASE);
  const to = hybridStorageKeys(base);
  return [
    [from.pairing, to.pairing],
    [from.mode, to.mode],
    [from.seen, to.seen],
    [remoteAddressKey(LEGACY_BASE), remoteAddressKey(base)],
    [clientEventsStorageKey(true, LEGACY_BASE), clientEventsStorageKey(true, base)],
  ];
}

function copyLocalStorage(local: StorageLike | null, base: string): void {
  if (local === null) return;
  for (const [from, to] of migratedLocalKeys(base)) {
    const value = readItem(local, from);
    if (value === null || readItem(local, to) !== null) continue;
    writeItem(local, to, value);
  }
}

function removeOldLocalStorage(local: StorageLike | null, base: string): void {
  if (local === null) return;
  for (const [from] of migratedLocalKeys(base)) {
    try {
      local.removeItem(from);
    } catch {
      // Storage refused; the copy itself is done.
    }
  }
}

/** Opens a database only when it exists (an open that would create it is aborted); null when missing. */
function openExisting(factory: IDBFactory, name: string): Promise<IDBDatabase | null> {
  return new Promise((resolve, reject) => {
    const req = factory.open(name);
    let missing = false;
    req.onupgradeneeded = () => {
      missing = true;
      req.transaction?.abort();
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => (missing ? resolve(null) : reject(req.error ?? new Error('IndexedDB open failed')));
    req.onblocked = () => reject(new Error('IndexedDB open blocked by another tab'));
  });
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

interface LegacyData {
  json: Map<string, unknown>;
  blobs: StoredBlob[];
}

async function readLegacy(db: IDBDatabase): Promise<LegacyData> {
  const json = new Map<string, unknown>();
  const blobs: StoredBlob[] = [];
  const names = Array.from(db.objectStoreNames);
  if (names.length === 0) return { json, blobs };
  const tx = db.transaction(names, 'readonly');
  if (names.includes('kv')) {
    const store = tx.objectStore('kv');
    const [keys, values] = await Promise.all([wrap(store.getAllKeys()), wrap(store.getAll())]);
    keys.forEach((key, index) => json.set(String(key), values[index]));
  }
  if (names.includes('blobs')) {
    for (const entry of await wrap(tx.objectStore('blobs').getAll() as IDBRequest<StoredBlob[]>)) {
      const raw: unknown = entry.bytes;
      const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer);
      blobs.push({ ...entry, bytes: new Uint8Array(bytes) });
    }
  }
  return { json, blobs };
}

/** Deletes a database; an open connection in another tab only delays it, so it never fails the move. */
function deleteDatabase(factory: IDBFactory, name: string): Promise<void> {
  return new Promise((resolve) => {
    const req = factory.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

async function copyDatabase(factory: IDBFactory, base: string): Promise<void> {
  const oldDb = await openExisting(factory, `portly-static:${LEGACY_BASE}`);
  if (oldDb === null) return;
  let legacy: LegacyData;
  try {
    legacy = await readLegacy(oldDb);
  } finally {
    oldDb.close();
  }
  if (legacy.json.size === 0 && legacy.blobs.length === 0) return;
  const target = await IndexedDbStorage.open(factory, `portly-static:${base}`);
  try {
    // Only into an empty database: whatever the new address already holds stays.
    if ((await target.listJsonKeys()).length > 0 || (await target.listBlobIds()).length > 0) return;
    await target.applyBatch({ json: legacy.json, putBlobs: legacy.blobs });
  } finally {
    target.close();
  }
}

/** Runs the move (see the file comment). Never throws. */
export async function migrateLegacyBase(deps: BaseMigrationDeps): Promise<BaseMigrationResult> {
  const { base, local, indexedDB: factory } = deps;
  if (base === LEGACY_BASE) return 'skipped';
  const marker = baseMigratedKey(base);
  if (readItem(local, marker) !== null) return 'skipped';
  try {
    copyLocalStorage(local, base);
    if (factory !== null) await copyDatabase(factory, base);
    removeOldLocalStorage(local, base);
    if (factory !== null) await deleteDatabase(factory, `portly-static:${LEGACY_BASE}`);
  } catch (err) {
    console.error('[Portly] Could not copy this browser’s data from the old address', err);
    return 'failed';
  }
  writeItem(local, marker, String(Date.now()));
  return 'migrated';
}
