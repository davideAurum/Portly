/**
 * Small ESPN-shaped documents for the sports tests (the real ones are 100–300 KB). Field names and
 * nesting follow ESPN's site API as of 2026-10: schedule events carry `score: {value,
 * displayValue}` and `broadcasts: [{type, market, media}]`; scoreboard events carry `score: "27"`,
 * `geoBroadcasts` and the short `broadcasts: [{market, names}]`.
 */

export interface TeamSpec {
  id: string;
  abbr: string;
  name: string;
  short: string;
}

export const KC: TeamSpec = { id: '12', abbr: 'KC', name: 'Kansas City Chiefs', short: 'Chiefs' };
export const DEN: TeamSpec = { id: '7', abbr: 'DEN', name: 'Denver Broncos', short: 'Broncos' };
export const LV: TeamSpec = { id: '13', abbr: 'LV', name: 'Las Vegas Raiders', short: 'Raiders' };
export const LAC: TeamSpec = { id: '24', abbr: 'LAC', name: 'Los Angeles Chargers', short: 'Chargers' };

function teamObj(t: TeamSpec, style: 'schedule' | 'scoreboard') {
  const base = { id: t.id, abbreviation: t.abbr, displayName: t.name, shortDisplayName: t.short, color: 'e31837' };
  return style === 'schedule'
    ? {
        ...base,
        logos: [
          { href: `https://a.espncdn.com/i/teamlogos/nfl/500/${t.abbr.toLowerCase()}.png`, rel: ['full', 'default'] },
          { href: `https://a.espncdn.com/i/teamlogos/nfl/500-dark/${t.abbr.toLowerCase()}.png`, rel: ['full', 'dark'] },
          { href: `https://a.espncdn.com/i/teamlogos/nfl/500-dark/scoreboard/${t.abbr.toLowerCase()}.png`, rel: ['full', 'scoreboard', 'dark'] },
        ],
      }
    : { ...base, logo: `https://a.espncdn.com/i/teamlogos/nfl/500/scoreboard/${t.abbr.toLowerCase()}.png` };
}

export interface EventSpec {
  id: string;
  date: string;
  home: TeamSpec;
  away: TeamSpec;
  state: 'pre' | 'in' | 'post';
  completed?: boolean;
  statusName?: string;
  detail?: string;
  homeScore?: number;
  awayScore?: number;
  broadcasts?: [kind: string, market: string, name: string][];
  note?: string;
  situation?: string;
}

export function event(spec: EventSpec, style: 'schedule' | 'scoreboard' = 'schedule') {
  const completed = spec.completed ?? spec.state === 'post';
  const decided = spec.state === 'post' && spec.homeScore !== undefined && spec.awayScore !== undefined && spec.homeScore !== spec.awayScore;
  const competitor = (t: TeamSpec, homeAway: 'home' | 'away', points: number | undefined, won: boolean) => ({
    id: t.id,
    homeAway,
    team: teamObj(t, style),
    ...(points === undefined ? {} : { score: style === 'schedule' ? { value: points, displayValue: String(points) } : String(points) }),
    ...(decided ? { winner: won } : {}),
    ...(style === 'scoreboard' ? { records: [{ name: 'overall', type: 'total', summary: '4-1' }] } : { record: [{ type: 'total', displayValue: '4-1' }] }),
  });
  const geo = (spec.broadcasts ?? []).map(([kind, market, name]) => ({ type: { shortName: kind }, market: { type: market }, media: { shortName: name } }));
  return {
    id: spec.id,
    date: spec.date,
    shortName: `${spec.away.abbr} @ ${spec.home.abbr}`,
    timeValid: true,
    links: [
      { rel: ['summary', 'desktop', 'event'], href: `https://www.espn.com/nfl/game/_/gameId/${spec.id}` },
      { rel: ['boxscore', 'desktop', 'event'], href: `https://www.espn.com/nfl/boxscore/_/gameId/${spec.id}` },
      { rel: ['boxscore', 'sportscenter', 'app', 'event'], href: `sportscenter://x-callback-url/showGame?gameId=${spec.id}` },
      { rel: ['watchespn', 'desktop', 'event'], href: `https://www.espn.com/watchespn/index?gameId=${spec.id}` },
    ],
    competitions: [
      {
        id: spec.id,
        date: spec.date,
        timeValid: true,
        venue: { fullName: 'Arrowhead Stadium' },
        notes: spec.note ? [{ type: 'event', headline: spec.note }] : [],
        competitors: [
          competitor(spec.home, 'home', spec.homeScore, (spec.homeScore ?? 0) > (spec.awayScore ?? 0)),
          competitor(spec.away, 'away', spec.awayScore, (spec.awayScore ?? 0) > (spec.homeScore ?? 0)),
        ],
        status: {
          type: {
            name: spec.statusName ?? (spec.state === 'pre' ? 'STATUS_SCHEDULED' : spec.state === 'in' ? 'STATUS_IN_PROGRESS' : 'STATUS_FINAL'),
            state: spec.state,
            completed,
            shortDetail: spec.detail ?? (spec.state === 'post' ? 'Final' : spec.state === 'in' ? 'Q3 4:12' : '10/18 - 4:25 PM EDT'),
          },
        },
        ...(spec.situation ? { situation: { downDistanceText: spec.situation } } : {}),
        ...(style === 'schedule'
          ? { broadcasts: geo }
          : { geoBroadcasts: geo, broadcasts: geo.length ? [{ market: 'national', names: geo.map((g) => g.media.shortName) }] : [] }),
      },
    ],
  };
}

export function schedule(team: TeamSpec, seasonType: number, events: ReturnType<typeof event>[]) {
  return {
    team: { id: team.id, abbreviation: team.abbr, displayName: team.name, color: 'e31837', logo: `https://a.espncdn.com/i/teamlogos/nfl/500/${team.abbr.toLowerCase()}.png` },
    requestedSeason: { year: 2026, type: seasonType, name: 'Regular Season' },
    events,
  };
}

export function scoreboard(events: ReturnType<typeof event>[]) {
  return { leagues: [], events };
}

export function teamsDoc(teams: (TeamSpec & { isActive?: boolean })[]) {
  return {
    sports: [
      {
        leagues: [
          {
            teams: teams.map((t) => ({
              team: {
                ...teamObj(t, 'schedule'),
                isActive: t.isActive ?? true,
              },
            })),
          },
        ],
      },
    ],
  };
}
