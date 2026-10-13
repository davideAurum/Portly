/**
 * App-wide providers (§10.1): TanStack Query with the cache persisted to localStorage
 * (maxAge 24 h, buster = app version) so a new tab paints last-known data instantly and then
 * refetches; sonner toasts following the effective light/dark scheme. Queries can opt out of
 * persistence with `meta: {persist: false}` (e.g. health, anything sensitive); mail queries and
 * all mutations are never persisted.
 *
 * The persisted cache is restored *before* the first render (main.tsx awaits
 * {@link restorePersistedCache}), so the first frame already shows last-known data instead of an
 * empty page. The snapshot is kept small (oversized queries, site-meta lookups and calendar
 * ranges nobody is looking at are not written), and when the origin's storage quota is hit the
 * oldest queries are dropped until it fits, rather than silently keeping an ever older snapshot.
 *
 * Each backend has its own snapshot ({@link persistOptionsFor}): the server build's; in the Pages
 * build the in-browser backend's and, in hybrid mode, the one of the Portly server on this PC
 * (keyed by that server's instance, kept 7 days, without accounts or OAuth clients). The two Pages
 * datasets never mix: a page load restores and writes only its own backend's snapshot, and on a
 * quota error the other backend's snapshot is dropped first. The options belong to the QueryClient
 * (one per page load), decided by the first restore or render.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { IsRestoringProvider, QueryClient, QueryClientProvider, defaultShouldDehydrateQuery, type Query } from '@tanstack/react-query';
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister';
import { persistQueryClientRestore, persistQueryClientSubscribe, removeOldestQuery, type PersistRetryer, type Persister } from '@tanstack/react-query-persist-client';
import { Toaster } from 'sonner';
import { ApiError } from '../api/client.ts';
import type { Backend } from '../capabilities.ts';
import { useColorScheme } from '../theme/useTheme.ts';
import { useToastSpaceReserved } from '../ui/toast.ts';

export const APP_VERSION: string = __APP_VERSION__;
export const QUERY_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/**
 * The Pages build's snapshot of the Portly server on this PC lives longer: a page load on the
 * server backend paints it while the server is being checked, even after a week away.
 */
export const LOCAL_SERVER_QUERY_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * The static build namespaces its cache by base path: every project site under one
 * `<user>.github.io` origin shares localStorage, and a static and a server build may both run
 * on localhost during development. In the Pages build this is the in-browser backend's key.
 */
export const QUERY_CACHE_STORAGE_KEY = __PORTLY_STATIC__ ? `portly:query-cache:static:${import.meta.env.BASE_URL}` : 'portly:query-cache';
/** Persisted snapshots from another build or version are discarded. */
export const QUERY_CACHE_BUSTER = __PORTLY_STATIC__ ? `${APP_VERSION}+static` : APP_VERSION;
/** The Pages build's key for the snapshot of the Portly server on this PC (hybrid mode). */
export const LOCAL_SERVER_QUERY_CACHE_KEY = `portly:query-cache:local-server:${import.meta.env.BASE_URL}`;
/** The Pages build's key for the in-browser backend's snapshot. */
const BROWSER_QUERY_CACHE_KEY = `portly:query-cache:static:${import.meta.env.BASE_URL}`;
/** The server build's key. */
const SERVER_BUILD_QUERY_CACHE_KEY = 'portly:query-cache';

function shouldRetry(failureCount: number, error: unknown): boolean {
  // Client errors (4xx), reauth/not-configured states and 501 stubs will not fix themselves.
  if (error instanceof ApiError && ((error.status >= 400 && error.status < 500) || error.status === 501)) return false;
  return failureCount < 2;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      // The API is this PC's own server, reachable whether or not the internet is: TanStack's
      // default ('online') would pause every query and mutation while the browser reports
      // offline. Upstream outages are the server's to report.
      queries: {
        staleTime: 30_000,
        gcTime: QUERY_CACHE_MAX_AGE_MS,
        refetchOnWindowFocus: true,
        retry: shouldRetry,
        networkMode: 'always',
      },
      mutations: {
        retry: false,
        networkMode: 'always',
      },
    },
  });
}

