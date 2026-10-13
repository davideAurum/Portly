import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { sportsLeague, type SportsTeam, type SportsTeamGames } from '@homebase/shared';
import type { AppEnv } from '../../context.ts';
import { createErrorHandler } from '../../lib/errors.ts';
import { RouteTable } from '../../lib/routes.ts';
import { createGate } from '../../security/gate.ts';
import { createSecurityHeaders } from '../../security/headers.ts';
import { createTestContext, type TestContext, type TestContextOverrides } from '../../testing/test-context.ts';
import { testRequest } from '../../testing/test-request.ts';
import { DEN, KC, LAC, LV, event, schedule, scoreboard, teamsDoc } from './__fixtures__/espn.ts';
import {
  EspnShapeError,
  isAroundNow,
  loadTeamGames,
  mapGame,
  mapSchedule,
  mapTeams,
  scheduleUrl,
  scoreboardUrl,
  standingsUrl,
  teamsUrl,
  type EspnTransport,
} from './espn.ts';
import { register } from './index.ts';

const NFL = sportsLeague('nfl')!;
const EPL = sportsLeague('epl')!;
const NOW = new Date('2026-10-11T20:00:00Z');

const FINAL_1 = event({ id: '1', date: '2026-09-14T00:15Z', home: KC, away: DEN, state: 'post', homeScore: 24, awayScore: 20 });
const FINAL_2 = event({ id: '2', date: '2026-09-21T17:00Z', home: LV, away: KC, state: 'post', homeScore: 31, awayScore: 17 });
const FINAL_3 = event({ id: '3', date: '2026-10-04T17:00Z', home: KC, away: LAC, state: 'post', homeScore: 10, awayScore: 10, detail: 'Final/OT' });
/** Kicked off at 19:00, schedule still says "pre" (it is cached longer than the scoreboard). */
const TODAY_PRE = event({ id: '4', date: '2026-10-11T19:00Z', home: DEN, away: KC, state: 'pre', broadcasts: [['TV', 'National', 'CBS']] });
const TODAY_LIVE = event(
  { id: '4', date: '2026-10-11T19:00Z', home: DEN, away: KC, state: 'in', homeScore: 7, awayScore: 14, detail: 'Q3 4:12', situation: '1st & 10 at DEN 30', broadcasts: [['TV', 'National', 'CBS'], ['Streaming', 'National', 'Paramount+']] },
  'scoreboard',
);
const NEXT = event({ id: '5', date: '2026-10-18T20:25Z', home: KC, away: LAC, state: 'pre', broadcasts: [['TV', 'National', 'Fox'], ['Radio', 'Home', 'KCFX']] });
const POSTPONED = event({ id: '6', date: '2026-10-25T17:00Z', home: KC, away: LV, state: 'post', completed: false, statusName: 'STATUS_POSTPONED', detail: 'Postponed' });

function transport(docs: Record<string, unknown>): EspnTransport & { calls: string[] } {
  const calls: string[] = [];
  const read = async (url: string) => {
    calls.push(url);
    if (!(url in docs)) throw new Error(`unexpected ${url}`);
    const doc = docs[url];
    if (doc instanceof Error) throw doc;
    return doc;
  };
  return { calls, schedule: read, scoreboard: read };
}

