/**
 * Launch pad sync's state in this browser (browser backend only; the server has no such route):
 * which sync connection is used, how the last round went, and **Sync now** (with the answer to a
 * first-sync question). docs/design/launchpad-sync.md sections 6.6 and 10.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getCapabilities } from '../capabilities.ts';
import type { LaunchpadSyncStatus } from '../static/slices.ts';
import type { FirstSyncChoice } from '../static/sync/engine.ts';
import { apiGet, apiPost } from './client.ts';

export type { FirstSyncChoice, LaunchpadSyncStatus };

export type LaunchpadSyncConnection = { kind: 'microsoft'; accountId: string; label: string } | { kind: 'github' };

export interface LaunchpadSyncInfo {
  /** The one sync connection in use (null: none, or more than one). */
  connection: LaunchpadSyncConnection | null;
  /** How many sync connections are set up: more than one means nothing syncs. */
  connections: number;
  status: LaunchpadSyncStatus;
  /** A problem code for `refused` or `error` (never content). */
  problem: string | null;
  /** A round is running on this page now. */
  running: boolean;
  /** Local changes not sent yet. */
  waiting: boolean;
  /** ISO times: last successful sync, last change received and sent, the next try after failures. */
  syncedAt: string | null;
  receivedAt: string | null;
  sentAt: string | null;
  retryAt: string | null;
}

export const LAUNCHPAD_SYNC_PATH = '/api/sync/launchpad';
/** Under `['sync', 'launchpad']`, which a change of the `launchpad-sync` slice refreshes. */
export const launchpadSyncKey = () => ['sync', 'launchpad'] as const;

/** Asked only where launch pad sync can run (this page's data lives in the browser). */
export function useLaunchpadSync() {
  return useQuery({
    queryKey: launchpadSyncKey(),
    queryFn: ({ signal }) => apiGet<LaunchpadSyncInfo>(LAUNCHPAD_SYNC_PATH, { signal }),
    staleTime: 30_000,
    enabled: getCapabilities().launchpadSync,
    meta: { persist: false },
  });
}

/** Syncs now, waiting for another tab's round; `choice` answers the first-sync question. */
export function useSyncNow() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (choice?: FirstSyncChoice) => apiPost<LaunchpadSyncInfo>(`${LAUNCHPAD_SYNC_PATH}/now`, choice ? { choice } : {}),
    onSuccess: (info) => client.setQueryData(launchpadSyncKey(), info),
  });
}
