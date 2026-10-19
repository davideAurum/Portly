/**
 * IndexedDB {@link StaticStorage}: database `portly-static:<base path>` (one per deployment,
 * since every project site under one `<user>.github.io` origin shares IndexedDB), object stores
 * `kv` (JSON documents by key) and `blobs` (images by id). One short transaction per call, and one
 * transaction over both stores for {@link IndexedDbStorage.applyBatch}; no schema beyond the two
 * stores, so upgrades are additive.
 */
import type { StaticStorage, StorageBatch, StoredBlob } from './types.ts';

/** Namespaced by the build's base path (the literal `import.meta.env.BASE_URL` is replaced by Vite). */
export const STATIC_DB_NAME = `portly-static:${import.meta.env.BASE_URL}`;
export const STATIC_DB_VERSION = 1;
const KV = 'kv';
const BLOBS = 'blobs';

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/**
 * Opens (and creates or upgrades) the database. `onCreate` runs in the transaction that creates
 * it, so whatever it writes exists exactly when the database does.
 */
export function openStaticDatabase(
  factory: IDBFactory = indexedDB,
  name = STATIC_DB_NAME,
  onCreate?: (tx: IDBTransaction) => void,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(name, STATIC_DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(KV)) db.createObjectStore(KV);
      if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS, { keyPath: 'id' });
      if (event.oldVersion === 0 && req.transaction !== null) onCreate?.(req.transaction);
    };
    req.onsuccess = () => {
      const db = req.result;
      // Another tab asked to upgrade/delete the database: close so it can proceed.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
    req.onblocked = () => reject(new Error('IndexedDB open blocked by another tab'));
  });
}

/** Database names before the rename to Portly: `homebase-static:<base path>`. */
const LEGACY_PREFIX = 'homebase-static:';
const PREFIX = 'portly-static:';
/**
 * `kv` key of a database {@link copyLegacyStaticDatabase} created and has not filled yet:
 * `{attempts}`. Written in the transaction that creates the database, removed in the one that
 * writes the copied records. No slice or backup key looks like it, so the app never reads it.
 */
export const LEGACY_COPY_PENDING_KEY = 'copy:homebase-pending';
/** Page loads that try the copy before the database is kept as it is. */
export const LEGACY_COPY_ATTEMPTS = 3;

/** The attempts recorded in a pending marker, or null when there is none. */
function pendingAttempts(value: unknown): number | null {
  if (value === undefined) return null;
  const attempts = typeof value === 'object' && value !== null ? (value as { attempts?: unknown }).attempts : undefined;
  return typeof attempts === 'number' && Number.isFinite(attempts) ? attempts : 0;
}

/** Counts one more attempt on a database still waiting for the copy; false when none is due. */
async function startCopyAttempt(db: IDBDatabase): Promise<boolean> {
  const tx = db.transaction(KV, 'readwrite');
  const done = transactionDone(tx);
  const kv = tx.objectStore(KV);
  let due = false;
  const marker = kv.get(LEGACY_COPY_PENDING_KEY);
  marker.onsuccess = () => {
    const attempts = pendingAttempts(marker.result);
    if (attempts === null || attempts >= LEGACY_COPY_ATTEMPTS) return;
    kv.put({ attempts: attempts + 1 }, LEGACY_COPY_PENDING_KEY);
    due = true;
  };
  await done;
  return due;
}

/**
 * Replaces everything in `db` with the records read from Homebase's database and removes the
 * pending marker, in one transaction: all of it or none. Writes nothing when the marker is gone
 * (another tab finished the copy meanwhile). Returns whether it wrote.
 */
async function writeCopy(db: IDBDatabase, keys: IDBValidKey[], values: unknown[], blobs: unknown[]): Promise<boolean> {
  const tx = db.transaction([KV, BLOBS], 'readwrite');
  const done = transactionDone(tx);
  const kv = tx.objectStore(KV);
  const blobStore = tx.objectStore(BLOBS);
  let wrote = false;
  const marker = kv.get(LEGACY_COPY_PENDING_KEY);
  marker.onsuccess = () => {
    if (marker.result === undefined) return;
    try {
      kv.clear();
      blobStore.clear();
      keys.forEach((key, i) => kv.put(values[i], key));
      for (const blob of blobs) blobStore.put(blob);
      kv.delete(LEGACY_COPY_PENDING_KEY);
      wrote = true;
    } catch {
      // A record that could not even be written: none of them is (`done` rejects).
      wrote = false;
      tx.abort();
    }
  };
  await done;
  return wrote;
}

