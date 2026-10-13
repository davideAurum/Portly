/**
 * Route metadata for the request gate (§4.2 step 3/4/5).
 *
 * `/api/*` routes are non-exempt, JSON-bodied by default. A route opts out by adding a
 * metadata middleware *where it is registered*:
 *
 *   app.get('/api/health', exempt('health'), handler);
 *   app.get('/api/icons/:id', exempt('image'), paired(), handler);
 *   app.get('/api/oauth/:provider/callback', exempt('oauth-callback'), handler);
 *   app.post('/api/uploads', multipart('upload'), paired(), handler);      // multipart, 10 MB
 *   app.post('/api/import/preview', multipart('import'), paired(), handler); // multipart, 25 MB
 *
 * Access from the Pages site (hybrid mode) is default-deny: only routes tagged {@link paired} may
 * be called by a paired browser on the configured Pages origin. Untagged routes (approving a new
 * pairing) stay with Homebase's own page on this PC.
 *
 * After all modules are registered, {@link RouteTable.collect} records `{method, pattern, ...meta}`
 * for every tagged handler into a Hono router instance; the gate matches requests against that
 * router (never with string-prefix checks).
 */
import type { MiddlewareHandler } from 'hono';
import { TrieRouter } from 'hono/router/trie-router';

/** Gate exemption kinds (§4.2 step 3). */
export type ExemptKind = 'health' | 'image' | 'oauth-callback';
/** Body kinds: JSON (default, 1 MB), multipart upload (10 MB), multipart import (25 MB). */
export type BodyKind = 'json' | 'upload' | 'import';
/** Who may call a route besides Homebase's own page: `paired` = the paired Pages site too. */
export type RouteAccess = 'paired';

export interface RouteMeta {
  exempt?: ExemptKind;
  body?: BodyKind;
  access?: RouteAccess;
}

export interface RecordedRoute extends RouteMeta {
  method: string;
  pattern: string;
}

export const BODY_LIMITS: Readonly<Record<BodyKind, number>> = Object.freeze({
  json: 1024 * 1024,
  upload: 10 * 1024 * 1024,
  import: 25 * 1024 * 1024,
});

const META_KEY = Symbol.for('homebase.routeMeta');
// Hono wraps sub-app handlers that have a custom error handler and keeps the original here.
const COMPOSED_HANDLER_KEY = '__COMPOSED_HANDLER';

type TaggedHandler = MiddlewareHandler & { [META_KEY]?: RouteMeta };

function tag(meta: RouteMeta): MiddlewareHandler {
  const handler: TaggedHandler = async (_c, next) => {
    await next();
  };
  Object.defineProperty(handler, META_KEY, { value: Object.freeze({ ...meta }), enumerable: false });
  return handler;
}

/** Declares the route as exempt from the header checks of §4.2 step 4 (see {@link ExemptKind}). */
export function exempt(kind: ExemptKind): MiddlewareHandler {
  return tag({ exempt: kind });
}

/** Declares the route as accepting `multipart/form-data` with the upload (10 MB) or import (25 MB) limit. */
export function multipart(kind: 'upload' | 'import'): MiddlewareHandler {
  return tag({ body: kind });
}

/**
 * Declares the route as callable by a paired browser on the configured Pages site (hybrid mode).
 * Combine it with {@link exempt}/{@link multipart} by listing both before the handler.
 */
export function paired(): MiddlewareHandler {
  return tag({ access: 'paired' });
}

/** Metadata attached to a handler by {@link exempt}/{@link multipart}/{@link paired}, if any. */
export function routeMetaOf(handler: unknown): RouteMeta | undefined {
  if (typeof handler !== 'function') return undefined;
  const direct = (handler as TaggedHandler)[META_KEY];
  if (direct) return direct;
  const inner = (handler as unknown as Record<string, unknown>)[COMPOSED_HANDLER_KEY];
  return typeof inner === 'function' ? (inner as TaggedHandler)[META_KEY] : undefined;
}

/** Anything exposing Hono's `routes` list (a Hono app). */
export interface RouteSource {
  readonly routes: readonly { method: string; path: string; handler: unknown }[];
}

/** One router entry: a recorded declaration, or an untagged `/api` route (access only). */
interface RouterEntry {
  route: RecordedRoute;
  /** Key of the registration the entry belongs to (`METHOD pattern`). */
  key: string;
}

function isApiPattern(pattern: string): boolean {
  return pattern === '/api' || pattern.startsWith('/api/');
}

export class RouteTable {
  #router = new TrieRouter<RouterEntry>();
  #routes: RecordedRoute[] = [];
  #collectedFrom = new WeakSet<object>();

  /** Records one route's metadata. */
  record(route: RecordedRoute): void {
    const method = route.method.toUpperCase();
    const entry: RecordedRoute = Object.freeze({ ...route, method });
    this.#routes.push(entry);
    this.#router.add(method, route.pattern, { route: entry, key: `${method} ${route.pattern}` });
  }

  /**
   * Records the metadata of every tagged handler registered on `app` (call once, after
   * registration). Untagged `/api` handlers with a concrete method are added to the router as
   * well (not to {@link list}), so a route nobody marked {@link paired} keeps an overlapping
   * paired pattern from opening it to the Pages site.
   */
  collect(app: RouteSource): void {
    if (this.#collectedFrom.has(app)) return;
    this.#collectedFrom.add(app);
    for (const r of app.routes) {
      const meta = routeMetaOf(r.handler);
      if (meta) {
        this.record({ method: r.method, pattern: r.path, ...meta });
      } else if (r.method.toUpperCase() !== 'ALL' && isApiPattern(r.path)) {
        const method = r.method.toUpperCase();
        const route: RecordedRoute = Object.freeze({ method, pattern: r.path });
        this.#router.add(method, r.path, { route, key: `${method} ${r.path}` });
      }
    }
  }

  /**
   * Metadata for a request (merged over all matching declarations). HEAD is matched as GET,
   * like Hono's own routing.
   *
   * Access fails closed: the result is `paired` only when *every* matching registration
   * (method + pattern) carries {@link paired}, so `/api/x/:id` [paired] never opens an
   * overlapping `/api/x/special` that is not.
   */
  match(method: string, path: string): RouteMeta {
    const m = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase();
    const [matches] = this.#router.match(m, path);
    const meta: RouteMeta = {};
    const access = new Map<string, boolean>();
    for (const match of matches) {
      const { route, key } = match[0];
      if (route.exempt && !meta.exempt) meta.exempt = route.exempt;
      if (route.body && !meta.body) meta.body = route.body;
      access.set(key, access.get(key) === true || route.access === 'paired');
    }
    if (access.size > 0 && [...access.values()].every(Boolean)) meta.access = 'paired';
    return meta;
  }

  list(): readonly RecordedRoute[] {
    return this.#routes;
  }
}
