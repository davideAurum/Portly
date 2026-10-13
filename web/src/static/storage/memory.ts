/**
 * In-memory {@link StaticStorage}: for tests, and the fallback when IndexedDB cannot be opened
 * (some private-browsing modes). Values are structured-cloned on the way in and out so callers
 * never share references with the store, like a real database.
 */
import type { StaticStorage, StorageBatch, StoredBlob } from './types.ts';

const MISSING = Symbol('missing');

export class MemoryStorage implements StaticStorage {
  readonly kind = 'memory' as const;
  private readonly json = new Map<string, unknown>();
  private readonly blobs = new Map<string, StoredBlob>();
  /** Batches run one at a time, so a rollback never undoes another batch's writes. */
  private batches: Promise<void> = Promise.resolve();

  async getJson(key: string): Promise<unknown> {
    const value = this.json.get(key);
    return value === undefined ? undefined : structuredClone(value);
  }

  async setJson(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.json.delete(key);
    else this.json.set(key, structuredClone(value));
  }

  async deleteJson(key: string): Promise<void> {
    this.json.delete(key);
  }

  async listJsonKeys(): Promise<string[]> {
    return [...this.json.keys()].sort();
  }

  private static copy(entry: StoredBlob): StoredBlob {
    return { ...entry, bytes: new Uint8Array(entry.bytes) };
  }

  async getBlob(id: string): Promise<StoredBlob | undefined> {
    const entry = this.blobs.get(id);
    return entry ? MemoryStorage.copy(entry) : undefined;
  }

  async putBlob(entry: StoredBlob): Promise<void> {
    this.blobs.set(entry.id, MemoryStorage.copy(entry));
  }

  async deleteBlob(id: string): Promise<void> {
    this.blobs.delete(id);
  }

  async listBlobs(): Promise<StoredBlob[]> {
    return [...this.blobs.values()].map((e) => MemoryStorage.copy(e)).sort((a, b) => a.createdAt - b.createdAt);
  }

  async listBlobIds(): Promise<string[]> {
    return [...this.blobs.keys()].sort();
  }

  /**
   * Applies the batch through the single-item methods (so a test subclass that makes one of them
   * fail is honoured) and, when any of them throws, puts every touched entry back as it was.
   */
  applyBatch(batch: StorageBatch): Promise<void> {
    const run = this.batches.then(() => this.applyNow(batch));
    this.batches = run.catch(() => undefined);
    return run;
  }

  private async applyNow(batch: StorageBatch): Promise<void> {
    const json = [...(batch.json ?? new Map<string, unknown>())];
    const deletes = batch.deleteBlobs ?? [];
    const puts = batch.putBlobs ?? [];
    const previousJson = new Map<string, unknown>();
    for (const [key] of json) previousJson.set(key, this.json.has(key) ? this.json.get(key) : MISSING);
    const previousBlobs = new Map<string, StoredBlob | typeof MISSING>();
    for (const id of [...deletes, ...puts.map((p) => p.id)]) previousBlobs.set(id, this.blobs.get(id) ?? MISSING);
    try {
      for (const [key, value] of json) {
        if (value === undefined) await this.deleteJson(key);
        else await this.setJson(key, value);
      }
      for (const id of deletes) await this.deleteBlob(id);
      for (const entry of puts) await this.putBlob(entry);
    } catch (err) {
      for (const [key, value] of previousJson) {
        if (value === MISSING) this.json.delete(key);
        else this.json.set(key, value);
      }
      for (const [id, entry] of previousBlobs) {
        if (entry === MISSING) this.blobs.delete(id);
        else this.blobs.set(id, entry);
      }
      throw err;
    }
  }

  async clear(): Promise<void> {
    this.json.clear();
    this.blobs.clear();
  }
}
