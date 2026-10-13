/**
 * The Hono application (§3, §4.2, §4.3, §6):
 *   request log → security headers → gate → modules → `/api` JSON 404 → static `web/dist`
 *   (hashed `/assets/*` immutable, `index.html` no-cache) → SPA fallback.
 *
 * The request log middleware (§17) is the outermost one: it gives every request an
 * id (`X-Request-Id` on every answer, also exposed to the Pages site), runs it inside
 * `withLogContext({rid, area})` (area = the module owning the path), registers it with
 * `ctx.runtime.inflight`, warns once when it is still running after 15 s, counts API answers for the
 * periodic status line, and logs one `request` line `{method, route, path, status, ms, code, from,
 * pairingId, aborted}` at a level from {@link requestLevel}. Health checks and the Diagnostics
 * page's own polling are "quiet": debug, kept out of the memory rings (below 500).
 */
import fs from 'node:fs';
import path from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { routePath } from 'hono/route';
import { REQUEST_ID_HEADER, type LogLevel } from '@portly/shared';
import type { AppContext, AppEnv } from './context.ts';
import { createErrorHandler, errorResponse } from './lib/errors.ts';
import { newRequestId, outsideLogContext, withLogContext, type LogContext } from './lib/log-context.ts';
import { pathForLog } from './lib/logger.ts';
import { RouteTable } from './lib/routes.ts';
import { MODULES, registerModules, type ModuleEntry, type ModuleStatus } from './modules/index.ts';
import { createGate, isApiPath } from './security/gate.ts';
import { createSecurityHeaders } from './security/headers.ts';

export const ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';
export const HTML_CACHE_CONTROL = 'no-cache';
/** An API request slower than this is logged at info at least. */
export const SLOW_REQUEST_MS = 3000;
/** A request still running after this long logs one warning. */
export const STILL_RUNNING_MS = 15_000;

export interface CreateAppOptions {
  /** Modules to register (default: all of {@link MODULES}). */
  modules?: readonly ModuleEntry[];
  /** Built SPA directory; `null` disables static serving. Default: `config.paths.webDist`. */
  webDist?: string | null;
}

/** API answers since the app was created (the periodic status line). */
export interface RequestCounts {
  count: number;
  s4xx: number;
  s5xx: number;
}

export interface PortlyApp {
  app: Hono<AppEnv>;
  routes: RouteTable;
  modules: ModuleStatus[];
  /** API answers so far: total, 4xx and 5xx. */
  requestCounts(): RequestCounts;
}

/**
 * Area of a request path for logs and filters: the module whose prefix owns it (exactly or as a
 * parent path), `diagnostics` for `/api/diagnostics`, else `server`.
 */
export function areaForPath(urlPath: string, modules: readonly ModuleEntry[] = MODULES): string {
  const owns = (prefix: string): boolean => urlPath === prefix || urlPath.startsWith(`${prefix}/`);
  if (owns('/api/diagnostics')) return 'diagnostics';
  for (const mod of modules) if (mod.prefixes.some(owns)) return mod.name;
  return 'server';
}

/**
 * Requests polled by pages and probes (`GET /api/health`, `GET /api/diagnostics/*`, the browser's
 * event uploads): their lines are debug and stay out of the memory rings unless they fail (≥ 500).
 */
export function isQuietRequest(method: string, urlPath: string): boolean {
  if (method === 'GET' && (urlPath === '/api/health' || urlPath.startsWith('/api/diagnostics/'))) return true;
  return method === 'POST' && urlPath === '/api/diagnostics/client-events';
}

/**
 * Level of a request line: 5xx warn; quiet requests debug; non-API and OPTIONS debug; API GET/HEAD
 * below 400 debug, other API answers (mutations, any 4xx) info; an API request slower than
 * {@link SLOW_REQUEST_MS} at least info.
 */
export function requestLevel(r: { method: string; api: boolean; status: number; ms: number; quiet: boolean }): LogLevel {
  if (r.status >= 500) return 'warn';
  if (r.quiet || !r.api || r.method === 'OPTIONS') return 'debug';
  if ((r.method === 'GET' || r.method === 'HEAD') && r.status < 400) return r.ms > SLOW_REQUEST_MS ? 'info' : 'debug';
  return 'info';
}

/** The route pattern that answered, or null for the catch-all handlers (`*`, `/api/*`) and middleware. */
function routeOf(c: Context<AppEnv>): string | null {
  try {
    const rp = routePath(c);
    return rp === '' || rp === '/*' || rp === '*' || rp === '/api/*' ? null : rp;
  } catch {
    return null;
  }
}

/** `X-Request-Id` on the final answer (a copy when its headers are immutable, e.g. a fetch() Response). */
function stampRequestId(c: Context<AppEnv>, rid: string): void {
  try {
    c.res.headers.set(REQUEST_ID_HEADER, rid);
  } catch {
    c.res = new Response(c.res.body, c.res);
    c.res.headers.set(REQUEST_ID_HEADER, rid);
  }
}

