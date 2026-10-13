import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../db/migrate.ts';
import { openDb, type Db } from '../db/open.ts';
import { createMemoryCache, createSqliteCache, type Cache } from './cache.ts';

function suite(name: string, make: (now: () => number) => { cache: Cache; cleanup(): void }): void {
  describe(name, () => {
    let clock = 1_000;
    let cache: Cache;
    let cleanup: () => void;
    beforeEach(() => {
      clock = 1_000;
      ({ cache, cleanup } = make(() => clock));
    });
    afterEach(() => cleanup());

    it('stores values until the TTL expires', () => {
      cache.set('weather:a', { temp: 21 }, 500);
      expect(cache.get('weather:a')).toEqual({ temp: 21 });
      clock += 499;
      expect(cache.get('weather:a')).toEqual({ temp: 21 });
      clock += 1;
      expect(cache.get('weather:a')).toBeUndefined();
    });

    it('returns undefined for missing keys and supports falsy values', () => {
      expect(cache.get('nope')).toBeUndefined();
      cache.set('zero', 0, 100);
      cache.set('empty', '', 100);
      cache.set('null', null, 100);
      expect(cache.get('zero')).toBe(0);
      expect(cache.get('empty')).toBe('');
      expect(cache.get('null')).toBeNull();
    });

    it('overwrites and deletes', () => {
      cache.set('k', 1, 100);
      cache.set('k', 2, 100);
      expect(cache.get('k')).toBe(2);
      cache.del('k');
      expect(cache.get('k')).toBeUndefined();
    });

    it('delPrefix removes only matching keys (prefix is literal, not a pattern)', () => {
      cache.set('search:google:a', 1, 100);
      cache.set('search:google:b', 2, 100);
      cache.set('search:ddg:a', 3, 100);
      cache.set('search%:x', 4, 100);
      cache.set('weather:x', 5, 100);
      cache.delPrefix('search:google:');
      expect(cache.get('search:google:a')).toBeUndefined();
      expect(cache.get('search:google:b')).toBeUndefined();
      expect(cache.get('search:ddg:a')).toBe(3);
      cache.delPrefix('search%');
      expect(cache.get('search%:x')).toBeUndefined();
      expect(cache.get('search:ddg:a')).toBe(3);
      expect(cache.get('weather:x')).toBe(5);
    });

    it('getOrSet computes once, caches, and shares concurrent calls', async () => {
      const fn = vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 5));
        return { v: 1 };
      });
      const [a, b] = await Promise.all([cache.getOrSet('k', 1000, fn), cache.getOrSet('k', 1000, fn)]);
      expect(a).toEqual({ v: 1 });
      expect(b).toEqual({ v: 1 });
      expect(fn).toHaveBeenCalledTimes(1);
      await cache.getOrSet('k', 1000, fn);
      expect(fn).toHaveBeenCalledTimes(1);
      clock += 1000;
      await cache.getOrSet('k', 1000, fn);
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('getOrSet does not cache failures', async () => {
      await expect(cache.getOrSet('k', 1000, () => Promise.reject(new Error('down')))).rejects.toThrow('down');
      expect(cache.get('k')).toBeUndefined();
      await expect(cache.getOrSet('k', 1000, () => 'ok')).resolves.toBe('ok');
    });

    it('rejects non-positive TTLs', () => {
      expect(() => cache.set('k', 1, 0)).toThrow(RangeError);
      expect(() => cache.set('k', 1, Number.NaN)).toThrow(RangeError);
    });
  });
}

suite('sqlite cache', (now) => {
  const db: Db = openDb(':memory:');
  migrate(db);
  return { cache: createSqliteCache(db, { now }), cleanup: () => db.close() };
});

suite('memory cache', (now) => ({ cache: createMemoryCache({ now }), cleanup: () => {} }));

describe('sqlite cache specifics', () => {
  it('persists JSON in the cache table and purges expired rows', () => {
    const db = openDb(':memory:');
    migrate(db);
    let clock = 0;
    const cache = createSqliteCache(db, { now: () => clock });
    cache.set('a', { x: 1 }, 10);
    cache.set('b', [1, 2], 100);
    expect(db.get<{ value: string }>('SELECT value FROM cache WHERE key = ?', ['a'])?.value).toBe('{"x":1}');
    clock = 50;
    expect(cache.purgeExpired()).toBe(1);
    expect(db.all('SELECT key FROM cache')).toEqual([{ key: 'b' }]);
    expect(() => cache.set('fn', () => 1, 10)).toThrow(TypeError);
    db.close();
  });
});

describe('memory cache specifics', () => {
  it('evicts the least recently used entry', () => {
    const cache = createMemoryCache({ maxEntries: 2 });
    cache.set('a', 1, 1000);
    cache.set('b', 2, 1000);
    expect(cache.get('a')).toBe(1); // a is now most recent
    cache.set('c', 3, 1000);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
    expect(cache.size).toBe(2);
  });
});
