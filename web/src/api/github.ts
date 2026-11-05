/**
 * GitHub status board client (§7 GitHub). The token is write-only: the server only reports
 * `{configured}`. Every widget shares one board query. Nothing here changes anything on GitHub.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { GitHubBoard, GitHubTokenStatus } from '@portly/shared';
import { apiDelete, apiGet, apiPut } from './client.ts';
import { qk } from './keys.ts';

export const GITHUB_BOARD_STALE_MS = 60_000;
export const GITHUB_BOARD_REFRESH_MS = 5 * 60_000;

export function fetchGitHubToken(signal?: AbortSignal): Promise<GitHubTokenStatus> {
  return apiGet<GitHubTokenStatus>('/api/github/token', { signal });
}

/** `{configured}` only (never the token), so a new tab knows at once whether GitHub is connected. */
export function useGitHubToken() {
  return useQuery({
    queryKey: qk.github.token(),
    queryFn: ({ signal }) => fetchGitHubToken(signal),
    staleTime: 60_000,
  });
}

/** `PUT /api/github/token`: checked with GitHub before it is stored. */
export function useSaveGitHubToken() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (token: string) => apiPut<GitHubTokenStatus>('/api/github/token', { token }),
    onSuccess: async (status) => {
      client.setQueryData(qk.github.token(), status);
      // Everything cached so far belonged to the previous token (or to "not configured").
      await client.invalidateQueries({ queryKey: qk.github.all() });
    },
  });
}

export function useRemoveGitHubToken() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => apiDelete<GitHubTokenStatus>('/api/github/token'),
    onSuccess: async () => {
      client.setQueryData<GitHubTokenStatus>(qk.github.token(), { configured: false });
      client.removeQueries({ queryKey: qk.github.board() });
      await client.invalidateQueries({ queryKey: qk.github.all() });
    },
  });
}

export function fetchGitHubBoard(signal?: AbortSignal): Promise<GitHubBoard> {
  return apiGet<GitHubBoard>('/api/github/repos', { signal });
}

/** The account's repositories; off until a token is known to be saved. */
export function useGitHubBoard(enabled = true) {
  return useQuery({
    queryKey: qk.github.board(),
    queryFn: ({ signal }) => fetchGitHubBoard(signal),
    enabled,
    staleTime: GITHUB_BOARD_STALE_MS,
    // A dashboard left open keeps up with pushes and CI runs (paused while the tab is hidden).
    refetchInterval: GITHUB_BOARD_REFRESH_MS,
  });
}
