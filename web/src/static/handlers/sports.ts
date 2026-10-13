/**
 * Sports module of the static backend (port of server/src/modules/sports/index.ts) — ESPN's
 * public site API, called directly from the browser (no key, CORS `*`). The mapping lives in
 * ../providers/espn.ts, a byte-identical copy of the server's.
 *
 * - `GET /api/sports/teams?league=` → `SportsTeam[]` from the league standings (ESPN's team list
 *   sends no CORS header), cached 1 day in memory.
 * - `GET /api/sports/games?league=&team=` → `SportsTeamGames`, assembled from cached schedules
 *   (5 min) and the league scoreboard (20 s, read only while a game is around now).
 *
 * Errors match the server: 422 `validation_failed`, 404 `not_found` (ESPN has no such team),
 * 429 `rate_limited`, 502 `provider_error`, 504 `upstream_timeout`. Failures are never cached.
 * Every upstream failure is also a `provider` event (host, status, code; never the URL); a 404 only
 * at debug, as the server: ESPN not knowing a team, or a neighbouring season phase, is expected.
 * As in weather.ts, upstream calls run inside the cache's single flight under their own deadline,
 * never one request's AbortSignal.
 */
import { SportsGamesQuerySchema, SportsTeamsQuerySchema, sportsLeague, type SportsLeagueInfo } from '@homebase/shared';
import type { StaticContext } from '../context.ts';
import { createMemoryCache, type MemoryCache } from '../lib/cache.ts';
import { fetchTextCapped, upstreamFailure, type FetchLike } from '../lib/fetch.ts';
import { parseQuery } from '../lib/validate.ts';
import {
  ESPN_MAX_BYTES,
  ESPN_TIMEOUT_MS,
  EspnShapeError,
  SCHEDULE_TTL_MS,
  SCOREBOARD_TTL_MS,
  TEAMS_TTL_MS,
  espnCacheKey,
  loadTeamGames,
  mapTeams,
  standingsUrl,
} from '../providers/espn.ts';
import { errorName, hostOf, recordProviderFailure, statusFailureCode, stopwatch, transportFailureCode } from '../providers/diagnostics.ts';
import { StaticApiError, json } from '../respond.ts';
import type { StaticRouter } from '../router.ts';

const SERVICE_LABEL = 'ESPN';

const caches = new WeakMap<StaticContext, MemoryCache>();

/** The backend's ESPN document cache (one per context; exposed for tests). */
export function sportsCache(ctx: StaticContext): MemoryCache {
  let cache = caches.get(ctx);
  if (!cache) {
    cache = createMemoryCache({ now: ctx.now });
    caches.set(ctx, cache);
  }
  return cache;
}

function upstreamError(status: number, what: string): StaticApiError {
  if (status === 404) return new StaticApiError('not_found', `ESPN has no ${what}`);
  if (status === 429) return new StaticApiError('rate_limited', 'ESPN is rate limiting requests; try again shortly');
  return new StaticApiError('provider_error', `ESPN answered HTTP ${status}`);
}

/** Fetches and parses one ESPN JSON document (`fetch` injectable for tests). */
export async function fetchEspnJson(url: string, what: string, fetch?: FetchLike): Promise<unknown> {
  const elapsed = stopwatch();
  const host = hostOf(url);
  let res;
  try {
    res = await fetchTextCapped(
      url,
      { method: 'GET', headers: { Accept: 'application/json' }, credentials: 'omit' },
      { timeoutMs: ESPN_TIMEOUT_MS, maxBytes: ESPN_MAX_BYTES, fetch },
    );
  } catch (err) {
    const code = transportFailureCode(err);
    if (code !== null) recordProviderFailure('espn', host, { code, errName: errorName(err), ms: elapsed() });
    throw upstreamFailure(err, SERVICE_LABEL);
  }
  if (res.status < 200 || res.status >= 300) {
    recordProviderFailure('espn', host, { status: res.status, code: statusFailureCode(res.status), ms: elapsed() }, res.status === 404 ? 'debug' : 'warn');
    throw upstreamError(res.status, what);
  }
  try {
    return JSON.parse(res.text) as unknown;
  } catch {
    recordProviderFailure('espn', host, { status: res.status, code: 'parse_error', ms: elapsed() });
    throw new StaticApiError('provider_error', 'ESPN sent a response that is not JSON');
  }
}

function shapeError(err: unknown): never {
  if (err instanceof EspnShapeError) throw new StaticApiError('provider_error', `ESPN sent an unexpected response: ${err.message}`);
  throw err;
}

function leagueOf(id: string): SportsLeagueInfo {
  const info = sportsLeague(id);
  if (!info) throw new StaticApiError('validation_failed', 'Unknown league');
  return info;
}

export function register(router: StaticRouter): void {
  router.get('/api/sports/teams', async (ctx, { url }) => {
    const info = leagueOf(parseQuery(url, SportsTeamsQuerySchema).league);
    const teams = await sportsCache(ctx)
      .getOrSet(`sports:teams:${info.id}`, TEAMS_TTL_MS, async () => mapTeams(await fetchEspnJson(standingsUrl(info), 'team list'), info.id))
      .catch(shapeError);
    return json(teams);
  });

  router.get('/api/sports/games', async (ctx, { url }) => {
    const query = parseQuery(url, SportsGamesQuerySchema);
    const info = leagueOf(query.league);
    const cache = sportsCache(ctx);
    const cachedJson = (docUrl: string, ttlMs: number, what: string) => cache.getOrSet(espnCacheKey(docUrl), ttlMs, () => fetchEspnJson(docUrl, what));
    const games = await loadTeamGames(
      info,
      query.team,
      {
        schedule: (docUrl) => cachedJson(docUrl, SCHEDULE_TTL_MS, 'schedule for this team'),
        scoreboard: (docUrl) => cachedJson(docUrl, SCOREBOARD_TTL_MS, 'scoreboard'),
      },
      new Date(ctx.now()),
    ).catch(shapeError);
    return json(games);
  });
}
