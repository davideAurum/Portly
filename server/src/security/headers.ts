/**
 * Response headers (§4.3), applied to every response (including gate refusals, errors and 404s):
 * - all: nosniff, CORP same-origin, Referrer-Policy no-referrer, COOP same-origin;
 * - HTML: the strict CSP below (script-src never gains 'unsafe-inline'/'unsafe-eval'; connect-src
 *   adds the configured Pages origin);
 * - `/api` JSON: `Cache-Control: no-store`;
 * - image routes (`/api/icons/:id`, `/api/uploads/:id`): sandbox CSP and, for successful
 *   image responses, `Cache-Control: private, max-age=86400`.
 * Any `Access-Control-*` header a handler sets is removed. The only CORS headers ever sent are
 * for the configured Pages site (hybrid mode), on the answers the gate marked as Pages requests:
 * `Access-Control-Allow-Origin: <pagesOrigin>` (from config, never echoed from the request),
 * `Vary: Origin`, `Access-Control-Expose-Headers` (incl. `X-Request-Id`, which the request log
 * middleware in app.ts sets on every answer) and, for preflights, the allowed method and
 * headers, `Max-Age` and Private Network Access when asked. Never `Allow-Credentials` (the page
 * authenticates with its pairing token on this PC, or its device secret from another PC). With a
 * Pages site configured, every `/api` answer carries `Vary: Origin`.
 */
import type { MiddlewareHandler } from 'hono';
import { DEVICE_ENROLL_HEADER, DEVICE_TOKEN_HEADER, PAIRING_TOKEN_HEADER, REQUEST_ID_HEADER } from '@portly/shared';
import type { AppEnv } from '../context.ts';
import type { RouteTable } from '../lib/routes.ts';
import { isApiPath, mediaType } from './gate.ts';

/**
 * The HTML CSP. With a Pages site configured, `connect-src` also allows its origin: Portly's own
 * page checks that the Pages site is reachable before it forwards there (web `app/pagesForward.ts`).
 */
export function htmlCsp(pagesOrigin: string | null = null): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://a.espncdn.com",
    pagesOrigin === null ? "connect-src 'self'" : `connect-src 'self' ${pagesOrigin}`,
    "font-src 'self' data:",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export const HTML_CSP = htmlCsp();

export const IMAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
export const IMAGE_CACHE_CONTROL = 'private, max-age=86400';

export const BASE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
});

/** Headers the Pages site may read on API answers (`X-Request-Id`: its diagnostics name the server's log lines). */
export const PAGES_EXPOSE_HEADERS = `Retry-After, Content-Disposition, ${REQUEST_ID_HEADER}`;
/** Request headers a Pages preflight is allowed (the gate refuses any other). */
export const PAGES_ALLOW_HEADERS = `Content-Type, X-Portly, ${PAIRING_TOKEN_HEADER}, ${DEVICE_TOKEN_HEADER}, ${DEVICE_ENROLL_HEADER}`;
/** Seconds a browser may cache a Pages preflight answer. */
export const PAGES_PREFLIGHT_MAX_AGE = '600';

export interface SecurityHeadersOptions {
  routes: RouteTable;
  /** The configured Pages origin (hybrid mode); absent or null: no CORS header is ever sent. */
  pagesOrigin?: string | null;
}

function mutableHeaders(res: Response): { res: Response; headers: Headers } {
  try {
    // Throws for immutable headers (e.g. a Response returned by fetch()).
    res.headers.set('X-Content-Type-Options', 'nosniff');
    return { res, headers: res.headers };
  } catch {
    const copy = new Response(res.body, res);
    return { res: copy, headers: copy.headers };
  }
}

/** Adds `names` to the `Vary` header (case-insensitive, no duplicates). */
export function appendVary(headers: Headers, ...names: string[]): void {
  const current = (headers.get('vary') ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v !== '');
  const seen = new Set(current.map((v) => v.toLowerCase()));
  for (const name of names) {
    if (!seen.has(name.toLowerCase())) {
      current.push(name);
      seen.add(name.toLowerCase());
    }
  }
  headers.set('Vary', current.join(', '));
}

export function createSecurityHeaders(options: SecurityHeadersOptions): MiddlewareHandler<AppEnv> {
  const { routes } = options;
  const pagesOrigin = options.pagesOrigin ?? null;
  const pageCsp = htmlCsp(pagesOrigin);
  return async function securityHeaders(c, next) {
    await next();

    const { res, headers } = mutableHeaders(c.res);
    for (const [name, value] of Object.entries(BASE_HEADERS)) headers.set(name, value);
    for (const name of [...headers.keys()]) {
      if (name.toLowerCase().startsWith('access-control-')) headers.delete(name);
    }

    const type = mediaType(headers.get('content-type') ?? undefined);
    const path = c.req.path;
    const api = isApiPath(path);
    const meta = api ? (c.get('routeMeta') ?? routes.match(c.req.method, path)) : {};

    if (type === 'text/html') {
      headers.set('Content-Security-Policy', pageCsp);
    }
    if (meta.exempt === 'image') {
      headers.set('Content-Security-Policy', IMAGE_CSP);
      if (res.status === 200 && type !== 'application/json') headers.set('Cache-Control', IMAGE_CACHE_CONTROL);
      else headers.set('Cache-Control', 'no-store');
    } else if (api && (type === 'application/json' || type === null)) {
      headers.set('Cache-Control', 'no-store');
    }

    // Pages site (hybrid mode), after the strip loop above.
    if (api && pagesOrigin !== null) appendVary(headers, 'Origin');
    if (pagesOrigin !== null && c.get('pagesCors') === true) {
      headers.set('Access-Control-Allow-Origin', pagesOrigin);
      headers.set('Access-Control-Expose-Headers', PAGES_EXPOSE_HEADERS);
      const preflight = c.get('pagesPreflight');
      if (preflight) {
        headers.set('Access-Control-Allow-Methods', preflight.method);
        headers.set('Access-Control-Allow-Headers', PAGES_ALLOW_HEADERS);
        headers.set('Access-Control-Max-Age', PAGES_PREFLIGHT_MAX_AGE);
        appendVary(headers, 'Origin', 'Access-Control-Request-Method', 'Access-Control-Request-Headers');
        if (preflight.privateNetwork) headers.set('Access-Control-Allow-Private-Network', 'true');
      }
    }

    if (res !== c.res) c.res = res;
  };
}
