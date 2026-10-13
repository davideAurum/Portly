/**
 * Storage behind the static backend: small JSON documents (settings, profiles, bookmarks, …)
 * keyed by name, plus binary blobs (uploaded images, bookmark icons) keyed by id. Implemented
 * on IndexedDB in the browser and in memory for tests and as a last-resort fallback.
 *
 * Image bytes are stored as `Uint8Array` + content type rather than `Blob`: Safari's private
 * mode has refused Blob values in IndexedDB, and test environments cannot structured-clone a
 * jsdom Blob. A `Blob` is built only when an object URL is needed (assets.ts).
 */

export interface StoredBlob {
  /** Stable id (UUID); also the key. */
  id: string;
  /** Namespace: `upload` (theme images) or `icon` (custom bookmark icons). */
  kind: 'upload' | 'icon';
  /** Sniffed image content type (never trusted from the uploader). */
  type: string;
  bytes: Uint8Array;
  /** Largest dimension in px when known (custom icons), else null. */
  width: number | null;
  createdAt: number;
}

/**
 * Writes applied together by {@link StaticStorage.applyBatch}: either every one of them is stored
 * or (on any failure) none is. Applied in this order: JSON documents, blob deletes, blob puts.
 */
export interface StorageBatch {
  /** JSON documents by key; an `undefined` value deletes the key. */
  json?: ReadonlyMap<string, unknown>;
  deleteBlobs?: readonly string[];
  putBlobs?: readonly StoredBlob[];
}

export interface StaticStorage {
  readonly kind: 'indexeddb' | 'memory';
  getJson(key: string): Promise<unknown>;
  setJson(key: string, value: unknown): Promise<void>;
  deleteJson(key: string): Promise<void>;
  listJsonKeys(): Promise<string[]>;
  getBlob(id: string): Promise<StoredBlob | undefined>;
  putBlob(entry: StoredBlob): Promise<void>;
  deleteBlob(id: string): Promise<void>;
  /** Every blob with its bytes, oldest first (reads everything: prefer {@link listBlobIds}). */
  listBlobs(): Promise<StoredBlob[]>;
  /** Ids of every stored blob, without reading the bytes. */
  listBlobIds(): Promise<string[]>;
  /** Applies the batch atomically (one IndexedDB transaction): all of it, or nothing. */
  applyBatch(batch: StorageBatch): Promise<void>;
  /** Removes everything (used by import-and-replace and by tests). */
  clear(): Promise<void>;
  /** Releases the underlying connection (IndexedDB). */
  close?(): void;
  /**
   * Called once when the storage stops working for good while the page is open: another tab
   * upgraded or deleted the database, or the browser closed the connection (site data cleared).
   */
  onClosed?(listener: () => void): () => void;
}

/** A Blob for the stored bytes (for object URLs and Response bodies). */
export function blobOf(entry: Pick<StoredBlob, 'bytes' | 'type'>): Blob {
  // Copy into a fresh ArrayBuffer so the Blob never shares (or is tainted by) a cross-realm view.
  const copy = new Uint8Array(entry.bytes.byteLength);
  copy.set(entry.bytes);
  return new Blob([copy], { type: entry.type });
}

/** True for the browser's "storage is full" error (IndexedDB QuotaExceededError). */
export function isQuotaExceeded(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'QuotaExceededError';
}