describe('sports: ESPN mapping', () => {
  it('is copied byte for byte into the in-browser backend', () => {
    const read = (p: string) => fs.readFileSync(path.resolve(import.meta.dirname, p), 'utf8');
    expect(read('../../../../web/src/static/providers/espn.ts')).toBe(read('espn.ts'));
  });

  it('builds the ESPN URLs', () => {
    expect(teamsUrl(NFL)).toBe('https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams?limit=1000');
    expect(scheduleUrl(NFL, '12')).toBe('https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/12/schedule');
    expect(scheduleUrl(NFL, '12', { seasonType: 1 })).toBe('https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/12/schedule?seasontype=1');
    expect(scheduleUrl(EPL, '359', { fixture: true })).toBe('https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/teams/359/schedule?fixture=true');
    expect(scoreboardUrl(sportsLeague('college-football')!)).toBe('https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?groups=80');
  });

  it('maps a team list: active teams by name, ESPN logos only, hex colors', () => {
    const doc = teamsDoc([KC, { ...DEN, isActive: false }, LAC]);
    (doc.sports[0]!.leagues[0]!.teams[1]!.team as { logos: unknown[] }).logos = [{ href: 'https://evil.example/x.png', rel: ['default'] }];
    const teams = mapTeams(doc, 'nfl');
    expect(teams.map((t) => t.abbreviation)).toEqual(['KC', 'LAC']);
    expect(teams[0]).toEqual<SportsTeam>({
      id: '12',
      league: 'nfl',
      name: 'Kansas City Chiefs',
      shortName: 'Chiefs',
      abbreviation: 'KC',
      logo: 'https://a.espncdn.com/i/teamlogos/nfl/500/kc.png',
      logoDark: 'https://a.espncdn.com/i/teamlogos/nfl/500-dark/kc.png',
      color: '#e31837',
    });
    const foreign = mapTeams(teamsDoc([{ ...KC }]), 'nfl');
    expect(foreign).toHaveLength(1);
    expect(() => mapTeams({ sports: [] }, 'nfl')).toThrow(EspnShapeError);
  });

  it('reads teams from a standings document too (the browser’s CORS-enabled source)', () => {
    const team = (t: typeof KC) => teamsDoc([t]).sports[0]!.leagues[0]!.teams[0]!.team;
    const standings = {
      children: [
        { name: 'AFC', children: [{ name: 'AFC West', standings: { entries: [{ team: team(KC) }, { team: team(DEN) }] } }] },
        { name: 'NFC', standings: { entries: [{ team: team(LAC) }, { team: team(KC) }] } },
      ],
    };
    expect(mapTeams(standings, 'nfl').map((t) => t.abbreviation)).toEqual(['DEN', 'KC', 'LAC']);
    expect(standingsUrl(NFL)).toBe('https://site.api.espn.com/apis/v2/sports/football/nfl/standings');
  });

  it('maps a finished schedule game: scores, winner, record, desktop links only', () => {
    const game = mapGame(FINAL_1, 'nfl')!;
    expect(game).toMatchObject({ id: '1', league: 'nfl', date: '2026-09-14T00:15:00.000Z', state: 'post', completed: true, detail: 'Final', situation: null, venue: 'Arrowhead Stadium' });
    expect(game.home).toMatchObject({ teamId: '12', abbreviation: 'KC', score: '24', winner: true, record: '4-1', logo: 'https://a.espncdn.com/i/teamlogos/nfl/500/kc.png' });
    expect(game.away).toMatchObject({ teamId: '7', score: '20', winner: false });
    expect(game.boxScoreUrl).toBe('https://www.espn.com/nfl/boxscore/_/gameId/1');
    expect(game.gameUrl).toBe('https://www.espn.com/nfl/game/_/gameId/1');
    expect(game.espnWatchUrl).toBe('https://www.espn.com/watchespn/index?gameId=1');
    // A draw: nobody won.
    expect(mapGame(FINAL_3, 'nfl')!.home.winner).toBeNull();
  });

  it('maps live scoreboard games: string scores, situation, broadcasts by kind and market', () => {
    const game = mapGame(TODAY_LIVE, 'nfl')!;
    expect(game).toMatchObject({ state: 'in', completed: false, detail: 'Q3 4:12', situation: '1st & 10 at DEN 30' });
    expect([game.away.score, game.home.score]).toEqual(['14', '7']);
    expect(game.home.winner).toBeNull();
    expect(game.broadcasts).toEqual([
      { name: 'CBS', kind: 'tv', market: 'National' },
      { name: 'Paramount+', kind: 'streaming', market: 'National' },
    ]);
    const upcoming = mapGame(NEXT, 'nfl')!;
    expect(upcoming.home.score).toBeNull();
    expect(upcoming.broadcasts).toContainEqual({ name: 'KCFX', kind: 'radio', market: 'Home' });
  });

  it('drops unsafe links and logos and skips games without two teams', () => {
    const raw = structuredClone(FINAL_1) as ReturnType<typeof event>;
    raw.links = [{ rel: ['boxscore', 'desktop'], href: 'javascript:alert(1)' }];
    (raw.competitions[0]!.competitors[0]!.team as { logos: unknown[] }).logos = [{ href: 'http://a.espncdn.com/x.png', rel: ['default'] }];
    const game = mapGame(raw, 'nfl')!;
    expect(game.boxScoreUrl).toBeNull();
    expect(game.espnWatchUrl).toBeNull();
    expect(game.home.logo).toBeNull();
    const broken = structuredClone(FINAL_1) as ReturnType<typeof event>;
    broken.competitions[0]!.competitors = broken.competitions[0]!.competitors.slice(0, 1);
    expect(mapGame(broken, 'nfl')).toBeNull();
    expect(mapGame({ id: 'x', date: 'not a date', competitions: [{}] }, 'nfl')).toBeNull();
    expect(() => mapSchedule({ events: 'nope' }, 'nfl')).toThrow(EspnShapeError);
  });

  it('knows when a game may be on', () => {
    const now = NOW.getTime();
    expect(isAroundNow(mapGame(TODAY_PRE, 'nfl')!, now)).toBe(true);
    expect(isAroundNow(mapGame(NEXT, 'nfl')!, now)).toBe(false);
    expect(isAroundNow(mapGame(FINAL_3, 'nfl')!, now)).toBe(false);
  });
});

