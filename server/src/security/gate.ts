/**
 * Global request gate (§4.2), mounted with `app.use('*', gate)`. Steps, in order:
 *
 * 1. 400 if the *raw* request path (as received on the socket, before URL normalization)
 *    contains `//`, `\`, `%2f`, `%5c` (any case), dot segments (incl. `%2e` forms) or control bytes.
 * 2. 403 unless the Host header is in the allowlist derived from config.
 * 3. `/api/*` routes are non-exempt unless declared with `exempt(kind)` (lib/routes.ts); the
 *    declaration is matched with a Hono router instance.
 *    Pages site (hybrid mode, only with `HOMEBASE_PAGES_URL` and a pairing store): an `/api`
 *    request whose `Origin` is exactly the configured Pages origin takes its own branch instead
 *    of step 4. Preflights are answered here (never passed on); every other request needs a
 *    route declared `paired()` (else 403 `local_only`), `X-Homebase: 1`, a cross-site/same-site/
 *    absent `Sec-Fetch-Site`, a pairing token made for that origin (else 401 `pairing_required`)
 *    and the Content-Type of step 4. Health passes as for anyone. These responses carry CORS
 *    headers for that origin only (security/headers.ts), refusals included.
 * 4. Non-exempt `/api` requests need `X-Homebase: 1`, an absent-or-allowed `Origin`, an
 *    absent-or-`same-origin` `Sec-Fetch-Site`, and for bodies `Content-Type: application/json`
 *    (`multipart/form-data` for routes declared with `multipart(kind)`). `image` routes accept
 *    `Sec-Fetch-Site` same-origin/none/absent; `health` and `oauth-callback` skip step 4.
 * 5. Body limits on streamed bytes (chunked included): JSON 1 MB, uploads 10 MB, imports 25 MB.
 *
 * Apart from the Pages site, the server never sends CORS headers and never answers preflights
 * (an OPTIONS request to the API has no `X-Homebase` header and is refused).
 *
 * Diagnostics (§17): every refusal logs `info 'request refused by gate' {method, path, status,
 * reason, origin?, secFetchSite?}` with a machine `reason` (repeat-collapsed per reason and origin);
 * a refused pairing token says why (`token_missing`, `token_malformed`, `token_unknown`,
 * `token_revoked {pairingId, removedBy}`, `token_origin_mismatch {pairingId}`), never the token.
 * `/api` requests (health included) from a web origin that is neither allowed nor the configured
 * Pages origin are noted in `foreignOrigins`: named and warned about when worth naming (GitHub
 * Pages, loopback, the Pages site's domain: a missing or wrong `HOMEBASE_PAGES_URL`), else only
 * counted. Origins are logged only when they are ours, the Pages site's or such named ones; a
 * browser extension's origin is logged as its scheme only (`chrome-extension:`), never its id.
 */
import type { Context, MiddlewareHandler } from 'hono';
import { ERROR_STATUS, PAIRING_TOKEN_HEADER, type ErrorCode } from '@homebase/shared';
import type { Config } from '../config.ts';
import type { AppEnv, PagesPreflight } from '../context.ts';
import { PayloadTooLargeError, errorResponse } from '../lib/errors.ts';
import { withLogContext } from '../lib/log-context.ts';
import { pathForLog, type LogFields, type Logger } from '../lib/logger.ts';
import { BODY_LIMITS, type RouteMeta, type RouteTable } from '../lib/routes.ts';
import { foreignOrigins as defaultForeignOrigins, isNamedForeignOrigin, webOrigin, type ForeignOriginTracker } from './foreign-origins.ts';
import type { PairingRecord, PairingStore } from './pairing.ts';

export interface GateOptions {
  /** `pagesOrigin` is optional so test beds without hybrid mode can pass a plain config. */
  config: Pick<Config, 'allowedHosts' | 'allowedOrigins'> & Partial<Pick<Config, 'pagesOrigin'>>;
  routes: RouteTable;
  log?: Logger;
  /**
   * Verifies Pages tokens. Without it (or without `config.pagesOrigin`) hybrid mode is off. With
   * `explain`, refusals say why a token failed (removed on this PC vs never issued).
   */
  pairing?: Pick<PairingStore, 'verify' | 'touch'> & Partial<Pick<PairingStore, 'explain'>>;
  /** Where foreign web origins are noted (default: the process-wide tracker the diagnostics summary reads). */
  foreignOrigins?: ForeignOriginTracker;
}

/** Machine reasons of gate refusals (the log line's `reason`; the answer keeps its readable message). */
export type GateRefusal =
  | 'bad_path'
  | 'host_not_allowed'
  | 'preflight_refused'
  | 'local_only'
  | 'x_homebase_missing'
  | 'cross_site'
  | 'token_missing'
  | 'token_malformed'
  | 'token_unknown'
  | 'token_revoked'
  | 'token_origin_mismatch'
  | 'content_type'
  | 'origin_not_allowed'
  | 'bad_content_length'
  | 'too_large';

