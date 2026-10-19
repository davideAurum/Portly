import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBakedBackdrop, windowSizeKey, type BackdropBakeDeps } from './useTheme.ts';

function fakeDeps(result: () => Promise<Blob | null> = async () => new Blob(['x'])) {
  let next = 0;
  const deps = {
    bake: vi.fn<BackdropBakeDeps['bake']>(() => result()),
    createObjectUrl: vi.fn<BackdropBakeDeps['createObjectUrl']>(() => `blob:http://localhost/${++next}`),
    revokeObjectUrl: vi.fn<BackdropBakeDeps['revokeObjectUrl']>(),
    preload: vi.fn<BackdropBakeDeps['preload']>(async () => undefined),
  } satisfies BackdropBakeDeps;
  return deps;
}

/** Runs the bake delay and lets the bake promise settle. */
async function flushBake() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });
}

describe('useBakedBackdrop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('bakes nothing without a photo or a blur', async () => {
    const deps = fakeDeps();
    const { result, rerender } = renderHook(({ src, blur }) => useBakedBackdrop(src, blur, deps), { initialProps: { src: null as string | null, blur: 10 } });
    await flushBake();
    rerender({ src: 'blob:http://localhost/photo', blur: 0 });
    await flushBake();
    expect(result.current).toBeNull();
    expect(deps.bake).not.toHaveBeenCalled();
  });

  it('returns the baked copy after a short delay, and bakes again for a new blur', async () => {
    const deps = fakeDeps();
    const { result, rerender } = renderHook(({ blur }) => useBakedBackdrop('blob:http://localhost/photo', blur, deps), { initialProps: { blur: 10 } });
    expect(result.current).toBeNull();
    await flushBake();
    expect(deps.bake).toHaveBeenCalledTimes(1);
    expect(deps.bake.mock.calls[0]?.slice(0, 2)).toEqual(['blob:http://localhost/photo', 10]);
    expect(result.current).toBe('blob:http://localhost/1');

    // A new blur: the old copy no longer matches, so the live blur shows until the new one is ready.
    rerender({ blur: 20 });
    expect(result.current).toBeNull();
    await flushBake();
    expect(result.current).toBe('blob:http://localhost/2');

    // The replaced object URL is revoked once the backdrop has switched.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });
    expect(deps.revokeObjectUrl).toHaveBeenCalledWith('blob:http://localhost/1');
    expect(deps.revokeObjectUrl).not.toHaveBeenCalledWith('blob:http://localhost/2');
  });

  it('waits for a slider to settle instead of baking every step', async () => {
    const deps = fakeDeps();
    const { rerender } = renderHook(({ blur }) => useBakedBackdrop('blob:http://localhost/photo', blur, deps), { initialProps: { blur: 1 } });
    for (const blur of [2, 3, 4, 5]) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      rerender({ blur });
    }
    await flushBake();
    expect(deps.bake).toHaveBeenCalledTimes(1);
    expect(deps.bake.mock.calls[0]?.[1]).toBe(5);
  });

  it('keeps the live blur when the browser cannot bake or the image fails', async () => {
    for (const result of [async () => null, async () => Promise.reject(new Error('decode'))]) {
      const deps = fakeDeps(result);
      const hook = renderHook(() => useBakedBackdrop('blob:http://localhost/photo', 10, deps));
      await flushBake();
      expect(hook.result.current).toBeNull();
      expect(deps.createObjectUrl).not.toHaveBeenCalled();
      hook.unmount();
    }
  });

  it('never returns a stale bake that lands after a newer one, and revokes a copy cancelled while decoding', async () => {
    const pending: ((blob: Blob) => void)[] = [];
    const deps = fakeDeps(() => new Promise<Blob>((resolve) => pending.push(resolve)));
    const { result, rerender } = renderHook(({ blur }) => useBakedBackdrop('blob:http://localhost/photo', blur, deps), { initialProps: { blur: 10 } });
    await flushBake(); // bake A (blur 10) starts and waits
    rerender({ blur: 20 });
    await flushBake(); // bake B (blur 20) starts and waits
    expect(pending).toHaveLength(2);
    await act(async () => {
      pending[1]!(new Blob(['b']));
    });
    expect(result.current).toBe('blob:http://localhost/1');
    await act(async () => {
      pending[0]!(new Blob(['a']));
    });
    // A's bake was cancelled before it produced a URL.
    expect(result.current).toBe('blob:http://localhost/1');
    expect(deps.createObjectUrl).toHaveBeenCalledTimes(1);

    // Cancelled while its copy decodes: the URL is revoked and never returned.
    let finishDecode = () => {};
    deps.preload.mockImplementationOnce(() => new Promise<void>((resolve) => (finishDecode = resolve)));
    deps.bake.mockImplementationOnce(async () => new Blob(['c']));
    rerender({ blur: 30 });
    await flushBake();
    rerender({ blur: 40 });
    await act(async () => {
      finishDecode();
    });
    expect(deps.revokeObjectUrl).toHaveBeenCalledWith('blob:http://localhost/2');
    expect(result.current).not.toBe('blob:http://localhost/2');
  });

  it('bakes again for browser zoom, keeping the old copy meanwhile, but not for small resizes', async () => {
    const setWindow = (width: number, height: number, dpr: number) => {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
      Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: dpr });
    };
    setWindow(1920, 1080, 1);
    const deps = fakeDeps();
    const { result } = renderHook(() => useBakedBackdrop('blob:http://localhost/photo', 10, deps));
    await flushBake();
    expect(result.current).toBe('blob:http://localhost/1');

    // A small resize stays in the same size bucket.
    setWindow(1900, 1070, 1);
    await act(async () => {
      window.dispatchEvent(new Event('resize'));
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(deps.bake).toHaveBeenCalledTimes(1);

    // Zoom to 200%: same device pixels, half the CSS size.
    setWindow(960, 540, 2);
    await act(async () => {
      window.dispatchEvent(new Event('resize'));
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(result.current).toBe('blob:http://localhost/1');
    await flushBake();
    expect(deps.bake).toHaveBeenCalledTimes(2);
    expect(deps.bake.mock.calls[1]?.[2]).toEqual({ width: 960, height: 540, devicePixelRatio: 2 });
    expect(result.current).toBe('blob:http://localhost/2');
    setWindow(1024, 768, 1); // jsdom's defaults
  });

  it('windowSizeKey changes with zoom and big resizes only', () => {
    const key = (width: number, height: number, devicePixelRatio: number) => windowSizeKey({ width, height, devicePixelRatio });
    expect(key(1920, 1080, 1)).toBe(key(1900, 1070, 1));
    expect(key(1920, 1080, 1)).not.toBe(key(960, 540, 2));
    expect(key(1920, 1080, 1)).not.toBe(key(1920, 1080, 1.5));
    expect(key(1920, 1080, 1)).not.toBe(key(1400, 1080, 1));
  });

  it('lets the copy go when the background stops being a blurred photo', async () => {
    const deps = fakeDeps();
    const { result, rerender } = renderHook(({ blur }) => useBakedBackdrop('blob:http://localhost/photo', blur, deps), { initialProps: { blur: 10 } });
    await flushBake();
    expect(result.current).toBe('blob:http://localhost/1');
    rerender({ blur: 0 });
    expect(result.current).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });
    expect(deps.revokeObjectUrl).toHaveBeenCalledWith('blob:http://localhost/1');
  });
});