/**
 * Copies the database Homebase (Portly's name before the rename) kept under
 * `homebase-static:<base path>` into this deployment's `portly-static:<base path>`: both stores,
 * every record; the old one is left as it is. Only into a database this copy created: it is
 * created with {@link LEGACY_COPY_PENDING_KEY}, which goes in the same transaction as the copied
 * records. A copy cut off part-way (an error, a full disk, a closed tab) leaves the marker, so a
 * later page load tries again and replaces what that database holds by then, for
 * {@link LEGACY_COPY_ATTEMPTS} loads in all; after that the database is kept as it is. A database
 * Portly made itself, or one the copy filled, is never touched. Browsers without
 * `indexedDB.databases()` skip it. Returns whether the records were copied; never rejects.
 */
export async function copyLegacyStaticDatabase(factory: IDBFactory, name: string): Promise<boolean> {
  if (!name.startsWith(PREFIX) || typeof factory.databases !== 'function') return false;
  const legacyName = `${LEGACY_PREFIX}${name.slice(PREFIX.length)}`;
  let target: IDBDatabase | null = null;
  try {
    const names = (await factory.databases()).map((info) => info.name);
    if (!names.includes(legacyName)) return false;
    target = await openStaticDatabase(factory, name, (tx) => tx.objectStore(KV).put({ attempts: 0 }, LEGACY_COPY_PENDING_KEY));
    if (!(await startCopyAttempt(target))) return false;
    const legacy = await openStaticDatabase(factory, legacyName);
    let keys: IDBValidKey[];
    let values: unknown[];
    let blobs: unknown[];
    try {
      const read = legacy.transaction([KV, BLOBS], 'readonly');
      [keys, values, blobs] = await Promise.all([
        request(read.objectStore(KV).getAllKeys()),
        request<unknown[]>(read.objectStore(KV).getAll()),
        request<unknown[]>(read.objectStore(BLOBS).getAll()),
      ]);
    } finally {
      legacy.close();
    }
    return await writeCopy(target, keys, values, blobs);
  } catch (err) {
    console.warn(`[Portly] Could not copy Homebase's in-browser data (${LEGACY_COPY_ATTEMPTS} page loads try in all)`, err);
    return false;
  } finally {
    target?.close();
  }
}

