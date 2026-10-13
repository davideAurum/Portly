/**
 * Images of a server-backend page: loaded through the server transport with the HTTP cache,
 * raster types as `blob:` URLs of the checked type, SVG only ever as a `data:` URL, at most three
 * at once, one request per image, 404s remembered and other failures retried (on the next request
 * and by the cache itself, until the page switches away from the server), subscribers told.
 */
import { describe, expect, it, vi } from 'vitest';
import { IMAGE_RETRY_DELAYS_MS, createServerAssetCache } from './assets.ts';
import { ServerModeEndedError } from './controller.ts';

const ICON = '/api/icons/abc';
const UPLOAD = '/api/uploads/1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b';

function image(type: string, body = 'img'): Response {
  return new Response(body, { headers: { 'Content-Type': type } });
}

function cache(answer: (path: string) => Response | Promise<Response>) {
  const fetch = vi.fn(async (path: string, _init?: RequestInit) => answer(path));
  const created: Blob[] = [];
  const createObjectUrl = vi.fn((blob: Blob) => {
    created.push(blob);
    return `blob:https://user.github.io/${created.length}`;
  });
  // Automatic retries are tested on their own, with a fake timer.
  return { fetch, created, createObjectUrl, source: createServerAssetCache({ fetch, createObjectUrl, retryDelaysMs: [] }) };
}

/** A setTimeout that only records; `fire()` runs what is due in order. */
function manualTimers() {
  const pending: { callback: () => void; ms: number }[] = [];
  return {
    setTimeout: (callback: () => void, ms: number) => {
      pending.push({ callback, ms });
      return pending.length;
    },
    pending,
    fire() {
      const next = pending.shift();
      next?.callback();
      return next?.ms;
    },
  };
}

describe('server asset cache', () => {
  it('loads a raster image as a blob: URL of its checked type, with the HTTP cache', async () => {
    const { fetch, source, created } = cache(() => image('image/png; charset=binary'));
    const listener = vi.fn();
    source.subscribe(listener);
    expect(source.get(ICON)).toBeNull();
    expect(await source.load(ICON)).toBe('blob:https://user.github.io/1');
    expect(source.get(ICON)).toBe('blob:https://user.github.io/1');
    expect(fetch).toHaveBeenCalledWith(ICON, { method: 'GET', cache: 'default' });
    expect(created[0]?.type).toBe('image/png');
    expect(listener).toHaveBeenCalledTimes(1);
    // Loaded once.
    expect(await source.load(ICON)).toBe('blob:https://user.github.io/1');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('turns SVG into a data: URL, never a blob: one', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    const { source, createObjectUrl } = cache(() => image('image/svg+xml', svg));
    const url = await source.load(UPLOAD);
    expect(url).toBe(`data:image/svg+xml;base64,${btoa(svg)}`);
    expect(createObjectUrl).not.toHaveBeenCalled();
  });

  it('gives no URL for something that is not an image', async () => {
    const { source, createObjectUrl } = cache(() => image('text/html', '<script>alert(1)</script>'));
    expect(await source.load(ICON)).toBeNull();
    expect(createObjectUrl).not.toHaveBeenCalled();
  });

  it('remembers a 404 but retries after other failures', async () => {
    const missing = cache(() => new Response(null, { status: 404 }));
    expect(await missing.source.load(ICON)).toBeNull();
    expect(await missing.source.load(ICON)).toBeNull();
    expect(missing.fetch).toHaveBeenCalledTimes(1);

    let attempt = 0;
    const flaky = cache(() => {
      attempt += 1;
      if (attempt === 1) throw new TypeError('Failed to fetch');
      if (attempt === 2) return new Response(null, { status: 503 });
      return image('image/webp');
    });
    expect(await flaky.source.load(ICON)).toBeNull();
    expect(await flaky.source.load(ICON)).toBeNull();
    expect(await flaky.source.load(ICON)).toMatch(/^blob:/);
    expect(flaky.fetch).toHaveBeenCalledTimes(3);
  });

  it('tries a failed image again by itself, and tells subscribers once it loads', async () => {
    const timers = manualTimers();
    let attempt = 0;
    const fetch = vi.fn(async () => {
      attempt += 1;
      if (attempt <= 2) throw new TypeError('Failed to fetch');
      return image('image/png');
    });
    const source = createServerAssetCache({ fetch, createObjectUrl: () => 'blob:https://user.github.io/x', setTimeout: timers.setTimeout });
    const listener = vi.fn();
    source.subscribe(listener);
    expect(await source.load(ICON)).toBeNull();
    expect(timers.fire()).toBe(IMAGE_RETRY_DELAYS_MS[0]);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(timers.pending).toHaveLength(1));
    expect(timers.fire()).toBe(IMAGE_RETRY_DELAYS_MS[1]);
    await vi.waitFor(() => expect(source.get(ICON)).toBe('blob:https://user.github.io/x'));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(timers.pending).toHaveLength(0);
  });

  it('stops retrying after the last delay, or at once when the page leaves the server', async () => {
    const timers = manualTimers();
    const fetch = vi.fn(async (): Promise<Response> => {
      throw new TypeError('Failed to fetch');
    });
    const source = createServerAssetCache({ fetch, setTimeout: timers.setTimeout, retryDelaysMs: [5] });
    expect(await source.load(ICON)).toBeNull();
    timers.fire();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    // Let the failed retry settle (a macrotask flushes every pending promise callback).
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(timers.pending).toHaveLength(0);
    expect(fetch).toHaveBeenCalledTimes(2);

    const ended = vi.fn(async (): Promise<Response> => {
      throw new ServerModeEndedError();
    });
    const switching = createServerAssetCache({ fetch: ended, setTimeout: timers.setTimeout });
    expect(await switching.load(UPLOAD)).toBeNull();
    expect(timers.pending).toHaveLength(0);
  });

  it('shares one request between callers of the same image', async () => {
    let finish: (res: Response) => void = () => {};
    const { fetch, source } = cache(() => new Promise<Response>((resolve) => (finish = resolve)));
    const first = source.load(ICON);
    const second = source.load(ICON);
    finish(image('image/gif'));
    expect(await first).toBe(await second);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('loads at most three images at once', async () => {
    const pending: ((res: Response) => void)[] = [];
    const { fetch, source } = cache(() => new Promise<Response>((resolve) => pending.push(resolve)));
    const loads = ['a', 'b', 'c', 'd', 'e'].map((id) => source.load(`/api/icons/${id}`));
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledTimes(3);
    pending[0]!(image('image/png'));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
    for (let i = 1; i < 5; i++) {
      await vi.waitFor(() => expect(pending[i]).toBeDefined());
      pending[i]!(image('image/png'));
    }
    expect(await Promise.all(loads)).toHaveLength(5);
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it('never fetches anything but app image URLs', async () => {
    const { fetch, source } = cache(() => image('image/png'));
    for (const url of ['/api/settings', 'https://example.com/a.png', '/api/icons/a/b', 'blob:x']) expect(await source.load(url)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});
