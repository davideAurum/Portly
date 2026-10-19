/**
 * useNow: ticks on interval boundaries with one timer per interval, stops while the tab is hidden
 * and catches up at once when it is visible again.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useNow } from './useNow.ts';

const START = Date.parse('2026-10-18T09:00:10.000Z');

beforeEach(() => {
  vi.useFakeTimers({ now: START, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function setVisibility(state: DocumentVisibilityState): void {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(state);
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

describe('useNow', () => {
  it('ticks on the interval boundary, one timer for every subscriber of an interval', () => {
    const first = renderHook(() => useNow(60_000));
    const second = renderHook(() => useNow(60_000));
    expect(vi.getTimerCount()).toBe(1);
    act(() => {
      vi.advanceTimersByTime(49_999);
    });
    expect(first.result.current.getTime()).toBe(START);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(first.result.current.toISOString()).toBe('2026-10-18T09:01:00.000Z');
    expect(second.result.current.toISOString()).toBe('2026-10-18T09:01:00.000Z');
    first.unmount();
    second.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops while the tab is hidden and catches up at once when it is visible again', () => {
    const renders = vi.fn();
    const hook = renderHook(() => {
      renders();
      return useNow(1_000);
    });
    setVisibility('hidden');
    expect(vi.getTimerCount()).toBe(0);
    const before = renders.mock.calls.length;
    act(() => {
      vi.advanceTimersByTime(5 * 60_000);
    });
    expect(renders.mock.calls.length).toBe(before);

    setVisibility('visible');
    expect(hook.result.current.getTime()).toBe(START + 5 * 60_000);
    expect(vi.getTimerCount()).toBe(1);
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(hook.result.current.getTime()).toBe(START + 5 * 60_000 + 1_000);
    hook.unmount();
  });

  it('a subscriber that mounts in a hidden tab waits for it to be visible', () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const hook = renderHook(() => useNow(60_000));
    expect(vi.getTimerCount()).toBe(0);
    vi.setSystemTime(START + 120_000);
    setVisibility('visible');
    expect(hook.result.current.getTime()).toBe(START + 120_000);
    expect(vi.getTimerCount()).toBe(1);
    hook.unmount();
  });
});
