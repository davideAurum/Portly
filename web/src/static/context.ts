/**
 * What every static-backend handler receives besides the request.
 */
import type { AssetRegistry } from './assets.ts';
import type { StaticState } from './state.ts';

export interface StaticContext {
  /** Persisted application state (settings, profiles, bookmarks, …) and the blob store. */
  state: StaticState;
  /** `/api/icons/<id>` and `/api/uploads/<id>` → object URLs for the running page. */
  assets: AssetRegistry;
  /** App version (`__APP_VERSION__`). */
  version: string;
  /** Epoch ms; injectable for tests. */
  now: () => number;
  /** Random UUIDv4; injectable for tests. */
  newId: () => string;
  /**
   * The app's own address, origin plus base path (`https://<user>.github.io/<repo>/`): the
   * redirect URI of the browser sign-in. Injectable for tests.
   */
  appUrl: string;
  /**
   * Tells this page's app that background work changed these slices (a calendar sync that
   * outlived the requests waiting for it), the way another tab's change is told. Absent in tests.
   */
  notify?: (keys: readonly string[]) => void;
}

/** The running page's app address (origin + Vite base path), or a localhost placeholder outside a page. */
export function defaultAppUrl(): string {
  const origin = typeof location === 'undefined' ? 'http://localhost' : location.origin;
  return new URL(import.meta.env.BASE_URL, origin).href;
}
