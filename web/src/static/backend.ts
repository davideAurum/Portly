/**
 * The in-browser backend of the static build. `staticFetch(path, init)` is what
 * `web/src/api/client.ts` calls instead of `fetch` when `__PORTLY_STATIC__` is true: it builds a
 * Request, dispatches it to the handler registered for `METHOD /api/path` and returns the
 * handler's Response, so the client's error mapping and JSON handling are shared with the server
 * build. The first call opens storage (IndexedDB, or memory when that fails), loads the persisted
 * state, registers stored images as object URLs and lets the handler modules seed first-run data.
 *
 * The page's backend reports its state through {@link getStaticBackendStatus} /
 * {@link subscribeStaticBackendStatus} (the shell shows a banner when it could not start or when
 * another tab closed its database). A failed start is retried with backoff, not on every call.
 *
 * Diagnostics (ARCHITECTURE §17): a failed start, a database closed under the page and a handler
 * that crashed (an answer `500 internal`) are also this browser's `backend` events, next to their
 * console lines — the error's name, the attempt or the route pattern, never a request's URL or data.
 *
 * Tests create isolated instances with {@link createStaticBackend} and an injected storage.
 */
import { recordCollapsedClientEvent } from '../api/client.ts';
import { recordClientEvent } from '../diagnostics/clientLog.ts';
import { AssetRegistry, setActiveAssetRegistry } from './assets.ts';
import { defaultAppUrl, type StaticContext } from './context.ts';
import { registerRoutes, onBackendReady } from './handlers/index.ts';
import { syncUploadAssets } from './handlers/uploads.ts';
import { finishSignIn, planAutomaticSignIn } from './oauthRedirect.ts';
import { apiError, StaticApiError } from './respond.ts';
import { StaticRouter } from './router.ts';
import { SLICE, getIcons } from './slices.ts';
import { StaticState, type ChangeChannel, type ExternalChangeListener } from './state.ts';
import { IndexedDbStorage } from './storage/idb.ts';
import { MemoryStorage } from './storage/memory.ts';
import { blobOf, isQuotaExceeded, type StaticStorage } from './storage/types.ts';

/** Placeholder origin: the static backend only looks at the path and query. */
const PLACEHOLDER_ORIGIN = 'http://portly.static';

/** The 500 message when the browser refuses a write because its storage is full. */
export const STORAGE_FULL_MESSAGE = 'Browser storage is full. Free up space on this device or export your data, then try again.';

export interface StaticBackend {
  readonly ctx: StaticContext;
  readonly router: StaticRouter;
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /**
   * Called with the slice names another tab changed, after they were reloaded here and the
   * images they name were registered (so a refetch already resolves their URLs), and with those
   * this tab's background work changed (`ctx.notify`: a calendar sync that outlived its requests).
   */
  onExternalChange(listener: ExternalChangeListener): () => void;
  close(): void;
}

