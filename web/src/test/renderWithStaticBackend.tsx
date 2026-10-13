/**
 * `renderWithStaticBackend(ui, options)` (§13): like `renderWithProviders`, but API calls are
 * answered by the REAL in-browser backend of the static build (`src/static/backend.ts`) over an
 * in-memory storage instead of per-route mocks. Global `fetch` is stubbed to
 * `backend.fetch(path, init)`, which is exactly what `api()` calls in the static build, so the
 * unchanged `api()` → ApiError path is exercised without the `__PORTLY_STATIC__` build flag
 * (the web vitest project defines it `false`). The backend registers whatever handler modules
 * `src/static/handlers/index.ts` lists.
 *
 * Seeding state before the first render — two ways:
 *
 *   // 1. After the handler modules' `ready()` ran (first-run seeding is done): mutate + commit.
 *   await renderWithStaticBackend(<Dashboard />, {
 *     seed: async (ctx) => {
 *       ctx.state.set(SLICE.settings, { ...defaultSettings(), activeProfileId: 'p1' });
 *       await ctx.state.commit(SLICE.settings);
 *     },
 *   });
 *
 *   // 2. Before `ready()` runs (e.g. to prove seeding is skipped): a pre-filled storage.
 *   const storage = new MemoryStorage();
 *   await storage.setJson('slice:profiles', [profileRow]);
 *   await renderWithStaticBackend(<Dashboard />, { storage });
 *
 * Afterwards read back through `result.ctx.state.get(name, init)` / `result.storage`, and drive
 * routes directly with `result.backend.fetch('/api/...')`. `ctx.now()` and `ctx.newId()` are
 * deterministic (1_700_000_000_000 ms; `00000000-0000-4000-8000-0000000000NN`) unless overridden.
 *
 * Multipart bodies (uploads, imports): `api()` passes a jsdom `FormData`, which vitest's jsdom
 * environment cannot hand to Node's `Request` (its compat shim reads a private jsdom Blob field
 * that jsdom 30 no longer has, failing with `Cannot read properties of undefined (reading
 * '_buffer')`). The stub serializes such a body the way a browser puts it on the wire — raw
 * multipart bytes plus the `content-type` boundary — and, with Node's `File` as the global class
 * for the duration of the call (see `withNodeFile`), the backend's `req.formData()` parses it back
 * into Node Files, so `previewImport(file)` and icon uploads work end to end.
 *
 * Not covered here: the capabilities. `capabilities.ts` reports the server build, so the gating
 * (hidden widgets and sections) is off and `resolveAssetUrl` / `useAssetUrl` stay the identity.
 * A test of the Pages build on its in-browser backend — gating on, blob: URLs for
 * `/api/uploads/<id>` — calls, before rendering:
 *
 *   setCapabilitiesForTests(capabilitiesFor(true, 'browser'));
 *
 * (the vitest setup restores the build's own capabilities after every test).
 */