/**
 * Query families never written to localStorage: mail content stays in memory only (§5), like
 * the server's own mail cache; diagnostics (health, hosts, log records) always show the server's
 * state now, and on the Pages site that storage is shared with every project site of the origin.
 */
const NON_PERSISTED_ROOTS: ReadonlySet<unknown> = new Set(['mail', 'diagnostics']);

/** Queries whose data serializes to more than this are not persisted (localStorage is ~5 M chars). */
export const MAX_PERSISTED_QUERY_CHARS = 512 * 1024;

/** Serialized size per data object (query data is immutable: a new object on every update). */
const serializedSizes = new WeakMap<object, number>();

function serializedSize(data: unknown): number {
  if (data === null || typeof data !== 'object') return data === undefined ? 0 : String(data).length;
  const cached = serializedSizes.get(data);
  if (cached !== undefined) return cached;
  let size: number;
  try {
    size = JSON.stringify(data)?.length ?? 0;
  } catch {
    size = Number.POSITIVE_INFINITY;
  }
  serializedSizes.set(data, size);
  return size;
}

function hasKeyPrefix(query: Query, ...prefix: string[]): boolean {
  return prefix.every((part, i) => query.queryKey[i] === part);
}

/** Whether a (successful) query is written to the persisted cache. */
export function shouldPersistQuery(query: Query): boolean {
  if (!defaultShouldDehydrateQuery(query) || query.meta?.persist === false || NON_PERSISTED_ROOTS.has(query.queryKey[0])) return false;
  // Per-URL title/icon lookups of the bookmark dialog: never needed for a new tab's first paint.
  if (hasKeyPrefix(query, 'bookmarks', 'site-meta')) return false;
  // Calendar ranges are persisted while a widget shows them (the new tab paints that range);
  // ranges visited earlier stay in memory only.
  if (hasKeyPrefix(query, 'calendar', 'events') && query.getObserversCount() === 0) return false;
  return serializedSize(query.state.data) <= MAX_PERSISTED_QUERY_CHARS;
}

/**
 * Mutations are never persisted: their variables can hold passwords, app passwords, tokens and
 * client secrets, which must not reach localStorage (a paused mutation would otherwise be).
 */
export function shouldPersistMutation(): boolean {
  return false;
}

/** What the persister writes to localStorage. */
export const PERSIST_DEHYDRATE_OPTIONS = Object.freeze({
  shouldDehydrateQuery: shouldPersistQuery,
  shouldDehydrateMutation: shouldPersistMutation,
});

/**
 * Query families a Pages page on the server backend never writes: the account list (addresses)
 * and the OAuth client settings. That snapshot sits in the storage of an origin every other page
 * of the account shares; the server build keeps them (its origin is its own).
 */
const REMOTE_SERVER_NON_PERSISTED_ROOTS: ReadonlySet<unknown> = new Set(['accounts', 'oauth-clients']);

export function shouldPersistRemoteServerQuery(query: Query): boolean {
  return !REMOTE_SERVER_NON_PERSISTED_ROOTS.has(query.queryKey[0]) && shouldPersistQuery(query);
}

/** What a Pages page on the server backend writes to localStorage. */
export const REMOTE_SERVER_DEHYDRATE_OPTIONS = Object.freeze({
  shouldDehydrateQuery: shouldPersistRemoteServerQuery,
  shouldDehydrateMutation: shouldPersistMutation,
});

function browserStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/** Removes the snapshots stored under `keys`; true when there was one. */
function removeSnapshots(storage: Storage | undefined, keys: readonly string[]): boolean {
  let removed = false;
  for (const key of keys) {
    try {
      if (storage?.getItem(key) == null) continue;
      storage.removeItem(key);
      removed = true;
    } catch {
      // Unusable storage: nothing to free there.
    }
  }
  return removed;
}

