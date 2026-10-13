/**
 * Asset URLs. The app references stored images only through the URLs `shared/core.ts` builds —
 * `/api/icons/<id>` and `/api/uploads/<id>` — and uses them as `<img src>` and CSS `url()`, which
 * no fetch interception can serve. What such a URL becomes depends on this page load
 * (`getCapabilities()`):
 *
 * - server build: the URL itself (the server serves it);
 * - Pages build, browser backend: the `AssetRegistry` of the static backend maps the ids to `blob:`
 *   object URLs created from the stored blobs (or, for bookmark icons that come from a favicon
 *   service, to that service's https URL);
 * - Pages build, server backend (hybrid mode): a `ServerAssetSource` (`setServerAssetSource`) loads
 *   the image from the Homebase server on this PC and hands out a `blob:` or `data:` URL once it is
 *   loaded. Until then there is no URL — never the raw `/api/…` path, which would ask the Pages
 *   host for it and leak the id.
 *
 * Components use `useAssetUrl` (follows loading); other code `getAssetUrl`, `loadAssetUrl` or,
 * when it needs a string now, `resolveAssetUrl`.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { getCapabilities } from '../capabilities.ts';
import { faviconServiceUrl, isFaviconId } from './favicon.ts';

export type AssetKind = 'icons' | 'uploads';

const ASSET_PATH = /^\/api\/(icons|uploads)\/([^/?#]+)$/;

export function parseAssetUrl(url: string): { kind: AssetKind; id: string } | null {
  const match = ASSET_PATH.exec(url);
  if (!match) return null;
  const kind = match[1] as AssetKind;
  const raw = match[2] ?? '';
  try {
    return { kind, id: decodeURIComponent(raw) };
  } catch {
    return null;
  }
}

export class AssetRegistry {
  private readonly urls = new Map<string, string>();
  private readonly objectUrls = new Set<string>();
  private readonly createObjectUrl: (blob: Blob) => string;
  private readonly revokeObjectUrl: (url: string) => void;

  constructor(options: { createObjectUrl?: (blob: Blob) => string; revokeObjectUrl?: (url: string) => void } = {}) {
    this.createObjectUrl = options.createObjectUrl ?? ((blob) => URL.createObjectURL(blob));
    this.revokeObjectUrl = options.revokeObjectUrl ?? ((url) => URL.revokeObjectURL(url));
  }

  private key(kind: AssetKind, id: string): string {
    return `${kind}/${id}`;
  }

  /** Registers a stored blob; returns its object URL (replacing any earlier registration). */
  registerBlob(kind: AssetKind, id: string, blob: Blob): string {
    this.revoke(kind, id);
    const url = this.createObjectUrl(blob);
    this.urls.set(this.key(kind, id), url);
    this.objectUrls.add(url);
    this.changed();
    return url;
  }

  /** Registers an external https URL (e.g. a favicon service) for an id. */
  registerExternal(kind: AssetKind, id: string, url: string): void {
    this.revoke(kind, id);
    this.urls.set(this.key(kind, id), url);
    this.changed();
  }

  revoke(kind: AssetKind, id: string): void {
    const key = this.key(kind, id);
    const url = this.urls.get(key);
    if (url === undefined) return;
    this.urls.delete(key);
    if (this.objectUrls.delete(url)) this.revokeObjectUrl(url);
    this.changed();
  }

  resolve(kind: AssetKind, id: string): string | undefined {
    return this.urls.get(this.key(kind, id));
  }

  has(kind: AssetKind, id: string): boolean {
    return this.urls.has(this.key(kind, id));
  }

  /** Ids of this kind registered with an object URL (not external URLs). */
  blobIds(kind: AssetKind): string[] {
    const prefix = `${kind}/`;
    const ids: string[] = [];
    for (const [key, url] of this.urls) if (key.startsWith(prefix) && this.objectUrls.has(url)) ids.push(key.slice(prefix.length));
    return ids;
  }

  /** Revokes every object URL (tests, teardown). */
  clear(): void {
    for (const url of this.objectUrls) this.revokeObjectUrl(url);
    this.objectUrls.clear();
    this.urls.clear();
    this.changed();
  }

  /** Tells `subscribeAssets` listeners, when this is the page's registry. */
  private changed(): void {
    if (active === this) notifyAssets();
  }
}

let active: AssetRegistry | null = null;

/** The registry of the running static backend (set by backend.ts when ready). */
export function setActiveAssetRegistry(registry: AssetRegistry | null): void {
  active = registry;
  notifyAssets();
}

export function getActiveAssetRegistry(): AssetRegistry | null {
  return active;
}

