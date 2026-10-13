/**
 * Asset URLs per page load (`assets.ts`): the identity in the server build, the static registry on
 * the Pages build's browser backend (unchanged: the original URL when unknown), and the server
 * image source on its server backend (null until loaded, a transparent pixel for sync callers,
 * never the raw `/api/…` URL). Plus the change notifications `useAssetUrl` follows (its React
 * side is covered by `web/src/test/useAssetUrl.test.tsx`).
 */
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { capabilitiesFor, setCapabilitiesForTests } from '../capabilities.ts';
import {
  AssetRegistry,
  TRANSPARENT_PIXEL,
  getAssetUrl,
  loadAssetUrl,
  resolveAssetUrl,
  setActiveAssetRegistry,
  setServerAssetSource,
  subscribeAssets,
  type ServerAssetSource,
} from './assets.ts';

const ICON = '/api/icons/11111111-1111-4111-8111-111111111111';
const UPLOAD = '/api/uploads/22222222-2222-4222-8222-222222222222';

/** A server image source over a map the test fills; `load` loads from `available`. */
function fakeSource(available: Record<string, string> = {}) {
  const loaded = new Map<string, string>();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const load = vi.fn(async (url: string): Promise<string | null> => {
    const value = available[url];
    if (value === undefined) return null;
    loaded.set(url, value);
    notify();
    return value;
  });
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
  return { source, load, listeners, notify };
}

function registry(): AssetRegistry {
  let n = 0;
  return new AssetRegistry({ createObjectUrl: () => `blob:test/${++n}`, revokeObjectUrl: () => {} });
}

afterEach(() => {
  setServerAssetSource(null);
  setActiveAssetRegistry(null);
});

describe('server build', () => {
  it('is the identity', async () => {
    setCapabilitiesForTests(capabilitiesFor(false, 'server'));
    setServerAssetSource(fakeSource({ [ICON]: 'blob:never' }).source);
    expect(getAssetUrl(ICON)).toBe(ICON);
    expect(resolveAssetUrl(UPLOAD)).toBe(UPLOAD);
    await expect(loadAssetUrl(ICON)).resolves.toBe(ICON);
  });
});

describe('Pages build, browser backend (the static registry)', () => {
  it('is the default here and answers from the active registry, else with the original URL', async () => {
    const assets = registry();
    expect(getAssetUrl(UPLOAD)).toBe(UPLOAD);
    setActiveAssetRegistry(assets);
    const url = assets.registerBlob('uploads', '22222222-2222-4222-8222-222222222222', new Blob(['x']));
    expect(getAssetUrl(UPLOAD)).toBe(url);
    expect(resolveAssetUrl(UPLOAD)).toBe(url);
    await expect(loadAssetUrl(UPLOAD)).resolves.toBe(url);
    expect(getAssetUrl(ICON)).toBe(ICON);
    expect(resolveAssetUrl(ICON)).toBe(ICON);
    expect(getAssetUrl('/api/icons/fav%3Agithub.com')).toBe('https://icons.duckduckgo.com/ip3/github.com.ico');
    expect(getAssetUrl('https://example.com/a.png')).toBe('https://example.com/a.png');
  });

  it('tells subscribers when the active registry changes, not another one', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAssets(listener);
    const assets = registry();
    setActiveAssetRegistry(assets);
    expect(listener).toHaveBeenCalledTimes(1);
    assets.registerBlob('icons', 'a', new Blob(['x']));
    assets.registerExternal('icons', 'b', 'https://icons.example/b.ico');
    assets.revoke('icons', 'a');
    assets.revoke('icons', 'missing');
    expect(listener).toHaveBeenCalledTimes(4);
    registry().registerBlob('icons', 'c', new Blob(['x']));
    expect(listener).toHaveBeenCalledTimes(4);
    unsubscribe();
    assets.clear();
    expect(listener).toHaveBeenCalledTimes(4);
  });
});

describe('Pages build, server backend (the server image source)', () => {
  it('has no URL until the image is loaded, then the source’s', async () => {
    setCapabilitiesForTests(capabilitiesFor(true, 'server'));
    const fake = fakeSource({ [ICON]: 'blob:http://pages.example/icon' });
    setServerAssetSource(fake.source);
    expect(getAssetUrl(ICON)).toBeNull();
    await expect(loadAssetUrl(ICON)).resolves.toBe('blob:http://pages.example/icon');
    expect(fake.load).toHaveBeenCalledWith(ICON);
    expect(getAssetUrl(ICON)).toBe('blob:http://pages.example/icon');
    expect(resolveAssetUrl(ICON)).toBe('blob:http://pages.example/icon');
  });

  it('resolveAssetUrl never gives the raw /api URL: a transparent pixel, and it starts loading', async () => {
    setCapabilitiesForTests(capabilitiesFor(true, 'server'));
    const fake = fakeSource({ [UPLOAD]: 'data:image/svg+xml;base64,PHN2Zy8+' });
    setServerAssetSource(fake.source);
    expect(resolveAssetUrl(UPLOAD)).toBe(TRANSPARENT_PIXEL);
    expect(TRANSPARENT_PIXEL).toMatch(/^data:image\/gif;base64,/);
    expect(fake.load).toHaveBeenCalledWith(UPLOAD);
    await vi.waitFor(() => expect(resolveAssetUrl(UPLOAD)).toBe('data:image/svg+xml;base64,PHN2Zy8+'));
  });

  it('a missing image, a failing source or no source at all give null (never the /api URL)', async () => {
    setCapabilitiesForTests(capabilitiesFor(true, 'server'));
    expect(getAssetUrl(ICON)).toBeNull();
    await expect(loadAssetUrl(ICON)).resolves.toBeNull();
    expect(resolveAssetUrl(ICON)).toBe(TRANSPARENT_PIXEL);

    setServerAssetSource(fakeSource().source);
    await expect(loadAssetUrl(ICON)).resolves.toBeNull();
    expect(resolveAssetUrl(ICON)).toBe(TRANSPARENT_PIXEL);

    const failing = fakeSource();
    failing.load.mockRejectedValue(new TypeError('Failed to fetch'));
    setServerAssetSource(failing.source);
    await expect(loadAssetUrl(ICON)).resolves.toBeNull();
  });

  it('passes other URLs through, except other /api paths', async () => {
    setCapabilitiesForTests(capabilitiesFor(true, 'server'));
    const fake = fakeSource();
    setServerAssetSource(fake.source);
    expect(getAssetUrl('https://example.com/a.png')).toBe('https://example.com/a.png');
    await expect(loadAssetUrl('https://example.com/a.png')).resolves.toBe('https://example.com/a.png');
    expect(getAssetUrl('/api/icons/a/b')).toBeNull();
    expect(getAssetUrl('/api/export')).toBeNull();
    expect(resolveAssetUrl('/api/export')).toBe(TRANSPARENT_PIXEL);
    expect(getAssetUrl('/api/icons/fav%3Agithub.com')).toBeNull();
    expect(fake.load).not.toHaveBeenCalled();
  });

  it('forwards the source’s notifications, and stops when it is replaced', () => {
    const listener = vi.fn();
    onTestFinished(subscribeAssets(listener));
    const first = fakeSource();
    setServerAssetSource(first.source);
    expect(listener).toHaveBeenCalledTimes(1);
    first.notify();
    expect(listener).toHaveBeenCalledTimes(2);
    setServerAssetSource(fakeSource().source);
    expect(listener).toHaveBeenCalledTimes(3);
    expect(first.listeners.size).toBe(0);
    first.notify();
    expect(listener).toHaveBeenCalledTimes(3);
  });
});
