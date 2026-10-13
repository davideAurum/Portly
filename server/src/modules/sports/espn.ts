/**
 * ESPN public site API → the shared sports contracts (§7a sports.ts). Pure: no network, no server
 * or browser imports, so web/src/static/providers/espn.ts is a byte-identical copy (a test checks).
 * Callers inject the transport into {@link loadTeamGames} and map {@link EspnShapeError} to their
 * own API error.
 *
 * Endpoints (`https://site.api.espn.com/apis/site/v2/sports/<sport>/<league>/…`, no key, CORS `*`):
 * - `teams` (`?limit=1000`, else college lists are cut short) → {@link mapTeams}. It sends no
 *   CORS header, so the browser reads `…/apis/v2/sports/<sport>/<league>/standings` instead
 *   ({@link standingsUrl}; every team that plays in the league — FBS only for college football),
 *   which {@link mapTeams} reads too;
 * - `teams/<id>/schedule` → {@link mapSchedule}. It covers one season phase only (the current one,
 *   or `?seasontype=1|2|3`: pre, regular, post), and for soccer only results unless `?fixture=true`;
 * - `scoreboard` (today, or this week for football) → {@link mapScoreboard}: the live scores and the
 *   full broadcast list, overlaid on the schedule's games.
 *
 * Everything returned is plain text; links are https URLs and logos come from ESPN's image host
 * only (the page's CSP allows exactly that host). Malformed games are skipped, a malformed
 * document throws {@link EspnShapeError}.
 */
import {
  MAX_SPORTS_RECENT,
  MAX_SPORTS_UPCOMING,
  isSafeHttpUrl,
  type SportsBroadcast,
  type SportsBroadcastKind,
  type SportsCompetitor,
  type SportsGame,
  type SportsGameState,
  type SportsLeagueInfo,
  type SportsTeam,
  type SportsTeamGames,
} from '@portly/shared';

export const ESPN_API_BASE = 'https://site.api.espn.com/apis/site/v2/sports';
/** The only host logos are taken from (allowed by the page's `img-src`). */
export const ESPN_IMAGE_HOST = 'a.espncdn.com';

/** Team lists change rarely. */
export const TEAMS_TTL_MS = 24 * 60 * 60 * 1000;
/** Schedules: new results and times; live scores come from the scoreboard. */
export const SCHEDULE_TTL_MS = 5 * 60 * 1000;
/** Scoreboard: live scores. */
export const SCOREBOARD_TTL_MS = 20 * 1000;
export const ESPN_TIMEOUT_MS = 8000;
export const ESPN_MAX_BYTES = 8 * 1024 * 1024;

/** A game counts as "around now" (→ check the scoreboard) from this long before its start… */
const LIVE_LEAD_MS = 30 * 60 * 1000;
/** …until this long after it (long games, extra innings, overtime). */
const LIVE_TAIL_MS = 8 * 60 * 60 * 1000;
/** Fewer finished games than this in the current phase → also read the previous phase. */
const MIN_RECENT = 3;

export class EspnShapeError extends Error {
  override name = 'EspnShapeError';
}

// ---------------------------------------------------------------------------
// URLs and cache keys
// ---------------------------------------------------------------------------

function leagueBase(info: SportsLeagueInfo): string {
  return `${ESPN_API_BASE}/${info.sport}/${info.league}`;
}

export function teamsUrl(info: SportsLeagueInfo): string {
  return `${leagueBase(info)}/teams?limit=1000`;
}

/** Team list with CORS (for the browser): the league standings. */
export function standingsUrl(info: SportsLeagueInfo): string {
  return `https://site.api.espn.com/apis/v2/sports/${info.sport}/${info.league}/standings`;
}