export interface CreateStaticBackendOptions {
  storage: StaticStorage;
  version?: string;
  now?: () => number;
  newId?: () => string;
  appUrl?: string;
  channel?: ChangeChannel | null;
  assets?: AssetRegistry;
  /** Make this instance the page's active one (asset URL resolution). Default false. */
  activate?: boolean;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

/** An error's name (`QuotaExceededError`, `TypeError`…), for diagnostic events. */
function errorName(err: unknown): string {
  const name = typeof err === 'object' && err !== null ? (err as { name?: unknown }).name : undefined;
  return typeof name === 'string' ? name : typeof err;
}

/** The parsed request, or the 400 answer when it cannot even be built (e.g. a GET with a body). */
function buildRequest(path: string, init: RequestInit): { url: URL; method: string; req: Request } | Response {
  try {
    const url = new URL(path, PLACEHOLDER_ORIGIN);
    const method = (init.method ?? 'GET').toUpperCase();
    return { url, method, req: new Request(url, { ...init, method }) };
  } catch (err) {
    if (isAbortError(err)) throw err;
    return apiError('bad_request', `Invalid request: ${describe(err)}`);
  }
}

export async function dispatch(router: StaticRouter, ctx: StaticContext, path: string, init: RequestInit = {}): Promise<Response> {
  const built = buildRequest(path, init);
  if (built instanceof Response) return built;
  const { url, method, req } = built;
  const match = router.match(method, url.pathname);
  if (!match) {
    return router.hasPath(url.pathname)
      ? apiError('bad_request', `${method} is not supported for ${url.pathname}`)
      : apiError('not_found', `No such API route: ${method} ${url.pathname}`);
  }
  try {
    // Answer from the latest data: reloads that other tabs asked for are applied first.
    await ctx.state.settled();
    return await match.handler(ctx, { req, url, params: match.params });
  } catch (err) {
    if (err instanceof StaticApiError) return err.toResponse();
    if (isAbortError(err)) throw err;
    // The route's pattern, never the request's path or query (ids, search terms).
    const op = `${method} ${match.pattern}`;
    if (isQuotaExceeded(err)) {
      recordCollapsedClientEvent('backend', `full ${op}`, 'error', 'browser storage is full', { errName: errorName(err), op });
      return apiError('internal', STORAGE_FULL_MESSAGE);
    }
    recordCollapsedClientEvent('backend', `crash ${op} ${errorName(err)}`, 'error', 'in-browser backend request failed', { errName: errorName(err), op });
    return apiError('internal', `Static backend failed: ${describe(err)}`);
  }
}

/**
 * Brings the asset registry in line with the icons slice (commit-free): registers custom icons
 * that have no object URL yet and revokes those whose metadata is gone. An icon only marked
 * orphaned keeps its URL (Undo can bring it back).
 */
export async function syncIconAssets(ctx: StaticContext): Promise<void> {
  const existing = new Set(getIcons(ctx).map((icon) => icon.id));
  for (const id of ctx.assets.blobIds('icons')) if (!existing.has(id)) ctx.assets.revoke('icons', id);
  for (const id of existing) {
    if (ctx.assets.has('icons', id)) continue;
    const blob = await ctx.state.getBlob(id);
    // Re-checked after the await: the icon may have been deleted meanwhile.
    if (blob?.kind === 'icon' && !ctx.assets.has('icons', id) && getIcons(ctx).some((icon) => icon.id === id)) {
      ctx.assets.registerBlob('icons', id, blobOf(blob));
    }
  }
}

/** After another tab changed `keys`: registers/revokes the object URLs of the images involved. */
export async function syncExternalAssets(ctx: StaticContext, keys: readonly string[]): Promise<void> {
  const changed = new Set(keys);
  // Settings and layouts decide which uploads are shown (only referenced ones are registered).
  if (changed.has(SLICE.uploads) || changed.has(SLICE.settings) || changed.has(SLICE.profiles)) await syncUploadAssets(ctx);
  if (changed.has(SLICE.icons)) await syncIconAssets(ctx);
}

/** Builds a backend over the given storage: loads state, registers assets, seeds first-run data. */
export async function createStaticBackend(options: CreateStaticBackendOptions): Promise<StaticBackend> {
  const state = new StaticState(options.storage, { channel: options.channel });
  const assets = options.assets ?? new AssetRegistry();
  const ctx: StaticContext = {
    state,
    assets,
    version: options.version ?? __APP_VERSION__,
    now: options.now ?? (() => Date.now()),
    newId: options.newId ?? (() => globalThis.crypto.randomUUID()),
    appUrl: options.appUrl ?? defaultAppUrl(),
  };
  try {
    await state.loadAll();
  } catch (err) {
    state.close();
    throw err;
  }
  const router = new StaticRouter();
  registerRoutes(router);
  await onBackendReady(ctx);
  if (options.activate) setActiveAssetRegistry(assets);

  // Another tab changed data: register its new images first, then tell the app (which refetches
  // and renders the new URLs). Serialized, so changes are handled in the order they arrived.
  // Background work of this tab (`ctx.notify`) is told the same way.
  const listeners = new Set<ExternalChangeListener>();
  let changes: Promise<void> = Promise.resolve();
  const tell = (keys: readonly string[]): void => {
    for (const listener of listeners) {
      try {
        listener(keys);
      } catch (err) {
        console.error('[Portly] A cross-tab change listener failed', err);
      }
    }
  };
  const stopWatching = state.onExternalChange((keys) => {
    changes = changes.then(async () => {
      try {
        await syncExternalAssets(ctx, keys);
      } catch (err) {
        console.error('[Portly] Could not load images another tab added', err);
      }
      tell(keys);
    });
  });
  ctx.notify = (keys) => {
    changes = changes.then(() => tell(keys));
  };

  return {
    ctx,
    router,
    fetch: (path, init) => dispatch(router, ctx, path, init),
    onExternalChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: () => {
      stopWatching();
      listeners.clear();
      state.close();
      if (options.activate) setActiveAssetRegistry(null);
      assets.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// The page's backend
// ---------------------------------------------------------------------------

export type StaticBackendStatus =
  | { state: 'starting' }
  | { state: 'ready'; storage: StaticStorage['kind'] }
  /** Could not start; the next API call after `retryAt` (epoch ms) tries again. */
  | { state: 'failed'; message: string; retryAt: number }
  /** Another tab upgraded or deleted the database (or the browser closed it): reload the page. */
  | { state: 'closed'; storage: StaticStorage['kind'] };

/** First retry delay after a failed start; doubles per failure up to {@link START_RETRY_MAX_MS}. */
export const START_RETRY_BASE_MS = 2_000;
export const START_RETRY_MAX_MS = 60_000;

async function openDefaultStorage(): Promise<StaticStorage> {
  if (typeof indexedDB === 'undefined') return new MemoryStorage();
  try {
    return await IndexedDbStorage.open();
  } catch {
    // Private browsing modes and storage-blocked contexts: run from memory for this page load.
    return new MemoryStorage();
  }
}

interface PageBackendConfig {
  openStorage: () => Promise<StaticStorage>;
  now: () => number;
}

const defaultConfig: PageBackendConfig = { openStorage: openDefaultStorage, now: () => Date.now() };
let config: PageBackendConfig = defaultConfig;
let activeBackend: Promise<StaticBackend> | null = null;
let failure: { error: unknown; count: number; retryAt: number } | null = null;
let status: StaticBackendStatus = { state: 'starting' };
const statusListeners = new Set<(status: StaticBackendStatus) => void>();

function setStatus(next: StaticBackendStatus): void {
  status = next;
  for (const listener of statusListeners) {
    try {
      listener(next);
    } catch {
      // One listener must not keep the others from hearing about it.
    }
  }
}

export function getStaticBackendStatus(): StaticBackendStatus {
  return status;
}

export function subscribeStaticBackendStatus(listener: (status: StaticBackendStatus) => void): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

async function startPageBackend(): Promise<StaticBackend> {
  const storage = await config.openStorage();
  try {
    const backend = await createStaticBackend({ storage, activate: true });
    storage.onClosed?.(() => {
      recordClientEvent('warn', 'backend', 'in-browser database closed (another tab upgraded or deleted it)', { op: 'closed' });
      setStatus({ state: 'closed', storage: storage.kind });
    });
    return backend;
  } catch (err) {
    // Nothing may keep the failed attempt's database connection open.
    storage.close?.();
    throw err;
  }
}

/**
 * The page's backend, created on first use. When creating it fails, the failure is kept and
 * reported (status `failed`) and the next attempt waits for a growing delay instead of
 * re-opening IndexedDB and re-reading everything on every API call.
 */
export function ensureStaticBackend(): Promise<StaticBackend> {
  if (activeBackend !== null) return activeBackend;
  if (failure !== null && config.now() < failure.retryAt) return Promise.reject(failure.error);
  const attempt = startPageBackend().then(
    (backend) => {
      failure = null;
      setStatus({ state: 'ready', storage: backend.ctx.state.storage.kind });
      return backend;
    },
    (err: unknown) => {
      const count = (failure?.count ?? 0) + 1;
      const retryAt = config.now() + Math.min(START_RETRY_BASE_MS * 2 ** (count - 1), START_RETRY_MAX_MS);
      failure = { error: err, count, retryAt };
      activeBackend = null;
      console.error('[Portly] The in-browser backend could not start', err);
      recordClientEvent('error', 'backend', 'in-browser backend could not start', { errName: errorName(err), attempt: count, op: 'start' });
      setStatus({ state: 'failed', message: describe(err), retryAt });
      throw err;
    },
  );
  activeBackend = attempt;
  return attempt;
}

/**
 * Tests only: replaces how the page's backend opens storage / reads the clock, and forgets any
 * backend or failure from earlier tests. Returns a function that restores the defaults.
 */
export function configurePageBackendForTests(overrides: Partial<PageBackendConfig> = {}): () => void {
  const reset = (): void => {
    void activeBackend?.then((backend) => backend.close()).catch(() => undefined);
    activeBackend = null;
    failure = null;
    status = { state: 'starting' };
    statusListeners.clear();
  };
  reset();
  config = { ...defaultConfig, ...overrides };
  return () => {
    reset();
    config = defaultConfig;
  };
}

/** What the API client calls in the static build. */
export async function staticFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const backend = await ensureStaticBackend();
  return backend.fetch(path, init);
}

/** Lets the app react when another tab changed data (e.g. invalidate the query cache). */
export async function subscribeStaticChanges(listener: ExternalChangeListener): Promise<() => void> {
  const backend = await ensureStaticBackend();
  return backend.onExternalChange(listener);
}

/** Storage backing the page's backend (`indexeddb` or the `memory` fallback), for the About page. */
export async function staticStorageKind(): Promise<StaticStorage['kind']> {
  const backend = await ensureStaticBackend();
  return backend.ctx.state.storage.kind;
}

/**
 * When the page was opened as Microsoft's sign-in answer (`?code&state`): completes the sign-in and
 * returns the address to show instead (with `?oauth=<result>`); null for any other address.
 */
export async function staticFinishSignIn(href: string): Promise<string | null> {
  const backend = await ensureStaticBackend();
  return finishSignIn(backend.ctx, href);
}

/** The address of an automatic Microsoft re-sign-in to go to at page load, or null (see oauthRedirect.ts). */
export async function staticAutomaticSignIn(href: string): Promise<string | null> {
  const backend = await ensureStaticBackend();
  return planAutomaticSignIn(backend.ctx, href);
}
