import type { ReactNode } from 'react';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SportsCompetitor, SportsGame, SportsTeam, SportsTeamGames } from '@homebase/shared';
import { teamGamesRefetchMs, SPORTS_IDLE_REFETCH_MS, SPORTS_LIVE_REFETCH_MS, SPORTS_SOON_REFETCH_MS } from '../../api/sports.ts';
import { WidgetFrameContext, type WidgetFrameContextValue } from '../../grid/WidgetContext.tsx';
import { mockError, renderWithProviders, type ApiMock, type MockRequest } from '../../test/render.tsx';
import { sportsConfigSchema, type FavoriteTeam, type SportsConfig } from './index.ts';
import { buildSections, gameLink, watchOptions, watchServiceFor } from './model.ts';
import SportsSettings from './Settings.tsx';
import SportsWidget from './Widget.tsx';

const NOW = new Date('2026-10-11T20:00:00Z').getTime();
const HOUR = 60 * 60 * 1000;
const at = (hours: number) => new Date(NOW + hours * HOUR).toISOString();

function side(abbr: string, name: string, patch: Partial<SportsCompetitor> = {}): SportsCompetitor {
  return { teamId: abbr, name, shortName: name.split(' ').at(-1)!, abbreviation: abbr, logo: null, logoDark: null, score: null, winner: null, record: null, ...patch };
}

function game(id: string, patch: Partial<SportsGame> & Pick<SportsGame, 'home' | 'away'>): SportsGame {
  return {
    id,
    league: 'nfl',
    date: at(0),
    timeValid: true,
    state: 'pre',
    completed: false,
    detail: '',
    situation: null,
    note: null,
    venue: null,
    boxScoreUrl: `https://www.espn.com/nfl/boxscore/_/gameId/${id}`,
    gameUrl: `https://www.espn.com/nfl/game/_/gameId/${id}`,
    espnWatchUrl: `https://www.espn.com/watchespn/index?gameId=${id}`,
    broadcasts: [],
    ...patch,
  };
}

const KC_FAV: FavoriteTeam = { league: 'nfl', id: 'KC', name: 'Kansas City Chiefs', abbreviation: 'KC', logo: null };
const DEN_FAV: FavoriteTeam = { league: 'nfl', id: 'DEN', name: 'Denver Broncos', abbreviation: 'DEN', logo: null };

const LIVE = game('10', {
  state: 'in',
  detail: 'Q3 4:12',
  situation: '1st & 10 at DEN 30',
  home: side('DEN', 'Denver Broncos', { score: '7' }),
  away: side('KC', 'Kansas City Chiefs', { score: '14' }),
  broadcasts: [
    { name: 'CBS', kind: 'tv', market: 'National' },
    { name: 'Paramount+', kind: 'streaming', market: 'National' },
    { name: 'KCFX', kind: 'radio', market: 'Away' },
  ],
});
const FINAL = game('9', {
  state: 'post',
  completed: true,
  detail: 'Final',
  date: at(-7 * 24),
  home: side('KC', 'Kansas City Chiefs', { score: '24', winner: true }),
  away: side('LV', 'Las Vegas Raiders', { score: '20', winner: false }),
});
const OLD_FINAL = game('8', { ...FINAL, id: '8', date: at(-14 * 24) });
const NEXT = game('11', {
  date: at(24 * 7),
  home: side('KC', 'Kansas City Chiefs'),
  away: side('LAC', 'Los Angeles Chargers'),
  broadcasts: [{ name: 'ESPN', kind: 'tv', market: 'National' }, { name: 'KSHB', kind: 'tv', market: 'Home' }],
});
const FAR = game('12', { date: at(24 * 40), home: side('KC', 'Kansas City Chiefs'), away: side('NYJ', 'New York Jets') });

function teamGames(team: string, patch: Partial<SportsTeamGames>): SportsTeamGames {
  return { league: 'nfl', teamId: team, team: null, recent: [], live: [], upcoming: [], fetchedAt: new Date(NOW).toISOString(), ...patch };
}

const KC_GAMES = teamGames('KC', { recent: [OLD_FINAL, FINAL], live: [LIVE], upcoming: [NEXT, FAR] });
const DEN_GAMES = teamGames('DEN', { live: [LIVE] });

function config(patch: Partial<SportsConfig> = {}): SportsConfig {
  return { ...sportsConfigSchema.parse({}), ...patch };
}

function Frame({ children, openSettings }: { children: ReactNode; openSettings?: () => void }) {
  const value: WidgetFrameContextValue = {
    instanceId: 'w-sports',
    title: 'Sports scores',
    openSettings: openSettings ?? (() => {}),
    canOpenSettings: true,
    actionsTarget: document.body,
  };
  return <WidgetFrameContext.Provider value={value}>{children}</WidgetFrameContext.Provider>;
}

function gamesApi(byTeam: Record<string, ApiMock>): ApiMock {
  return (req: MockRequest) => {
    const team = new URLSearchParams(req.search).get('team') ?? '';
    const mock = byTeam[team];
    return typeof mock === 'function' ? (mock as (r: MockRequest) => unknown)(req) : (mock ?? mockError(404, 'not_found'));
  };
}

