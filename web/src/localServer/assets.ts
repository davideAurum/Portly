/**
 * Images of a server-backend page (hybrid mode): bookmark icons (`/api/icons/<id>`) and uploads
 * (`/api/uploads/<id>`) live on the Portly server on this PC, but an `<img src>` or CSS `url()`
 * cannot carry the pairing token, and the raw `/api/…` path would ask the Pages host for it. So
 * the page fetches each image through the server transport (with the browser's HTTP cache: the
 * server sends `private, max-age=86400`) and hands out a URL of its own:
 *
 * - raster images (png, gif, jpeg, webp, avif, ico, bmp): a `blob:` URL, created with the checked
 *   type so the blob can only ever render as an image;
 * - SVG: a `data:image/svg+xml;base64,…` URL, never a `blob:` one — a same-origin SVG document
 *   opened on its own could run script on the Pages origin, a `data:` one cannot.
 *
 * At most three images load at once. A 404 is remembered (the image does not exist); any other
 * failure is not: the cache tries again by itself a few times ({@link IMAGE_RETRY_DELAYS_MS} — a
 * retry waits in the transport while the server reconnects), and the next request for the same
 * image tries again too. Subscribers hear about every image that finished loading. This is the
 * `ServerAssetSource` `static/assets.ts` uses.
 */
import { parseAssetUrl, type ServerAssetSource } from '../static/assets.ts';
import { ServerModeEndedError } from './controller.ts';

/** Content types an image may have (what the server's magic-byte sniffing stores). */
const RASTER_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/gif',
  'image/jpeg',
  'image/webp',
  'image/avif',
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'image/bmp',
]);
const SVG_TYPE = 'image/svg+xml';

export const MAX_CONCURRENT_IMAGE_LOADS = 3;

/**
 * After a failed load (not a 404), the cache tries again after these delays. Without it an image
 * whose request failed because the server went away mid-request would stay blank until something
 * asked for it again; a retry waits in the transport until the server is back (or the page
 * switches to the browser's copy, which ends the retries).
 */
export const IMAGE_RETRY_DELAYS_MS: readonly number[] = Object.freeze([2_000, 10_000, 30_000]);

export interface ServerAssetCacheDeps {
  /** The server transport (`localServerFetch`): `path` is the app URL, e.g. `/api/icons/<id>`. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  createObjectUrl?: (blob: Blob) => string;
  maxConcurrent?: number;
  /** Delays of the automatic retries after a failure (default {@link IMAGE_RETRY_DELAYS_MS}; `[]` turns them off). */
  retryDelaysMs?: readonly number[];
  setTimeout?: (callback: () => void, ms: number) => unknown;
}

type Entry = { kind: 'loaded'; url: string } | { kind: 'missing' } | { kind: 'loading'; promise: Promise<string | null> };

function base64(bytes: Uint8Array): string {
  let binary = '';
  // In chunks: spreading megabytes into one call overflows the argument limit.
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function createServerAssetCache(deps: ServerAssetCacheDeps): ServerAssetSource {
  const createObjectUrl = deps.createObjectUrl ?? ((blob: Blob) => URL.createObjectURL(blob));
  const maxConcurrent = deps.maxConcurrent ?? MAX_CONCURRENT_IMAGE_LOADS;
  const retryDelays = deps.retryDelaysMs ?? IMAGE_RETRY_DELAYS_MS;
  const setTimer = deps.setTimeout ?? ((callback: () => void, ms: number) => globalThis.setTimeout(callback, ms));
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  const queue: (() => void)[] = [];
  let running = 0;

  function notify(): void {
    for (const listener of [...listeners]) listener();
  }

  /** Runs `task` when one of the load slots is free. */
  function limited<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        running += 1;
        task()
          .then(resolve, reject)
          .finally(() => {
            running -= 1;
            queue.shift()?.();
          });
      };
      if (running < maxConcurrent) run();
      else queue.push(run);
    });
  }

  /** The image's page URL; null when it does not exist (404) or is not an image; throws on other failures. */
  async function fetchImage(url: string): Promise<string | null> {
    const res = await deps.fetch(url, { method: 'GET', cache: 'default' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Image request failed (${res.status})`);
    const type = (res.headers.get('content-type') ?? '').split(';', 1)[0]!.trim().toLowerCase();
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (type === SVG_TYPE) return `data:${SVG_TYPE};base64,${base64(bytes)}`;
    if (RASTER_TYPES.has(type)) return createObjectUrl(new Blob([bytes], { type }));
    return null;
  }

  /** Tries a failed image again later, unless the page is switching away from the server. */
  function retryLater(url: string, error: unknown, attempt: number): void {
    const delay = retryDelays[attempt];
    if (delay === undefined || error instanceof ServerModeEndedError) return;
    setTimer(() => {
      // Someone else asked for it meanwhile (or it loaded): nothing to do.
      if (!entries.has(url)) void start(url, attempt + 1);
    }, delay);
  }

  function start(url: string, attempt: number): Promise<string | null> {
    const promise = limited(() => fetchImage(url)).then(
      (loaded) => {
        entries.set(url, loaded === null ? { kind: 'missing' } : { kind: 'loaded', url: loaded });
        if (loaded !== null) notify();
        return loaded;
      },
      (error: unknown) => {
        // Not remembered: the next request for this image tries again, and so does the cache.
        entries.delete(url);
        retryLater(url, error, attempt);
        return null;
      },
    );
    entries.set(url, { kind: 'loading', promise });
    return promise;
  }

  function load(url: string): Promise<string | null> {
    if (parseAssetUrl(url) === null) return Promise.resolve(null);
    const entry = entries.get(url);
    if (entry?.kind === 'loaded') return Promise.resolve(entry.url);
    if (entry?.kind === 'missing') return Promise.resolve(null);
    if (entry?.kind === 'loading') return entry.promise;
    return start(url, 0);
  }

  return {
    get(url) {
      const entry = entries.get(url);
      return entry?.kind === 'loaded' ? entry.url : null;
    },
    load,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
