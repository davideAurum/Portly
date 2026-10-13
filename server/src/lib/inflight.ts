/**
 * Requests in progress (ARCHITECTURE §17): the request middleware registers each request with
 * {@link InFlightRequests.start} and calls the returned `done` when it finished; the Diagnostics
 * summary shows how many are open and the oldest ones, and shutdown waits for the count to reach
 * zero. Paths are logged forms (`pathForLog`: no query string).
 */

export interface InFlightSnapshot {
  count: number;
  /** Age of the oldest open request (ms); null when none. */
  oldestMs: number | null;
  /** Oldest first, at most {@link MAX_SNAPSHOT_ROUTES}: `"METHOD path"`. */
  routes: string[];
}

export interface InFlightRequests {
  /** Registers a request; the returned function (idempotent) marks it finished. */
  start(rid: string, method: string, path: string): () => void;
  /** Open requests, leaving out `excludeRid` (e.g. the Diagnostics summary's own request). */
  snapshot(now?: number, excludeRid?: string): InFlightSnapshot;
  count(): number;
}

export const MAX_SNAPSHOT_ROUTES = 10;

interface OpenRequest {
  rid: string;
  method: string;
  path: string;
  startedAt: number;
}

export function createInFlightRequests(options: { now?: () => number } = {}): InFlightRequests {
  const clock = options.now ?? Date.now;
  // Keyed by a fresh object per request: a repeated rid never removes another request's entry.
  const open = new Map<object, OpenRequest>();

  return {
    start(rid, method, path) {
      const token = {};
      open.set(token, { rid, method, path, startedAt: clock() });
      return () => {
        open.delete(token);
      };
    },
    snapshot(now = clock(), excludeRid) {
      // Insertion order is start order: the first entries are the oldest.
      const entries = [...open.values()].filter((r) => r.rid !== excludeRid);
      const oldest = entries[0];
      return {
        count: entries.length,
        oldestMs: oldest === undefined ? null : Math.max(0, now - oldest.startedAt),
        routes: entries.slice(0, MAX_SNAPSHOT_ROUTES).map((r) => `${r.method} ${r.path}`),
      };
    },
    count() {
      return open.size;
    },
  };
}
