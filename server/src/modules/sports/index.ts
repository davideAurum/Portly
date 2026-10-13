/**
 * Sports scores for the sports widget, from ESPN's public site API (no key, `policy: 'provider'`:
 * fixed vendor host). Both routes are declared `paired()` (the paired Pages site may use them too).
 *
 * - `GET /api/sports/teams?league=` → `SportsTeam[]`, cached {@link TEAMS_TTL_MS}.
 * - `GET /api/sports/games?league=&team=` → `SportsTeamGames`. Assembled on every request from
 *   cached documents: schedules {@link SCHEDULE_TTL_MS}, the league scoreboard (live scores)
 *   {@link SCOREBOARD_TTL_MS}, read only while one of the team's games is around now.
 *
 * Unknown league / malformed team id → 422 `validation_failed`; ESPN 404 for a team → 404
 * `not_found`; 429 → `rate_limited`; other non-2xx or malformed documents → 502 `provider_error`;
 * timeouts → 504 `upstream_timeout`. Failures are not cached.
 *
 * Diagnostics (§17): a request that read anything from ESPN (cache hits are not reads) records
 * health key `sports:<league>` (on demand, never stale) with detail `{op: teams|schedule|scoreboard,
 * status}` — failing when the answer failed (an HTTP code with ESPN's status, `parse_error` for an
 * unreadable document, or a transport code), degraded when a best-effort read (the scoreboard,
 * another season phase) failed but the games were still answered. ESPN not knowing a team (404 for
 * its schedule) is about that request, not the league, and is not recorded. Requests run in
 * `withLogContext({area: 'sports', op: teams|games})`; outbound purpose `espn.<op>`.
 */
import type { Hono } from 'hono';
import {
  REASON_TOKEN,
  SportsGamesQuerySchema,
  SportsTeamsQuerySchema,
  sportsLeague,
  type SportsLeagueInfo,
} from '@portly/shared';
import type { AppContext, AppEnv } from '../../context.ts';
import { HttpError } from '../../lib/errors.ts';
import { outcomeFromError, type DetailValue, type HealthSubject, type Outcome } from '../../lib/health.ts';
import { withLogContext } from '../../lib/log-context.ts';
import { errorFields } from '../../lib/logger.ts';
import { paired } from '../../lib/routes.ts';
import { parseQuery } from '../../lib/validate.ts';
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
  teamsUrl,
  type EspnTransport,
} from './espn.ts';

export const prefixes = ['/api/sports'] as const;

/** Which ESPN document a read is for (health detail, outbound purpose `espn.<op>`). */
export type EspnOp = 'teams' | 'schedule' | 'scoreboard';

/**
 * ESPN reads made for one request, for its health record. Only network reads count (a cache hit is
 * not a check); `last` is the latest read and its status (null when no answer arrived).
 */
export interface EspnReads {
  count: number;
  ms: number;
  last: { op: EspnOp; status: number | null } | null;
  /** The first best-effort read that failed (the request still answered). */
  partial: { op: EspnOp; err: unknown } | null;
}

function newEspnReads(): EspnReads {
  return { count: 0, ms: 0, last: null, partial: null };
}

/**
 * A failed ESPN answer as an API error, carrying ESPN's status as `httpStatus` (logged as
 * `upstreamStatus`; `outcomeFromError` maps it to `not_found`/`rate_limited`/`http_5xx` …).
 */
function upstreamError(status: number, what: string): HttpError & { httpStatus: number } {
  let err: HttpError;
  if (status === 404) err = new HttpError(404, 'not_found', `ESPN has no ${what}`);
  else if (status === 429) err = new HttpError(429, 'rate_limited', 'ESPN is rate limiting requests; try again shortly');
  else err = new HttpError(502, 'provider_error', `ESPN answered HTTP ${status}`);
  return Object.assign(err, { httpStatus: status });
}

/** An ESPN document we could not read (not JSON, or not the documented shape). */
class EspnUnreadableError extends HttpError {
  override name = 'EspnUnreadableError';
  constructor(message: string, cause?: unknown) {
    super(502, 'provider_error', { message, cause });
  }
}

/** Fetches and parses one ESPN JSON document, counting it in `reads` when given. */
export async function fetchEspnJson(ctx: AppContext, url: string, what: string, op: EspnOp, reads?: EspnReads): Promise<unknown> {
  const read = { op, status: null as number | null };
  if (reads) {
    reads.count += 1;
    reads.last = read;
  }
  const started = Date.now();
  try {
    const res = await ctx.fetch(url, {
      policy: 'provider',
      as: 'text',
      maxBytes: ESPN_MAX_BYTES,
      timeoutMs: ESPN_TIMEOUT_MS,
      headers: { Accept: 'application/json' },
      purpose: `espn.${op}`,
    });
    read.status = res.status;
    if (res.status < 200 || res.status >= 300) throw upstreamError(res.status, what);
    try {
      return JSON.parse(res.data) as unknown;
    } catch {
      throw new EspnUnreadableError('ESPN sent a response that is not JSON');
    }
  } finally {
    if (reads) reads.ms += Date.now() - started;
  }
}

function shapeError(err: unknown): never {
  if (err instanceof EspnShapeError) throw new EspnUnreadableError(`ESPN sent an unexpected response: ${err.message}`, err);
  throw err;
}

