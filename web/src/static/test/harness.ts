/**
 * Test harness for static-backend handler modules (vitest project `static`, node environment):
 * an isolated in-memory backend with only the given modules registered, deterministic ids and
 * clock, and helpers that call routes the way `web/src/api/client.ts` does.
 */
import { AssetRegistry } from '../assets.ts';
import { dispatch } from '../backend.ts';
import type { StaticContext } from '../context.ts';
import type { HandlerModule } from '../handlers/index.ts';
import { StaticRouter } from '../router.ts';
import { StaticState } from '../state.ts';
import { MemoryStorage } from '../storage/memory.ts';
import type { StaticStorage } from '../storage/types.ts';

export interface TestBackend {
  ctx: StaticContext;
  router: StaticRouter;
  storage: StaticStorage;
  /** Raw dispatch, like `staticFetch`. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** JSON request helper: sets the headers the API client sets; `body` is JSON-encoded unless FormData. */
  call(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Response>;
  /** `call` + parsed JSON body (or undefined for 204). */
  json<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }>;
  /** Deterministic clock: advance by `ms`. */
  tick(ms: number): void;
  /** Object URLs handed out by the asset registry, for assertions. */
  objectUrls: string[];
  close(): void;
}

export interface TestBackendOptions {
  storage?: StaticStorage;
  version?: string;
  startAt?: number;
  appUrl?: string;
}

export async function createTestBackend(modules: readonly HandlerModule[], options: TestBackendOptions = {}): Promise<TestBackend> {
  const storage = options.storage ?? new MemoryStorage();
  const state = new StaticState(storage, { channel: null, instanceId: 'test' });
  const objectUrls: string[] = [];
  const assets = new AssetRegistry({
    createObjectUrl: (blob) => {
      const url = `blob:test/${objectUrls.length}-${blob.size}`;
      objectUrls.push(url);
      return url;
    },
    revokeObjectUrl: () => {},
  });
  let now = options.startAt ?? 1_700_000_000_000;
  let counter = 0;
  const ctx: StaticContext = {
    state,
    assets,
    version: options.version ?? '0.0.0-test',
    now: () => now,
    // Valid UUIDv4 shape, deterministic: 00000000-0000-4000-8000-0000000000NN.
    newId: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`,
    appUrl: options.appUrl ?? 'http://localhost:5173/',
  };
  await state.loadAll();
  const router = new StaticRouter();
  for (const module of modules) module.register(router);
  for (const module of modules) await module.ready?.(ctx);

  const fetch = (path: string, init?: RequestInit) => dispatch(router, ctx, path, init);
  const call: TestBackend['call'] = (method, path, body, headers = {}) => {
    const h = new Headers({ 'X-Portly': '1', Accept: 'application/json', ...headers });
    let payload: BodyInit | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      payload = JSON.stringify(body);
      h.set('Content-Type', 'application/json');
    }
    return fetch(path, { method, headers: h, body: payload });
  };
  return {
    ctx,
    router,
    storage,
    fetch,
    call,
    async json(method, path, body) {
      const res = await call(method, path, body);
      const text = res.status === 204 ? '' : await res.text();
      return { status: res.status, body: (text === '' ? undefined : JSON.parse(text)) as never };
    },
    tick: (ms) => {
      now += ms;
    },
    objectUrls,
    close: () => {
      state.close();
      assets.clear();
    },
  };
}

/** Builds a multipart body with one `file` part, like the API client's FormData uploads. */
export function fileForm(bytes: Uint8Array | string, name = 'image.png', type = 'image/png', field = 'file', extra: Record<string, string> = {}): FormData {
  const form = new FormData();
  const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  form.append(field, new File([copy], name, { type }));
  for (const [key, value] of Object.entries(extra)) form.append(key, value);
  return form;
}

/** Minimal valid images for upload tests (magic bytes only; sizes are what the sniffer needs). */
export const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 0x10, 0, 0, 0, 0x10, 8, 6, 0, 0, 0]);
export const GIF_BYTES = new TextEncoder().encode('GIF89a\u0010\u0000\u0010\u0000');