/** The outermost middleware (§17): request id, log context, in-flight registry, request line. */
function requestLog(ctx: AppContext, modules: readonly ModuleEntry[], counts: RequestCounts): MiddlewareHandler<AppEnv> {
  const log = ctx.log;
  return (c, next) => {
    const rid = newRequestId();
    const started = Date.now();
    const method = c.req.method;
    const urlPath = c.req.path;
    const logPath = pathForLog(urlPath);
    const api = isApiPath(urlPath);
    const quiet = isQuietRequest(method, urlPath);
    const area = areaForPath(urlPath, modules);
    const done = ctx.runtime.inflight.start(rid, method, logPath);
    c.set('requestId', rid);
    // Quiet GETs: their debug lines skip the rings too (the browser's event upload must not: its
    // debug events belong in the client ring).
    const context: LogContext = quiet && method === 'GET' ? { rid, area, quiet: true } : { rid, area };
    return withLogContext(context, async () => {
      // Timers keep the context they were created in (log-context rule 1): this one names the rid itself.
      const slow = outsideLogContext(() =>
        setTimeout(() => log.warn('request still running', { rid, area, method, path: logPath, ms: STILL_RUNNING_MS }), STILL_RUNNING_MS),
      );
      slow.unref();
      try {
        await next();
      } finally {
        clearTimeout(slow);
        done();
        try {
          stampRequestId(c, rid);
          const status = c.res.status;
          const ms = Date.now() - started;
          if (api) {
            counts.count++;
            if (status >= 500) counts.s5xx++;
            else if (status >= 400) counts.s4xx++;
          }
          const route = routeOf(c);
          const code = c.get('errorCode');
          log[requestLevel({ method, api, status, ms, quiet })]('request', {
            method,
            route,
            path: logPath,
            status,
            ms,
            code,
            from: c.get('pagesCors') ? 'pages' : 'local',
            pairingId: c.get('pairingId'),
            aborted: c.req.raw.signal.aborted || undefined,
            repeatKey: method === 'GET' ? `GET ${route ?? logPath} ${status} ${code ?? ''}` : undefined,
            ring: quiet && status < 500 ? false : undefined,
          });
        } catch {
          // Never let logging break an answer.
        }
      }
    });
  };
}

/** True when the last path segment has a file extension (`/favicon.svg`, `/a/b.js`). */
export function hasFileExtension(urlPath: string): boolean {
  const last = urlPath.slice(urlPath.lastIndexOf('/') + 1);
  return /\.[^./]+$/.test(last);
}

export function isAssetPath(urlPath: string): boolean {
  return urlPath === '/assets' || urlPath.startsWith('/assets/');
}

/** Runs a static handler and stamps `Cache-Control` on the file it served (if any). */
function withCacheControl(handler: MiddlewareHandler<AppEnv>, value: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const res = await handler(c, next);
    if (res instanceof Response && res.status < 400) res.headers.set('Cache-Control', value);
    return res;
  };
}

function mountStatic(app: Hono<AppEnv>, webDist: string): void {
  // Hashed build assets: immutable; a miss is a plain 404 (never index.html).
  app.get('/assets/*', withCacheControl(serveStatic({ root: webDist }), ASSET_CACHE_CONTROL));
  app.get('/assets/*', (c) => c.text('Not found', 404));

  // Other files at the root of web/dist (favicon, robots.txt, index.html itself): revalidate.
  const rootFiles = withCacheControl(serveStatic({ root: webDist }), HTML_CACHE_CONTROL);
  app.get('*', async (c, next) => {
    if (isApiPath(c.req.path) || !hasFileExtension(c.req.path)) return next();
    return rootFiles(c, next);
  });

  // SPA fallback: GET, not /api/ or /assets/, no file extension → index.html (no-cache).
  const indexHtml = withCacheControl(serveStatic({ root: webDist, path: 'index.html' }), HTML_CACHE_CONTROL);
  app.get('*', async (c, next) => {
    const p = c.req.path;
    if (isApiPath(p) || isAssetPath(p) || hasFileExtension(p)) return next();
    return indexHtml(c, next);
  });
}

export function createApp(ctx: AppContext, options: CreateAppOptions = {}): PortlyApp {
  const app = new Hono<AppEnv>();
  const routes = new RouteTable();
  const entries = options.modules ?? MODULES;
  const counts: RequestCounts = { count: 0, s4xx: 0, s5xx: 0 };
  // Areas come from the registered modules, then the full list (a test app may register only a few).
  const areaModules = entries === MODULES ? MODULES : [...entries, ...MODULES];

  app.onError(createErrorHandler(ctx.log));
  app.notFound((c) => (isApiPath(c.req.path) ? errorResponse(c, 'not_found', 'No such API route') : c.text('Not found', 404)));

  app.use('*', requestLog(ctx, areaModules, counts));
  app.use('*', createSecurityHeaders({ routes, pagesOrigin: ctx.config.pagesOrigin }));
  app.use('*', createGate({ config: ctx.config, routes, log: ctx.log, pairing: ctx.pairing }));

  const modules = registerModules(app, ctx, entries);
  ctx.runtime.modules.splice(0, Infinity, ...modules);

  // /api JSON 404, mounted before the SPA fallback.
  const apiNotFound = (c: Context<AppEnv>): Response => errorResponse(c, 'not_found', 'No such API route');
  app.all('/api', apiNotFound);
  app.all('/api/*', apiNotFound);

  const webDist = options.webDist === undefined ? ctx.config.paths.webDist : options.webDist;
  if (webDist !== null && fs.existsSync(path.join(webDist, 'index.html'))) {
    mountStatic(app, webDist);
  } else if (webDist !== null) {
    const hint = ctx.config.dev
      ? `Portly API server (dev). Open ${ctx.config.appOrigin} for the app.`
      : 'web/dist is missing. Run `npm run build` first.';
    app.get('*', (c) => (isApiPath(c.req.path) ? errorResponse(c, 'not_found') : c.text(hint, 404)));
  }

  routes.collect(app);
  return { app, routes, modules, requestCounts: () => ({ ...counts }) };
}