/** JSON-normalized copy (only plain data is stored: no class instances, no undefined). */
function plainJson(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** The stored form of a blob: a tight copy of the bytes (never a view into a larger buffer). */
function plainBlob(entry: StoredBlob): StoredBlob {
  const bytes = new Uint8Array(entry.bytes.byteLength);
  bytes.set(entry.bytes);
  return { id: entry.id, kind: entry.kind, type: entry.type, bytes, width: entry.width, createdAt: entry.createdAt };
}

export class IndexedDbStorage implements StaticStorage {
  readonly kind = 'indexeddb' as const;
  private readonly db: IDBDatabase;
  private closedFor: string | null = null;
  private readonly closeListeners = new Set<() => void>();

  constructor(db: IDBDatabase) {
    this.db = db;
    // Another tab upgrades or deletes the database: let it proceed, and stop using this
    // connection (every later call fails with a clear error and the app asks for a reload).
    db.onversionchange = () => {
      db.close();
      this.markClosed('Portly was updated or its data was cleared in another tab; reload this page');
    };
    // The browser closed the connection itself (site data cleared, storage failure).
    db.onclose = () => this.markClosed("The browser closed Portly's storage; reload this page");
  }

  static async open(factory: IDBFactory = indexedDB, name = STATIC_DB_NAME): Promise<IndexedDbStorage> {
    await copyLegacyStaticDatabase(factory, name);
    return new IndexedDbStorage(await openStaticDatabase(factory, name));
  }

  /** Why the connection is unusable, or null while it works. */
  get closedReason(): string | null {
    return this.closedFor;
  }

  close(): void {
    this.db.close();
  }

  onClosed(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  private markClosed(reason: string): void {
    if (this.closedFor !== null) return;
    this.closedFor = reason;
    for (const listener of this.closeListeners) {
      try {
        listener();
      } catch {
        // A listener must never keep the others from hearing about it.
      }
    }
  }

  private transaction(stores: string | string[], mode: IDBTransactionMode): IDBTransaction {
    if (this.closedFor !== null) throw new DOMException(this.closedFor, 'InvalidStateError');
    return this.db.transaction(stores, mode);
  }

  private async read<T>(store: string, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const tx = this.transaction(store, 'readonly');
    const result = await request(fn(tx.objectStore(store)));
    await transactionDone(tx);
    return result;
  }

  async getJson(key: string): Promise<unknown> {
    return this.read(KV, (s) => s.get(key));
  }

  async setJson(key: string, value: unknown): Promise<void> {
    await this.applyBatch({ json: new Map([[key, value]]) });
  }

  async deleteJson(key: string): Promise<void> {
    await this.applyBatch({ json: new Map([[key, undefined]]) });
  }

  async listJsonKeys(): Promise<string[]> {
    const keys = await this.read(KV, (s) => s.getAllKeys());
    return keys.map((k) => String(k)).sort();
  }

  /** Values read back from IndexedDB may be views from another realm; normalize to a local Uint8Array. */
  private static normalize(entry: StoredBlob): StoredBlob {
    const raw: unknown = entry.bytes;
    const bytes =
      raw instanceof Uint8Array ? raw : ArrayBuffer.isView(raw) ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength) : new Uint8Array(raw as ArrayBuffer);
    return { ...entry, bytes: new Uint8Array(bytes) };
  }

  async getBlob(id: string): Promise<StoredBlob | undefined> {
    const entry = await this.read<StoredBlob | undefined>(BLOBS, (s) => s.get(id) as IDBRequest<StoredBlob | undefined>);
    return entry ? IndexedDbStorage.normalize(entry) : undefined;
  }

  async putBlob(entry: StoredBlob): Promise<void> {
    await this.applyBatch({ putBlobs: [entry] });
  }

  async deleteBlob(id: string): Promise<void> {
    await this.applyBatch({ deleteBlobs: [id] });
  }

  async listBlobs(): Promise<StoredBlob[]> {
    const entries = await this.read<StoredBlob[]>(BLOBS, (s) => s.getAll() as IDBRequest<StoredBlob[]>);
    return entries.map((e) => IndexedDbStorage.normalize(e)).sort((a, b) => a.createdAt - b.createdAt);
  }

  async listBlobIds(): Promise<string[]> {
    const keys = await this.read(BLOBS, (s) => s.getAllKeys());
    return keys.map((k) => String(k)).sort();
  }

  /**
   * One readwrite transaction over the stores the batch touches. Every value is normalized before
   * the transaction opens and every request is issued synchronously inside it (an await would let
   * it auto-commit early); IndexedDB then stores all of it or, on any error or abort, none of it.
   */
  async applyBatch(batch: StorageBatch): Promise<void> {
    const json = [...(batch.json ?? new Map<string, unknown>())].map(([key, value]) => [key, plainJson(value)] as const);
    const deletes = [...(batch.deleteBlobs ?? [])];
    const puts = (batch.putBlobs ?? []).map(plainBlob);
    const stores = [...(json.length > 0 ? [KV] : []), ...(deletes.length > 0 || puts.length > 0 ? [BLOBS] : [])];
    if (stores.length === 0) return;
    const tx = this.transaction(stores, 'readwrite');
    const done = transactionDone(tx);
    try {
      if (json.length > 0) {
        const kv = tx.objectStore(KV);
        for (const [key, value] of json) {
          if (value === undefined) kv.delete(key);
          else kv.put(value, key);
        }
      }
      if (deletes.length > 0 || puts.length > 0) {
        const blobs = tx.objectStore(BLOBS);
        for (const id of deletes) blobs.delete(id);
        for (const entry of puts) blobs.put(entry);
      }
    } catch (err) {
      // A request that could not even be issued (e.g. DataCloneError): undo the ones that were.
      try {
        tx.abort();
      } catch {
        // Already finished or aborted.
      }
      await done.catch(() => undefined);
      throw err;
    }
    await done;
  }

  async clear(): Promise<void> {
    const tx = this.transaction([KV, BLOBS], 'readwrite');
    tx.objectStore(KV).clear();
    tx.objectStore(BLOBS).clear();
    await transactionDone(tx);
  }
}