/** Methods a Pages preflight may ask for. */
export const PAGES_ALLOWED_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
/** Request headers a Pages preflight may ask for (lower-case). */
export const PAGES_ALLOWED_HEADERS: ReadonlySet<string> = new Set(['content-type', 'x-homebase', PAIRING_TOKEN_HEADER.toLowerCase()]);
/** `Sec-Fetch-Site` values a Pages request may carry (absent is fine too). Loopback dev origins are same-site. */
const PAGES_FETCH_SITES: ReadonlySet<string> = new Set(['cross-site', 'same-site']);

// ---------------------------------------------------------------------------
// Step 1 — raw path checks
// ---------------------------------------------------------------------------

/** The request target exactly as received (Node's `incoming.url`), falling back to the parsed URL. */
export function rawRequestTarget(c: Context<AppEnv>): string {
  const incoming = (c.env as AppEnv['Bindings'] | undefined)?.incoming;
  if (incoming && typeof incoming.url === 'string') return incoming.url;
  const url = new URL(c.req.url);
  return url.pathname + url.search;
}

/** Path part of a raw request target (origin-form or absolute-form), without query/fragment. */
export function rawPathOf(target: string): string {
  let rest = target;
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(rest);
  if (scheme) {
    rest = rest.slice(scheme[0].length);
    const slash = rest.search(/[/?#]/);
    rest = slash === -1 ? '/' : rest.slice(slash);
    if (!rest.startsWith('/')) rest = `/${rest}`;
  }
  const cut = rest.search(/[?#]/);
  return cut === -1 ? rest : rest.slice(0, cut);
}

const ENCODED_DOT = /%2e/gi;

/** Reason the raw path is refused, or null when it is acceptable. */
export function rawPathProblem(rawPath: string): string | null {
  if (!rawPath.startsWith('/')) return 'path must start with /';
  if (rawPath.includes('//')) return 'empty path segment';
  if (rawPath.includes('\\')) return 'backslash in path';
  if (/%2f|%5c/i.test(rawPath)) return 'encoded slash in path';
  if (/%00|[\u0000-\u001f\u007f]/i.test(rawPath)) return 'control character in path';
  for (const segment of rawPath.split('/')) {
    const decoded = segment.replace(ENCODED_DOT, '.');
    if (decoded === '.' || decoded === '..') return 'dot segment in path';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Header helpers
// ---------------------------------------------------------------------------

export function isApiPath(path: string): boolean {
  return path === '/api' || path.startsWith('/api/');
}

/** Media type of a Content-Type header, lower-cased, without parameters. */
export function mediaType(contentType: string | undefined): string | null {
  if (!contentType) return null;
  const type = contentType.split(';', 1)[0]?.trim().toLowerCase();
  return type ? type : null;
}

function declaredLength(c: Context): number | null | 'invalid' {
  const raw = c.req.header('content-length');
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return 'invalid';
  return Number(trimmed);
}

function hasRequestBody(c: Context): boolean {
  if (c.req.header('transfer-encoding') !== undefined) return true;
  const len = declaredLength(c);
  return len === 'invalid' || (typeof len === 'number' && len > 0);
}

/** Wraps the request body so that more than `limit` streamed bytes error with PayloadTooLargeError. */
export function limitRequestBody(request: Request, limit: number): Request {
  const body = request.body;
  if (!body) return request;
  let seen = 0;
  const counted = body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > limit) {
          controller.error(new PayloadTooLargeError(limit));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
  return new Request(request, { body: counted, duplex: 'half' } as RequestInit);
}

// ---------------------------------------------------------------------------
// Pages site (hybrid mode)
// ---------------------------------------------------------------------------

/**
 * A Pages preflight's answer, or null when it asks for a method or header the API never needs.
 * `Access-Control-Request-Headers` entries are compared case-insensitively.
 */
export function pagesPreflight(c: Context): PagesPreflight | null {
  const method = c.req.header('access-control-request-method')?.trim() ?? '';
  if (!PAGES_ALLOWED_METHODS.has(method)) return null;
  const requested = (c.req.header('access-control-request-headers') ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h !== '');
  if (requested.some((h) => !PAGES_ALLOWED_HEADERS.has(h))) return null;
  const privateNetwork = c.req.header('access-control-request-private-network')?.trim().toLowerCase() === 'true';
  return { method, privateNetwork };
}

/** Why the Content-Type of a request is refused (§4.2 step 4), or null when it is acceptable. */
function contentTypeProblem(c: Context, method: string, meta: RouteMeta): string | null {
  if (method === 'GET' || method === 'HEAD') return null;
  const type = mediaType(c.req.header('content-type'));
  if (!hasRequestBody(c) && type === null) return null;
  const expected = meta.body === 'upload' || meta.body === 'import' ? 'multipart/form-data' : 'application/json';
  return type === expected ? null : `Content-Type must be ${expected}`;
}

// ---------------------------------------------------------------------------
// Diagnostics helpers
// ---------------------------------------------------------------------------

/** A browser extension's origin; only the scheme is logged (the id says which extensions are installed). */
const EXTENSION_ORIGIN = /^(chrome-extension|moz-extension|safari-web-extension):\/\/[a-z0-9.-]{1,64}$/i;
const FETCH_SITE_VALUE = /^[a-z-]{1,16}$/;

/** A Pages request's token: its pairing, or the refusal reason and the fields to log with it. */
type TokenVerdict = { record: PairingRecord } | { reason: GateRefusal; fields: LogFields };

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export function createGate(options: GateOptions): MiddlewareHandler<AppEnv> {
  const { config, routes, log, pairing } = options;
  const tracker = options.foreignOrigins ?? defaultForeignOrigins;
  const pagesOrigin = pairing ? (config.pagesOrigin ?? null) : null;
  // The configured Pages site, hybrid mode on or not: foreign-origin checks compare with it.
  const configuredPages = config.pagesOrigin ?? null;

  /**
   * The request's Origin when it may be logged: ours, the Pages site's, or a foreign one worth
   * naming — never a third-party site the user happened to visit (§3, Never logged). A browser extension is
   * logged by its scheme only (`chrome-extension:`), never by its id.
   */
  const loggableOrigin = (raw: string | undefined): string | undefined => {
    if (raw === undefined) return undefined;
    if (raw === configuredPages || config.allowedOrigins.has(raw)) return raw;
    const extension = EXTENSION_ORIGIN.exec(raw);
    if (extension) return `${(extension[1] ?? 'extension').toLowerCase()}:`;
    const web = webOrigin(raw);
    return web !== null && isNamedForeignOrigin(web, configuredPages) ? web : undefined;
  };

  const refuse = (c: Context<AppEnv>, code: ErrorCode, message: string, reason: GateRefusal, extra: LogFields = {}): Response => {
    const origin = loggableOrigin(c.req.header('origin'));
    const site = c.req.header('sec-fetch-site')?.trim().toLowerCase();
    log?.info('request refused by gate', {
      method: c.req.method,
      path: pathForLog(c.req.path),
      status: ERROR_STATUS[code],
      reason,
      origin,
      secFetchSite: site !== undefined && FETCH_SITE_VALUE.test(site) ? site : undefined,
      ...extra,
      repeatKey: `gate ${reason} ${origin ?? ''}`,
    });
    return errorResponse(c, code, message);
  };

  /**
   * Notes an `/api` request from a web origin that is neither ours nor the configured Pages site:
   * one worth naming is kept and warned about (repeat-collapsed per origin), any other only counted.
   */
  const noteForeignOrigin = (c: Context<AppEnv>, raw: string, meta: RouteMeta): void => {
    const origin = webOrigin(raw);
    if (origin === null) return;
    const named = isNamedForeignOrigin(origin, configuredPages);
    tracker.note(origin, { named });
    if (!named) {
      log?.debug('request from another site', { method: c.req.method, path: pathForLog(c.req.path) });
      return;
    }
    const message =
      meta.exempt === 'health' ? 'health check from another site (no CORS answer)' : 'request from a site that is not the configured Pages site';
    log?.warn(message, { origin, pagesOrigin: configuredPages, repeatKey: `foreign origin ${origin}` });
  };

  /** A Pages request's token → its pairing, or why it is refused (the token itself is never logged). */
  const checkToken = (token: string | undefined): TokenVerdict => {
    if (token === undefined || token === '') return { reason: 'token_missing', fields: {} };
    if (!pairing) return { reason: 'token_unknown', fields: {} };
    let record: PairingRecord | null;
    if (pairing.explain) {
      const check = pairing.explain(token);
      if (check.status === 'malformed') return { reason: 'token_malformed', fields: {} };
      if (check.status === 'unknown') return { reason: 'token_unknown', fields: {} };
      if (check.status === 'removed') return { reason: 'token_revoked', fields: { pairingId: check.pairingId, removedBy: check.removedBy } };
      record = check.record;
    } else {
      record = pairing.verify(token);
      if (!record) return { reason: 'token_unknown', fields: {} };
    }
    // The exact Origin match is the real check; the token says this browser was paired for it.
    if (record.origin !== pagesOrigin) return { reason: 'token_origin_mismatch', fields: { pairingId: record.id } };
    return { record };
  };

  /**
   * The Pages branch: a refusal or the preflight answer, or null when the request goes on to the
   * body limits and its route.
   */
  const checkPagesRequest = (c: Context<AppEnv>, method: string, meta: RouteMeta): Response | null => {
    if (method === 'OPTIONS' && c.req.header('access-control-request-method') !== undefined) {
      const preflight = pagesPreflight(c);
      if (!preflight) return refuse(c, 'forbidden', 'Preflight asks for a method or header the API does not accept', 'preflight_refused');
      c.set('pagesPreflight', preflight);
      return c.body(null, 204);
    }
    if (meta.exempt === 'health') return null;

    if (meta.access !== 'paired') return refuse(c, 'local_only', "Only Homebase's own page on this PC can use this", 'local_only');
    if (c.req.header('x-homebase') !== '1') return refuse(c, 'forbidden', 'Missing X-Homebase header', 'x_homebase_missing');
    const site = c.req.header('sec-fetch-site')?.trim().toLowerCase();
    if (site !== undefined && !PAGES_FETCH_SITES.has(site)) return refuse(c, 'forbidden', 'Unexpected Sec-Fetch-Site', 'cross_site');

    const verdict = checkToken(c.req.header(PAIRING_TOKEN_HEADER));
    if (!('record' in verdict)) {
      return refuse(c, 'pairing_required', 'This browser is not paired with Homebase on this PC', verdict.reason, verdict.fields);
    }
    const { record } = verdict;

    const typeProblem = contentTypeProblem(c, method, meta);
    if (typeProblem) return refuse(c, 'bad_request', typeProblem, 'content_type', { pairingId: record.id });

    c.set('pairingId', record.id);
    pairing?.touch(record.id);
    return null;
  };

  return async function gate(c, next) {
    // 1. Raw path normalization tricks.
    const problem = rawPathProblem(rawPathOf(rawRequestTarget(c)));
    if (problem) return refuse(c, 'bad_request', `Malformed request path (${problem})`, 'bad_path');

    // 2. Host allowlist (DNS rebinding).
    const host = c.req.header('host')?.trim().toLowerCase();
    if (!host || !config.allowedHosts.has(host)) return refuse(c, 'forbidden', 'Host not allowed', 'host_not_allowed');

    const path = c.req.path;
    const method = c.req.method.toUpperCase();
    const api = isApiPath(path);
    const meta: RouteMeta = api ? routes.match(method, path) : {};
    const origin = c.req.header('origin');

    // A web page elsewhere calling the API: how a missing or wrong HOMEBASE_PAGES_URL shows up.
    if (api && origin !== undefined && origin !== configuredPages && !config.allowedOrigins.has(origin)) {
      noteForeignOrigin(c, origin, meta);
    }

    if (api && pagesOrigin !== null && origin === pagesOrigin) {
      // 3/4 for the Pages site. Set before any refusal so the page can read why.
      c.set('pagesCors', true);
      const answer = checkPagesRequest(c, method, meta);
      if (answer) return answer;
    } else if (api && meta.exempt !== 'health' && meta.exempt !== 'oauth-callback') {
      // 3/4. Header checks for /api.
      if (origin !== undefined && !config.allowedOrigins.has(origin)) return refuse(c, 'forbidden', 'Origin not allowed', 'origin_not_allowed');

      const site = c.req.header('sec-fetch-site')?.trim().toLowerCase();
      if (meta.exempt === 'image') {
        if (site !== undefined && site !== 'same-origin' && site !== 'none') {
          return refuse(c, 'forbidden', 'Cross-site request refused', 'cross_site');
        }
      } else {
        if (c.req.header('x-homebase') !== '1') return refuse(c, 'forbidden', 'Missing X-Homebase header', 'x_homebase_missing');
        if (site !== undefined && site !== 'same-origin') return refuse(c, 'forbidden', 'Cross-site request refused', 'cross_site');
        const typeProblem = contentTypeProblem(c, method, meta);
        if (typeProblem) return refuse(c, 'bad_request', typeProblem, 'content_type');
      }
    }

    // 5. Body limits (streamed bytes; Content-Length is only used to fail fast).
    const limit = BODY_LIMITS[meta.body ?? 'json'];
    const length = declaredLength(c);
    if (length === 'invalid') return refuse(c, 'bad_request', 'Invalid Content-Length', 'bad_content_length');
    if (typeof length === 'number' && length > limit) {
      return refuse(c, 'payload_too_large', `Request body exceeds ${limit} bytes`, 'too_large', { limit });
    }
    if (c.req.raw.body) c.req.raw = limitRequestBody(c.req.raw, limit);

    c.set('routeMeta', meta);
    // What the route logs for a paired Pages browser carries its pairing.
    const pairingId = c.get('pairingId');
    return pairingId === undefined ? next() : withLogContext({ pairingId }, next);
  };
}