export function scheduleUrl(info: SportsLeagueInfo, teamId: string, options: { seasonType?: number; fixture?: boolean } = {}): string {
  const params = new URLSearchParams();
  if (options.seasonType !== undefined) params.set('seasontype', String(options.seasonType));
  if (options.fixture) params.set('fixture', 'true');
  const query = params.toString();
  return `${leagueBase(info)}/teams/${encodeURIComponent(teamId)}/schedule${query ? `?${query}` : ''}`;
}

export function scoreboardUrl(info: SportsLeagueInfo): string {
  return `${leagueBase(info)}/scoreboard${info.scoreboardGroups ? `?groups=${info.scoreboardGroups}` : ''}`;
}

/** Cache key of an ESPN document (the URL is unique per document). */
export function espnCacheKey(url: string): string {
  return `sports:${url}`;
}

// ---------------------------------------------------------------------------
// Loose readers (ESPN's documents are large and only partly stable)
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>;

function obj(value: unknown): Obj | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Obj) : undefined;
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Trimmed, single-line text capped at `max` characters, or null. */
function text(value: unknown, max = 120): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  const clean = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (clean === '') return null;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function httpsUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !isSafeHttpUrl(value)) return null;
  const url = new URL(value);
  return url.protocol === 'https:' ? url.href : null;
}

function imageUrl(value: unknown): string | null {
  const url = httpsUrl(value);
  return url !== null && new URL(url).hostname === ESPN_IMAGE_HOST ? url : null;
}

function hexColor(value: unknown): string | null {
  return typeof value === 'string' && /^[0-9a-f]{6}$/i.test(value) ? `#${value.toLowerCase()}` : null;
}

function rels(value: unknown): string[] {
  return arr(obj(value)?.rel).filter((r): r is string => typeof r === 'string');
}

/** `{logos:[{href, rel:[…]}]}` or `{logo: href}` → light and dark logos. */
function logos(team: Obj): { logo: string | null; logoDark: string | null } {
  const list = arr(team.logos);
  const pick = (want: (r: string[]) => boolean): string | null => {
    for (const entry of list) if (want(rels(entry))) return imageUrl(obj(entry)?.href);
    return null;
  };
  const logo = pick((r) => r.includes('default')) ?? imageUrl(obj(list[0])?.href) ?? imageUrl(team.logo);
  const logoDark = pick((r) => r.includes('dark') && !r.includes('scoreboard'));
  return { logo, logoDark };
}

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

function mapTeam(value: unknown, league: string): SportsTeam | null {
  const team = obj(value);
  if (!team) return null;
  const id = text(team.id, 10);
  const name = text(team.displayName) ?? text(team.name);
  if (id === null || !/^\d+$/.test(id) || name === null) return null;
  return {
    id,
    league,
    name,
    shortName: text(team.shortDisplayName) ?? text(team.nickname) ?? text(team.name) ?? name,
    abbreviation: text(team.abbreviation, 12) ?? name.slice(0, 3).toUpperCase(),
    ...logos(team),
    color: hexColor(team.color),
  };
}

/** The raw team objects of a standings document (entries of every group, depth-first). */
function standingsTeams(root: Obj): unknown[] {
  const out: unknown[] = [];
  const walk = (group: Obj | undefined, depth: number) => {
    if (!group || depth > 6) return;
    for (const entry of arr(obj(group.standings)?.entries)) out.push(obj(entry)?.team);
    for (const child of arr(group.children)) walk(obj(child), depth + 1);
  };
  walk(root, 0);
  return out;
}

