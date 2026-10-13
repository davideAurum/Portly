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

export function openStaticDatabase(factory: IDBFactory = indexedDB, name = STATIC_DB_NAME): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(name, STATIC_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(KV)) db.createObjectStore(KV);
      if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS, { keyPath: 'id' });
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

  static async open(factory?: IDBFactory, name?: string): Promise<IndexedDbStorage> {
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
