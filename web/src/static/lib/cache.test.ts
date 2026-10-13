import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryCache, type MemoryCache } from './cache.ts';

describe('createMemoryCache', () => {
  let clock = 1_000;
  let cache: MemoryCache;
  beforeEach(() => {
    clock = 1_000;
    cache = createMemoryCache({ now: () => clock });
  });

  it('stores values until the TTL expires', () => {
    cache.set('weather:a', { temp: 21 }, 500);
    expect(cache.get('weather:a')).toEqual({ temp: 21 });
    clock += 499;
    expect(cache.get('weather:a')).toEqual({ temp: 21 });
    clock += 1;
    expect(cache.get('weather:a')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('returns undefined for missing keys and supports falsy values', () => {
    expect(cache.get('nope')).toBeUndefined();
    cache.set('zero', 0, 100);
    cache.set('empty', '', 100);
    cache.set('null', null, 100);
    cache.set('false', false, 100);
    expect(cache.get('zero')).toBe(0);
    expect(cache.get('empty')).toBe('');
    expect(cache.get('null')).toBeNull();
    expect(cache.get('false')).toBe(false);
  });

  it('overwrites and deletes', () => {
    cache.set('k', 1, 100);
    cache.set('k', 2, 100);
    expect(cache.get('k')).toBe(2);
    expect(cache.size).toBe(1);
    cache.del('k');
    expect(cache.get('k')).toBeUndefined();
    cache.del('k'); // idempotent
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
    cache.delPrefix('');
    expect(cache.size).toBe(0);
  });

  it('getOrSet computes once, caches, and shares concurrent calls', async () => {
    const fn = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return { v: 1 };
    });
    const [a, b] = await Promise.all([cache.getOrSet('k', 1000, fn), cache.getOrSet('k', 1000, fn)]);
    expect(a).toEqual({ v: 1 });
    expect(b).toEqual({ v: 1 });
    expect(a).toBe(b);
    expect(fn).toHaveBeenCalledTimes(1);
    await cache.getOrSet('k', 1000, fn);
    expect(fn).toHaveBeenCalledTimes(1);
    clock += 1000;
    await cache.getOrSet('k', 1000, fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('getOrSet accepts synchronous producers and distinct keys do not share flights', async () => {
    const fn = vi.fn((key: string) => `${key}!`);
    const [a, b] = await Promise.all([cache.getOrSet('a', 100, () => fn('a')), cache.getOrSet('b', 100, () => fn('b'))]);
    expect([a, b]).toEqual(['a!', 'b!']);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('getOrSet does not cache failures, and all waiters see the same failure', async () => {
    const failing = vi.fn(() => Promise.reject(new Error('down')));
    const results = await Promise.allSettled([cache.getOrSet('k', 1000, failing), cache.getOrSet('k', 1000, failing)]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(failing).toHaveBeenCalledTimes(1);
    expect(cache.get('k')).toBeUndefined();
    await expect(cache.getOrSet('k', 1000, () => 'ok')).resolves.toBe('ok');
    expect(cache.get('k')).toBe('ok');
  });

  it('rejects non-positive TTLs', () => {
    expect(() => cache.set('k', 1, 0)).toThrow(RangeError);
    expect(() => cache.set('k', 1, -5)).toThrow(RangeError);
    expect(() => cache.set('k', 1, Number.NaN)).toThrow(RangeError);
    expect(() => cache.set('k', 1, Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => cache.getOrSet('k', 0, () => 1)).toThrow(RangeError);
  });

  it('evicts the least recently used entry', () => {
    const small = createMemoryCache({ maxEntries: 2, now: () => clock });
    small.set('a', 1, 1000);
    small.set('b', 2, 1000);
    expect(small.get('a')).toBe(1); // a is now most recent
    small.set('c', 3, 1000);
    expect(small.get('b')).toBeUndefined();
    expect(small.get('a')).toBe(1);
    expect(small.get('c')).toBe(3);
    expect(small.size).toBe(2);
  });

  it('uses Date.now by default', () => {
    const real = createMemoryCache();
    real.set('k', 'v', 10_000);
    expect(real.get('k')).toBe('v');
  });
});