/**
 * The persister of the snapshot under `key`. On a storage quota error it first drops the
 * snapshots under `otherKeys` (another backend's) and tries again, then drops the oldest query
 * until the snapshot fits (instead of keeping a stale one).
 */
export function createQueryPersister(storage: Storage | undefined, throttleTime = 1000, key: string = QUERY_CACHE_STORAGE_KEY, otherKeys: readonly string[] = []): Persister {
  const retry: PersistRetryer = (props) => {
    if (props.errorCount === 1 && removeSnapshots(storage, otherKeys)) return props.persistedClient;
    return removeOldestQuery(props);
  };
  return createSyncStoragePersister({ storage, key, throttleTime, retry });
}

/** How one backend's snapshot is persisted. */
export interface QueryPersistOptions {
  /** localStorage key of the snapshot (`applyPersistedTheme` reads it too). */
  key: string;
  persister: Persister;
  maxAge: number;
  /** Snapshots written under another buster (version, build, server instance) are discarded. */
  buster: string;
  dehydrateOptions: typeof PERSIST_DEHYDRATE_OPTIONS;
}

/** Options on the page's own localStorage, one object per key and buster. */
const pageOptions = new Map<string, QueryPersistOptions>();

/**
 * The persist options of a backend: the server build's (`portly:query-cache`, buster = version);
 * in the Pages build (`pagesBuild`, default: this build) the in-browser backend's
 * (`portly:query-cache:static:<base>`, buster `<version>+static`) or those of the Portly server
 * on this PC (`portly:query-cache:local-server:<base>`, buster
 * `<version>+local-server:<instanceId>`, 7 days, no accounts or OAuth clients). Without a `storage`
 * override, the same object for the same key and buster.
 */
export function persistOptionsFor(backend: Backend, instanceId: string | null = null, options: { pagesBuild?: boolean; storage?: Storage } = {}): QueryPersistOptions {
  const pagesBuild = options.pagesBuild ?? __PORTLY_STATIC__;
  const remote = pagesBuild && backend === 'server';
  const key = !pagesBuild ? SERVER_BUILD_QUERY_CACHE_KEY : remote ? LOCAL_SERVER_QUERY_CACHE_KEY : BROWSER_QUERY_CACHE_KEY;
  const buster = !pagesBuild ? APP_VERSION : remote ? `${APP_VERSION}+local-server:${instanceId ?? ''}` : `${APP_VERSION}+static`;
  const id = `${key} ${buster}`;
  const shared = options.storage === undefined;
  const cached = shared ? pageOptions.get(id) : undefined;
  if (cached !== undefined) return cached;
  const storage = shared ? (typeof window === 'undefined' ? undefined : browserStorage()) : options.storage;
  const otherKeys = !pagesBuild ? [] : [remote ? BROWSER_QUERY_CACHE_KEY : LOCAL_SERVER_QUERY_CACHE_KEY];
  const persist: QueryPersistOptions = Object.freeze({
    key,
    persister: createQueryPersister(storage, 1000, key, otherKeys),
    maxAge: remote ? LOCAL_SERVER_QUERY_CACHE_MAX_AGE_MS : QUERY_CACHE_MAX_AGE_MS,
    buster,
    dehydrateOptions: remote ? REMOTE_SERVER_DEHYDRATE_OPTIONS : PERSIST_DEHYDRATE_OPTIONS,
  });
  if (shared) pageOptions.set(id, persist);
  return persist;
}

const clientOptions = new WeakMap<QueryClient, QueryPersistOptions>();

/**
 * The persist options of `client`: those it was first restored or rendered with, else the build's
 * default backend (the server build's, or the in-browser backend's in the Pages build).
 */
export function persistOptionsOf(client: QueryClient): QueryPersistOptions {
  return clientOptions.get(client) ?? persistOptionsFor(__PORTLY_STATIC__ ? 'browser' : 'server');
}