describe('sports: loadTeamGames', () => {
  it('splits games into recent, live and upcoming and overlays the scoreboard on games around now', async () => {
    const t = transport({
      [scheduleUrl(NFL, '12')]: schedule(KC, 2, [NEXT, FINAL_2, FINAL_1, TODAY_PRE, FINAL_3, POSTPONED]),
      [scoreboardUrl(NFL)]: scoreboard([TODAY_LIVE]),
    });
    const games = await loadTeamGames(NFL, '12', t, NOW);
    expect(games.team?.name).toBe('Kansas City Chiefs');
    expect(games.recent.map((g) => g.id)).toEqual(['1', '2', '3']);
    expect(games.upcoming.map((g) => g.id)).toEqual(['5']);
    expect(games.live).toHaveLength(1);
    const live = games.live[0]!;
    expect(live).toMatchObject({ id: '4', state: 'in', detail: 'Q3 4:12', situation: '1st & 10 at DEN 30' });
    expect([live.away.score, live.home.score]).toEqual(['14', '7']);
    // Logos (and their dark variants) stay the schedule's; broadcasts come from the scoreboard.
    expect(live.home.logoDark).toBe('https://a.espncdn.com/i/teamlogos/nfl/500-dark/den.png');
    expect(live.broadcasts.map((b) => b.name)).toEqual(['CBS', 'Paramount+']);
    expect(games.fetchedAt).toBe(NOW.toISOString());
    expect(t.calls).toEqual([scheduleUrl(NFL, '12'), scoreboardUrl(NFL)]);
  });

  it('skips the scoreboard when nothing is on, and survives a failing one', async () => {
    const quiet = transport({ [scheduleUrl(NFL, '12')]: schedule(KC, 2, [FINAL_1, FINAL_2, FINAL_3, NEXT]) });
    await loadTeamGames(NFL, '12', quiet, NOW);
    expect(quiet.calls).toEqual([scheduleUrl(NFL, '12')]);

    const failing = transport({ [scheduleUrl(NFL, '12')]: schedule(KC, 2, [FINAL_1, FINAL_2, FINAL_3, TODAY_PRE]), [scoreboardUrl(NFL)]: new Error('down') });
    const games = await loadTeamGames(NFL, '12', failing, NOW);
    expect(games.upcoming.map((g) => g.id)).toEqual(['4']);
  });

  it('reads the previous phase when the current one has few results, and the next when nothing is scheduled', async () => {
    const pre = transport({
      [scheduleUrl(NFL, '12')]: schedule(KC, 2, [FINAL_3]),
      [scheduleUrl(NFL, '12', { seasonType: 1 })]: schedule(KC, 1, [FINAL_1, FINAL_2]),
      [scheduleUrl(NFL, '12', { seasonType: 3 })]: schedule(KC, 3, [NEXT]),
    });
    const games = await loadTeamGames(NFL, '12', pre, NOW);
    expect(games.recent.map((g) => g.id)).toEqual(['1', '2', '3']);
    expect(games.upcoming.map((g) => g.id)).toEqual(['5']);

    // Extra phases are best effort.
    const failing = transport({ [scheduleUrl(NFL, '12')]: schedule(KC, 2, [FINAL_3]), [scheduleUrl(NFL, '12', { seasonType: 1 })]: new Error('x'), [scheduleUrl(NFL, '12', { seasonType: 3 })]: new Error('x') });
    expect((await loadTeamGames(NFL, '12', failing, NOW)).recent).toHaveLength(1);
  });

  it('reads soccer fixtures alongside the results', async () => {
    const t = transport({
      [scheduleUrl(EPL, '12')]: schedule(KC, 14308, [FINAL_1]),
      [scheduleUrl(EPL, '12', { fixture: true })]: schedule(KC, 14308, [NEXT]),
    });
    const games = await loadTeamGames(EPL, '12', t, NOW);
    expect(games.recent.map((g) => g.id)).toEqual(['1']);
    expect(games.upcoming.map((g) => g.id)).toEqual(['5']);
    expect(games.league).toBe('epl');
  });

  it('lets the main schedule fail', async () => {
    await expect(loadTeamGames(NFL, '12', transport({ [scheduleUrl(NFL, '12')]: new Error('boom') }), NOW)).rejects.toThrow('boom');
    await expect(loadTeamGames(NFL, '12', transport({ [scheduleUrl(NFL, '12')]: { nope: true } }), NOW)).rejects.toThrow(EspnShapeError);
  });
});

