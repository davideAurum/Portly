/**
 * Fake transport for tests (§13): `createFakeFetch([{match, method?, respond}])` returns a
 * `fetch`-compatible function to pass as `createSafeFetch({fetchImpl})` (createTestContext does
 * this). Routes are tried in order; `match` is a substring of, or RegExp tested against, the full
 * URL. An unmatched request throws AND fails the current test (so it cannot be masked by the
 * caller's error handling). No live network is ever touched.
 */
import { onTestFinished } from 'vitest';

export interface FakeResponseSpec {
  status?: number;
  json?: unknown;
  text?: string;
  body?: Uint8Array | string;
  headers?: Record<string, string>;
}

export interface FakeRequest {
  url: string;
  method: string;
  headers: Headers;
  body: string | null;
}

export interface FakeFetchRoute {
  match: string | RegExp;
  method?: string;
  respond: FakeResponseSpec | ((req: FakeRequest) => FakeResponseSpec | Promise<FakeResponseSpec>);
  /** Respond only this many times (default unlimited). */
  times?: number;
}

export interface FakeFetch {
  (input: string | URL | Request, init?: RequestInit): Promise<Response>;
  /** Every request received, in order. */
  readonly calls: FakeRequest[];
  /** Requests that matched no route. */
  readonly unmatched: FakeRequest[];
  /** Adds routes (tried after the existing ones). */
  add(...routes: FakeFetchRoute[]): void;
  reset(): void;
}

function matches(route: FakeFetchRoute, req: FakeRequest): boolean {
  if (route.method && route.method.toUpperCase() !== req.method) return false;
  return typeof route.match === 'string' ? req.url.includes(route.match) : route.match.test(req.url);
}

async function bodyText(body: RequestInit['body'] | null | undefined): Promise<string | null> {
  if (body === null || body === undefined) return null;
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof Uint8Array) return Buffer.from(body).toString('utf8');
  return new Response(body).text();
}

function toResponse(spec: FakeResponseSpec): Response {
  const headers = new Headers(spec.headers);
  let payload: ConstructorParameters<typeof Response>[0] = null;
  if (spec.json !== undefined) {
    payload = JSON.stringify(spec.json);
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  } else if (spec.text !== undefined) {
    payload = spec.text;
    if (!headers.has('content-type')) headers.set('content-type', 'text/plain; charset=utf-8');
  } else if (spec.body !== undefined) {
    payload = typeof spec.body === 'string' ? spec.body : new Uint8Array(spec.body);
  }
  const status = spec.status ?? 200;
  const nullBody = status === 204 || status === 205 || status === 304;
  return new Response(nullBody ? null : payload, { status, headers });
}

export function createFakeFetch(initialRoutes: FakeFetchRoute[] = []): FakeFetch {
  const routes: { route: FakeFetchRoute; used: number }[] = initialRoutes.map((route) => ({ route, used: 0 }));
  const calls: FakeRequest[] = [];
  const unmatched: FakeRequest[] = [];
  let hookRegistered = false;

  const registerHook = (): void => {
    if (hookRegistered) return;
    try {
      onTestFinished(() => {
        if (unmatched.length > 0) {
          const list = unmatched.map((r) => `${r.method} ${r.url}`).join(', ');
          throw new Error(`fake-fetch: unmatched request(s): ${list}`);
        }
      });
      hookRegistered = true;
    } catch {
      // Not inside a running test: the thrown error below still surfaces the problem.
    }
  };

  const fake = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : null;
    const url = request ? request.url : String(input);
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers ?? request?.headers);
    const body = await bodyText(init?.body ?? (request ? await request.text() : null));
    const req: FakeRequest = { url, method, headers, body };
    calls.push(req);

    if (init?.signal?.aborted) throw init.signal.reason ?? new DOMException('Aborted', 'AbortError');

    const entry = routes.find((r) => matches(r.route, req) && (r.route.times === undefined || r.used < r.route.times));
    if (!entry) {
      unmatched.push(req);
      registerHook();
      throw new Error(`fake-fetch: no route for ${method} ${url}`);
    }
    entry.used++;
    const spec = typeof entry.route.respond === 'function' ? await entry.route.respond(req) : entry.route.respond;
    return toResponse(spec);
  }) as FakeFetch;

  Object.defineProperties(fake, {
    calls: { value: calls },
    unmatched: { value: unmatched },
    add: {
      value: (...more: FakeFetchRoute[]) => {
        for (const route of more) routes.push({ route, used: 0 });
      },
    },
    reset: {
      value: () => {
        calls.length = 0;
        unmatched.length = 0;
      },
    },
  });
  return fake;
}