function leagueOf(id: string): SportsLeagueInfo {
  const info = sportsLeague(id);
  // The query schema already restricts `league` to known ids.
  if (!info) throw new HttpError(422, 'validation_failed', 'Unknown league');
  return info;
}

/**
 * A league's subject (key `sports:<league>`), labelled with the league's name when that is a
 * plain token ("NFL"); names with spaces ("Premier League") are not storable labels.
 */
export function sportsHealthSubject(info: SportsLeagueInfo): HealthSubject {
  const subject: HealthSubject = { key: `sports:${info.id}`, area: 'sports', expectEveryMs: null };
  if (REASON_TOKEN.test(info.name)) subject.label = info.name;
  return subject;
}

function readDetail(read: { op: EspnOp; status: number | null } | null): Record<string, DetailValue> {
  if (read === null) return {};
  return read.status === null ? { op: read.op } : { op: read.op, status: read.status };
}

/** ESPN's status behind a failed read, when it answered. */
function statusOf(err: unknown): number | null {
  const status = (err as { httpStatus?: unknown } | null)?.httpStatus;
  return typeof status === 'number' ? status : null;
}

/** Records one request's outcome on `sports:<league>` — only when it read something from ESPN. */
function recordReads(ctx: AppContext, info: SportsLeagueInfo, reads: EspnReads, err?: unknown): void {
  if (reads.count === 0) return;
  const subject = sportsHealthSubject(info);
  if (err !== undefined) {
    const extra: Partial<Outcome> = { ms: reads.ms, detail: readDetail(reads.last) };
    if (err instanceof EspnUnreadableError) {
      extra.code = 'parse_error';
      const status = reads.last?.status ?? null;
      if (status !== null) extra.status = status;
    }
    ctx.health.record(subject, outcomeFromError(err, extra));
  } else if (reads.partial !== null) {
    const { op, err: partialErr } = reads.partial;
    const status = statusOf(partialErr);
    const outcome = outcomeFromError(partialErr, { ms: reads.ms, detail: readDetail({ op, status }) });
    ctx.health.record(subject, { ...outcome, ok: true, degraded: true });
  } else {
    ctx.health.record(subject, { ok: true, ms: reads.ms, detail: readDetail(reads.last) });
  }
}

export function register(app: Hono<AppEnv>, ctx: AppContext): void {
  const log = ctx.log.child({ module: 'sports' });
  const cachedJson = (url: string, ttlMs: number, what: string, op: EspnOp, reads: EspnReads) =>
    ctx.cache.getOrSet(espnCacheKey(url), ttlMs, () => fetchEspnJson(ctx, url, what, op, reads));

  app.get('/api/sports/teams', paired(), async (c) => {
    const info = leagueOf(parseQuery(c, SportsTeamsQuerySchema).league);
    const url = teamsUrl(info);
    const reads = newEspnReads();
    const teams = await withLogContext({ area: 'sports', op: 'teams' }, async () => {
      try {
        const list = await ctx.cache
          .getOrSet(`sports:teams:${info.id}`, TEAMS_TTL_MS, async () => mapTeams(await fetchEspnJson(ctx, url, 'team list', 'teams', reads), info.id))
          .catch(shapeError);
        recordReads(ctx, info, reads);
        return list;
      } catch (err) {
        recordReads(ctx, info, reads, err);
        throw err;
      }
    });
    return c.json(teams);
  });

  app.get('/api/sports/games', paired(), async (c) => {
    const query = parseQuery(c, SportsGamesQuerySchema);
    const info = leagueOf(query.league);
    const reads = newEspnReads();
    const games = await withLogContext({ area: 'sports', op: 'games' }, async () => {
      // The first schedule read is the team's current phase (its failure fails the request); later
      // reads and the scoreboard are best effort, so loadTeamGames swallows their failures — note
      // them here (an unknown extra phase answering 404 is expected, not a problem).
      let mainRead = true;
      const bestEffort = (op: EspnOp, p: Promise<unknown>): Promise<unknown> =>
        p.catch((err: unknown) => {
          log.debug('espn best-effort read failed', { op, ...errorFields(err) });
          if (reads.partial === null && !(op === 'schedule' && statusOf(err) === 404)) reads.partial = { op, err };
          throw err;
        });
      const transport: EspnTransport = {
        schedule: (url) => {
          const p = cachedJson(url, SCHEDULE_TTL_MS, 'schedule for this team', 'schedule', reads);
          if (mainRead) {
            mainRead = false;
            return p;
          }
          return bestEffort('schedule', p);
        },
        scoreboard: (url) => bestEffort('scoreboard', cachedJson(url, SCOREBOARD_TTL_MS, 'scoreboard', 'scoreboard', reads)),
      };
      try {
        const result = await loadTeamGames(info, query.team, transport, new Date()).catch(shapeError);
        recordReads(ctx, info, reads);
        return result;
      } catch (err) {
        // Only the main schedule read can fail the request. A 404 there is a team ESPN does not
        // list (say, a stale widget's relegated club): ESPN answered, the league is fine.
        if (statusOf(err) !== 404) recordReads(ctx, info, reads, err);
        throw err;
      }
    });
    return c.json(games);
  });
}
