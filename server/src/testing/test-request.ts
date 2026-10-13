/**
 * `testRequest(app, method, path, {body?, headers?})` (§13): sends a request through the full app
 * (gate included) the way the SPA would — `Host: localhost:5757`, `X-Homebase: 1`,
 * `Sec-Fetch-Site: same-origin` and, for bodies, `Content-Type: application/json`.
 *
 * - `headers` override the defaults; a `null` value removes a default header.
 * - Plain-object/array bodies are JSON-encoded; strings, bytes, FormData and streams are sent as-is.
 * - `path` is also handed to the app as the raw request target (like Node's `incoming.url`), so
 *   path-normalization tricks reach the gate exactly as written.
 * - `pagesHeaders(token)` turns a request into one from the paired Pages site (hybrid mode; the
 *   context needs `env: TEST_PAGES_ENV`).
 */
import { PAIRING_TOKEN_HEADER } from '@homebase/shared';
import { TEST_PORT } from './test-context.ts';

/** Any Hono app (whatever its Env type). */
export interface RequestableApp {
  request(input: string, init?: RequestInit, env?: never): Response | Promise<Response>;
}

type RequestBody = NonNullable<RequestInit['body']>;

export interface TestRequestOptions {
  body?: unknown;
  headers?: Record<string, string | null>;
}

export const DEFAULT_TEST_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  Host: `localhost:${TEST_PORT}`,
  'X-Homebase': '1',
  'Sec-Fetch-Site': 'same-origin',
});

/** Pages site of the hybrid-mode tests. */
export const TEST_PAGES_URL = 'https://pages.example/homebase/';
export const TEST_PAGES_ORIGIN = 'https://pages.example';
/** Environment that configures {@link TEST_PAGES_URL} (pass as `createTestContext({env})`). */
export const TEST_PAGES_ENV: Readonly<Record<string, string>> = Object.freeze({ HOMEBASE_PAGES_URL: TEST_PAGES_URL });

/**
 * Headers of a request from the Pages site the way its fetches look: its Origin, cross-site and,
 * unless `token` is null, the pairing token. `extra` overrides any of them.
 */
export function pagesHeaders(token: string | null, extra: Record<string, string | null> = {}): Record<string, string | null> {
  return { Origin: TEST_PAGES_ORIGIN, 'Sec-Fetch-Site': 'cross-site', [PAIRING_TOKEN_HEADER]: token, ...extra };
}

function isRawBody(body: unknown): boolean {
  return (
    typeof body === 'string' ||
    body instanceof Uint8Array ||
    body instanceof FormData ||
    body instanceof ReadableStream ||
    body instanceof Blob ||
    body instanceof URLSearchParams
  );
}

export async function testRequest(
  app: RequestableApp,
  method: string,
  path: string,
  options: TestRequestOptions = {},
): Promise<Response> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(DEFAULT_TEST_HEADERS)) headers.set(name, value);

  let body: RequestBody | undefined;
  if (options.body !== undefined) {
    if (isRawBody(options.body)) {
      body = options.body as RequestBody;
    } else {
      body = JSON.stringify(options.body);
      headers.set('Content-Type', 'application/json');
    }
  }
  // Mirror real HTTP/1.1 framing headers (Request objects do not expose them).
  if (typeof body === 'string') headers.set('Content-Length', String(Buffer.byteLength(body)));
  else if (body instanceof Uint8Array) headers.set('Content-Length', String(body.byteLength));
  else if (body instanceof ReadableStream) headers.set('Transfer-Encoding', 'chunked');
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (value === null) headers.delete(name);
    else headers.set(name, value);
  }

  const init: RequestInit & { duplex?: 'half' } = { method: method.toUpperCase(), headers };
  if (body !== undefined) {
    init.body = body;
    if (body instanceof ReadableStream) init.duplex = 'half';
  }
  // The URL's host is fixed; the gate reads the Host *header*, like in production.
  const url = `http://localhost:${TEST_PORT}${path.startsWith('/') ? path : `/${path}`}`;
  const env = { incoming: { url: path, headers: {} } };
  return app.request(url, init, env as never);
}

/** Convenience: parsed JSON body (throws if the response is not JSON). */
export async function jsonOf<T = unknown>(res: Response): Promise<T> {
  return (await res.json()) as T;
}
