/**
 * The GitHub token for launch pad sync through gists (browser backend only; the server has no
 * such route). Write-only like the Todoist token: the backend only reports `{configured}`.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getCapabilities } from '../capabilities.ts';
import { apiDelete, apiGet, apiPut } from './client.ts';

export interface GistTokenStatus {
  configured: boolean;
}

export const GIST_TOKEN_PATH = '/api/sync/gist/token';
/** Under `['sync', 'gist']`, which a change of the `gist-sync` slice in another tab refreshes. */
export const gistTokenKey = () => ['sync', 'gist', 'token'] as const;

/** `{configured}` (never the token); asked only when this page's data lives in the browser. */
export function useGistToken() {
  return useQuery({
    queryKey: gistTokenKey(),
    queryFn: ({ signal }) => apiGet<GistTokenStatus>(GIST_TOKEN_PATH, { signal }),
    staleTime: 60_000,
    enabled: getCapabilities().backend === 'browser',
  });
}

/** Checked with GitHub by the backend before it is stored. */
export function useSaveGistToken() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (token: string) => apiPut<GistTokenStatus>(GIST_TOKEN_PATH, { token }),
    onSuccess: (status) => client.setQueryData(gistTokenKey(), status),
  });
}

export function useRemoveGistToken() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => apiDelete<GistTokenStatus>(GIST_TOKEN_PATH),
    onSuccess: () => client.setQueryData<GistTokenStatus>(gistTokenKey(), { configured: false }),
  });
}