/**
 * Where a server-backend page of the Pages build gets its images: the Homebase server on this PC,
 * through the hybrid-mode transport. `get` answers synchronously (null until loaded, or when the
 * image does not exist), `load` fetches it if needed, and `subscribe` hears about every newly
 * loaded image.
 */
export interface ServerAssetSource {
  get(url: string): string | null;
  load(url: string): Promise<string | null>;
  subscribe(listener: () => void): () => void;
}

let serverSource: ServerAssetSource | null = null;
let unsubscribeServerSource: (() => void) | null = null;
const listeners = new Set<() => void>();

function notifyAssets(): void {
  for (const listener of [...listeners]) listener();
}

/** Plugs in the server-backend image source (Pages build, hybrid mode; null to unplug). */
export function setServerAssetSource(source: ServerAssetSource | null): void {
  unsubscribeServerSource?.();
  unsubscribeServerSource = null;
  serverSource = source;
  if (source !== null) unsubscribeServerSource = source.subscribe(notifyAssets);
  notifyAssets();
}

/** Calls `listener` whenever an asset URL may resolve differently (an image loaded, registered or removed). */
export function subscribeAssets(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

type AssetMode = 'identity' | 'registry' | 'server';

function assetMode(): AssetMode {
  const caps = getCapabilities();
  if (!caps.pagesBuild) return 'identity';
  return caps.backend === 'server' ? 'server' : 'registry';
}

/** The static registry's URL for `url`, or `url` itself when unknown (the `<img>` then errors and the UI shows its fallback). */
function registryUrl(url: string): string {
  const parsed = parseAssetUrl(url);
  if (!parsed) return url;
  // Synthetic favicon ids need no registry: they map straight to the icon service.
  if (parsed.kind === 'icons' && isFaviconId(parsed.id)) return faviconServiceUrl(parsed.id) ?? url;
  if (active === null) return url;
  return active.resolve(parsed.kind, parsed.id) ?? url;
}

/** True for an app API path, which only the Homebase server can answer (never asked of the Pages host). */
function isApiPath(url: string): boolean {
  return url === '/api' || url.startsWith('/api/');
}

/**
 * Maps an app asset URL (`/api/icons/<id>`, `/api/uploads/<id>`) to something the browser can
 * load on this page, or null when there is nothing to show yet. Server build: the URL itself.
 * Pages build, browser backend: the registered object/external URL, or the original URL when
 * unknown. Pages build, server backend: the loaded image's URL, or null until it is loaded (or when
 * it does not exist): call `loadAssetUrl` or use `useAssetUrl` to load it. Other URLs come back
 * unchanged, except other `/api/` paths on a server backend (null).
 */
export function getAssetUrl(url: string): string | null {
  switch (assetMode()) {
    case 'identity':
      return url;
    case 'registry':
      return registryUrl(url);
    case 'server':
      if (parseAssetUrl(url) === null) return isApiPath(url) ? null : url;
      return serverSource?.get(url) ?? null;
  }
}

/** Like `getAssetUrl`, but loads a server-backend image first; resolves null when it cannot be loaded. */
export async function loadAssetUrl(url: string): Promise<string | null> {
  if (assetMode() !== 'server' || parseAssetUrl(url) === null) return getAssetUrl(url);
  if (serverSource === null) return null;
  try {
    return await serverSource.load(url);
  } catch {
    return null;
  }
}

/** A transparent 1x1 GIF: what `resolveAssetUrl` gives for a server-backend image until it is loaded. */
export const TRANSPARENT_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/**
 * `getAssetUrl` for callers that need a string now. Pages build, server backend: an image that is
 * not loaded yet starts loading and gives a transparent pixel meanwhile (never the raw `/api/…`
 * URL); `subscribeAssets` (or `useAssetUrl`) picks up the real URL once it is loaded.
 */
export function resolveAssetUrl(url: string): string {
  const resolved = getAssetUrl(url);
  if (resolved !== null) return resolved;
  if (assetMode() === 'server' && parseAssetUrl(url) !== null) void loadAssetUrl(url);
  return TRANSPARENT_PIXEL;
}

/**
 * The URL to show for an app asset URL in a component, following loading: null while there is
 * nothing to show (no URL given, or a server-backend image not loaded yet or missing), when the
 * component renders its placeholder instead. Starts loading a server-backend image that is not
 * loaded yet (again when another image source is plugged in).
 */
export function useAssetUrl(url: string | null | undefined): string | null {
  const resolved = useSyncExternalStore(
    subscribeAssets,
    () => (url == null ? null : getAssetUrl(url)),
    () => null,
  );
  const source = useSyncExternalStore(
    subscribeAssets,
    () => serverSource,
    () => null,
  );
  useEffect(() => {
    if (url == null || resolved !== null) return;
    void loadAssetUrl(url);
  }, [url, resolved, source]);
  return resolved;
}
