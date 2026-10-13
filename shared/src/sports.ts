/**
 * Sports scores contracts (`GET /api/sports/teams`, `GET /api/sports/games`). Data comes from
 * ESPN's public site API (no key); the server (or, in the browser-only build, the page) maps it to
 * these shapes: plain text only, links and logos are SafeHttpUrls, unknown fields are dropped.
 */
import { z } from 'zod';

export interface SportsLeagueInfo {
  /** Our key (stored in widget configs). */
  id: string;
  /** ESPN path segments: `/sports/<sport>/<league>/…`. */
  sport: string;
  league: string;
  name: string;
  /** Soccer: results and fixtures are separate ESPN lists, and there are no numbered season phases. */
  soccer: boolean;
  /** ESPN scoreboard `groups` filter (college: every Division I game, not only the top 25). */
  scoreboardGroups?: string;
}

function league(id: string, sport: string, espnLeague: string, name: string, extra: Partial<SportsLeagueInfo> = {}): SportsLeagueInfo {
  return Object.freeze({ id, sport, league: espnLeague, name, soccer: sport === 'soccer', ...extra });
}

/** The leagues the widget offers, in picker order. */
export const SPORTS_LEAGUES: readonly SportsLeagueInfo[] = Object.freeze([
  league('nfl', 'football', 'nfl', 'NFL'),
  league('nba', 'basketball', 'nba', 'NBA'),
  league('mlb', 'baseball', 'mlb', 'MLB'),
  league('nhl', 'hockey', 'nhl', 'NHL'),
  league('wnba', 'basketball', 'wnba', 'WNBA'),
  league('college-football', 'football', 'college-football', 'College football', { scoreboardGroups: '80' }),
  league('mens-college-basketball', 'basketball', 'mens-college-basketball', "Men's college basketball", { scoreboardGroups: '50' }),
  league('womens-college-basketball', 'basketball', 'womens-college-basketball', "Women's college basketball", { scoreboardGroups: '50' }),
  league('mls', 'soccer', 'usa.1', 'MLS'),
  league('nwsl', 'soccer', 'usa.nwsl', 'NWSL'),
  league('epl', 'soccer', 'eng.1', 'Premier League'),
  league('laliga', 'soccer', 'esp.1', 'LaLiga'),
  league('bundesliga', 'soccer', 'ger.1', 'Bundesliga'),
  league('serie-a', 'soccer', 'ita.1', 'Serie A'),
  league('ligue-1', 'soccer', 'fra.1', 'Ligue 1'),
  league('champions-league', 'soccer', 'uefa.champions', 'Champions League'),
]);

export const SPORTS_LEAGUE_IDS = SPORTS_LEAGUES.map((l) => l.id) as [string, ...string[]];
export const SportsLeagueId = z.enum(SPORTS_LEAGUE_IDS);
export type SportsLeagueId = z.output<typeof SportsLeagueId>;

export function sportsLeague(id: string): SportsLeagueInfo | undefined {
  return SPORTS_LEAGUES.find((l) => l.id === id);
}

/** ESPN team ids are short numbers. */
export const SportsTeamId = z.string().regex(/^\d{1,10}$/, { message: 'Must be a team id' });

/** Most games of each kind returned per team (the widget shows fewer). */
export const MAX_SPORTS_RECENT = 10;
export const MAX_SPORTS_UPCOMING = 10;

export interface SportsTeam {
  id: string;
  league: string;
  /** "Kansas City Chiefs". */
  name: string;
  /** "Chiefs". */
  shortName: string;
  /** "KC". */
  abbreviation: string;
  logo: string | null;
  /** Logo for dark backgrounds (falls back to `logo`). */
  logoDark: string | null;
  /** `#rrggbb` or null. */
  color: string | null;
}

export interface SportsCompetitor {
  teamId: string;
  name: string;
  shortName: string;
  abbreviation: string;
  logo: string | null;
  logoDark: string | null;
  /** As displayed ("24", "3 (4)"); null before the game. */
  score: string | null;
  /** True / false once decided; null before or during the game, and for draws. */
  winner: boolean | null;
  /** Season record ("5-1"), when ESPN gives one. */
  record: string | null;
}

export const SPORTS_GAME_STATES = ['pre', 'in', 'post'] as const;
export type SportsGameState = (typeof SPORTS_GAME_STATES)[number];

export const SPORTS_BROADCAST_KINDS = ['tv', 'streaming', 'radio', 'other'] as const;
export type SportsBroadcastKind = (typeof SPORTS_BROADCAST_KINDS)[number];

export interface SportsBroadcast {
  /** As ESPN names it ("ESPN", "Prime Video", "NFL Net"). */
  name: string;
  kind: SportsBroadcastKind;
  /** "National", "Home" or "Away"; null when not given. */
  market: string | null;
}

export interface SportsGame {
  id: string;
  league: string;
  /** Start time, ISO-8601 UTC. */
  date: string;
  /** False when only the day is known (time TBD). */
  timeValid: boolean;
  state: SportsGameState;
  /** True for a finished game; a postponed or canceled one is `post` but not completed. */
  completed: boolean;
  /** Short status ("Final", "Q3 4:12", "9:20 - OT", "Postponed", "10/18 - 4:25 PM EDT"). */
  detail: string;
  /** Live situation ("1st & 10 at WSH 30"), only while live. */
  situation: string | null;
  home: SportsCompetitor;
  away: SportsCompetitor;
  /** "Week 6", "ALCS - Game 3", a tournament round… */
  note: string | null;
  venue: string | null;
  /** Box score (falls back to the game page). */
  boxScoreUrl: string | null;
  /** Game page (gamecast / preview). */
  gameUrl: string | null;
  /** ESPN's watch page for the game, when ESPN carries it. */
  espnWatchUrl: string | null;
  broadcasts: SportsBroadcast[];
}

/** `GET /api/sports/games?league=&team=` */
export interface SportsTeamGames {
  league: string;
  teamId: string;
  team: SportsTeam | null;
  /** Up to {@link MAX_SPORTS_RECENT} finished games, most recent last. */
  recent: SportsGame[];
  /** Games in progress (normally zero or one). */
  live: SportsGame[];
  /** Up to {@link MAX_SPORTS_UPCOMING} scheduled games, soonest first (postponed games excluded). */
  upcoming: SportsGame[];
  /** When the data was assembled (ISO-8601). */
  fetchedAt: string;
}

/** Query of `GET /api/sports/teams`. */
export const SportsTeamsQuerySchema = z.object({ league: SportsLeagueId });
export type SportsTeamsQuery = z.output<typeof SportsTeamsQuerySchema>;

/** Query of `GET /api/sports/games`. */
export const SportsGamesQuerySchema = z.object({ league: SportsLeagueId, team: SportsTeamId });
export type SportsGamesQuery = z.output<typeof SportsGamesQuerySchema>;
