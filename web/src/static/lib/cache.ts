/**
 * In-memory TTL cache for the static backend (port of `createMemoryCache` from
 * server/src/lib/cache.ts): weather forecasts (10 min), geocoding (24 h), search suggestions
 * (5 min) and Todoist projects (5 min). Keys are namespaced `'<module>:...'`. Nothing here is ever
 * persisted — the page's TanStack cache already survives reloads where that is wanted.
 */

export interface Cache {
  /** Value for `key`, or undefined when missing/expired. */
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown, ttlMs: number): void;
  /**
   * Cached value, or the result of `fn` stored for `ttlMs`. Concurrent calls for the same key
   * share one `fn` invocation; failures are not cached. Because every waiter gets that one
   * invocation's outcome, `fn` must not depend on one caller's AbortSignal (one caller's abort
   * would reject them all): bound it with a deadline instead, as the server does.
   */
  getOrSet<T>(key: string, ttlMs: number, fn: () => T | Promise<T>): Promise<T>;
  del(key: string): void;
  /** Deletes every key starting with `prefix` (a literal prefix, not a pattern). */
  delPrefix(prefix: string): void;
}

export interface MemoryCache extends Cache {
  /** Number of live-or-expired entries currently held. */
  readonly size: number;
}

export interface MemoryCacheOptions {
  /** Clock (epoch ms); injectable for tests. */
  now?: () => number;
  /** Max entries before the least recently used is evicted (default 500). */
  maxEntries?: number;
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

/** In-memory LRU cache. Values are stored by reference (callers must not mutate them). */
export function createMemoryCache(options: MemoryCacheOptions = {}): MemoryCache {
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? 500;
  const entries = new Map<string, { value: unknown; expiresAt: number }>();
  const flight = singleFlight();

  const cache: MemoryCache = {
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
