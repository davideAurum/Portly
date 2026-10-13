/**
 * Static backend router: `METHOD /api/path/:param` patterns → handlers. Matching is exact on
 * segment count; `:name` segments capture one percent-decoded path segment. No wildcards.
 */
import type { StaticContext } from './context.ts';

export interface StaticRequest {
  /** The request as the API client built it (JSON or FormData body, headers, signal). */
  req: Request;
  /** Parsed URL (origin is a placeholder; use `pathname` and `searchParams`). */
  url: URL;
  /** Captured `:param` segments, percent-decoded. */
  params: Readonly<Record<string, string>>;
}

export type StaticHandler = (ctx: StaticContext, request: StaticRequest) => Response | Promise<Response>;

interface Segment {
  literal?: string;
  param?: string;
}

interface Route {
  method: string;
  pattern: string;
  segments: Segment[];
  handler: StaticHandler;
}

export interface RouteMatch {
  handler: StaticHandler;
  params: Record<string, string>;
  pattern: string;
}

function splitPath(path: string): string[] {
  return path.split('/').filter((s) => s.length > 0);
}

function parsePattern(pattern: string): Segment[] {
  if (!pattern.startsWith('/')) throw new Error(`Route pattern must start with /: ${pattern}`);
  return splitPath(pattern).map((s) => (s.startsWith(':') ? { param: s.slice(1) } : { literal: s }));
}

export class StaticRouter {
  private readonly routes: Route[] = [];

  add(method: string, pattern: string, handler: StaticHandler): this {
    const upper = method.toUpperCase();
    if (this.routes.some((r) => r.method === upper && r.pattern === pattern)) {
      throw new Error(`Duplicate route ${upper} ${pattern}`);
    }
    this.routes.push({ method: upper, pattern, segments: parsePattern(pattern), handler });
    return this;
  }

  get(pattern: string, handler: StaticHandler): this {
    return this.add('GET', pattern, handler);
  }
  post(pattern: string, handler: StaticHandler): this {
    return this.add('POST', pattern, handler);
  }
  put(pattern: string, handler: StaticHandler): this {
    return this.add('PUT', pattern, handler);
  }
  patch(pattern: string, handler: StaticHandler): this {
    return this.add('PATCH', pattern, handler);
  }
  delete(pattern: string, handler: StaticHandler): this {
    return this.add('DELETE', pattern, handler);
  }

  /** Registered `METHOD pattern` strings (for tests and the 404 message). */
  list(): string[] {
    return this.routes.map((r) => `${r.method} ${r.pattern}`);
  }

  /**
   * Finds the route for a method + pathname. HEAD matches GET routes (like the server). Returns
   * `{handler: null}`-style absence as `undefined`; `methodNotAllowed` is true when the path
   * exists under another method.
   */
  match(method: string, pathname: string): RouteMatch | undefined {
    const upper = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase();
    const parts = splitPath(pathname);
    for (const route of this.routes) {
      if (route.method !== upper || route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < route.segments.length; i++) {
        const segment = route.segments[i];
        const part = parts[i];
        if (segment === undefined || part === undefined) {
          ok = false;
          break;
        }
        if (segment.param !== undefined) {
          let decoded: string;
          try {
            decoded = decodeURIComponent(part);
          } catch {
            ok = false;
            break;
          }
          if (decoded.length === 0) {
            ok = false;
            break;
          }
          params[segment.param] = decoded;
        } else if (segment.literal !== part) {
          ok = false;
          break;
        }
      }
      if (ok) return { handler: route.handler, params, pattern: route.pattern };
    }
    return undefined;
  }

  /** Whether any route has this pathname under a different method. */
  hasPath(pathname: string): boolean {
    const parts = splitPath(pathname);
    return this.routes.some(
      (route) =>
        route.segments.length === parts.length &&
        route.segments.every((segment, i) => segment.param !== undefined || segment.literal === parts[i]),
    );
  }
}