/** The client's options, settled by the first caller (later `persist` arguments cannot change them). */
function bindPersistOptions(client: QueryClient, persist: QueryPersistOptions | undefined): QueryPersistOptions {
  const existing = clientOptions.get(client);
  if (existing !== undefined) return existing;
  const options = persist ?? persistOptionsOf(client);
  clientOptions.set(client, options);
  return options;
}

function persistClientOptions(client: QueryClient, persist: QueryPersistOptions) {
  return { queryClient: client, persister: persist.persister, maxAge: persist.maxAge, buster: persist.buster, dehydrateOptions: persist.dehydrateOptions };
}

/** Bottom offset while a bottom bar (the edit toolbar) is shown: bar height + its margin + a gap. */
export const RAISED_TOAST_OFFSET = { bottom: 88 } as const;

/**
 * Toasts follow the effective light/dark scheme (settings, then the OS preference) and move up
 * while a bottom bar is shown, so they never cover its buttons.
 */
function ThemedToaster() {
  const scheme = useColorScheme();
  const raised = useToastSpaceReserved();
  return <Toaster position="bottom-right" closeButton richColors theme={scheme} offset={raised ? RAISED_TOAST_OFFSET : undefined} />;
}

/**
 * Runs once the persisted cache has been restored: everything restored is marked stale and the
 * active queries refetch, so a new tab paints last-known data instantly and then shows the
 * server's current state (§10.1) — even when the restored data is younger than its staleTime,
 * e.g. written moments ago by another tab that still held an older copy.
 */
export function refreshAfterRestore(client: QueryClient): Promise<void> {
  return client.invalidateQueries();
}

interface RestoreState {
  promise: Promise<void>;
  done: boolean;
}

const restores = new WeakMap<QueryClient, RestoreState>();

/**
 * Restores the persisted cache into `client` once (later calls share the first restore) and marks
 * everything restored stale ({@link refreshAfterRestore}). Never rejects: an unreadable snapshot
 * is discarded and the app starts empty. `persist` is this page load's backend snapshot (default:
 * {@link persistOptionsOf}); the first restore or render settles it for the client.
 */
export function restorePersistedCache(client: QueryClient, persist?: QueryPersistOptions): Promise<void> {
  const options = bindPersistOptions(client, persist);
  const existing = restores.get(client);
  if (existing) return existing.promise;
  const state: RestoreState = { promise: Promise.resolve(), done: false };
  state.promise = persistQueryClientRestore(persistClientOptions(client, options))
    .catch(() => undefined)
    .then(() => refreshAfterRestore(client))
    .catch(() => undefined)
    .finally(() => {
      state.done = true;
    });
  restores.set(client, state);
  return state.promise;
}

/** Whether {@link restorePersistedCache} has finished for `client`. */
export function isCacheRestored(client: QueryClient): boolean {
  return restores.get(client)?.done ?? false;
}

export interface AppProvidersProps {
  client: QueryClient;
  /** This page load's backend snapshot (default: the client's, {@link persistOptionsOf}). */
  persist?: QueryPersistOptions;
  children: ReactNode;
}

/**
 * QueryClientProvider + persistence. When main.tsx already restored the cache, queries render
 * restored data on the very first frame and refetch on mount; otherwise (a restore still
 * running) queries wait for it, like TanStack's PersistQueryClientProvider.
 */
export function AppProviders({ client, persist, children }: AppProvidersProps) {
  const [restoring, setRestoring] = useState(() => !isCacheRestored(client));
  const options = bindPersistOptions(client, persist);

  useEffect(() => {
    if (restoring) {
      let live = true;
      void restorePersistedCache(client, options).then(() => {
        if (live) setRestoring(false);
      });
      return () => {
        live = false;
      };
    }
    return persistQueryClientSubscribe(persistClientOptions(client, options));
  }, [client, options, restoring]);

  return (
    <QueryClientProvider client={client}>
      <IsRestoringProvider value={restoring}>
        {children}
        <ThemedToaster />
      </IsRestoringProvider>
    </QueryClientProvider>
  );
}