function renderSports(cfg: Partial<SportsConfig>, byTeam: Record<string, ApiMock> = {}, openSettings?: () => void) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  return renderWithProviders(
    <Frame openSettings={openSettings}>
      <SportsWidget instanceId="w-sports" config={config(cfg)} setConfig={async () => {}} size={{ w: 4, h: 7 }} editMode={false} />
    </Frame>,
    { apiMocks: { 'GET /api/sports/games': gamesApi(byTeam) } },
  );
}

describe('sports model', () => {
  it('groups games into live, upcoming (within the look-ahead) and final, sharing games between favorites', () => {
    const sections = buildSections(
      [
        { team: KC_FAV, data: KC_GAMES },
        { team: DEN_FAV, data: DEN_GAMES },
        { team: { ...KC_FAV, id: 'X' }, data: undefined },
      ],
      { recentGames: 2, upcomingGames: 3, upcomingDays: 14 },
      NOW,
    );
    expect(sections.live.map((r) => r.key)).toEqual(['nfl:10']);
    expect([...sections.live[0]!.favorites].sort()).toEqual(['DEN', 'KC']);
    expect(sections.upcoming.map((r) => r.game.id)).toEqual(['11']);
    expect(sections.final.map((r) => r.game.id)).toEqual(['9', '8']);

    const none = buildSections([{ team: KC_FAV, data: KC_GAMES }], { recentGames: 0, upcomingGames: 0, upcomingDays: 30 }, NOW);
    expect([none.live.length, none.upcoming.length, none.final.length]).toEqual([1, 0, 0]);
  });

  it('links to the box score once a game has started, else to the preview', () => {
    expect(gameLink(FINAL)).toBe('https://www.espn.com/nfl/boxscore/_/gameId/9');
    expect(gameLink(LIVE)).toBe('https://www.espn.com/nfl/boxscore/_/gameId/10');
    expect(gameLink(NEXT)).toBe('https://www.espn.com/nfl/game/_/gameId/11');
    expect(gameLink({ ...FINAL, boxScoreUrl: null })).toBe('https://www.espn.com/nfl/game/_/gameId/9');
  });

  it('maps broadcasters to streaming services', () => {
    expect(watchServiceFor('ESPN2')?.label).toBe('ESPN app');
    expect(watchServiceFor('SEC Network')?.label).toBe('ESPN app');
    expect(watchServiceFor('FS1')?.label).toBe('Fox Sports app');
    expect(watchServiceFor('CBS')?.label).toBe('Paramount+');
    expect(watchServiceFor('CBSSN')?.label).toBe('CBS Sports');
    expect(watchServiceFor('Prime Video')?.label).toBe('Prime Video');
    expect(watchServiceFor('NFL Net')?.label).toBe('NFL+');
    expect(watchServiceFor('TNT')?.label).toBe('HBO Max');
    expect(watchServiceFor('Bally Sports KC')).toBeNull();

    const live = watchOptions(LIVE);
    expect(live.watch.map((o) => `${o.broadcast.name}→${o.service?.label}`)).toEqual(['CBS→Paramount+', 'Paramount+→Paramount+']);
    expect(live.radio.map((b) => b.name)).toEqual(['KCFX']);
    // ESPN's game-specific watch page replaces the generic one.
    expect(watchOptions(NEXT).watch[0]!.service?.url).toBe('https://www.espn.com/watchespn/index?gameId=11');
    expect(watchOptions(NEXT).watch[1]!.service).toBeNull();
  });

  it('refreshes fast while live, soon before kick-off, slowly otherwise', () => {
    expect(teamGamesRefetchMs(KC_GAMES, NOW)).toBe(SPORTS_LIVE_REFETCH_MS);
    expect(teamGamesRefetchMs(teamGames('KC', { upcoming: [{ ...NEXT, date: at(0.1) }] }), NOW)).toBe(SPORTS_SOON_REFETCH_MS);
    expect(teamGamesRefetchMs(teamGames('KC', { upcoming: [{ ...NEXT, date: at(-0.5) }] }), NOW)).toBe(SPORTS_SOON_REFETCH_MS);
    expect(teamGamesRefetchMs(teamGames('KC', { upcoming: [NEXT] }), NOW)).toBe(SPORTS_IDLE_REFETCH_MS);
    expect(teamGamesRefetchMs(undefined, NOW)).toBe(SPORTS_IDLE_REFETCH_MS);
  });
});

