/**
 * Sports API (ESPN data, cached by the server or the in-browser backend):
 * - `GET /api/sports/teams?league=` → SportsTeam[] (the settings' team picker);
 * - `GET /api/sports/games?league=&team=` → SportsTeamGames, one query per favorite team so
 *   widgets sharing a team share its cache entry.
 *
 * Game queries refresh themselves faster while it matters: every {@link SPORTS_LIVE_REFETCH_MS}
 * while a game is live, every {@link SPORTS_SOON_REFETCH_MS} when one starts soon, else every
 * {@link SPORTS_IDLE_REFETCH_MS}.
 */
import { queryOptions, useQueries, useQuery } from '@tanstack/react-query';
import type { SportsTeam, SportsTeamGames } from '@homebase/shared';
import { apiGet } from './client.ts';
import { qk } from './keys.ts';

export const SPORTS_LIVE_REFETCH_MS = 30 * 1000;
export const SPORTS_SOON_REFETCH_MS = 60 * 1000;
export const SPORTS_IDLE_REFETCH_MS = 10 * 60 * 1000;
/** A game starting within this long counts as "soon" (so the first live score shows promptly). */
export const SPORTS_SOON_WINDOW_MS = 15 * 60 * 1000;
const TEAMS_STALE_MS = 12 * 60 * 60 * 1000;

export function fetchSportsTeams(league: string, signal?: AbortSignal): Promise<SportsTeam[]> {
  return apiGet<SportsTeam[]>(`/api/sports/teams?${new URLSearchParams({ league }).toString()}`, { signal });
}

export function fetchTeamGames(league: string, team: string, signal?: AbortSignal): Promise<SportsTeamGames> {
  return apiGet<SportsTeamGames>(`/api/sports/games?${new URLSearchParams({ league, team }).toString()}`, { signal });
}

export function sportsTeamsQuery(league: string) {
  return queryOptions({
    queryKey: qk.sports.teams(league),
    queryFn: ({ signal }) => fetchSportsTeams(league, signal),
    staleTime: TEAMS_STALE_MS,
  });
}

export function useSportsTeams(league: string, enabled = true) {
  return useQuery({ ...sportsTeamsQuery(league), enabled });
}

/** How soon a team's games should be read again. */
export function teamGamesRefetchMs(data: SportsTeamGames | undefined, now: number = Date.now()): number {
  if (!data) return SPORTS_IDLE_REFETCH_MS;
  if (data.live.length > 0) return SPORTS_LIVE_REFETCH_MS;
  const next = data.upcoming[0];
  // Past its start time but not live yet: keep checking until the scoreboard says it began.
  if (next && Date.parse(next.date) - now <= SPORTS_SOON_WINDOW_MS) return SPORTS_SOON_REFETCH_MS;
  return SPORTS_IDLE_REFETCH_MS;
}

export function teamGamesQuery(league: string, team: string) {
  return queryOptions({
    queryKey: qk.sports.games(league, team),
    queryFn: ({ signal }) => fetchTeamGames(league, team, signal),
    staleTime: SPORTS_LIVE_REFETCH_MS - 5000,
  });
}

/** One query per team, in the given order. */
export function useTeamGames(teams: readonly { league: string; id: string }[]) {
  return useQueries({
    queries: teams.map((t) => ({
      ...teamGamesQuery(t.league, t.id),
      refetchInterval: (query: { state: { data: SportsTeamGames | undefined } }) => teamGamesRefetchMs(query.state.data),
      refetchOnWindowFocus: true,
    })),
  });
}
