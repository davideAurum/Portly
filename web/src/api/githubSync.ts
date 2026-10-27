/**
 * The private GitHub repository and token for launch pad sync (browser backend only; the server has
 * no such route). Write-only like the Todoist token: the backend only reports `{configured}`.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getCapabilities } from '../capabilities.ts';
import { apiDelete, apiGet, apiPut } from './client.ts';

export interface GitHubSyncStatus {
  configured: boolean;
}

export interface GitHubSyncUpdate {
  /** `owner/name`. */
  repository: string;
  token: string;
}

export const GITHUB_SYNC_PATH = '/api/sync/github';
/** Under `['sync', 'github']`, which a change of the `github-sync` slice in another tab refreshes. */
export const githubSyncKey = () => ['sync', 'github'] as const;

/** `{configured}` (never the token or repository); asked only when this page's data lives in the browser. */
export function useGitHubSync() {
  return useQuery({
    queryKey: githubSyncKey(),
    queryFn: ({ signal }) => apiGet<GitHubSyncStatus>(GITHUB_SYNC_PATH, { signal }),
    staleTime: 60_000,
    enabled: getCapabilities().backend === 'browser',
  });
}

/** Checked with GitHub by the backend before it is stored. */
export function useSaveGitHubSync() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (update: GitHubSyncUpdate) => apiPut<GitHubSyncStatus>(GITHUB_SYNC_PATH, update),
    onSuccess: (status) => client.setQueryData(githubSyncKey(), status),
  });
}

export function useRemoveGitHubSync() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => apiDelete<GitHubSyncStatus>(GITHUB_SYNC_PATH),
    onSuccess: () => client.setQueryData<GitHubSyncStatus>(githubSyncKey(), { configured: false }),
  });
}