import type { ReactElement, ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react';
import { Toaster } from 'sonner';
import { onTestFinished, vi } from 'vitest';
import { createStaticBackend, type StaticBackend } from '../static/backend.ts';
import type { StaticContext } from '../static/context.ts';
import { MemoryStorage } from '../static/storage/memory.ts';
import type { StaticStorage } from '../static/storage/types.ts';
import { createTestQueryClient } from './render.tsx';

export interface StaticRequestLog {
  method: string;
  /** Pathname without the query string. */
  path: string;
  /** `?a=b` or ''. */
  search: string;
  /** Status the backend answered with. */
  status: number;
}

export interface RenderWithStaticBackendOptions {
  /** Storage the backend loads from (default: an empty `MemoryStorage`). Pre-fill it to seed before `ready()`. */
  storage?: StaticStorage;
  /** Runs after the backend is ready and before rendering: mutate slices and `commit` them. */
  seed?: (ctx: StaticContext) => void | Promise<void>;
  /** Hash route to start on, e.g. '#/settings/about'. */
  route?: string;
  queryClient?: QueryClient;
  /** Render a sonner Toaster (default true). */
  toaster?: boolean;
  /** `ctx.version` (default '0.0.0-test', the web project's `__APP_VERSION__`). */
  version?: string;
  now?: () => number;
  newId?: () => string;
}

export interface RenderWithStaticBackendResult extends RenderResult {
  backend: StaticBackend;
  ctx: StaticContext;
  storage: StaticStorage;
  queryClient: QueryClient;
  /** Every request `fetch` received, in order, with the backend's status. */
  requests: StaticRequestLog[];
  /** Requests matching `METHOD /path` (path without the query string). */
  requestsTo(key: string): StaticRequestLog[];
  /** Closes the backend (also done automatically when the test finishes). */
  close(): void;
}

/** Deterministic ids like `src/static/test/harness.ts`: `00000000-0000-4000-8000-0000000000NN`. */
function sequentialIds(): () => string {
  let counter = 0;
  return () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
}

/** Percent-encodes the characters a multipart header value cannot carry (RFC 7578 §4.2). */
function headerValue(value: string): string {
  return value.replace(/[\r\n"]/g, (c) => ({ '\r': '%0D', '\n': '%0A', '"': '%22' })[c] ?? c);
}

/**
 * Serializes a (jsdom) `FormData` as a `multipart/form-data` body — what the browser would send —
 * so Node's `Request` can carry it (see the module docs). File parts keep their name and type.
 */
export async function multipartBody(form: FormData): Promise<{ body: Uint8Array<ArrayBuffer>; contentType: string }> {
  const boundary = `----portly-test-${Math.random().toString(36).slice(2)}`;
  const encoder = new TextEncoder();
  const parts: Uint8Array<ArrayBuffer>[] = [];
  for (const [name, value] of form) {
    const disposition = `Content-Disposition: form-data; name="${headerValue(name)}"`;
    if (typeof value === 'string') {
      parts.push(encoder.encode(`--${boundary}\r\n${disposition}\r\n\r\n${value}\r\n`));
      continue;
    }
    const type = value.type === '' ? 'application/octet-stream' : value.type;
    parts.push(encoder.encode(`--${boundary}\r\n${disposition}; filename="${headerValue(value.name)}"\r\nContent-Type: ${type}\r\n\r\n`));
    parts.push(new Uint8Array(await value.arrayBuffer()));
    parts.push(encoder.encode('\r\n'));
  }
  parts.push(encoder.encode(`--${boundary}--\r\n`));
  const body = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.byteLength;
  }
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

/** Node's own `File` class (`node:buffer`), reached without `@types/node`; null outside Node. */
function nodeFileClass(): typeof File | null {
  const process = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
  const buffer = process?.getBuiltinModule?.('node:buffer') as { File?: typeof File } | undefined;
  return buffer?.File ?? null;
}

/**
 * Runs `fn` with Node's `File` as the global class. Under jsdom the global `File` is jsdom's,
 * and Node's multipart parser (`Request.formData()`) builds each file part with the global class
 * but checks it against its own, so every multipart body with a file part fails an internal
 * assertion. Pointing the global at Node's class for the duration of the backend call makes the
 * parser agree with itself; the handler receives ordinary Node Files.
 */
async function withNodeFile<T>(fn: () => Promise<T>): Promise<T> {
  const NodeFile = nodeFileClass();
  if (NodeFile === null || globalThis.File === NodeFile) return fn();
  const previous = globalThis.File;
  globalThis.File = NodeFile;
  try {
    return await fn();
  } finally {
    globalThis.File = previous;
  }
}

/**
 * Creates a backend over `storage` and stubs global `fetch` to dispatch into it. Exported for tests
 * that need the backend without rendering (e.g. plain `api()` calls or hooks via `renderHook`).
 */
export async function stubFetchWithStaticBackend(
  options: Pick<RenderWithStaticBackendOptions, 'storage' | 'seed' | 'version' | 'now' | 'newId'> = {},
): Promise<{ backend: StaticBackend; ctx: StaticContext; storage: StaticStorage; requests: StaticRequestLog[]; close(): void }> {
  const storage = options.storage ?? new MemoryStorage();
  const backend = await createStaticBackend({
    storage,
    channel: null,
    activate: true,
    version: options.version ?? '0.0.0-test',
    now: options.now ?? (() => 1_700_000_000_000),
    newId: options.newId ?? sequentialIds(),
  });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    backend.close();
  };
  try {
    onTestFinished(close);
  } catch {
    // Called outside a test (e.g. from a hook): the caller closes it.
  }
  await options.seed?.(backend.ctx);

  const requests: StaticRequestLog[] = [];
  const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // api() always passes a path string; Request/URL inputs are accepted for completeness.
    const target = input instanceof Request ? input.url : String(input);
    const url = new URL(target, window.location.origin);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const path = `${url.pathname}${url.search}`;
    let res: Response;
    if (init?.body instanceof FormData) {
      const { body, contentType } = await multipartBody(init.body);
      const headers = new Headers(init.headers);
      headers.set('content-type', contentType);
      res = await withNodeFile(() => backend.fetch(path, { ...init, method, body, headers }));
    } else {
      res = await backend.fetch(path, { ...init, method });
    }
    requests.push({ method, path: url.pathname, search: url.search, status: res.status });
    return res;
  });
  vi.stubGlobal('fetch', fetchStub);
  return { backend, ctx: backend.ctx, storage, requests, close };
}

export async function renderWithStaticBackend(ui: ReactElement, options: RenderWithStaticBackendOptions = {}): Promise<RenderWithStaticBackendResult> {
  const { route, toaster = true } = options;
  if (route !== undefined) window.history.replaceState(null, '', `/${route}`);

  // The stub must be in place before the first render: queries start in the mount effects.
  const { backend, ctx, storage, requests, close } = await stubFetchWithStaticBackend(options);
  const queryClient = options.queryClient ?? createTestQueryClient();
  // Same providers as render.tsx; a wrapper (not a wrapping element) so `rerender(ui)` keeps them.
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      {children}
      {toaster ? <Toaster /> : null}
    </QueryClientProvider>
  );
  const result = render(ui, { wrapper });
  const requestsTo = (key: string) => requests.filter((r) => `${r.method} ${r.path}` === key);
  return { ...result, backend, ctx, storage, queryClient, requests, requestsTo, close };
}
