import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FROSTED_GLASS_KEY, readFrostedGlass, useFrostedGlass, writeFrostedGlass } from './glassPreference.ts';

describe('frosted glass preference (this browser)', () => {
  afterEach(() => {
    window.localStorage.removeItem(FROSTED_GLASS_KEY);
  });

  it('is off unless turned on, and turning it off removes the key', () => {
    expect(readFrostedGlass()).toBe(false);
    writeFrostedGlass(true);
    expect(window.localStorage.getItem(FROSTED_GLASS_KEY)).toBe('1');
    expect(readFrostedGlass()).toBe(true);
    writeFrostedGlass(false);
    expect(window.localStorage.getItem(FROSTED_GLASS_KEY)).toBeNull();
    expect(readFrostedGlass()).toBe(false);
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
    expect(readFrostedGlass(broken)).toBe(false);
    expect(() => writeFrostedGlass(true, broken)).not.toThrow();
    expect(readFrostedGlass({ getItem: () => 'yes' })).toBe(false);
  });

  it('keeps the hook current for this page and for other tabs', () => {
    const { result } = renderHook(() => useFrostedGlass());
    expect(result.current).toBe(false);
    act(() => writeFrostedGlass(true));
    expect(result.current).toBe(true);

    // Another tab turned it off.
    act(() => {
      window.localStorage.removeItem(FROSTED_GLASS_KEY);
      window.dispatchEvent(new StorageEvent('storage', { key: FROSTED_GLASS_KEY }));
    });
    expect(result.current).toBe(false);
  });
});
