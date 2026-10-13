/**
 * Static backend: sports (`GET /api/sports/teams`, `GET /api/sports/games`) over ESPN called from
 * the browser. The mapping itself (and that this copy matches it) is tested on the server
 * (server/src/modules/sports); here: the routes answer, cache and map errors like the server's.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SportsTeam, SportsTeamGames } from '@portly/shared';
import { getClientEvents } from '../../diagnostics/clientLog.ts';
import { createFakeFetch, failingFetch, type FakeFetchRoute } from '../providers/__fixtures__/fakeFetch.ts';
import { SCHEDULE_TTL_MS } from '../providers/espn.ts';
import { createTestBackend, type TestBackend } from '../test/harness.ts';
import * as sports from './sports.ts';

const TEAM = { id: '12', abbreviation: 'KC', displayName: 'Kansas City Chiefs', shortDisplayName: 'Chiefs', color: 'e31837', logo: 'https://a.espncdn.com/i/teamlogos/nfl/500/kc.png' };
const OPP = { id: '7', abbreviation: 'DEN', displayName: 'Denver Broncos', shortDisplayName: 'Broncos' };

const SCHEDULE = {
  team: TEAM,
  // Preseason with a game to come: no other phase is read.
  requestedSeason: { type: 1 },
  events: [
    {
      id: '1',
      date: '2026-10-04T17:00Z',
      links: [{ rel: ['boxscore', 'desktop'], href: 'https://www.espn.com/nfl/boxscore/_/gameId/1' }],
      competitions: [
        {
          competitors: [
            { homeAway: 'home', team: TEAM, score: { displayValue: '24' }, winner: true },
            { homeAway: 'away', team: OPP, score: { displayValue: '20' }, winner: false },
          ],
          status: { type: { state: 'post', completed: true, shortDetail: 'Final' } },
          broadcasts: [],
        },
      ],
    },
    {
      id: '2',
      date: '2026-10-18T20:25Z',
      competitions: [
        {
          competitors: [
            { homeAway: 'home', team: OPP },
            { homeAway: 'away', team: TEAM },
          ],
          status: { type: { state: 'pre', completed: false, shortDetail: '10/18 - 4:25 PM EDT' } },
          broadcasts: [{ type: { shortName: 'TV' }, market: { type: 'National' }, media: { shortName: 'CBS' } }],
        },
      ],
    },
  ],
};

const json = (doc: unknown): FakeFetchRoute['respond'] => ({ json: doc });

describe('static sports', () => {
  let t: TestBackend | undefined;

  afterEach(() => {
    t?.close();
    t = undefined;
    vi.unstubAllGlobals();
  });

  const setup = async (routes: FakeFetchRoute[]) => {
    const fake = createFakeFetch(routes);
    vi.stubGlobal('fetch', fake.fetch);
    t = await createTestBackend([sports]);
    return fake;
  };

  it('lists teams', async () => {
    const fake = await setup([{ match: '/apis/v2/sports/football/nfl/standings', respond: json({ children: [{ standings: { entries: [{ team: TEAM }] } }, { standings: { entries: [{ team: OPP }] } }] }) }]);
    const res = await t!.call('GET', '/api/sports/teams?league=nfl');
    expect(res.status).toBe(200);
    expect(((await res.json()) as SportsTeam[]).map((x) => x.abbreviation)).toEqual(['DEN', 'KC']);
    expect(fake.calls[0]!.init.credentials).toBe('omit');
  });

  it('returns a team’s games and caches the schedule', async () => {
    const fake = await setup([{ match: '/football/nfl/teams/12/schedule', respond: json(SCHEDULE) }]);
    const res = await t!.call('GET', '/api/sports/games?league=nfl&team=12');
    expect(res.status).toBe(200);
    const body = (await res.json()) as SportsTeamGames;
    expect(body.recent.map((g) => g.boxScoreUrl)).toEqual(['https://www.espn.com/nfl/boxscore/_/gameId/1']);
    expect(body.upcoming[0]!.broadcasts).toEqual([{ name: 'CBS', kind: 'tv', market: 'National' }]);
    await t!.call('GET', '/api/sports/games?league=nfl&team=12');
    expect(fake.calls).toHaveLength(1);
    t!.tick(SCHEDULE_TTL_MS + 1);
    await t!.call('GET', '/api/sports/games?league=nfl&team=12');
    expect(fake.calls).toHaveLength(2);
  });

  it('maps errors like the server', async () => {
    await setup([
      { match: '/teams/99/schedule', respond: { status: 404, json: {} } },
      { match: '/teams/98/schedule', respond: { status: 429, json: {} } },
    ]);
    expect((await t!.call('GET', '/api/sports/games?league=nfl&team=abc')).status).toBe(422);
    expect((await t!.call('GET', '/api/sports/games?league=nfl&team=99')).status).toBe(404);
    expect((await t!.call('GET', '/api/sports/games?league=nfl&team=98')).status).toBe(429);
    vi.stubGlobal('fetch', failingFetch);
    const res = await t!.call('GET', '/api/sports/teams?league=nba');
    expect(res.status).toBe(502);
  });

  it('records each ESPN failure as a provider event: host, status and code, never the URL', async () => {
    await setup([
      { match: '/teams/99/schedule', respond: { status: 503, json: {} } },
      { match: '/teams/98/schedule', respond: { text: 'not json' } },
      { match: '/teams/97/schedule', respond: { status: 404, json: {} } },
    ]);
    await t!.call('GET', '/api/sports/games?league=nfl&team=99');
    await t!.call('GET', '/api/sports/games?league=nfl&team=98');
    await t!.call('GET', '/api/sports/games?league=nfl&team=97');
    vi.stubGlobal('fetch', failingFetch);
    await t!.call('GET', '/api/sports/teams?league=nba');
    const events = getClientEvents().map((entry) => entry.event);
    expect(events.map((event) => [event.level, event.cat, event.msg, event.fields])).toEqual([
      ['warn', 'provider', 'provider request failed', { provider: 'espn', host: 'site.api.espn.com', status: 503, code: 'http_5xx', errName: null, ms: expect.any(Number) }],
      ['warn', 'provider', 'provider request failed', { provider: 'espn', host: 'site.api.espn.com', status: 200, code: 'parse_error', errName: null, ms: expect.any(Number) }],
      // ESPN not knowing a team (or a neighbouring season phase) is expected: debug only.
      ['debug', 'provider', 'provider request failed', { provider: 'espn', host: 'site.api.espn.com', status: 404, code: 'not_found', errName: null, ms: expect.any(Number) }],
      ['warn', 'provider', 'provider request failed', { provider: 'espn', host: 'site.api.espn.com', status: null, code: 'network', errName: 'TypeError', ms: expect.any(Number) }],
    ]);
    expect(JSON.stringify(events)).not.toContain('/teams/');
  });
});