/** `teams` or `standings` document → active teams sorted by name. */
export function mapTeams(json: unknown, league: string): SportsTeam[] {
  const root = obj(json);
  const leagueObj = obj(arr(obj(arr(root?.sports)[0])?.leagues)[0]);
  let raws: unknown[];
  if (leagueObj && Array.isArray(leagueObj.teams)) raws = leagueObj.teams.map((entry) => obj(entry)?.team);
  else if (root && (Array.isArray(root.children) || obj(root.standings))) raws = standingsTeams(root);
  else throw new EspnShapeError('Unexpected team list');
  const teams: SportsTeam[] = [];
  const seen = new Set<string>();
  for (const entry of raws) {
    const raw = obj(entry);
    if (!raw || raw.isActive === false) continue;
    const team = mapTeam(raw, league);
    if (team && !seen.has(team.id)) {
      seen.add(team.id);
      teams.push(team);
    }
  }
  return teams.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Games
// ---------------------------------------------------------------------------

function score(value: unknown): string | null {
  const o = obj(value);
  return o ? (text(o.displayValue, 16) ?? text(o.value, 16)) : text(value, 16);
}

function record(competitor: Obj): string | null {
  for (const entry of [...arr(competitor.records), ...arr(competitor.record)]) {
    const r = obj(entry);
    if (r && r.type === 'total') return text(r.summary, 16) ?? text(r.displayValue, 16);
  }
  return null;
}

function mapCompetitor(value: unknown, state: SportsGameState): SportsCompetitor | null {
  const competitor = obj(value);
  const team = obj(competitor?.team);
  if (!competitor || !team) return null;
  const teamId = text(team.id, 10) ?? text(competitor.id, 10);
  const name = text(team.displayName) ?? text(team.name);
  if (teamId === null || name === null) return null;
  const shootout = text(competitor.shootoutScore, 4);
  const base = state === 'pre' ? null : score(competitor.score);
  return {
    teamId,
    name,
    shortName: text(team.shortDisplayName) ?? text(team.nickname) ?? text(team.name) ?? name,
    abbreviation: text(team.abbreviation, 12) ?? name.slice(0, 3).toUpperCase(),
    ...logos(team),
    score: base !== null && shootout !== null ? `${base} (${shootout})` : base,
    winner: state === 'post' && typeof competitor.winner === 'boolean' ? competitor.winner : null,
    record: record(competitor),
  };
}

function broadcastKind(value: unknown): SportsBroadcastKind {
  const kind = typeof value === 'string' ? value.toLowerCase() : '';
  if (kind === 'tv') return 'tv';
  if (kind === 'streaming' || kind === 'web') return 'streaming';
  if (kind === 'radio') return 'radio';
  return 'other';
}

function marketLabel(value: unknown): string | null {
  const market = text(obj(value)?.type ?? value, 20);
  if (market === null) return null;
  return market.charAt(0).toUpperCase() + market.slice(1).toLowerCase();
}

/** `geoBroadcasts` / schedule `broadcasts` (`{type, market, media}`), or scoreboard `broadcasts` (`{market, names}`). */
function mapBroadcasts(competition: Obj): SportsBroadcast[] {
  const out: SportsBroadcast[] = [];
  const seen = new Set<string>();
  const add = (name: string | null, kind: SportsBroadcastKind, market: string | null) => {
    if (name === null) return;
    const key = `${name.toLowerCase()}|${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name, kind, market });
  };
  const detailed = arr(competition.geoBroadcasts).length > 0 ? arr(competition.geoBroadcasts) : arr(competition.broadcasts);
  for (const entry of detailed) {
    const b = obj(entry);
    if (!b) continue;
    if (obj(b.media)) add(text(obj(b.media)?.shortName, 60), broadcastKind(obj(b.type)?.shortName), marketLabel(b.market));
    else for (const name of arr(b.names)) add(text(name, 60), 'tv', marketLabel(b.market));
  }
  return out.slice(0, 20);
}

function eventLink(event: Obj, rel: string): string | null {
  for (const entry of arr(event.links)) {
    const r = rels(entry);
    if (r.includes(rel) && r.includes('desktop')) {
      const url = httpsUrl(obj(entry)?.href);
      if (url !== null) return url;
    }
  }
  return null;
}

function mapState(value: unknown): SportsGameState {
  return value === 'in' || value === 'post' ? value : 'pre';
}

/** One ESPN event → a game, or null when it lacks the basics (id, date, two teams). */
export function mapGame(value: unknown, league: string): SportsGame | null {
  const event = obj(value);
  const competition = obj(arr(event?.competitions)[0]);
  if (!event || !competition) return null;
  const id = text(event.id, 20);
  const time = typeof event.date === 'string' ? Date.parse(event.date) : NaN;
  if (id === null || !Number.isFinite(time)) return null;

  const status = obj(competition.status) ?? obj(event.status);
  const type = obj(status?.type);
  const state = mapState(type?.state);
  const competitors = arr(competition.competitors).map(obj);
  const homeRaw = competitors.find((c) => c?.homeAway === 'home') ?? competitors[0];
  const awayRaw = competitors.find((c) => c !== homeRaw && c?.homeAway === 'away') ?? competitors.find((c) => c !== homeRaw);
  const home = mapCompetitor(homeRaw, state);
  const away = mapCompetitor(awayRaw, state);
  if (!home || !away) return null;

  const situation = obj(competition.situation);
  const gameUrl = eventLink(event, 'summary') ?? eventLink(event, 'gamecast');
  return {
    id,
    league,
    date: new Date(time).toISOString(),
    timeValid: competition.timeValid !== false && event.timeValid !== false,
    state,
    completed: type?.completed === true,
    detail: text(type?.shortDetail, 60) ?? text(type?.detail, 60) ?? text(type?.description, 60) ?? '',
    situation: state === 'in' ? (text(situation?.downDistanceText, 80) ?? text(situation?.shortDownDistanceText, 80)) : null,
    home,
    away,
    note: text(obj(arr(competition.notes)[0])?.headline, 80),
    venue: text(obj(competition.venue)?.fullName, 80),
    boxScoreUrl: eventLink(event, 'boxscore') ?? gameUrl,
    gameUrl,
    espnWatchUrl: eventLink(event, 'watchespn'),
    broadcasts: mapBroadcasts(competition),
  };
}

function mapEvents(events: unknown, league: string): SportsGame[] {
  const games: SportsGame[] = [];
  for (const event of arr(events)) {
    const game = mapGame(event, league);
    if (game) games.push(game);
  }
  return games;
}

export interface MappedSchedule {
  team: SportsTeam | null;
  games: SportsGame[];
  /** ESPN's season phase of this list (1 pre, 2 regular, 3 post; soccer uses other numbers). */
  seasonType: number | null;
}

/** `teams/<id>/schedule` document → its games, the team and the season phase. */
export function mapSchedule(json: unknown, league: string): MappedSchedule {
  const root = obj(json);
  if (!root || !Array.isArray(root.events)) throw new EspnShapeError('Unexpected schedule');
  const seasonType = obj(root.requestedSeason)?.type;
  return {
    team: mapTeam(root.team, league),
    games: mapEvents(root.events, league),
    seasonType: typeof seasonType === 'number' && Number.isInteger(seasonType) ? seasonType : null,
  };
}

/** `scoreboard` document → its games. */
export function mapScoreboard(json: unknown, league: string): SportsGame[] {
  const root = obj(json);
  if (!root || !Array.isArray(root.events)) throw new EspnShapeError('Unexpected scoreboard');
  return mapEvents(root.events, league);
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/** The scoreboard's live fields over the schedule's game (logos and links stay the schedule's when present). */
function overlay(base: SportsGame, live: SportsGame): SportsGame {
  const side = (a: SportsCompetitor, b: SportsCompetitor): SportsCompetitor => ({
    ...a,
    score: b.score,
    winner: b.winner,
    record: b.record ?? a.record,
    logo: a.logo ?? b.logo,
    logoDark: a.logoDark ?? b.logoDark,
  });
  return {
    ...base,
    date: live.date,
    timeValid: live.timeValid,
    state: live.state,
    completed: live.completed,
    detail: live.detail || base.detail,
    situation: live.situation,
    home: side(base.home, live.home),
    away: side(base.away, live.away),
    note: base.note ?? live.note,
    boxScoreUrl: base.boxScoreUrl ?? live.boxScoreUrl,
    gameUrl: base.gameUrl ?? live.gameUrl,
    espnWatchUrl: base.espnWatchUrl ?? live.espnWatchUrl,
    broadcasts: live.broadcasts.length > 0 ? live.broadcasts : base.broadcasts,
  };
}

/** True when a game may be on right now (worth a scoreboard read). */
export function isAroundNow(game: SportsGame, now: number): boolean {
  if (game.state === 'in') return true;
  if (game.completed) return false;
  const start = Date.parse(game.date);
  return start - LIVE_LEAD_MS <= now && now <= start + LIVE_TAIL_MS;
}

/** Splits games into finished (most recent last), live and upcoming (soonest first). */
export function classifyGames(games: readonly SportsGame[]): Pick<SportsTeamGames, 'recent' | 'live' | 'upcoming'> {
  const byDate = [...games].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  return {
    recent: byDate.filter((g) => g.state === 'post' && g.completed).slice(-MAX_SPORTS_RECENT),
    live: byDate.filter((g) => g.state === 'in'),
    upcoming: byDate.filter((g) => g.state === 'pre').slice(0, MAX_SPORTS_UPCOMING),
  };
}

export interface EspnTransport {
  /** Reads a schedule document (cache it {@link SCHEDULE_TTL_MS}). */
  schedule(url: string): Promise<unknown>;
  /** Reads a scoreboard document (cache it {@link SCOREBOARD_TTL_MS}). */
  scoreboard(url: string): Promise<unknown>;
}

/**
 * A team's recent, live and upcoming games. The current schedule must load (its errors
 * propagate); the extra reads — the neighbouring season phase when the current one is short of
 * results or games to come, soccer fixtures, and the scoreboard for games around now — are best
 * effort.
 */
export async function loadTeamGames(info: SportsLeagueInfo, teamId: string, transport: EspnTransport, now: Date): Promise<SportsTeamGames> {
  const main = mapSchedule(await transport.schedule(scheduleUrl(info, teamId)), info.id);
  const lists: SportsGame[][] = [main.games];
  const extra = async (url: string): Promise<void> => {
    try {
      lists.push(mapSchedule(await transport.schedule(url), info.id).games);
    } catch {
      // Best effort: the current phase is enough to show something.
    }
  };

  if (info.soccer) {
    await extra(scheduleUrl(info, teamId, { fixture: true }));
  } else if (main.seasonType !== null && main.seasonType >= 1 && main.seasonType <= 3) {
    const { recent, upcoming } = classifyGames(main.games);
    const reads: Promise<void>[] = [];
    if (recent.length < MIN_RECENT && main.seasonType > 1) reads.push(extra(scheduleUrl(info, teamId, { seasonType: main.seasonType - 1 })));
    if (upcoming.length === 0 && main.seasonType < 3) reads.push(extra(scheduleUrl(info, teamId, { seasonType: main.seasonType + 1 })));
    await Promise.all(reads);
  }

  const byId = new Map<string, SportsGame>();
  for (const list of lists) for (const game of list) if (!byId.has(game.id)) byId.set(game.id, game);

  const nowMs = now.getTime();
  if ([...byId.values()].some((g) => isAroundNow(g, nowMs))) {
    try {
      for (const live of mapScoreboard(await transport.scoreboard(scoreboardUrl(info)), info.id)) {
        const base = byId.get(live.id);
        if (base) byId.set(live.id, overlay(base, live));
      }
    } catch {
      // Best effort: keep the schedule's view of the game.
    }
  }

  return {
    league: info.id,
    teamId,
    team: main.team,
    ...classifyGames([...byId.values()]),
    fetchedAt: now.toISOString(),
  };
}