describe('SportsWidget', () => {
  afterEach(() => vi.useRealTimers());

  it('asks for teams when none are chosen', async () => {
    const openSettings = vi.fn();
    renderSports({}, {}, openSettings);
    expect(screen.getByText('No teams yet')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Choose teams' }));
    expect(openSettings).toHaveBeenCalledWith({ focus: 'sports-team' });
  });

  it('shows live, upcoming and final games with a live badge and box score links', async () => {
    renderSports({ teams: [KC_FAV, DEN_FAV] }, { KC: KC_GAMES, DEN: DEN_GAMES });
    const live = await screen.findByRole('region', { name: 'Live' });
    expect(within(live).getAllByRole('listitem')).toHaveLength(1);
    expect(within(within(live).getByRole('listitem')).getByText('Live')).toBeInTheDocument();
    expect(live).toHaveTextContent('Q3 4:12');
    expect(live).toHaveTextContent('1st & 10 at DEN 30');
    const liveLink = within(live).getByRole('link');
    expect(liveLink).toHaveAttribute('href', 'https://www.espn.com/nfl/boxscore/_/gameId/10');
    expect(liveLink).toHaveAttribute('target', '_blank');
    // Visitors first: KC 14 above DEN 7.
    expect(liveLink.textContent).toMatch(/Chiefs.*14.*Broncos.*7/);

    const upcoming = screen.getByRole('region', { name: 'Upcoming' });
    expect(within(upcoming).getAllByRole('listitem')).toHaveLength(1);
    expect(upcoming).toHaveTextContent('Chargers');
    expect(within(upcoming).getByRole('link')).toHaveAttribute('href', 'https://www.espn.com/nfl/game/_/gameId/11');

    const final = screen.getByRole('region', { name: 'Final' });
    expect(within(final).getAllByRole('listitem')).toHaveLength(1);
    expect(final).toHaveTextContent('Final');
    expect(within(final).getByRole('link')).toHaveAttribute('href', 'https://www.espn.com/nfl/boxscore/_/gameId/9');
    // Finished games have no "where to watch".
    expect(within(final).queryByRole('button')).toBeNull();
  });

  it('lists where a game can be watched', async () => {
    renderSports({ teams: [KC_FAV] }, { KC: KC_GAMES });
    const live = await screen.findByRole('region', { name: 'Live' });
    await userEvent.click(within(live).getByRole('button', { name: /Where to watch Kansas City Chiefs at Denver Broncos/ }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('CBS');
    expect(within(dialog).getAllByRole('link', { name: /Paramount\+/ })[0]).toHaveAttribute('href', 'https://www.paramountplus.com/');
    expect(dialog).toHaveTextContent('Radio: KCFX');
  });

  it('keeps showing the other teams when one fails', async () => {
    renderSports({ teams: [KC_FAV, DEN_FAV] }, { KC: KC_GAMES, DEN: mockError(502, 'provider_error', 'ESPN answered HTTP 503') });
    expect(await screen.findByTestId('team-error')).toHaveTextContent('Denver Broncos');
    expect(screen.getByRole('region', { name: 'Final' })).toBeInTheDocument();
  });

  it('says so when there is nothing to show', async () => {
    renderSports({ teams: [KC_FAV] }, { KC: teamGames('KC', { upcoming: [FAR] }) });
    expect(await screen.findByText('No games right now')).toBeInTheDocument();
  });
});

describe('SportsSettings', () => {
  const TEAMS: SportsTeam[] = [
    { id: '12', league: 'nfl', name: 'Kansas City Chiefs', shortName: 'Chiefs', abbreviation: 'KC', logo: 'https://a.espncdn.com/i/teamlogos/nfl/500/kc.png', logoDark: null, color: null },
    { id: '7', league: 'nfl', name: 'Denver Broncos', shortName: 'Broncos', abbreviation: 'DEN', logo: null, logoDark: null, color: null },
  ];

  it('adds, finds and removes favorite teams', async () => {
    const onChange = vi.fn();
    const value = config();
    const { rerender } = renderWithProviders(<SportsSettings value={value} onChange={onChange} />, { apiMocks: { 'GET /api/sports/teams': TEAMS } });
    const list = await screen.findByRole('list', { name: 'NFL teams' });
    expect(within(list).getAllByRole('button')).toHaveLength(2);

    await userEvent.type(screen.getByPlaceholderText('Find a team'), 'chiefs');
    await waitFor(() => expect(within(list).getAllByRole('button')).toHaveLength(1));
    await userEvent.click(within(list).getByRole('button', { name: /Kansas City Chiefs/ }));
    expect(onChange).toHaveBeenLastCalledWith({
      ...value,
      teams: [{ league: 'nfl', id: '12', name: 'Kansas City Chiefs', abbreviation: 'KC', logo: 'https://a.espncdn.com/i/teamlogos/nfl/500/kc.png' }],
    });

    const chosen = onChange.mock.lastCall![0] as SportsConfig;
    rerender(<SportsSettings value={chosen} onChange={onChange} />);
    expect(within(screen.getByRole('list', { name: 'Favorite teams' })).getByText('Kansas City Chiefs')).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'NFL teams' })).getByRole('button', { name: /Kansas City Chiefs/ })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Remove Kansas City Chiefs' }));
    expect(onChange).toHaveBeenLastCalledWith({ ...chosen, teams: [] });
  });

  it('drops logos from other hosts in stored configs', () => {
    const parsed = sportsConfigSchema.parse({ teams: [{ ...KC_FAV, id: '12', logo: 'https://evil.example/x.png' }] });
    expect(parsed.teams[0]!.logo).toBeNull();
  });
});