describe('sports: routes', () => {
  let ctx: TestContext | undefined;

  afterEach(() => {
    if (ctx) {
      ctx.close();
      fs.rmSync(ctx.config.dataDir, { recursive: true, force: true });
      ctx = undefined;
    }
  });

  function testbed(overrides: TestContextOverrides) {
    ctx = createTestContext(overrides);
    const app = new Hono<AppEnv>();
    const routes = new RouteTable();
    app.onError(createErrorHandler(ctx.log));
    app.use('*', createSecurityHeaders({ routes }));
    app.use('*', createGate({ config: ctx.config, routes, log: ctx.log }));
    register(app, ctx);
    routes.collect(app);
    return async <T>(path: string) => {
      const res = await testRequest(app, 'GET', path);
      return { status: res.status, body: (await res.json()) as T };
    };
  }

  const json = (doc: unknown) => ({ text: JSON.stringify(doc), headers: { 'content-type': 'application/json' } });

  it('lists a league’s teams and caches them', async () => {
    const get = testbed({ fetchRoutes: [{ match: '/football/nfl/teams?limit=1000', respond: json(teamsDoc([LAC, KC])) }] });
    const res = await get<SportsTeam[]>('/api/sports/teams?league=nfl');
    expect(res.status).toBe(200);
    expect(res.body.map((t) => t.name)).toEqual(['Kansas City Chiefs', 'Los Angeles Chargers']);
    await get('/api/sports/teams?league=nfl');
    expect(ctx!.fakeFetch!.calls).toHaveLength(1);
  });

  it('returns a team’s games', async () => {
    const get = testbed({ fetchRoutes: [{ match: '/football/nfl/teams/12/schedule', respond: json(schedule(KC, 2, [FINAL_1, FINAL_2, FINAL_3, NEXT])) }] });
    const res = await get<SportsTeamGames>('/api/sports/games?league=nfl&team=12');
    expect(res.status).toBe(200);
    expect(res.body.recent).toHaveLength(3);
    expect(res.body.upcoming[0]!.broadcasts[0]).toEqual({ name: 'Fox', kind: 'tv', market: 'National' });
  });

  it('validates the query and maps ESPN failures', async () => {
    const get = testbed({
      fetchRoutes: [
        { match: '/teams/99/schedule', respond: { status: 404, text: '{}' } },
        { match: '/teams/98/schedule', respond: { status: 503, text: '{}' } },
        { match: '/teams/97/schedule', respond: { text: '<html>' } },
        { match: '/teams/96/schedule', respond: json({ unexpected: true }) },
      ],
    });
    expect((await get('/api/sports/teams?league=cricket')).status).toBe(422);
    expect((await get('/api/sports/games?league=nfl&team=abc')).status).toBe(422);
    expect((await get('/api/sports/games?league=nfl')).status).toBe(422);
    expect((await get('/api/sports/games?league=nfl&team=99')).status).toBe(404);
    expect((await get('/api/sports/games?league=nfl&team=98')).status).toBe(502);
    expect((await get('/api/sports/games?league=nfl&team=97')).status).toBe(502);
    const shape = await get<{ error: { code: string } }>('/api/sports/games?league=nfl&team=96');
    expect(shape.status).toBe(502);
    expect(shape.body.error.code).toBe('provider_error');
  });

  describe('health (diagnostics)', () => {
    const health = (league = 'nfl') => ctx!.health.get(`sports:${league}`);
    /** A game that starts in 10 minutes: the scoreboard is read. */
    const soon = () => event({ id: '8', date: new Date(Date.now() + 10 * 60 * 1000).toISOString(), home: KC, away: DEN, state: 'pre' });

    it('records a league read (on demand: never stale); cache hits are not checks', async () => {
      const get = testbed({ fetchRoutes: [{ match: '/football/nfl/teams?limit=1000', respond: json(teamsDoc([KC])) }] });
      await get('/api/sports/teams?league=nfl');
      await get('/api/sports/teams?league=nfl');
      expect(health()).toMatchObject({ area: 'sports', label: 'NFL', status: 'ok', expectEveryMs: null, detail: { op: 'teams', status: 200 } });
      expect(ctx!.health.history('sports:nfl')).toHaveLength(1);
    });

    it('labels a league only with a storable name', async () => {
      const get = testbed({ fetchRoutes: [{ match: '/soccer/eng.1/teams?limit=1000', respond: json(teamsDoc([KC])) }] });
      await get('/api/sports/teams?league=epl');
      expect(health('epl')).toMatchObject({ status: 'ok', label: null });
    });

    it.each([
      ['503', { status: 503, text: '{}' }, 'http_5xx', 503],
      ['429', { status: 429, text: '{}' }, 'rate_limited', 429],
      ['not JSON', { text: '<html>' }, 'parse_error', 200],
      ['an unexpected document', json({ unexpected: true }), 'parse_error', 200],
    ])('a failed team schedule (%s) fails the league with %s', async (_name, respond, code, status) => {
      const get = testbed({ fetchRoutes: [{ match: '/teams/12/schedule', respond }] });
      await get('/api/sports/games?league=nfl&team=12');
      expect(health()).toMatchObject({ status: 'failing', lastCode: code, lastStatus: status, detail: { op: 'schedule', status } });
    });

    it('a team ESPN does not know (404) is about that request: the league neither fails nor recovers', async () => {
      const get = testbed({
        fetchRoutes: [
          { match: '/football/nfl/teams/12/schedule', respond: json(schedule(KC, 2, [FINAL_3, NEXT])) },
          { match: '/football/nfl/teams/98/schedule', respond: { status: 503, text: '{}' } },
          { match: '/football/nfl/teams/99/schedule', respond: { status: 404, text: '{}' } },
          { match: '/football/nfl/teams?limit=1000', respond: { status: 404, text: '{}' } },
        ],
      });
      expect((await get('/api/sports/games?league=nfl&team=99')).status).toBe(404);
      expect(health()).toBeNull();

      expect((await get('/api/sports/games?league=nfl&team=12')).status).toBe(200);
      expect((await get('/api/sports/games?league=nfl&team=99')).status).toBe(404);
      expect(health()).toMatchObject({ status: 'ok', detail: { op: 'schedule', status: 200 } });

      expect((await get('/api/sports/games?league=nfl&team=98')).status).toBe(502);
      expect((await get('/api/sports/games?league=nfl&team=99')).status).toBe(404);
      expect(health()).toMatchObject({ status: 'failing', lastCode: 'http_5xx', consecutiveFailures: 1 });
      expect(ctx!.logs.query({ q: 'sports failing' }).records.map((r) => r.fields.code)).toEqual(['http_5xx']);
      expect(ctx!.logs.query({ q: 'sports recovered' }).records).toEqual([]);

      // The team list is the league's own document: its 404 does fail the league.
      expect((await get('/api/sports/teams?league=nfl')).status).toBe(404);
      expect(health()).toMatchObject({ status: 'failing', lastCode: 'not_found', lastStatus: 404, detail: { op: 'teams', status: 404 } });
    });

    it('a failed scoreboard degrades the league while the games still answer', async () => {
      const get = testbed({
        fetchRoutes: [
          { match: '/football/nfl/teams/12/schedule', respond: json(schedule(KC, 2, [FINAL_1, FINAL_2, FINAL_3, soon()])) },
          { match: '/football/nfl/scoreboard', respond: { status: 503, text: 'busy' } },
        ],
      });
      const res = await get<SportsTeamGames>('/api/sports/games?league=nfl&team=12');
      expect(res.status).toBe(200);
      expect(res.body.upcoming.map((g) => g.id)).toEqual(['8']);
      expect(health()).toMatchObject({ status: 'degraded', lastCode: 'http_5xx', lastStatus: 503, detail: { op: 'scoreboard', status: 503 } });
    });

    it('an unknown extra season phase (404) is not a problem', async () => {
      const get = testbed({
        fetchRoutes: [
          { match: /\/teams\/12\/schedule\?seasontype=1/, respond: { status: 404, text: '{}' } },
          { match: '/football/nfl/teams/12/schedule', respond: json(schedule(KC, 2, [FINAL_3, NEXT])) },
        ],
      });
      expect((await get('/api/sports/games?league=nfl&team=12')).status).toBe(200);
      expect(ctx!.fakeFetch!.calls).toHaveLength(2);
      expect(health()?.status).toBe('ok');
    });

    it('logs under the league request and tells safe-fetch what each read is for', async () => {
      const get = testbed({
        fetchRoutes: [
          { match: '/football/nfl/teams?limit=1000', respond: json(teamsDoc([KC])) },
          { match: '/football/nfl/teams/12/schedule', respond: json(schedule(KC, 2, [FINAL_1, FINAL_2, FINAL_3, soon()])) },
          { match: '/football/nfl/scoreboard', respond: json(scoreboard([])) },
        ],
      });
      const purposes: (string | undefined)[] = [];
      const real = ctx!.fetch;
      ctx!.fetch = async (url, options) => {
        purposes.push(options.purpose);
        return real(url, options);
      };
      await get('/api/sports/teams?league=nfl');
      await get('/api/sports/games?league=nfl&team=12');
      expect(purposes).toEqual(['espn.teams', 'espn.schedule', 'espn.scoreboard']);
      expect(health()).toMatchObject({ status: 'ok', detail: { op: 'scoreboard', status: 200 } });
      // Health lines carry the league's key and area; their `op` is the ESPN read (detail).
      const ok = ctx!.logs.query({ q: 'sports ok' }).records;
      expect(ok.map((r) => [r.area, r.fields.key, r.fields.op])).toEqual([
        ['sports', 'sports:nfl', 'teams'],
        ['sports', 'sports:nfl', 'scoreboard'],
      ]);
      expect(ctx!.logs.query({ area: 'sports', fieldEquals: { op: 'games' } }).records.map((r) => r.msg)).toContain('outbound');
    });
  });
});
