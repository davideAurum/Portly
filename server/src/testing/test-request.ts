/**
 * `testRequest(app, method, path, {body?, headers?})` (§13): sends a request through the full app
 * (gate included) the way the SPA would — `Host: localhost:5757`, `X-Portly: 1`,
 * `Sec-Fetch-Site: same-origin` and, for bodies, `Content-Type: application/json`.
 *
 * - `headers` override the defaults; a `null` value removes a default header.
 * - Plain-object/array bodies are JSON-encoded; strings, bytes, FormData and streams are sent as-is.
 * - `path` is also handed to the app as the raw request target (like Node's `incoming.url`), so
 *   path-normalization tricks reach the gate exactly as written.
 * - `pagesHeaders(token)` turns a request into one from the paired Pages site (hybrid mode; the
 *   context needs `env: TEST_PAGES_ENV`).
 * - `remoteHeaders(secret)` turns a request into one from another PC through the reverse proxy
 *   (the remote Host and, unless `secret` is null, the device cookie; the context needs
 *   `env: TEST_REMOTE_ENV`). Such a request arrives on the remote port (`TEST_REMOTE_PORT`, like
 *   the proxy forwards it); `listenerPort` overrides which port any request came in on.
 */
import { DEVICE_COOKIE, PAIRING_TOKEN_HEADER } from '@portly/shared';
import { TEST_PORT } from './test-context.ts';

export { TEST_PORT };

/** Any Hono app (whatever its Env type). */
export interface RequestableApp {
  request(input: string, init?: RequestInit, env?: never): Response | Promise<Response>;
}

type RequestBody = NonNullable<RequestInit['body']>;

export interface TestRequestOptions {
  body?: unknown;
  headers?: Record<string, string | null>;
  /** The local port the request came in on (default: the remote port for the remote Host, else the main port). */
  listenerPort?: number;
}

export const DEFAULT_TEST_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  Host: `localhost:${TEST_PORT}`,
  'X-Portly': '1',
  'Sec-Fetch-Site': 'same-origin',
});

/** Pages site of the hybrid-mode tests. */
export const TEST_PAGES_URL = 'https://pages.example/portly/';
export const TEST_PAGES_ORIGIN = 'https://pages.example';
/** Environment that configures {@link TEST_PAGES_URL} (pass as `createTestContext({env})`). */
export const TEST_PAGES_ENV: Readonly<Record<string, string>> = Object.freeze({ PORTLY_PAGES_URL: TEST_PAGES_URL });

/**
 * Headers of a request from the Pages site the way its fetches look: its Origin, cross-site and,
 * unless `token` is null, the pairing token. `extra` overrides any of them.
 */
export function pagesHeaders(token: string | null, extra: Record<string, string | null> = {}): Record<string, string | null> {
  return { Origin: TEST_PAGES_ORIGIN, 'Sec-Fetch-Site': 'cross-site', [PAIRING_TOKEN_HEADER]: token, ...extra };
}

/** The remote origin (other PCs) of the device tests, its Host header and the loopback port the proxy forwards to. */
export const TEST_REMOTE_ORIGIN = 'https://pc.tailnet.example';
export const TEST_REMOTE_HOST = 'pc.tailnet.example';
export const TEST_REMOTE_PORT = TEST_PORT + 1;
/** Environment that configures {@link TEST_REMOTE_ORIGIN} (pass as `createTestContext({env})`). */
export const TEST_REMOTE_ENV: Readonly<Record<string, string>> = Object.freeze({ PORTLY_REMOTE_ORIGIN: TEST_REMOTE_ORIGIN });

/**
 * Headers of a request from another PC the way its page's fetches arrive through the proxy: the
 * remote Host, same-origin fetch metadata (the defaults) and, unless `secret` is null, the device
 * cookie. `extra` overrides any of them.
 */
export function remoteHeaders(secret: string | null, extra: Record<string, string | null> = {}): Record<string, string | null> {
  return { Host: TEST_REMOTE_HOST, Cookie: secret === null ? null : `${DEVICE_COOKIE}=${secret}`, ...extra };
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
  // The URL's host is fixed; the gate reads the Host *header*, like in production, and the
  // listener port from the socket: the remote Host arrives on the remote port unless told otherwise.
  const url = `http://localhost:${TEST_PORT}${path.startsWith('/') ? path : `/${path}`}`;
  const localPort = options.listenerPort ?? (headers.get('host')?.trim().toLowerCase() === TEST_REMOTE_HOST ? TEST_REMOTE_PORT : TEST_PORT);
  const env = { incoming: { url: path, headers: {}, socket: { localPort } } };
  return app.request(url, init, env as never);
}

/** Convenience: parsed JSON body (throws if the response is not JSON). */
export async function jsonOf<T = unknown>(res: Response): Promise<T> {
  return (await res.json()) as T;
}
