/**
 * `useAssetUrl` (`static/assets.ts`) in a component: the identity in the server build, the static
 * registry on the Pages build's browser backend (re-rendering when an image is registered), and on
 * its server backend null until the server image source has loaded the image — which the hook
 * starts — then the loaded URL.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { capabilitiesFor, setCapabilitiesForTests } from '../capabilities.ts';
import { AssetRegistry, setActiveAssetRegistry, setServerAssetSource, useAssetUrl, type ServerAssetSource } from '../static/assets.ts';

const ICON = '/api/icons/11111111-1111-4111-8111-111111111111';
const OTHER = '/api/icons/33333333-3333-4333-8333-333333333333';

/** A server image source whose loads the test resolves by hand. */
function manualSource() {
  const loaded = new Map<string, string | null>();
  const listeners = new Set<() => void>();
  const pending = new Map<string, (value: string | null) => void>();
  const load = vi.fn(
    (url: string) =>
      new Promise<string | null>((resolve) => {
        pending.set(url, resolve);
      }),
  );
  const source: ServerAssetSource = {
    get: (url) => loaded.get(url) ?? null,
    load,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    source,
    load,
    finish(url: string, value: string | null) {
      loaded.set(url, value);
      pending.get(url)?.(value);
      for (const listener of listeners) listener();
    },
  };
}

afterEach(() => {
  setServerAssetSource(null);
  setActiveAssetRegistry(null);
});

describe('useAssetUrl', () => {
  it('server build: the URL itself; nothing for no URL', () => {
    const initialProps: { url: string | null | undefined } = { url: ICON };
    const { result, rerender } = renderHook(({ url }) => useAssetUrl(url), { initialProps });
    expect(result.current).toBe(ICON);
    rerender({ url: null });
    expect(result.current).toBeNull();
    rerender({ url: undefined });
    expect(result.current).toBeNull();
  });

  it('Pages build, browser backend: follows the static registry', () => {
    setCapabilitiesForTests(capabilitiesFor(true, 'browser'));
    const assets = new AssetRegistry({ createObjectUrl: () => 'blob:test/1', revokeObjectUrl: () => {} });
    setActiveAssetRegistry(assets);
    const { result } = renderHook(() => useAssetUrl(ICON));
    // Unknown ids keep the original URL, as before (the <img> errors and shows its fallback).
    expect(result.current).toBe(ICON);
    act(() => {
      assets.registerBlob('icons', '11111111-1111-4111-8111-111111111111', new Blob(['x']));
    });
    expect(result.current).toBe('blob:test/1');
  });

  it('Pages build, server backend: null until loaded, loads it, then the loaded URL', async () => {
    setCapabilitiesForTests(capabilitiesFor(true, 'server'));
    const fake = manualSource();
    setServerAssetSource(fake.source);
    const { result, rerender } = renderHook(({ url }: { url: string }) => useAssetUrl(url), { initialProps: { url: ICON } });
    expect(result.current).toBeNull();
    expect(fake.load).toHaveBeenCalledWith(ICON);

    await act(async () => fake.finish(ICON, 'blob:http://pages.example/icon'));
    expect(result.current).toBe('blob:http://pages.example/icon');
    expect(fake.load).toHaveBeenCalledTimes(1);

    rerender({ url: OTHER });
    expect(result.current).toBeNull();
    expect(fake.load).toHaveBeenLastCalledWith(OTHER);
    // A missing image stays null (the component keeps its placeholder) and is not asked for again.
    await act(async () => fake.finish(OTHER, null));
    expect(result.current).toBeNull();
    expect(fake.load).toHaveBeenCalledTimes(2);
  });

  it('Pages build, server backend: loads through a source plugged in after the first render', async () => {
    setCapabilitiesForTests(capabilitiesFor(true, 'server'));
    const { result } = renderHook(() => useAssetUrl(ICON));
    expect(result.current).toBeNull();
    const fake = manualSource();
    act(() => setServerAssetSource(fake.source));
    expect(fake.load).toHaveBeenCalledWith(ICON);
    await act(async () => fake.finish(ICON, 'blob:http://pages.example/late'));
    expect(result.current).toBe('blob:http://pages.example/late');
  });
});
