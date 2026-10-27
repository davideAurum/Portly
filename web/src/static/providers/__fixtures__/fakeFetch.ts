/**
 * A fake `fetch` for provider tests (the static counterpart of server/src/testing/fake-fetch.ts):
 * routes matched by URL substring / RegExp (first match wins, optional method and `times` budget),
 * every call recorded with its method, URL, headers and text body. Install it with
 * `vi.stubGlobal('fetch', fake.fetch)` — the handlers read `globalThis.fetch` at call time — or pass
 * it as the `fetch` option of a provider function.
 */
import type { FetchLike } from '../../lib/fetch.ts';

export interface FakeRequest {
  method: string;
  url: string;
  headers: Headers;
  body: string | null;
  /** The body's bytes (uploads of files and images). */
  bytes: Uint8Array | null;
  init: RequestInit;
}

export interface FakeResponseSpec {
  status?: number;
  headers?: Record<string, string>;
  json?: unknown;
  text?: string;
  /** A binary body (a downloaded file). */
  bytes?: Uint8Array;
}

export interface FakeFetchRoute {
  match: string | RegExp;
  method?: string;
  /** Answer, or a function building one per request (may be async). */
  respond: FakeResponseSpec | ((req: FakeRequest) => FakeResponseSpec | Promise<FakeResponseSpec>);
  /** Use this route at most this many times (then fall through to later routes). */
  times?: number;
}

export interface FakeFetch {
  fetch: FetchLike;
  calls: FakeRequest[];
  add(route: FakeFetchRoute): void;
}

function buildResponse(spec: FakeResponseSpec): Response {
  const headers = new Headers(spec.headers ?? {});
  let body: string | null = null;
  if (spec.json !== undefined) {
    body = JSON.stringify(spec.json);
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  } else if (spec.text !== undefined) {
    body = spec.text;
  }
  const status = spec.status ?? 200;
  if (spec.bytes !== undefined) return new Response(new Uint8Array(spec.bytes), { status, headers });
  return new Response(status === 204 || status === 205 || status === 304 ? null : body, { status, headers });
}

async function bodyBytes(init: RequestInit): Promise<Uint8Array | null> {
  const body = init.body;
  if (body === undefined || body === null) return null;
  return new Uint8Array(await new Response(body).arrayBuffer());
}

async function bodyText(init: RequestInit): Promise<string | null> {
  const body = init.body;
  if (body === undefined || body === null) return null;
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  return new Response(body).text();
}

export function createFakeFetch(routes: FakeFetchRoute[] = []): FakeFetch {
  const table = routes.map((route) => ({ ...route, remaining: route.times ?? Number.POSITIVE_INFINITY }));
  const calls: FakeRequest[] = [];
  const fetch: FetchLike = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init.method ?? 'GET').toUpperCase();
    const req: FakeRequest = { method, url, headers: new Headers(init.headers ?? {}), body: await bodyText(init), bytes: await bodyBytes(init), init };
    calls.push(req);
    if (init.signal?.aborted) throw init.signal.reason ?? new DOMException('aborted', 'AbortError');
    for (const route of table) {
      if (route.remaining <= 0) continue;
      if (route.method !== undefined && route.method.toUpperCase() !== method) continue;
      const hit = typeof route.match === 'string' ? url.includes(route.match) : route.match.test(url);
      if (!hit) continue;
      route.remaining -= 1;
      const spec = typeof route.respond === 'function' ? await route.respond(req) : route.respond;
      return buildResponse(spec);
    }
    throw new TypeError(`fetch failed: no fake route for ${method} ${url}`);
  };
  return {
    fetch,
    calls,
    add: (route) => {
      table.push({ ...route, remaining: route.times ?? Number.POSITIVE_INFINITY });
    },
  };
}

/** A transport that never answers but honours the signal (rejects with its reason), like fetch. */
export const hangingFetch: FetchLike = (_url, init) =>
  new Promise((_, reject) => {
    const signal = init?.signal;
    if (!signal) return;
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

/** A transport that fails like a network/CORS error. */
export const failingFetch: FetchLike = () => Promise.reject(new TypeError('Failed to fetch'));
