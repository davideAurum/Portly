import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { WIKIPEDIA_FALLBACK_KEY, readWikipediaFallback, useWikipediaFallback, writeWikipediaFallback } from './wikipediaFallback.ts';

describe('Wikipedia suggestions instead (this browser)', () => {
  afterEach(() => {
    window.localStorage.removeItem(WIKIPEDIA_FALLBACK_KEY);
  });

  it('is off unless turned on, and turning it off removes the key', () => {
    expect(readWikipediaFallback()).toBe(false);
    writeWikipediaFallback(true);
    expect(window.localStorage.getItem(WIKIPEDIA_FALLBACK_KEY)).toBe('1');
    expect(readWikipediaFallback()).toBe(true);
    writeWikipediaFallback(false);
    expect(window.localStorage.getItem(WIKIPEDIA_FALLBACK_KEY)).toBeNull();
    expect(readWikipediaFallback()).toBe(false);
  });

  it('counts unreadable or unwritable storage as off and never throws', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('full');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readWikipediaFallback(broken)).toBe(false);
    expect(() => writeWikipediaFallback(true, broken)).not.toThrow();
    expect(readWikipediaFallback({ getItem: () => 'yes' })).toBe(false);
  });

  it('keeps the hook current for this page and for other tabs', () => {
    const { result } = renderHook(() => useWikipediaFallback());
    expect(result.current).toBe(false);
    act(() => writeWikipediaFallback(true));
    expect(result.current).toBe(true);

    // Another tab turned it off.
    act(() => {
      window.localStorage.removeItem(WIKIPEDIA_FALLBACK_KEY);
      window.dispatchEvent(new StorageEvent('storage', { key: WIKIPEDIA_FALLBACK_KEY }));
    });
    expect(result.current).toBe(false);
  });
});
