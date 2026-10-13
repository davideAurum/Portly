/**
 * Caches (§6): `cache` — SQLite `cache` table, JSON values, **non-sensitive data only**
 * (weather, suggestions); `memo` — in-memory LRU with the same API for sensitive data
 * (e.g. mail lists), never persisted. Keys are namespaced `'<module>:...'`.
 */
import type { Db } from '../db/open.ts';

export interface Cache {
  /** Value for `key`, or undefined when missing/expired. */
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown, ttlMs: number): void;
  /**
   * Cached value, or the result of `fn` stored for `ttlMs`. Concurrent calls for the same key
   * share one `fn` invocation; failures are not cached.
   */
  getOrSet<T>(key: string, ttlMs: number, fn: () => T | Promise<T>): Promise<T>;
  del(key: string): void;
  /** Deletes every key starting with `prefix`. */
  delPrefix(prefix: string): void;
}

/** Same API as {@link Cache}, held in process memory only. */
export type MemoryCache = Cache;

export interface CacheOptions {
  now?: () => number;
}

function validateTtl(ttlMs: number): void {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new RangeError(`cache ttlMs must be a positive number (got ${ttlMs})`);
}

function singleFlight() {
  const inflight = new Map<string, Promise<unknown>>();
  return <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const existing = inflight.get(key);
    if (existing) return existing as Promise<T>;
    const p = (async () => {
      try {
        return await fn();
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, p);
    return p;
  };
}

export interface SqliteCache extends Cache {
  /** Deletes expired rows; returns the number removed. */
  purgeExpired(): number;
}

/** SQLite-backed cache (the `cache` table). Values must be JSON-serializable. */
export function createSqliteCache(db: Db, options: CacheOptions = {}): SqliteCache {
  const now = options.now ?? Date.now;
  const flight = singleFlight();

  const cache: SqliteCache = {
    get<T>(key: string): T | undefined {
      const row = db.get<{ value: string; expires_at: number }>('SELECT value, expires_at FROM cache WHERE key = ?', [key]);
      if (!row) return undefined;
      if (row.expires_at <= now()) {
        db.run('DELETE FROM cache WHERE key = ? AND expires_at <= ?', [key, now()]);
        return undefined;
      }
      try {
        return JSON.parse(row.value) as T;
      } catch {
        db.run('DELETE FROM cache WHERE key = ?', [key]);
        return undefined;
      }
    },
    set(key, value, ttlMs) {
      validateTtl(ttlMs);
      const json = JSON.stringify(value);
      if (json === undefined) throw new TypeError(`cache value for "${key}" is not JSON-serializable`);
      db.run(
        'INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at',
        [key, json, now() + ttlMs],
      );
    },
    getOrSet<T>(key: string, ttlMs: number, fn: () => T | Promise<T>): Promise<T> {
      validateTtl(ttlMs);
      const hit = cache.get<T>(key);
      if (hit !== undefined) return Promise.resolve(hit);
      return flight(key, async () => {
        const value = await fn();
        cache.set(key, value, ttlMs);
        return value;
      });
    },
    del(key) {
      db.run('DELETE FROM cache WHERE key = ?', [key]);
    },
    delPrefix(prefix) {
      if (prefix.length === 0) {
        db.run('DELETE FROM cache');
        return;
      }
      db.run('DELETE FROM cache WHERE substr(key, 1, ?) = ?', [prefix.length, prefix]);
    },
    purgeExpired() {
      return db.run('DELETE FROM cache WHERE expires_at <= ?', [now()]).changes;
    },
  };
  return cache;
}

export interface MemoryCacheOptions extends CacheOptions {
  /** Max entries before the least recently used is evicted (default 500). */
  maxEntries?: number;
}

/** In-memory LRU cache. Values are stored by reference (callers must not mutate them). */
export function createMemoryCache(options: MemoryCacheOptions = {}): MemoryCache & { readonly size: number } {
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? 500;
  const entries = new Map<string, { value: unknown; expiresAt: number }>();
  const flight = singleFlight();

  const cache = {
    get<T>(key: string): T | undefined {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= now()) {
        entries.delete(key);
        return undefined;
      }
      entries.delete(key);
      entries.set(key, entry);
      return entry.value as T;
    },
    set(key: string, value: unknown, ttlMs: number): void {
      validateTtl(ttlMs);
      entries.delete(key);
      entries.set(key, { value, expiresAt: now() + ttlMs });
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
    getOrSet<T>(key: string, ttlMs: number, fn: () => T | Promise<T>): Promise<T> {
      validateTtl(ttlMs);
      const hit = cache.get<T>(key);
      if (hit !== undefined) return Promise.resolve(hit);
      return flight(key, async () => {
        const value = await fn();
        cache.set(key, value, ttlMs);
        return value;
      });
    },
    del(key: string): void {
      entries.delete(key);
    },
    delPrefix(prefix: string): void {
      for (const key of [...entries.keys()]) if (key.startsWith(prefix)) entries.delete(key);
    },
    get size(): number {
      return entries.size;
    },
  };
  return cache;
}
