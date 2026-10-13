/**
 * Pure view model of the sports widget: picks each favorite team's live, recent and upcoming
 * games, de-duplicates games between two favorites, and orders the sections (Live, Upcoming,
 * Final). Also maps broadcasters to where the game can be watched.
 */
import type { SportsBroadcast, SportsGame, SportsTeamGames } from '@homebase/shared';
import type { FavoriteTeam, SportsConfig } from './index.ts';

export interface GameRow {
  /** `<league>:<game id>`, unique across the widget. */
  key: string;
  game: SportsGame;
  /** Favorite team ids playing in this game (one, or two when favorites meet). */
  favorites: ReadonlySet<string>;
}

export interface GameSections {
  live: GameRow[];
  upcoming: GameRow[];
  /** Most recent first. */
  final: GameRow[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The games to show for the loaded teams, grouped and ordered. */
export function buildSections(
  entries: readonly { team: FavoriteTeam; data: SportsTeamGames | undefined }[],
  config: Pick<SportsConfig, 'recentGames' | 'upcomingGames' | 'upcomingDays'>,
  now: number,
): GameSections {
  const rows = new Map<string, { game: SportsGame; favorites: Set<string>; kind: keyof GameSections }>();
  const add = (game: SportsGame, team: FavoriteTeam, kind: keyof GameSections) => {
    const key = `${game.league}:${game.id}`;
    const row = rows.get(key);
    if (row) row.favorites.add(team.id);
    else rows.set(key, { game, favorites: new Set([team.id]), kind });
  };
  const horizon = now + config.upcomingDays * DAY_MS;
  for (const { team, data } of entries) {
    if (!data) continue;
    for (const game of data.live) add(game, team, 'live');
    if (config.upcomingGames > 0) {
      for (const game of data.upcoming.filter((g) => Date.parse(g.date) <= horizon).slice(0, config.upcomingGames)) add(game, team, 'upcoming');
    }
    if (config.recentGames > 0) for (const game of data.recent.slice(-config.recentGames)) add(game, team, 'final');
  }
  const sections: GameSections = { live: [], upcoming: [], final: [] };
  for (const [key, row] of rows) sections[row.kind].push({ key, game: row.game, favorites: row.favorites });
  const byDate = (a: GameRow, b: GameRow) => a.game.date.localeCompare(b.game.date) || a.key.localeCompare(b.key);
  sections.live.sort(byDate);
  sections.upcoming.sort(byDate);
  sections.final.sort((a, b) => byDate(b, a));
  return sections;
}

/** The link a game row opens: the box score once the game has started, else the game preview. */
export function gameLink(game: SportsGame): string | null {
  return game.state === 'pre' ? (game.gameUrl ?? game.boxScoreUrl) : (game.boxScoreUrl ?? game.gameUrl);
}

// ---------------------------------------------------------------------------
// Where to watch
// ---------------------------------------------------------------------------

export interface WatchService {
  /** "ESPN app", "Peacock"… */
  label: string;
  url: string;
}

interface ServiceRule {
  test: RegExp;
  service: WatchService;
}

const ESPN: WatchService = { label: 'ESPN app', url: 'https://www.espn.com/watch/' };
const FOX: WatchService = { label: 'Fox Sports app', url: 'https://www.foxsports.com/live' };
const PARAMOUNT: WatchService = { label: 'Paramount+', url: 'https://www.paramountplus.com/' };
const PEACOCK: WatchService = { label: 'Peacock', url: 'https://www.peacocktv.com/' };

/** Broadcaster name (as ESPN writes it) → the official place to stream it. First match wins. */
const SERVICE_RULES: readonly ServiceRule[] = [
  { test: /^(espn\s?(2|u|news|deportes|\+|unlimited)?|abc|sec ?n(etwork)?|acc ?n(etwork)?|longhorn network)$/i, service: ESPN },
  { test: /^(fox|fs1|fs2|fox sports ?[12]?|fox deportes|btn|big ten network|fox one)$/i, service: FOX },
  { test: /^cbs ?(sports network|sn)$|^cbssn$/i, service: { label: 'CBS Sports', url: 'https://www.cbssports.com/watch/' } },
  { test: /^(cbs|paramount\+|paramount plus)$/i, service: PARAMOUNT },
  { test: /^(nbc|peacock|telemundo|universo|nbcsn)$/i, service: PEACOCK },
  { test: /^(prime video|amazon prime video|amazon)$/i, service: { label: 'Prime Video', url: 'https://www.primevideo.com/' } },
  { test: /^netflix$/i, service: { label: 'Netflix', url: 'https://www.netflix.com/' } },
  { test: /^(tnt|tbs|trutv|tru tv|max|hbo max)$/i, service: { label: 'HBO Max', url: 'https://www.hbomax.com/' } },
  { test: /^(nfl ?net(work)?|nfl\+|nfl plus|nfl redzone)$/i, service: { label: 'NFL+', url: 'https://www.nfl.com/plus/' } },
  { test: /^(nba ?tv|nba league pass)$/i, service: { label: 'NBA League Pass', url: 'https://www.nba.com/watch' } },
  { test: /^(mlb ?n(etwork)?|mlb\.tv|mlb tv)$/i, service: { label: 'MLB.TV', url: 'https://www.mlb.com/tv' } },
  { test: /^(apple ?tv\+?|mls season pass)$/i, service: { label: 'Apple TV', url: 'https://tv.apple.com/' } },
  { test: /^youtube( tv)?$/i, service: { label: 'YouTube', url: 'https://www.youtube.com/' } },
  { test: /^(the )?cw$/i, service: { label: 'The CW app', url: 'https://www.cwtv.com/' } },
];

export function watchServiceFor(name: string): WatchService | null {
  const normalized = name.trim();
  return SERVICE_RULES.find((rule) => rule.test.test(normalized))?.service ?? null;
}

export interface WatchOption {
  broadcast: SportsBroadcast;
  service: WatchService | null;
}

export interface WatchOptions {
  /** TV and streaming, national first. */
  watch: WatchOption[];
  radio: SportsBroadcast[];
}

const MARKET_ORDER: Record<string, number> = { National: 0, Home: 1, Away: 2 };

/**
 * Where a game can be watched. ESPN's own watch page (specific to the game) replaces the generic
 * ESPN link when an ESPN network carries it.
 */
export function watchOptions(game: SportsGame): WatchOptions {
  const watch: WatchOption[] = [];
  const radio: SportsBroadcast[] = [];
  for (const broadcast of game.broadcasts) {
    if (broadcast.kind === 'radio') {
      radio.push(broadcast);
      continue;
    }
    let service = watchServiceFor(broadcast.name);
    if (service === ESPN && game.espnWatchUrl) service = { ...ESPN, url: game.espnWatchUrl };
    watch.push({ broadcast, service });
  }
  const rank = (b: SportsBroadcast) => MARKET_ORDER[b.market ?? 'National'] ?? 3;
  watch.sort((a, b) => rank(a.broadcast) - rank(b.broadcast));
  return { watch, radio };
}
